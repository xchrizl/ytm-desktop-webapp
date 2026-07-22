import { config } from "./config";
import { createConnection } from "./connection";
import {
    addPlaylist,
    broadcastError,
    broadcastStatus,
    removePlaylist,
    setControlHandlers,
    setCurrentToken,
    startServer,
} from "./server";

async function main(): Promise<void> {
    console.log(`[index] ${config.appName} v${config.appVersion} starting (web UI on port ${config.serverPort})`);

    // Serve the web UI + browser WS first, unconditionally. The app must be
    // reachable even with no token or an unreachable/misconfigured companion
    // host, so the user can pair or change the host from the UI instead of
    // editing .env and redeploying.
    startServer();

    const connection = createConnection({
        onStatus: broadcastStatus,
        onToken: setCurrentToken,
        onError: broadcastError,
        onPlaylistCreated: (playlist) => {
            console.log("[index] playlist created:", playlist.title);
            addPlaylist(playlist);
        },
        onPlaylistDeleted: (playlistId) => {
            console.log("[index] playlist deleted:", playlistId);
            removePlaylist(playlistId);
        },
    });

    // Let the browser drive pairing and host switching over the WS.
    setControlHandlers({
        startPairing: () => void connection.startPairing(),
        setHost: (remoteIp, remotePort) => void connection.changeHost(remoteIp, remotePort),
    });

    // Connect with a persisted token if we have one; otherwise sit "unpaired"
    // and wait for the user to pair from the UI.
    await connection.init();

    process.on("SIGINT", () => {
        console.log("\n[index] shutting down...");
        process.exit(0);
    });
}

main().catch((err) => {
    console.error("[index] fatal error during startup:", err);
    process.exit(1);
});
