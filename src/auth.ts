import { unlink } from "node:fs/promises";
import { config } from "./config";
import { ApiError, getState, requestCode, requestToken } from "./api";

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
 * Checks whether a token is currently accepted by the companion server.
 * Throws on anything other than an auth failure (network errors, 5xx,
 * rate limits, etc.) so those aren't mistaken for "token is invalid".
 */
async function isTokenValid(token: string): Promise<boolean> {
    try {
        await getState(token);
        return true;
    } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
            return false;
        }
        throw err;
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
 * Returns a token guaranteed to be valid at the time of the call:
 * reuses the persisted token if it still works, otherwise runs the
 * pairing flow and persists the new token.
 */
export async function getValidToken(): Promise<string> {
    const existing = await readTokenFromDisk();

    if (existing) {
        try {
            if (await isTokenValid(existing)) {
                return existing;
            }
            console.log("Stored token was rejected by the companion server - re-pairing.");
        } catch (err) {
            // Couldn't tell whether the token is valid (e.g. a transient network
            // error) -- assume it's still good rather than forcing a re-pair and
            // crashing startup over what might just be a momentary blip.
            console.warn("Could not verify stored token, assuming it's still valid:", err);
            return existing;
        }
    }

    return pairNewToken();
}