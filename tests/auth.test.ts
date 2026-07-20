import { afterEach, describe, expect, test } from "bun:test";
import { getValidToken, invalidateToken } from "../src/auth";
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

    test("getValidToken reuses a persisted token that's still accepted", async () => {
        await Bun.write(config.tokenFilePath, "valid-token");

        const token = await getValidToken();

        expect(token).toBe("valid-token");
    });

    test("getValidToken re-pairs when the persisted token is rejected", async () => {
        await Bun.write(config.tokenFilePath, "some-old-revoked-token");

        const token = await getValidToken();

        expect(token).toBe("valid-token");
        expect(await readTokenFile()).toBe("valid-token");
    });

    test("getValidToken trusts the persisted token if validation fails for a non-auth reason", async () => {
        await Bun.write(config.tokenFilePath, "valid-token");
        mockServer.forceErrorNextRequestTo = "/api/v1/state"; // 500, not 401/403

        const token = await getValidToken();

        // Optimistically trusted rather than treated as invalid -- a 500 isn't
        // proof the token is bad, just that the check itself failed.
        expect(token).toBe("valid-token");
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
});
