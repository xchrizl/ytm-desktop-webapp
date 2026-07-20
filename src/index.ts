import { config } from "./config";
import { getValidToken, invalidateToken } from "./auth";
import { getApiBaseUrl } from "./api";
import { connectYtmSocket, type YtmSocketHandle } from "./socket";
import { setPlayerState, setConnected } from "./state";
import { broadcastError, setCurrentToken, startServer } from "./server";

async function main(): Promise<void> {
    console.log(`[index] ${config.appName} v${config.appVersion} starting (web UI on port ${config.serverPort})`);

    const apiBaseUrl = await getApiBaseUrl();
    console.log(`[index] companion API resolved: ${apiBaseUrl}`);

    let token = await getValidToken();
    setCurrentToken(token);

    // Serve the web UI + browser WS as soon as we have a token, so the UI
    // is reachable even while the YTM socket is still connecting.
    startServer();

    // Guards against onAuthError firing multiple times concurrently (e.g.
    // several rejected reconnect attempts in a row) and racing itself.
    let reauthInProgress = false;

    // connect_error fires on every reconnect attempt (1-10s apart), so only
    // the first error of an outage is pushed to browsers as a toast; reset
    // once the socket comes back.
    let connectionErrorNotified = false;

    const socketHandle: YtmSocketHandle = await connectYtmSocket(token, {
        onStateUpdate: (state) => {
            setPlayerState(state);
        },
        onConnect: () => {
            setConnected(true);
            connectionErrorNotified = false;
        },
        onDisconnect: (reason) => {
            setConnected(false);
            console.warn("[index] ytm-socket disconnected:", reason);
        },
        onConnectionError: (err) => {
            // Not auth-related (e.g. YTM Desktop closed, network down).
            // socket.io's own reconnection logic will keep retrying.
            console.error("[index] ytm-socket connection error:", err.message);
            if (!connectionErrorNotified) {
                connectionErrorNotified = true;
                broadcastError(`Can't reach YTM Desktop: ${err.message}`);
            }
        },
        onAuthError: (err) => {
            if (reauthInProgress) return;
            reauthInProgress = true;
            console.warn("[index] ytm-socket auth error, re-pairing:", err.message);

            (async () => {
                try {
                    await invalidateToken();
                    token = await getValidToken();
                    setCurrentToken(token);
                    socketHandle.updateToken(token);
                    console.log("[index] re-paired successfully; socket reconnecting with new token");
                } catch (reauthErr) {
                    console.error("[index] failed to re-pair after auth error:", reauthErr);
                } finally {
                    reauthInProgress = false;
                }
            })();
        },
    });

    process.on("SIGINT", () => {
        console.log("\n[index] shutting down...");
        socketHandle.disconnect();
        process.exit(0);
    });
}

main().catch((err) => {
    console.error("[index] fatal error during startup:", err);
    process.exit(1);
});