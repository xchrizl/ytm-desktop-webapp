import type {
    YTMCodeRes,
    YTMCommand,
    YTMMetadataRes,
    YTMPlaylist,
    YTMStateRes,
    YTMTokenReq,
    YTMTokenRes,
} from "../src/types";

/** A fake stand-in for YTM Desktop's companion server, so tests never need the real app running. */
export interface MockCompanionServer {
    port: number;
    validTokens: Set<string>;
    state: YTMStateRes;
    receivedCommands: YTMCommand[];
    apiVersions: string[];
    /** Delays every response by this many ms -- for exercising request timeouts. */
    delayMs: number;
    /** The next request to this pathname gets a 429 instead of its normal response. */
    rateLimitNextRequestTo: string | null;
    /** The next request to this pathname gets a 500 instead of its normal response. */
    forceErrorNextRequestTo: string | null;
    /** Restores all fields to their defaults between tests. */
    reset(): void;
    stop(): void;
}

function defaultState(): YTMStateRes {
    return {
        player: { trackState: 1, videoProgress: 0, volume: 100, adPlaying: false, queue: null },
        video: null,
        playlistId: "",
    };
}

function startMockCompanionServer(): MockCompanionServer {
    const mock: MockCompanionServer = {
        port: 0,
        validTokens: new Set(["valid-token"]),
        state: defaultState(),
        receivedCommands: [],
        apiVersions: ["v1"],
        delayMs: 0,
        rateLimitNextRequestTo: null,
        forceErrorNextRequestTo: null,
        reset() {
            mock.validTokens = new Set(["valid-token"]);
            mock.state = defaultState();
            mock.receivedCommands = [];
            mock.apiVersions = ["v1"];
            mock.delayMs = 0;
            mock.rateLimitNextRequestTo = null;
            mock.forceErrorNextRequestTo = null;
        },
        stop() {
            server.stop(true);
        },
    };

    function unauthorized(req: Request): Response | null {
        const token = req.headers.get("authorization");
        return token && mock.validTokens.has(token) ? null : new Response("unauthorized", { status: 401 });
    }

    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            if (mock.delayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, mock.delayMs));
            }

            const url = new URL(req.url);

            if (mock.rateLimitNextRequestTo === url.pathname) {
                mock.rateLimitNextRequestTo = null;
                return new Response(null, { status: 429, headers: { "retry-after": "1" } });
            }
            if (mock.forceErrorNextRequestTo === url.pathname) {
                mock.forceErrorNextRequestTo = null;
                return new Response("mock server error", { status: 500 });
            }

            if (url.pathname === "/metadata" && req.method === "GET") {
                return Response.json({ apiVersions: mock.apiVersions } satisfies YTMMetadataRes);
            }

            if (url.pathname === "/api/v1/auth/requestcode" && req.method === "POST") {
                return Response.json({ code: "TEST-CODE" } satisfies YTMCodeRes);
            }

            if (url.pathname === "/api/v1/auth/request" && req.method === "POST") {
                const body = (await req.json()) as YTMTokenReq;
                if (body.code !== "TEST-CODE") {
                    return new Response("invalid code", { status: 400 });
                }
                mock.validTokens.add("valid-token");
                return Response.json({ token: "valid-token" } satisfies YTMTokenRes);
            }

            if (url.pathname === "/api/v1/state" && req.method === "GET") {
                const unauthorizedRes = unauthorized(req);
                if (unauthorizedRes) return unauthorizedRes;
                return Response.json(mock.state);
            }

            if (url.pathname === "/api/v1/playlists" && req.method === "GET") {
                const unauthorizedRes = unauthorized(req);
                if (unauthorizedRes) return unauthorizedRes;
                return Response.json([{ id: "PL1", title: "Test playlist" }] satisfies YTMPlaylist[]);
            }

            if (url.pathname === "/api/v1/command" && req.method === "POST") {
                const unauthorizedRes = unauthorized(req);
                if (unauthorizedRes) return unauthorizedRes;
                mock.receivedCommands.push((await req.json()) as YTMCommand);
                return new Response(null, { status: 204 });
            }

            return new Response("not found", { status: 404 });
        },
    });

    mock.port = server.port ?? 0;
    return mock;
}

export const mockServer = startMockCompanionServer();
