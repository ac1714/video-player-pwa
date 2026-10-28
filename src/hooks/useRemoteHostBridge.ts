/**
 * Bridges ControllerView state/handlers to the phone remote host.
 *
 * ControllerView remains the single source of truth for library, queue and playback;
 * this hook just mirrors it to paired phones and routes their commands back into the
 * exact same handlers the on-screen controls use.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { MediaFile, Playlist } from '../types';
import type { RemoteCommand, RemoteLibrary, RemotePlayerState } from '../lib/remote/protocol';
import { remoteHost, type HostStatusSnapshot } from '../lib/remote/remoteHost';

export interface RemoteHostBridgeInput {
  mediaFiles: MediaFile[];
  playlists: Playlist[];
  queue: string[];
  activeTrackId: string | null;
  activePlaylistId: string | null;
  playerState: RemotePlayerState;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  loop: boolean;
  autoPlayNext: boolean;
  /** Re-assigned every render so commands always hit the latest closures. */
  onCommand: (cmd: RemoteCommand) => void;
}

function folderOf(path?: string): string | undefined {
  if (!path) return undefined;
  const idx = path.lastIndexOf('/');
  return idx > 0 ? path.slice(0, idx) : undefined;
}

export function useRemoteHostBridge(input: RemoteHostBridgeInput): HostStatusSnapshot {
  const [status, setStatus] = useState<HostStatusSnapshot>(() => ({
    status: 'disabled',
    enabled: false,
    connectedDevices: [],
    pairing: null,
  }));

  const commandRef = useRef(input.onCommand);
  commandRef.current = input.onCommand;

  useEffect(() => {
    remoteHost.init();
    remoteHost.setCommandHandler((cmd) => commandRef.current(cmd));
    const unsub = remoteHost.subscribe(setStatus);
    return () => {
      unsub();
      remoteHost.setCommandHandler(null);
    };
  }, []);

  const library: RemoteLibrary = useMemo(
    () => ({
      tracks: input.mediaFiles.map((f) => ({
        id: f.id,
        name: f.name,
        duration: f.duration,
        folder: folderOf(f.relativePath),
      })),
      playlists: input.playlists.map((p) => ({ id: p.id, name: p.name, fileIds: p.fileIds })),
    }),
    [input.mediaFiles, input.playlists]
  );

  useEffect(() => {
    remoteHost.setLibrary(library);
  }, [library]);

  useEffect(() => {
    remoteHost.setPlayback({
      trackId: input.activeTrackId,
      playlistId: input.activePlaylistId,
      state: input.playerState,
      currentTime: Number.isFinite(input.currentTime) ? input.currentTime : 0,
      duration: Number.isFinite(input.duration) ? input.duration : 0,
      volume: input.volume,
      muted: input.muted,
      loop: input.loop,
      autoPlayNext: input.autoPlayNext,
      queue: input.queue,
    });
  }, [
    input.activeTrackId,
    input.activePlaylistId,
    input.playerState,
    input.currentTime,
    input.duration,
    input.volume,
    input.muted,
    input.loop,
    input.autoPlayNext,
    input.queue,
  ]);

  return status;
}
