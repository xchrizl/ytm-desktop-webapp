import { afterEach, describe, expect, test } from "bun:test";
import { _resetApiBaseUrlCacheForTests, ApiError, RateLimitError, getPlaylists, getState, requestCode, requestToken, sendCommand } from "../src/api";
import { mockServer } from "./mock-companion-server";

afterEach(() => {
    mockServer.reset();
});

describe("api", () => {
    test("getState returns the mock server's current state for a valid token", async () => {
        mockServer.state.playlistId = "PL_TEST";
        const state = await getState("valid-token");
        expect(state.playlistId).toBe("PL_TEST");
    });

    test("getState throws ApiError with status 401 for an invalid token", async () => {
        await expect(getState("not-a-real-token")).rejects.toMatchObject({
            name: "ApiError",
            status: 401,
        });
    });

    test("requestCode + requestToken complete the pairing flow", async () => {
        const { code } = await requestCode({ appId: "a", appName: "b", appVersion: "1" });
        expect(code).toBe("TEST-CODE");

        const { token } = await requestToken({ appId: "a", code });
        expect(typeof token).toBe("string");
        expect(token.length).toBeGreaterThan(0);
    });

    test("sendCommand posts the command and the mock server records it", async () => {
        await sendCommand("valid-token", { command: "next" });
        expect(mockServer.receivedCommands).toEqual([{ command: "next" }]);
    });

    test("getPlaylists returns the mock server's playlists", async () => {
        const playlists = await getPlaylists("valid-token");
        expect(playlists.length).toBeGreaterThan(0);
    });

    test("a 429 response throws RateLimitError with retryAfterSeconds parsed from the header", async () => {
        mockServer.rateLimitNextRequestTo = "/api/v1/state";

        const error = await getState("valid-token").catch((err) => err);
        expect(error).toBeInstanceOf(RateLimitError);
        expect((error as RateLimitError).retryAfterSeconds).toBe(1);
    });

    test("resolveApiBaseUrl retries after a failed /metadata check instead of staying poisoned", async () => {
        _resetApiBaseUrlCacheForTests();
        mockServer.apiVersions = []; // companion server doesn't support our API_VERSION

        await expect(getState("valid-token")).rejects.toBeInstanceOf(ApiError);

        mockServer.apiVersions = ["v1"]; // "companion server" recovers
        const state = await getState("valid-token");
        expect(state).toBeTruthy();

        _resetApiBaseUrlCacheForTests(); // leave a clean cache for tests that ran after this one
    });
});
