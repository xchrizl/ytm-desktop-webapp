import { io, type Socket } from "socket.io-client";
import { getApiBaseUrl } from "./api";
import type { YTMStateRes } from "./types";

export interface YtmSocketHandlers {
    /** Fired every time the companion server pushes a new player state. */
    onStateUpdate: (state: YTMStateRes) => void;
    onConnect?: () => void;
    onDisconnect?: (reason: string) => void;
    /**
     * Fired when a connection error looks auth-related (as opposed to the
     * server just being unreachable). Callers are responsible for deciding
     * what to do about it -- e.g. re-running the pairing flow in auth.ts
     * and calling `updateToken` with the result. This module only manages
     * the socket connection itself, not auth policy.
     */
    onAuthError?: (error: Error) => void;
    /** Fired for connection errors that don't look auth-related. */
    onConnectionError?: (error: Error) => void;
}

export interface YtmSocketHandle {
    /** Swaps the auth token and reconnects if the socket is currently disconnected. */
    updateToken(token: string): void;
    disconnect(): void;
    readonly connected: boolean;
}

/** Heuristic: the companion server docs don't specify an exact auth-error shape for the socket, so we match on message content. */
function looksLikeAuthError(err: Error): boolean {
    const message = err.message.toLowerCase();
    return message.includes("auth") || message.includes("unauthorized") || message.includes("token") || message.includes("forbidden");
}

/**
 * Opens the socket.io connection to the companion server's realtime
 * namespace and wires up the given handlers. Resolves once the socket
 * object exists (not once it's connected -- connection is async and
 * handled via the onConnect/onConnectionError handlers).
 */
export async function connectYtmSocket(token: string, handlers: YtmSocketHandlers): Promise<YtmSocketHandle> {
    const baseUrl = await getApiBaseUrl();

    const socket: Socket = io(`${baseUrl}/realtime`, {
        transports: ["websocket"],
        auth: { token },
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
    });

    socket.on("connect", () => {
        console.log("[ytm-socket] connected:", socket.id);
        handlers.onConnect?.();
    });

    socket.on("disconnect", (reason) => {
        console.warn("[ytm-socket] disconnected:", reason);
        handlers.onDisconnect?.(reason);
    });

    socket.on("connect_error", (err: Error) => {
        console.error("[ytm-socket] connection error:", err.message);
        if (looksLikeAuthError(err)) {
            handlers.onAuthError?.(err);
        } else {
            handlers.onConnectionError?.(err);
        }
    });

    socket.on("state-update", (data: YTMStateRes) => {
        handlers.onStateUpdate(data);
    });

    return {
        updateToken(newToken: string) {
            socket.auth = { token: newToken };
            if (!socket.connected) {
                socket.connect();
            }
        },
        disconnect() {
            socket.disconnect();
        },
        get connected() {
            return socket.connected;
        },
    };
}