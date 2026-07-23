(() => {
    "use strict";

    const el = (id) => document.getElementById(id);

    const dot = el("conn-dot");
    const connText = el("conn-text");
    const backdrop = el("backdrop");
    const art = el("art");
    const artPlaceholder = el("art-placeholder");
    const adBadge = el("ad-badge");
    const metaEl = el("meta");
    const typeBadge = el("type-badge");
    const titleEl = el("title");
    const authorEl = el("author");
    const albumEl = el("album");
    const counterpartBtn = el("counterpart-btn");
    const queueStatus = el("queue-status");
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
    const silence = el("silence");
    const debugPanel = el("debug-panel");
    const settingsBtn = el("settings-btn");
    const settingsPanel = el("settings-panel");
    const hostIp = el("host-ip");
    const hostPort = el("host-port");
    const pairStatus = el("pair-status");
    const pairCode = el("pair-code");
    const pairBtn = el("pair-btn");

    // Pure, DOM-free helpers + companion-server enum constants live in
    // pure.js (loaded as a plain <script> before this one, so YtmPure is a
    // global) and are unit-tested in tests/pure.test.ts.
    const {
        REPEAT_NONE, REPEAT_ALL, REPEAT_ONE,
        LIKE_DISLIKE, LIKE,
        TRACK_PLAYING,
        VIDEO_TYPE_AUDIO, VIDEO_TYPE_VIDEO,
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
    } = YtmPure;

    let latestState = null; // last YTMStateRes received, or null
    let latestConnected = false;
    let authStatus = null; // last ConnectionStatus from the server, or null
    let cachedQueue = null; // last full queue received; reused when the server omits an unchanged one
    let remoteHost = null; // companion server "ip:port", from state messages
    let playlistsLoading = false;
    let seekDragging = false;
    let volumeDragging = false;
    let mutedLocally = false;
    let volumeBeforeMute = 100;
    let tickTimer = null;
    // Known limitation: the companion API has no field reporting whether
    // shuffle is on, so we can't read the real state back. Instead we track it
    // locally: each click flips this boolean and the button holds the "active"
    // (red) style to match. This can drift if shuffle is toggled directly in
    // the desktop app, but it gives the button a visible on/off state.
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

    // --- WebSocket connection to our own Bun server (see src/server.ts) --------

    let ws = null;
    let reconnectDelay = 1000;
    const MAX_RECONNECT_DELAY = 10000;

    function setConnDot(status) {
        dot.classList.remove("connected", "waiting", "offline");
        dot.classList.add(status);
    }

    function connectedText() {
        return remoteHost ? `Connected · ${remoteHost}` : "Connected";
    }

    function updateStatusBar() {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            setConnDot("offline");
            connText.textContent = "Reconnecting to server…";
            return;
        }
        // Once the server has reported an auth/connection status, it drives the
        // bar. Before the first status arrives, fall back to the connected flag
        // from state messages.
        switch (authStatus && authStatus.state) {
            case "connected":
                setConnDot("connected");
                connText.textContent = connectedText();
                return;
            case "connecting":
                setConnDot("waiting");
                connText.textContent = "Connecting to YTM Desktop…";
                return;
            case "pairing":
                setConnDot("waiting");
                connText.textContent = authStatus.code ? `Pairing — code ${authStatus.code}` : "Pairing…";
                return;
            case "unpaired":
                setConnDot("offline");
                connText.textContent = "Not paired";
                return;
            case "auth-error":
                setConnDot("offline");
                connText.textContent = "Re-authentication needed";
                return;
            case "disconnected":
                setConnDot("waiting");
                connText.textContent = "YTM Desktop unreachable";
                return;
            case "error":
                setConnDot("offline");
                connText.textContent = authStatus.message || "Connection error";
                return;
            default:
                setConnDot(latestConnected ? "connected" : "waiting");
                connText.textContent = latestConnected ? connectedText() : "Waiting for YTM Desktop…";
        }
    }

    function connectWs() {
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(`${protocol}//${location.host}/ws`);

        ws.addEventListener("open", () => {
            reconnectDelay = 1000;
            updateStatusBar();
            dispatchPendingShare();
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
            } else if (msg.type === "status") {
                authStatus = msg;
                if (msg.remoteHost) remoteHost = msg.remoteHost;
                updateStatusBar();
                renderSettings();
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

    // --- Web Share Target ("share to play") ----------------------------------
    // When launched via Android's Share sheet from the YouTube Music (or
    // YouTube) app, the manifest's share_target lands the shared URL on this
    // page as ?text=/?url=/?title= query params (see manifest.json). We parse
    // out the videoId/playlistId and fire the same `changeVideo` command the
    // playlists panel uses, so the shared song/playlist starts playing on the
    // paired desktop. A normal launch has no share params, so this is a no-op.

    // { videoId, playlistId } waiting to be sent once the WS is open, or null.
    let pendingShare = null;

    // Reads any share params off the launch URL, records the parsed target as
    // pendingShare, then strips the query so a manual reload doesn't replay it.
    function consumeShareFromUrl() {
        const params = new URLSearchParams(location.search);
        if (!params.has("text") && !params.has("url") && !params.has("title")) return;

        const share =
            parseYtmShare(params.get("url")) ||
            parseYtmShare(params.get("text")) ||
            parseYtmShare(params.get("title"));

        history.replaceState({}, "", location.pathname);

        if (!share) {
            showToast("Couldn't find a YouTube Music link to play");
            return;
        }
        pendingShare = share;
    }

    // Sends the queued share once the WS is open. Fires from the ws "open"
    // handler (and directly, if a share is consumed while already connected).
    function dispatchPendingShare() {
        if (!pendingShare) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        sendCommand({ command: "changeVideo", data: pendingShare });
        pendingShare = null;
        showToast("Playing shared link…");
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

    function setTypeBadge(badge) {
        if (!badge) {
            typeBadge.hidden = true;
            return;
        }
        typeBadge.textContent = badge.text;
        typeBadge.classList.toggle("live", badge.live);
        typeBadge.hidden = false;
    }

    // Shows/hides the audio<->video toggle from counterpartAction's decision
    // (see pure.js). The button only appears when the current track is
    // genuinely one half of an audio/video pair.
    function setCounterpart(state) {
        const action = counterpartAction(state);
        if (!action) {
            counterpartBtn.hidden = true;
            counterpartBtn.onclick = null;
            return;
        }

        const { targetId, label } = action;
        counterpartBtn.textContent = label;
        counterpartBtn.hidden = false;
        counterpartBtn.onclick = () => {
            sendCommand({ command: "changeVideo", data: { videoId: targetId, playlistId: null } });
            showToast(label);
        };
    }

    function renderTrack(state) {
        const video = state ? state.video : null;

        if (!video) {
            setTypeBadge(null);
            setCounterpart(null);
            metaEl.classList.remove("metadata-loading");
            titleEl.textContent = "Nothing playing";
            authorEl.textContent = "—";
            albumEl.textContent = "";
            setArt(null);
            document.title = "YTM Remote";
            return;
        }

        // metadataFilled is undefined on older companion servers -- only dim
        // when it's explicitly false, so behaviour is unchanged without it.
        metaEl.classList.toggle("metadata-loading", video.metadataFilled === false);
        setTypeBadge(typeBadgeFor(video));
        setCounterpart(state);
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

    // Endless/radio queue indicator. isGenerating (fetching more tracks) takes
    // precedence over the steady "Radio" label so the momentary state is
    // visible; neither shows for an ordinary finite queue.
    function setQueueStatus(queue) {
        let text = null;
        if (queue.isGenerating) text = "Adding songs…";
        else if (queue.isInfinite) text = "Radio";

        if (!text) {
            queueStatus.hidden = true;
            return;
        }
        queueStatus.textContent = text;
        queueStatus.hidden = false;
    }

    function renderQueue(queue) {
        if (!queue || !queue.items || queue.items.length === 0) {
            queuePanel.hidden = true;
            queueList.textContent = "";
            queueStatus.hidden = true;
            renderedQueueSignature = null;
            return;
        }

        queuePanel.hidden = false;
        // Runs every tick (isGenerating flips without the track list changing),
        // so it must be outside the signature short-circuit below.
        setQueueStatus(queue);

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
        return computeProgress({
            value: progressAnchorValue,
            at: progressAnchorAt,
            isPlaying: progressIsPlaying,
            duration: progressDuration,
        }, performance.now());
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
        shuffleActive = !shuffleActive;
        btnShuffle.classList.toggle("active", shuffleActive);
    });
    btnPrev.addEventListener("click", () => sendCommand({ command: "previous" }));
    btnNext.addEventListener("click", () => sendCommand({ command: "next" }));
    btnPlayPause.addEventListener("click", () => sendCommand({ command: "playPause" }));
    btnLike.addEventListener("click", () => sendCommand({ command: "toggleLike" }));
    btnDislike.addEventListener("click", () => sendCommand({ command: "toggleDislike" }));

    btnRepeat.addEventListener("click", () => {
        const current = latestState?.player.queue?.repeatMode ?? REPEAT_NONE;
        sendCommand({ command: "repeatMode", data: nextRepeatMode(current) });
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
        
        // discover mix
        // RDTMAK5uy_n_5IN6hzAOwdCnM8D8rzrs3vDl12UcZpA
        const li_discover = document.createElement("li");
        li_discover.className = "playlist-item";
        li_discover.textContent = "Discover Mix";
        li_discover.addEventListener("click", () => {
            sendCommand({ command: "changeVideo", data: { videoId: null, playlistId: "RDTMAK5uy_n_5IN6hzAOwdCnM8D8rzrs3vDl12UcZpA" } });
            showToast(`Playing "Discover Mix"`);
        });
        playlistsList.appendChild(li_discover);

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

    // --- Settings / pairing --------------------------------------------------
    // Driven by the server's `status` message (see updateStatusBar). Lets the
    // user change the companion host and run/redo pairing without editing .env.

    // Splits the live "ip:port" into the two inputs. Only called when the panel
    // opens, so incoming status updates never clobber what the user is typing.
    function fillHostInputs() {
        const parts = splitHostPort(remoteHost);
        if (!parts) return;
        hostIp.value = parts.ip;
        if (parts.port) hostPort.value = parts.port;
    }

    // True when the host typed in the inputs differs from the live host. The
    // single action button uses this to decide whether clicking it should
    // switch host first (label "Pair") or just (re-)pair the current one.
    function hostEdited() {
        const typed = `${hostIp.value.trim()}:${(hostPort.value || "").trim()}`;
        return !!remoteHost && typed !== remoteHost;
    }

    // Renders the pairing status line + code, and the single action button's
    // label/disabled state. One button covers every case:
    //   pairing in progress         -> "Pairing…" (disabled)
    //   host edited                 -> "Pair"  (switch host, then pair)
    //   not paired (unpaired/error) -> "Pair"
    //   paired, host unchanged      -> "Re-pair"
    function renderSettings() {
        const st = authStatus && authStatus.state;
        let text = "—";
        let showCode = false;

        switch (st) {
            case "connected":
                text = "Paired and connected.";
                break;
            case "connecting":
                text = "Connecting…";
                break;
            case "pairing":
                text = authStatus.code ? "Approve this code in YTM Desktop:" : "Requesting a pairing code…";
                showCode = !!authStatus.code;
                break;
            case "unpaired":
                text = authStatus.message || "Not paired yet.";
                break;
            case "auth-error":
                text = authStatus.message || "Session expired — pair again to reconnect.";
                break;
            case "disconnected":
                text = authStatus.message || "Companion server unreachable — retrying…";
                break;
            case "error":
                text = authStatus.message || "Something went wrong.";
                break;
        }

        pairStatus.textContent = text;
        pairCode.textContent = showCode ? authStatus.code : "";
        pairCode.hidden = !showCode;

        const pairing = st === "pairing";
        // "Re-pair" only when we're already on this host with a token; every
        // other case (no token, or a host change) is a plain "Pair".
        const paired = st === "connected" || st === "connecting" || st === "disconnected";
        pairBtn.disabled = pairing;
        pairBtn.textContent = pairing ? "Pairing…" : !hostEdited() && paired ? "Re-pair" : "Pair";
    }

    settingsBtn.addEventListener("click", () => {
        settingsPanel.hidden = !settingsPanel.hidden;
        settingsBtn.classList.toggle("open", !settingsPanel.hidden);
        if (!settingsPanel.hidden) {
            fillHostInputs();
            renderSettings();
        }
    });

    // Re-evaluate the button label as the user edits the host (typing a new
    // host flips "Re-pair" -> "Pair").
    hostIp.addEventListener("input", renderSettings);
    hostPort.addEventListener("input", renderSettings);

    pairBtn.addEventListener("click", () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            showToast("Not connected to server");
            return;
        }
        if (!hostEdited()) {
            // Same host: pair / re-pair in place.
            ws.send(JSON.stringify({ type: "startPairing" }));
            return;
        }
        // Host changed: validate, then switch + pair (the server continues
        // straight into pairing after the host change).
        const ip = hostIp.value.trim();
        const port = Number(hostPort.value);
        if (!ip) {
            showToast("Enter a host or IP");
            return;
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            showToast("Enter a valid port (1–65535)");
            return;
        }
        ws.send(JSON.stringify({ type: "setHost", ip, port }));
        showToast(`Switching to ${ip}:${port}…`);
    });

    // --- Swipe gestures ------------------------------------------------------
    // Horizontal swipe on the player card skips tracks: left = next,
    // right = previous. The album art follows the finger as feedback.

    const playerCard = el("player-card");
    const artWrap = document.querySelector(".art-wrap");
    const SWIPE_THRESHOLD_PX = 70; // finger travel required to trigger
    const SWIPE_LOCK_PX = 12; // travel before we decide horizontal vs vertical

    let swipeStartX = 0;
    let swipeStartY = 0;
    let swipeDeltaX = 0;
    let swipeTracking = false;
    // null = direction not decided yet; true = horizontal (ours); false =
    // vertical (leave it to the browser for scrolling).
    let swipeHorizontal = null;

    function swipeReset(animate) {
        if (animate && swipeHorizontal) {
            artWrap.style.transition = "transform 0.2s ease";
        }
        artWrap.style.transform = "";
        swipeTracking = false;
        swipeHorizontal = null;
        swipeDeltaX = 0;
    }

    playerCard.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) {
            swipeReset(false);
            return;
        }
        // Sliders and buttons own their touches (dragging the seek bar must
        // not skip the track).
        if (e.target.closest("button, input")) return;
        artWrap.style.transition = "";
        swipeStartX = e.touches[0].clientX;
        swipeStartY = e.touches[0].clientY;
        swipeTracking = true;
        swipeHorizontal = null;
        swipeDeltaX = 0;
    }, { passive: true });

    playerCard.addEventListener("touchmove", (e) => {
        if (!swipeTracking || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - swipeStartX;
        const dy = e.touches[0].clientY - swipeStartY;

        if (swipeHorizontal === null) {
            if (Math.abs(dx) < SWIPE_LOCK_PX && Math.abs(dy) < SWIPE_LOCK_PX) return;
            swipeHorizontal = Math.abs(dx) > Math.abs(dy);
            if (!swipeHorizontal) {
                swipeTracking = false;
                return;
            }
        }

        // Claim the gesture so the page doesn't scroll or overscroll-bounce
        // while swiping (needs the listener to be non-passive).
        if (e.cancelable) e.preventDefault();
        swipeDeltaX = dx;
        // Dampened drag so the art hints at the action without flying off.
        artWrap.style.transform = `translateX(${dx * 0.35}px)`;
    }, { passive: false });

    playerCard.addEventListener("touchend", () => {
        if (!swipeTracking) return;
        const dx = swipeDeltaX;
        const trigger = swipeHorizontal && Math.abs(dx) >= SWIPE_THRESHOLD_PX && latestState;
        swipeReset(true);
        if (trigger) {
            sendCommand({ command: dx < 0 ? "next" : "previous" });
        }
    });

    playerCard.addEventListener("touchcancel", () => swipeReset(true));

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
    // Lock-screen/notification and media-key integration. This page never
    // plays real audio itself (playback happens on the desktop app) -- but
    // Android Chrome only requests full audio focus (and shows the media
    // notification) for a page playing media over 5 seconds long, to avoid
    // triggering it for incidental UI sounds -- see
    // https://developer.chrome.com/blog/media-notifications. `silence` is a
    // 10s all-zero-PCM (true digital silence) WAV looped for as long as a
    // track is loaded, purely to keep the browser's media notification alive.
    // Chrome grants audio focus on play() without inspecting the samples, so
    // silence holds focus while producing no sound;
    // ms.playbackState still reflects the real (paused/playing) state shown
    // in the notification.
    let silenceUnlocked = false;
    let lastSilenceError = null;

    function unlockSilentAudio() {
        if (silenceUnlocked) return;
        silence
            .play()
            .then(() => {
                silenceUnlocked = true;
                lastSilenceError = null;
                updateMediaSession(latestState);
            })
            .catch((err) => {
                // Still locked (no user gesture yet, or autoplay blocked) -- try again next gesture.
                lastSilenceError = err && err.name ? err.name : String(err);
            });
    }
    document.addEventListener("pointerdown", unlockSilentAudio);

    function updateMediaSession(state) {
        if (!("mediaSession" in navigator)) return;
        const ms = navigator.mediaSession;
        const video = state ? state.video : null;
        if (!video) {
            ms.metadata = null;
            ms.playbackState = "none";
            silence.pause();
            return;
        }
        ms.metadata = new MediaMetadata({
            title: video.title || "",
            artist: video.author || "",
            album: video.album || "",
            artwork: (video.thumbnails || []).map((t) => ({ src: t.url, sizes: `${t.width}x${t.height}` })),
        });
        const playing = state.player.trackState === TRACK_PLAYING;
        ms.playbackState = playing ? "playing" : "paused";
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
        // Android derives the notification's own play/pause icon from whether
        // `silence` itself is actually playing, not just ms.playbackState --
        // so it has to track the real paused state, not just "is a track loaded".
        if (playing && silence.paused) {
            silence.play().catch((err) => {
                lastSilenceError = err && err.name ? err.name : String(err);
            });
        } else if (!playing && !silence.paused) {
            silence.pause();
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

    // --- Debug panel -----------------------------------------------------------
    // On-screen readout of Media Session / silent-audio state, for diagnosing
    // notification-controls issues on a phone without hooking up remote
    // devtools. Enable with ?debug=1 in the URL.

    if (new URLSearchParams(location.search).get("debug") === "1") {
        debugPanel.hidden = false;
        setInterval(() => {
            const ms = ("mediaSession" in navigator) ? navigator.mediaSession : null;
            debugPanel.textContent = [
                `connected: ${latestConnected}`,
                `video loaded: ${!!(latestState && latestState.video)}`,
                `silence: paused=${silence.paused} time=${silence.currentTime.toFixed(2)} vol=${silence.volume} muted=${silence.muted} readyState=${silence.readyState}`,
                `silenceUnlocked: ${silenceUnlocked}`,
                `lastSilenceError: ${lastSilenceError}`,
                `mediaSession.playbackState: ${ms ? ms.playbackState : "n/a"}`,
                `mediaSession.metadata.title: ${ms && ms.metadata ? ms.metadata.title : "n/a"}`,
                `isSecureContext: ${window.isSecureContext}`,
            ].join("\n");
        }, 500);
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
    consumeShareFromUrl();
    connectWs();
    // In case the socket opened synchronously above, don't wait on the handler.
    dispatchPendingShare();
})();
