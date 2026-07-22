import { afterAll } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockServer } from "./mock-companion-server";

// Grab an OS-assigned free port for our own web UI server (src/server.ts) by
// briefly binding to port 0 and reading back what got assigned.
const portProbe = Bun.serve({ port: 0, fetch: () => new Response() });
const serverPort = portProbe.port;
portProbe.stop(true);

const tokenFilePath = join(tmpdir(), `ytm-desktop-webapp-test-token-${process.pid}.txt`);
const settingsFilePath = join(tmpdir(), `ytm-desktop-webapp-test-settings-${process.pid}.json`);

// src/config.ts reads these once at import time, so they must be set before
// any test file (or the modules it imports) ever touches "../src/config".
process.env.REMOTE_IP = "127.0.0.1";
process.env.REMOTE_PORT = String(mockServer.port);
process.env.API_VERSION = "v1";
process.env.APP_ID = "ytm-desktop-webapp-tests";
process.env.APP_NAME = "YTM Desktop WebApp Tests";
process.env.APP_VERSION = "0.0.0-test";
process.env.SERVER_PORT = String(serverPort);
process.env.TOKEN_FILE_PATH = tokenFilePath;
process.env.SETTINGS_FILE_PATH = settingsFilePath;

afterAll(async () => {
    mockServer.stop();
    for (const path of [tokenFilePath, settingsFilePath]) {
        try {
            await unlink(path);
        } catch {
            // Nothing to clean up if a test never wrote it.
        }
    }
});
