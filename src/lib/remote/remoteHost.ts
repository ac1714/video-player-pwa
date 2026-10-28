/**
 * Remote Host (Chromebook side)
 *
 * - Registers a *persistent* PeerJS ID so a paired phone can always find it again.
 * - Only one tab per browser profile hosts at a time (Web Locks). Other tabs wait in
 *   standby and take over automatically if the hosting tab closes.
 * - Auto-recovers from broker disconnects, sleep/wake, Wi-Fi blips and "ID still taken"
 *   errors with exponential backoff.
 */

import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';
import {
  HOST_ID_PREFIX,
  REMOTE_PROTOCOL_VERSION,
  randomId,
  type HostToRemoteMessage,
  type PairingInfo,
  type RemoteCommand,
  type RemoteLibrary,
  type RemotePlaybackState,
  type RemoteToHostMessage,
} from './protocol';

const CONFIG_KEY = 'pwa_remote_host_config';
const LOCK_NAME = 'pwa_remote_host_lock';

export type HostStatus = 'disabled' | 'standby' | 'connecting' | 'online' | 'error';

export interface HostStatusSnapshot {
  status: HostStatus;
  enabled: boolean;
  connectedDevices: string[];
  error?: string;
  pairing: PairingInfo | null;
}

interface HostConfig {
  hostId: string;
  token: string;
  enabled: boolean;
  hostName: string;
}

interface ConnInfo {
  conn: DataConnection;
  authed: boolean;
  deviceName: string;
}

function defaultHostName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/CrOS/i.test(ua)) return 'Chromebook';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Linux/i.test(ua)) return 'Linux PC';
  return 'Computer';
}

function loadConfig(): HostConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HostConfig;
    if (parsed?.hostId?.startsWith(HOST_ID_PREFIX) && parsed.token) return parsed;
  } catch {}
  return null;
}

function saveConfig(cfg: HostConfig) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch {}
}

function createConfig(enabled: boolean): HostConfig {
  return {
    hostId: `${HOST_ID_PREFIX}${randomId(20)}`,
    token: randomId(24),
    enabled,
    hostName: defaultHostName(),
  };
}

type CommandHandler = (cmd: RemoteCommand) => void;
type StatusListener = (snap: HostStatusSnapshot) => void;

class RemoteHost {
  private config: HostConfig | null = null;
  private peer: Peer | null = null;
  private conns = new Map<string, ConnInfo>();
  private status: HostStatus = 'disabled';
  private lastError: string | undefined;
  private listeners = new Set<StatusListener>();
  private commandHandler: CommandHandler | null = null;

  private library: RemoteLibrary | null = null;
  private libraryJson = '';
  private playback: RemotePlaybackState | null = null;
  private lastPlaybackSentAt = 0;
  private lastPlaybackKey = '';
  private pendingStateTimer: ReturnType<typeof setTimeout> | null = null;

  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  private lockAbort: AbortController | null = null;
  private releaseLock: (() => void) | null = null;
  private hasLock = false;
  private lockGeneration = 0;
  private started = false;

  /** Call once on app start (from the controller window). Starts hosting if previously enabled. */
  init() {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.config = loadConfig();

    window.addEventListener('online', () => this.kick('online'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.kick('visible');
    });
    window.addEventListener('pagehide', () => this.teardownPeer());

    if (this.config?.enabled) this.acquireLockAndStart();
    else this.setStatus('disabled');
  }

  // ---------- Public API ----------

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  setCommandHandler(handler: CommandHandler | null) {
    this.commandHandler = handler;
  }

  /** Enables hosting (creating a pairing on first use). Returns the pairing info for the QR code. */
  enable(): PairingInfo {
    if (!this.config) this.config = createConfig(true);
    this.config.enabled = true;
    saveConfig(this.config);
    this.acquireLockAndStart();
    this.emit();
    return this.pairingInfo()!;
  }

  disable() {
    if (this.config) {
      this.config.enabled = false;
      saveConfig(this.config);
    }
    this.stopHosting();
    this.setStatus('disabled');
  }

  /** Forgets every paired phone by rotating the peer ID and secret. */
  resetPairing(): PairingInfo {
    const wasEnabled = this.config?.enabled ?? true;
    this.broadcast({ t: 'denied', reason: 'Pairing was reset on the host. Scan the new QR code.' });
    this.stopHosting();
    this.config = createConfig(wasEnabled);
    saveConfig(this.config);
    if (wasEnabled) this.acquireLockAndStart();
    this.emit();
    return this.pairingInfo()!;
  }

  pairingInfo(): PairingInfo | null {
    if (!this.config) return null;
    return { hostId: this.config.hostId, token: this.config.token, hostName: this.config.hostName };
  }

  setLibrary(lib: RemoteLibrary) {
    const json = JSON.stringify(lib);
    if (json === this.libraryJson) return;
    this.library = lib;
    this.libraryJson = json;
    this.broadcast({ t: 'library', library: lib });
  }

  setPlayback(state: Omit<RemotePlaybackState, 'sentAt'>) {
    this.playback = { ...state, sentAt: Date.now() };
    const key = [
      state.trackId,
      state.playlistId,
      state.state,
      Math.round(state.duration),
      state.volume.toFixed(2),
      state.muted,
      state.loop,
      state.autoPlayNext,
      state.queue.join(','),
    ].join('|');

    const significant = key !== this.lastPlaybackKey;
    this.lastPlaybackKey = key;
    const now = Date.now();
    if (significant || now - this.lastPlaybackSentAt > 1000) {
      this.flushPlayback();
    } else if (!this.pendingStateTimer) {
      this.pendingStateTimer = setTimeout(() => this.flushPlayback(), 1000 - (now - this.lastPlaybackSentAt));
    }
  }

  // ---------- Internals ----------

  private snapshot(): HostStatusSnapshot {
    return {
      status: this.status,
      enabled: !!this.config?.enabled,
      connectedDevices: [...this.conns.values()].filter((c) => c.authed).map((c) => c.deviceName),
      error: this.lastError,
      pairing: this.pairingInfo(),
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

  private setStatus(status: HostStatus, error?: string) {
    this.status = status;
    this.lastError = error;
    this.emit();
  }

  private flushPlayback() {
    if (this.pendingStateTimer) {
      clearTimeout(this.pendingStateTimer);
      this.pendingStateTimer = null;
    }
    if (!this.playback) return;
    this.lastPlaybackSentAt = Date.now();
    this.broadcast({ t: 'state', state: { ...this.playback, sentAt: Date.now() } });
  }

  private acquireLockAndStart() {
    if (this.hasLock) {
      this.startPeer();
      return;
    }
    if (this.lockAbort) return; // already waiting for the lock

    const locks = (navigator as any).locks;
    if (!locks?.request) {
      // No Web Locks support: just host from this tab.
      this.hasLock = true;
      this.startPeer();
      return;
    }

    const generation = ++this.lockGeneration;
    const abort = new AbortController();
    this.lockAbort = abort;
    this.setStatus('standby');
    locks
      .request(LOCK_NAME, { signal: abort.signal }, () => {
        if (generation !== this.lockGeneration) return; // superseded while waiting
        this.hasLock = true;
        this.startPeer();
        return new Promise<void>((resolve) => {
          this.releaseLock = resolve;
        });
      })
      .catch(() => {
        /* aborted */
      })
      .finally(() => {
        if (generation === this.lockGeneration) {
          this.hasLock = false;
          this.lockAbort = null;
          this.releaseLock = null;
        }
      });
  }

  private stopHosting() {
    this.clearRetry();
    this.teardownPeer();
    const release = this.releaseLock;
    const abort = this.lockAbort;
    this.lockGeneration++;
    this.hasLock = false;
    this.releaseLock = null;
    this.lockAbort = null;
    if (release) release();
    if (abort) abort.abort();
  }

  private startPeer() {
    if (!this.config?.enabled || !this.hasLock) return;
    if (this.peer && !this.peer.destroyed) return;
    this.clearRetry();
    this.setStatus('connecting');

    const peer = new Peer(this.config.hostId, { debug: 0 });
    this.peer = peer;

    peer.on('open', () => {
      if (this.peer !== peer) return;
      this.retryAttempt = 0;
      this.setStatus('online');
      this.startKeepalive();
    });

    peer.on('connection', (conn) => this.handleConnection(conn));

    peer.on('disconnected', () => {
      // Lost the broker websocket (sleep, Wi-Fi drop). Existing P2P links may survive.
      if (this.peer !== peer || peer.destroyed) return;
      this.setStatus('connecting');
      this.scheduleRetry(() => {
        if (this.peer === peer && !peer.destroyed && peer.disconnected) {
          try {
            peer.reconnect();
          } catch {
            this.restartPeer();
          }
        }
      });
    });

    peer.on('close', () => {
      if (this.peer === peer) {
        this.peer = null;
        if (this.config?.enabled && this.hasLock) this.scheduleRetry(() => this.startPeer());
      }
    });

    peer.on('error', (err: any) => {
      if (this.peer !== peer) return;
      const type: string = err?.type || 'unknown';
      if (type === 'browser-incompatible') {
        this.setStatus('error', 'This browser does not support WebRTC.');
        return;
      }
      if (type === 'peer-unavailable') return; // not relevant for a host
      const msg =
        type === 'unavailable-id'
          ? 'Previous session still registered; retrying shortly…'
          : type === 'network' || type === 'socket-error' || type === 'socket-closed' || type === 'server-error'
          ? 'Cannot reach the pairing server; retrying…'
          : `Connection error (${type}); retrying…`;
      this.setStatus('connecting', msg);
      // For ID collisions the broker needs time to expire the old registration.
      this.restartPeer(type === 'unavailable-id' ? 5000 : undefined);
    });
  }

  private restartPeer(minDelay?: number) {
    this.teardownPeer();
    this.scheduleRetry(() => this.startPeer(), minDelay);
  }

  private teardownPeer() {
    this.stopKeepalive();
    for (const { conn } of this.conns.values()) {
      try {
        conn.close();
      } catch {}
    }
    this.conns.clear();
    if (this.peer) {
      const p = this.peer;
      this.peer = null;
      try {
        p.destroy();
      } catch {}
    }
    this.emit();
  }

  private scheduleRetry(fn: () => void, minDelay = 0) {
    this.clearRetry();
    const delay = Math.max(minDelay, Math.min(30000, 1000 * 2 ** this.retryAttempt));
    this.retryAttempt = Math.min(this.retryAttempt + 1, 6);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      fn();
    }, delay);
  }

  private clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Called on wake / network-online / tab visible: retry immediately instead of waiting out the backoff. */
  private kick(_reason: string) {
    if (!this.config?.enabled || !this.hasLock) return;
    this.retryAttempt = 0;
    if (!this.peer || this.peer.destroyed) {
      this.clearRetry();
      this.startPeer();
    } else if (this.peer.disconnected) {
      this.clearRetry();
      try {
        this.peer.reconnect();
      } catch {
        this.restartPeer();
      }
    }
  }

  private startKeepalive() {
    this.stopKeepalive();
    // Periodic state push doubles as a heartbeat so phones can detect dead links quickly.
    this.keepaliveTimer = setInterval(() => {
      if (this.conns.size > 0) this.flushPlayback();
    }, 3000);
  }

  private stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private handleConnection(conn: DataConnection) {
    const info: ConnInfo = { conn, authed: false, deviceName: 'Phone' };
    this.conns.set(conn.connectionId, info);

    const authTimeout = setTimeout(() => {
      if (!info.authed) {
        try {
          conn.close();
        } catch {}
      }
    }, 8000);

    conn.on('data', (raw) => {
      const msg = raw as RemoteToHostMessage;
      if (!msg || typeof msg !== 'object') return;

      if (msg.t === 'hello') {
        if (msg.token !== this.config?.token) {
          this.send(conn, { t: 'denied', reason: 'This phone is not paired (or pairing was reset). Scan the QR code again.' });
          setTimeout(() => {
            try {
              conn.close();
            } catch {}
          }, 300);
          return;
        }
        clearTimeout(authTimeout);
        info.authed = true;
        info.deviceName = String(msg.deviceName || 'Phone').slice(0, 40);
        this.send(conn, { t: 'welcome', v: REMOTE_PROTOCOL_VERSION, hostName: this.config.hostName });
        if (this.library) this.send(conn, { t: 'library', library: this.library });
        if (this.playback) this.send(conn, { t: 'state', state: { ...this.playback, sentAt: Date.now() } });
        this.emit();
        return;
      }

      if (!info.authed) return;

      switch (msg.t) {
        case 'ping':
          this.send(conn, { t: 'pong', ts: msg.ts });
          break;
        case 'requestLibrary':
          if (this.library) this.send(conn, { t: 'library', library: this.library });
          break;
        case 'cmd':
          if (msg.cmd && this.commandHandler) {
            try {
              this.commandHandler(msg.cmd);
            } catch (e) {
              console.warn('Remote command failed:', e);
            }
          }
          break;
      }
    });

    const drop = () => {
      clearTimeout(authTimeout);
      if (this.conns.get(conn.connectionId)?.conn === conn) {
        this.conns.delete(conn.connectionId);
        this.emit();
      }
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  private send(conn: DataConnection, msg: HostToRemoteMessage) {
    if (!conn.open) return;
    try {
      conn.send(msg);
    } catch {}
  }

  private broadcast(msg: HostToRemoteMessage) {
    for (const info of this.conns.values()) {
      if (info.authed) this.send(info.conn, msg);
    }
  }
}

export const remoteHost = new RemoteHost();
