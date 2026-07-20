import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { setCurrentToken, startServer } from "../src/server";
import { setConnected, setPlayerState } from "../src/state";
import type { YTMQueue, YTMStateRes } from "../src/types";
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

    test("serves an ETag and answers a matching If-None-Match with a bodyless 304", async () => {
        const first = await fetch(`${base}/app.js`);
        const etag = first.headers.get("etag");
        expect(etag).toBeTruthy();
        expect(first.headers.get("cache-control")).toBe("no-cache");

        const second = await fetch(`${base}/app.js`, { headers: { "If-None-Match": etag! } });
        expect(second.status).toBe(304);
        expect(await second.text()).toBe("");
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

describe("queue broadcast diffing", () => {
    const queue: YTMQueue = {
        autoplay: false,
        items: [
            {
                thumbnails: [{ url: "http://example.test/t.jpg", width: 60, height: 60 }],
                title: "Song A",
                author: "Artist",
                duration: "3:21",
                selected: true,
                videoId: "vid-a",
                counterparts: null,
            },
        ],
        automixItems: [],
        isGenerating: false,
        isInfinite: false,
        repeatMode: 0,
        selectedItemIndex: 0,
    };

    function stateWith(progress: number, q: YTMQueue | null): YTMStateRes {
        return {
            player: { trackState: 1, videoProgress: progress, volume: 80, adPlaying: false, queue: q },
            video: null,
            playlistId: "PL_QUEUE_TEST",
        };
    }

    test("sends the queue when it changes, omits it when only progress moves", async () => {
        const ws = new WebSocket(`ws://localhost:${config.serverPort}/ws`);
        await waitOpen(ws);
        await nextMessage(ws); // drain snapshot-on-connect

        // Queue is new -> full broadcast.
        let broadcast = nextMessage(ws);
        setPlayerState(stateWith(10, queue));
        let msg = await broadcast;
        expect(msg.queueOmitted).toBeUndefined();
        expect(msg.playerState.player.queue).toEqual(queue);

        // Same queue, progress moved -> queue omitted and flagged.
        broadcast = nextMessage(ws);
        setPlayerState(stateWith(11, queue));
        msg = await broadcast;
        expect(msg.queueOmitted).toBe(true);
        expect(msg.playerState.player.queue).toBeNull();
        expect(msg.playerState.player.videoProgress).toBe(11);

        // Queue changed -> full broadcast again.
        const movedQueue = { ...queue, selectedItemIndex: 1 };
        broadcast = nextMessage(ws);
        setPlayerState(stateWith(12, movedQueue));
        msg = await broadcast;
        ws.close();
        expect(msg.queueOmitted).toBeUndefined();
        expect(msg.playerState.player.queue).toEqual(movedQueue);
    });

    test("a client connecting mid-stream still gets the full queue in its snapshot", async () => {
        // Make the current queue the "already broadcast" one, so a regular
        // broadcast right now would omit it -- the on-connect snapshot must not.
        setPlayerState(stateWith(20, queue));

        const ws = new WebSocket(`ws://localhost:${config.serverPort}/ws`);
        const first = await nextMessage(ws);
        ws.close();

        expect(first.queueOmitted).toBeUndefined();
        expect(first.playerState.player.queue).toEqual(queue);
    });
});
