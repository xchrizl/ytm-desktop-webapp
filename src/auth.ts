import { unlink } from "node:fs/promises";
import { config } from "./config";
import { requestCode, requestToken } from "./api";

/**
 * Reads the persisted token from disk, if present.
 * Returns null if the file doesn't exist or is empty.
 */
async function readTokenFromDisk(): Promise<string | null> {
    const file = Bun.file(config.tokenFilePath);
    if (!(await file.exists()) || file.size === 0) {
        return null;
    }
    const token = (await file.text()).trim();
    return token.length > 0 ? token : null;
}

async function writeTokenToDisk(token: string): Promise<void> {
    await Bun.write(config.tokenFilePath, token);
}

/**
 * Deletes the persisted token, forcing a fresh pairing flow next time
 * `getValidToken` is called. Useful if the companion server revokes a
 * token mid-session (e.g. the socket connection rejects auth).
 */
export async function invalidateToken(): Promise<void> {
    try {
        await unlink(config.tokenFilePath);
    } catch (err) {
        // ENOENT just means there was nothing to delete -- not an error for our purposes.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
        }
    }
}

/**
 * Runs the full requestcode -> (user approves in YTM Desktop) -> request
 * pairing flow, persists the resulting token, and returns it.
 *
 * Note: the token exchange step blocks for up to 30s server-side while
 * waiting for the user to approve the pairing prompt in the app.
 */
async function pairNewToken(): Promise<string> {
    console.log("No valid token found - starting pairing flow...");

    const { code } = await requestCode({
        appId: config.appId,
        appName: config.appName,
        appVersion: config.appVersion,
    });

    console.log(`Open YTM Desktop and approve this pairing code: ${code}`);

    const { token } = await requestToken({
        appId: config.appId,
        code,
    });

    // The token is already valid at this point (the user just approved it) --
    // don't throw it away if persisting it fails, or the whole approve-a-code
    // flow has to be repeated on the next run for no reason.
    try {
        await writeTokenToDisk(token);
        console.log("Paired successfully - token saved to", config.tokenFilePath);
    } catch (err) {
        console.warn(
            `Paired successfully, but failed to save token to ${config.tokenFilePath} - ` +
                `it won't persist across restarts:`,
            err,
        );
    }

    return token;
}

/**
 * Returns the token to use: the persisted one if present, otherwise runs
 * the pairing flow and persists the result. The persisted token is trusted
 * without a validation round trip -- if it turns out to be stale, the
 * socket's auth-error path (see index.ts) calls invalidateToken and then
 * this again, which then re-pairs.
 */
export async function getValidToken(): Promise<string> {
    const existing = await readTokenFromDisk();
    return existing ?? pairNewToken();
}