// Pure, DOM-free helpers shared by the frontend (public/app.js) and exercised
// directly by the test suite (tests/pure.test.ts). Everything here is a plain
// function of its arguments -- no DOM, no WebSocket, no module-level mutable
// state -- so it can run under `bun test` without a browser.
//
// Loaded two ways: in the browser as a plain <script> before app.js (exposing
// `YtmPure` on the global), and in Bun tests via CommonJS `module.exports`.
// Keep it dependency-free and side-effect-free so both entry points stay cheap.
(function (root, factory) {
    const api = factory();
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        root.YtmPure = api;
    }
})(typeof self !== "undefined" ? self : globalThis, function () {
    "use strict";

    // Repeat mode as reported by the companion server: -1 Unknown, 0 None, 1 All, 2 One.
    const REPEAT_NONE = 0, REPEAT_ALL = 1, REPEAT_ONE = 2;
    // Like status: -1 Unknown, 0 Dislike, 1 Indifferent, 2 Like.
    const LIKE_DISLIKE = 0, LIKE = 2;
    // Track state: -1 Unknown, 0 Paused, 1 Playing, 2 Buffering.
    const TRACK_PLAYING = 1;
    // Video type: -1 Unknown, 0 Audio, 1 Video, 2 Uploaded, 3 Podcast. Only the
    // genuinely-distinct, rare kinds get a badge (see typeBadgeFor) -- ordinary
    // YTM tracks report Video, so badging that just adds noise to every song.
    // AUDIO/VIDEO are still used to label the audio<->video toggle button.
    const VIDEO_TYPE_AUDIO = 0, VIDEO_TYPE_VIDEO = 1, VIDEO_TYPE_UPLOAD = 2, VIDEO_TYPE_PODCAST = 3;

    /** Formats a duration in seconds as "m:ss"; clamps negatives/NaN to 0:00. */
    function formatTime(totalSeconds) {
        const s = Math.max(0, Math.floor(totalSeconds || 0));
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${m}:${String(r).padStart(2, "0")}`;
    }

    /** Smallest thumbnail still sharp at minWidth; falls back to the largest available if none is big enough. */
    function thumbnailFor(thumbnails, minWidth) {
        if (!thumbnails || thumbnails.length === 0) return null;
        let best = null;
        let largest = thumbnails[0];
        for (const t of thumbnails) {
            if (t.width > largest.width) largest = t;
            if (t.width >= minWidth && (!best || t.width < best.width)) best = t;
        }
        return best || largest;
    }

    /**
     * Extracts { videoId, playlistId } from a string that contains a YouTube
     * Music / YouTube URL (Android sometimes prefixes the URL with other text).
     * Returns null if no usable id is found.
     */
    function parseYtmShare(str) {
        if (!str) return null;
        const match = str.match(/https?:\/\/\S+/);
        if (!match) return null;

        let url;
        try {
            url = new URL(match[0]);
        } catch {
            return null;
        }

        const host = url.hostname.replace(/^www\./, "");
        const params = url.searchParams;
        let videoId = null;
        let playlistId = null;

        if (host === "youtu.be") {
            videoId = url.pathname.slice(1).split("/")[0] || null;
        } else if (host === "music.youtube.com" || host === "youtube.com" || host === "m.youtube.com") {
            if (url.pathname.startsWith("/playlist")) {
                playlistId = params.get("list");
            } else {
                // /watch (and share variants) carry v= and, for a song shared
                // from within a playlist/radio, an accompanying list= context.
                videoId = params.get("v");
                playlistId = params.get("list");
            }
        }

        if (!videoId && !playlistId) return null;
        return { videoId: videoId || null, playlistId: playlistId || null };
    }

    // A short label for the track's kind, or null for the common cases (audio,
    // and the near-ubiquitous "Video" type that ordinary YTM music reports).
    // Only podcasts, user uploads, and live streams -- which are genuinely
    // distinct and uncommon -- earn a badge. Live takes precedence. isLive and
    // videoType are only present on companion server >= 2.0.6.
    function typeBadgeFor(video) {
        if (video.isLive) return { text: "Live", live: true };
        switch (video.videoType) {
            case VIDEO_TYPE_PODCAST: return { text: "Podcast", live: false };
            case VIDEO_TYPE_UPLOAD: return { text: "Upload", live: false };
            default: return null;
        }
    }

    // The queue item flagged `selected` is the one currently playing -- the
    // source of the current track's `counterparts` (alternate audio/video
    // versions of the same song). Searches items then automix directly rather
    // than concatenating them, since this runs on every state tick.
    function currentQueueItem(state) {
        const queue = state && state.player ? state.player.queue : null;
        if (!queue) return null;
        return (queue.items || []).find((item) => item.selected)
            || (queue.automixItems || []).find((item) => item.selected)
            || null;
    }

    // Decides the audio<->video toggle. A queue item's own `videoId` and its
    // `counterpart` are the same song's two forms (audio + video). The item
    // keeps the audio videoId even once you've switched to the video, so we
    // don't target the counterpart directly -- we target whichever of the two
    // ids ISN'T currently playing, which works in both directions. Returns
    // { targetId, label } when the current track is genuinely one half of such
    // a pair, or null otherwise. The label reflects the current form: audio ->
    // "Watch video", video -> "Play audio only".
    function counterpartAction(state) {
        const current = currentQueueItem(state);
        const counterpart = current && current.counterparts && current.counterparts[0];
        const currentId = state && state.video ? state.video.id : null;

        const pair = current && counterpart ? [current.videoId, counterpart.videoId] : [];
        const targetId = currentId && pair.includes(currentId)
            ? pair.find((id) => id && id !== currentId)
            : null;

        if (!targetId) return null;

        const currentType = state.video ? state.video.videoType : undefined;
        let label = "Switch version";
        if (currentType === VIDEO_TYPE_VIDEO) label = "Play audio only";
        else if (currentType === VIDEO_TYPE_AUDIO) label = "Watch video";

        return { targetId, label };
    }

    // Stable identity of the track list rendered into the queue: the ordered
    // (videoId, title) of items then automix. Used to skip rebuilding the DOM
    // when only the selection changed. Any list reorder/add/remove changes it.
    function queueSignature(queue) {
        const ids = (list) => (list || []).map((item) => `${item.videoId} ${item.title}`).join("\n");
        return `${ids(queue.items)}\n--automix--\n${ids(queue.automixItems)}`;
    }

    // Cycles the repeat button: None -> All -> One -> None.
    function nextRepeatMode(current) {
        return current === REPEAT_NONE ? REPEAT_ALL : current === REPEAT_ALL ? REPEAT_ONE : REPEAT_NONE;
    }

    // Splits a live "ip:port" host string into its two parts for the settings
    // inputs. Splits on the LAST colon so IPv6-ish hosts keep their address
    // intact. Returns null for an empty host, and an empty port when absent.
    function splitHostPort(remoteHost) {
        if (!remoteHost) return null;
        const idx = remoteHost.lastIndexOf(":");
        if (idx === -1) return { ip: remoteHost, port: "" };
        return { ip: remoteHost.slice(0, idx), port: remoteHost.slice(idx + 1) };
    }

    // Derives the current playback position from a progress anchor
    // ({ value, at, isPlaying, duration }) and the current clock reading `now`
    // (both in the same time base, e.g. performance.now()). While paused the
    // anchor value stands; while playing it advances by real elapsed time,
    // capped at the track duration. This is the pure core of app.js's
    // stutter-free progress interpolation.
    function computeProgress(anchor, now) {
        if (!anchor.isPlaying) return anchor.value;
        const elapsedSeconds = (now - anchor.at) / 1000;
        return Math.min(anchor.value + elapsedSeconds, anchor.duration);
    }

    return {
        REPEAT_NONE, REPEAT_ALL, REPEAT_ONE,
        LIKE_DISLIKE, LIKE,
        TRACK_PLAYING,
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
    };
});
