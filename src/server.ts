import { config } from "./config";
import { subscribe, getSnapshot, type StateSnapshot } from "./state";
import { sendCommand, ApiError } from "./api";
import type { YTMCommand } from "./types";

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
    | ({ type: "state" } & StateSnapshot)
    | { type: "error"; message: string };

function send(ws: ClientSocket, message: OutgoingMessage): void {
    ws.send(JSON.stringify(message));
}

function broadcastState(snapshot: StateSnapshot): void {
    const payload = JSON.stringify({ type: "state", ...snapshot } satisfies OutgoingMessage);
    for (const ws of clients) {
        ws.send(payload);
    }
}

/** Loose runtime check: is this a plausible YTMCommand? Full validity (e.g. data ranges) is left to the companion server to reject. */
function isPlausibleCommand(value: unknown): value is YTMCommand {
    return typeof value === "object" && value !== null && typeof (value as { command?: unknown }).command === "string";
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
    return "application/octet-stream";
}

async function serveStatic(pathname: string): Promise<Response> {
    const requestedPath = pathname === "/" ? "/index.html" : pathname;
    // Strip any ".." segments to prevent escaping STATIC_DIR.
    const safePath = requestedPath.split("/").filter((segment) => segment !== "..").join("/");

    const file = Bun.file(`${STATIC_DIR}${safePath}`);
    if (!(await file.exists())) {
        return new Response("Not found", { status: 404 });
    }

    return new Response(file, { headers: { "Content-Type": contentTypeFor(safePath) } });
}

/** Returns the underlying Bun server handle so callers (mainly tests) can shut it down cleanly. */
export function startServer() {
    subscribe(broadcastState);

    const server = Bun.serve({
        port: config.serverPort,
        fetch(req, server) {
            const url = new URL(req.url);

            if (url.pathname === "/ws") {
                if (server.upgrade(req)) {
                    return; // Connection upgraded; Bun handles the response.
                }
                return new Response("WebSocket upgrade failed", { status: 500 });
            }

            return serveStatic(url.pathname);
        },
        websocket: {
            open(ws) {
                clients.add(ws);
                send(ws, { type: "state", ...getSnapshot() });
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