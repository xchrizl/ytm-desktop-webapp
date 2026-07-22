// --- /metadata ---------------------------------------------------------------

export interface YTMMetadataRes {
    apiVersions: string[];
}

// --- /auth/requestcode ---------------------------------------------------------

export interface YTMCodeReq {
    appId: string;
    appName: string;
    appVersion: string;
}

export interface YTMCodeRes {
    code: string;
}

// --- /auth/request -------------------------------------------------------------

export interface YTMTokenReq {
    appId: string;
    code: string;
}

export interface YTMTokenRes {
    token: string;
}

// --- /state ----------------------------------------------------------------

export type YTMTrackState = -1 | 0 | 1 | 2; // Unknown, Paused, Playing, Buffering
export type YTMLikeStatus = -1 | 0 | 1 | 2; // Unknown, Dislike, Indifferent, Like
export type YTMRepeatMode = -1 | 0 | 1 | 2; // Unknown, None, All, One
export type YTMVideoType = -1 | 0 | 1 | 2 | 3; // Unknown, Audio, Video, Uploaded, Podcast

export interface YTMThumbnail {
    url: string;
    width: number;
    height: number;
}

export interface YTMQueueItem {
    thumbnails: YTMThumbnail[];
    title: string;
    author: string;
    duration: string;
    selected: boolean;
    videoId: string;
    /** Same shape as YTMQueueItem[], nested for alternate versions of this track. */
    counterparts: YTMQueueItem[] | null;
}

export interface YTMQueue {
    autoplay: boolean;
    items: YTMQueueItem[];
    /** Autoplay items appended after the normal queue, same shape as `items`. */
    automixItems: YTMQueueItem[];
    isGenerating: boolean;
    isInfinite: boolean;
    repeatMode: YTMRepeatMode;
    selectedItemIndex: number;
}

export interface YTMPlayerState {
    trackState: YTMTrackState;
    videoProgress: number;
    volume: number;
    /** While true, state reflects the ad currently playing; ad metadata is never provided. */
    adPlaying: boolean;
    queue: YTMQueue | null;
}

export interface YTMVideo {
    author: string;
    channelId: string;
    title: string;
    album: string | null;
    albumId: string | null;
    likeStatus: YTMLikeStatus | null;
    thumbnails: YTMThumbnail[];
    durationSeconds: number;
    id: string;
    // Present in companion server >= 2.0.6
    isLive?: boolean;
    videoType?: YTMVideoType;
    metadataFilled?: boolean;
}

export interface YTMStateRes {
    player: YTMPlayerState;
    video: YTMVideo | null;
    playlistId: string;
}

// --- /playlists --------------------------------------------------------------

export interface YTMPlaylist {
    id: string;
    title: string;
}

// --- Connection / auth status (this app -> browser) --------------------------
// Not part of the companion API: our own view of where the token/socket stand,
// broadcast to browsers so the UI can drive pairing and host switching.

export type ConnStatusState =
    | "unpaired" // no token; waiting for the user to start pairing
    | "pairing" // pairing flow running (a `code` may be present to show)
    | "connecting" // have a token, socket is connecting
    | "connected" // socket connected to the companion server
    | "disconnected" // socket dropped for a non-auth reason (host unreachable, etc.)
    | "auth-error" // token was rejected; user needs to re-pair
    | "error"; // pairing or host change failed (see `message`)

export interface ConnectionStatus {
    state: ConnStatusState;
    /** Live companion "ip:port" the status refers to. */
    remoteHost: string;
    /** Pairing code to confirm in YTM Desktop, present only while `state` is "pairing". */
    code?: string;
    /** Human-readable detail for "error"/"disconnected"/"auth-error" states. */
    message?: string;
}

// --- /command ----------------------------------------------------------------

export type YTMCommand =
    | { command: "playPause" }
    | { command: "play" }
    | { command: "pause" }
    | { command: "volumeUp" }
    | { command: "volumeDown" }
    | { command: "setVolume"; data: number } // 0-100
    | { command: "mute" }
    | { command: "unmute" }
    | { command: "seekTo"; data: number } // 0-durationSeconds
    | { command: "next" }
    | { command: "previous" }
    | { command: "repeatMode"; data: YTMRepeatMode }
    | { command: "shuffle" }
    | { command: "playQueueIndex"; data: number }
    | { command: "toggleLike" }
    | { command: "toggleDislike" }
    | { command: "changeVideo"; data: { videoId: string | null; playlistId: string | null } };