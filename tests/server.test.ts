import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { setCurrentToken, startServer } from "../src/server";
import { setConnected, setPlayerState } from "../src/state";
import type { YTMStateRes } from "../src/types";
import { mockServer } from "./mock-companion-server";

let server: ReturnType<typeof startServer>;

beforeAll(() => {
    server = startServer();
});

afterAll(() => {
    server.stop(true);
});

const base = `http://localhost:${config.serverPort}`;

function nextMessage(ws: WebSocket): Promise<any> {
    return new Promise((resolve, reject) => {
        ws.addEventListener("message", (e) => resolve(JSON.parse(e.data as string)), { once: true });
        ws.addEventListener("error", reject, { once: true });
    });
}

function waitOpen(ws: WebSocket): Promise<void> {
    return new Promise((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));
}

describe("static file serving", () => {
    test("serves index.html at /", async () => {
        const res = await fetch(`${base}/`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(await res.text()).toContain("<title>YTM Remote</title>");
    });

    test("serves app.js with a JS content type", async () => {
        const res = await fetch(`${base}/app.js`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/javascript");
    });

    test("serves style.css with a CSS content type", async () => {
        const res = await fetch(`${base}/style.css`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/css");
    });

    test("404s for a file that doesn't exist", async () => {
        const res = await fetch(`${base}/does-not-exist.txt`);
        expect(res.status).toBe(404);
    });
});

describe("websocket protocol", () => {
    test("sends the current state snapshot immediately on connect", async () => {
        const state: YTMStateRes = {
            player: { trackState: 1, videoProgress: 42, volume: 80, adPlaying: false, queue: null },
            video: null,
            playlistId: "PL_WS_TEST",
        };
        setPlayerState(state);
        setConnected(true);

        const ws = new WebSocket(`ws://localhost:${config.serverPort}/ws`);
        const first = await nextMessage(ws);
        ws.close();

        expect(first).toEqual({ type: "state", playerState: state, connected: true });
    });

    // currentToken in server.ts starts null and is checked *before* JSON is even
    // parsed, so this must run before any test below sets a token -- once set,
    // there's no public way to unset it again.
    test("replies with an error when no token has been set yet", async () => {
        const ws = new WebSocket(`ws://localhost:${config.serverPort}/ws`);
        await waitOpen(ws);
        await nextMessage(ws);

        const reply = nextMessage(ws);
        ws.send(JSON.stringify({ command: "playPause" }));
        const msg = await reply;
        ws.close();

        expect(msg).toEqual({ type: "error", message: "Not authenticated with the companion server yet" });
    });

    describe("once authenticated", () => {
        beforeAll(() => {
            setCurrentToken("valid-token");
        });

        test("replies with an error for invalid JSON", async () => {
            const ws = new WebSocket(`ws://localhost:${config.serverPort}/ws`);
            await waitOpen(ws);
            await nextMessage(ws); // drain the initial state push

            const reply = nextMessage(ws);
            ws.send("not json");
            const msg = await reply;
            ws.close();

            expect(msg).toEqual({ type: "error", message: "Invalid JSON" });
        });

        test("replies with an error for a message that isn't a plausible command", async () => {
            const ws = new WebSocket(`ws://localhost:${config.serverPort}/ws`);
            await waitOpen(ws);
            await nextMessage(ws);

            const reply = nextMessage(ws);
            ws.send(JSON.stringify({ notACommand: true }));
            const msg = await reply;
            ws.close();

            expect(msg).toEqual({ type: "error", message: "Invalid command message" });
        });

        test("forwards a valid command to the companion server", async () => {
            mockServer.receivedCommands = [];

            const ws = new WebSocket(`ws://localhost:${config.serverPort}/ws`);
            await waitOpen(ws);
            await nextMessage(ws); // drain the initial state push

            ws.send(JSON.stringify({ command: "playPause" }));
            await new Promise((resolve) => setTimeout(resolve, 100)); // let the async dispatch land
            ws.close();

            expect(mockServer.receivedCommands).toEqual([{ command: "playPause" }]);
        });
    });
});
