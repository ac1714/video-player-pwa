/**
 * Phone Remote Protocol (PeerJS / WebRTC data channel)
 *
 * The Chromebook (host) owns the library, queue and player. The phone (remote)
 * only sends small JSON commands and receives lightweight state snapshots —
 * video bytes never cross the wire, so the active Chromecast tab/desktop cast
 * session is never touched.
 */

export const REMOTE_PROTOCOL_VERSION = 1;

export const HOST_ID_PREFIX = 'vps-remote-';

/** Multi-provider STUN servers to guarantee rapid NAT traversal on cellular & Wi-Fi networks */
export const WEBRTC_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export interface RemoteTrack {
  id: string;
  name: string;
  duration?: number;
  folder?: string;
  playCount?: number;
}

export interface RemotePlaylist {
  id: string;
  name: string;
  fileIds: string[];
}

export interface RemoteLibrary {
  tracks: RemoteTrack[];
  playlists: RemotePlaylist[];
}

export type RemotePlayerState = 'playing' | 'paused' | 'buffering' | 'idle';

export interface RemotePlaybackState {
  trackId: string | null;
  playlistId: string | null;
  state: RemotePlayerState;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  loop: boolean;
  autoPlayNext: boolean;
  queue: string[];
  /** Host-side wall clock (ms) when this snapshot was taken; lets the phone interpolate the timeline. */
  sentAt: number;
}

export type RemoteCommand =
  | { kind: 'play' }
  | { kind: 'pause' }
  | { kind: 'togglePlay' }
  | { kind: 'seek'; time: number }
  | { kind: 'skip'; delta: number }
  | { kind: 'next' }
  | { kind: 'prev' }
  | { kind: 'volume'; volume: number; muted: boolean }
  | { kind: 'loop'; loop: boolean }
  | { kind: 'playTrack'; trackId: string }
  | { kind: 'playPlaylist'; playlistId: string; startTrackId?: string }
  | { kind: 'queueAdd'; trackId: string; playNext?: boolean }
  | { kind: 'queueRemove'; index: number }
  | { kind: 'queueMove'; index: number; direction: 'up' | 'down' }
  | { kind: 'queueClear' }
  | { kind: 'addTrackToPlaylist'; trackId: string; playlistId: string };

/** Phone -> Chromebook */
export type RemoteToHostMessage =
  | { t: 'hello'; v: number; token: string; deviceName: string }
  | { t: 'cmd'; cmd: RemoteCommand }
  | { t: 'ping'; ts: number }
  | { t: 'requestLibrary' };

/** Chromebook -> Phone */
export type HostToRemoteMessage =
  | { t: 'welcome'; v: number; hostName: string }
  | { t: 'denied'; reason: string }
  | { t: 'library'; library: RemoteLibrary }
  | { t: 'state'; state: RemotePlaybackState }
  | { t: 'pong'; ts: number }
  | { t: 'notice'; text: string };

export interface PairingInfo {
  hostId: string;
  token: string;
  hostName?: string;
}

/** Encodes pairing info into the URL fragment (fragments are never sent to any server). */
export function encodePairingFragment(info: PairingInfo): string {
  const params = new URLSearchParams();
  params.set('pair', info.hostId);
  params.set('k', info.token);
  if (info.hostName) params.set('n', info.hostName);
  return params.toString();
}

export function decodePairingFragment(hash: string): PairingInfo | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const hostId = params.get('pair');
  const token = params.get('k');
  if (!hostId || !token || !hostId.startsWith(HOST_ID_PREFIX)) return null;
  return { hostId, token, hostName: params.get('n') || undefined };
}

export function randomId(length = 20): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Builds the URL the phone opens (also used as the QR code payload). */
export function getRemoteUrl(info?: PairingInfo): string {
  const segs = window.location.pathname.split('/').filter(Boolean);
  if (segs.length > 0 && segs[segs.length - 1].endsWith('.html')) segs.pop();
  const prefix = segs.length > 0 ? `/${segs.join('/')}/` : '/';
  const url = new URL(prefix, window.location.origin);
  url.searchParams.set('view', 'remote');
  if (info) url.hash = encodePairingFragment(info);
  return url.toString();
}
