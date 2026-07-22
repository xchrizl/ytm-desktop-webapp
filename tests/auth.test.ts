import { afterEach, describe, expect, test } from "bun:test";
import { getValidToken, invalidateToken, pairToken, readPersistedToken } from "../src/auth";
import { config } from "../src/config";
import { mockServer } from "./mock-companion-server";

async function readTokenFile(): Promise<string | null> {
    const file = Bun.file(config.tokenFilePath);
    if (!(await file.exists())) return null;
    const text = (await file.text()).trim();
    return text.length > 0 ? text : null;
}

afterEach(async () => {
    mockServer.reset();
    await invalidateToken();
});

describe("auth", () => {
    test("getValidToken pairs and persists a new token when none exists on disk", async () => {
        const token = await getValidToken();

        expect(token).toBe("valid-token");
        expect(await readTokenFile()).toBe("valid-token");
    });

    test("getValidToken reuses a persisted token without validating it", async () => {
        // A persisted token is trusted as-is (no round trip to the companion
        // server) -- even one the server would reject. Stale tokens are
        // handled reactively by the socket's auth-error path in index.ts,
        // which invalidates and re-pairs.
        await Bun.write(config.tokenFilePath, "some-possibly-stale-token");

        const token = await getValidToken();

        expect(token).toBe("some-possibly-stale-token");
    });

    test("getValidToken re-pairs after invalidateToken", async () => {
        await Bun.write(config.tokenFilePath, "some-old-revoked-token");
        await invalidateToken();

        const token = await getValidToken();

        expect(token).toBe("valid-token");
        expect(await readTokenFile()).toBe("valid-token");
    });

    test("invalidateToken removes the persisted token", async () => {
        await Bun.write(config.tokenFilePath, "valid-token");

        await invalidateToken();

        expect(await readTokenFile()).toBeNull();
    });

    test("invalidateToken is a no-op when there's nothing to delete", async () => {
        await invalidateToken();
        await expect(invalidateToken()).resolves.toBeUndefined();
    });

    test("readPersistedToken returns null when nothing is stored, the token when it is", async () => {
        expect(await readPersistedToken()).toBeNull();

        await Bun.write(config.tokenFilePath, "stored-token");
        expect(await readPersistedToken()).toBe("stored-token");
    });

    test("pairToken invokes onCode with the issued code and returns the token", async () => {
        const captured: { code: string | null } = { code: null };

        const token = await pairToken((code) => {
            captured.code = code;
        });

        expect(captured.code).toBe("TEST-CODE");
        expect(token).toBe("valid-token");
    });
});
