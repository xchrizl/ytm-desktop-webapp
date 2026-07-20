(() => {
    "use strict";

    const el = (id) => document.getElementById(id);

    const dot = el("conn-dot");
    const connText = el("conn-text");
    const backdrop = el("backdrop");
    const art = el("art");
    const artPlaceholder = el("art-placeholder");
    const adBadge = el("ad-badge");
    const titleEl = el("title");
    const authorEl = el("author");
    const albumEl = el("album");
    const seek = el("seek");
    const timeCurrent = el("time-current");
    const timeTotal = el("time-total");
    const btnShuffle = el("btn-shuffle");
    const btnPrev = el("btn-prev");
    const btnPlayPause = el("btn-playpause");
    const iconPlay = el("icon-play");
    const iconPause = el("icon-pause");
    const btnNext = el("btn-next");
    const btnRepeat = el("btn-repeat");
    const iconRepeat = el("icon-repeat");
    const iconRepeatOne = el("icon-repeat-one");
    const btnDislike = el("btn-dislike");
    const btnLike = el("btn-like");
    const btnMute = el("btn-mute");
    const iconVol = el("icon-vol");
    const iconMute = el("icon-mute");
    const volumeSlider = el("volume");
    const queuePanel = el("queue-panel");
    const queueToggle = el("queue-toggle");
    const queueList = el("queue-list");
    const playlistsPanel = el("playlists-panel");
    const playlistsToggle = el("playlists-toggle");
    const playlistsList = el("playlists-list");
    const toast = el("toast");

    // Repeat mode as reported by the companion server: -1 Unknown, 0 None, 1 All, 2 One.
    const REPEAT_NONE = 0, REPEAT_ALL = 1, REPEAT_ONE = 2;
    // Like status: -1 Unknown, 0 Dislike, 1 Indifferent, 2 Like.
    const LIKE_DISLIKE = 0, LIKE = 2;
    // Track state: -1 Unknown, 0 Paused, 1 Playing, 2 Buffering.
    const TRACK_PLAYING = 1;

    let latestState = null; // last YTMStateRes received, or null
    let latestConnected = false;
    let cachedQueue = null; // last full queue received; reused when the server omits an unchanged one
    let remoteHost = null; // companion server "ip:port", from state messages
    let playlistsLoading = false;
    let seekDragging = false;
    let volumeDragging = false;
    let mutedLocally = false;
    let volumeBeforeMute = 100;
    let tickTimer = null;
    // Known limitation: the companion API has no field reporting whether
    // shuffle is on, so the shuffle button can't reflect real state -- it
    // just flashes briefly as feedback when clicked (see its handler).
    let shuffleFlashTimer = null;

    // Progress is tracked as an anchor (value + the real-time timestamp it was
    // true as of) rather than a value nudged forward by a timer. The server
    // pushes its own progress on basically every update too; incrementing a
    // stored value AND overwriting it from incoming state fight each other and
    // produce a stutter. Deriving the displayed value from elapsed real time
    // since the last anchor avoids that entirely.
    let progressAnchorValue = 0;
    let progressAnchorAt = 0;
    let progressIsPlaying = false;
    let progressDuration = Infinity;

    function formatTime(totalSeconds) {
        const s = Math.max(0, Math.floor(totalSeconds || 0));
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${m}:${String(r).padStart(2, "0")}`;
    }

    function showToast(message) {
        toast.textContent = message;
        toast.hidden = false;
        clearTimeout(showToast._t);
        showToast._t = setTimeout(() => {
            toast.hidden = true;
        }, 3500);
    }

    // Rendered sizes (in CSS px, scaled for hi-DPI screens) that thumbnails
    // are picked against -- requesting the largest available thumbnail for a
    // 36px queue row wastes bandwidth for no visible gain.
    const DPR = window.devicePixelRatio || 1;
    const ART_MIN_PX = 240 * DPR;
    const QUEUE_THUMB_MIN_PX = 36 * DPR;

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

    // --- WebSocket connection to our own Bun server (see src/server.ts) --------

    let ws = null;
    let reconnectDelay = 1000;
    const MAX_RECONNECT_DELAY = 10000;

    function setConnDot(status) {
        dot.classList.remove("connected", "waiting", "offline");
        dot.classList.add(status);
    }

    function updateStatusBar() {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            setConnDot("offline");
            connText.textContent = "Reconnecting to server…";
            return;
        }
        if (!latestConnected) {
            setConnDot("waiting");
            connText.textContent = "Waiting for YTM Desktop…";
            return;
        }
        setConnDot("connected");
        connText.textContent = remoteHost ? `Connected · ${remoteHost}` : "Connected";
    }

    function connectWs() {
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(`${protocol}//${location.host}/ws`);

        ws.addEventListener("open", () => {
            reconnectDelay = 1000;
            updateStatusBar();
        });

        ws.addEventListener("close", () => {
            updateStatusBar();
            setTimeout(connectWs, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        });

        ws.addEventListener("error", () => {
            ws.close();
        });

        ws.addEventListener("message", (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                return;
            }

            if (msg.type === "state") {
                latestConnected = !!msg.connected;
                remoteHost = msg.remoteHost || null;
                const state = msg.playerState || null;
                // The server omits the queue when it hasn't changed since the
                // last broadcast (it's the bulk of every payload) -- splice
                // the one we already have back in.
                if (state && msg.queueOmitted) {
                    state.player.queue = cachedQueue;
                } else {
                    cachedQueue = state ? state.player.queue : null;
                }
                latestState = state;
                updateStatusBar();
                render(latestState);
            } else if (msg.type === "playlists") {
                renderPlaylists(msg.playlists);
            } else if (msg.type === "error") {
                showToast(msg.message);
                if (playlistsLoading) {
                    playlistsLoading = false;
                    setPlaylistsLabel("Couldn't load playlists");
                }
            }
        });
    }

    function sendCommand(command) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            showToast("Not connected to server");
            return;
        }
        ws.send(JSON.stringify(command));
    }

    // --- Rendering ---------------------------------------------------------

    function render(state) {
        renderTrack(state);
        renderPlayer(state ? state.player : null);
        renderQueue(state ? state.player.queue : null);
        updateMediaSession(state);
    }

    // URL currently shown in the art <img> + backdrop, so state pushes that
    // don't change the track don't re-set src/background every tick (which
    // can retrigger loads and restarts the backdrop transition).
    let currentArtUrl = null;

    function setArt(url) {
        if (url === currentArtUrl) return;
        currentArtUrl = url;
        if (url) {
            art.src = url;
            art.style.display = "block";
            artPlaceholder.style.display = "none";
            backdrop.style.backgroundImage = `url("${url}")`;
        } else {
            art.removeAttribute("src");
            art.style.display = "none";
            artPlaceholder.style.display = "flex";
            backdrop.style.backgroundImage = "";
        }
    }

    function renderTrack(state) {
        const video = state ? state.video : null;

        if (!video) {
            titleEl.textContent = "Nothing playing";
            authorEl.textContent = "—";
            albumEl.textContent = "";
            setArt(null);
            document.title = "YTM Remote";
            return;
        }

        titleEl.textContent = video.title || "Unknown title";
        authorEl.textContent = video.author || "Unknown artist";
        albumEl.textContent = video.album || "";
        document.title = `${video.title} — YTM Remote`;

        const thumb = thumbnailFor(video.thumbnails, ART_MIN_PX);
        setArt(thumb ? thumb.url : null);

        btnLike.classList.toggle("active", video.likeStatus === LIKE);
        btnDislike.classList.toggle("active", video.likeStatus === LIKE_DISLIKE);

        seek.max = String(video.durationSeconds || 0);
        timeTotal.textContent = formatTime(video.durationSeconds);
    }

    function renderPlayer(player) {
        const hasPlayer = !!player;

        adBadge.hidden = !hasPlayer || !player.adPlaying;

        const playing = hasPlayer && player.trackState === TRACK_PLAYING;
        iconPlay.classList.toggle("icon-hidden", playing);
        iconPause.classList.toggle("icon-hidden", !playing);

        [btnPrev, btnNext, btnShuffle, btnRepeat, btnPlayPause, seek, btnLike, btnDislike].forEach((b) => {
            b.disabled = !hasPlayer;
        });

        if (!hasPlayer) {
            stopTicking();
            progressIsPlaying = false;
            seek.value = "0";
            timeCurrent.textContent = "0:00";
            return;
        }

        progressAnchorValue = player.videoProgress || 0;
        progressAnchorAt = performance.now();
        progressDuration = latestState?.video?.durationSeconds ?? Infinity;
        progressIsPlaying = playing && !player.adPlaying;

        if (!seekDragging) {
            renderProgress();
        }

        if (progressIsPlaying) {
            startTicking();
        } else {
            stopTicking();
        }

        const repeatMode = player.queue?.repeatMode ?? -1;
        const repeatOne = repeatMode === REPEAT_ONE;
        iconRepeat.classList.toggle("icon-hidden", repeatOne);
        iconRepeatOne.classList.toggle("icon-hidden", !repeatOne);
        btnRepeat.classList.toggle("active", repeatMode === REPEAT_ALL || repeatMode === REPEAT_ONE);

        if (!volumeDragging) {
            volumeSlider.value = String(player.volume ?? 0);
        }
        updateMuteIcon(mutedLocally || player.volume === 0);
    }

    function updateMuteIcon(isMuted) {
        iconVol.classList.toggle("icon-hidden", isMuted);
        iconMute.classList.toggle("icon-hidden", !isMuted);
    }

    // Identifies the track list rendered into #queue-list. State pushes
    // arrive on every progress tick; rebuilding dozens of <li>s (and their
    // <img>s) each time is by far the most expensive thing on the page, and
    // almost always the list hasn't changed -- only the selection has.
    let renderedQueueSignature = null;

    function queueSignature(queue) {
        const ids = (list) => (list || []).map((item) => `${item.videoId} ${item.title}`).join("\n");
        return `${ids(queue.items)}\n--automix--\n${ids(queue.automixItems)}`;
    }

    /** Builds one queue row; `index` is the position in the combined items+automix queue, which is what playQueueIndex expects. */
    function queueRow(item, index) {
        const li = document.createElement("li");
        li.className = "queue-item";
        if (item.selected) li.classList.add("selected");

        const thumb = thumbnailFor(item.thumbnails, QUEUE_THUMB_MIN_PX);
        const img = document.createElement("img");
        img.alt = "";
        if (thumb) img.src = thumb.url;

        const meta = document.createElement("div");
        meta.className = "queue-item-meta";

        const title = document.createElement("div");
        title.className = "queue-item-title";
        title.textContent = item.title;

        const author = document.createElement("div");
        author.className = "queue-item-author";
        author.textContent = item.author;

        meta.append(title, author);

        const duration = document.createElement("span");
        duration.className = "queue-item-duration";
        duration.textContent = item.duration;

        li.append(img, meta, duration);
        li.addEventListener("click", () => sendCommand({ command: "playQueueIndex", data: index }));
        return li;
    }

    function renderQueue(queue) {
        if (!queue || !queue.items || queue.items.length === 0) {
            queuePanel.hidden = true;
            queueList.textContent = "";
            renderedQueueSignature = null;
            return;
        }

        queuePanel.hidden = false;

        const automix = queue.automixItems || [];
        const signature = queueSignature(queue);
        if (signature === renderedQueueSignature) {
            // Same tracks -- just sync the selection highlight (skipping the
            // "Up next" label row, which isn't a .queue-item).
            const allItems = queue.items.concat(automix);
            const rows = queueList.querySelectorAll(".queue-item");
            rows.forEach((row, i) => {
                row.classList.toggle("selected", !!allItems[i] && allItems[i].selected);
            });
            return;
        }
        renderedQueueSignature = signature;
        queueList.textContent = "";

        queue.items.forEach((item, index) => {
            queueList.appendChild(queueRow(item, index));
        });

        if (automix.length > 0) {
            const label = document.createElement("li");
            label.className = "queue-section-label";
            label.textContent = "Up next";
            queueList.appendChild(label);
            // Automix items continue the queue's index space after the regular items.
            automix.forEach((item, i) => {
                queueList.appendChild(queueRow(item, queue.items.length + i));
            });
        }
    }

    // --- Local progress interpolation --------------------------------------
    // Derives the current playback position from the anchor set in
    // renderPlayer, rather than mutating a stored value tick by tick.

    function currentProgress() {
        if (!progressIsPlaying) return progressAnchorValue;
        const elapsedSeconds = (performance.now() - progressAnchorAt) / 1000;
        return Math.min(progressAnchorValue + elapsedSeconds, progressDuration);
    }

    function renderProgress() {
        if (seekDragging) return;
        const value = currentProgress();
        seek.value = String(Math.floor(value));
        timeCurrent.textContent = formatTime(value);
    }

    function startTicking() {
        if (tickTimer) return;
        tickTimer = setInterval(renderProgress, 250);
    }

    function stopTicking() {
        if (!tickTimer) return;
        clearInterval(tickTimer);
        tickTimer = null;
    }

    // --- Controls ------------------------------------------------------------

    btnShuffle.addEventListener("click", () => {
        sendCommand({ command: "shuffle" });
        btnShuffle.classList.add("active");
        clearTimeout(shuffleFlashTimer);
        shuffleFlashTimer = setTimeout(() => btnShuffle.classList.remove("active"), 1000);
    });
    btnPrev.addEventListener("click", () => sendCommand({ command: "previous" }));
    btnNext.addEventListener("click", () => sendCommand({ command: "next" }));
    btnPlayPause.addEventListener("click", () => sendCommand({ command: "playPause" }));
    btnLike.addEventListener("click", () => sendCommand({ command: "toggleLike" }));
    btnDislike.addEventListener("click", () => sendCommand({ command: "toggleDislike" }));

    btnRepeat.addEventListener("click", () => {
        const current = latestState?.player.queue?.repeatMode ?? REPEAT_NONE;
        const next = current === REPEAT_NONE ? REPEAT_ALL : current === REPEAT_ALL ? REPEAT_ONE : REPEAT_NONE;
        sendCommand({ command: "repeatMode", data: next });
    });

    btnMute.addEventListener("click", () => {
        const currentlyMuted = mutedLocally || (latestState && latestState.player.volume === 0);
        if (currentlyMuted) {
            mutedLocally = false;
            sendCommand({ command: "unmute" });
            if (latestState) volumeSlider.value = String(volumeBeforeMute);
        } else {
            volumeBeforeMute = Number(volumeSlider.value) || volumeBeforeMute;
            mutedLocally = true;
            sendCommand({ command: "mute" });
        }
        updateMuteIcon(mutedLocally);
    });

    seek.addEventListener("input", () => {
        seekDragging = true;
        timeCurrent.textContent = formatTime(Number(seek.value));
    });
    seek.addEventListener("change", () => {
        const value = Number(seek.value);
        sendCommand({ command: "seekTo", data: value });
        progressAnchorValue = value;
        progressAnchorAt = performance.now();
        seekDragging = false;
    });

    let volumeSendTimer = null;
    volumeSlider.addEventListener("input", () => {
        volumeDragging = true;
        mutedLocally = false;
        updateMuteIcon(Number(volumeSlider.value) === 0);
        clearTimeout(volumeSendTimer);
        volumeSendTimer = setTimeout(() => {
            sendCommand({ command: "setVolume", data: Number(volumeSlider.value) });
        }, 100);
    });
    volumeSlider.addEventListener("change", () => {
        // Cancel the debounced send from "input" so release doesn't fire setVolume twice.
        clearTimeout(volumeSendTimer);
        volumeDragging = false;
        sendCommand({ command: "setVolume", data: Number(volumeSlider.value) });
    });

    queueToggle.addEventListener("click", () => {
        queuePanel.classList.toggle("open");
    });

    // --- Playlists -----------------------------------------------------------

    function setPlaylistsLabel(text) {
        playlistsList.textContent = "";
        const li = document.createElement("li");
        li.className = "queue-section-label";
        li.textContent = text;
        playlistsList.appendChild(li);
    }

    function requestPlaylists() {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            showToast("Not connected to server");
            return;
        }
        playlistsLoading = true;
        setPlaylistsLabel("Loading playlists…");
        ws.send(JSON.stringify({ type: "getPlaylists" }));
    }

    function renderPlaylists(playlists) {
        playlistsLoading = false;
        // "LM" is the library's special Liked Music entry: YTM Desktop
        // accepts changeVideo for it but never starts playback (observed
        // live against companion server v1), so don't offer a dead row.
        const usable = (playlists || []).filter((pl) => pl.id !== "LM");
        if (usable.length === 0) {
            setPlaylistsLabel("No playlists");
            return;
        }
        playlistsList.textContent = "";
        for (const pl of usable) {
            const li = document.createElement("li");
            li.className = "playlist-item";
            li.textContent = pl.title;
            li.addEventListener("click", () => {
                sendCommand({ command: "changeVideo", data: { videoId: null, playlistId: pl.id } });
                showToast(`Playing "${pl.title}"`);
            });
            playlistsList.appendChild(li);
        }
    }

    playlistsToggle.addEventListener("click", () => {
        const open = playlistsPanel.classList.toggle("open");
        // Re-request on every open for freshness; the server caches, so this
        // doesn't hammer the (slow, rate-limited) companion endpoint.
        if (open) requestPlaylists();
    });

    // --- Keyboard shortcuts --------------------------------------------------

    function seekBy(deltaSeconds) {
        if (!latestState || !latestState.video) return;
        const target = Math.max(0, Math.min(currentProgress() + deltaSeconds, progressDuration));
        if (!Number.isFinite(target)) return;
        sendCommand({ command: "seekTo", data: Math.floor(target) });
        progressAnchorValue = target;
        progressAnchorAt = performance.now();
        renderProgress();
    }

    document.addEventListener("keydown", (e) => {
        // Don't steal keys from focused form controls (range sliders use the
        // arrows natively) or buttons (space would double-trigger), and leave
        // browser shortcuts alone.
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLButtonElement) return;

        switch (e.key) {
            case " ":
                e.preventDefault();
                sendCommand({ command: "playPause" });
                break;
            case "ArrowLeft":
                e.preventDefault();
                seekBy(-10);
                break;
            case "ArrowRight":
                e.preventDefault();
                seekBy(10);
                break;
            case "ArrowUp":
                e.preventDefault();
                sendCommand({ command: "volumeUp" });
                break;
            case "ArrowDown":
                e.preventDefault();
                sendCommand({ command: "volumeDown" });
                break;
            case "m":
                btnMute.click();
                break;
            case "n":
                sendCommand({ command: "next" });
                break;
            case "p":
                sendCommand({ command: "previous" });
                break;
        }
    });

    // --- Media Session -------------------------------------------------------
    // Lock-screen/media-key integration where the browser offers it. Note:
    // most browsers only surface these controls for pages actually playing
    // audio, so on many platforms this is best-effort only.

    function updateMediaSession(state) {
        if (!("mediaSession" in navigator)) return;
        const ms = navigator.mediaSession;
        const video = state ? state.video : null;
        if (!video) {
            ms.metadata = null;
            ms.playbackState = "none";
            return;
        }
        ms.metadata = new MediaMetadata({
            title: video.title || "",
            artist: video.author || "",
            album: video.album || "",
            artwork: (video.thumbnails || []).map((t) => ({ src: t.url, sizes: `${t.width}x${t.height}` })),
        });
        ms.playbackState = state.player.trackState === TRACK_PLAYING ? "playing" : "paused";
        if (Number.isFinite(video.durationSeconds) && video.durationSeconds > 0) {
            try {
                ms.setPositionState({
                    duration: video.durationSeconds,
                    position: Math.min(currentProgress(), video.durationSeconds),
                    playbackRate: 1,
                });
            } catch {
                // Invalid position states (e.g. position > duration mid-track-change) aren't worth breaking render over.
            }
        }
    }

    if ("mediaSession" in navigator) {
        const actions = [
            ["play", () => sendCommand({ command: "play" })],
            ["pause", () => sendCommand({ command: "pause" })],
            ["previoustrack", () => sendCommand({ command: "previous" })],
            ["nexttrack", () => sendCommand({ command: "next" })],
            ["seekto", (details) => sendCommand({ command: "seekTo", data: Math.floor(details.seekTime || 0) })],
        ];
        for (const [action, handler] of actions) {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch {
                // Action not supported by this browser -- fine.
            }
        }
    }

    // --- Init ------------------------------------------------------------------

    // PWA: the service worker only registers on secure origins (HTTPS or
    // localhost) -- over plain http on a LAN IP the browser refuses it, and
    // the app just runs as a normal page.
    if ("serviceWorker" in navigator && window.isSecureContext) {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    updateStatusBar();
    render(null);
    connectWs();
})();
