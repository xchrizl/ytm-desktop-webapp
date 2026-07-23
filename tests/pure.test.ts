import { describe, expect, test } from "bun:test";
// pure.js is a dependency-free UMD module (public/pure.js) shared with the
// frontend; Bun loads its CommonJS export directly, no DOM needed.
import pure from "../public/pure.js";

const {
    REPEAT_NONE, REPEAT_ALL, REPEAT_ONE,
    VIDEO_TYPE_AUDIO, VIDEO_TYPE_VIDEO, VIDEO_TYPE_UPLOAD, VIDEO_TYPE_PODCAST,
    formatTime,
    thumbnailFor,
    parseYtmShare,
    typeBadgeFor,
    currentQueueItem,
    counterpartAction,
    queueSignature,
    nextRepeatMode,
    splitHostPort,
    computeProgress,
} = pure;

describe("formatTime", () => {
    test("formats minutes and zero-padded seconds", () => {
        expect(formatTime(0)).toBe("0:00");
        expect(formatTime(5)).toBe("0:05");
        expect(formatTime(65)).toBe("1:05");
        expect(formatTime(3599)).toBe("59:59");
    });

    test("floors fractional seconds", () => {
        expect(formatTime(9.9)).toBe("0:09");
    });

    test("clamps negatives and non-finite input to 0:00", () => {
        expect(formatTime(-10)).toBe("0:00");
        expect(formatTime(NaN)).toBe("0:00");
        expect(formatTime(undefined)).toBe("0:00");
    });
});

describe("thumbnailFor", () => {
    const thumbs = [
        { url: "s", width: 60 },
        { url: "m", width: 120 },
        { url: "l", width: 240 },
    ];

    test("returns null for empty or missing input", () => {
        expect(thumbnailFor(null, 100)).toBeNull();
        expect(thumbnailFor([], 100)).toBeNull();
    });

    test("picks the smallest thumbnail at or above minWidth", () => {
        expect(thumbnailFor(thumbs, 100)!.url).toBe("m");
        expect(thumbnailFor(thumbs, 120)!.url).toBe("m");
        expect(thumbnailFor(thumbs, 121)!.url).toBe("l");
    });

    test("falls back to the largest when none is big enough", () => {
        expect(thumbnailFor(thumbs, 9999)!.url).toBe("l");
    });

    test("does not assume the array is sorted by width", () => {
        const unsorted = [
            { url: "l", width: 240 },
            { url: "s", width: 60 },
            { url: "m", width: 120 },
        ];
        expect(thumbnailFor(unsorted, 100)!.url).toBe("m");
        expect(thumbnailFor(unsorted, 9999)!.url).toBe("l");
    });
});

describe("parseYtmShare", () => {
    test("returns null when there is no URL", () => {
        expect(parseYtmShare("")).toBeNull();
        expect(parseYtmShare(null)).toBeNull();
        expect(parseYtmShare("just some text")).toBeNull();
    });

    test("extracts a videoId from a music.youtube.com watch link", () => {
        expect(parseYtmShare("https://music.youtube.com/watch?v=abc123")).toEqual({
            videoId: "abc123",
            playlistId: null,
        });
    });

    test("keeps the list= context when a song is shared from a playlist", () => {
        expect(parseYtmShare("https://music.youtube.com/watch?v=abc123&list=PL42")).toEqual({
            videoId: "abc123",
            playlistId: "PL42",
        });
    });

    test("extracts a playlistId alone from a /playlist link", () => {
        expect(parseYtmShare("https://music.youtube.com/playlist?list=PL42")).toEqual({
            videoId: null,
            playlistId: "PL42",
        });
    });

    test("handles youtu.be short links", () => {
        expect(parseYtmShare("https://youtu.be/abc123")).toEqual({
            videoId: "abc123",
            playlistId: null,
        });
    });

    test("handles a www. prefix and plain youtube.com", () => {
        expect(parseYtmShare("https://www.youtube.com/watch?v=abc123")).toEqual({
            videoId: "abc123",
            playlistId: null,
        });
    });

    test("pulls the URL out of surrounding shared text", () => {
        expect(parseYtmShare("Check this out https://music.youtube.com/watch?v=abc123 cool")).toEqual({
            videoId: "abc123",
            playlistId: null,
        });
    });

    test("returns null for an unrecognized host", () => {
        expect(parseYtmShare("https://example.com/watch?v=abc123")).toBeNull();
    });

    test("returns null for a malformed URL", () => {
        expect(parseYtmShare("http://")).toBeNull();
    });
});

describe("typeBadgeFor", () => {
    test("live takes precedence over videoType", () => {
        expect(typeBadgeFor({ isLive: true, videoType: VIDEO_TYPE_PODCAST })).toEqual({
            text: "Live",
            live: true,
        });
    });

    test("badges podcasts and uploads", () => {
        expect(typeBadgeFor({ videoType: VIDEO_TYPE_PODCAST })).toEqual({ text: "Podcast", live: false });
        expect(typeBadgeFor({ videoType: VIDEO_TYPE_UPLOAD })).toEqual({ text: "Upload", live: false });
    });

    test("returns null for ordinary audio/video tracks", () => {
        expect(typeBadgeFor({ videoType: VIDEO_TYPE_AUDIO })).toBeNull();
        expect(typeBadgeFor({ videoType: VIDEO_TYPE_VIDEO })).toBeNull();
        expect(typeBadgeFor({})).toBeNull();
    });
});

describe("currentQueueItem", () => {
    test("returns null when there is no queue", () => {
        expect(currentQueueItem(null)).toBeNull();
        expect(currentQueueItem({ player: {} })).toBeNull();
        expect(currentQueueItem({ player: { queue: null } })).toBeNull();
    });

    test("finds the selected item among the regular items", () => {
        const item = { videoId: "b", selected: true };
        const state = { player: { queue: { items: [{ videoId: "a" }, item] } } };
        expect(currentQueueItem(state)).toBe(item);
    });

    test("falls back to a selected automix item", () => {
        const item = { videoId: "x", selected: true };
        const state = { player: { queue: { items: [{ videoId: "a" }], automixItems: [item] } } };
        expect(currentQueueItem(state)).toBe(item);
    });

    test("returns null when nothing is selected", () => {
        const state = { player: { queue: { items: [{ videoId: "a" }], automixItems: [{ videoId: "b" }] } } };
        expect(currentQueueItem(state)).toBeNull();
    });
});

describe("counterpartAction", () => {
    function stateWithPair(currentId: string, videoType?: number) {
        return {
            video: { id: currentId, videoType },
            player: {
                queue: {
                    items: [
                        {
                            videoId: "audioId",
                            selected: true,
                            counterparts: [{ videoId: "videoId" }],
                        },
                    ],
                },
            },
        };
    }

    test("returns null when the current track has no counterpart", () => {
        const state = { video: { id: "a" }, player: { queue: { items: [{ videoId: "a", selected: true }] } } };
        expect(counterpartAction(state)).toBeNull();
    });

    test("targets the video form when currently playing the audio form", () => {
        expect(counterpartAction(stateWithPair("audioId", VIDEO_TYPE_AUDIO))).toEqual({
            targetId: "videoId",
            label: "Watch video",
        });
    });

    test("targets the audio form when currently playing the video form", () => {
        expect(counterpartAction(stateWithPair("videoId", VIDEO_TYPE_VIDEO))).toEqual({
            targetId: "audioId",
            label: "Play audio only",
        });
    });

    test("uses a generic label when videoType is unknown", () => {
        expect(counterpartAction(stateWithPair("audioId", undefined))).toEqual({
            targetId: "videoId",
            label: "Switch version",
        });
    });

    test("returns null when the playing id is neither half of the pair", () => {
        expect(counterpartAction(stateWithPair("somethingElse"))).toBeNull();
    });
});

describe("queueSignature", () => {
    test("is stable across selection-only changes", () => {
        const a = { items: [{ videoId: "1", title: "A", selected: false }], automixItems: [] };
        const b = { items: [{ videoId: "1", title: "A", selected: true }], automixItems: [] };
        expect(queueSignature(a)).toBe(queueSignature(b));
    });

    test("changes when the track list changes", () => {
        const a = { items: [{ videoId: "1", title: "A" }], automixItems: [] };
        const b = { items: [{ videoId: "2", title: "B" }], automixItems: [] };
        expect(queueSignature(a)).not.toBe(queueSignature(b));
    });

    test("distinguishes items from automix items", () => {
        const a = { items: [{ videoId: "1", title: "A" }], automixItems: [] };
        const b = { items: [], automixItems: [{ videoId: "1", title: "A" }] };
        expect(queueSignature(a)).not.toBe(queueSignature(b));
    });

    test("tolerates missing lists", () => {
        expect(() => queueSignature({})).not.toThrow();
    });
});

describe("nextRepeatMode", () => {
    test("cycles None -> All -> One -> None", () => {
        expect(nextRepeatMode(REPEAT_NONE)).toBe(REPEAT_ALL);
        expect(nextRepeatMode(REPEAT_ALL)).toBe(REPEAT_ONE);
        expect(nextRepeatMode(REPEAT_ONE)).toBe(REPEAT_NONE);
    });

    test("resets an unknown mode to None (only an explicit None advances to All)", () => {
        expect(nextRepeatMode(-1)).toBe(REPEAT_NONE);
    });
});

describe("splitHostPort", () => {
    test("returns null for an empty host", () => {
        expect(splitHostPort(null)).toBeNull();
        expect(splitHostPort("")).toBeNull();
    });

    test("splits ip and port on the last colon", () => {
        expect(splitHostPort("192.168.1.5:9863")).toEqual({ ip: "192.168.1.5", port: "9863" });
    });

    test("keeps an IPv6-style address intact by splitting on the last colon", () => {
        expect(splitHostPort("::1:9863")).toEqual({ ip: "::1", port: "9863" });
    });

    test("returns an empty port when the host has no colon", () => {
        expect(splitHostPort("myhost")).toEqual({ ip: "myhost", port: "" });
    });
});

describe("computeProgress", () => {
    test("returns the anchor value unchanged while paused", () => {
        const anchor = { value: 42, at: 1000, isPlaying: false, duration: 200 };
        expect(computeProgress(anchor, 999999)).toBe(42);
    });

    test("advances by real elapsed time while playing", () => {
        const anchor = { value: 10, at: 1000, isPlaying: true, duration: 200 };
        // 4000ms later -> +4s
        expect(computeProgress(anchor, 5000)).toBe(14);
    });

    test("never exceeds the track duration", () => {
        const anchor = { value: 195, at: 0, isPlaying: true, duration: 200 };
        expect(computeProgress(anchor, 60_000)).toBe(200);
    });
});
