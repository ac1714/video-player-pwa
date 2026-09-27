/**
 * Unified BroadcastChannel & Direct Cross-Window Inter-Tab Communication Hub
 * Channel: 'pwa_video_sync_channel'
 */

import { SyncMessage } from '../types';
import { getMemoryFile } from './db';
import { saveActivePlaybackState, getActivePlaybackState } from './localStorageState';

const CHANNEL_NAME = 'pwa_video_sync_channel';

type MessageListener = (message: SyncMessage) => void;

export function getPopoutUrl(trackId?: string, currentTime?: number): string {
  if (typeof window === 'undefined') return '/player.html';
  try {
    const isDevOrSubpath = window.location.pathname.includes('/player.html');
    let basePath: string;
    if (isDevOrSubpath) {
      basePath = window.location.pathname;
    } else {
      const segs = window.location.pathname.split('/').filter(Boolean);
      if (segs.length > 0 && segs[segs.length - 1].endsWith('.html')) {
        segs.pop();
      }
      const prefix = segs.length > 0 ? `/${segs.join('/')}` : '';
      basePath = `${prefix}/player.html`;
    }
    const url = new URL(basePath, window.location.origin);
    url.searchParams.set('view', 'player');
    url.searchParams.set('mode', 'external');
    if (trackId) {
      url.searchParams.set('trackId', trackId);
    }
    if (currentTime !== undefined && Number.isFinite(currentTime) && currentTime > 0) {
      url.searchParams.set('time', currentTime.toFixed(2));
    }
    return url.toString();
  } catch {
    const base = trackId ? `player.html?view=player&mode=external&trackId=${encodeURIComponent(trackId)}` : 'player.html';
    return currentTime && currentTime > 0 ? `${base}&time=${currentTime.toFixed(2)}` : base;
  }
}

class SyncChannelManager {
  private channel: BroadcastChannel | null = null;
  private listeners: Set<MessageListener> = new Set();
  private popoutWin: Window | null = null;
  private popoutCheckInterval: any = null;

  constructor() {
    // 1. Initialize BroadcastChannel if supported
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        this.channel = new BroadcastChannel(CHANNEL_NAME);
        this.channel.onmessage = (event) => {
          this.notifyListeners(event.data);
        };
        this.channel.onmessageerror = (err) => {
          console.error('BroadcastChannel message error:', err);
        };
      } catch (e) {
        console.warn('BroadcastChannel initialization failed:', e);
      }
    }

    // 2. Storage event fallback for cross-tab notifications
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key === 'pwa_video_sync_message_event' && event.newValue) {
          try {
            const parsed = JSON.parse(event.newValue) as SyncMessage;
            this.notifyListeners(parsed);
          } catch {
            // Ignore JSON parse errors
          }
        }
      });

      // 3. Direct window postMessage listener for opener <-> popout window bridge
      window.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || typeof data !== 'object') return;

        // Save reference to popout window if message came from child window
        if (event.source && event.source !== window) {
          try {
            this.popoutWin = event.source as Window;
          } catch {}
        }

        // Normalize action -> type if reference format used
        if (data.action === 'PLAY' && !data.type) {
          this.notifyListeners({
            type: 'LOAD_TRACK',
            payload: {
              trackId: data.trackId || 'current',
              autoPlay: true,
              blob: data.file || data.blob,
            },
          });
          return;
        }

        if (data.type) {
          this.notifyListeners(data as SyncMessage);
        }
      });
    }
  }

  public registerPopoutWindow(win: Window | null): void {
    this.popoutWin = win;
    if (this.popoutCheckInterval) {
      clearInterval(this.popoutCheckInterval);
      this.popoutCheckInterval = null;
    }
    if (win) {
      this.popoutCheckInterval = setInterval(() => {
        if (this.popoutWin && this.popoutWin.closed) {
          this.popoutWin = null;
          clearInterval(this.popoutCheckInterval);
          this.popoutCheckInterval = null;

          const state = getActivePlaybackState();
          const disconnectMsg: SyncMessage = {
            type: 'PLAYER_DISCONNECTED',
            payload: {
              isPopout: true,
              trackId: state.trackId,
              currentTime: state.lastTime || state.currentTime || 0,
              autoResume: true,
              isPlaying: state.isPlaying ?? true,
            },
          };
          this.post(disconnectMsg);
        }
      }, 350);
    }
  }

  public getPopoutWindow(): Window | null {
    if (this.popoutWin && this.popoutWin.closed) {
      this.popoutWin = null;
    }
    return this.popoutWin;
  }

  public isPopoutActive(): boolean {
    if (this.popoutWin && !this.popoutWin.closed) {
      return true;
    }
    this.popoutWin = null;
    return false;
  }

  public focusPopoutWindow(): boolean {
    if (this.popoutWin && !this.popoutWin.closed) {
      try {
        this.popoutWin.focus();
        return true;
      } catch {}
    }
    return false;
  }

  public openPopoutWindow(trackId?: string, currentTime?: number, blob?: Blob): { success: boolean; win: Window | null; url: string } {
    if (typeof window === 'undefined') {
      return { success: false, win: null, url: '/player.html' };
    }

    const urlString = getPopoutUrl(trackId, currentTime);

    // CRITICAL: Call window.open immediately while user click gesture token is fully active!
    let win: Window | null = null;
    try {
      win = window.open(urlString, '_blank');
    } catch (e) {
      console.warn('Direct window.open failed:', e);
    }

    // Save playback state to localStorage so new tab can access it immediately
    if (trackId) {
      try {
        saveActivePlaybackState({ trackId, isPlaying: true, lastTime: currentTime || 0, currentTime: currentTime || 0 });
      } catch {}
    }

    // Export active track ID and blob to window object so child popout window has synchronous access
    try {
      const activeBlob = blob || (trackId ? getMemoryFile(trackId)?.file : undefined);
      if (activeBlob) {
        (window as any).__PWA_ACTIVE_MEDIA_BLOB__ = activeBlob;
      }
      if (trackId) {
        (window as any).__PWA_ACTIVE_TRACK_ID__ = trackId;
      }
      if (currentTime !== undefined) {
        (window as any).__PWA_ACTIVE_TRACK_TIME__ = currentTime;
      }
    } catch {}

    // If programmatic window.open was suppressed (e.g. sandbox or strict popup blocker), trigger anchor navigation
    if (!win && typeof document !== 'undefined') {
      try {
        const link = document.createElement('a');
        link.href = urlString;
        link.target = '_blank';
        link.rel = 'opener';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch (anchorErr) {
        console.warn('Anchor fallback navigation failed:', anchorErr);
      }
    }

    if (win) {
      this.registerPopoutWindow(win);
      try { win.focus(); } catch {}

      if (trackId) {
        setTimeout(() => {
          this.post({
            type: 'LOAD_TRACK',
            payload: { trackId, autoPlay: true, blob, currentTime },
          });
        }, 300);
      }
      return { success: true, win, url: urlString };
    }

    return { success: false, win: null, url: urlString };
  }

  private notifyListeners(data: SyncMessage) {
    if (!data || !data.type) return;
    for (const listener of this.listeners) {
      try {
        listener(data);
      } catch (err) {
        console.error('Error in SyncChannel listener:', err);
      }
    }
  }

  public subscribe(listener: MessageListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public post(message: SyncMessage): void {
    // 1. Immediately notify listeners in the current window/tab
    this.notifyListeners(message);

    // 2. Broadcast via BroadcastChannel (supports Blobs in modern browsers)
    if (this.channel) {
      try {
        this.channel.postMessage(message);
      } catch (err) {
        // If posting with blob failed over BroadcastChannel, strip blob and retry
        try {
          const sanitized = { ...message } as any;
          if (sanitized.payload?.blob) {
            delete sanitized.payload.blob;
          }
          this.channel.postMessage(sanitized);
        } catch {}
      }
    }

    // 3. Direct postMessage to opened Popout Window (if open)
    if (this.popoutWin && !this.popoutWin.closed) {
      try {
        this.popoutWin.postMessage(message, '*');
      } catch (err) {
        try {
          const sanitized = { ...message } as any;
          if (sanitized.payload && typeof sanitized.payload === 'object') {
            const copy = { ...sanitized.payload };
            sanitized.payload = copy;
          }
          this.popoutWin.postMessage(sanitized, '*');
        } catch (e2) {
          console.warn('Could not postMessage to popout window:', e2);
        }
      }
    }

    // 4. Direct postMessage to Opener Window (if this is the popout window)
    if (typeof window !== 'undefined' && window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage(message, '*');
      } catch (err) {
        try {
          const sanitized = { ...message } as any;
          if (sanitized.payload && typeof sanitized.payload === 'object') {
            const copy = { ...sanitized.payload };
            sanitized.payload = copy;
          }
          window.opener.postMessage(sanitized, '*');
        } catch (e2) {
          console.warn('Could not postMessage to opener window:', e2);
        }
      }
    }

    // 5. Cross-tab storage fallback for non-blob messages
    try {
      const hasBlob = (message as any)?.payload?.blob;
      if (!hasBlob && typeof window !== 'undefined') {
        localStorage.setItem(
          'pwa_video_sync_message_event',
          JSON.stringify({
            ...message,
            _nonce: Date.now() + Math.random(),
          })
        );
      }
    } catch {
      // Storage quota or restriction ignored
    }
  }

  public close(): void {
    this.listeners.clear();
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }
}

export const syncChannel = new SyncChannelManager();

