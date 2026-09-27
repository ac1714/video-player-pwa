/**
 * Main Application Component
 * 
 * Routes:
 * - /player.html -> Dedicated Fullscreen Video Player (New Tab / Window)
 * - /controller.html or / -> Split View (Controller + Embedded Player Preview) or Controller-only
 */

import React, { useEffect, useState, useRef } from 'react';
import { ExternalLink, Sliders, X, Copy, Check } from 'lucide-react';
import { ControllerView } from './components/ControllerView';
import { PlayerView } from './components/PlayerView';
import { ThemeProvider } from './lib/theme';
import { syncChannel, getPopoutUrl } from './lib/syncChannel';
import { getActivePlaybackState, saveActivePlaybackState } from './lib/localStorageState';

function getInitialViewMode(): 'controller' | 'player' | 'split' {
  if (typeof window === 'undefined') return 'split';
  const path = window.location.pathname.toLowerCase();
  const params = new URLSearchParams(window.location.search);
  const viewParam = params.get('view')?.toLowerCase();
  const modeParam = params.get('mode')?.toLowerCase();

  if (
    path.includes('player.html') ||
    viewParam === 'player' ||
    modeParam === 'external' ||
    modeParam === 'player' ||
    params.has('popout')
  ) {
    return 'player';
  }
  if (path.includes('controller.html') || viewParam === 'controller') {
    return 'controller';
  }
  return 'split';
}

export default function App() {
  const [viewMode, setViewMode] = useState<'controller' | 'player' | 'split'>(getInitialViewMode);
  const [activeTrackId, setActiveTrackId] = useState<string>(() => getActivePlaybackState().trackId || '');
  const [copiedUrl, setCopiedUrl] = useState<boolean>(false);
  const [isExternalActive, setIsExternalActive] = useState<boolean>(false);

  const latestTrackIdRef = useRef<string>(getActivePlaybackState().trackId || '');
  const latestTimeRef = useRef<number>(getActivePlaybackState().lastTime || 0);

  // Detect route based on URL path or search query parameter
  useEffect(() => {
    const handlePopState = () => {
      setViewMode(getInitialViewMode());
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Listen to track load and state changes to update active track and popout state
  useEffect(() => {
    const unsub = syncChannel.subscribe((msg) => {
      if (msg.type === 'LOAD_TRACK' && msg.payload.trackId) {
        setActiveTrackId(msg.payload.trackId);
        latestTrackIdRef.current = msg.payload.trackId;
        if (msg.payload.currentTime !== undefined) {
          latestTimeRef.current = msg.payload.currentTime;
        }
      } else if (msg.type === 'PROVIDE_TRACK_DATA' && msg.payload.trackId) {
        setActiveTrackId(msg.payload.trackId);
        latestTrackIdRef.current = msg.payload.trackId;
      } else if (msg.type === 'TIME_UPDATE' && msg.payload?.trackId) {
        setActiveTrackId(msg.payload.trackId);
        latestTrackIdRef.current = msg.payload.trackId;
        if (msg.payload.currentTime !== undefined) {
          latestTimeRef.current = msg.payload.currentTime;
        }
      } else if (msg.type === 'SYNC_PONG' && msg.payload?.trackId) {
        setActiveTrackId(msg.payload.trackId);
        latestTrackIdRef.current = msg.payload.trackId;
        if (msg.payload.currentTime !== undefined) {
          latestTimeRef.current = msg.payload.currentTime;
        }
      } else if (msg.type === 'PLAYER_CONNECTED' && msg.payload?.isPopout) {
        setIsExternalActive(true);
      } else if (msg.type === 'PLAYER_DISCONNECTED' && msg.payload?.isPopout) {
        setIsExternalActive(false);
        // Automatically switch to split view so the video player is visible and mounted
        setViewMode('split');
        const state = getActivePlaybackState();
        const targetTrackId = msg.payload?.trackId || latestTrackIdRef.current || state.trackId || activeTrackId;
        const resumeTime = (msg.payload?.currentTime !== undefined && msg.payload.currentTime > 0)
          ? msg.payload.currentTime
          : (latestTimeRef.current > 0 ? latestTimeRef.current : (state.lastTime || state.currentTime || 0));
        if (targetTrackId) {
          saveActivePlaybackState({ trackId: targetTrackId, isPlaying: true, lastTime: resumeTime });
          setTimeout(() => {
            syncChannel.post({
              type: 'LOAD_TRACK',
              payload: {
                trackId: targetTrackId,
                autoPlay: true,
                currentTime: resumeTime,
              },
            });
          }, 80);
        }
      } else if (msg.type === 'BRING_PLAYBACK_HERE') {
        setIsExternalActive(false);
        setViewMode('split');
        const state = getActivePlaybackState();
        const targetTrackId = msg.payload?.trackId || latestTrackIdRef.current || state.trackId || activeTrackId;
        const resumeTime = (msg.payload?.currentTime !== undefined && msg.payload.currentTime > 0)
          ? msg.payload.currentTime
          : (latestTimeRef.current > 0 ? latestTimeRef.current : (state.lastTime || state.currentTime || 0));
        if (targetTrackId) {
          saveActivePlaybackState({ trackId: targetTrackId, isPlaying: true, lastTime: resumeTime });
        }
      }
    });

    return () => {
      unsub();
    };
  }, [activeTrackId]);

  const handleOpenPopout = (trackIdToOpen?: string) => {
    const targetId = trackIdToOpen || activeTrackId || (window as any).__PWA_ACTIVE_TRACK_ID__;
    const currentState = getActivePlaybackState();
    const curTime = (window as any).__PWA_ACTIVE_TRACK_TIME__ || currentState.lastTime || 0;
    if (targetId) {
      saveActivePlaybackState({ trackId: targetId, isPlaying: true, lastTime: curTime });
      syncChannel.post({ type: 'LOAD_TRACK', payload: { trackId: targetId, autoPlay: true, currentTime: curTime } });
    }
    const res = syncChannel.openPopoutWindow(targetId, curTime);
    if (res.win) {
      syncChannel.registerPopoutWindow(res.win);
    }
    setIsExternalActive(true);
  };

  const handleCopyPlayerUrl = () => {
    const url = getPopoutUrl(activeTrackId || undefined);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    }
  };

  return (
    <ThemeProvider>
      {viewMode === 'player' ? (
        <PlayerView />
      ) : (
        <div className="flex flex-col min-h-screen bg-neutral-100 dark:bg-black text-neutral-900 dark:text-neutral-100 transition-colors">
          <div className="flex-1 flex flex-col lg:grid lg:grid-cols-12 min-h-screen">
            {/* Controller Column (Catalog, Playlists, Ingestion) */}
            <div
              className={`border-r border-neutral-200 dark:border-neutral-800 overflow-y-auto ${
                viewMode === 'split'
                  ? 'lg:col-span-7 xl:col-span-7 order-2 lg:order-1'
                  : 'w-full order-1'
              }`}
            >
              <ControllerView
                onOpenPlayerInNewTab={handleOpenPopout}
                onToggleSplitMode={() =>
                  setViewMode(viewMode === 'split' ? 'controller' : 'split')
                }
                isSplitMode={viewMode === 'split'}
                viewMode={viewMode}
                onSetViewMode={setViewMode}
              />
            </div>

            {/* Video Player Column (Visible in Split mode) */}
            {viewMode === 'split' && (
              <div className="lg:col-span-5 xl:col-span-5 h-[340px] sm:h-[420px] lg:h-[calc(100vh-5.5rem)] sticky top-0 bg-black p-3 sm:p-4 flex flex-col z-20 order-1 lg:order-2 border-b lg:border-b-0 border-neutral-800">
                <div className="flex items-center justify-end pb-2 text-xs text-neutral-400">
                  <div className="flex items-center gap-2">
                    <button
                      id="split-pop-out-btn"
                      onClick={() => handleOpenPopout()}
                      className="px-2.5 py-1 rounded-md bg-amber-500 hover:bg-amber-400 text-black font-semibold transition cursor-pointer flex items-center gap-1.5 shadow-sm active:scale-95 text-xs"
                      title="Open dedicated video player in a new browser tab"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Open in New Tab</span>
                    </button>
                    <button
                      onClick={() => setViewMode('controller')}
                      className="text-neutral-400 hover:text-white font-medium transition cursor-pointer px-2 py-1"
                      title="Hide player preview"
                    >
                      Hide
                    </button>
                  </div>
                </div>
                <div className="flex-1 min-h-0 relative">
                  <PlayerView
                    embedded={true}
                    isExternalActive={isExternalActive}
                    onOpenPopout={() => handleOpenPopout()}
                    onBringBack={() => {
                      setIsExternalActive(false);
                      setViewMode('split');
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </ThemeProvider>
  );
}
