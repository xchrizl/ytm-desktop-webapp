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
    const toast = el("toast");

    // Repeat mode as reported by the companion server: -1 Unknown, 0 None, 1 All, 2 One.
    const REPEAT_NONE = 0, REPEAT_ALL = 1, REPEAT_ONE = 2;
    // Like status: -1 Unknown, 0 Dislike, 1 Indifferent, 2 Like.
    const LIKE_DISLIKE = 0, LIKE = 2;
    // Track state: -1 Unknown, 0 Paused, 1 Playing, 2 Buffering.
    const TRACK_PLAYING = 1;

    let latestState = null; // last YTMStateRes received, or null
    let latestConnected = false;
    let seekDragging = false;
    let volumeDragging = false;
    let mutedLocally = false;
    let volumeBeforeMute = 100;
    let tickTimer = null;
    // The companion API has no field reporting whether shuffle is on, so this
    // is purely an optimistic local toggle -- it can drift from the real
    // state if shuffle is ever changed from within YTM Desktop directly.
    let shuffleActive = false;

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

    function largestThumbnail(thumbnails) {
        if (!thumbnails || thumbnails.length === 0) return null;
        return thumbnails.reduce((best, t) => (t.width > best.width ? t : best), thumbnails[0]);
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
        connText.textContent = "Connected";
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
                latestState = msg.playerState || null;
                updateStatusBar();
                render(latestState);
            } else if (msg.type === "error") {
                showToast(msg.message);
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
    }

    function renderTrack(state) {
        const video = state ? state.video : null;

        if (!video) {
            titleEl.textContent = "Nothing playing";
            authorEl.textContent = "—";
            albumEl.textContent = "";
            art.removeAttribute("src");
            art.style.display = "none";
            artPlaceholder.style.display = "flex";
            backdrop.style.backgroundImage = "";
            document.title = "YTM Remote";
            return;
        }

        titleEl.textContent = video.title || "Unknown title";
        authorEl.textContent = video.author || "Unknown artist";
        albumEl.textContent = video.album || "";
        document.title = `${video.title} — YTM Remote`;

        const thumb = largestThumbnail(video.thumbnails);
        if (thumb) {
            art.src = thumb.url;
            art.style.display = "block";
            artPlaceholder.style.display = "none";
            backdrop.style.backgroundImage = `url("${thumb.url}")`;
        } else {
            art.removeAttribute("src");
            art.style.display = "none";
            artPlaceholder.style.display = "flex";
            backdrop.style.backgroundImage = "";
        }

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

    function renderQueue(queue) {
        if (!queue || !queue.items || queue.items.length === 0) {
            queuePanel.hidden = true;
            queueList.textContent = "";
            return;
        }

        queuePanel.hidden = false;
        queueList.textContent = "";

        queue.items.forEach((item, index) => {
            const li = document.createElement("li");
            li.className = "queue-item";
            if (item.selected) li.classList.add("selected");

            const thumb = largestThumbnail(item.thumbnails);
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

            queueList.appendChild(li);
        });
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
        shuffleActive = !shuffleActive;
        btnShuffle.classList.toggle("active", shuffleActive);
        sendCommand({ command: "shuffle" });
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
        volumeDragging = false;
        sendCommand({ command: "setVolume", data: Number(volumeSlider.value) });
    });

    queueToggle.addEventListener("click", () => {
        queuePanel.classList.toggle("open");
    });

    // --- Init ------------------------------------------------------------------

    updateStatusBar();
    render(null);
    connectWs();
})();
