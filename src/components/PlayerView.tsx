/**
 * Player Page Component (player.html)
 * 
 * - Fullscreen edge-to-edge HTML5 <video> canvas
 * - Autonomous FileSystemFileHandle resolution from IndexedDB
 * - Native Picture-in-Picture controls & inter-tab PiP synchronization
 * - Pure deep pitch-black styling (no blue/slate tints)
 * - Clean minimal HUD without promotional branding or unnecessary text
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Radio,
  Lock,
  ExternalLink,
  Film,
  AlertCircle,
  RefreshCw,
  PictureInPicture2,
  Repeat,
  FolderOpen,
  Expand,
  SkipBack,
  SkipForward,
  RotateCcw,
  RotateCw,
} from 'lucide-react';
import { MediaFile, SyncMessage } from '../types';
import { getMediaFile, getMemoryFile, saveMediaFile, registerMemoryFile, getAllDirectoryHandles, getAllMediaFiles, retrieveBinaryBlob, persistBinaryBlob } from '../lib/db';
import { relinkFolderHandles, generateUUID, isInsideIframe, pickFolderToRelink, pickFilesToRelink, relinkFilesFromList } from '../lib/fileIngestion';
import { syncChannel, getPopoutUrl } from '../lib/syncChannel';
import {
  getActivePlaybackState,
  saveActivePlaybackState,
  setActiveTrack,
  setVolumeState,
  setLastPlaybackTime,
  setLoopSetting,
  getStoredQueue,
} from '../lib/localStorageState';

interface PlayerViewProps {
  embedded?: boolean;
  isExternalActive?: boolean;
  onOpenPopout?: () => void;
  onBringBack?: () => void;
}

export const PlayerView: React.FC<PlayerViewProps> = ({
  embedded = false,
  isExternalActive = false,
  onOpenPopout,
  onBringBack,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isExternalActiveRef = useRef<boolean>(isExternalActive);
  const currentTrackRef = useRef<MediaFile | null>(null);
  const lastLoadedTrackIdRef = useRef<string | null>(null);
  const isLoadingTrackRef = useRef<boolean>(false);
  const hasMountedRef = useRef<boolean>(false);
  const handlePlayPrevRef = useRef<() => void>(() => {});
  const handlePlayNextRef = useRef<() => void>(() => {});

  useEffect(() => {
    isExternalActiveRef.current = isExternalActive;
    if (isExternalActive && videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }
  }, [isExternalActive]);

  // Viewport Fit mode: contain (fit uncropped), cover (fill edge-to-edge), fill (stretch)
  const [fitMode, setFitMode] = useState<'contain' | 'cover' | 'fill'>(() => {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('pwa_player_fit_mode');
      if (saved === 'contain' || saved === 'cover' || saved === 'fill') return saved;
    }
    return 'contain';
  });
  const [fitModeNotice, setFitModeNotice] = useState<string | null>(null);

  const cycleFitMode = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setFitMode((prev) => {
      const next = prev === 'contain' ? 'cover' : prev === 'cover' ? 'fill' : 'contain';
      try {
        localStorage.setItem('pwa_player_fit_mode', next);
      } catch {}
      const label =
        next === 'contain'
          ? 'Fit: Full frame (uncropped)'
          : next === 'cover'
          ? 'Fill: Edge-to-edge (crop)'
          : 'Stretch: Fill frame';
      setFitModeNotice(label);
      setTimeout(() => setFitModeNotice(null), 2500);
      syncChannel.post({ type: 'SET_FIT_MODE', payload: { fitMode: next } });
      return next;
    });
  };

  // Playback state
  const [currentTrack, setCurrentTrack] = useState<MediaFile | null>(null);

  useEffect(() => {
    currentTrackRef.current = currentTrack;
  }, [currentTrack]);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isBuffering, setIsBuffering] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isPiP, setIsPiP] = useState<boolean>(false);
  const [pipSupported, setPipSupported] = useState<boolean>(false);
  const [isLooping, setIsLooping] = useState<boolean>(() => getActivePlaybackState().loop ?? false);

  // Permission recovery state
  const [needsPermission, setNeedsPermission] = useState<boolean>(false);
  const [pendingTrack, setPendingTrack] = useState<{ trackId: string; autoPlay?: boolean } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const relinkInputRef = useRef<HTMLInputElement | null>(null);

  // HUD visibility on mouse move
  const [showHud, setShowHud] = useState<boolean>(true);
  const hudTimeoutRef = useRef<number | null>(null);

  // Object URL tracking for revocation
  const currentObjectUrlRef = useRef<string | null>(null);
  const lastTimeSentRef = useRef<number>(0);

  // Check Picture in Picture support
  useEffect(() => {
    if (typeof document !== 'undefined') {
      setPipSupported(Boolean(document.pictureInPictureEnabled));
    }
  }, []);

  // Safely revoke object URL to prevent memory leaks
  const revokeCurrentUrl = useCallback(() => {
    if (currentObjectUrlRef.current) {
      URL.revokeObjectURL(currentObjectUrlRef.current);
      currentObjectUrlRef.current = null;
    }
  }, []);

  // Update Media Session API
  const updateMediaSession = useCallback((file: MediaFile) => {
    if (typeof window === 'undefined' || !('mediaSession' in navigator)) return;

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: file.name.replace(/\.[^/.]+$/, ''),
        artist: 'Local Media',
        album: 'Video Player',
        artwork: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
        ],
      });

      navigator.mediaSession.setActionHandler('play', () => {
        videoRef.current?.play().catch(() => {});
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        videoRef.current?.pause();
      });
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (videoRef.current && details.seekTime !== undefined) {
          videoRef.current.currentTime = details.seekTime;
        }
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        handlePlayPrevRef.current();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        handlePlayNextRef.current();
      });
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        if (videoRef.current) {
          const skip = details.seekOffset || 10;
          videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - skip);
        }
      });
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        if (videoRef.current) {
          const skip = details.seekOffset || 10;
          videoRef.current.currentTime = Math.min(videoRef.current.duration || 0, videoRef.current.currentTime + skip);
        }
      });
    } catch (e) {
      console.warn('MediaSession setup warning:', e);
    }
  }, []);

  // Play Media Blob directly
  const playMediaBlob = useCallback(
    (fileRecord: MediaFile, mediaBlob: Blob, autoPlay: boolean = true) => {
      setErrorMessage(null);
      setNeedsPermission(false);
      setPendingTrack(null);

      // If this exact track is already loaded in the video element, do NOT recreate URL or reset currentTime to 0!
      if (
        currentTrackRef.current?.id === fileRecord.id &&
        videoRef.current?.src &&
        videoRef.current.src !== '' &&
        videoRef.current.src !== window.location.href &&
        !videoRef.current.ended
      ) {
        if (autoPlay && videoRef.current.paused) {
          videoRef.current.play().catch(() => {});
        }
        return;
      }

      revokeCurrentUrl();
      const blobUrl = URL.createObjectURL(mediaBlob);
      currentObjectUrlRef.current = blobUrl;

      lastLoadedTrackIdRef.current = fileRecord.id;
      currentTrackRef.current = fileRecord;
      setCurrentTrack(fileRecord);
      setActiveTrack(fileRecord.id);
      updateMediaSession(fileRecord);

      // Report active track to controller via SYNC_PONG (never post LOAD_TRACK from player to avoid loops)
      syncChannel.post({
        type: 'SYNC_PONG',
        payload: {
          trackId: fileRecord.id,
          state: autoPlay ? 'playing' : 'paused',
          currentTime: 0,
          duration: 0,
          volume,
          muted: isMuted,
          loop: isLooping,
        },
      });

      if (videoRef.current) {
        videoRef.current.src = blobUrl;
        videoRef.current.load();

        if (autoPlay) {
          const playPromise = videoRef.current.play();
          if (playPromise !== undefined) {
            playPromise
              .then(() => {
                setIsPlaying(true);
                syncChannel.post({ type: 'STATE_CHANGE', payload: { state: 'playing' } });
              })
              .catch((playErr) => {
                console.warn('Autoplay prevented, attempting muted fallback:', playErr);
                if (videoRef.current) {
                  videoRef.current.muted = true;
                  videoRef.current
                    .play()
                    .then(() => {
                      setIsPlaying(true);
                      syncChannel.post({ type: 'STATE_CHANGE', payload: { state: 'playing' } });
                    })
                    .catch(() => {
                      setIsPlaying(false);
                      syncChannel.post({ type: 'STATE_CHANGE', payload: { state: 'paused' } });
                    });
                }
              });
          }
        }
      }
    },
    [revokeCurrentUrl, updateMediaSession, volume, isMuted, isLooping]
  );

  // Load track by ID from IndexedDB or memory
  const loadTrackById = useCallback(
    async (trackId: string, autoPlay: boolean = true, directBlob?: Blob) => {
      // 1. If this exact track is already loaded in the video element, do NOT reload or restart
      if (
        (currentTrackRef.current?.id === trackId || lastLoadedTrackIdRef.current === trackId) &&
        videoRef.current?.src &&
        videoRef.current.src !== '' &&
        videoRef.current.src !== window.location.href
      ) {
        if (autoPlay && videoRef.current.paused) {
          videoRef.current.play().catch(() => {});
        }
        return;
      }

      // 2. Prevent concurrent duplicate load calls for the same track
      if (isLoadingTrackRef.current && lastLoadedTrackIdRef.current === trackId) {
        return;
      }

      isLoadingTrackRef.current = true;
      lastLoadedTrackIdRef.current = trackId;
      setErrorMessage(null);
      setNeedsPermission(false);

      try {
        let fileRecord = await getMediaFile(trackId);
        let mediaBlob: Blob | null = directBlob || null;

        // 1. Direct blob fallback or local memory registry
        if (!mediaBlob) {
          const localMem = getMemoryFile(trackId);
          if (localMem?.file) {
            mediaBlob = localMem.file;
          }
        }

        // 2. Synchronous opener / parent window lookup (INSTANT cross-window memory sharing)
        if (!mediaBlob && typeof window !== 'undefined') {
          try {
            const hostWin =
              window.opener && !window.opener.closed
                ? window.opener
                : window.parent !== window
                ? window.parent
                : null;
            if (hostWin) {
              const hostGet = (hostWin as any).__PWA_GET_MEMORY_FILE__;
              const hostEntry = hostGet ? hostGet(trackId) : null;
              if (hostEntry?.file) {
                const foundBlob: Blob = hostEntry.file;
                mediaBlob = foundBlob;
                registerMemoryFile(trackId, foundBlob, hostEntry.handle);
                persistBinaryBlob(trackId, foundBlob).catch(() => {});
              } else {
                const activeBlob = (hostWin as any).__PWA_ACTIVE_MEDIA_BLOB__;
                const activeTrackId = (hostWin as any).__PWA_ACTIVE_TRACK_ID__;
                if (activeBlob && (!trackId || activeTrackId === trackId)) {
                  const foundBlob: Blob = activeBlob;
                  mediaBlob = foundBlob;
                  registerMemoryFile(trackId, foundBlob);
                  persistBinaryBlob(trackId, foundBlob).catch(() => {});
                } else {
                  const hostRegistry = (hostWin as any).__PWA_MEMORY_REGISTRY__;
                  if (hostRegistry && hostRegistry.get) {
                    const regEntry = hostRegistry.get(trackId);
                    if (regEntry?.file) {
                      const foundBlob: Blob = regEntry.file;
                      mediaBlob = foundBlob;
                      registerMemoryFile(trackId, foundBlob, regEntry.handle);
                      persistBinaryBlob(trackId, foundBlob).catch(() => {});
                    }
                  }
                }
              }
            }
          } catch (openerErr) {
            console.warn('Could not read file from opener window:', openerErr);
          }
        }

        // 3. Direct blob fallback (if stored in record, OPFS, Cache Storage, or IndexedDB)
        if (!mediaBlob) {
          if (fileRecord?.blobFallback) {
            mediaBlob = fileRecord.blobFallback;
          } else {
            mediaBlob = (await retrieveBinaryBlob(trackId)) || null;
          }
        }

        if (mediaBlob) {
          if (!fileRecord) {
            fileRecord = {
              id: trackId,
              name: 'Media Track',
              mimeType: mediaBlob.type || 'video/mp4',
              size: mediaBlob.size,
              lastModified: Date.now(),
              createdAt: Date.now(),
              blobFallback: mediaBlob,
            };
          }
          registerMemoryFile(trackId, mediaBlob);

          // If the requested track is already loaded in the video element, simply unpause if needed
          if (
            (currentTrackRef.current?.id === trackId || lastLoadedTrackIdRef.current === trackId) &&
            videoRef.current?.src &&
            videoRef.current.src !== '' &&
            videoRef.current.src !== window.location.href
          ) {
            if (autoPlay && videoRef.current.paused) {
              videoRef.current.play().catch(() => {});
            }
            isLoadingTrackRef.current = false;
            return;
          }

          playMediaBlob(fileRecord, mediaBlob, autoPlay);
          isLoadingTrackRef.current = false;
          return;
        }

        // 4. Request data from controller tab via BroadcastChannel & opener postMessage
        syncChannel.post({
          type: 'REQUEST_TRACK_DATA',
          payload: { trackId },
        });
        if (typeof window !== 'undefined' && window.opener && !window.opener.closed) {
          try {
            window.opener.postMessage({
              type: 'REQUEST_TRACK_DATA',
              payload: { trackId },
            }, '*');
          } catch {}
        }

        // 5. If no blob fallback, try FileSystemFileHandle
        if (fileRecord?.handle) {
          try {
            // @ts-expect-error queryPermission mode check
            const permStatus = await fileRecord.handle.queryPermission({ mode: 'read' });
            if (permStatus === 'granted') {
              mediaBlob = await fileRecord.handle.getFile();
              registerMemoryFile(trackId, mediaBlob, fileRecord.handle);
              playMediaBlob(fileRecord, mediaBlob, autoPlay);
              return;
            }
          } catch (permErr: unknown) {
            console.warn('File handle query failed:', permErr);
          }
        }

        // 6. Check stored directory handles
        const dirHandles = await getAllDirectoryHandles();
        if (dirHandles.length > 0) {
          for (const dirHandle of dirHandles) {
            try {
              // @ts-expect-error queryPermission mode check
              const dirPerm = await dirHandle.queryPermission({ mode: 'read' });
              if (dirPerm === 'granted') {
                await relinkFolderHandles(dirHandle);
                const refreshed = await getMediaFile(trackId);
                if (refreshed?.handle) {
                  mediaBlob = await refreshed.handle.getFile();
                  registerMemoryFile(trackId, mediaBlob, refreshed.handle);
                  playMediaBlob(refreshed, mediaBlob, autoPlay);
                  return;
                }
              }
            } catch {}
          }
        }

        // Wait up to 3500ms for controller tab to respond with blob or persist to Cache/DB
        for (let i = 0; i < 20; i++) {
          if (
            currentTrackRef.current?.id === trackId &&
            videoRef.current?.src &&
            videoRef.current.src !== '' &&
            videoRef.current.src !== window.location.href &&
            !videoRef.current.ended
          ) {
            return;
          }

          await new Promise((resolve) => setTimeout(resolve, 175));

          // Check opener during wait
          if (typeof window !== 'undefined') {
            try {
              const hostWin =
                window.opener && !window.opener.closed
                  ? window.opener
                  : window.parent !== window
                  ? window.parent
                  : null;
              if (hostWin) {
                const hostGet = (hostWin as any).__PWA_GET_MEMORY_FILE__;
                const hostEntry = hostGet ? hostGet(trackId) : null;
                if (hostEntry?.file) {
                  registerMemoryFile(trackId, hostEntry.file, hostEntry.handle);
                } else {
                  const activeBlob = (hostWin as any).__PWA_ACTIVE_MEDIA_BLOB__;
                  const activeId = (hostWin as any).__PWA_ACTIVE_TRACK_ID__;
                  if (activeBlob && (!trackId || activeId === trackId)) {
                    registerMemoryFile(trackId, activeBlob);
                  }
                }
              }
            } catch {}
          }

          const checkMem = getMemoryFile(trackId);
          if (checkMem?.file) {
            setNeedsPermission(false);
            playMediaBlob(
              fileRecord || {
                id: trackId,
                name: 'Media Track',
                mimeType: checkMem.file.type || 'video/mp4',
                size: checkMem.file.size,
                lastModified: Date.now(),
                createdAt: Date.now(),
                blobFallback: checkMem.file,
              },
              checkMem.file,
              autoPlay
            );
            return;
          }

          // Check persistent storage layers (IndexedDB media_blobs / Cache Storage / OPFS)
          const storedBlob = await retrieveBinaryBlob(trackId);
          if (storedBlob) {
            setNeedsPermission(false);
            playMediaBlob(
              fileRecord || {
                id: trackId,
                name: 'Media Track',
                mimeType: storedBlob.type || 'video/mp4',
                size: storedBlob.size,
                lastModified: Date.now(),
                createdAt: Date.now(),
                blobFallback: storedBlob,
              },
              storedBlob,
              autoPlay
            );
            return;
          }

          // Resend request at midpoint if not yet resolved
          if (i === 5 || i === 12) {
            syncChannel.post({
              type: 'REQUEST_TRACK_DATA',
              payload: { trackId },
            });
            if (typeof window !== 'undefined' && window.opener && !window.opener.closed) {
              try {
                window.opener.postMessage({
                  type: 'REQUEST_TRACK_DATA',
                  payload: { trackId },
                }, '*');
              } catch {}
            }
          }
        }

        // If still no blob after grace window, prompt user for gesture authorization
        setPendingTrack({ trackId, autoPlay });
        setNeedsPermission(true);
        setIsPlaying(false);
      } catch (err: unknown) {
        console.error('Error loading track:', err);
        setIsPlaying(false);
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load video file.');
        syncChannel.post({ type: 'STATE_CHANGE', payload: { state: 'idle' } });
      } finally {
        isLoadingTrackRef.current = false;
      }
    },
    [playMediaBlob]
  );

  // Handle direct file input fallback for environments where directory picker is restricted
  const handleRelinkChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    let trackToLoad = pendingTrack || (currentTrack ? { trackId: currentTrack.id, autoPlay: true } : null);
    if (!trackToLoad) {
      const initial = getActivePlaybackState();
      if (initial.trackId) {
        trackToLoad = { trackId: initial.trackId, autoPlay: true };
      }
    }

    const allFiles = Array.from(files);
    const existingFiles = await getAllMediaFiles();
    const existingByName = new Map<string, MediaFile>();
    for (const ef of existingFiles) {
      existingByName.set(ef.name.toLowerCase(), ef);
      if (ef.relativePath) {
        existingByName.set(ef.relativePath.toLowerCase(), ef);
      }
    }

    let matchedFile: File | null = null;
    let targetRec: MediaFile | null = null;

    for (const f of allFiles) {
      const relPath = (f as any).webkitRelativePath || f.name;
      const matched = existingByName.get(relPath.toLowerCase()) || existingByName.get(f.name.toLowerCase());

      if (matched) {
        matched.blobFallback = f;
        matched.size = f.size;
        matched.lastModified = f.lastModified;
        registerMemoryFile(matched.id, f);
        await saveMediaFile(matched);

        if (trackToLoad && matched.id === trackToLoad.trackId) {
          matchedFile = f;
          targetRec = matched;
        }
      } else {
        const id = generateUUID();
        registerMemoryFile(id, f);
        const newRec: MediaFile = {
          id,
          name: f.name,
          relativePath: relPath,
          mimeType: f.type || 'video/mp4',
          size: f.size,
          lastModified: f.lastModified,
          createdAt: Date.now(),
          blobFallback: f,
        };
        await saveMediaFile(newRec);

        if (!targetRec) {
          targetRec = newRec;
          matchedFile = f;
        }
      }
    }

    // If single file selected and no specific name matched, associate with pending track
    if (!matchedFile && allFiles.length === 1 && trackToLoad) {
      const singleFile = allFiles[0];
      const rec = await getMediaFile(trackToLoad.trackId);
      if (rec) {
        rec.blobFallback = singleFile;
        registerMemoryFile(rec.id, singleFile);
        await saveMediaFile(rec);
        matchedFile = singleFile;
        targetRec = rec;
      }
    }

    if (matchedFile && targetRec) {
      setNeedsPermission(false);
      setPendingTrack(null);
      setErrorMessage(null);
      playMediaBlob(targetRec, matchedFile, trackToLoad?.autoPlay ?? true);
    }
  };

  // Authorize Disk Access on user gesture
  const handleAuthorizeDiskAccess = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    
    // Prioritize pendingTrack if it exists, otherwise use currentTrack or localStorage
    let trackToLoad = pendingTrack || (currentTrack ? { trackId: currentTrack.id, autoPlay: true } : null);
    if (!trackToLoad) {
      const initial = getActivePlaybackState();
      if (initial.trackId) {
        trackToLoad = { trackId: initial.trackId, autoPlay: true };
      }
    }

    // Send inter-tab request immediately if we have a track
    if (trackToLoad?.trackId) {
      syncChannel.post({
        type: 'REQUEST_TRACK_DATA',
        payload: { trackId: trackToLoad.trackId },
      });
    }
    
    try {
      // 1. Check stored directory handles to authorize entire folder access at once (covers ALL videos)
      const dirHandles = await getAllDirectoryHandles();
      for (const dirHandle of dirHandles) {
        try {
          // @ts-expect-error requestPermission mode check
          const dirStatus = await dirHandle.requestPermission({ mode: 'read' });
          if (dirStatus === 'granted') {
            await relinkFolderHandles(dirHandle);
            setNeedsPermission(false);
            setPendingTrack(null);
            setErrorMessage(null);
            if (trackToLoad?.trackId) {
              await loadTrackById(trackToLoad.trackId, trackToLoad.autoPlay ?? true);
            }
            return;
          }
        } catch (dirPermErr) {
          console.warn('Directory permission request error:', dirPermErr);
        }
      }

      // 2. Check direct file handle fallback if no directory handle was stored
      if (trackToLoad?.trackId) {
        const fileRecord = await getMediaFile(trackToLoad.trackId);
        if (fileRecord?.handle) {
          try {
            // @ts-expect-error requestPermission mode check
            const res = await fileRecord.handle.requestPermission({ mode: 'read' });
            if (res === 'granted') {
              const file = await fileRecord.handle.getFile();
              registerMemoryFile(fileRecord.id, file, fileRecord.handle);
              persistBinaryBlob(fileRecord.id, file).catch(() => {});
              setNeedsPermission(false);
              setPendingTrack(null);
              setErrorMessage(null);
              await loadTrackById(trackToLoad.trackId, trackToLoad.autoPlay ?? true, file);
              return;
            }
          } catch (handlePermErr) {
            console.warn('Direct handle requestPermission failed:', handlePermErr);
          }
        }
      }

      // 3. Fallback: prompt the browser's native folder picker to re-link and authorize the media library
      if ('showDirectoryPicker' in window && !isInsideIframe()) {
        try {
          // @ts-expect-error showDirectoryPicker
          const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
          if (dirHandle) {
            await relinkFolderHandles(dirHandle);
            setNeedsPermission(false);
            setPendingTrack(null);
            setErrorMessage(null);
            if (trackToLoad?.trackId) {
              await loadTrackById(trackToLoad.trackId, trackToLoad.autoPlay ?? true);
            }
            return;
          }
        } catch (dirErr: any) {
          if (dirErr?.name === 'AbortError') {
            return;
          }
          console.warn('showDirectoryPicker fallback error:', dirErr);
        }
      }

      // 4. Universal folder re-link picker (works 100% in all iframes and all browsers!)
      const relinkRes = await pickFolderToRelink();
      if (relinkRes.matched > 0) {
        setNeedsPermission(false);
        setPendingTrack(null);
        setErrorMessage(null);
        if (trackToLoad?.trackId) {
          const matched = relinkRes.matchedFiles.find((m) => m.id === trackToLoad!.trackId);
          if (matched && matched.blobFallback) {
            playMediaBlob(matched, matched.blobFallback, trackToLoad.autoPlay ?? true);
          } else {
            await loadTrackById(trackToLoad.trackId, trackToLoad.autoPlay ?? true);
          }
        } else if (relinkRes.matchedFiles.length > 0 && relinkRes.matchedFiles[0].blobFallback) {
          playMediaBlob(relinkRes.matchedFiles[0], relinkRes.matchedFiles[0].blobFallback, true);
        }
        return;
      } else if (relinkRes.total > 0) {
        setErrorMessage(`Selected folder had no filenames matching the catalog. Try picking individual video files.`);
        return;
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      console.warn('Permission request error:', err);
      setErrorMessage('Authorization was not completed. Click "Select Videos Folder" to try again.');
    }
  };

  // Direct video file re-link on user gesture
  const handleAuthorizeFileDirect = async () => {
    let trackToLoad = pendingTrack || (currentTrack ? { trackId: currentTrack.id, autoPlay: true } : null);
    if (!trackToLoad) {
      const initial = getActivePlaybackState();
      if (initial.trackId) {
        trackToLoad = { trackId: initial.trackId, autoPlay: true };
      }
    }
    const targetId = trackToLoad?.trackId;

    try {
      const res = await pickFilesToRelink();
      if (res.matched > 0) {
        setNeedsPermission(false);
        setPendingTrack(null);
        setErrorMessage(null);
        if (targetId) {
          const matched = res.matchedFiles.find((m) => m.id === targetId);
          if (matched && matched.blobFallback) {
            playMediaBlob(matched, matched.blobFallback, trackToLoad?.autoPlay ?? true);
          } else {
            loadTrackById(targetId, trackToLoad?.autoPlay ?? true);
          }
        } else if (res.matchedFiles.length > 0 && res.matchedFiles[0].blobFallback) {
          playMediaBlob(res.matchedFiles[0], res.matchedFiles[0].blobFallback, true);
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        console.warn('File re-link error:', e);
      }
    }
  };

  // Picture-in-Picture toggle with cross-browser WebKit support
  const togglePiP = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPiP(false);
        syncChannel.post({ type: 'PIP_CHANGE', payload: { active: false } });
      } else if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
        await video.requestPictureInPicture();
        setIsPiP(true);
        syncChannel.post({ type: 'PIP_CHANGE', payload: { active: true } });
      } else if ((video as any).webkitSupportsPresentationMode && typeof (video as any).webkitSetPresentationMode === 'function') {
        const currentMode = (video as any).webkitPresentationMode;
        const newMode = currentMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture';
        (video as any).webkitSetPresentationMode(newMode);
        setIsPiP(newMode === 'picture-in-picture');
        syncChannel.post({ type: 'PIP_CHANGE', payload: { active: newMode === 'picture-in-picture' } });
      }
    } catch (err) {
      console.warn('PiP toggle error:', err);
    }
  }, []);

  // Previous and Next Track Handlers for pop-out tab
  const handlePlayPrev = useCallback(async () => {
    // 1. Post to syncChannel so ControllerView handles it if connected
    syncChannel.post({ type: 'PREV_TRACK' });

    // 2. If more than 3 seconds in, seek to beginning (standard player convention)
    if (videoRef.current && videoRef.current.currentTime > 3) {
      videoRef.current.currentTime = 0;
      return;
    }

    // 3. Fallback / autonomous handling if ControllerView is not active:
    const queue = getStoredQueue();
    const currentId = currentTrackRef.current?.id;
    if (queue.length > 0) {
      const curIdx = currentId ? queue.indexOf(currentId) : -1;
      let prevIdx = curIdx > 0 ? curIdx - 1 : queue.length - 1;
      const prevId = queue[prevIdx];
      if (prevId && prevId !== currentId) {
        loadTrackById(prevId, true);
        return;
      }
    }

    // 4. If queue is empty, check all media files in database:
    try {
      const allFiles = await getAllMediaFiles();
      if (allFiles.length > 1) {
        const curIdx = currentId ? allFiles.findIndex((f) => f.id === currentId) : -1;
        let prevIdx = curIdx > 0 ? curIdx - 1 : allFiles.length - 1;
        const target = allFiles[prevIdx];
        if (target && target.id !== currentId) {
          loadTrackById(target.id, true);
        }
      }
    } catch {}
  }, [loadTrackById]);

  const handlePlayNext = useCallback(async () => {
    // 1. Post to syncChannel so ControllerView handles it if connected
    syncChannel.post({ type: 'NEXT_TRACK' });

    // 2. Fallback / autonomous handling if ControllerView is not active:
    const queue = getStoredQueue();
    const currentId = currentTrackRef.current?.id;
    if (queue.length > 0) {
      const curIdx = currentId ? queue.indexOf(currentId) : -1;
      let nextIdx = curIdx + 1 < queue.length ? curIdx + 1 : 0;
      const nextId = queue[nextIdx];
      if (nextId && nextId !== currentId) {
        loadTrackById(nextId, true);
        return;
      }
    }

    // 3. If queue is empty, check all media files in database:
    try {
      const allFiles = await getAllMediaFiles();
      if (allFiles.length > 1) {
        const curIdx = currentId ? allFiles.findIndex((f) => f.id === currentId) : -1;
        let nextIdx = curIdx + 1 < allFiles.length ? curIdx + 1 : 0;
        const target = allFiles[nextIdx];
        if (target && target.id !== currentId) {
          loadTrackById(target.id, true);
        }
      }
    } catch {}
  }, [loadTrackById]);

  useEffect(() => {
    handlePlayPrevRef.current = handlePlayPrev;
    handlePlayNextRef.current = handlePlayNext;
  }, [handlePlayPrev, handlePlayNext]);

  // Fullscreen Toggle
  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  }, []);

  // Global Keyboard Shortcuts (Space, J, L, P, N, I, F, M)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) {
        return;
      }

      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          if (videoRef.current) {
            if (videoRef.current.paused) videoRef.current.play().catch(() => {});
            else videoRef.current.pause();
          }
          break;

        case 'ArrowLeft':
        case 'j':
        case 'J':
          e.preventDefault();
          if (videoRef.current) {
            const newTime = Math.max(0, videoRef.current.currentTime - 5);
            videoRef.current.currentTime = newTime;
            syncChannel.post({ type: 'SEEK_TO', payload: { time: newTime } });
          }
          break;

        case 'ArrowRight':
        case 'l':
        case 'L':
          e.preventDefault();
          if (videoRef.current) {
            const newTime = Math.min(videoRef.current.duration || 0, videoRef.current.currentTime + 5);
            videoRef.current.currentTime = newTime;
            syncChannel.post({ type: 'SEEK_TO', payload: { time: newTime } });
          }
          break;

        case 'p':
        case 'P':
        case '<':
          e.preventDefault();
          handlePlayPrev();
          break;

        case 'n':
        case 'N':
        case '>':
          e.preventDefault();
          handlePlayNext();
          break;

        case 'i':
        case 'I':
          e.preventDefault();
          togglePiP();
          break;

        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;

        case 'm':
        case 'M':
          e.preventDefault();
          if (videoRef.current) {
            const newMuted = !isMuted;
            videoRef.current.muted = newMuted;
            setIsMuted(newMuted);
            setVolumeState(volume, newMuted);
            syncChannel.post({ type: 'SET_VOLUME', payload: { volume, muted: newMuted } });
          }
          break;

        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handlePlayPrev, handlePlayNext, togglePiP, toggleFullscreen, isMuted, volume]);

  // Initialize playback state from localStorage on mount (run exactly once)
  useEffect(() => {
    if (hasMountedRef.current) return;
    hasMountedRef.current = true;

    const initial = getActivePlaybackState();
    const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    let targetTrackId = urlParams?.get('trackId') || initial.trackId;

    if (!targetTrackId && typeof window !== 'undefined' && window.opener && !window.opener.closed) {
      try {
        targetTrackId = (window.opener as any).__PWA_ACTIVE_TRACK_ID__;
      } catch {}
    }

    setVolume(initial.volume);
    setIsMuted(initial.muted);

    if (videoRef.current) {
      videoRef.current.volume = initial.volume;
      videoRef.current.muted = initial.muted;
    }

    const initLoad = async () => {
      let resolvedId = targetTrackId;
      if (!resolvedId) {
        try {
          const allFiles = await getAllMediaFiles();
          if (allFiles.length > 0) {
            resolvedId = allFiles[0].id;
          }
        } catch {}
      }

      if (resolvedId) {
        loadTrackById(resolvedId, true);
        syncChannel.post({
          type: 'REQUEST_TRACK_DATA',
          payload: { trackId: resolvedId },
        });
        if (typeof window !== 'undefined' && window.opener && !window.opener.closed) {
          try {
            window.opener.postMessage(
              {
                type: 'REQUEST_TRACK_DATA',
                payload: { trackId: resolvedId },
              },
              '*'
            );
          } catch {}
        }
      } else {
        syncChannel.post({
          type: 'SYNC_PING',
        });
      }
    };

    initLoad();

    // Broadcast readiness and connection to controller
    syncChannel.post({ type: 'PLAYER_CONNECTED', payload: { isPopout: !embedded } });
    if (typeof window !== 'undefined' && window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage({ type: 'PLAYER_CONNECTED', payload: { isPopout: !embedded } }, '*');
      } catch {}
    }

    syncChannel.post({
      type: 'SYNC_PONG',
      payload: {
        trackId: targetTrackId || initial.trackId,
        state: 'idle',
        currentTime: 0,
        duration: 0,
        volume: initial.volume,
        muted: initial.muted,
        loop: initial.loop ?? false,
      },
    });

    const videoEl = videoRef.current;
    const handleEnterPiP = () => {
      setIsPiP(true);
      syncChannel.post({ type: 'PIP_CHANGE', payload: { active: true } });
    };
    const handleLeavePiP = () => {
      setIsPiP(false);
      syncChannel.post({ type: 'PIP_CHANGE', payload: { active: false } });
    };

    if (videoEl) {
      videoEl.addEventListener('enterpictureinpicture', handleEnterPiP);
      videoEl.addEventListener('leavepictureinpicture', handleLeavePiP);
    }

    return () => {
      syncChannel.post({ type: 'PLAYER_DISCONNECTED', payload: { isPopout: !embedded } });
      if (typeof window !== 'undefined' && window.opener && !window.opener.closed) {
        try {
          window.opener.postMessage({ type: 'PLAYER_DISCONNECTED', payload: { isPopout: !embedded } }, '*');
        } catch {}
      }
      if (videoEl) {
        videoEl.removeEventListener('enterpictureinpicture', handleEnterPiP);
        videoEl.removeEventListener('leavepictureinpicture', handleLeavePiP);
      }
      revokeCurrentUrl();
    };
  }, []);

  // BroadcastChannel message router
  useEffect(() => {
    const unsubscribe = syncChannel.subscribe((msg: SyncMessage) => {
      switch (msg.type) {
        case 'LOAD_TRACK':
          if (embedded && isExternalActiveRef.current) return;
          loadTrackById(msg.payload.trackId, msg.payload.autoPlay ?? true, msg.payload.blob);
          break;

        case 'PROVIDE_TRACK_DATA': {
          const { trackId, blob, mimeType, name } = msg.payload;
          if (blob) {
            setNeedsPermission(false);
            setErrorMessage(null);
            registerMemoryFile(trackId, blob);
            const fileRec: MediaFile = {
              id: trackId,
              name: name || 'Media Track',
              mimeType: mimeType || blob.type || 'video/mp4',
              size: blob.size,
              lastModified: Date.now(),
              createdAt: Date.now(),
              blobFallback: blob,
            };
            getMediaFile(trackId).then((existing) => {
              if (existing) {
                existing.blobFallback = blob;
                saveMediaFile(existing);
              } else {
                saveMediaFile(fileRec);
              }
            });

            const isAlreadyLoaded =
              currentTrackRef.current?.id === trackId &&
              videoRef.current?.src &&
              videoRef.current.src !== '' &&
              videoRef.current.src !== window.location.href;

            if (!isAlreadyLoaded) {
              if (!embedded || !isExternalActiveRef.current) {
                playMediaBlob(fileRec, blob, pendingTrack?.autoPlay ?? true);
              }
            }
          }
          break;
        }

        case 'PLAY':
          if (embedded && isExternalActiveRef.current) return;
          if (videoRef.current) {
            if (!videoRef.current.src || videoRef.current.src === window.location.href || videoRef.current.src === '') {
              const state = getActivePlaybackState();
              if (state.trackId) {
                loadTrackById(state.trackId, true);
              }
            } else {
              videoRef.current.play().catch((err) => {
                console.warn('Play triggered failed, attempting muted playback:', err);
                if (videoRef.current) {
                  videoRef.current.muted = true;
                  videoRef.current
                    .play()
                    .then(() => {
                      setIsPlaying(true);
                      syncChannel.post({ type: 'STATE_CHANGE', payload: { state: 'playing' } });
                    })
                    .catch(() => {});
                }
              });
            }
          }
          break;

        case 'PAUSE':
          videoRef.current?.pause();
          break;

        case 'SEEK_TO':
          if (videoRef.current && Number.isFinite(msg.payload.time)) {
            videoRef.current.currentTime = msg.payload.time;
          }
          break;

        case 'SET_VOLUME':
          if (videoRef.current) {
            videoRef.current.volume = msg.payload.volume;
            videoRef.current.muted = msg.payload.muted;
          }
          setVolume(msg.payload.volume);
          setIsMuted(msg.payload.muted);
          setVolumeState(msg.payload.volume, msg.payload.muted);
          break;

        case 'TOGGLE_PIP':
          togglePiP();
          break;

        case 'SET_LOOP':
          setIsLooping(msg.payload.loop);
          setLoopSetting(msg.payload.loop);
          break;

        case 'SET_FIT_MODE':
          if (msg.payload.fitMode) {
            setFitMode(msg.payload.fitMode);
          }
          break;

        case 'BRING_PLAYBACK_HERE':
          if (!embedded) {
            videoRef.current?.pause();
            setIsPlaying(false);
            syncChannel.post({ type: 'STATE_CHANGE', payload: { state: 'paused' } });
          } else {
            const state = getActivePlaybackState();
            const targetId = state.trackId || currentTrack?.id;
            if (targetId) {
              loadTrackById(targetId, true);
            }
          }
          break;

        case 'SYNC_PING':
          if (embedded && isExternalActiveRef.current) return;
          if (videoRef.current) {
            const hasSource = Boolean(videoRef.current.src && videoRef.current.src !== window.location.href);
            const isTrulyPlaying = Boolean(
              hasSource &&
              !videoRef.current.paused &&
              !videoRef.current.ended &&
              videoRef.current.readyState >= 2
            );
            const reportedState = isTrulyPlaying
              ? 'playing'
              : (hasSource && !videoRef.current.ended ? 'paused' : 'idle');

            syncChannel.post({
              type: 'SYNC_PONG',
              payload: {
                trackId: currentTrackRef.current?.id || null,
                state: reportedState,
                currentTime: videoRef.current.currentTime || 0,
                duration: videoRef.current.duration || 0,
                volume: videoRef.current.volume,
                muted: videoRef.current.muted,
                loop: isLooping,
              },
            });
          }
          break;

        default:
          break;
      }
    });

    return () => {
      unsubscribe();
    };
  }, [loadTrackById, togglePiP, embedded]);

  // Direct postMessage bridge for window.opener <-> popout window communication
  useEffect(() => {
    const handleDirectMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'LOAD_TRACK' && data.payload?.trackId) {
        if (embedded && isExternalActiveRef.current) return;
        loadTrackById(data.payload.trackId, data.payload.autoPlay ?? true, data.payload.blob);
      } else if (data.type === 'PROVIDE_TRACK_DATA' && data.payload?.blob) {
        const { trackId, blob, mimeType, name } = data.payload;
        registerMemoryFile(trackId, blob);
        setNeedsPermission(false);
        setErrorMessage(null);

        const fileRec: MediaFile = {
          id: trackId,
          name: name || 'Media Track',
          mimeType: mimeType || blob.type || 'video/mp4',
          size: blob.size,
          lastModified: Date.now(),
          createdAt: Date.now(),
          blobFallback: blob,
        };

        const isAlreadyLoaded =
          currentTrackRef.current?.id === trackId &&
          videoRef.current?.src &&
          videoRef.current.src !== '' &&
          videoRef.current.src !== window.location.href;

        if (!isAlreadyLoaded) {
          if (!embedded || !isExternalActiveRef.current) {
            playMediaBlob(fileRec, blob, true);
          }
        }
      } else if (data.type === 'PLAY') {
        if (embedded && isExternalActiveRef.current) return;
        videoRef.current?.play().catch(() => {});
      } else if (data.type === 'PAUSE') {
        videoRef.current?.pause();
      } else if (data.type === 'SEEK_TO' && Number.isFinite(data.payload?.time)) {
        if (videoRef.current) videoRef.current.currentTime = data.payload.time;
      } else if (data.type === 'SET_VOLUME') {
        if (videoRef.current) {
          videoRef.current.volume = data.payload.volume;
          videoRef.current.muted = data.payload.muted;
        }
      }
    };

    window.addEventListener('message', handleDirectMessage);
    return () => {
      window.removeEventListener('message', handleDirectMessage);
    };
  }, [loadTrackById, playMediaBlob, embedded]);

  // Video HTML5 event bindings
  const onTimeUpdate = () => {
    if (embedded && isExternalActiveRef.current) return;
    if (!videoRef.current) return;
    const cur = videoRef.current.currentTime;
    const dur = videoRef.current.duration || 0;
    setCurrentTime(cur);
    setDuration(dur);

    const now = performance.now();
    if (now - lastTimeSentRef.current > 250) {
      lastTimeSentRef.current = now;
      syncChannel.post({
        type: 'TIME_UPDATE',
        payload: {
          currentTime: cur,
          duration: dur,
        },
      });
      setLastPlaybackTime(cur);
    }
  };

  const onPlay = () => {
    if (embedded && isExternalActiveRef.current) return;
    setIsPlaying(true);
  };

  const onPlaying = () => {
    if (embedded && isExternalActiveRef.current) return;
    setIsPlaying(true);
    setIsBuffering(false);
    syncChannel.post({ type: 'STATE_CHANGE', payload: { state: 'playing' } });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
  };

  const onPause = () => {
    if (embedded && isExternalActiveRef.current) return;
    if (!videoRef.current || videoRef.current.paused) {
      setIsPlaying(false);
      setIsBuffering(false);
      syncChannel.post({ type: 'STATE_CHANGE', payload: { state: 'paused' } });
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
    }
  };

  const onWaiting = () => {
    setIsBuffering(true);
    syncChannel.post({ type: 'STATE_CHANGE', payload: { state: 'buffering' } });
  };

  const onEnded = () => {
    if (isLooping) {
      if (videoRef.current) {
        videoRef.current.currentTime = 0;
        videoRef.current.play().catch(() => {});
      }
      return;
    }
    setIsPlaying(false);
    syncChannel.post({
      type: 'STATE_CHANGE',
      payload: { state: 'idle' },
    });

    if (currentTrack) {
      syncChannel.post({
        type: 'TRACK_ENDED',
        payload: { trackId: currentTrack.id },
      });
    }
  };

  // Mouse idle HUD auto-hide
  const handleMouseMove = () => {
    setShowHud(true);
    if (hudTimeoutRef.current) {
      window.clearTimeout(hudTimeoutRef.current);
    }
    hudTimeoutRef.current = window.setTimeout(() => {
      if (isPlaying) {
        setShowHud(false);
      }
    }, 2500);
  };

  const formatTime = (secs: number) => {
    if (!Number.isFinite(secs) || secs < 0) return '00:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div
      ref={containerRef}
      id="pwa-player-container"
      onMouseMove={handleMouseMove}
      className={`w-full h-full bg-black overflow-hidden flex items-center justify-center select-none ${
        embedded ? 'relative rounded-2xl border border-neutral-800' : 'fixed inset-0 z-40'
      }`}
    >
      {/* If embedded and external window active, display overlay on top without tearing down video element */}
      {embedded && isExternalActive && (
        <div
          id="pwa-player-container-external"
          className="absolute inset-0 z-30 bg-neutral-950 flex flex-col items-center justify-center p-6 text-center select-none"
        >
          <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 mb-3 shadow-xl">
            <ExternalLink className="w-7 h-7 animate-pulse" />
          </div>
          <h3 className="text-sm font-bold text-white tracking-tight">Playing in Dedicated Tab</h3>
          <p className="mt-1 text-xs text-neutral-400 max-w-xs truncate font-medium">
            {currentTrack ? currentTrack.name : 'Popout Player Active'}
          </p>
          <p className="mt-2 text-[11px] text-neutral-500 max-w-xs">
            Playback is running in your dedicated video tab to prevent duplicate sound.
          </p>
          <div className="flex items-center gap-2.5 mt-5">
            <button
              onClick={() => syncChannel.focusPopoutWindow()}
              className="px-3.5 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs transition cursor-pointer shadow flex items-center gap-1.5 active:scale-95"
              title="Focus the popout window"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Focus Tab</span>
            </button>
            {onBringBack && (
              <button
                onClick={onBringBack}
                className="px-3.5 py-1.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 font-semibold text-xs transition cursor-pointer flex items-center gap-1.5 active:scale-95"
                title="Return playback to this split preview"
              >
                <Play className="w-3.5 h-3.5" />
                <span>Play Here</span>
              </button>
            )}
          </div>
        </div>
      )}
      {/* Native HTML5 Video Element */}
      <video
        ref={videoRef}
        id="pwa-main-video-element"
        playsInline
        loop={isLooping}
        onTimeUpdate={onTimeUpdate}
        onPlay={onPlay}
        onPause={onPause}
        onWaiting={onWaiting}
        onPlaying={onPlaying}
        onEnded={onEnded}
        onError={(e) => {
          console.warn('Video element playback error:', e);
          setIsPlaying(false);
          setIsBuffering(false);
          syncChannel.post({ type: 'STATE_CHANGE', payload: { state: 'idle' } });
        }}
        onClick={() => {
          if (videoRef.current) {
            if (videoRef.current.paused) {
              videoRef.current.play().catch((err) => {
                console.error('Click play failed:', err);
              });
            } else {
              videoRef.current.pause();
            }
          }
        }}
        className={`w-full h-full ${
          fitMode === 'cover' ? 'object-cover' : fitMode === 'fill' ? 'object-fill' : 'object-contain'
        } cursor-pointer transition-all duration-200`}
      />

      {/* Picture-in-Picture Active Badge */}
      {isPiP && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 bg-neutral-900/90 border border-neutral-700 text-white text-xs font-medium px-3.5 py-1.5 rounded-full shadow-lg flex items-center gap-1.5 pointer-events-none">
          <PictureInPicture2 className="w-3.5 h-3.5 text-amber-400" />
          <span>Picture-in-Picture Active</span>
        </div>
      )}

      {/* Fit Mode Notice Badge */}
      {fitModeNotice && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-30 bg-neutral-900/95 border border-amber-500/40 text-amber-300 text-xs font-semibold px-4 py-1.5 rounded-full shadow-2xl flex items-center gap-1.5 pointer-events-none transition">
          <Expand className="w-3.5 h-3.5" />
          <span>{fitModeNotice}</span>
        </div>
      )}

      {/* Buffering Spinner */}
      {isBuffering && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 pointer-events-none z-10">
          <RefreshCw className="w-10 h-10 text-white animate-spin" />
        </div>
      )}

      {/* Minimal Standby State (Clean, no useless branding) */}
      {!currentTrack && !needsPermission && !errorMessage && (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center z-10 pointer-events-none">
          <div className="w-14 h-14 rounded-2xl bg-neutral-900 border border-neutral-800 flex items-center justify-center text-neutral-400 mb-3 shadow-xl">
            <Film className="w-7 h-7" />
          </div>
          <h2 className="text-base font-bold text-white tracking-tight">Standby</h2>
          <p className="mt-1 text-xs text-neutral-400">Select a video from the controller to start playback</p>
        </div>
      )}

      {/* Hidden File Input for Universal Fallback */}
      <input
        ref={relinkInputRef}
        type="file"
        accept="video/*"
        multiple
        onChange={handleRelinkChange}
        className="sr-only"
        style={{ position: 'fixed', top: '-9999px', left: '-9999px', opacity: 0 }}
      />

      {/* Disk Permission Recovery Prompt */}
      {needsPermission && (
        <div
          id="permission-recovery-prompt"
          className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/95 p-6 text-center"
        >
          <div className="w-14 h-14 rounded-2xl bg-neutral-900 border border-neutral-800 flex items-center justify-center text-amber-400 mb-3 shadow-xl">
            <Lock className="w-7 h-7" />
          </div>
          <h2 className="text-xl font-bold text-white">Browser Permission Required</h2>
          <p className="mt-1 text-xs text-neutral-400 max-w-md">
            Browser security requires direct user confirmation to access your video files. Select your videos folder or file once to restore playback across your entire catalog — without re-importing or losing playlists.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 mt-5">
            <button
              id="authorize-folder-access-btn"
              onClick={(e) => handleAuthorizeDiskAccess(e)}
              className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs transition active:scale-95 cursor-pointer shadow-lg flex items-center gap-2"
            >
              <FolderOpen className="w-4 h-4" />
              <span>Select Videos Folder</span>
            </button>
            <button
              id="authorize-file-access-btn"
              onClick={handleAuthorizeFileDirect}
              className="px-4 py-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-200 font-semibold text-xs transition active:scale-95 cursor-pointer flex items-center gap-2"
            >
              <Film className="w-4 h-4" />
              <span>Select Video File</span>
            </button>
          </div>
        </div>
      )}

      {/* Playback Error */}
      {errorMessage && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/95 p-6 text-center">
          <AlertCircle className="w-10 h-10 text-rose-500 mb-2" />
          <h3 className="text-sm font-semibold text-white">Playback Error</h3>
          <p className="mt-1 text-xs text-neutral-400 max-w-sm">{errorMessage}</p>
          <div className="flex flex-wrap items-center justify-center gap-2 mt-4">
            <button
              onClick={() => {
                setErrorMessage(null);
                if (pendingTrack) {
                  loadTrackById(pendingTrack.trackId, pendingTrack.autoPlay ?? true);
                } else if (currentTrack) {
                  loadTrackById(currentTrack.id, true);
                }
              }}
              className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs font-semibold text-white cursor-pointer"
            >
              Retry
            </button>
            <button
              onClick={(e) => handleAuthorizeDiskAccess(e)}
              className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-xs font-semibold cursor-pointer shadow flex items-center gap-1.5"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>Re-link Folder</span>
            </button>
            <button
              onClick={handleAuthorizeFileDirect}
              className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-semibold cursor-pointer border border-neutral-700 flex items-center gap-1.5"
            >
              <Film className="w-3.5 h-3.5" />
              <span>Re-link File</span>
            </button>
          </div>
        </div>
      )}

      {/* Floating Minimal HUD Overlay */}
      <div
        className={`absolute inset-0 pointer-events-none flex flex-col justify-between p-4 md:p-6 transition-opacity duration-300 z-20 ${
          showHud || !isPlaying ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* Top Header Bar */}
        <div className="flex items-center justify-between pointer-events-auto">
          <div className="flex items-center gap-2 bg-black/80 backdrop-blur-md border border-neutral-800 px-3 py-1.5 rounded-xl text-xs">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-semibold text-white">Player</span>
            {currentTrack && (
              <>
                <span className="text-neutral-600">•</span>
                <span className="text-neutral-300 font-medium text-xs truncate max-w-[220px]">
                  {currentTrack.name}
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Aspect Ratio / Fit Mode Button */}
            <button
              id="player-fit-mode-btn"
              onClick={cycleFitMode}
              className={`p-2 rounded-xl bg-black/80 hover:bg-neutral-900 border transition cursor-pointer ${
                fitMode !== 'contain'
                  ? 'border-amber-400 text-amber-400'
                  : 'border-neutral-800 text-neutral-300 hover:text-white'
              }`}
              title={`Aspect Ratio: ${fitMode.toUpperCase()} (Click to cycle Fit, Fill, Stretch)`}
            >
              <Expand className="w-4 h-4" />
            </button>

            {/* Picture-in-Picture Control */}
            {pipSupported && (
              <button
                id="player-pip-btn"
                onClick={togglePiP}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border transition cursor-pointer text-xs font-semibold ${
                  isPiP
                    ? 'bg-amber-500 text-black border-amber-400 shadow-md'
                    : 'bg-black/80 hover:bg-neutral-900 border-neutral-800 text-neutral-300 hover:text-white'
                }`}
                title={isPiP ? 'Exit Picture-in-Picture (I)' : 'Enter Picture-in-Picture (I)'}
              >
                <PictureInPicture2 className="w-4 h-4 text-amber-400" />
                <span>{isPiP ? 'Exit PiP' : 'PiP'}</span>
              </button>
            )}

            {embedded && (
              <button
                id="embedded-pop-out-btn"
                onClick={() => {
                  if (onOpenPopout) {
                    onOpenPopout();
                  } else {
                    const targetId = currentTrack?.id;
                    if (targetId) {
                      saveActivePlaybackState({ trackId: targetId, isPlaying: true });
                      syncChannel.post({ type: 'LOAD_TRACK', payload: { trackId: targetId, autoPlay: true } });
                    }
                    syncChannel.openPopoutWindow(targetId);
                  }
                }}
                className="flex items-center gap-1.5 bg-black/80 hover:bg-neutral-900 border border-neutral-800 px-3 py-1.5 rounded-xl text-xs font-medium text-neutral-300 hover:text-white transition cursor-pointer"
                title="Open player in a new browser tab"
              >
                <ExternalLink className="w-3.5 h-3.5 text-amber-400" />
                <span className="hidden sm:inline">Open in New Tab</span>
              </button>
            )}

            <button
              onClick={toggleFullscreen}
              className="p-2 rounded-xl bg-black/80 hover:bg-neutral-900 border border-neutral-800 text-neutral-300 hover:text-white transition cursor-pointer"
              title="Toggle Fullscreen"
            >
              {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Center Big Play Trigger */}
        {!isPlaying && currentTrack && !needsPermission && (
          <div className="self-center pointer-events-auto">
            <button
              onClick={() => {
                videoRef.current?.play().catch((err) => {
                  console.error('Central play failed:', err);
                });
              }}
              className="w-14 h-14 rounded-full bg-white text-black flex items-center justify-center shadow-2xl transition transform hover:scale-105 active:scale-95 cursor-pointer"
              title="Play"
            >
              <Play className="w-7 h-7 ml-0.5" fill="currentColor" />
            </button>
          </div>
        )}

        {/* Bottom Scrubber Overlay */}
        {currentTrack && (
          <div className={`bg-black/85 backdrop-blur-md border border-neutral-800 rounded-2xl pointer-events-auto shadow-2xl ${
            embedded ? 'p-2.5 sm:p-3 space-y-2' : 'p-4 space-y-3'
          }`}>
            <div className="flex items-center justify-between">
              <div className="min-w-0 pr-3">
                <h4 className="text-xs font-bold text-white truncate max-w-[220px]">{currentTrack.name}</h4>
              </div>

              <div className="flex items-center gap-1.5 sm:gap-2">
                {/* Previous Track Button */}
                <button
                  id="player-prev-track-btn"
                  onClick={handlePlayPrev}
                  className="p-1.5 sm:p-2 rounded-xl bg-neutral-800/90 hover:bg-neutral-700 text-neutral-300 hover:text-white transition cursor-pointer active:scale-95"
                  title="Previous Video (P)"
                >
                  <SkipBack className="w-3.5 h-3.5 sm:w-4 sm:h-4 fill-current" />
                </button>

                {/* Play/Pause Button */}
                <button
                  id="player-play-pause-btn"
                  onClick={() => {
                    if (videoRef.current) {
                      if (isPlaying) {
                        videoRef.current.pause();
                      } else {
                        videoRef.current.play().catch((err) => {
                          console.error('Manual play failed:', err);
                        });
                      }
                    }
                  }}
                  className="p-1.5 sm:p-2 rounded-xl bg-white text-black hover:bg-neutral-200 transition cursor-pointer active:scale-95 shadow-md"
                  title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" fill="currentColor" />}
                </button>

                {/* Next Track Button */}
                <button
                  id="player-next-track-btn"
                  onClick={handlePlayNext}
                  className="p-1.5 sm:p-2 rounded-xl bg-neutral-800/90 hover:bg-neutral-700 text-neutral-300 hover:text-white transition cursor-pointer active:scale-95"
                  title="Next Video (N)"
                >
                  <SkipForward className="w-3.5 h-3.5 sm:w-4 sm:h-4 fill-current" />
                </button>
              </div>

              <div className="flex items-center gap-2 sm:gap-2.5">
                {/* Loop Button */}
                <button
                  onClick={() => {
                    const nextLoop = !isLooping;
                    setIsLooping(nextLoop);
                    setLoopSetting(nextLoop);
                    syncChannel.post({
                      type: 'SET_LOOP',
                      payload: { loop: nextLoop },
                    });
                  }}
                  className={`p-1.5 rounded-lg border transition cursor-pointer ${
                    isLooping
                      ? 'bg-white text-black border-transparent'
                      : 'border-neutral-800 text-neutral-400 hover:text-white'
                  }`}
                  title={isLooping ? 'Disable Loop' : 'Enable Loop'}
                >
                  <Repeat className="w-3.5 h-3.5" />
                </button>

                {/* Picture-in-Picture Button */}
                {pipSupported && (
                  <button
                    id="player-bottom-pip-btn"
                    onClick={togglePiP}
                    className={`p-1.5 rounded-lg border transition cursor-pointer flex items-center gap-1 ${
                      isPiP
                        ? 'bg-amber-500 text-black border-amber-400 shadow-sm'
                        : 'border-neutral-800 text-neutral-300 hover:text-white hover:border-neutral-700 bg-neutral-900/80'
                    }`}
                    title={isPiP ? 'Exit Picture-in-Picture (I)' : 'Picture-in-Picture (I)'}
                  >
                    <PictureInPicture2 className="w-3.5 h-3.5" />
                    <span className="text-[11px] font-medium hidden md:inline">PiP</span>
                  </button>
                )}

                {/* Volume slider (Full view only) */}
                {!embedded && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        if (videoRef.current) {
                          videoRef.current.muted = !isMuted;
                          setIsMuted(!isMuted);
                          setVolumeState(volume, !isMuted);
                          syncChannel.post({
                            type: 'SET_VOLUME',
                            payload: { volume, muted: !isMuted },
                          });
                        }
                      }}
                      className="text-neutral-400 hover:text-white"
                      title={isMuted ? 'Unmute (M)' : 'Mute (M)'}
                    >
                      {isMuted || volume === 0 ? (
                        <VolumeX className="w-4 h-4 text-rose-400" />
                      ) : (
                        <Volume2 className="w-4 h-4" />
                      )}
                    </button>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={isMuted ? 0 : volume}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        setVolume(val);
                        setIsMuted(false);
                        if (videoRef.current) {
                          videoRef.current.volume = val;
                          videoRef.current.muted = false;
                        }
                        setVolumeState(val, false);
                        syncChannel.post({
                          type: 'SET_VOLUME',
                          payload: { volume: val, muted: false },
                        });
                      }}
                      className="w-16 h-1 accent-white bg-neutral-800 rounded-lg cursor-pointer"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Scrubber */}
            <div className="space-y-1">
              <input
                type="range"
                min="0"
                max={duration || 100}
                step="0.1"
                value={currentTime}
                onChange={(e) => {
                  const targetSec = parseFloat(e.target.value);
                  setCurrentTime(targetSec);
                  if (videoRef.current) {
                    videoRef.current.currentTime = targetSec;
                  }
                  syncChannel.post({
                    type: 'SEEK_TO',
                    payload: { time: targetSec },
                  });
                }}
                className="w-full h-1 accent-white bg-neutral-800 rounded-lg cursor-pointer"
              />
              <div className="flex justify-between text-xs font-sans font-medium tabular-nums text-neutral-400">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
