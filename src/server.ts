import { readFileSync } from "node:fs";
import type { Serve } from "bun";
import { config } from "./config";
import { subscribe, getSnapshot, type StateSnapshot } from "./state";
import { sendCommand, getPlaylists, ApiError } from "./api";
import type { YTMCommand, YTMPlaylist } from "./types";

const STATIC_DIR = "public";

// The token used to authenticate outgoing /command calls. Set once auth
// completes in index.ts, and updated again if the token is ever refreshed.
let currentToken: string | null = null;

export function setCurrentToken(token: string): void {
    currentToken = token;
}

type ClientSocket = Bun.ServerWebSocket<unknown>;

const clients = new Set<ClientSocket>();

type OutgoingMessage =
    | ({ type: "state"; remoteHost: string; queueOmitted?: true } & StateSnapshot)
    | { type: "playlists"; playlists: YTMPlaylist[] }
    | { type: "error"; message: string };

function send(ws: ClientSocket, message: OutgoingMessage): void {
    ws.send(JSON.stringify(message));
}

// Serialized queue from the last broadcast. The queue is by far the largest
// part of a state snapshot and usually unchanged between updates (which
// arrive on every progress tick) -- when it hasn't changed, it's omitted
// from the broadcast and clients reuse the queue they already have,
// signalled by `queueOmitted`. New connections always get a full snapshot.
let lastQueueJson: string | null = null;

function broadcastState(snapshot: StateSnapshot): void {
    const queueJson = JSON.stringify(snapshot.playerState?.player.queue ?? null);
    const queueUnchanged = queueJson === lastQueueJson;
    lastQueueJson = queueJson;

    if (clients.size === 0) return;

    const message: OutgoingMessage =
        queueUnchanged && snapshot.playerState
            ? {
                  type: "state",
                  remoteHost: config.remoteHost,
                  queueOmitted: true,
                  connected: snapshot.connected,
                  playerState: {
                      ...snapshot.playerState,
                      player: { ...snapshot.playerState.player, queue: null },
                  },
              }
            : { type: "state", remoteHost: config.remoteHost, ...snapshot };

    const payload = JSON.stringify(message);
    for (const ws of clients) {
        ws.send(payload);
    }
}

/** Pushes a toast-able error message to every connected browser (e.g. "YTM Desktop unreachable"). */
export function broadcastError(message: string): void {
    if (clients.size === 0) return;
    const payload = JSON.stringify({ type: "error", message } satisfies OutgoingMessage);
    for (const ws of clients) {
        ws.send(payload);
    }
}

/** Loose runtime check: is this a plausible YTMCommand? Full validity (e.g. data ranges) is left to the companion server to reject. */
function isPlausibleCommand(value: unknown): value is YTMCommand {
    return typeof value === "object" && value !== null && typeof (value as { command?: unknown }).command === "string";
}

function isPlaylistsRequest(value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "getPlaylists";
}

// Playlists change rarely, but the companion endpoint can block for up to
// 30s and is rate limited -- cache responses instead of hitting it every
// time a client opens the playlists panel.
const PLAYLISTS_CACHE_MS = 5 * 60_000;
let playlistsCache: { data: YTMPlaylist[]; at: number } | null = null;

async function handleGetPlaylists(ws: ClientSocket, token: string): Promise<void> {
    if (playlistsCache && Date.now() - playlistsCache.at < PLAYLISTS_CACHE_MS) {
        send(ws, { type: "playlists", playlists: playlistsCache.data });
        return;
    }
    const playlists = await getPlaylists(token);
    playlistsCache = { data: playlists, at: Date.now() };
    send(ws, { type: "playlists", playlists });
}

function broadcastPlaylists(playlists: YTMPlaylist[]): void {
    if (clients.size === 0) return;
    const payload = JSON.stringify({ type: "playlists", playlists } satisfies OutgoingMessage);
    for (const ws of clients) {
        ws.send(payload);
    }
}

// The companion server emits playlist-created/deleted over the realtime
// socket (see index.ts). Rather than invalidate the cache and pay the slow,
// rate-limited GET /playlists again, apply the change to the cached list in
// place and push the updated list to every client. The cache's `at` is left
// untouched so the periodic full re-fetch still acts as a resync safety net.
// If nothing is cached yet there's no baseline to patch -- the next
// getPlaylists fetch will pick the change up on its own.

/** Adds a newly-created playlist to the cached list and broadcasts it live. */
export function addPlaylist(playlist: YTMPlaylist): void {
    if (!playlistsCache) return;
    if (playlistsCache.data.some((p) => p.id === playlist.id)) return;
    playlistsCache.data = [...playlistsCache.data, playlist];
    broadcastPlaylists(playlistsCache.data);
}

/** Removes a deleted playlist from the cached list and broadcasts it live. */
export function removePlaylist(playlistId: string): void {
    if (!playlistsCache) return;
    const next = playlistsCache.data.filter((p) => p.id !== playlistId);
    if (next.length === playlistsCache.data.length) return;
    playlistsCache.data = next;
    broadcastPlaylists(playlistsCache.data);
}

async function handleIncomingMessage(ws: ClientSocket, raw: string): Promise<void> {
    if (!currentToken) {
        send(ws, { type: "error", message: "Not authenticated with the companion server yet" });
        return;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        send(ws, { type: "error", message: "Invalid JSON" });
        return;
    }

    if (isPlaylistsRequest(parsed)) {
        try {
            await handleGetPlaylists(ws, currentToken);
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Failed to fetch playlists";
            console.error("[server] playlists fetch failed:", message);
            send(ws, { type: "error", message });
        }
        return;
    }

    if (!isPlausibleCommand(parsed)) {
        send(ws, { type: "error", message: "Invalid command message" });
        return;
    }

    try {
        await sendCommand(currentToken, parsed);
    } catch (err) {
        const message = err instanceof ApiError ? err.message : "Failed to send command";
        console.error("[server] command failed:", message);
        send(ws, { type: "error", message });
    }
}

function contentTypeFor(pathname: string): string {
    if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
    if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
    if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
    if (pathname.endsWith("manifest.json")) return "application/manifest+json";
    if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
    if (pathname.endsWith(".svg")) return "image/svg+xml";
    if (pathname.endsWith(".png")) return "image/png";
    if (pathname.endsWith(".ico")) return "image/x-icon";
    if (pathname.endsWith(".wav")) return "audio/wav";
    return "application/octet-stream";
}

/**
 * Preloads every file in STATIC_DIR as a buffered Response for Bun.serve's
 * static `routes`. Buffered routes are served entirely from native code with
 * an automatic ETag and If-None-Match/304 handling -- no per-request disk
 * I/O and no JS on the hot path. `Cache-Control: no-cache` makes browsers
 * revalidate (a bodyless 304) instead of heuristically caching stale assets.
 * Routes are frozen when the server starts, so editing a static file
 * requires a restart.
 */
function staticResponse(name: string, body: Uint8Array): Serve.BaseRouteValue {
    // Cast: with @types/node installed, `new Response()` is typed as undici's
    // Response, which bun-types' route value type doesn't accept even though
    // they're the same class at runtime.
    return new Response(body, {
        headers: { "Content-Type": contentTypeFor(name), "Cache-Control": "no-cache" },
    }) as unknown as Serve.BaseRouteValue;
}

function buildStaticRoutes(): Record<string, Serve.BaseRouteValue> {
    const routes: Record<string, Serve.BaseRouteValue> = {};
    for (const name of new Bun.Glob("*").scanSync(STATIC_DIR)) {
        const body = readFileSync(`${STATIC_DIR}/${name}`);
        routes[`/${name}`] = staticResponse(name, body);
        // index.html doubles as the root route.
        if (name === "index.html") routes["/"] = staticResponse(name, body);
    }
    return routes;
}

/** Returns the underlying Bun server handle so callers (mainly tests) can shut it down cleanly. */
export function startServer() {
    subscribe(broadcastState);

    const server = Bun.serve({
        port: config.serverPort,
        routes: buildStaticRoutes(),
        fetch(req, server) {
            const url = new URL(req.url);

            if (url.pathname === "/ws") {
                if (server.upgrade(req)) {
                    return; // Connection upgraded; Bun handles the response.
                }
                return new Response("WebSocket upgrade failed", { status: 500 });
            }

            // Anything not matched by the static routes above.
            return new Response("Not found", { status: 404 });
        },
        websocket: {
            open(ws) {
                clients.add(ws);
                send(ws, { type: "state", remoteHost: config.remoteHost, ...getSnapshot() });
            },
            close(ws) {
                clients.delete(ws);
            },
            message(ws, message) {
                handleIncomingMessage(ws, message.toString()).catch((err) => {
                    console.error("[server] unexpected error handling message:", err);
                });
            },
        },
    });

    console.log(`[server] web UI + WS listening on http://localhost:${config.serverPort}`);
    return server;
}