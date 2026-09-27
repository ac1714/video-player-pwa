/**
 * IndexedDB Schema & Service for PWA Video Sync
 * 
 * Stores:
 * 1. media_files: Primary key 'id'
 * 2. playlists: Primary key 'id'
 * 3. file_playlists: Primary compound key ['fileId', 'playlistId']
 */

import { MediaFile, Playlist, FilePlaylist } from '../types';

const DB_NAME = 'PwaVideoSyncDB';
const DB_VERSION = 5;

export const STORE_MEDIA_FILES = 'media_files';
export const STORE_MEDIA_BLOBS = 'media_blobs';
export const STORE_PLAYLISTS = 'playlists';
export const STORE_FILE_PLAYLISTS = 'file_playlists';
export const STORE_DIRECTORY_HANDLES = 'directory_handles';

let dbInstance: IDBDatabase | null = null;

export function getDB(): Promise<IDBDatabase> {
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // 1. media_files store
      if (!db.objectStoreNames.contains(STORE_MEDIA_FILES)) {
        const mediaStore = db.createObjectStore(STORE_MEDIA_FILES, { keyPath: 'id' });
        mediaStore.createIndex('by_name', 'name', { unique: false });
        mediaStore.createIndex('by_createdAt', 'createdAt', { unique: false });
      }

      // 2. media_blobs store (Dedicated binary blob store)
      if (!db.objectStoreNames.contains(STORE_MEDIA_BLOBS)) {
        db.createObjectStore(STORE_MEDIA_BLOBS, { keyPath: 'id' });
      }

      // 3. playlists store
      if (!db.objectStoreNames.contains(STORE_PLAYLISTS)) {
        const playlistStore = db.createObjectStore(STORE_PLAYLISTS, { keyPath: 'id' });
        playlistStore.createIndex('by_name', 'name', { unique: false });
        playlistStore.createIndex('by_updatedAt', 'updatedAt', { unique: false });
      }

      // 4. file_playlists relational store (Compound key: [fileId, playlistId])
      if (!db.objectStoreNames.contains(STORE_FILE_PLAYLISTS)) {
        const relStore = db.createObjectStore(STORE_FILE_PLAYLISTS, {
          keyPath: ['fileId', 'playlistId'],
        });
        relStore.createIndex('fileId', 'fileId', { unique: false });
        relStore.createIndex('playlistId', 'playlistId', { unique: false });
        relStore.createIndex('addedAt', 'addedAt', { unique: false });
      }

      // 5. directory_handles store (Stores FileSystemDirectoryHandle for one-click re-authorization)
      if (!db.objectStoreNames.contains(STORE_DIRECTORY_HANDLES)) {
        db.createObjectStore(STORE_DIRECTORY_HANDLES, { keyPath: 'name' });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = (event.target as IDBOpenDBRequest).result;
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
      };
      resolve(dbInstance);
    };

    request.onerror = () => {
      reject(request.error || new Error('Failed to open IndexedDB'));
    };
  });
}

// In-memory registry to guarantee instant playback of large files even when browser storage quota is tight
export const memoryFileRegistry = new Map<string, { file?: File | Blob; handle?: FileSystemFileHandle }>();

if (typeof window !== 'undefined') {
  (window as any).__PWA_MEMORY_REGISTRY__ = memoryFileRegistry;
  (window as any).__PWA_GET_MEMORY_FILE__ = (id: string) => memoryFileRegistry.get(id);
  (window as any).__PWA_REGISTER_MEMORY_FILE__ = (id: string, file?: File | Blob, handle?: FileSystemFileHandle) => registerMemoryFile(id, file, handle);
}

// Cache storage name for persistent binary blob storage
const CACHE_NAME = 'pwa_video_blobs_v1';

export function registerMemoryFile(id: string, file?: File | Blob, handle?: FileSystemFileHandle) {
  if (file || handle) {
    const existing = memoryFileRegistry.get(id);
    const updated = {
      file: file || existing?.file,
      handle: handle || existing?.handle,
    };
    memoryFileRegistry.set(id, updated);
    if (typeof window !== 'undefined' && file) {
      (window as any).__PWA_ACTIVE_MEDIA_BLOB__ = file;
      (window as any).__PWA_ACTIVE_TRACK_ID__ = id;
    }
  }
}

export function getMemoryFile(id: string) {
  return memoryFileRegistry.get(id);
}

/**
 * Keeps video reference in memory registry for instantaneous playback in active session.
 * Does NOT write full binary video blobs to IndexedDB, OPFS, or Cache Storage,
 * ensuring zero disk thrashing, zero quota exhaustion, and instant video playback.
 */
export async function persistBinaryBlob(id: string, blob: Blob): Promise<void> {
  if (!id || !blob) return;
  registerMemoryFile(id, blob);
}

/**
 * Retrieves in-memory video file or blob for instantaneous playback.
 */
export async function retrieveBinaryBlob(id: string): Promise<Blob | undefined> {
  if (!id) return undefined;
  const mem = getMemoryFile(id);
  if (mem?.file && mem.file.size > 0) {
    return mem.file;
  }
  return undefined;
}

/**
 * Purges legacy stored video blobs from IndexedDB, OPFS, and Cache Storage.
 * This frees gigabytes of duplicate browser storage and prevents disk I/O thrashing.
 */
export async function purgeLegacyStoredBlobs(): Promise<void> {
  // 1. Clear IndexedDB STORE_MEDIA_BLOBS
  try {
    const db = await getDB();
    if (db.objectStoreNames.contains(STORE_MEDIA_BLOBS)) {
      const tx = db.transaction(STORE_MEDIA_BLOBS, 'readwrite');
      tx.objectStore(STORE_MEDIA_BLOBS).clear();
    }
  } catch {}

  // 2. Clean up any blobFallback from STORE_MEDIA_FILES to keep records lean (metadata + handles only)
  try {
    const db = await getDB();
    if (db.objectStoreNames.contains(STORE_MEDIA_FILES)) {
      const tx = db.transaction(STORE_MEDIA_FILES, 'readwrite');
      const store = tx.objectStore(STORE_MEDIA_FILES);
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest).result as IDBCursorWithValue;
        if (cursor) {
          const val = cursor.value;
          if (val && val.blobFallback) {
            delete val.blobFallback;
            cursor.update(val);
          }
          cursor.continue();
        }
      };
    }
  } catch {}

  // 3. Clear OPFS video_* files
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      // @ts-expect-error entries on directory handle
      if (typeof root.entries === 'function') {
        // @ts-expect-error entries async iterator
        for await (const [name] of root.entries()) {
          if (name.startsWith('video_')) {
            await root.removeEntry(name).catch(() => {});
          }
        }
      }
    }
  } catch {}

  // 4. Delete legacy Cache Storage
  try {
    if (typeof caches !== 'undefined') {
      await caches.delete(CACHE_NAME).catch(() => {});
      await caches.delete('pwa-video-stream').catch(() => {});
    }
  } catch {}
}

// Automatically purge legacy duplicate blobs in the background on startup
if (typeof window !== 'undefined') {
  setTimeout(() => {
    purgeLegacyStoredBlobs().catch(() => {});
  }, 1000);
}

/**
 * Deletes binary blob from memory and legacy storage layers.
 */
export async function deleteBinaryBlob(id: string): Promise<void> {
  memoryFileRegistry.delete(id);

  try {
    const db = await getDB();
    if (db.objectStoreNames.contains(STORE_MEDIA_BLOBS)) {
      const tx = db.transaction(STORE_MEDIA_BLOBS, 'readwrite');
      tx.objectStore(STORE_MEDIA_BLOBS).delete(id);
    }
  } catch {}

  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(`video_${id}`).catch(() => {});
    }
  } catch {}

  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open(CACHE_NAME);
      await cache.delete(`/pwa-video-stream/${id}`).catch(() => {});
    }
  } catch {}
}

function putToStore(db: IDBDatabase, storeName: string, record: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Directory handles in-memory cache for instant permission query/request without DB delay
const memoryDirectoryHandles = new Map<string, FileSystemDirectoryHandle>();

export function getCachedDirectoryHandles(): FileSystemDirectoryHandle[] {
  return Array.from(memoryDirectoryHandles.values());
}

// Save Directory Handle (supports authorizing whole directories at once)
export async function saveDirectoryHandle(id: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const key = id || handle.name;
  memoryDirectoryHandles.set(key, handle);
  const db = await getDB();
  try {
    if (db.objectStoreNames.contains(STORE_DIRECTORY_HANDLES)) {
      await putToStore(db, STORE_DIRECTORY_HANDLES, {
        name: handle.name,
        handle: handle,
        id: key,
        updatedAt: Date.now(),
      });
    }
  } catch (e) {
    console.warn('Could not store in STORE_DIRECTORY_HANDLES:', e);
  }

  try {
    // Also store in media_files with a distinct directory prefix for backward compatibility
    await putToStore(db, STORE_MEDIA_FILES, {
      id: `__dir_${key}`,
      name: handle.name,
      mimeType: 'directory/handle',
      size: 0,
      lastModified: Date.now(),
      createdAt: Date.now(),
      dirHandle: handle,
    });
  } catch (err) {
    console.warn('Could not store directory handle in IndexedDB:', err);
  }
}

export async function getAllDirectoryHandles(): Promise<FileSystemDirectoryHandle[]> {
  try {
    const handleMap = new Map<string, FileSystemDirectoryHandle>(memoryDirectoryHandles);

    const db = await getDB();

    // 1. Check dedicated STORE_DIRECTORY_HANDLES
    if (db.objectStoreNames.contains(STORE_DIRECTORY_HANDLES)) {
      const records = await new Promise<any[]>((resolve) => {
        try {
          const tx = db.transaction(STORE_DIRECTORY_HANDLES, 'readonly');
          const store = tx.objectStore(STORE_DIRECTORY_HANDLES);
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });
      for (const r of records) {
        if (r?.handle) {
          const k = r.name || r.id;
          handleMap.set(k, r.handle);
          memoryDirectoryHandles.set(k, r.handle);
        }
      }
    }

    // 2. Check legacy __dir_ records in STORE_MEDIA_FILES only if no handles found in dedicated store
    if (handleMap.size === 0 && db.objectStoreNames.contains(STORE_MEDIA_FILES)) {
      const mediaRecords = await new Promise<any[]>((resolve) => {
        try {
          const tx = db.transaction(STORE_MEDIA_FILES, 'readonly');
          const store = tx.objectStore(STORE_MEDIA_FILES);
          const range = IDBKeyRange.bound('__dir_', '__dir_\uffff');
          const req = store.getAll(range);
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });

      for (const r of mediaRecords) {
        if (r?.id?.startsWith('__dir_') && r.dirHandle) {
          const k = r.name || r.id;
          handleMap.set(k, r.dirHandle);
          memoryDirectoryHandles.set(k, r.dirHandle);
        }
      }
    }

    return Array.from(handleMap.values());
  } catch {
    return Array.from(memoryDirectoryHandles.values());
  }
}

async function saveMediaFileResilient(db: IDBDatabase, file: MediaFile): Promise<void> {
  // Always register in memory registry first for instant in-session video playback
  registerMemoryFile(file.id, file.blobFallback, file.handle);

  // If the record is a directory handle marker, save directly
  if (file.id.startsWith('__dir_')) {
    await putToStore(db, STORE_MEDIA_FILES, file);
    return;
  }

  // Store metadata & handle only (NEVER full binary video blobs)
  const metadataRecord: MediaFile = {
    id: file.id,
    name: file.name,
    relativePath: file.relativePath || file.name,
    mimeType: file.mimeType,
    size: file.size,
    lastModified: file.lastModified,
    duration: file.duration,
    createdAt: file.createdAt || Date.now(),
    handle: file.handle,
  };

  try {
    await putToStore(db, STORE_MEDIA_FILES, metadataRecord);
  } catch (err2) {
    console.warn('Failed to store metadata record:', err2);
  }
}

// Media Files operations
export async function saveMediaFile(file: MediaFile): Promise<void> {
  registerMemoryFile(file.id, file.blobFallback, file.handle);
  const db = await getDB();
  await putToStore(db, STORE_MEDIA_FILES, {
    id: file.id,
    name: file.name,
    relativePath: file.relativePath || file.name,
    mimeType: file.mimeType,
    size: file.size,
    lastModified: file.lastModified,
    duration: file.duration,
    createdAt: file.createdAt || Date.now(),
    handle: file.handle,
  });
}

export async function saveMediaFilesBatch(files: MediaFile[]): Promise<{ savedCount: number; errors: number }> {
  const db = await getDB();
  
  // Register all in memory immediately for instantaneous in-session playback
  for (const f of files) {
    registerMemoryFile(f.id, f.blobFallback, f.handle);
  }

  // Save metadata & handles to IndexedDB (zero binary blob disk bloat)
  return new Promise((resolve) => {
    try {
      const tx = db.transaction([STORE_MEDIA_FILES], 'readwrite');
      const store = tx.objectStore(STORE_MEDIA_FILES);

      for (const f of files) {
        store.put({
          id: f.id,
          name: f.name,
          relativePath: f.relativePath || f.name,
          mimeType: f.mimeType,
          size: f.size,
          lastModified: f.lastModified,
          duration: f.duration,
          createdAt: f.createdAt || Date.now(),
          handle: f.handle,
        });
      }

      tx.oncomplete = () => resolve({ savedCount: files.length, errors: 0 });
      tx.onerror = (e) => {
        console.warn('Batch put error:', e);
        resolve({ savedCount: 0, errors: files.length });
      };
    } catch (err) {
      console.warn('Batch transaction error:', err);
      resolve({ savedCount: 0, errors: files.length });
    }
  });
}

export function isLegacySyntheticSample(name: string): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  return (
    n === 'clip_1:_sample_video.webm' ||
    n === 'clip_1:_sample_video.mp4' ||
    n === 'clip 1: sample video' ||
    n === 'clip_1: sample video' ||
    n.includes('sample_video') ||
    n.includes('sample video') ||
    n.includes('sample_clip') ||
    n.includes('sample clip') ||
    /^clip_\d+(:_sample_video)?\.webm$/i.test(n)
  );
}

export function isSyntheticSampleClip(_name: string): boolean {
  return false;
}

export async function getAllMediaFiles(): Promise<MediaFile[]> {
  const db = await getDB();
  const records = await new Promise<MediaFile[]>((resolve, reject) => {
    const tx = db.transaction(STORE_MEDIA_FILES, 'readonly');
    const store = tx.objectStore(STORE_MEDIA_FILES);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  // Permanently remove any legacy synthetic demo clips generated by past versions
  const demoRecords = records.filter((r) => isLegacySyntheticSample(r.name));
  if (demoRecords.length > 0) {
    for (const d of demoRecords) {
      deleteMediaFile(d.id).catch(() => {});
    }
    try {
      const activeTrackId = localStorage.getItem('pwa_video_track_id');
      if (activeTrackId && demoRecords.some((d) => d.id === activeTrackId)) {
        localStorage.removeItem('pwa_video_track_id');
        localStorage.removeItem('pwa_video_active_state');
      }
    } catch {}
  }

  const dbFiles = records
    .filter((record) => !record.id?.startsWith('__dir_') && !isLegacySyntheticSample(record.name))
    .map((record) => {
      const cached = getMemoryFile(record.id);
      if (record.blobFallback && !cached?.file) {
        registerMemoryFile(record.id, record.blobFallback, record.handle);
      }
      return {
        ...record,
        blobFallback: cached?.file || record.blobFallback,
        handle: record.handle || cached?.handle,
      };
    });

  // Ensure any newly ingested files in the in-memory registry are included even if IndexedDB is still settling
  const fileMap = new Map<string, MediaFile>();
  for (const f of dbFiles) {
    fileMap.set(f.id, f);
  }
  for (const [id, mem] of memoryFileRegistry.entries()) {
    const fileName = (mem.file as any)?.name || mem.handle?.name || 'Video File';
    if (!id.startsWith('__dir_') && !isLegacySyntheticSample(fileName) && !fileMap.has(id) && (mem.file || mem.handle)) {
      fileMap.set(id, {
        id,
        name: fileName,
        mimeType: (mem.file as any)?.type || 'video/mp4',
        size: (mem.file as any)?.size || 0,
        lastModified: (mem.file as any)?.lastModified || Date.now(),
        createdAt: Date.now(),
        handle: mem.handle,
        blobFallback: mem.file,
      });
    }
  }

  return Array.from(fileMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getMediaFile(id: string): Promise<MediaFile | undefined> {
  const db = await getDB();
  const record = await new Promise<MediaFile | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_MEDIA_FILES, 'readonly');
    const store = tx.objectStore(STORE_MEDIA_FILES);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  if (!record) return undefined;

  let blob = record.blobFallback;
  if (!blob) {
    blob = await retrieveBinaryBlob(record.id);
  } else {
    registerMemoryFile(record.id, blob, record.handle);
  }

  const cached = getMemoryFile(record.id);
  return {
    ...record,
    blobFallback: blob || cached?.file,
    handle: record.handle || cached?.handle,
  };
}

export async function deleteMediaFile(id: string): Promise<void> {
  memoryFileRegistry.delete(id);
  await deleteBinaryBlob(id);
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_MEDIA_FILES, STORE_PLAYLISTS, STORE_FILE_PLAYLISTS], 'readwrite');
    
    // 1. Delete from media_files
    const mediaStore = tx.objectStore(STORE_MEDIA_FILES);
    mediaStore.delete(id);

    // 2. Remove fileId from any playlist queues
    const playlistStore = tx.objectStore(STORE_PLAYLISTS);
    const getAllPlaylistsReq = playlistStore.getAll();
    getAllPlaylistsReq.onsuccess = () => {
      const playlists: Playlist[] = getAllPlaylistsReq.result || [];
      for (const pl of playlists) {
        if (pl.fileIds && pl.fileIds.includes(id)) {
          pl.fileIds = pl.fileIds.filter(fId => fId !== id);
          pl.updatedAt = Date.now();
          playlistStore.put(pl);
        }
      }
    };

    // 3. Remove from file_playlists join table
    const relStore = tx.objectStore(STORE_FILE_PLAYLISTS);
    const index = relStore.index('fileId');
    const getRelReq = index.getAllKeys(id);
    getRelReq.onsuccess = () => {
      const keys = getRelReq.result;
      for (const key of keys) {
        relStore.delete(key);
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Playlists operations
export async function getAllPlaylists(): Promise<Playlist[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PLAYLISTS, 'readonly');
    const store = tx.objectStore(STORE_PLAYLISTS);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Clear Video Cache Utility (Resets media file handles and references)
 * - keepPlaylists: if true, preserves playlist folders and structures while removing file handles
 */
export async function clearVideoCache(keepPlaylists: boolean = true): Promise<void> {
  memoryFileRegistry.clear();
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const storeNames = keepPlaylists
      ? [STORE_MEDIA_FILES, STORE_FILE_PLAYLISTS, STORE_PLAYLISTS]
      : [STORE_MEDIA_FILES, STORE_FILE_PLAYLISTS, STORE_PLAYLISTS];
    const tx = db.transaction(storeNames, 'readwrite');
    
    // 1. Clear media_files
    tx.objectStore(STORE_MEDIA_FILES).clear();
    
    // 2. Clear file_playlists relations
    tx.objectStore(STORE_FILE_PLAYLISTS).clear();

    // 3. If keeping playlists, reset their fileIds array
    if (keepPlaylists) {
      const plStore = tx.objectStore(STORE_PLAYLISTS);
      const req = plStore.getAll();
      req.onsuccess = () => {
        const playlists: Playlist[] = req.result || [];
        for (const pl of playlists) {
          pl.fileIds = [];
          pl.updatedAt = Date.now();
          plStore.put(pl);
        }
      };
    } else {
      tx.objectStore(STORE_PLAYLISTS).clear();
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Complete reset of IndexedDB and LocalStorage
 */
export async function fullSystemReset(): Promise<void> {
  memoryFileRegistry.clear();
  await purgeLegacyStoredBlobs().catch(() => {});
  try {
    const db = await getDB();
    db.close();
  } catch {}
  
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });

  try {
    localStorage.removeItem('pwa_sync_active_playlist');
    localStorage.removeItem('pwa_sync_active_track');
    localStorage.removeItem('pwa_sync_last_playback_time');
    localStorage.removeItem('pwa_sync_autoplay');
    localStorage.removeItem('pwa_sync_loop');
    localStorage.removeItem('pwa_theme_preference');
  } catch {}
}

export async function getPlaylist(id: string): Promise<Playlist | undefined> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PLAYLISTS, 'readonly');
    const store = tx.objectStore(STORE_PLAYLISTS);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function createPlaylist(name: string): Promise<Playlist> {
  const db = await getDB();
  const newPlaylist: Playlist = {
    id: crypto.randomUUID ? crypto.randomUUID() : `pl_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    name: name.trim() || 'Untitled Playlist',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    fileIds: [],
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PLAYLISTS, 'readwrite');
    const store = tx.objectStore(STORE_PLAYLISTS);
    const req = store.add(newPlaylist);
    req.onsuccess = () => resolve(newPlaylist);
    req.onerror = () => reject(req.error);
  });
}

export async function updatePlaylist(playlist: Playlist): Promise<void> {
  const db = await getDB();
  playlist.updatedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PLAYLISTS, 'readwrite');
    const store = tx.objectStore(STORE_PLAYLISTS);
    const req = store.put(playlist);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function deletePlaylist(id: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PLAYLISTS, STORE_FILE_PLAYLISTS], 'readwrite');
    
    // 1. Delete playlist
    const plStore = tx.objectStore(STORE_PLAYLISTS);
    plStore.delete(id);

    // 2. Delete join rows
    const relStore = tx.objectStore(STORE_FILE_PLAYLISTS);
    const index = relStore.index('playlistId');
    const getRelReq = index.getAllKeys(id);
    getRelReq.onsuccess = () => {
      const keys = getRelReq.result;
      for (const key of keys) {
        relStore.delete(key);
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Relational Mappings (file_playlists)
export async function addFileToPlaylist(fileId: string, playlistId: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PLAYLISTS, STORE_FILE_PLAYLISTS], 'readwrite');
    
    // Add to relational table
    const relStore = tx.objectStore(STORE_FILE_PLAYLISTS);
    const relEntry: FilePlaylist = {
      fileId,
      playlistId,
      addedAt: Date.now(),
    };
    relStore.put(relEntry);

    // Also append to ordered fileIds list in playlist if not already present
    const plStore = tx.objectStore(STORE_PLAYLISTS);
    const getPlReq = plStore.get(playlistId);
    getPlReq.onsuccess = () => {
      const pl: Playlist | undefined = getPlReq.result;
      if (pl) {
        if (!pl.fileIds.includes(fileId)) {
          pl.fileIds.push(fileId);
          pl.updatedAt = Date.now();
          plStore.put(pl);
        }
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeFileFromPlaylist(fileId: string, playlistId: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PLAYLISTS, STORE_FILE_PLAYLISTS], 'readwrite');
    
    // Remove from relational table
    const relStore = tx.objectStore(STORE_FILE_PLAYLISTS);
    relStore.delete([fileId, playlistId]);

    // Also remove from ordered fileIds list in playlist
    const plStore = tx.objectStore(STORE_PLAYLISTS);
    const getPlReq = plStore.get(playlistId);
    getPlReq.onsuccess = () => {
      const pl: Playlist | undefined = getPlReq.result;
      if (pl) {
        pl.fileIds = pl.fileIds.filter(fId => fId !== fileId);
        pl.updatedAt = Date.now();
        plStore.put(pl);
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPlaylistsForFile(fileId: string): Promise<string[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILE_PLAYLISTS, 'readonly');
    const relStore = tx.objectStore(STORE_FILE_PLAYLISTS);
    const index = relStore.index('fileId');
    const req = index.getAll(fileId);
    req.onsuccess = () => {
      const rows: FilePlaylist[] = req.result || [];
      resolve(rows.map(r => r.playlistId));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getFilesForPlaylist(playlistId: string): Promise<MediaFile[]> {
  const db = await getDB();
  // We first fetch the playlist to preserve the custom user ordering of fileIds
  const playlist = await getPlaylist(playlistId);
  if (!playlist || !playlist.fileIds.length) {
    return [];
  }

  const allFiles = await getAllMediaFiles();
  const fileMap = new Map<string, MediaFile>();
  for (const f of allFiles) {
    fileMap.set(f.id, f);
  }

  const orderedFiles: MediaFile[] = [];
  for (const id of playlist.fileIds) {
    const found = fileMap.get(id);
    if (found) {
      orderedFiles.push(found);
    }
  }

  return orderedFiles;
}
