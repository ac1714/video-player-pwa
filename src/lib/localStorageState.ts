/**
 * Active Playback State in localStorage
 * Fast key-value retrieval for active playlist, active track index, volume, etc.
 */

import { ActivePlaybackState } from '../types';

const STORAGE_KEYS = {
  PLAYLIST_ID: 'pwa_video_active_playlist_id',
  TRACK_ID: 'pwa_video_active_track_id',
  TRACK_INDEX: 'pwa_video_active_track_index',
  VOLUME: 'pwa_video_volume',
  MUTED: 'pwa_video_muted',
  LAST_TIME: 'pwa_video_last_time',
  AUTOPLAY: 'pwa_video_autoplay',
  LOOP: 'pwa_video_loop',
  PLAYING: 'pwa_video_is_playing',
};

export function getActivePlaybackState(): ActivePlaybackState {
  if (typeof window === 'undefined') {
    return {
      playlistId: null,
      trackId: null,
      trackIndex: 0,
      volume: 1,
      muted: false,
      lastTime: 0,
      currentTime: 0,
      isPlaying: false,
      loop: false,
    };
  }

  const playlistId = localStorage.getItem(STORAGE_KEYS.PLAYLIST_ID);
  const trackId = localStorage.getItem(STORAGE_KEYS.TRACK_ID);
  const trackIndexStr = localStorage.getItem(STORAGE_KEYS.TRACK_INDEX);
  const volumeStr = localStorage.getItem(STORAGE_KEYS.VOLUME);
  const mutedStr = localStorage.getItem(STORAGE_KEYS.MUTED);
  const lastTimeStr = localStorage.getItem(STORAGE_KEYS.LAST_TIME);
  const loopStr = localStorage.getItem(STORAGE_KEYS.LOOP);
  const isPlayingStr = localStorage.getItem(STORAGE_KEYS.PLAYING);
  const parsedTime = lastTimeStr ? parseFloat(lastTimeStr) : 0;

  return {
    playlistId: playlistId || null,
    trackId: trackId || null,
    trackIndex: trackIndexStr ? parseInt(trackIndexStr, 10) : 0,
    volume: volumeStr !== null ? parseFloat(volumeStr) : 1.0,
    muted: mutedStr === 'true',
    lastTime: parsedTime,
    currentTime: parsedTime,
    isPlaying: isPlayingStr === 'true',
    loop: loopStr === 'true',
  };
}

export function setActivePlaylistId(playlistId: string | null): void {
  if (typeof window === 'undefined') return;
  if (playlistId) {
    localStorage.setItem(STORAGE_KEYS.PLAYLIST_ID, playlistId);
  } else {
    localStorage.removeItem(STORAGE_KEYS.PLAYLIST_ID);
  }
}

export function setActiveTrack(trackId: string | null, index: number = 0): void {
  if (typeof window === 'undefined') return;
  if (trackId) {
    localStorage.setItem(STORAGE_KEYS.TRACK_ID, trackId);
    localStorage.setItem(STORAGE_KEYS.TRACK_INDEX, index.toString());
  } else {
    localStorage.removeItem(STORAGE_KEYS.TRACK_ID);
    localStorage.setItem(STORAGE_KEYS.TRACK_INDEX, '0');
  }
}

export function setVolumeState(volume: number, muted: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEYS.VOLUME, volume.toString());
  localStorage.setItem(STORAGE_KEYS.MUTED, muted ? 'true' : 'false');
}

export function setLastPlaybackTime(time: number): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEYS.LAST_TIME, time.toString());
}

export function getAutoPlaySetting(): boolean {
  if (typeof window === 'undefined') return true;
  const val = localStorage.getItem(STORAGE_KEYS.AUTOPLAY);
  return val === null ? true : val === 'true';
}

export function setAutoPlaySetting(autoPlay: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEYS.AUTOPLAY, autoPlay ? 'true' : 'false');
}

export function getLoopSetting(): boolean {
  if (typeof window === 'undefined') return false;
  const val = localStorage.getItem(STORAGE_KEYS.LOOP);
  return val === 'true';
}

export function setLoopSetting(loop: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEYS.LOOP, loop ? 'true' : 'false');
}

export function saveActivePlaybackState(state: Partial<ActivePlaybackState> & { isPlaying?: boolean }): void {
  if (typeof window === 'undefined') return;
  if (state.trackId !== undefined) {
    setActiveTrack(state.trackId, state.trackIndex ?? 0);
  }
  if (state.playlistId !== undefined) {
    setActivePlaylistId(state.playlistId);
  }
  if (state.volume !== undefined || state.muted !== undefined) {
    setVolumeState(state.volume ?? 1, state.muted ?? false);
  }
  if (state.lastTime !== undefined) {
    setLastPlaybackTime(state.lastTime);
  }
  if (state.currentTime !== undefined && state.lastTime === undefined) {
    setLastPlaybackTime(state.currentTime);
  }
  if (state.isPlaying !== undefined) {
    localStorage.setItem(STORAGE_KEYS.PLAYING, state.isPlaying ? 'true' : 'false');
  }
  if (state.loop !== undefined) {
    setLoopSetting(state.loop);
  }
}

const QUEUE_STORAGE_KEY = 'pwa_video_playback_queue';

export function getStoredQueue(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setStoredQueue(queue: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
  } catch {}
}

