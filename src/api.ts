import { config } from "./config";
import type {
    YTMMetadataRes,
    YTMCodeReq,
    YTMCodeRes,
    YTMTokenReq,
    YTMTokenRes,
    YTMStateRes,
    YTMPlaylist,
    YTMCommand,
} from "./types";

/** Thrown for any non-2xx response from the companion server. */
export class ApiError extends Error {
    constructor(
        message: string,
        public readonly status: number,
        public readonly statusText: string,
    ) {
        super(message);
        this.name = "ApiError";
    }
}

/** Thrown specifically on HTTP 429, so callers can back off distinctly from other failures. */
export class RateLimitError extends ApiError {
    constructor(
        message: string,
        status: number,
        statusText: string,
        public readonly retryAfterSeconds: number | null,
    ) {
        super(message, status, statusText);
        this.name = "RateLimitError";
    }
}

// The versioned base URL (e.g. "http://127.0.0.1:9863/api/v1") is only known
// after validating config.apiVersion against GET /metadata. Resolved once,
// cached, and reused by every subsequent call.
let resolvedBaseUrlPromise: Promise<string> | null = null;

async function resolveApiBaseUrl(): Promise<string> {
    if (!resolvedBaseUrlPromise) {
        // On failure, clear the cache so the next caller retries instead of
        // being stuck with a permanently-rejected promise for the process lifetime.
        resolvedBaseUrlPromise = (async () => {
            try {
                const res = await fetch(`${config.remoteBaseUrl}/metadata`, {
                    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
                });
                if (!res.ok) {
                    throw new ApiError(
                        `Failed to fetch companion server metadata: ${res.statusText}`,
                        res.status,
                        res.statusText,
                    );
                }

                const metadata = (await res.json()) as YTMMetadataRes;
                if (!metadata.apiVersions.includes(config.apiVersion)) {
                    throw new ApiError(
                        `Companion server does not support API version "${config.apiVersion}". ` +
                            `Supported versions: ${metadata.apiVersions.join(", ")}`,
                        res.status,
                        res.statusText,
                    );
                }

                return `${config.remoteBaseUrl}/api/${config.apiVersion}`;
            } catch (err) {
                resolvedBaseUrlPromise = null;
                throw err;
            }
        })();
    }
    return resolvedBaseUrlPromise;
}

/** Test-only: clears the cached base-URL resolution so the next call re-resolves it from scratch. */
export function _resetApiBaseUrlCacheForTests(): void {
    resolvedBaseUrlPromise = null;
}

/**
 * Returns the version-checked companion API base URL (e.g.
 * "http://127.0.0.1:9863/api/v1"), resolving and caching it against
 * GET /metadata on first call. Exposed for callers that need to build
 * URLs outside of `request()`, such as the realtime socket namespace.
 */
export function getApiBaseUrl(): Promise<string> {
    return resolveApiBaseUrl();
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** /auth/request and /playlists can legitimately hold the request open for up to 30s per the companion server docs. */
const LONG_POLL_TIMEOUT_MS = 35_000;

interface RequestOptions {
    method?: "GET" | "POST";
    body?: unknown;
    /** Authorization header value. Omit for the two unauthenticated auth routes. */
    token?: string;
    /** Aborts the request after this many ms. Defaults to DEFAULT_TIMEOUT_MS. */
    timeoutMs?: number;
}

/** Warns loudly once a route is close to its rate limit, per the companion server's x-ratelimit-* headers. */
function checkRateLimitHeaders(path: string, res: Response): void {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const limit = res.headers.get("x-ratelimit-limit");
    const reset = res.headers.get("x-ratelimit-reset");

    if (remaining === null || limit === null) return;

    const remainingNum = Number(remaining);
    if (Number.isFinite(remainingNum) && remainingNum <= 1) {
        console.warn(
            `[api] Close to rate limit on ${path}: ${remaining}/${limit} requests left` +
                (reset ? `, resets in ${reset}s` : ""),
        );
    }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const baseUrl = await resolveApiBaseUrl();
    const { method = "GET", body, token, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers["Authorization"] = token;

    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
    });

    checkRateLimitHeaders(path, res);

    if (res.status === 429) {
        const retryAfterRaw = res.headers.get("retry-after");
        const retryAfterSeconds = retryAfterRaw !== null ? Number(retryAfterRaw) : null;
        throw new RateLimitError(
            `Rate limited on ${path}` + (retryAfterSeconds !== null ? ` (retry after ${retryAfterSeconds}s)` : ""),
            res.status,
            res.statusText,
            retryAfterSeconds,
        );
    }

    if (!res.ok) {
        throw new ApiError(`Request to ${path} failed: ${res.statusText}`, res.status, res.statusText);
    }

    // Some routes (e.g. POST /command) return no body at all.
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
}

// --- Unauthenticated routes --------------------------------------------------

export function requestCode(body: YTMCodeReq): Promise<YTMCodeRes> {
    return request<YTMCodeRes>("/auth/requestcode", { method: "POST", body });
}

/**
 * Exchanges a code for a token. The companion server holds this request open
 * for up to 30s while the user approves the pairing prompt — callers should
 * not assume a fast response.
 */
export function requestToken(body: YTMTokenReq): Promise<YTMTokenRes> {
    return request<YTMTokenRes>("/auth/request", { method: "POST", body, timeoutMs: LONG_POLL_TIMEOUT_MS });
}

// --- Authenticated routes -----------------------------------------------------

export function getState(token: string): Promise<YTMStateRes> {
    return request<YTMStateRes>("/state", { token });
}

/** Can take up to 30s to respond, per the companion server docs. */
export function getPlaylists(token: string): Promise<YTMPlaylist[]> {
    return request<YTMPlaylist[]>("/playlists", { token, timeoutMs: LONG_POLL_TIMEOUT_MS });
}

export function sendCommand(token: string, command: YTMCommand): Promise<void> {
    return request<void>("/command", { method: "POST", body: command, token });
}