/**
 * Owns the companion connection lifecycle: the auth token, the realtime
 * socket, and a `ConnectionStatus` state machine that the browser UI observes
 * (over the WS `status` message) and drives (via `startPairing`/`changeHost`).
 *
 * This is where the "re-pair on auth error" and connection-error throttling
 * that used to live inline in index.ts now sit. It's decoupled from the
 * browser-facing server: status changes and new tokens are pushed out through
 * injected callbacks, so `server.ts` never imports this module.
 */

import { invalidateToken, pairToken, readPersistedToken } from "./auth";
import { ApiError, resetApiBaseUrlCache } from "./api";
import { getRemoteHost, setRemote } from "./settings";
import { connectYtmSocket, type YtmSocketHandle } from "./socket";
import { setConnected, setPlayerState } from "./state";
import type { ConnectionStatus, ConnStatusState, YTMPlaylist } from "./types";

export interface ConnectionDeps {
    /** Pushes a new status to observers (wired to the WS broadcast in index.ts). */
    onStatus: (status: ConnectionStatus) => void;
    /** Announces a freshly obtained token (wired to server.setCurrentToken). */
    onToken: (token: string) => void;
    /** Surfaces a transient error (toast) that isn't a lasting status change. */
    onError: (message: string) => void;
    onPlaylistCreated: (playlist: YTMPlaylist) => void;
    onPlaylistDeleted: (playlistId: string) => void;
}

export interface Connection {
    /** Connects with a persisted token if one exists, otherwise sits "unpaired". */
    init(): Promise<void>;
    /** Runs the pairing flow, surfacing the code via status, then connects. */
    startPairing(): Promise<void>;
    /** Switches to a different companion host (drops the old token; user re-pairs). */
    changeHost(remoteIp: string, remotePort: number): Promise<void>;
}

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export function createConnection(deps: ConnectionDeps): Connection {
    let token: string | null = null;
    let socketHandle: YtmSocketHandle | null = null;

    // Guards against re-entrancy of the async flows.
    let reauthInProgress = false;
    let pairingInProgress = false;
    // Set while we tear a socket down on purpose (host change / auth error), so
    // the resulting onDisconnect doesn't clobber the status we just set.
    let intentionalDisconnect = false;
    // connect_error fires on every reconnect attempt (1-10s apart); only the
    // first error of an outage becomes a status update, reset once connected.
    let connectionErrorNotified = false;

    function emit(state: ConnStatusState, extra?: { code?: string; message?: string }): void {
        deps.onStatus({ state, remoteHost: getRemoteHost(), ...extra });
    }

    function teardownSocket(): void {
        intentionalDisconnect = true;
        socketHandle?.disconnect();
        socketHandle = null;
        setConnected(false);
    }

    async function connect(): Promise<void> {
        if (!token) {
            emit("unpaired");
            return;
        }
        // Drop any prior socket before opening a new one (e.g. reconnecting to a new host).
        if (socketHandle) teardownSocket();

        emit("connecting");
        connectionErrorNotified = false;
        intentionalDisconnect = false;

        try {
            socketHandle = await connectYtmSocket(token, {
                onStateUpdate: setPlayerState,
                onPlaylistCreated: deps.onPlaylistCreated,
                onPlaylistDeleted: deps.onPlaylistDeleted,
                onConnect: () => {
                    setConnected(true);
                    connectionErrorNotified = false;
                    emit("connected");
                },
                onDisconnect: (reason) => {
                    setConnected(false);
                    console.warn("[connection] ytm-socket disconnected:", reason);
                    // Deliberate teardown owns the status; only surface unexpected drops.
                    if (!intentionalDisconnect) emit("disconnected", { message: `Disconnected: ${reason}` });
                },
                onConnectionError: (err) => {
                    // Not auth-related (YTM Desktop closed, network down). socket.io keeps retrying.
                    console.error("[connection] ytm-socket connection error:", err.message);
                    if (!connectionErrorNotified) {
                        connectionErrorNotified = true;
                        emit("disconnected", { message: `Can't reach YTM Desktop: ${err.message}` });
                    }
                },
                onAuthError: handleAuthError,
            });
        } catch (err) {
            // getApiBaseUrl() failed (bad host, /metadata unreachable, unsupported API version).
            console.error("[connection] failed to open socket:", describe(err));
            emit("error", { message: `Couldn't reach ${getRemoteHost()}: ${describe(err)}` });
        }
    }

    // The token was rejected. Unlike a plain connection error we can't just
    // wait for socket.io to retry -- the same bad token will keep failing -- so
    // we stop the socket, drop the token, and ask the user to re-pair (a
    // deliberate choice over silently auto-pairing, which would pop an
    // unexpected approval prompt in YTM Desktop).
    function handleAuthError(err: Error): void {
        if (reauthInProgress) return;
        reauthInProgress = true;
        console.warn("[connection] ytm-socket auth error:", err.message);
        (async () => {
            try {
                teardownSocket();
                await invalidateToken();
                token = null;
                emit("auth-error", { message: "Session expired — pair again to reconnect." });
            } catch (e) {
                console.error("[connection] error handling auth failure:", describe(e));
            } finally {
                reauthInProgress = false;
            }
        })();
    }

    async function startPairing(): Promise<void> {
        if (pairingInProgress) return;
        pairingInProgress = true;
        emit("pairing");
        try {
            const newToken = await pairToken((code) => emit("pairing", { code }));
            token = newToken;
            deps.onToken(newToken);
            await connect();
        } catch (err) {
            console.error("[connection] pairing failed:", describe(err));
            // A 403 on the auth routes almost always means the companion
            // server is up but pairing is switched off -- point the user
            // straight at the toggle rather than a bare "Forbidden".
            const message =
                err instanceof ApiError && err.status === 403
                    ? "Pairing refused (403). Turn on “Enable companion authorization” in YTM Desktop (Settings → Integrations), then try again."
                    : `Pairing failed: ${describe(err)}`;
            // Pairing never touched the existing socket/token, so a failed
            // *re-pair* of a still-connected session must not drop us into an
            // error state -- surface the reason as a toast and stay connected.
            // Only a genuinely dead session (unpaired, or after a host switch)
            // becomes a lasting error.
            if (socketHandle?.connected && token) {
                deps.onError(message);
                emit("connected");
            } else {
                emit("error", { message });
            }
        } finally {
            pairingInProgress = false;
        }
    }

    // Switches to a different companion host and pairs against it. The old
    // token is host-specific so it's dropped; pairing then runs immediately
    // (this is only ever reached from an explicit "Pair" click in the UI, so
    // continuing straight into pairing is expected, not a surprise prompt).
    async function changeHost(remoteIp: string, remotePort: number): Promise<void> {
        try {
            teardownSocket();
            await setRemote(remoteIp, remotePort); // throws on invalid ip/port
            resetApiBaseUrlCache(); // cached base URL points at the old host
            await invalidateToken(); // the old token is host-specific
            token = null;
        } catch (err) {
            console.error("[connection] change host failed:", describe(err));
            emit("error", { message: `Couldn't change host: ${describe(err)}` });
            return;
        }
        await startPairing();
    }

    async function init(): Promise<void> {
        token = await readPersistedToken();
        if (token) {
            deps.onToken(token);
            await connect();
        } else {
            emit("unpaired");
        }
    }

    return { init, startPairing, changeHost };
}
