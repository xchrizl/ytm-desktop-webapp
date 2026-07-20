import { afterEach, describe, expect, test } from "bun:test";
import { getSnapshot, setConnected, setPlayerState, subscribe, type StateSnapshot } from "../src/state";
import type { YTMStateRes } from "../src/types";

function makeState(playlistId = "PL_DEFAULT"): YTMStateRes {
    return {
        player: { trackState: 1, videoProgress: 0, volume: 100, adPlaying: false, queue: null },
        video: null,
        playlistId,
    };
}

// state.ts is a module-level singleton with no reset hook, so every test
// unsubscribes its own listeners and re-establishes whatever baseline it
// needs rather than assuming a pristine starting point.
const unsubscribers: Array<() => void> = [];
afterEach(() => {
    while (unsubscribers.length > 0) {
        unsubscribers.pop()!();
    }
});

function track(): { calls: StateSnapshot[] } {
    const calls: StateSnapshot[] = [];
    unsubscribers.push(subscribe((snapshot) => calls.push(snapshot)));
    return { calls };
}

describe("state", () => {
    test("subscribe immediately receives the current snapshot", () => {
        const { calls } = track();
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual(getSnapshot());
    });

    test("setPlayerState updates the snapshot and notifies listeners", () => {
        const { calls } = track();
        calls.length = 0; // drop the immediate initial call

        const state = makeState("PL_CHANGED");
        setPlayerState(state);

        expect(calls).toHaveLength(1);
        expect(calls[0]!.playerState).toEqual(state);
        expect(getSnapshot().playerState).toEqual(state);
    });

    test("setConnected notifies listeners when the value changes", () => {
        setConnected(false);
        const { calls } = track();
        calls.length = 0;

        setConnected(true);

        expect(calls).toHaveLength(1);
        expect(calls[0]!.connected).toBe(true);
        expect(getSnapshot().connected).toBe(true);
    });

    test("setConnected is a no-op when the value doesn't change", () => {
        setConnected(true);
        const { calls } = track();
        calls.length = 0;

        setConnected(true);

        expect(calls).toHaveLength(0);
    });

    test("unsubscribe stops further notifications", () => {
        const calls: StateSnapshot[] = [];
        const unsubscribe = subscribe((snapshot) => calls.push(snapshot));
        calls.length = 0;
        unsubscribe();

        setConnected(!getSnapshot().connected);

        expect(calls).toHaveLength(0);
    });
});
