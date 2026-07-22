/**
 * Centralized, validated application configuration.
 *
 * All environment variables are read and validated exactly once, here.
 * Every other module should import `config` from this file instead of
 * touching `process.env` directly — that way a missing/invalid var fails
 * fast at startup with a clear message, instead of silently becoming
 * `"undefined"` somewhere deep in a URL string.
 */

interface Config {
    /**
     * YTM Desktop companion server host, e.g. "127.0.0.1".
     * NOTE: this (and remotePort/remoteHost/remoteBaseUrl) is only the
     * *initial default* — the live host can be changed at runtime from the
     * UI and lives in `settings.ts`, which seeds itself from these values.
     */
    remoteIp: string;
    /** YTM Desktop companion server port, e.g. 9863 (initial default; see remoteIp) */
    remotePort: number;
    /** Convenience "ip:port" combo, e.g. "127.0.0.1:9863" (initial default; see remoteIp) */
    remoteHost: string;
    /** Companion server base URL, e.g. "http://127.0.0.1:9863" (initial default; see remoteIp) */
    remoteBaseUrl: string;
    /** Requested companion API version, e.g. "v1" */
    apiVersion: string;

    /** Identifies this app to the companion server during auth */
    appId: string;
    appName: string;
    appVersion: string;

    /** Port our own Bun server (web UI + WS) listens on */
    serverPort: number;

    /** Path to the file used to persist the auth token between runs */
    tokenFilePath: string;

    /** Path to the file used to persist runtime settings (the live companion host) between runs */
    settingsFilePath: string;
}

/** Reads a required env var, exits the process with a clear error if missing/empty. */
function requireEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        console.error(`Missing required environment variable: ${name}`);
        console.error(`Check your .env file against .env.example`);
        process.exit(1);
    }
    return value;
}

/** Reads an optional env var, falling back to `fallback` if unset/empty. */
function optionalEnv(name: string, fallback: string): string {
    const value = process.env[name]?.trim();
    return value ? value : fallback;
}

/** Parses and validates a value as a TCP port number (1-65535). */
function parsePort(name: string, raw: string): number {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error(`Invalid ${name}: "${raw}" is not a valid port number (1-65535)`);
        process.exit(1);
    }
    return port;
}

function loadConfig(): Config {
    const remoteIp = requireEnv("REMOTE_IP");
    const remotePort = parsePort("REMOTE_PORT", requireEnv("REMOTE_PORT"));
    const apiVersion = requireEnv("API_VERSION");

    const appId = requireEnv("APP_ID");
    const appName = requireEnv("APP_NAME");
    const appVersion = requireEnv("APP_VERSION");

    const serverPort = parsePort("SERVER_PORT", optionalEnv("SERVER_PORT", "8080"));
    const tokenFilePath = optionalEnv("TOKEN_FILE_PATH", "token.txt");
    const settingsFilePath = optionalEnv("SETTINGS_FILE_PATH", "settings.json");

    const remoteHost = `${remoteIp}:${remotePort}`;
    const remoteBaseUrl = `http://${remoteHost}`;

    return Object.freeze({
        remoteIp,
        remotePort,
        remoteHost,
        remoteBaseUrl,
        apiVersion,
        appId,
        appName,
        appVersion,
        serverPort,
        tokenFilePath,
        settingsFilePath,
    });
}

export const config = loadConfig();
export type { Config };
