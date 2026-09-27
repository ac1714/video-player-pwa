/**
 * Controller Page Component (controller.html)
 * 
 * - Library & Folder Manager (Directory Picker, File Picker, Sample Clip Generator, File Inspector)
 * - Playlist Hub (Create, Rename, Delete, Reorder track sequence)
 * - Remote Control Bar with Picture-in-Picture controls, transport controls, and scrub bar
 * - Light / Pitch-Black Dark middle toggle with zero blue tinting
 * - Minimalist clean UI stripped of extra branding and verbose text elements
 */

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  FolderPlus,
  FilePlus,
  Film,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  ListPlus,
  Trash2,
  Edit2,
  Check,
  X,
  Radio,
  ExternalLink,
  ChevronUp,
  ChevronDown,
  Info,
  Sliders,
  CheckSquare,
  Square,
  Search,
  PictureInPicture2,
  Repeat,
  Database,
  HardDrive,
  AlertTriangle,
  RotateCcw,
  Lock,
  Monitor,
  FolderOpen,
  FolderHeart,
  ListOrdered,
  GripVertical,
  Plus,
  ListVideo,
  PlusCircle,
  Clock,
  Shuffle,
} from 'lucide-react';
import { MediaFile, Playlist, SyncMessage } from '../types';
import {
  getAllMediaFiles,
  getMediaFile,
  getMemoryFile,
  getAllPlaylists,
  createPlaylist,
  updatePlaylist,
  deletePlaylist,
  deleteMediaFile,
  addFileToPlaylist,
  removeFileFromPlaylist,
  getPlaylistsForFile,
  clearVideoCache,
  fullSystemReset,
  registerMemoryFile,
  memoryFileRegistry,
  getAllDirectoryHandles,
  saveDirectoryHandle,
  retrieveBinaryBlob,
  persistBinaryBlob,
} from '../lib/db';
import { syncChannel, getPopoutUrl } from '../lib/syncChannel';
import {
  pickFolderAndIngest,
  pickFilesAndIngest,
  ingestFileList,
  ingestDroppedItems,
  relinkFolderHandles,
  pickFolderToRelink,
  pickFilesToRelink,
  relinkFilesFromList,
  isInsideIframe,
} from '../lib/fileIngestion';
import {
  getActivePlaybackState,
  saveActivePlaybackState,
  setActivePlaylistId,
  setActiveTrack,
  setVolumeState,
  getAutoPlaySetting,
  setAutoPlaySetting,
  getLoopSetting,
  setLoopSetting,
  getStoredQueue,
  setStoredQueue,
} from '../lib/localStorageState';
import { PWAInstallButton } from './PWAInstallButton';
import { OfflineIndicator } from './OfflineIndicator';
import { ThemeToggle } from './ThemeToggle';

interface ControllerViewProps {
  onOpenPlayerInNewTab?: (trackId?: string) => void;
  onToggleSplitMode?: () => void;
  isSplitMode?: boolean;
  viewMode?: 'split' | 'controller' | 'player';
  onSetViewMode?: (mode: 'split' | 'controller') => void;
}

export const ControllerView: React.FC<ControllerViewProps> = ({
  onOpenPlayerInNewTab,
  onToggleSplitMode,
  isSplitMode = false,
  viewMode = 'split',
  onSetViewMode,
}) => {
  // Master lists from IndexedDB
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Active Playlist & Active Track
  const [activePlaylistId, setActivePlaylistIdState] = useState<string | null>(null);
  const [activeTrackId, setActiveTrackIdState] = useState<string | null>(null);

  // Playback Telemetry from Player
  const [playerState, setPlayerState] = useState<'playing' | 'paused' | 'buffering' | 'idle'>('idle');
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isPlayerConnected, setIsPlayerConnected] = useState<boolean>(false);
  const [isPiPActive, setIsPiPActive] = useState<boolean>(false);
  const [autoPlayNext, setAutoPlayNext] = useState<boolean>(true);
  const [isLooping, setIsLooping] = useState<boolean>(() => getLoopSetting());

  // Scrubber dragging state to prevent telemetry jitter while scrubbing
  const [isScrubbing, setIsScrubbing] = useState<boolean>(false);
  const [scrubTime, setScrubTime] = useState<number>(0);
  const isScrubbingRef = useRef<boolean>(false);

  // Navigation Tabs: 'catalog' | 'playlists' | 'queue'
  const [activeTab, setActiveTab] = useState<'catalog' | 'playlists' | 'queue'>('catalog');

  // Dedicated Playback Queue
  const [queue, setQueue] = useState<string[]>(() => getStoredQueue());
  const queueRef = useRef<string[]>(queue);
  const [draggedQueueIndex, setDraggedQueueIndex] = useState<number | null>(null);

  // Expanded Playlist in Playlists Tab
  const [expandedPlaylistId, setExpandedPlaylistId] = useState<string | null>(null);

  // Quick Add-to-Playlist modals
  const [fileToAddToPlaylist, setFileToAddToPlaylist] = useState<MediaFile | null>(null);
  const [showAddTracksToPlaylist, setShowAddTracksToPlaylist] = useState<Playlist | null>(null);

  // Refs for stable inter-tab sync callbacks
  const activeTrackIdRef = useRef<string | null>(activeTrackId);
  const activePlaylistIdRef = useRef<string | null>(activePlaylistId);
  const isLoopingRef = useRef<boolean>(isLooping);
  const autoPlayNextRef = useRef<boolean>(autoPlayNext);
  const playlistsRef = useRef<Playlist[]>(playlists);
  const mediaFilesRef = useRef<MediaFile[]>(mediaFiles);
  const handlePlayNextRef = useRef<() => void>(() => {});
  const handlePlayPrevRef = useRef<() => void>(() => {});

  useEffect(() => {
    queueRef.current = queue;
    setStoredQueue(queue);
  }, [queue]);

  useEffect(() => {
    activeTrackIdRef.current = activeTrackId;
  }, [activeTrackId]);

  useEffect(() => {
    activePlaylistIdRef.current = activePlaylistId;
  }, [activePlaylistId]);

  useEffect(() => {
    isLoopingRef.current = isLooping;
  }, [isLooping]);

  useEffect(() => {
    autoPlayNextRef.current = autoPlayNext;
  }, [autoPlayNext]);

  useEffect(() => {
    playlistsRef.current = playlists;
  }, [playlists]);

  useEffect(() => {
    mediaFilesRef.current = mediaFiles;
  }, [mediaFiles]);

  // Inspector modal state (many-to-many playlist association)
  const [inspectingFile, setInspectingFile] = useState<MediaFile | null>(null);
  const [filePlaylistIds, setFilePlaylistIds] = useState<string[]>([]);

  // Playlist management UI states
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [newPlaylistName, setNewPlaylistName] = useState<string>('');
  const [editingPlaylistId, setEditingPlaylistId] = useState<string | null>(null);
  const [editingPlaylistName, setEditingPlaylistName] = useState<string>('');
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  // Storage and cache management
  const [showStorageModal, setShowStorageModal] = useState<boolean>(false);
  const [storageStats, setStorageStats] = useState<{ usedMB: string; quotaMB: string } | null>(null);
  const [showPopoutMenu, setShowPopoutMenu] = useState<boolean>(false);
  const [popoutBlockedUrl, setPopoutBlockedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!showPopoutMenu) return;
    const handleOutside = () => setShowPopoutMenu(false);
    window.addEventListener('click', handleOutside);
    return () => window.removeEventListener('click', handleOutside);
  }, [showPopoutMenu]);

  // Directory reauthorization state (eliminates forced re-imports!)
  const [needsDirectoryReauth, setNeedsDirectoryReauth] = useState<boolean>(false);
  const [reauthDirectoryName, setReauthDirectoryName] = useState<string>('');

  const checkDirectoryPermissions = useCallback(async () => {
    try {
      const dirHandles = await getAllDirectoryHandles();
      if (dirHandles.length > 0) {
        for (const dh of dirHandles) {
          const anyDh = dh as any;
          if (anyDh.queryPermission) {
            const perm = await anyDh.queryPermission({ mode: 'read' });
            if (perm !== 'granted') {
              setNeedsDirectoryReauth(true);
              setReauthDirectoryName(dh.name);
              return;
            }
          }
        }
        setNeedsDirectoryReauth(false);
      }
    } catch (e) {
      console.warn('Permission query check error:', e);
    }
  }, []);

  const handleReauthorizeFolder = async () => {
    try {
      const dirHandles = await getAllDirectoryHandles();
      if (dirHandles.length > 0) {
        for (const dh of dirHandles) {
          const anyDh = dh as any;
          if (anyDh.requestPermission) {
            try {
              const res = await anyDh.requestPermission({ mode: 'read' });
              if (res === 'granted') {
                setStatusNotice(`Re-linking "${dh.name}"...`);
                const relinkRes = await relinkFolderHandles(dh);
                await loadDatabase();
                setNeedsDirectoryReauth(false);
                setStatusNotice(`Successfully reauthorized "${dh.name}" (${relinkRes.matched} files reconnected)!`);
                return;
              }
            } catch (permErr) {
              console.warn('Directory requestPermission failed, falling back:', permErr);
            }
          }
        }
      }

      // If stored handle prompt was dismissed, lost, or running inside restricted iframe:
      if ('showDirectoryPicker' in window && !isInsideIframe()) {
        try {
          // @ts-expect-error showDirectoryPicker
          const dh: FileSystemDirectoryHandle = await window.showDirectoryPicker({ mode: 'read' });
          if (dh) {
            await saveDirectoryHandle(dh.name, dh);
            setStatusNotice(`Re-linking "${dh.name}"...`);
            const relinkRes = await relinkFolderHandles(dh);
            await loadDatabase();
            setNeedsDirectoryReauth(false);
            setStatusNotice(`Successfully reauthorized "${dh.name}" (${relinkRes.matched} files reconnected)!`);
            return;
          }
        } catch (pickerErr: any) {
          if (pickerErr?.name === 'AbortError') return;
          console.warn('showDirectoryPicker failed, falling back to universal input:', pickerErr);
        }
      }

      // Universal HTML5 webkitdirectory re-link fallback (works 100% in all iframes and browsers!)
      setStatusNotice('Select your videos folder to reconnect catalog...');
      const relinkRes = await pickFolderToRelink((matched) => {
        setStatusNotice(`Scanning folder: ${matched} files reconnected...`);
      });

      if (relinkRes.matched > 0) {
        await loadDatabase();
        setNeedsDirectoryReauth(false);
        setStatusNotice(`Successfully reconnected ${relinkRes.matched} videos! Playback restored.`);
      } else if (relinkRes.total > 0) {
        setStatusNotice(`Selected folder contained ${relinkRes.total} files, but none matched catalog filenames.`);
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.error('Reauthorization error:', err);
        setStatusNotice('Could not reauthorize folder.');
      }
    }
  };

  const handleReauthorizeFiles = async () => {
    try {
      setStatusNotice('Select video file(s) to reconnect...');
      const relinkRes = await pickFilesToRelink((matched) => {
        setStatusNotice(`Reconnecting: ${matched} files re-linked...`);
      });
      if (relinkRes.matched > 0) {
        await loadDatabase();
        setNeedsDirectoryReauth(false);
        setStatusNotice(`Successfully reconnected ${relinkRes.matched} videos! Playback restored.`);
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.error('File re-link error:', err);
      }
    }
  };

  const loadStorageStats = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        const used = (((est.usage || 0) / (1024 * 1024))).toFixed(1);
        const quota = (((est.quota || 0) / (1024 * 1024))).toFixed(1);
        setStorageStats({ usedMB: used, quotaMB: quota });
      } catch {
        setStorageStats(null);
      }
    }
  }, []);

  // Load database state
  const loadDatabase = useCallback(async () => {
    try {
      let [files, lists] = await Promise.all([getAllMediaFiles(), getAllPlaylists()]);

      // Clean up and purge any synthetic test clips so the catalog is clean
      const isSampleClip = (name: string) => {
        const lower = name.toLowerCase();
        return (
          lower.includes('sample video') ||
          lower.startsWith('clip 1:') ||
          lower.startsWith('clip_1:') ||
          lower.startsWith('clip 1') ||
          lower.startsWith('clip_1')
        );
      };

      const leftoverSamples = files.filter((f) => isSampleClip(f.name));
      if (leftoverSamples.length > 0) {
        for (const sample of leftoverSamples) {
          try {
            await deleteMediaFile(sample.id);
          } catch {}
        }
        files = files.filter((f) => !isSampleClip(f.name));
      }

      setMediaFiles(files);
      setPlaylists(lists);

      // Initialize queue if empty
      setQueue((prevQueue) => {
        if (prevQueue.length > 0) {
          const valid = prevQueue.filter((id) => files.some((f) => f.id === id));
          if (valid.length > 0) return valid;
        }
        const initialQueue = files.map((f) => f.id);
        setStoredQueue(initialQueue);
        return initialQueue;
      });

      const localState = getActivePlaybackState();
      setActivePlaylistIdState(localState.playlistId);
      const targetId = localState.trackId || (files.length > 0 ? files[0].id : null);
      setActiveTrackIdState(targetId);
      if (targetId && files.length > 0) {
        const target = files.find((f) => f.id === targetId) || files[0];
        if (target?.blobFallback) {
          registerMemoryFile(target.id, target.blobFallback);
        }
      }
      setVolume(localState.volume);
      setIsMuted(localState.muted);
      setAutoPlayNext(getAutoPlaySetting());
      setIsLooping(getLoopSetting());
    } catch (err) {
      console.error('Error loading database in Controller:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDatabase();
    loadStorageStats();
    checkDirectoryPermissions();
  }, [loadDatabase, loadStorageStats, checkDirectoryPermissions]);

  // Ping player tab on mount and periodically check connectivity
  useEffect(() => {
    let pingInterval: number;

    const checkConnection = () => {
      syncChannel.post({ type: 'SYNC_PING' });
    };

    checkConnection();
    pingInterval = window.setInterval(checkConnection, 4000);

    return () => {
      window.clearInterval(pingInterval);
    };
  }, []);

  // Notice toast auto-dismiss
  useEffect(() => {
    if (statusNotice) {
      const timer = setTimeout(() => setStatusNotice(null), 3500);
      return () => clearTimeout(timer);
    }
  }, [statusNotice]);

  // Listen to Inter-Tab Telemetry & Events
  useEffect(() => {
    const unsubscribe = syncChannel.subscribe((msg: SyncMessage) => {
      switch (msg.type) {
        case 'PLAYER_CONNECTED': {
          setIsPlayerConnected(true);
          // Only send track payload to dedicated external popout window to avoid loops with embedded player
          if (msg.payload?.isPopout) {
            const currentId = activeTrackIdRef.current || activeTrackId || (mediaFilesRef.current?.[0]?.id);
            if (currentId) {
              const sendTrack = (blob?: Blob, mime?: string, name?: string) => {
                syncChannel.post({
                  type: 'LOAD_TRACK',
                  payload: {
                    trackId: currentId,
                    autoPlay: true,
                    blob,
                    currentTime: currentTime || 0,
                  },
                });
                if (blob) {
                  syncChannel.post({
                    type: 'PROVIDE_TRACK_DATA',
                    payload: {
                      trackId: currentId,
                      blob,
                      mimeType: mime,
                      name,
                    },
                  });
                }
              };

              const mem = getMemoryFile(currentId);
              const targetRec = mediaFilesRef.current?.find((f) => f.id === currentId);
              if (mem?.file) {
                sendTrack(mem.file, targetRec?.mimeType, targetRec?.name);
              } else if (targetRec?.blobFallback) {
                registerMemoryFile(currentId, targetRec.blobFallback);
                sendTrack(targetRec.blobFallback, targetRec.mimeType, targetRec.name);
              } else {
                getMediaFile(currentId)
                  .then(async (rec) => {
                    let blob = rec?.blobFallback;
                    if (!blob) blob = await retrieveBinaryBlob(currentId);
                    if (blob) registerMemoryFile(currentId, blob);
                    sendTrack(blob, rec?.mimeType, rec?.name);
                  })
                  .catch(() => {});
              }
            }
          }
          break;
        }

        case 'LOAD_TRACK': {
          setIsPlayerConnected(true);
          if (msg.payload.trackId) {
            setActiveTrackIdState(msg.payload.trackId);
            activeTrackIdRef.current = msg.payload.trackId;
            setActiveTrack(msg.payload.trackId);
          }
          if (msg.payload.currentTime !== undefined && !isScrubbingRef.current) {
            setCurrentTime(msg.payload.currentTime);
          }
          break;
        }

        case 'SYNC_PONG':
          setIsPlayerConnected(true);
          if (msg.payload.state === 'playing' || msg.payload.state === 'paused' || msg.payload.state === 'buffering' || msg.payload.state === 'idle') {
            setPlayerState(msg.payload.state);
          }
          if (msg.payload.trackId) {
            setActiveTrackIdState(msg.payload.trackId);
            activeTrackIdRef.current = msg.payload.trackId;
            setActiveTrack(msg.payload.trackId);
          }
          if (msg.payload.currentTime !== undefined && !isScrubbingRef.current) {
            setCurrentTime(msg.payload.currentTime);
          }
          if (msg.payload.duration !== undefined) {
            setDuration(msg.payload.duration);
          }
          if (msg.payload.volume !== undefined) {
            setVolume(msg.payload.volume);
            setIsMuted(msg.payload.muted);
          }
          if (typeof msg.payload.loop === 'boolean') {
            setIsLooping(msg.payload.loop);
          }
          break;

        case 'STATE_CHANGE':
          setIsPlayerConnected(true);
          setPlayerState(msg.payload.state);
          break;

        case 'TIME_UPDATE':
          setIsPlayerConnected(true);
          if (!isScrubbingRef.current) {
            setCurrentTime(msg.payload.currentTime);
          }
          setDuration(msg.payload.duration);
          break;

        case 'SET_VOLUME':
          setVolume(msg.payload.volume);
          setIsMuted(msg.payload.muted);
          break;

        case 'SET_LOOP':
          setIsLooping(msg.payload.loop);
          break;

        case 'PIP_CHANGE':
          setIsPiPActive(msg.payload.active);
          break;

        case 'SYNC_PING': {
          setIsPlayerConnected(true);
          break;
        }

        case 'REQUEST_TRACK_DATA': {
          const reqTrackId = msg.payload.trackId || activeTrackIdRef.current || activeTrackId;
          if (!reqTrackId) break;
          const mem = getMemoryFile(reqTrackId);
          if (mem?.file) {
            persistBinaryBlob(reqTrackId, mem.file).catch(() => {});
            syncChannel.post({
              type: 'PROVIDE_TRACK_DATA',
              payload: { trackId: reqTrackId, blob: mem.file },
            });
          } else {
            getMediaFile(reqTrackId).then(async (rec) => {
              let blob = rec?.blobFallback;
              if (!blob) {
                blob = await retrieveBinaryBlob(reqTrackId);
              }
              if (!blob && rec?.handle) {
                try {
                  blob = await rec.handle.getFile();
                  registerMemoryFile(reqTrackId, blob, rec.handle);
                } catch (e) {
                  console.warn('Could not read file from handle for popout window:', e);
                }
              }
              if (!blob) {
                try {
                  const dirHandles = await getAllDirectoryHandles();
                  for (const dh of dirHandles) {
                    await relinkFolderHandles(dh);
                    const ref = getMemoryFile(reqTrackId);
                    if (ref?.file) {
                      blob = ref.file;
                      break;
                    }
                  }
                } catch {}
              }
              if (blob) {
                persistBinaryBlob(reqTrackId, blob).catch(() => {});
                syncChannel.post({
                  type: 'PROVIDE_TRACK_DATA',
                  payload: {
                    trackId: reqTrackId,
                    blob: blob,
                    mimeType: rec?.mimeType,
                    name: rec?.name,
                  },
                });
              }
            });
          }
          break;
        }

        case 'TRACK_ENDED': {
          setIsPlayerConnected(true);
          if (isLoopingRef.current && activeTrackIdRef.current) {
            dispatchLoadTrack(activeTrackIdRef.current, true);
          } else if (autoPlayNextRef.current) {
            handlePlayNextRef.current();
          }
          break;
        }

        case 'NEXT_TRACK': {
          handlePlayNextRef.current();
          break;
        }

        case 'PREV_TRACK': {
          handlePlayPrevRef.current();
          break;
        }

        default:
          break;
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Active playlist and its ordered tracks
  const activePlaylist = useMemo(() => {
    if (!activePlaylistId) return null;
    return playlists.find((p) => p.id === activePlaylistId) || null;
  }, [playlists, activePlaylistId]);

  const activePlaylistFiles = useMemo(() => {
    if (!activePlaylist) return [];
    const fileMap = new Map(mediaFiles.map((f) => [f.id, f]));
    return activePlaylist.fileIds
      .map((id) => fileMap.get(id))
      .filter((f): f is MediaFile => Boolean(f));
  }, [activePlaylist, mediaFiles]);

  const queueFiles = useMemo(() => {
    const fileMap = new Map(mediaFiles.map((f) => [f.id, f]));
    return queue
      .map((id) => fileMap.get(id))
      .filter((f): f is MediaFile => Boolean(f));
  }, [queue, mediaFiles]);

  const activeTrack = useMemo(() => {
    if (!activeTrackId) return null;
    return mediaFiles.find((f) => f.id === activeTrackId) || null;
  }, [mediaFiles, activeTrackId]);

  const currentQueueIndex = useMemo(() => {
    if (!activeTrackId) return -1;
    return queue.indexOf(activeTrackId);
  }, [queue, activeTrackId]);

  // Command Dispatches & Direct Permission Elevation
  const dispatchLoadTrack = async (trackId: string, autoPlay: boolean = true) => {
    setActiveTrackIdState(trackId);
    setActiveTrack(trackId);

    const mem = getMemoryFile(trackId);
    const targetFile = mediaFiles.find((f) => f.id === trackId);
    let availableBlob: Blob | undefined = mem?.file || targetFile?.blobFallback;

    if (!availableBlob) {
      availableBlob = await retrieveBinaryBlob(trackId);
      if (availableBlob && targetFile) {
        targetFile.blobFallback = availableBlob;
      }
    }

    // 1. Check stored directory handles to reauthorize folder access for ALL tracks
    if (!availableBlob) {
      try {
        const dirHandles = await getAllDirectoryHandles();
        for (const dh of dirHandles) {
          try {
            const anyDh = dh as any;
            let perm = anyDh.queryPermission ? await anyDh.queryPermission({ mode: 'read' }) : 'granted';
            if (perm !== 'granted' && anyDh.requestPermission) {
              try {
                perm = await anyDh.requestPermission({ mode: 'read' });
              } catch {}
            }
            if (perm === 'granted') {
              await relinkFolderHandles(dh);
              const refreshed = getMemoryFile(trackId);
              if (refreshed?.file) {
                availableBlob = refreshed.file;
                persistBinaryBlob(trackId, availableBlob).catch(() => {});
                setNeedsDirectoryReauth(false);
                break;
              }
            }
          } catch {}
        }
      } catch {}
    }

    // 2. Fallback to direct file handle if directory handles were not stored
    if (!availableBlob && targetFile?.handle) {
      try {
        const handle = targetFile.handle;
        // @ts-expect-error queryPermission mode check
        if (handle.queryPermission) {
          // @ts-expect-error queryPermission mode check
          const query = await handle.queryPermission({ mode: 'read' });
          if (query !== 'granted') {
            // @ts-expect-error requestPermission mode check
            const req = await handle.requestPermission({ mode: 'read' });
            if (req !== 'granted') {
              setStatusNotice(`Select folder or file to re-link disk access for "${targetFile.name}".`);
              setNeedsDirectoryReauth(true);
            }
          }
        }
        if (handle.getFile) {
          try {
            availableBlob = await handle.getFile();
            registerMemoryFile(trackId, availableBlob, handle);
            persistBinaryBlob(trackId, availableBlob).catch(() => {});
            setNeedsDirectoryReauth(false);
          } catch {}
        }
      } catch (err) {
        console.warn('Could not read file from handle directly:', err);
      }
    }

    if (availableBlob) {
      setNeedsDirectoryReauth(false);
      persistBinaryBlob(trackId, availableBlob).catch(() => {});
      if (typeof window !== 'undefined') {
        (window as any).__PWA_ACTIVE_TRACK_ID__ = trackId;
        (window as any).__PWA_ACTIVE_MEDIA_BLOB__ = availableBlob;
        (window as any).__PWA_MEMORY_REGISTRY__ = memoryFileRegistry;
        (window as any).__PWA_GET_MEMORY_FILE__ = (id: string) => getMemoryFile(id);
      }
    } else {
      setNeedsDirectoryReauth(true);
    }

    syncChannel.post({
      type: 'LOAD_TRACK',
      payload: {
        trackId,
        autoPlay,
        playlistId: activePlaylistId || undefined,
        blob: availableBlob,
      },
    });

    if (availableBlob) {
      syncChannel.post({
        type: 'PROVIDE_TRACK_DATA',
        payload: {
          trackId,
          blob: availableBlob,
          mimeType: targetFile?.mimeType,
          name: targetFile?.name,
        },
      });
    }
  };

  const handleOpenPopoutWindow = (trackIdToOpen?: string) => {
    const targetId = trackIdToOpen || activeTrackId || (mediaFiles.length > 0 ? mediaFiles[0].id : undefined);
    if (targetId) {
      saveActivePlaybackState({ trackId: targetId, isPlaying: true });
      syncChannel.post({ type: 'LOAD_TRACK', payload: { trackId: targetId, autoPlay: true } });
    }
    const res = syncChannel.openPopoutWindow(targetId);
    if (res.win) {
      setStatusNotice('Opened video player in new tab');
      setPopoutBlockedUrl(null);
    } else {
      setPopoutBlockedUrl(res.url);
      setStatusNotice('Check browser prompt or click banner below to open tab');
    }
  };

  const handleClearVideoCache = async (keepPlaylists: boolean = true) => {
    try {
      await clearVideoCache(keepPlaylists);
      await loadDatabase();
      await loadStorageStats();
      setStatusNotice(keepPlaylists ? 'Video cache cleared. Playlist structure preserved.' : 'Library reset.');
      setShowStorageModal(false);
      syncChannel.post({ type: 'STATE_CHANGE', payload: { state: 'idle' } });
    } catch (err) {
      console.error('Error clearing video cache:', err);
      setStatusNotice('Failed to clear video cache.');
    }
  };

  const handleFullSystemReset = async () => {
    if (!window.confirm('This will permanently delete all playlists, video references, and settings. Are you sure?')) {
      return;
    }
    try {
      await fullSystemReset();
      window.location.reload();
    } catch (err) {
      console.error('Reset error:', err);
    }
  };

  const dispatchPlay = () => {
    const targetId = activeTrackIdRef.current || activeTrackId || (queueRef.current?.[0]) || (mediaFilesRef.current?.[0]?.id);
    if (!targetId) return;
    if (!activeTrackId) {
      dispatchLoadTrack(targetId, true);
      return;
    }
    syncChannel.post({ type: 'PLAY' });
    setPlayerState('playing');
  };

  const dispatchPause = () => {
    syncChannel.post({ type: 'PAUSE' });
    setPlayerState('paused');
  };

  const dispatchSeek = (time: number) => {
    setCurrentTime(time);
    syncChannel.post({
      type: 'SEEK_TO',
      payload: { time },
    });
  };

  const dispatchVolume = (vol: number, muted: boolean) => {
    setVolume(vol);
    setIsMuted(muted);
    setVolumeState(vol, muted);
    syncChannel.post({
      type: 'SET_VOLUME',
      payload: { volume: vol, muted },
    });
  };

  const dispatchTogglePiP = () => {
    syncChannel.post({ type: 'TOGGLE_PIP' });
  };

  const handleToggleLoop = (targetVal?: boolean) => {
    const nextLoop = targetVal !== undefined ? targetVal : !isLooping;
    setIsLooping(nextLoop);
    setLoopSetting(nextLoop);
    syncChannel.post({
      type: 'SET_LOOP',
      payload: { loop: nextLoop },
    });
  };

  // Next / Previous Navigation using Queue
  const handlePlayNext = () => {
    const currentQueue = queueRef.current;
    if (currentQueue.length === 0) {
      if (mediaFiles.length > 0) {
        dispatchLoadTrack(mediaFiles[0].id, true);
      }
      return;
    }
    const curIdx = currentQueue.indexOf(activeTrackIdRef.current || '');
    if (curIdx === -1) {
      dispatchLoadTrack(currentQueue[0], true);
    } else if (curIdx + 1 < currentQueue.length) {
      dispatchLoadTrack(currentQueue[curIdx + 1], true);
    } else if (isLoopingRef.current) {
      dispatchLoadTrack(currentQueue[0], true);
    }
  };
  handlePlayNextRef.current = handlePlayNext;

  const handlePlayPrev = () => {
    if (currentTime > 3) {
      dispatchSeek(0);
      return;
    }
    const currentQueue = queueRef.current;
    if (currentQueue.length === 0) {
      dispatchSeek(0);
      return;
    }
    const curIdx = currentQueue.indexOf(activeTrackIdRef.current || '');
    if (curIdx > 0) {
      dispatchLoadTrack(currentQueue[curIdx - 1], true);
    } else if (isLoopingRef.current) {
      dispatchLoadTrack(currentQueue[currentQueue.length - 1], true);
    } else {
      dispatchSeek(0);
    }
  };
  handlePlayPrevRef.current = handlePlayPrev;

  // Queue Operations
  const handleAddToQueue = (trackId: string, playNow: boolean = false, playNext: boolean = false) => {
    const file = mediaFiles.find((f) => f.id === trackId);
    setQueue((prev) => {
      let next: string[];
      if (playNext) {
        const activeIdx = prev.indexOf(activeTrackId || '');
        if (activeIdx !== -1) {
          const filtered = prev.filter((id) => id !== trackId);
          const insertIdx = filtered.indexOf(activeTrackId || '') + 1;
          next = [...filtered.slice(0, insertIdx), trackId, ...filtered.slice(insertIdx)];
        } else {
          next = [trackId, ...prev.filter((id) => id !== trackId)];
        }
      } else {
        if (prev.includes(trackId)) {
          next = [...prev.filter((id) => id !== trackId), trackId];
        } else {
          next = [...prev, trackId];
        }
      }
      syncChannel.post({ type: 'QUEUE_UPDATED', payload: { queue: next } });
      return next;
    });

    if (file) {
      setStatusNotice(
        playNext
          ? `"${file.name}" will play next`
          : `Added "${file.name}" to queue`
      );
    }

    if (playNow) {
      dispatchLoadTrack(trackId, true);
    }
  };

  const handleAddAllToQueue = () => {
    const allIds = mediaFiles.map((f) => f.id);
    setQueue(allIds);
    syncChannel.post({ type: 'QUEUE_UPDATED', payload: { queue: allIds } });
    setStatusNotice(`Added all ${allIds.length} videos to queue`);
  };

  const handleClearQueue = () => {
    setQueue([]);
    syncChannel.post({ type: 'QUEUE_UPDATED', payload: { queue: [] } });
    setStatusNotice('Playback queue cleared');
  };

  const handleRemoveFromQueue = (index: number) => {
    setQueue((prev) => {
      const removedId = prev[index];
      const next = prev.filter((_, i) => i !== index);
      syncChannel.post({ type: 'QUEUE_UPDATED', payload: { queue: next } });
      if (activeTrackId === removedId && next.length > 0) {
        const nextId = next[index] || next[next.length - 1];
        dispatchLoadTrack(nextId, true);
      }
      return next;
    });
  };

  const handleMoveQueueItem = (fromIndex: number, direction: 'up' | 'down') => {
    const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
    if (toIndex < 0 || toIndex >= queue.length) return;
    setQueue((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(fromIndex, 1);
      copy.splice(toIndex, 0, moved);
      syncChannel.post({ type: 'QUEUE_UPDATED', payload: { queue: copy } });
      return copy;
    });
  };

  const handleReorderQueueDrag = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || toIndex >= queue.length) return;
    setQueue((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(fromIndex, 1);
      copy.splice(toIndex, 0, moved);
      syncChannel.post({ type: 'QUEUE_UPDATED', payload: { queue: copy } });
      return copy;
    });
  };

  const handlePlayPlaylist = (pl: Playlist) => {
    if (pl.fileIds.length === 0) {
      setStatusNotice(`Playlist "${pl.name}" is empty`);
      return;
    }
    setActivePlaylistIdState(pl.id);
    setActivePlaylistId(pl.id);
    setQueue(pl.fileIds);
    syncChannel.post({ type: 'QUEUE_UPDATED', payload: { queue: pl.fileIds } });
    dispatchLoadTrack(pl.fileIds[0], true);
    setStatusNotice(`Playing "${pl.name}" (${pl.fileIds.length} tracks)`);
  };

  const handleAddPlaylistToQueue = (pl: Playlist) => {
    if (pl.fileIds.length === 0) {
      setStatusNotice(`Playlist "${pl.name}" is empty`);
      return;
    }
    setQueue((prev) => {
      const combined = [...prev];
      for (const id of pl.fileIds) {
        if (!combined.includes(id)) {
          combined.push(id);
        }
      }
      syncChannel.post({ type: 'QUEUE_UPDATED', payload: { queue: combined } });
      return combined;
    });
    setStatusNotice(`Added ${pl.fileIds.length} tracks from "${pl.name}" to queue`);
  };

  const handleAddTrackToPlaylistDirect = async (fileId: string, playlistId: string) => {
    await addFileToPlaylist(fileId, playlistId);
    await loadDatabase();
    const pl = playlists.find((p) => p.id === playlistId);
    const file = mediaFiles.find((f) => f.id === fileId);
    setStatusNotice(`Added "${file?.name || 'Video'}" to "${pl?.name || 'Playlist'}"`);
    setFileToAddToPlaylist(null);
  };

  // Direct DOM input refs for foolproof user-gesture activation across all browsers & iframes
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);

  useEffect(() => {
    if (folderInputRef.current) {
      (folderInputRef.current as any).webkitdirectory = true;
      folderInputRef.current.setAttribute('webkitdirectory', '');
      folderInputRef.current.setAttribute('directory', '');
      folderInputRef.current.setAttribute('mozdirectory', '');
    }
  }, []);

  // Progressive real-time file updates for zero perceived latency during folder / file ingestion
  const handleProgressiveFiles = useCallback((batch: MediaFile[], totalSoFar: number) => {
    setMediaFiles((prev) => {
      const map = new Map<string, MediaFile>();
      for (const p of prev) map.set(p.id, p);
      for (const b of batch) map.set(b.id, b);
      return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
    });
    setStatusNotice(`Scanning: found ${totalSoFar} video file${totalSoFar === 1 ? '' : 's'}...`);
  }, []);

  // Ingestion Handlers
  const handleIngestFolder = async () => {
    // 1. Try native File System Access API first for permanent handle storage
    if ('showDirectoryPicker' in window && !isInsideIframe()) {
      try {
        setStatusNotice('Opening folder...');
        const result = await pickFolderAndIngest(handleProgressiveFiles);
        if (result.count > 0) {
          await loadDatabase();
          setNeedsDirectoryReauth(false);
          setStatusNotice(`Imported ${result.count} video file${result.count === 1 ? '' : 's'}.`);
          if (!activeTrackId && result.files.length > 0) {
            dispatchLoadTrack(result.files[0].id, false);
          }
          return;
        } else {
          setStatusNotice('No video files found in selected folder.');
          return;
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          setStatusNotice(null);
          return;
        }
        console.warn('showDirectoryPicker failed, attempting file input fallback:', err);
      }
    }

    // 2. Fallback to HTML5 webkitdirectory input
    if (folderInputRef.current) {
      folderInputRef.current.value = '';
      folderInputRef.current.click();
    }
  };

  const handleFolderInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    try {
      setStatusNotice(`Reading folder (${files.length} items)...`);
      const result = await ingestFileList(files, handleProgressiveFiles);
      await loadDatabase();
      if (result.count === 0) {
        setStatusNotice('No video files found in folder.');
      } else {
        setStatusNotice(`Imported ${result.count} video file${result.count === 1 ? '' : 's'}.`);
        if (!activeTrackId && result.files.length > 0) {
          dispatchLoadTrack(result.files[0].id, false);
        }
      }
    } catch (err) {
      console.error('Folder input error:', err);
      setStatusNotice('Error importing folder.');
    } finally {
      e.target.value = '';
    }
  };

  const handleIngestFiles = async () => {
    if ('showOpenFilePicker' in window) {
      try {
        const result = await pickFilesAndIngest(handleProgressiveFiles);
        if (result.count > 0) {
          await loadDatabase();
          setStatusNotice(`Imported ${result.count} video file${result.count === 1 ? '' : 's'}.`);
          if (!activeTrackId && result.files.length > 0) {
            dispatchLoadTrack(result.files[0].id, false);
          }
          return;
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        console.warn('showOpenFilePicker failed, falling back to file input:', err);
      }
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    try {
      setStatusNotice(`Importing ${files.length} files...`);
      const result = await ingestFileList(files, handleProgressiveFiles);
      await loadDatabase();
      if (result.count === 0) {
        setStatusNotice('No video files found.');
      } else {
        setStatusNotice(`Imported ${result.count} video file${result.count === 1 ? '' : 's'}.`);
        if (!activeTrackId && result.files.length > 0) {
          dispatchLoadTrack(result.files[0].id, false);
        }
      }
    } catch (err) {
      console.error('File input error:', err);
      setStatusNotice('Error importing files.');
    } finally {
      e.target.value = '';
    }
  };

  // Drag and drop handlers (support both folders and multiple files)
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDraggingOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    try {
      setStatusNotice('Scanning dropped items...');
      const result = await ingestDroppedItems(e.dataTransfer, handleProgressiveFiles);
      await loadDatabase();
      if (result.count === 0) {
        setStatusNotice('No video files found in dropped items.');
      } else {
        setStatusNotice(`Imported ${result.count} video file${result.count === 1 ? '' : 's'}.`);
        if (!activeTrackId && result.files.length > 0) {
          dispatchLoadTrack(result.files[0].id, false);
        }
      }
    } catch (err) {
      console.error('Drop error:', err);
      setStatusNotice('Failed to process dropped items.');
    }
  };


  // Inspector Dialog
  const openInspector = async (file: MediaFile) => {
    setInspectingFile(file);
    const assignedIds = await getPlaylistsForFile(file.id);
    setFilePlaylistIds(assignedIds);
  };

  const toggleFilePlaylist = async (playlistId: string) => {
    if (!inspectingFile) return;
    const isAssigned = filePlaylistIds.includes(playlistId);

    if (isAssigned) {
      await removeFileFromPlaylist(inspectingFile.id, playlistId);
      setFilePlaylistIds((prev) => prev.filter((id) => id !== playlistId));
    } else {
      await addFileToPlaylist(inspectingFile.id, playlistId);
      setFilePlaylistIds((prev) => [...prev, playlistId]);
    }
    const updatedPlaylists = await getAllPlaylists();
    setPlaylists(updatedPlaylists);
    syncChannel.post({ type: 'PLAYLIST_MODIFIED', payload: { playlistId } });
  };

  // Playlist Management
  const handleCreatePlaylist = async () => {
    if (!newPlaylistName.trim()) return;
    const pl = await createPlaylist(newPlaylistName.trim());
    setNewPlaylistName('');
    setShowCreateModal(false);
    await loadDatabase();
    setActivePlaylistIdState(pl.id);
    setActivePlaylistId(pl.id);
  };

  const handleRenamePlaylist = async (id: string) => {
    const pl = playlists.find((p) => p.id === id);
    if (!pl || !editingPlaylistName.trim()) return;
    pl.name = editingPlaylistName.trim();
    await updatePlaylist(pl);
    setEditingPlaylistId(null);
    await loadDatabase();
  };

  const handleDeletePlaylist = async (id: string) => {
    const pl = playlists.find((p) => p.id === id);
    if (!pl) return;
    if (confirm(`Delete playlist "${pl.name}"?`)) {
      await deletePlaylist(id);
      if (activePlaylistId === id) {
        setActivePlaylistIdState(null);
        setActivePlaylistId(null);
      }
      await loadDatabase();
    }
  };

  const handleMoveTrack = async (index: number, direction: 'up' | 'down') => {
    if (!activePlaylist) return;
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= activePlaylist.fileIds.length) return;

    const newOrder = [...activePlaylist.fileIds];
    const [moved] = newOrder.splice(index, 1);
    newOrder.splice(targetIndex, 0, moved);

    const updatedPl: Playlist = {
      ...activePlaylist,
      fileIds: newOrder,
    };
    await updatePlaylist(updatedPl);
    await loadDatabase();
    syncChannel.post({ type: 'PLAYLIST_MODIFIED', payload: { playlistId: activePlaylist.id } });
  };

  const handleRemoveTrackFromPlaylist = async (fileId: string) => {
    if (!activePlaylist) return;
    await removeFileFromPlaylist(fileId, activePlaylist.id);
    await loadDatabase();
    syncChannel.post({ type: 'PLAYLIST_MODIFIED', payload: { playlistId: activePlaylist.id } });
  };

  const handleDeleteMediaFile = async (id: string, name: string) => {
    // Optimistically remove from state immediately so it disappears with 0 delay
    setMediaFiles((prev) => prev.filter((f) => f.id !== id));
    setQueue((prev) => prev.filter((trackId) => trackId !== id));
    if (activeTrackId === id) {
      setActiveTrackIdState(null);
      setActiveTrack(null);
      syncChannel.post({ type: 'PAUSE' });
    }
    try {
      await deleteMediaFile(id);
      setStatusNotice(`Removed "${name}".`);
    } catch (e) {
      console.warn('Error deleting media file:', e);
    }
    await loadDatabase();
  };

  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return mediaFiles;
    const q = searchQuery.toLowerCase();
    return mediaFiles.filter((f) => f.name.toLowerCase().includes(q) || f.mimeType.toLowerCase().includes(q));
  }, [mediaFiles, searchQuery]);

  const formatTime = (secs: number) => {
    if (!Number.isFinite(secs) || secs < 0) return '00:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div
      id="controller-root-layout"
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative flex flex-col min-h-screen bg-neutral-100 dark:bg-black text-neutral-900 dark:text-neutral-100 pb-36 transition-colors"
    >
      {/* Hidden file & folder inputs for direct, infallible browser gesture support */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        {...({ webkitdirectory: '', directory: '', mozdirectory: '' } as any)}
        className="sr-only fixed -top-96 -left-96 opacity-0"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleFolderInputChange}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="video/*,.mp4,.webm,.mkv,.mov,.m4v,.ogv,.avi,.ts,.m2ts,.mts"
        className="sr-only fixed -top-96 -left-96 opacity-0 pointer-events-none"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleFileInputChange}
      />

      {/* Drag Over Overlay */}
      {isDraggingOver && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center border-4 border-dashed border-sky-400 pointer-events-none animate-in fade-in duration-150">
          <FolderPlus className="w-16 h-16 text-sky-400 mb-3 animate-bounce" />
          <h3 className="text-xl font-bold text-white mb-1">Drop Folder or Video Files Here</h3>
          <p className="text-sm text-neutral-300">Folders and nested video files will be scanned and imported automatically.</p>
        </div>
      )}

      {/* Top Header Navigation */}
      <header className="sticky top-0 z-30 bg-white/90 dark:bg-neutral-950/90 backdrop-blur-md border-b border-neutral-200 dark:border-neutral-800 px-4 md:px-8 py-3 flex items-center justify-between shadow-sm">
        {/* Left: Title without icon */}
        <div className="flex items-center">
          <span className="text-base font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">Video Player</span>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          {/* Theme Toggle (Right side of header) */}
          <ThemeToggle />

          {/* Pop Out to New Tab Link */}
          <a
            id="open-player-window-btn"
            href={getPopoutUrl(activeTrackId || (mediaFiles.length > 0 ? mediaFiles[0].id : undefined), currentTime)}
            target="_blank"
            rel="opener"
            onClick={(e) => {
              e.preventDefault();
              const targetId = activeTrackId || (mediaFiles.length > 0 ? mediaFiles[0].id : undefined);
              if (onOpenPlayerInNewTab) {
                onOpenPlayerInNewTab(targetId);
              } else {
                if (targetId) {
                  const mem = getMemoryFile(targetId);
                  const fileObj = mediaFiles.find((f) => f.id === targetId);
                  const blob = mem?.file || fileObj?.blobFallback;
                  if (blob && typeof window !== 'undefined') {
                    (window as any).__PWA_ACTIVE_TRACK_ID__ = targetId;
                    (window as any).__PWA_ACTIVE_MEDIA_BLOB__ = blob;
                    (window as any).__PWA_ACTIVE_TRACK_TIME__ = currentTime;
                    registerMemoryFile(targetId, blob);
                  }
                  saveActivePlaybackState({ trackId: targetId, isPlaying: true, lastTime: currentTime });
                  syncChannel.post({ type: 'LOAD_TRACK', payload: { trackId: targetId, autoPlay: true, blob, currentTime } });
                }
                const res = syncChannel.openPopoutWindow(targetId, currentTime);
                if (res.win) {
                  syncChannel.registerPopoutWindow(res.win);
                }
              }
              setStatusNotice('Opening dedicated video player in a new browser tab...');
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-400 text-xs font-semibold transition cursor-pointer shadow-sm active:scale-95"
            title="Open dedicated Video Player in a new browser tab"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>Open in New Tab</span>
          </a>

          {/* Player Preview toggle */}
          {onToggleSplitMode && (
            <button
              id="split-screen-toggle-btn"
              onClick={onToggleSplitMode}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition cursor-pointer ${
                isSplitMode
                  ? 'bg-neutral-900 dark:bg-white text-white dark:text-black border-transparent'
                  : 'bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300'
              }`}
              title={isSplitMode ? 'Hide Player Preview' : 'Show Player Preview'}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{isSplitMode ? 'Hide Preview' : 'Show Preview'}</span>
            </button>
          )}

          <PWAInstallButton />
        </div>
      </header>

      {/* Popout Blocked Fallback Banner */}
      {popoutBlockedUrl && (
        <div
          id="popout-blocked-banner"
          className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2.5 text-xs flex flex-wrap items-center justify-between gap-3 text-amber-900 dark:text-amber-200 z-30"
        >
          <div className="flex items-center gap-2">
            <span className="font-semibold text-amber-600 dark:text-amber-400">Pop-Out Window Blocked by Browser?</span>
            <span className="text-neutral-700 dark:text-neutral-300">Click below to open the dedicated player directly in a new window or tab.</span>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={popoutBlockedUrl}
              target="_blank"
              rel="opener"
              onClick={() => setPopoutBlockedUrl(null)}
              className="px-3 py-1 rounded-md bg-amber-500 hover:bg-amber-400 text-black font-semibold transition shadow-sm inline-flex items-center gap-1.5"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Open Player Window</span>
            </a>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(popoutBlockedUrl);
                setStatusNotice('Player URL copied to clipboard');
              }}
              className="px-2.5 py-1 rounded-md bg-neutral-200 dark:bg-neutral-800 hover:bg-neutral-300 dark:hover:bg-neutral-700 text-neutral-800 dark:text-neutral-200 transition cursor-pointer"
            >
              Copy Link
            </button>
            <button
              onClick={() => setPopoutBlockedUrl(null)}
              className="p-1 text-neutral-500 hover:text-neutral-900 dark:hover:text-white transition cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Ephemeral Notice */}
      {statusNotice && (
        <div
          id="controller-status-toast"
          className="fixed top-16 right-4 z-50 flex items-center gap-2 rounded-xl bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 px-3.5 py-2 text-xs font-medium text-neutral-800 dark:text-neutral-200 shadow-xl"
        >
          <Info className="w-4 h-4 text-neutral-500 shrink-0" />
          <span>{statusNotice}</span>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 space-y-6">
        {/* Ingestion Action Row */}
        <section
          id="ingestion-action-bar"
          className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-xl bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 shadow-sm"
        >
          <span className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">
            Local Files
          </span>

          <div className="flex flex-wrap items-center gap-2">
            <button
              id="import-folder-btn"
              onClick={handleIngestFolder}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-black text-xs font-semibold hover:opacity-90 transition cursor-pointer"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>Import Folder</span>
            </button>

            <button
              id="import-files-btn"
              onClick={handleIngestFiles}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 border border-neutral-200 dark:border-neutral-800 text-xs font-semibold text-neutral-800 dark:text-neutral-200 transition cursor-pointer"
            >
              <FilePlus className="w-3.5 h-3.5" />
              <span>Import Files</span>
            </button>



            {/* Reauthorize Access Button (when permission needs elevation) */}
            {needsDirectoryReauth && (
              <button
                id="reauthorize-action-btn"
                onClick={handleReauthorizeFolder}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold transition cursor-pointer shadow-sm animate-pulse"
                title="Select folder to reconnect disk access to all catalog videos without re-uploading"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>Re-link Folder</span>
              </button>
            )}

            {/* Storage & Cache Management Button */}
            <button
              id="storage-utility-btn"
              onClick={() => {
                loadStorageStats();
                setShowStorageModal(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 border border-neutral-200 dark:border-neutral-800 text-xs font-semibold text-neutral-700 dark:text-neutral-300 transition cursor-pointer"
              title="Manage Storage and Video Cache"
            >
              <HardDrive className="w-3.5 h-3.5 text-neutral-500" />
              <span>Storage & Cache</span>
            </button>
          </div>
        </section>

        {/* Browser Permission Re-Authorization Banner */}
        {needsDirectoryReauth && (
          <section
            id="reauthorize-banner"
            className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-900 dark:text-amber-200 text-xs shadow-sm"
          >
            <div className="flex items-start sm:items-center gap-2.5">
              <Lock className="w-5 h-5 text-amber-500 shrink-0 mt-0.5 sm:mt-0" />
              <div>
                <span className="font-bold text-sm">Media Access Requires Re-authorization:</span>{' '}
                <p className="mt-0.5 text-neutral-700 dark:text-neutral-300">
                  {reauthDirectoryName ? `Folder "${reauthDirectoryName}" needs ` : 'Your media files need '}
                  browser permission renewal. Your catalog and playlists are safe — select your folder or file to restore instant playback without re-importing.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto flex-wrap">
              <button
                id="reauthorize-banner-confirm-btn"
                onClick={handleReauthorizeFolder}
                className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs transition cursor-pointer shadow-md active:scale-95 flex items-center gap-1.5"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>Select Folder</span>
              </button>
              <button
                id="reauthorize-banner-files-btn"
                onClick={handleReauthorizeFiles}
                className="px-3.5 py-2 rounded-lg bg-neutral-200 dark:bg-neutral-800 hover:bg-neutral-300 dark:hover:bg-neutral-700 text-neutral-800 dark:text-neutral-200 font-semibold text-xs transition cursor-pointer border border-neutral-300 dark:border-neutral-700 flex items-center gap-1.5"
              >
                <Film className="w-3.5 h-3.5" />
                <span>Select File(s)</span>
              </button>
            </div>
          </section>
        )}

        {/* Segmented Navigation Tabs: Catalog, Playlists, Queue */}
        <div className="flex items-center justify-between flex-wrap gap-3 pb-2 border-b border-neutral-200 dark:border-neutral-800">
          <div className="flex items-center gap-1.5 p-1 bg-neutral-200/80 dark:bg-neutral-900 rounded-xl border border-neutral-300/80 dark:border-neutral-800">
            <button
              id="tab-btn-catalog"
              onClick={() => setActiveTab('catalog')}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                activeTab === 'catalog'
                  ? 'bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white shadow-xs'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              <Film className="w-3.5 h-3.5" />
              <span>Catalog</span>
              <span className="text-[11px] font-sans font-medium tabular-nums opacity-75">({mediaFiles.length})</span>
            </button>

            <button
              id="tab-btn-playlists"
              onClick={() => setActiveTab('playlists')}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                activeTab === 'playlists'
                  ? 'bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white shadow-xs'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              <FolderHeart className="w-3.5 h-3.5" />
              <span>Playlists</span>
              <span className="text-[11px] font-sans font-medium tabular-nums opacity-75">({playlists.length})</span>
            </button>

            <button
              id="tab-btn-queue"
              onClick={() => setActiveTab('queue')}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                activeTab === 'queue'
                  ? 'bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white shadow-xs'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              <ListOrdered className="w-3.5 h-3.5" />
              <span>Queue</span>
              <span className="text-[11px] font-sans font-medium tabular-nums opacity-75">({queue.length})</span>
              {playerState === 'playing' && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              )}
            </button>
          </div>

          {/* Quick Tab Header Actions */}
          <div className="flex items-center gap-2">
            {activeTab === 'queue' && (
              <>
                <button
                  id="queue-clear-btn"
                  onClick={handleClearQueue}
                  disabled={queue.length === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium text-neutral-600 dark:text-neutral-400 hover:text-rose-500 dark:hover:text-rose-400 transition cursor-pointer disabled:opacity-40"
                  title="Clear all tracks from queue"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear Queue</span>
                </button>
                <button
                  onClick={() => setActiveTab('catalog')}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-black text-xs font-semibold hover:opacity-90 transition cursor-pointer shadow-xs"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Videos</span>
                </button>
              </>
            )}

            {activeTab === 'playlists' && (
              <button
                id="create-playlist-header-btn"
                onClick={() => setShowCreateModal(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-black text-xs font-semibold hover:opacity-90 transition cursor-pointer shadow-xs"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Playlist</span>
              </button>
            )}

            {activeTab === 'catalog' && (
              <button
                onClick={handleAddAllToQueue}
                disabled={mediaFiles.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-semibold text-neutral-700 dark:text-neutral-300 transition cursor-pointer disabled:opacity-40"
                title="Add all videos to playback queue"
              >
                <ListPlus className="w-3.5 h-3.5" />
                <span>Queue All ({mediaFiles.length})</span>
              </button>
            )}
          </div>
        </div>

        {/* TAB 1: CATALOG VIEW */}
        {activeTab === 'catalog' && (
          <section id="master-catalog-section" className="rounded-xl bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-neutral-200 dark:border-neutral-800">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-neutral-500">
                  Media Catalog
                </span>
                <span className="text-xs font-sans font-medium tabular-nums text-neutral-400">
                  ({filteredFiles.length} {filteredFiles.length === 1 ? 'video' : 'videos'})
                </span>
              </div>

              <div className="relative min-w-[220px]">
                <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-neutral-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search catalog by name or format..."
                  className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-xs text-neutral-900 dark:text-neutral-100 outline-none focus:ring-1 focus:ring-neutral-400"
                />
              </div>
            </div>

            {loading ? (
              <div className="py-16 text-center text-xs text-neutral-400 font-medium">Loading catalog...</div>
            ) : filteredFiles.length === 0 ? (
              <div className="py-16 px-4 text-center border border-dashed border-neutral-300 dark:border-neutral-800 rounded-xl">
                <Film className="w-10 h-10 text-neutral-400 mx-auto mb-3 opacity-60" />
                <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                  {searchQuery ? 'No matching videos found' : 'Your video catalog is empty'}
                </p>
                <p className="text-xs text-neutral-500 mb-5 max-w-sm mx-auto">
                  Import a local folder, select video files, or drag and drop videos to get started.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2.5">
                  <button
                    onClick={handleIngestFolder}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-black text-xs font-semibold hover:opacity-90 transition cursor-pointer shadow-sm"
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                    <span>Import Folder</span>
                  </button>
                  <button
                    onClick={handleIngestFiles}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 border border-neutral-200 dark:border-neutral-800 text-xs font-semibold transition cursor-pointer"
                  >
                    <FilePlus className="w-3.5 h-3.5" />
                    <span>Import Files</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2 max-h-[620px] overflow-y-auto pr-1">
                {filteredFiles.map((file) => {
                  const isThisActive = activeTrackId === file.id;
                  const inQueue = queue.includes(file.id);
                  return (
                    <div
                      key={file.id}
                      className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-xl border transition ${
                        isThisActive
                          ? 'bg-neutral-100/90 dark:bg-neutral-900 border-neutral-300 dark:border-neutral-700 shadow-xs'
                          : 'bg-neutral-50/40 dark:bg-neutral-900/30 border-neutral-200 dark:border-neutral-800/80 hover:bg-neutral-100/60 dark:hover:bg-neutral-900/60'
                      }`}
                    >
                      {/* Left: Play button & video metadata */}
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <button
                          onClick={() => {
                            handleAddToQueue(file.id, true);
                          }}
                          className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition cursor-pointer ${
                            isThisActive
                              ? 'bg-neutral-900 dark:bg-white text-white dark:text-black shadow-xs'
                              : 'bg-neutral-200 dark:bg-neutral-800 hover:bg-neutral-300 dark:hover:bg-neutral-700 text-neutral-800 dark:text-neutral-200'
                          }`}
                          title="Play Now"
                        >
                          <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                        </button>

                        <div className="min-w-0 flex-1">
                          <p
                            onClick={() => handleAddToQueue(file.id, true)}
                            className="text-xs sm:text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate cursor-pointer hover:underline"
                            title={file.name}
                          >
                            {file.name}
                          </p>
                          <div className="flex items-center gap-2 text-[11px] text-neutral-500 dark:text-neutral-400 font-sans font-medium tabular-nums mt-0.5">
                            <span>{(file.size / (1024 * 1024)).toFixed(1)} MB</span>
                            <span>•</span>
                            <span className="uppercase">{file.mimeType.replace('video/', '')}</span>
                            {inQueue && (
                              <>
                                <span>•</span>
                                <span className="text-emerald-600 dark:text-emerald-400 font-semibold">In Queue</span>
                              </>
                            )}
                            {file.relativePath && file.relativePath !== file.name && (
                              <>
                                <span>•</span>
                                <span className="truncate max-w-[160px] text-neutral-400" title={file.relativePath}>
                                  {file.relativePath}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Right: Actions */}
                      <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-auto flex-wrap">
                        {/* Add to Queue Button */}
                        <button
                          onClick={() => handleAddToQueue(file.id, false, false)}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-800 text-xs font-semibold text-neutral-700 dark:text-neutral-300 transition cursor-pointer"
                          title="Add to end of queue"
                        >
                          <ListPlus className="w-3.5 h-3.5" />
                          <span>Add to Queue</span>
                        </button>

                        {/* Play Next in Queue */}
                        <button
                          onClick={() => handleAddToQueue(file.id, false, true)}
                          className="p-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition cursor-pointer"
                          title="Play Next in Queue"
                        >
                          <SkipForward className="w-3.5 h-3.5" />
                        </button>

                        {/* Add to Playlist */}
                        <button
                          onClick={() => setFileToAddToPlaylist(file)}
                          className="p-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition cursor-pointer"
                          title="Add to Playlist..."
                        >
                          <FolderHeart className="w-3.5 h-3.5" />
                        </button>

                        {/* Open in New Tab */}
                        <a
                          id={`popout-catalog-file-${file.id}`}
                          href={getPopoutUrl(file.id)}
                          target="_blank"
                          rel="opener"
                          onClick={(e) => {
                            e.preventDefault();
                            if (onOpenPlayerInNewTab) {
                              onOpenPlayerInNewTab(file.id);
                            } else {
                              const mem = getMemoryFile(file.id);
                              const blob = mem?.file || file.blobFallback;
                              if (blob && typeof window !== 'undefined') {
                                (window as any).__PWA_ACTIVE_TRACK_ID__ = file.id;
                                (window as any).__PWA_ACTIVE_MEDIA_BLOB__ = blob;
                                registerMemoryFile(file.id, blob);
                              }
                              saveActivePlaybackState({ trackId: file.id, isPlaying: true });
                              syncChannel.post({ type: 'LOAD_TRACK', payload: { trackId: file.id, autoPlay: true, blob } });
                              const res = syncChannel.openPopoutWindow(file.id, 0, blob);
                              if (res.win) {
                                syncChannel.registerPopoutWindow(res.win);
                              }
                            }
                            setStatusNotice(`Opening "${file.name}" in new tab...`);
                          }}
                          className="p-1.5 text-neutral-500 hover:text-amber-500 rounded-lg transition cursor-pointer inline-flex items-center justify-center border border-neutral-200 dark:border-neutral-800"
                          title="Play video in a separate browser tab"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>

                        {/* Inspector */}
                        <button
                          onClick={() => openInspector(file)}
                          className="p-1.5 text-neutral-500 hover:text-neutral-900 dark:hover:text-white rounded-lg border border-neutral-200 dark:border-neutral-800 transition cursor-pointer"
                          title="Video file details & playlists"
                        >
                          <Info className="w-3.5 h-3.5" />
                        </button>

                        {/* Delete */}
                        <button
                          onClick={() => handleDeleteMediaFile(file.id, file.name)}
                          className="p-1.5 text-neutral-400 hover:text-rose-500 rounded-lg border border-neutral-200 dark:border-neutral-800 transition cursor-pointer"
                          title="Remove video from library"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* TAB 2: PLAYLISTS VIEW */}
        {activeTab === 'playlists' && (
          <section id="playlists-manager-section" className="space-y-4">
            {playlists.length === 0 ? (
              <div className="rounded-xl bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 p-12 text-center">
                <FolderHeart className="w-12 h-12 text-neutral-400 mx-auto mb-3 opacity-60" />
                <h3 className="text-base font-bold text-neutral-900 dark:text-neutral-100 mb-1">No Playlists Created Yet</h3>
                <p className="text-xs text-neutral-500 mb-5 max-w-sm mx-auto">
                  Organize your videos into custom playlists. You can re-order tracks inside playlists and queue entire playlists with 1 click.
                </p>
                <button
                  onClick={() => setShowCreateModal(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-black text-xs font-semibold hover:opacity-90 transition cursor-pointer shadow-sm"
                >
                  <Plus className="w-4 h-4" />
                  <span>Create Your First Playlist</span>
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {playlists.map((pl) => {
                  const isExpanded = expandedPlaylistId === pl.id;
                  const plFiles = pl.fileIds
                    .map((id) => mediaFiles.find((f) => f.id === id))
                    .filter((f): f is MediaFile => Boolean(f));

                  return (
                    <div
                      key={pl.id}
                      className="rounded-xl bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 p-4 space-y-3 shadow-xs"
                    >
                      {/* Playlist Header */}
                      <div className="flex items-start justify-between gap-2 pb-2 border-b border-neutral-200 dark:border-neutral-800">
                        <div className="min-w-0 flex-1">
                          {editingPlaylistId === pl.id ? (
                            <div className="flex items-center gap-1.5">
                              <input
                                type="text"
                                value={editingPlaylistName}
                                onChange={(e) => setEditingPlaylistName(e.target.value)}
                                className="px-2 py-1 text-xs font-semibold rounded bg-neutral-100 dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 outline-none flex-1"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleRenamePlaylist(pl.id);
                                }}
                              />
                              <button
                                onClick={() => handleRenamePlaylist(pl.id)}
                                className="p-1 text-emerald-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded"
                                title="Save"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => setEditingPlaylistId(null)}
                                className="p-1 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded"
                                title="Cancel"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <h4 className="text-sm font-bold text-neutral-900 dark:text-neutral-100 truncate" title={pl.name}>
                                {pl.name}
                              </h4>
                              <button
                                onClick={() => {
                                  setEditingPlaylistId(pl.id);
                                  setEditingPlaylistName(pl.name);
                                }}
                                className="p-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 rounded"
                                title="Rename playlist"
                              >
                                <Edit2 className="w-3 h-3" />
                              </button>
                            </div>
                          )}
                          <p className="text-[11px] font-sans font-medium tabular-nums text-neutral-500 mt-0.5">
                            {pl.fileIds.length} {pl.fileIds.length === 1 ? 'track' : 'tracks'}
                          </p>
                        </div>

                        {/* Top Playlist Actions */}
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => handlePlayPlaylist(pl)}
                            disabled={pl.fileIds.length === 0}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-neutral-900 dark:bg-white text-white dark:text-black text-xs font-semibold transition hover:opacity-90 cursor-pointer disabled:opacity-40"
                            title="Play playlist now"
                          >
                            <Play className="w-3 h-3 fill-current ml-0.5" />
                            <span>Play</span>
                          </button>
                          <button
                            onClick={() => handleAddPlaylistToQueue(pl)}
                            disabled={pl.fileIds.length === 0}
                            className="p-1.5 rounded-md border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-neutral-700 dark:text-neutral-300 transition cursor-pointer disabled:opacity-40"
                            title="Add playlist to queue"
                          >
                            <ListPlus className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeletePlaylist(pl.id)}
                            className="p-1.5 text-neutral-400 hover:text-rose-500 rounded-md transition cursor-pointer"
                            title="Delete playlist"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Playlist Tracks Area */}
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs text-neutral-500 font-medium">
                          <span>Tracks in Playlist</span>
                          <button
                            onClick={() => setExpandedPlaylistId(isExpanded ? null : pl.id)}
                            className="text-neutral-500 hover:text-neutral-900 dark:hover:text-white flex items-center gap-1 cursor-pointer"
                          >
                            <span>{isExpanded ? 'Collapse' : 'Manage Tracks'}</span>
                            {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          </button>
                        </div>

                        {plFiles.length === 0 ? (
                          <div className="py-4 text-center text-xs text-neutral-400 bg-neutral-50 dark:bg-neutral-900/50 rounded-lg border border-dashed border-neutral-200 dark:border-neutral-800">
                            Playlist is empty. Add videos below.
                          </div>
                        ) : (
                          <div className={`space-y-1 overflow-y-auto pr-1 ${isExpanded ? 'max-h-64' : 'max-h-36'}`}>
                            {plFiles.map((file, idx) => (
                              <div
                                key={`pl-file-${pl.id}-${file.id}-${idx}`}
                                className="flex items-center justify-between p-2 rounded-lg bg-neutral-50 dark:bg-neutral-900/40 border border-neutral-200/80 dark:border-neutral-800/80 text-xs"
                              >
                                <div className="flex items-center gap-2 min-w-0 pr-2">
                                  <span className="font-sans font-medium tabular-nums text-neutral-400 w-4 text-right">
                                    {idx + 1}
                                  </span>
                                  <button
                                    onClick={() => dispatchLoadTrack(file.id, true)}
                                    className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300 transition cursor-pointer"
                                    title="Play track"
                                  >
                                    <Play className="w-3 h-3 fill-current ml-0.5" />
                                  </button>
                                  <span className="truncate font-medium text-neutral-800 dark:text-neutral-200" title={file.name}>
                                    {file.name}
                                  </span>
                                </div>

                                <div className="flex items-center gap-0.5 shrink-0">
                                  <button
                                    disabled={idx === 0}
                                    onClick={async () => {
                                      const newOrder = [...pl.fileIds];
                                      const [moved] = newOrder.splice(idx, 1);
                                      newOrder.splice(idx - 1, 0, moved);
                                      await updatePlaylist({ ...pl, fileIds: newOrder });
                                      await loadDatabase();
                                    }}
                                    className="p-1 text-neutral-400 hover:text-neutral-900 dark:hover:text-white disabled:opacity-20 cursor-pointer"
                                    title="Move track up"
                                  >
                                    <ChevronUp className="w-3 h-3" />
                                  </button>
                                  <button
                                    disabled={idx === pl.fileIds.length - 1}
                                    onClick={async () => {
                                      const newOrder = [...pl.fileIds];
                                      const [moved] = newOrder.splice(idx, 1);
                                      newOrder.splice(idx + 1, 0, moved);
                                      await updatePlaylist({ ...pl, fileIds: newOrder });
                                      await loadDatabase();
                                    }}
                                    className="p-1 text-neutral-400 hover:text-neutral-900 dark:hover:text-white disabled:opacity-20 cursor-pointer"
                                    title="Move track down"
                                  >
                                    <ChevronDown className="w-3 h-3" />
                                  </button>
                                  <button
                                    onClick={async () => {
                                      await removeFileFromPlaylist(file.id, pl.id);
                                      await loadDatabase();
                                    }}
                                    className="p-1 text-neutral-400 hover:text-rose-500 cursor-pointer"
                                    title="Remove from playlist"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Add Videos to this playlist button */}
                        <button
                          onClick={() => setShowAddTracksToPlaylist(pl)}
                          className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-semibold text-neutral-700 dark:text-neutral-300 transition cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>Add Videos to Playlist</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* TAB 3: QUEUE VIEW */}
        {activeTab === 'queue' && (
          <section id="playback-queue-section" className="space-y-4">
            {/* Now Playing Banner (if active track) */}
            {activeTrack && (
              <div className="rounded-xl bg-neutral-900 text-white p-4 shadow-md border border-neutral-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-neutral-800 border border-neutral-700 flex items-center justify-center shrink-0 text-amber-400">
                    <Film className="w-5 h-5 animate-pulse" />
                  </div>
                  <div className="min-w-0">
                    <span className="text-[11px] font-sans font-semibold uppercase tracking-wider text-amber-400">
                      Now Playing {currentQueueIndex !== -1 ? `• Track ${currentQueueIndex + 1} of ${queue.length}` : ''}
                    </span>
                    <h3 className="text-sm sm:text-base font-bold truncate text-white" title={activeTrack.name}>
                      {activeTrack.name}
                    </h3>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0 self-end sm:self-auto">
                  <span className="text-xs font-sans font-medium tabular-nums text-neutral-400">
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </span>
                  <button
                    onClick={() => {
                      if (playerState === 'playing') dispatchPause();
                      else dispatchPlay();
                    }}
                    className="px-3 py-1.5 rounded-lg bg-white text-black font-semibold text-xs flex items-center gap-1.5 transition hover:bg-neutral-200 cursor-pointer"
                  >
                    {playerState === 'playing' ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current ml-0.5" />}
                    <span>{playerState === 'playing' ? 'Pause' : 'Play'}</span>
                  </button>
                </div>
              </div>
            )}

            {/* Queue List Card */}
            <div className="rounded-xl bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 p-4 sm:p-5 space-y-3">
              <div className="flex items-center justify-between pb-3 border-b border-neutral-200 dark:border-neutral-800">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-neutral-500">Active Queue</span>
                  <span className="text-xs font-sans font-medium tabular-nums text-neutral-400">
                    ({queueFiles.length} {queueFiles.length === 1 ? 'track' : 'tracks'})
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleClearQueue}
                    disabled={queue.length === 0}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium text-neutral-600 dark:text-neutral-400 hover:text-rose-500 transition cursor-pointer disabled:opacity-40"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>Clear</span>
                  </button>
                </div>
              </div>

              {queueFiles.length === 0 ? (
                <div className="py-16 text-center border border-dashed border-neutral-300 dark:border-neutral-800 rounded-xl">
                  <ListOrdered className="w-10 h-10 text-neutral-400 mx-auto mb-3 opacity-60" />
                  <h4 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                    Your playback queue is empty
                  </h4>
                  <p className="text-xs text-neutral-500 mb-4 max-w-xs mx-auto">
                    Add videos from the Catalog or Playlists tab to begin a custom continuous playback sequence.
                  </p>
                  <button
                    onClick={() => setActiveTab('catalog')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-black text-xs font-semibold hover:opacity-90 transition cursor-pointer shadow-xs"
                  >
                    <Film className="w-3.5 h-3.5" />
                    <span>Browse Media Catalog</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-1.5 max-h-[580px] overflow-y-auto pr-1">
                  {queueFiles.map((file, idx) => {
                    const isPlayingThis = activeTrackId === file.id;
                    const isDragging = draggedQueueIndex === idx;

                    return (
                      <div
                        key={`queue-item-${file.id}-${idx}`}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', String(idx));
                          setDraggedQueueIndex(idx);
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
                          if (!isNaN(fromIdx)) {
                            handleReorderQueueDrag(fromIdx, idx);
                          }
                          setDraggedQueueIndex(null);
                        }}
                        onDragEnd={() => setDraggedQueueIndex(null)}
                        className={`flex items-center justify-between p-2.5 rounded-xl border transition ${
                          isDragging
                            ? 'opacity-40 border-dashed border-amber-500'
                            : isPlayingThis
                            ? 'bg-neutral-100 dark:bg-neutral-900 border-neutral-400 dark:border-neutral-600 shadow-xs'
                            : 'bg-neutral-50/50 dark:bg-neutral-900/30 border-neutral-200 dark:border-neutral-800/80 hover:bg-neutral-100/70 dark:hover:bg-neutral-900/70'
                        }`}
                      >
                        {/* Drag Handle & Number & Track Info */}
                        <div className="flex items-center gap-2.5 min-w-0 flex-1 pr-2">
                          <button
                            className="p-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 cursor-grab active:cursor-grabbing shrink-0"
                            title="Drag to re-order"
                          >
                            <GripVertical className="w-4 h-4" />
                          </button>

                          <span className="font-sans font-medium tabular-nums text-neutral-400 text-xs w-5 text-right shrink-0">
                            {idx + 1}
                          </span>

                          <button
                            onClick={() => dispatchLoadTrack(file.id, true)}
                            className={`w-7 h-7 rounded flex items-center justify-center shrink-0 transition cursor-pointer ${
                              isPlayingThis
                                ? 'bg-neutral-900 dark:bg-white text-white dark:text-black'
                                : 'bg-neutral-200 dark:bg-neutral-800 hover:bg-neutral-300 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300'
                            }`}
                            title="Play this track"
                          >
                            <Play className="w-3 h-3 fill-current ml-0.5" />
                          </button>

                          <div className="min-w-0 flex-1">
                            <p
                              onClick={() => dispatchLoadTrack(file.id, true)}
                              className="text-xs sm:text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate cursor-pointer hover:underline"
                              title={file.name}
                            >
                              {file.name}
                            </p>
                            <div className="flex items-center gap-2 text-[11px] font-sans font-medium tabular-nums text-neutral-400">
                              <span>{(file.size / (1024 * 1024)).toFixed(1)} MB</span>
                              {isPlayingThis && (
                                <>
                                  <span>•</span>
                                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold uppercase text-[10px]">
                                    {playerState}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Re-order & Remove Controls */}
                        <div className="flex items-center gap-1 shrink-0">
                          {/* Move Up */}
                          <button
                            disabled={idx === 0}
                            onClick={() => handleMoveQueueItem(idx, 'up')}
                            className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-200 dark:hover:bg-neutral-800 disabled:opacity-20 cursor-pointer"
                            title="Move Up in Queue"
                          >
                            <ChevronUp className="w-3.5 h-3.5" />
                          </button>

                          {/* Move Down */}
                          <button
                            disabled={idx === queueFiles.length - 1}
                            onClick={() => handleMoveQueueItem(idx, 'down')}
                            className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-200 dark:hover:bg-neutral-800 disabled:opacity-20 cursor-pointer"
                            title="Move Down in Queue"
                          >
                            <ChevronDown className="w-3.5 h-3.5" />
                          </button>

                          {/* Remove from Queue */}
                          <button
                            onClick={() => handleRemoveFromQueue(idx)}
                            className="p-1.5 rounded-lg text-neutral-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition cursor-pointer ml-1"
                            title="Remove from Queue"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      {/* REMOTE CONTROL BAR (With Loop & Transport Controls) */}
      <footer
        id="remote-control-bar"
        className="fixed bottom-0 inset-x-0 z-40 bg-white/95 dark:bg-black/95 backdrop-blur-xl border-t border-neutral-200 dark:border-neutral-800 px-4 md:px-8 py-3 shadow-2xl"
      >
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3">
          {/* Active Track */}
          <div className="flex items-center gap-3 min-w-0 w-full md:w-1/4">
            <div className="w-9 h-9 rounded-lg bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 flex items-center justify-center shrink-0">
              <Film className="w-4 h-4 text-neutral-500" />
            </div>
            <div className="min-w-0">
              <p className="text-xs sm:text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100 truncate" title={activeTrack ? activeTrack.name : 'No Track'}>
                {activeTrack ? activeTrack.name : 'No Track'}
              </p>
              <span className="text-[10px] font-sans font-medium tracking-wider uppercase text-neutral-500 dark:text-neutral-400">
                {playerState}
              </span>
            </div>
          </div>

          {/* Transport Controls & Continuous Progress Bar */}
          <div className="flex-1 w-full max-w-xl flex flex-col items-center gap-1.5">
            <div className="flex items-center gap-2 sm:gap-3">
              <button
                id="ctrl-prev-btn"
                onClick={handlePlayPrev}
                className="p-1.5 text-neutral-500 hover:text-neutral-900 dark:hover:text-white transition cursor-pointer"
                title="Previous Track"
              >
                <SkipBack className="w-4 h-4 fill-current" />
              </button>

              <button
                id="ctrl-play-pause-btn"
                onClick={() => {
                  if (playerState === 'playing') {
                    dispatchPause();
                  } else {
                    dispatchPlay();
                  }
                }}
                className="w-9 h-9 rounded-full bg-neutral-900 dark:bg-white text-white dark:text-black flex items-center justify-center shadow transition active:scale-95 cursor-pointer"
                title={playerState === 'playing' ? 'Pause' : 'Play'}
              >
                {playerState === 'playing' ? (
                  <Pause className="w-4 h-4 fill-current" />
                ) : (
                  <Play className="w-4 h-4 fill-current ml-0.5" />
                )}
              </button>

              <button
                id="ctrl-next-btn"
                onClick={handlePlayNext}
                className="p-1.5 text-neutral-500 hover:text-neutral-900 dark:hover:text-white transition cursor-pointer"
                title="Next Track"
              >
                <SkipForward className="w-4 h-4 fill-current" />
              </button>

              {/* Loop Option Button */}
              <button
                id="ctrl-loop-btn"
                onClick={() => handleToggleLoop()}
                className={`p-1.5 rounded-lg border transition cursor-pointer ${
                  isLooping
                    ? 'bg-neutral-900 dark:bg-white text-white dark:text-black border-transparent shadow-xs'
                    : 'border-neutral-200 dark:border-neutral-800 text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
                }`}
                title={isLooping ? 'Disable Loop' : 'Enable Loop'}
              >
                <Repeat className="w-4 h-4" />
              </button>

              {/* Picture-in-Picture Control Button */}
              <button
                id="ctrl-pip-btn"
                onClick={dispatchTogglePiP}
                className={`p-1.5 rounded-lg border transition cursor-pointer ${
                  isPiPActive
                    ? 'bg-neutral-900 dark:bg-white text-white dark:text-black border-transparent'
                    : 'border-neutral-200 dark:border-neutral-800 text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
                }`}
                title={isPiPActive ? 'Exit Picture-in-Picture' : 'Enter Picture-in-Picture'}
              >
                <PictureInPicture2 className="w-4 h-4" />
              </button>

              {/* Pop-Out Player Button */}
              {/* Open in New Tab Button */}
              <a
                id="ctrl-popout-bottom-btn"
                href={getPopoutUrl(activeTrackId || (mediaFiles.length > 0 ? mediaFiles[0].id : undefined), currentTime)}
                target="_blank"
                rel="opener"
                onClick={(e) => {
                  e.preventDefault();
                  const targetId = activeTrackId || (mediaFiles.length > 0 ? mediaFiles[0].id : undefined);
                  if (onOpenPlayerInNewTab) {
                    onOpenPlayerInNewTab(targetId);
                  } else {
                    if (targetId) {
                      const mem = getMemoryFile(targetId);
                      const fileObj = mediaFiles.find((f) => f.id === targetId);
                      const blob = mem?.file || fileObj?.blobFallback;
                      if (blob && typeof window !== 'undefined') {
                        (window as any).__PWA_ACTIVE_TRACK_ID__ = targetId;
                        (window as any).__PWA_ACTIVE_MEDIA_BLOB__ = blob;
                        (window as any).__PWA_ACTIVE_TRACK_TIME__ = currentTime;
                        registerMemoryFile(targetId, blob);
                      }
                      saveActivePlaybackState({ trackId: targetId, isPlaying: true, lastTime: currentTime });
                      syncChannel.post({ type: 'LOAD_TRACK', payload: { trackId: targetId, autoPlay: true, blob, currentTime } });
                    }
                    const res = syncChannel.openPopoutWindow(targetId, currentTime);
                    if (res.win) {
                      syncChannel.registerPopoutWindow(res.win);
                    }
                  }
                  setStatusNotice('Opening video player in new tab...');
                }}
                className="p-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 text-neutral-500 hover:text-amber-500 hover:border-amber-500/50 dark:hover:text-amber-400 transition cursor-pointer inline-flex items-center justify-center"
                title="Open video player in a new browser tab"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>

            {/* Scrubber */}
            <div className="w-full flex items-center gap-2.5">
              <span className="text-xs font-sans font-medium tabular-nums text-neutral-500 dark:text-neutral-400 w-11 text-right select-none">
                {formatTime(isScrubbing ? scrubTime : currentTime)}
              </span>
              <input
                id="ctrl-seek-scrubber"
                type="range"
                min="0"
                max={duration || 100}
                step="0.1"
                value={isScrubbing ? scrubTime : currentTime}
                onMouseDown={() => {
                  isScrubbingRef.current = true;
                  setIsScrubbing(true);
                  setScrubTime(currentTime);
                }}
                onTouchStart={() => {
                  isScrubbingRef.current = true;
                  setIsScrubbing(true);
                  setScrubTime(currentTime);
                }}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  setScrubTime(val);
                }}
                onMouseUp={(e) => {
                  const val = parseFloat((e.target as HTMLInputElement).value);
                  isScrubbingRef.current = false;
                  setIsScrubbing(false);
                  dispatchSeek(val);
                }}
                onTouchEnd={(e) => {
                  const val = parseFloat((e.target as HTMLInputElement).value);
                  isScrubbingRef.current = false;
                  setIsScrubbing(false);
                  dispatchSeek(val);
                }}
                className="flex-1 h-1 accent-neutral-900 dark:accent-white bg-neutral-200 dark:bg-neutral-800 rounded-lg cursor-pointer"
              />
              <span className="text-xs font-sans font-medium tabular-nums text-neutral-500 dark:text-neutral-400 w-11 select-none">
                {formatTime(duration)}
              </span>
            </div>
          </div>

          {/* Volume & Autoplay */}
          <div className="flex items-center justify-end gap-3 sm:gap-4 w-full md:w-1/4">
            {/* Autoplay Toggle */}
            <label className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-neutral-600 dark:text-neutral-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoPlayNext}
                onChange={(e) => {
                  setAutoPlayNext(e.target.checked);
                  setAutoPlaySetting(e.target.checked);
                }}
                className="accent-neutral-900 dark:accent-white rounded cursor-pointer"
              />
              <span className="hidden sm:inline">Autoplay</span>
            </label>

            {/* Volume Control */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => dispatchVolume(volume, !isMuted)}
                className="text-neutral-500 hover:text-neutral-900 dark:hover:text-white transition cursor-pointer"
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="w-4 h-4 text-rose-500" />
                ) : (
                  <Volume2 className="w-4 h-4" />
                )}
              </button>
              <input
                id="ctrl-volume-slider"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={(e) => dispatchVolume(parseFloat(e.target.value), false)}
                className="w-16 h-1 accent-neutral-900 dark:accent-white bg-neutral-200 dark:bg-neutral-800 rounded-lg cursor-pointer"
              />
              <span className="text-[11px] font-sans font-medium tabular-nums text-neutral-400 select-none w-7 text-right">
                {isMuted ? '0%' : `${Math.round(volume * 100)}%`}
              </span>
            </div>
          </div>
        </div>
      </footer>

      {/* INSPECTOR MODAL */}
      {inspectingFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div
            id="file-inspector-modal"
            className="w-full max-w-sm rounded-xl bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 p-5 shadow-2xl text-neutral-900 dark:text-neutral-100 space-y-4"
          >
            <div className="flex items-start justify-between">
              <h3 className="text-sm font-bold truncate max-w-[260px]">{inspectingFile.name}</h3>
              <button
                onClick={() => setInspectingFile(null)}
                className="p-1 text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-2.5 rounded-lg bg-neutral-100 dark:bg-neutral-900 text-xs font-sans space-y-1 text-neutral-600 dark:text-neutral-400">
              <div className="flex justify-between">
                <span>Size:</span>
                <span className="text-neutral-900 dark:text-neutral-200">
                  {(inspectingFile.size / (1024 * 1024)).toFixed(2)} MB
                </span>
              </div>
              <div className="flex justify-between">
                <span>Type:</span>
                <span className="text-neutral-900 dark:text-neutral-200">{inspectingFile.mimeType}</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-neutral-500">Playlists</span>
              {playlists.length === 0 ? (
                <div className="py-3 text-center text-xs text-neutral-400">No playlists created yet.</div>
              ) : (
                <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                  {playlists.map((pl) => {
                    const checked = filePlaylistIds.includes(pl.id);
                    return (
                      <div
                        key={`rel-${pl.id}`}
                        onClick={() => toggleFilePlaylist(pl.id)}
                        className={`flex items-center justify-between p-2 rounded-lg border cursor-pointer text-xs transition ${
                          checked
                            ? 'bg-neutral-100 dark:bg-neutral-900 border-neutral-300 dark:border-neutral-700 font-medium'
                            : 'border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-400'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {checked ? (
                            <CheckSquare className="w-4 h-4 text-neutral-900 dark:text-white shrink-0" />
                          ) : (
                            <Square className="w-4 h-4 text-neutral-400 shrink-0" />
                          )}
                          <span>{pl.name}</span>
                        </div>
                        <span className="text-[10px] font-sans font-medium tabular-nums text-neutral-400">{pl.fileIds.length} tracks</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="pt-2 flex items-center justify-between">
              <button
                onClick={() => {
                  if (inspectingFile) {
                    handleDeleteMediaFile(inspectingFile.id, inspectingFile.name);
                    setInspectingFile(null);
                  }
                }}
                className="px-3 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 text-xs font-semibold transition cursor-pointer flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Remove from Library</span>
              </button>
              <button
                onClick={() => setInspectingFile(null)}
                className="px-3.5 py-1.5 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-black text-xs font-semibold transition cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CREATE PLAYLIST MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-xs rounded-xl bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 p-5 shadow-2xl space-y-3">
            <h3 className="text-sm font-bold">New Playlist</h3>
            <input
              type="text"
              autoFocus
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              placeholder="Playlist name..."
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreatePlaylist();
              }}
              className="w-full px-3 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 text-xs outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-3 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-900 text-xs text-neutral-600 dark:text-neutral-400"
              >
                Cancel
              </button>
              <button
                onClick={handleCreatePlaylist}
                className="px-3 py-1.5 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-black text-xs font-semibold"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* STORAGE & COMPATIBILITY RESET MODAL */}
      {showStorageModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 p-5 shadow-2xl text-neutral-900 dark:text-neutral-100 space-y-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-neutral-700 dark:text-neutral-300" />
                <h3 className="text-sm font-bold">Storage & Cache Utility</h3>
              </div>
              <button
                onClick={() => setShowStorageModal(false)}
                className="p-1 text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Storage Usage Info */}
            <div className="p-3 rounded-lg bg-neutral-100 dark:bg-neutral-900 text-xs space-y-1.5">
              <div className="flex justify-between font-medium">
                <span className="text-neutral-500">IndexedDB Storage:</span>
                <span className="font-sans font-medium text-neutral-900 dark:text-neutral-100">
                  {storageStats ? `${storageStats.usedMB} MB / ${storageStats.quotaMB} MB quota` : 'Calculating...'}
                </span>
              </div>
              <div className="flex justify-between font-medium">
                <span className="text-neutral-500">Track Catalog Size:</span>
                <span className="font-sans font-medium text-neutral-900 dark:text-neutral-100">
                  {mediaFiles.length} files ({playlists.length} playlists)
                </span>
              </div>
            </div>

            {/* Compatibility Explanation */}
            <div className="p-3 rounded-lg bg-neutral-50 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 text-xs text-neutral-600 dark:text-neutral-400 space-y-2">
              <p className="font-semibold text-neutral-800 dark:text-neutral-200">
                Backwards Compatibility & Expired Handles
              </p>
              <p>
                Browsers do not retain persistent native disk permissions across fresh browser reboots or sandbox context switches. If you have videos from an earlier version or session that show playback errors or fail to play, you have two recovery options:
              </p>
            </div>

            {/* Action Buttons */}
            <div className="space-y-2 pt-1">
              <button
                onClick={() => handleClearVideoCache(true)}
                className="w-full flex items-center justify-between p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-900 dark:text-amber-200 text-xs font-semibold transition cursor-pointer"
              >
                <div className="text-left">
                  <p className="font-bold">Clear Video Cache (Preserve Playlists)</p>
                  <p className="text-[11px] font-normal text-amber-800/80 dark:text-amber-300/80">
                    Purges stale video handles while keeping your custom playlist names & folders intact.
                  </p>
                </div>
                <RotateCcw className="w-4 h-4 shrink-0 ml-2 text-amber-600 dark:text-amber-400" />
              </button>

              <button
                onClick={() => handleClearVideoCache(false)}
                className="w-full flex items-center justify-between p-3 rounded-lg border border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20 text-rose-900 dark:text-rose-200 text-xs font-semibold transition cursor-pointer"
              >
                <div className="text-left">
                  <p className="font-bold">Clear All Videos & Playlists</p>
                  <p className="text-[11px] font-normal text-rose-800/80 dark:text-rose-300/80">
                    Removes all media handles and deletes existing playlists.
                  </p>
                </div>
                <Trash2 className="w-4 h-4 shrink-0 ml-2 text-rose-600 dark:text-rose-400" />
              </button>

              <button
                onClick={handleFullSystemReset}
                className="w-full flex items-center justify-between p-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 transition cursor-pointer"
              >
                <span>Full System Reset (Wipe DB & Storage)</span>
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex justify-end pt-2 border-t border-neutral-200 dark:border-neutral-800">
              <button
                onClick={() => setShowStorageModal(false)}
                className="px-4 py-1.5 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-black text-xs font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <OfflineIndicator />
    </div>
  );
};
