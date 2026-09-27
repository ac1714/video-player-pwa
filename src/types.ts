/**
 * Relational Playlist & File Mapping Schema and Inter-Tab Protocol Types
 */

export interface MediaFile {
  id: string; // UUID
  name: string;
  relativePath?: string;
  mimeType: string;
  size: number;
  lastModified: number;
  handle?: FileSystemFileHandle;
  blobFallback?: Blob;
  duration?: number;
  createdAt: number;
}

export interface Playlist {
  id: string; // UUID
  name: string;
  createdAt: number;
  updatedAt: number;
  fileIds: string[]; // Ordered array of fileId references
}

export interface FilePlaylist {
  fileId: string;
  playlistId: string;
  addedAt: number;
}

// Inter-Tab Communication Protocol
export type SyncMessage =
  | {
      type: 'LOAD_TRACK';
      payload: {
        trackId: string;
        autoPlay?: boolean;
        playlistId?: string;
        blob?: Blob;
        currentTime?: number;
        volume?: number;
        muted?: boolean;
      };
    }
  | {
      type: 'REQUEST_TRACK_DATA';
      payload: {
        trackId: string;
      };
    }
  | {
      type: 'PROVIDE_TRACK_DATA';
      payload: {
        trackId: string;
        blob?: Blob;
        mimeType?: string;
        name?: string;
      };
    }
  | {
      type: 'PLAY';
    }
  | {
      type: 'PAUSE';
    }
  | {
      type: 'SEEK_TO';
      payload: {
        time: number;
      };
    }
  | {
      type: 'SET_VOLUME';
      payload: {
        volume: number; // 0.0 to 1.0
        muted: boolean;
      };
    }
  | {
      type: 'TIME_UPDATE';
      payload: {
        currentTime: number;
        duration: number;
        trackId?: string;
        isPopout?: boolean;
      };
    }
  | {
      type: 'STATE_CHANGE';
      payload: {
        state: 'playing' | 'paused' | 'buffering' | 'idle';
        isPopout?: boolean;
      };
    }
  | {
      type: 'TRACK_ENDED';
      payload: {
        trackId: string;
      };
    }
  | {
      type: 'PLAYLIST_MODIFIED';
      payload: {
        playlistId: string;
      };
    }
  | {
      type: 'SYNC_PING';
    }
  | {
      type: 'PLAYER_CONNECTED';
      payload?: {
        isPopout?: boolean;
        senderId?: string;
      };
    }
  | {
      type: 'PLAYER_DISCONNECTED';
      payload?: {
        isPopout?: boolean;
        senderId?: string;
        trackId?: string | null;
        currentTime?: number;
        autoResume?: boolean;
        isPlaying?: boolean;
      };
    }
  | {
      type: 'BRING_PLAYBACK_HERE';
      payload?: {
        trackId?: string;
        currentTime?: number;
      };
    }
  | {
      type: 'SET_FIT_MODE';
      payload: {
        fitMode: 'contain' | 'cover' | 'fill';
      };
    }
  | {
      type: 'QUEUE_UPDATED';
      payload: {
        queue: string[];
      };
    }
  | {
      type: 'TOGGLE_PIP';
    }
  | {
      type: 'NEXT_TRACK';
    }
  | {
      type: 'PREV_TRACK';
    }
  | {
      type: 'PIP_CHANGE';
      payload: {
        active: boolean;
      };
    }
  | {
      type: 'SET_LOOP';
      payload: {
        loop: boolean;
      };
    }
  | {
      type: 'SYNC_PONG';
      payload: {
        trackId: string | null;
        state: 'playing' | 'paused' | 'buffering' | 'idle';
        currentTime: number;
        duration: number;
        volume: number;
        muted: boolean;
        loop?: boolean;
        isPopout?: boolean;
      };
    };

export interface ActivePlaybackState {
  playlistId: string | null;
  trackId: string | null;
  trackIndex: number;
  volume: number;
  muted: boolean;
  lastTime: number;
  currentTime?: number;
  isPlaying?: boolean;
  loop?: boolean;
}
