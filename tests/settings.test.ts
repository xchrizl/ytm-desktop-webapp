import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { config } from "../src/config";
import { getRemoteBaseUrl, getRemoteHost, getRemoteIp, getRemotePort, isValidPort, setRemote } from "../src/settings";

// settings is a process-wide singleton seeded from config; restore the env
// defaults (and remove the persisted file) after each test so a mutation here
// doesn't leak into other test files that read the live host.
async function restoreDefaults(): Promise<void> {
    await setRemote(config.remoteIp, config.remotePort);
    try {
        await unlink(config.settingsFilePath);
    } catch {
        // Fine if it was never written.
    }
}

afterEach(restoreDefaults);
afterAll(restoreDefaults);

describe("settings", () => {
    test("defaults come from config (the env-seeded values)", () => {
        expect(getRemoteIp()).toBe(config.remoteIp);
        expect(getRemotePort()).toBe(config.remotePort);
        expect(getRemoteHost()).toBe(`${config.remoteIp}:${config.remotePort}`);
        expect(getRemoteBaseUrl()).toBe(`http://${config.remoteIp}:${config.remotePort}`);
    });

    test("setRemote updates the live host getters", async () => {
        await setRemote("10.0.0.5", 1234);

        expect(getRemoteIp()).toBe("10.0.0.5");
        expect(getRemotePort()).toBe(1234);
        expect(getRemoteHost()).toBe("10.0.0.5:1234");
        expect(getRemoteBaseUrl()).toBe("http://10.0.0.5:1234");
    });

    test("setRemote trims the host and persists it to disk as JSON", async () => {
        await setRemote("  192.168.1.9  ", 9999);

        expect(getRemoteHost()).toBe("192.168.1.9:9999");
        const persisted = JSON.parse(await Bun.file(config.settingsFilePath).text());
        expect(persisted).toEqual({ remoteIp: "192.168.1.9", remotePort: 9999 });
    });

    test("setRemote rejects an empty host and an out-of-range port", async () => {
        await expect(setRemote("", 9863)).rejects.toThrow(/required/i);
        await expect(setRemote("host", 0)).rejects.toThrow(/port/i);
        await expect(setRemote("host", 70000)).rejects.toThrow(/port/i);
    });

    test("isValidPort accepts 1-65535 and rejects everything else", () => {
        expect(isValidPort(1)).toBe(true);
        expect(isValidPort(65535)).toBe(true);
        expect(isValidPort(0)).toBe(false);
        expect(isValidPort(65536)).toBe(false);
        expect(isValidPort(9863.5)).toBe(false);
        expect(isValidPort("9863")).toBe(false);
    });
});
