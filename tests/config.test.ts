import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// src/config.ts validates env vars and calls process.exit(1) as a side effect
// of module evaluation, so it can't be imported in-process without risking
// killing the test runner. Spawn it as a subprocess instead and inspect the
// exit code / stderr, same as a real misconfigured run would produce.
const configPath = join(import.meta.dir, "..", "src", "config.ts");

const validEnv: Record<string, string> = {
    REMOTE_IP: "127.0.0.1",
    REMOTE_PORT: "9863",
    API_VERSION: "v1",
    APP_ID: "test-app",
    APP_NAME: "Test App",
    APP_VERSION: "1.0.0",
};

function envWithout(...keys: string[]): Record<string, string> {
    const env: Record<string, string> = { ...process.env, ...validEnv } as Record<string, string>;
    for (const key of keys) delete env[key];
    return env;
}

async function runConfig(env: Record<string, string>): Promise<{ exitCode: number; stderr: string }> {
    const proc = Bun.spawn(["bun", "run", configPath], {
        env,
        // Bun auto-loads a ".env" from the process's cwd, which would silently
        // re-inject the project's real values over whatever we pass here.
        // Run from a directory that has none, so `env` is authoritative.
        cwd: tmpdir(),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stderr };
}

describe("config", () => {
    test("exits 1 with a helpful message when a required var is missing", async () => {
        const { exitCode, stderr } = await runConfig(envWithout("REMOTE_IP"));
        expect(exitCode).toBe(1);
        expect(stderr).toContain("REMOTE_IP");
    }, 10000);

    test("exits 1 when a port var isn't a valid port number", async () => {
        const { exitCode, stderr } = await runConfig({ ...envWithout(), REMOTE_PORT: "not-a-port" });
        expect(exitCode).toBe(1);
        expect(stderr).toContain("REMOTE_PORT");
    }, 10000);

    test("exits 1 for an out-of-range port", async () => {
        const { exitCode, stderr } = await runConfig({ ...envWithout(), REMOTE_PORT: "99999" });
        expect(exitCode).toBe(1);
        expect(stderr).toContain("REMOTE_PORT");
    }, 10000);

    test("a whitespace-only value is treated the same as missing", async () => {
        const { exitCode, stderr } = await runConfig({ ...envWithout(), REMOTE_IP: "   " });
        expect(exitCode).toBe(1);
        expect(stderr).toContain("REMOTE_IP");
    }, 10000);

    test("succeeds when all required vars are present and valid", async () => {
        const { exitCode } = await runConfig(envWithout());
        expect(exitCode).toBe(0);
    }, 10000);
});
