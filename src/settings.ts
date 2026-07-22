/**
 * Runtime-mutable companion connection settings.
 *
 * Unlike `config` (env, read once, frozen), the *live* companion host can be
 * changed from the UI at runtime. This module holds that live host, seeded
 * from the `config` defaults and overlaid at startup from a persisted
 * settings file, so a UI change survives restarts. Every module that needs
 * the current companion base URL/host (api.ts, server.ts) reads it from here
 * instead of from `config`.
 *
 * This module deliberately imports only `config` (+ fs) so the dependency
 * graph stays acyclic: api.ts imports settings.ts, never the reverse. When
 * the host changes, resetting api.ts's cached base URL is the caller's job
 * (see connection.ts), not this module's.
 */

import { readFileSync } from "node:fs";
import { config } from "./config";

interface PersistedSettings {
    remoteIp: string;
    remotePort: number;
}

const current: PersistedSettings = {
    remoteIp: config.remoteIp,
    remotePort: config.remotePort,
};

// Overlay any persisted settings written by a previous UI host change. A
// missing file (first run) or unparseable contents just leaves the env
// defaults in place -- a bad settings file must never stop the app booting.
(function loadPersisted(): void {
    let raw: string;
    try {
        raw = readFileSync(config.settingsFilePath, "utf8");
    } catch {
        return; // No settings file yet -- use the env defaults.
    }
    try {
        const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
        if (typeof parsed.remoteIp === "string" && parsed.remoteIp.trim()) {
            current.remoteIp = parsed.remoteIp.trim();
        }
        if (isValidPort(parsed.remotePort)) {
            current.remotePort = parsed.remotePort;
        }
    } catch (err) {
        console.warn(`[settings] ignoring unreadable ${config.settingsFilePath}:`, err);
    }
})();

/** True for a valid TCP port (integer 1-65535). */
export function isValidPort(port: unknown): port is number {
    return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function getRemoteIp(): string {
    return current.remoteIp;
}

export function getRemotePort(): number {
    return current.remotePort;
}

/** Live "ip:port", e.g. "127.0.0.1:9863". */
export function getRemoteHost(): string {
    return `${current.remoteIp}:${current.remotePort}`;
}

/** Live companion base URL, e.g. "http://127.0.0.1:9863". */
export function getRemoteBaseUrl(): string {
    return `http://${getRemoteHost()}`;
}

/**
 * Updates the live companion host and persists it to disk. Throws on an
 * invalid ip/port so callers can surface the reason to the UI. Persisting is
 * best-effort: a write failure is logged but doesn't undo the in-memory
 * change (the app still works this session, it just won't remember next boot).
 */
export async function setRemote(remoteIp: string, remotePort: number): Promise<void> {
    const ip = typeof remoteIp === "string" ? remoteIp.trim() : "";
    if (!ip) throw new Error("Host/IP is required");
    if (!isValidPort(remotePort)) throw new Error(`Invalid port: "${remotePort}" (must be 1-65535)`);

    current.remoteIp = ip;
    current.remotePort = remotePort;

    try {
        await Bun.write(config.settingsFilePath, JSON.stringify({ remoteIp: ip, remotePort } satisfies PersistedSettings));
    } catch (err) {
        console.warn(`[settings] failed to persist ${config.settingsFilePath}:`, err);
    }
}
