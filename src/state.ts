import type { YTMStateRes } from "./types";

export interface StateSnapshot {
    /** Last known player state from YTM. Null only until the very first state-update arrives. */
    playerState: YTMStateRes | null;
    /** Whether the ytm-socket connection is currently up. */
    connected: boolean;
}

type Listener = (snapshot: StateSnapshot) => void;

let playerState: YTMStateRes | null = null;
let connected = false;

const listeners = new Set<Listener>();

function emit(): void {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
        listener(snapshot);
    }
}

/** Returns an immutable snapshot of the current state. */
export function getSnapshot(): StateSnapshot {
    return { playerState, connected };
}

/** Called by ytm-socket's onStateUpdate handler whenever YTM pushes new player state. */
export function setPlayerState(state: YTMStateRes): void {
    playerState = state;
    emit();
}

/** Called by ytm-socket's onConnect/onDisconnect handlers. No-op (no re-emit) if the value hasn't changed. */
export function setConnected(value: boolean): void {
    if (connected === value) return;
    connected = value;
    emit();
}

/**
 * Subscribes to state changes. The listener is called immediately with the
 * current snapshot (so a newly-connected browser client doesn't have to
 * wait for the next YTM event to see anything), then again on every change.
 * Returns an unsubscribe function.
 */
export function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    listener(getSnapshot());
    return () => {
        listeners.delete(listener);
    };
}