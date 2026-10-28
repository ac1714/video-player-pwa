/**
 * Remote Client (phone side)
 *
 * - Remembers the pairing (host peer ID + secret) in localStorage, so after the first
 *   QR scan the phone reconnects on its own every time the remote page is opened or
 *   brought back to the foreground — even days later.
 * - Detects dead links with a heartbeat and silently reconnects with backoff.
 */

import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';
import {
  REMOTE_PROTOCOL_VERSION,
  type HostToRemoteMessage,
  type PairingInfo,
  type RemoteCommand,
  type RemoteLibrary,
  type RemotePlaybackState,
  type RemoteToHostMessage,
} from './protocol';

const PAIRING_KEY = 'pwa_remote_pairing';
const DEVICE_ROLE_KEY = 'pwa_remote_device_role';
const HEARTBEAT_MS = 4000;
const DEAD_AFTER_MS = 11000;

export type ClientStatus = 'unpaired' | 'connecting' | 'connected' | 'host-offline' | 'denied' | 'error';

export interface ClientSnapshot {
  status: ClientStatus;
  pairing: PairingInfo | null;
  hostName: string | null;
  library: RemoteLibrary | null;
  playback: RemotePlaybackState | null;
  /** Local wall-clock (ms) when `playback` arrived, used for smooth timeline interpolation. */
  playbackReceivedAt: number;
  message?: string;
  latencyMs?: number;
}

type Listener = (snap: ClientSnapshot) => void;

export function loadPairing(): PairingInfo | null {
  try {
    const raw = localStorage.getItem(PAIRING_KEY);
    if (raw) return JSON.parse(raw) as PairingInfo;
  } catch {}
  return null;
}

function savePairing(info: PairingInfo | null) {
  try {
    if (info) localStorage.setItem(PAIRING_KEY, JSON.stringify(info));
    else localStorage.removeItem(PAIRING_KEY);
  } catch {}
}

/** When set to 'remote', the installed PWA on this phone opens straight into the remote. */
export function getDeviceRole(): 'remote' | 'full' | null {
  try {
    const v = localStorage.getItem(DEVICE_ROLE_KEY);
    return v === 'remote' || v === 'full' ? v : null;
  } catch {
    return null;
  }
}

export function setDeviceRole(role: 'remote' | 'full') {
  try {
    localStorage.setItem(DEVICE_ROLE_KEY, role);
  } catch {}
}

function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  const android = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/i);
  if (android?.[1] && !/^K$/i.test(android[1].trim())) return android[1].trim();
  if (/Android/i.test(ua)) return 'Android phone';
  return 'Phone';
}

class RemoteClient {
  private pairing: PairingInfo | null = null;
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private status: ClientStatus = 'unpaired';
  private message: string | undefined;
  private hostName: string | null = null;
  private library: RemoteLibrary | null = null;
  private playback: RemotePlaybackState | null = null;
  private playbackReceivedAt = 0;
  private latencyMs: number | undefined;
  private listeners = new Set<Listener>();

  private lastMessageAt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private started = false;

  init() {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.pairing = loadPairing();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.kick();
    });
    window.addEventListener('pageshow', () => this.kick());
    window.addEventListener('online', () => this.kick());
    window.addEventListener('focus', () => this.kick());

    if (this.pairing) this.connect();
    else this.setStatus('unpaired');
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  /** Store a new pairing (from a QR scan / link) and connect to it. */
  pair(info: PairingInfo) {
    this.pairing = info;
    savePairing(info);
    setDeviceRole('remote');
    this.library = null;
    this.playback = null;
    this.hostName = info.hostName || null;
    this.retryAttempt = 0;
    this.teardown();
    this.connect();
  }

  forget() {
    this.pairing = null;
    savePairing(null);
    this.library = null;
    this.playback = null;
    this.hostName = null;
    this.teardown();
    this.setStatus('unpaired');
  }

  send(cmd: RemoteCommand): boolean {
    return this.sendRaw({ t: 'cmd', cmd });
  }

  /** Force an immediate reconnect attempt (e.g. user tapped "Retry"). */
  retryNow() {
    this.retryAttempt = 0;
    if (this.status === 'denied') this.message = undefined;
    this.teardown();
    this.connect();
  }

  // ---------- internals ----------

  private snapshot(): ClientSnapshot {
    return {
      status: this.status,
      pairing: this.pairing,
      hostName: this.hostName || this.pairing?.hostName || null,
      library: this.library,
      playback: this.playback,
      playbackReceivedAt: this.playbackReceivedAt,
      message: this.message,
      latencyMs: this.latencyMs,
    };
  }

  private emit() {
    const snap = this.snapshot();
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {}
    }
  }

  private setStatus(status: ClientStatus, message?: string) {
    this.status = status;
    this.message = message;
    this.emit();
  }

  private kick() {
    if (!this.pairing || this.status === 'denied') return;
    if (this.status === 'connected' && this.conn?.open) {
      // Link may have died while the phone was asleep; verify right away.
      this.sendRaw({ t: 'ping', ts: Date.now() });
      if (Date.now() - this.lastMessageAt > DEAD_AFTER_MS) {
        this.retryNow();
      }
      return;
    }
    this.retryAttempt = 0;
    this.clearRetry();
    this.connect();
  }

  private connect() {
    if (!this.pairing) return;
    this.clearRetry();
    if (this.status !== 'host-offline') this.setStatus('connecting');

    // Reuse an open broker connection if we have one; otherwise (re)create it.
    if (this.peer && !this.peer.destroyed && !this.peer.disconnected && this.peer.open) {
      this.openDataConnection();
      return;
    }
    this.destroyPeer();

    const peer = new Peer({ debug: 0 });
    this.peer = peer;

    peer.on('open', () => {
      if (this.peer !== peer) return;
      this.openDataConnection();
    });

    peer.on('disconnected', () => {
      // Broker socket dropped; an established P2P data channel can keep working.
      if (this.peer !== peer || peer.destroyed) return;
      if (!this.conn?.open) this.scheduleRetry();
    });

    peer.on('error', (err: any) => {
      if (this.peer !== peer) return;
      const type: string = err?.type || 'unknown';
      if (type === 'peer-unavailable') {
        this.setStatus('host-offline', 'Your computer isn’t reachable. Make sure the Video Player is open on it.');
        this.closeConn();
        this.scheduleRetry(10000);
        return;
      }
      if (type === 'browser-incompatible') {
        this.setStatus('error', 'This browser does not support WebRTC.');
        return;
      }
      this.setStatus('connecting', 'Network hiccup — reconnecting…');
      this.destroyPeer();
      this.scheduleRetry();
    });
  }

  private openDataConnection() {
    if (!this.peer || !this.pairing) return;
    this.closeConn();

    // 'binary' (BinaryPack) auto-chunks large payloads such as big library lists;
    // PeerJS's 'json' mode rejects anything over ~16 KB.
    const conn = this.peer.connect(this.pairing.hostId, { reliable: true, serialization: 'binary' });
    this.conn = conn;

    const openTimeout = setTimeout(() => {
      if (this.conn === conn && !conn.open) {
        this.closeConn();
        this.scheduleRetry();
      }
    }, 12000);

    conn.on('open', () => {
      clearTimeout(openTimeout);
      if (this.conn !== conn) return;
      this.lastMessageAt = Date.now();
      this.sendRaw({
        t: 'hello',
        v: REMOTE_PROTOCOL_VERSION,
        token: this.pairing!.token,
        deviceName: guessDeviceName(),
      });
    });

    conn.on('data', (raw) => {
      if (this.conn !== conn) return;
      this.lastMessageAt = Date.now();
      this.handleMessage(raw as HostToRemoteMessage);
    });

    const onDrop = () => {
      clearTimeout(openTimeout);
      if (this.conn !== conn) return;
      this.conn = null;
      this.stopHeartbeat();
      if (this.status === 'denied' || !this.pairing) return;
      this.setStatus('connecting', 'Connection lost — reconnecting…');
      this.scheduleRetry();
    };
    conn.on('close', onDrop);
    conn.on('error', onDrop);
  }

  private handleMessage(msg: HostToRemoteMessage) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'welcome':
        this.hostName = msg.hostName;
        if (this.pairing && this.pairing.hostName !== msg.hostName) {
          this.pairing = { ...this.pairing, hostName: msg.hostName };
          savePairing(this.pairing);
        }
        this.retryAttempt = 0;
        this.startHeartbeat();
        this.setStatus('connected');
        break;
      case 'denied':
        this.closeConn();
        this.setStatus('denied', msg.reason);
        break;
      case 'library':
        this.library = msg.library;
        this.emit();
        break;
      case 'state':
        this.playback = msg.state;
        this.playbackReceivedAt = Date.now();
        this.emit();
        break;
      case 'pong':
        this.latencyMs = Math.max(0, Date.now() - msg.ts);
        break;
      case 'notice':
        this.message = msg.text;
        this.emit();
        break;
    }
  }

  private sendRaw(msg: RemoteToHostMessage): boolean {
    if (!this.conn?.open) return false;
    try {
      this.conn.send(msg);
      return true;
    } catch {
      return false;
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - this.lastMessageAt > DEAD_AFTER_MS) {
        this.retryNow();
        return;
      }
      this.sendRaw({ t: 'ping', ts: Date.now() });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleRetry(maxDelay = 15000) {
    if (!this.pairing || this.status === 'denied') return;
    this.clearRetry();
    const delay = Math.min(maxDelay, 1000 * 2 ** this.retryAttempt);
    this.retryAttempt = Math.min(this.retryAttempt + 1, 5);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // Don't burn battery retrying in the background; `kick()` resumes on return.
      if (document.visibilityState === 'visible') this.connect();
    }, delay);
  }

  private clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private closeConn() {
    const c = this.conn;
    this.conn = null;
    this.stopHeartbeat();
    if (c) {
      try {
        c.close();
      } catch {}
    }
  }

  private destroyPeer() {
    const p = this.peer;
    this.peer = null;
    if (p) {
      try {
        p.destroy();
      } catch {}
    }
  }

  private teardown() {
    this.clearRetry();
    this.closeConn();
    this.destroyPeer();
  }
}

export const remoteClient = new RemoteClient();
