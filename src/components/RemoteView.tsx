/**
 * Phone Remote View (?view=remote)
 *
 * Mobile-first remote control for the Video Player running on a computer.
 * Talks to the computer over a PeerJS data channel — it never joins or takes over
 * the Chromecast session; the computer keeps casting and simply obeys commands.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  RotateCcw,
  RotateCw,
  Volume2,
  Volume1,
  VolumeX,
  Repeat,
  ListVideo,
  ListMusic,
  Library,
  Search,
  ListPlus,
  ListStart,
  ChevronUp,
  ChevronDown,
  Trash2,
  X,
  Wifi,
  WifiOff,
  LoaderCircle,
  EllipsisVertical,
  Unlink,
  ExternalLink,
  MonitorSmartphone,
  Clapperboard,
  Cast,
  Link,
} from 'lucide-react';
import { remoteClient, setDeviceRole, type ClientSnapshot } from '../lib/remote/remoteClient';
import { decodePairingFragment, type RemoteCommand, type RemoteTrack } from '../lib/remote/protocol';

type Tab = 'queue' | 'playlists' | 'library';

const LIBRARY_RENDER_LIMIT = 250;

function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) secs = 0;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function prettyName(name: string): string {
  return name.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ').trim() || name;
}

function haptic() {
  try {
    navigator.vibrate?.(8);
  } catch {}
}

function useClientSnapshot(): ClientSnapshot {
  const [snap, setSnap] = useState<ClientSnapshot>(() => ({
    status: 'unpaired',
    pairing: null,
    hostName: null,
    library: null,
    playback: null,
    playbackReceivedAt: 0,
  }));
  useEffect(() => {
    // Consume a pairing link (QR scan) before connecting, then scrub the secret from the address bar.
    const fromHash = decodePairingFragment(window.location.hash);
    remoteClient.init();
    if (fromHash) {
      remoteClient.pair(fromHash);
      try {
        const clean = new URL(window.location.href);
        clean.hash = '';
        window.history.replaceState(null, '', clean.toString());
      } catch {}
    } else {
      setDeviceRole('remote');
    }
    return remoteClient.subscribe(setSnap);
  }, []);
  return snap;
}

/** Smoothly interpolated playback position between host updates. */
function useLivePosition(snap: ClientSnapshot): number {
  const [, force] = useState(0);
  const playing = snap.playback?.state === 'playing';
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => force((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [playing]);
  const pb = snap.playback;
  if (!pb) return 0;
  const elapsed = pb.state === 'playing' ? (Date.now() - snap.playbackReceivedAt) / 1000 : 0;
  const t = pb.currentTime + elapsed;
  return pb.duration > 0 ? Math.min(pb.duration, t) : t;
}

export const RemoteView: React.FC = () => {
  const snap = useClientSnapshot();
  const [tab, setTab] = useState<Tab>('queue');
  const [toast, setToast] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [optimisticPlaying, setOptimisticPlaying] = useState<{ value: boolean; until: number } | null>(null);
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  const [localVolume, setLocalVolume] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [expandedPlaylist, setExpandedPlaylist] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const volumeSendTimer = useRef<number | null>(null);

  const connected = snap.status === 'connected';
  const pb = snap.playback;
  const position = useLivePosition(snap);

  const trackMap = useMemo(() => {
    const m = new Map<string, RemoteTrack>();
    for (const t of snap.library?.tracks || []) m.set(t.id, t);
    return m;
  }, [snap.library]);

  const currentTrack = pb?.trackId ? trackMap.get(pb.trackId) : undefined;
  const currentPlaylist = pb?.playlistId ? snap.library?.playlists.find((p) => p.id === pb.playlistId) : undefined;

  // Drop optimistic overrides once the host confirms (or after a short timeout).
  useEffect(() => {
    setOptimisticPlaying(null);
  }, [pb?.state]);
  useEffect(() => {
    if (localVolume !== null && pb && Math.abs(pb.volume - localVolume) < 0.02) setLocalVolume(null);
  }, [pb?.volume]); // eslint-disable-line react-hooks/exhaustive-deps

  const isPlaying =
    optimisticPlaying && optimisticPlaying.until > Date.now() ? optimisticPlaying.value : pb?.state === 'playing' || pb?.state === 'buffering';

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  }, []);

  const send = useCallback(
    (cmd: RemoteCommand, feedback?: string) => {
      haptic();
      const ok = remoteClient.send(cmd);
      if (!ok) showToast('Not connected yet');
      else if (feedback) showToast(feedback);
      return ok;
    },
    [showToast]
  );

  const togglePlay = () => {
    if (send({ kind: 'togglePlay' })) setOptimisticPlaying({ value: !isPlaying, until: Date.now() + 2000 });
  };

  const sendVolume = (vol: number, muted: boolean) => {
    setLocalVolume(vol);
    if (volumeSendTimer.current) window.clearTimeout(volumeSendTimer.current);
    volumeSendTimer.current = window.setTimeout(() => remoteClient.send({ kind: 'volume', volume: vol, muted }), 60);
  };

  const filteredLibrary = useMemo(() => {
    const tracks = snap.library?.tracks || [];
    const q = search.trim().toLowerCase();
    const list = q ? tracks.filter((t) => t.name.toLowerCase().includes(q) || t.folder?.toLowerCase().includes(q)) : tracks;
    return list;
  }, [snap.library, search]);

  // ---------------- Unpaired screen ----------------
  if (snap.status === 'unpaired') {
    return <UnpairedScreen />;
  }

  const duration = pb?.duration || currentTrack?.duration || 0;
  const shownTime = scrubValue ?? position;
  const progressPct = duration > 0 ? Math.min(100, (shownTime / duration) * 100) : 0;
  const volume = localVolume ?? pb?.volume ?? 1;
  const muted = pb?.muted ?? false;
  const queue = pb?.queue || [];

  return (
    <div className="min-h-[100dvh] bg-[#07070a] text-white font-sans select-none overflow-x-hidden">
      {/* Ambient gradient backdrop */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-32 -left-24 h-80 w-80 rounded-full bg-amber-500/20 blur-[100px] remote-float" />
        <div className="absolute top-40 -right-24 h-72 w-72 rounded-full bg-fuchsia-600/15 blur-[100px] remote-float-delayed" />
        <div className="absolute bottom-0 left-1/3 h-64 w-64 rounded-full bg-sky-500/10 blur-[100px]" />
      </div>

      <div className="relative mx-auto max-w-lg px-4 pb-10" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
        {/* Header */}
        <header className="flex items-center justify-between py-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-9 w-9 shrink-0 rounded-xl bg-gradient-to-br from-amber-400 to-orange-600 flex items-center justify-center shadow-lg shadow-orange-500/30">
              <MonitorSmartphone className="h-5 w-5 text-black" />
            </div>
            <div className="min-w-0">
              <h1 className="text-[15px] font-bold leading-tight truncate font-display">{snap.hostName || 'Video Player'}</h1>
              <ConnectionPill snap={snap} />
            </div>
          </div>
          <div className="relative">
            <button
              id="remote-menu-btn"
              onClick={() => setMenuOpen((v) => !v)}
              className="h-9 w-9 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center active:scale-95 transition"
              aria-label="Remote options"
            >
              <EllipsisVertical className="h-4.5 w-4.5" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-11 z-50 w-56 rounded-2xl bg-neutral-900/95 backdrop-blur-xl border border-white/10 shadow-2xl p-1.5 text-sm remote-pop">
                  <button
                    id="remote-open-full-app-btn"
                    onClick={() => {
                      setDeviceRole('full');
                      const u = new URL(window.location.href);
                      u.search = '';
                      u.hash = '';
                      window.location.href = u.toString();
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-white/5 text-left"
                  >
                    <ExternalLink className="h-4 w-4 text-neutral-400" /> Open full app on this phone
                  </button>
                  <button
                    id="remote-forget-btn"
                    onClick={() => {
                      setMenuOpen(false);
                      if (window.confirm('Unpair this phone? You will need to scan the QR code again.')) remoteClient.forget();
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-rose-500/10 text-rose-400 text-left"
                  >
                    <Unlink className="h-4 w-4" /> Unpair this phone
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        {/* Connection banner */}
        {!connected && <ConnectionBanner snap={snap} />}

        <div className={`transition-opacity duration-300 ${connected ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
          {/* Now Playing */}
          <section className="mt-3 rounded-[28px] bg-white/[0.04] border border-white/10 backdrop-blur-xl p-5 shadow-2xl shadow-black/40">
            <div className="flex items-center gap-4">
              <div className="relative h-20 w-20 shrink-0 rounded-2xl overflow-hidden bg-gradient-to-br from-amber-500 via-orange-600 to-fuchsia-700 flex items-center justify-center shadow-xl shadow-orange-900/40">
                <Clapperboard className="h-8 w-8 text-white/90" />
                {isPlaying && (
                  <div className="absolute bottom-1.5 right-1.5 flex items-end gap-[2px] h-3.5">
                    <span className="w-[3px] bg-white/90 rounded-full remote-eq" />
                    <span className="w-[3px] bg-white/90 rounded-full remote-eq [animation-delay:-0.3s]" />
                    <span className="w-[3px] bg-white/90 rounded-full remote-eq [animation-delay:-0.6s]" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] uppercase tracking-[0.14em] text-amber-400/90 font-semibold flex items-center gap-1.5">
                  <Cast className="h-3 w-3" /> {pb?.state === 'buffering' ? 'Buffering' : isPlaying ? 'Now playing' : pb?.trackId ? 'Paused' : 'Idle'}
                </p>
                <h2 className="mt-1 text-lg font-bold leading-snug line-clamp-2 font-display">
                  {currentTrack ? prettyName(currentTrack.name) : 'Nothing playing'}
                </h2>
                <p className="text-xs text-neutral-400 truncate mt-0.5">
                  {currentPlaylist ? currentPlaylist.name : currentTrack?.folder || (currentTrack ? 'Library' : 'Pick something below')}
                </p>
              </div>
            </div>

            {/* Timeline */}
            <div className="mt-5">
              <div className="relative h-6 flex items-center">
                <div className="absolute inset-x-0 h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-500" style={{ width: `${progressPct}%` }} />
                </div>
                <input
                  id="remote-timeline-slider"
                  type="range"
                  min={0}
                  max={Math.max(duration, 1)}
                  step={0.5}
                  value={Math.min(shownTime, Math.max(duration, 1))}
                  disabled={!duration}
                  onChange={(e) => setScrubValue(parseFloat(e.target.value))}
                  onPointerUp={() => {
                    if (scrubValue !== null) send({ kind: 'seek', time: scrubValue });
                    setTimeout(() => setScrubValue(null), 600);
                  }}
                  onKeyUp={() => {
                    if (scrubValue !== null) send({ kind: 'seek', time: scrubValue });
                    setScrubValue(null);
                  }}
                  className="remote-range absolute inset-x-0 w-full"
                  aria-label="Seek"
                />
              </div>
              <div className="flex justify-between text-[11px] text-neutral-400 font-medium tabular-nums">
                <span>{formatTime(shownTime)}</span>
                <span>-{formatTime(Math.max(0, duration - shownTime))}</span>
              </div>
            </div>

            {/* Transport */}
            <div className="mt-3 flex items-center justify-between">
              <TransportButton id="remote-prev-btn" label="Previous" onClick={() => send({ kind: 'prev' })}>
                <SkipBack className="h-6 w-6" fill="currentColor" />
              </TransportButton>
              <TransportButton id="remote-back10-btn" label="Back 10 seconds" onClick={() => send({ kind: 'skip', delta: -10 })}>
                <span className="relative">
                  <RotateCcw className="h-7 w-7" />
                  <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold pt-0.5">10</span>
                </span>
              </TransportButton>
              <button
                id="remote-play-pause-btn"
                onClick={togglePlay}
                aria-label={isPlaying ? 'Pause' : 'Play'}
                className="h-[72px] w-[72px] rounded-full bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500 text-black flex items-center justify-center shadow-[0_10px_40px_-8px_rgba(251,146,60,0.7)] active:scale-90 transition-transform duration-150"
              >
                {isPlaying ? <Pause className="h-8 w-8" fill="currentColor" /> : <Play className="h-8 w-8 translate-x-0.5" fill="currentColor" />}
              </button>
              <TransportButton id="remote-fwd10-btn" label="Forward 10 seconds" onClick={() => send({ kind: 'skip', delta: 10 })}>
                <span className="relative">
                  <RotateCw className="h-7 w-7" />
                  <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold pt-0.5">10</span>
                </span>
              </TransportButton>
              <TransportButton id="remote-next-btn" label="Next" onClick={() => send({ kind: 'next' })}>
                <SkipForward className="h-6 w-6" fill="currentColor" />
              </TransportButton>
            </div>

            {/* Volume + loop */}
            <div className="mt-5 flex items-center gap-3">
              <button
                id="remote-mute-btn"
                onClick={() => send({ kind: 'volume', volume, muted: !muted })}
                className="h-9 w-9 shrink-0 rounded-full bg-white/5 flex items-center justify-center active:scale-90 transition"
                aria-label={muted ? 'Unmute' : 'Mute'}
              >
                {muted || volume === 0 ? (
                  <VolumeX className="h-4.5 w-4.5 text-rose-400" />
                ) : volume < 0.5 ? (
                  <Volume1 className="h-4.5 w-4.5" />
                ) : (
                  <Volume2 className="h-4.5 w-4.5" />
                )}
              </button>
              <div className="relative flex-1 h-6 flex items-center">
                <div className="absolute inset-x-0 h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div className={`h-full rounded-full ${muted ? 'bg-neutral-500' : 'bg-white/80'}`} style={{ width: `${volume * 100}%` }} />
                </div>
                <input
                  id="remote-volume-slider"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  onChange={(e) => sendVolume(parseFloat(e.target.value), false)}
                  className="remote-range absolute inset-x-0 w-full"
                  aria-label="Volume"
                />
              </div>
              <button
                id="remote-loop-btn"
                onClick={() => send({ kind: 'loop', loop: !pb?.loop }, pb?.loop ? 'Loop off' : 'Loop on')}
                className={`h-9 w-9 shrink-0 rounded-full flex items-center justify-center active:scale-90 transition ${
                  pb?.loop ? 'bg-amber-400/20 text-amber-300 ring-1 ring-amber-400/40' : 'bg-white/5 text-neutral-400'
                }`}
                aria-label="Toggle loop"
                aria-pressed={!!pb?.loop}
              >
                <Repeat className="h-4 w-4" />
              </button>
            </div>
          </section>

          {/* Tabs */}
          <nav className="mt-5 grid grid-cols-3 gap-1 p-1 rounded-2xl bg-white/[0.04] border border-white/10" role="tablist">
            {(
              [
                { id: 'queue', label: 'Up Next', icon: ListVideo, count: queue.length },
                { id: 'playlists', label: 'Playlists', icon: ListMusic, count: snap.library?.playlists.length },
                { id: 'library', label: 'Library', icon: Library, count: snap.library?.tracks.length },
              ] as const
            ).map(({ id, label, icon: Icon, count }) => (
              <button
                key={id}
                id={`remote-tab-${id}`}
                role="tab"
                aria-selected={tab === id}
                onClick={() => {
                  haptic();
                  setTab(id);
                }}
                className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[13px] font-semibold transition-all ${
                  tab === id ? 'bg-white text-black shadow-lg' : 'text-neutral-400 active:bg-white/5'
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
                {!!count && <span className={`text-[10px] tabular-nums ${tab === id ? 'text-black/50' : 'text-neutral-500'}`}>{count}</span>}
              </button>
            ))}
          </nav>

          <section className="mt-3">
            {!snap.library ? (
              <div className="py-12 flex justify-center text-neutral-500">
                <LoaderCircle className="h-6 w-6 animate-spin" />
              </div>
            ) : tab === 'queue' ? (
              <QueueList
                queue={queue}
                trackMap={trackMap}
                activeId={pb?.trackId || null}
                isPlaying={!!isPlaying}
                onPlay={(id) => send({ kind: 'playTrack', trackId: id })}
                onMove={(i, d) => send({ kind: 'queueMove', index: i, direction: d })}
                onRemove={(i) => send({ kind: 'queueRemove', index: i }, 'Removed from queue')}
                onClear={() => {
                  if (window.confirm('Clear the whole queue?')) send({ kind: 'queueClear' }, 'Queue cleared');
                }}
              />
            ) : tab === 'playlists' ? (
              <div className="space-y-2">
                {snap.library.playlists.length === 0 && <EmptyState text="No playlists yet. Create them on your computer." />}
                {snap.library.playlists.map((pl) => {
                  const open = expandedPlaylist === pl.id;
                  const active = pb?.playlistId === pl.id;
                  return (
                    <div key={pl.id} className={`rounded-2xl border transition ${active ? 'border-amber-400/40 bg-amber-400/[0.06]' : 'border-white/10 bg-white/[0.03]'}`}>
                      <div className="flex items-center gap-3 p-3">
                        <button
                          onClick={() => setExpandedPlaylist(open ? null : pl.id)}
                          className="flex-1 min-w-0 flex items-center gap-3 text-left"
                          aria-expanded={open}
                        >
                          <div className="h-11 w-11 shrink-0 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center">
                            <ListMusic className="h-5 w-5" />
                          </div>
                          <div className="min-w-0">
                            <p className="font-semibold truncate">{pl.name}</p>
                            <p className="text-xs text-neutral-400">
                              {pl.fileIds.length} video{pl.fileIds.length === 1 ? '' : 's'}
                              {active && <span className="text-amber-400"> · playing</span>}
                            </p>
                          </div>
                          {open ? <ChevronUp className="h-4 w-4 text-neutral-500 ml-auto" /> : <ChevronDown className="h-4 w-4 text-neutral-500 ml-auto" />}
                        </button>
                        <button
                          onClick={() => send({ kind: 'playPlaylist', playlistId: pl.id }, `Playing “${pl.name}”`)}
                          disabled={pl.fileIds.length === 0}
                          className="h-10 w-10 shrink-0 rounded-full bg-white text-black flex items-center justify-center active:scale-90 transition disabled:opacity-30"
                          aria-label={`Play playlist ${pl.name}`}
                        >
                          <Play className="h-4.5 w-4.5 translate-x-px" fill="currentColor" />
                        </button>
                      </div>
                      {open && (
                        <div className="px-2 pb-2 remote-pop">
                          {pl.fileIds.map((fid, idx) => {
                            const t = trackMap.get(fid);
                            if (!t) return null;
                            return (
                              <TrackRow
                                key={`${fid}-${idx}`}
                                track={t}
                                index={idx + 1}
                                active={pb?.trackId === fid}
                                isPlaying={!!isPlaying}
                                onPlay={() => send({ kind: 'playPlaylist', playlistId: pl.id, startTrackId: fid })}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div>
                <div className="relative mb-3">
                  <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-500" />
                  <input
                    id="remote-library-search"
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search videos or folders"
                    className="w-full h-11 pl-10 pr-10 rounded-2xl bg-white/[0.05] border border-white/10 text-sm placeholder:text-neutral-500 outline-none focus:border-amber-400/50 focus:bg-white/[0.07] transition"
                  />
                  {search && (
                    <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-neutral-400" aria-label="Clear search">
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {filteredLibrary.length === 0 && <EmptyState text={search ? 'No matches.' : 'Your library is empty.'} />}
                <div className="space-y-0.5">
                  {filteredLibrary.slice(0, LIBRARY_RENDER_LIMIT).map((t) => (
                    <TrackRow
                      key={t.id}
                      track={t}
                      active={pb?.trackId === t.id}
                      isPlaying={!!isPlaying}
                      showFolder
                      onPlay={() => send({ kind: 'playTrack', trackId: t.id })}
                      actions={
                        <>
                          <IconAction label="Play next" onClick={() => send({ kind: 'queueAdd', trackId: t.id, playNext: true }, 'Playing next')}>
                            <ListStart className="h-4 w-4" />
                          </IconAction>
                          <IconAction label="Add to queue" onClick={() => send({ kind: 'queueAdd', trackId: t.id }, 'Added to queue')}>
                            <ListPlus className="h-4 w-4" />
                          </IconAction>
                        </>
                      }
                    />
                  ))}
                </div>
                {filteredLibrary.length > LIBRARY_RENDER_LIMIT && (
                  <p className="text-center text-xs text-neutral-500 py-4">
                    Showing {LIBRARY_RENDER_LIMIT} of {filteredLibrary.length}. Search to narrow down.
                  </p>
                )}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Toast */}
      <div
        className={`fixed left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-white text-black text-sm font-semibold shadow-2xl transition-all duration-300 ${
          toast ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'
        }`}
        style={{ bottom: 'max(env(safe-area-inset-bottom), 20px)' }}
        role="status"
        aria-live="polite"
      >
        {toast}
      </div>
    </div>
  );
};

// ---------------- Sub-components ----------------

const TransportButton: React.FC<{ id: string; label: string; onClick: () => void; children: React.ReactNode }> = ({ id, label, onClick, children }) => (
  <button
    id={id}
    onClick={onClick}
    aria-label={label}
    className="h-12 w-12 rounded-full flex items-center justify-center text-white/90 active:scale-90 active:bg-white/10 transition"
  >
    {children}
  </button>
);

const IconAction: React.FC<{ label: string; onClick: () => void; children: React.ReactNode }> = ({ label, onClick, children }) => (
  <button
    onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}
    aria-label={label}
    title={label}
    className="h-9 w-9 rounded-full flex items-center justify-center text-neutral-400 active:text-white active:bg-white/10 transition"
  >
    {children}
  </button>
);

const EmptyState: React.FC<{ text: string }> = ({ text }) => <p className="text-center text-sm text-neutral-500 py-10">{text}</p>;

const PlayingBars: React.FC<{ animate: boolean }> = ({ animate }) => (
  <div className="flex items-end gap-[2px] h-3.5">
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        className={`w-[3px] rounded-full bg-amber-400 ${animate ? 'remote-eq' : 'h-1.5'}`}
        style={animate ? { animationDelay: `${-i * 0.3}s` } : undefined}
      />
    ))}
  </div>
);

const TrackRow: React.FC<{
  track: RemoteTrack;
  index?: number;
  active: boolean;
  isPlaying: boolean;
  showFolder?: boolean;
  onPlay: () => void;
  actions?: React.ReactNode;
}> = ({ track, index, active, isPlaying, showFolder, onPlay, actions }) => (
  <div
    onClick={onPlay}
    role="button"
    tabIndex={0}
    onKeyDown={(e) => e.key === 'Enter' && onPlay()}
    className={`group flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition active:scale-[0.99] ${
      active ? 'bg-amber-400/10' : 'active:bg-white/5'
    }`}
  >
    <div className="w-6 shrink-0 flex justify-center text-xs text-neutral-500 tabular-nums">
      {active ? <PlayingBars animate={isPlaying} /> : index ?? <Play className="h-3.5 w-3.5 opacity-40" />}
    </div>
    <div className="min-w-0 flex-1">
      <p className={`text-sm truncate ${active ? 'text-amber-300 font-semibold' : 'text-white/90'}`}>{prettyName(track.name)}</p>
      <p className="text-[11px] text-neutral-500 truncate">
        {track.duration ? formatTime(track.duration) : '—'}
        {showFolder && track.folder ? ` · ${track.folder}` : ''}
      </p>
    </div>
    {actions && <div className="flex items-center shrink-0">{actions}</div>}
  </div>
);

const QueueList: React.FC<{
  queue: string[];
  trackMap: Map<string, RemoteTrack>;
  activeId: string | null;
  isPlaying: boolean;
  onPlay: (id: string) => void;
  onMove: (index: number, dir: 'up' | 'down') => void;
  onRemove: (index: number) => void;
  onClear: () => void;
}> = ({ queue, trackMap, activeId, isPlaying, onPlay, onMove, onRemove, onClear }) => {
  if (queue.length === 0) return <EmptyState text="The queue is empty. Add videos from Library or Playlists." />;
  return (
    <div>
      <div className="flex items-center justify-between px-1 pb-2">
        <p className="text-xs text-neutral-500">
          {queue.length} in queue{activeId && queue.includes(activeId) ? ` · #${queue.indexOf(activeId) + 1} playing` : ''}
        </p>
        <button id="remote-clear-queue-btn" onClick={onClear} className="text-xs font-semibold text-neutral-400 active:text-rose-400 px-2 py-1">
          Clear
        </button>
      </div>
      <div className="space-y-0.5">
        {queue.map((id, i) => {
          const t = trackMap.get(id);
          if (!t) return null;
          return (
            <TrackRow
              key={`${id}-${i}`}
              track={t}
              index={i + 1}
              active={id === activeId}
              isPlaying={isPlaying}
              onPlay={() => onPlay(id)}
              actions={
                <>
                  <IconAction label="Move up" onClick={() => onMove(i, 'up')}>
                    <ChevronUp className="h-4 w-4" />
                  </IconAction>
                  <IconAction label="Move down" onClick={() => onMove(i, 'down')}>
                    <ChevronDown className="h-4 w-4" />
                  </IconAction>
                  <IconAction label="Remove" onClick={() => onRemove(i)}>
                    <Trash2 className="h-4 w-4" />
                  </IconAction>
                </>
              }
            />
          );
        })}
      </div>
    </div>
  );
};

const ConnectionPill: React.FC<{ snap: ClientSnapshot }> = ({ snap }) => {
  const map = {
    connected: { text: 'Connected', cls: 'text-emerald-400', dot: 'bg-emerald-400' },
    connecting: { text: 'Connecting…', cls: 'text-amber-400', dot: 'bg-amber-400 animate-pulse' },
    'host-offline': { text: 'Computer offline', cls: 'text-neutral-400', dot: 'bg-neutral-500' },
    denied: { text: 'Not paired', cls: 'text-rose-400', dot: 'bg-rose-400' },
    error: { text: 'Error', cls: 'text-rose-400', dot: 'bg-rose-400' },
    unpaired: { text: 'Not paired', cls: 'text-neutral-400', dot: 'bg-neutral-500' },
  } as const;
  const s = map[snap.status];
  return (
    <p className={`flex items-center gap-1.5 text-[11px] font-medium ${s.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.text}
      {snap.status === 'connected' && snap.latencyMs !== undefined && <span className="text-neutral-500">· {snap.latencyMs} ms</span>}
    </p>
  );
};

const ConnectionBanner: React.FC<{ snap: ClientSnapshot }> = ({ snap }) => {
  const offline = snap.status === 'host-offline';
  const denied = snap.status === 'denied' || snap.status === 'error';
  return (
    <div
      className={`mt-3 rounded-2xl border p-3.5 flex items-start gap-3 remote-pop ${
        denied ? 'border-rose-500/30 bg-rose-500/10' : offline ? 'border-white/10 bg-white/[0.04]' : 'border-amber-400/30 bg-amber-400/10'
      }`}
    >
      <div className="mt-0.5">
        {denied ? (
          <Unlink className="h-5 w-5 text-rose-400" />
        ) : offline ? (
          <WifiOff className="h-5 w-5 text-neutral-400" />
        ) : (
          <LoaderCircle className="h-5 w-5 text-amber-400 animate-spin" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold">{denied ? 'Pairing no longer valid' : offline ? 'Can’t reach your computer' : 'Reconnecting…'}</p>
        <p className="text-xs text-neutral-400 mt-0.5">
          {snap.message ||
            (offline ? 'Open the Video Player on your computer. This remote will connect automatically.' : 'Hang tight — this usually takes a second.')}
        </p>
      </div>
      {!denied ? (
        <button
          id="remote-retry-btn"
          onClick={() => remoteClient.retryNow()}
          className="shrink-0 px-3 py-1.5 rounded-full bg-white/10 text-xs font-semibold active:scale-95 transition flex items-center gap-1"
        >
          <Wifi className="h-3.5 w-3.5" /> Retry
        </button>
      ) : (
        <button
          onClick={() => remoteClient.forget()}
          className="shrink-0 px-3 py-1.5 rounded-full bg-white/10 text-xs font-semibold active:scale-95 transition"
        >
          Re-pair
        </button>
      )}
    </div>
  );
};

const UnpairedScreen: React.FC = () => {
  const [link, setLink] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    try {
      const hash = link.includes('#') ? link.slice(link.indexOf('#')) : '';
      const info = decodePairingFragment(hash);
      if (!info) throw new Error('bad');
      setError(null);
      remoteClient.pair(info);
    } catch {
      setError('That doesn’t look like a pairing link.');
    }
  };

  return (
    <div className="min-h-[100dvh] bg-[#07070a] text-white font-sans flex flex-col items-center justify-center px-6 relative overflow-hidden">
      <div className="pointer-events-none absolute -top-24 -left-24 h-80 w-80 rounded-full bg-amber-500/20 blur-[100px] remote-float" />
      <div className="pointer-events-none absolute bottom-0 -right-24 h-80 w-80 rounded-full bg-fuchsia-600/15 blur-[100px] remote-float-delayed" />
      <div className="relative w-full max-w-sm text-center remote-pop">
        <div className="mx-auto h-20 w-20 rounded-3xl bg-gradient-to-br from-amber-400 to-orange-600 flex items-center justify-center shadow-2xl shadow-orange-500/40">
          <MonitorSmartphone className="h-10 w-10 text-black" />
        </div>
        <h1 className="mt-6 text-2xl font-bold font-display">Pair this phone</h1>
        <p className="mt-2 text-sm text-neutral-400 leading-relaxed">
          On your computer, open the Video Player and tap <span className="text-white font-semibold">Remote</span> in the top bar, then scan the QR code
          with this phone’s camera.
        </p>
        <ol className="mt-6 text-left space-y-3 text-sm">
          {['Only needed once — this phone remembers the pairing.', 'Your cast session keeps running untouched.', 'Add this page to your Home screen for one-tap access.'].map(
            (s, i) => (
              <li key={i} className="flex gap-3 items-start">
                <span className="h-6 w-6 shrink-0 rounded-full bg-white/10 flex items-center justify-center text-xs font-bold text-amber-300">{i + 1}</span>
                <span className="text-neutral-300 pt-0.5">{s}</span>
              </li>
            )
          )}
        </ol>
        <div className="mt-8 text-left">
          <label htmlFor="remote-pair-link-input" className="text-xs text-neutral-500 font-medium">
            Or paste the pairing link
          </label>
          <div className="mt-1.5 flex gap-2">
            <div className="relative flex-1">
              <Link className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-500" />
              <input
                id="remote-pair-link-input"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://…#pair=…"
                className="w-full h-11 pl-9 pr-3 rounded-xl bg-white/[0.05] border border-white/10 text-sm outline-none focus:border-amber-400/50"
              />
            </div>
            <button id="remote-pair-submit-btn" onClick={submit} className="h-11 px-4 rounded-xl bg-white text-black text-sm font-bold active:scale-95 transition">
              Pair
            </button>
          </div>
          {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
        </div>
      </div>
    </div>
  );
};
