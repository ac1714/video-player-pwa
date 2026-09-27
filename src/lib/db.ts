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
 * Persists a video file blob into OPFS, Cache Storage, and IndexedDB media_blobs store.
 * This guarantees the file remains playable across page reloads and across tabs without re-import.
 */
export async function persistBinaryBlob(id: string, blob: Blob): Promise<void> {
  if (!id || !blob) return;
  registerMemoryFile(id, blob);

  // 1. Persist to IndexedDB dedicated media_blobs store
  try {
    const db = await getDB();
    await putToStore(db, STORE_MEDIA_BLOBS, { id, blob });
  } catch (err) {
    // IndexedDB fallback
  }

  // 2. Persist to OPFS (Origin Private File System)
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(`video_${id}`, { create: true });
      const writable = await (fileHandle as any).createWritable();
      await writable.write(blob);
      await writable.close();
    }
  } catch (err) {
    // OPFS fallback
  }

  // 3. Persist to Cache Storage API (shared across tabs and reloads on the same origin)
  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open(CACHE_NAME);
      const response = new Response(blob, {
        headers: {
          'Content-Type': blob.type || 'video/mp4',
          'Content-Length': String(blob.size),
        },
      });
      await cache.put(`/pwa-video-stream/${id}`, response);
    }
  } catch (err) {
    // Cache storage fallback
  }
}

/**
 * Retrieves a persistent video blob from Memory, OPFS, Cache Storage, or IndexedDB media_blobs.
 */
export async function retrieveBinaryBlob(id: string): Promise<Blob | undefined> {
  if (!id) return undefined;

  // 1. In-Memory Registry
  const mem = getMemoryFile(id);
  if (mem?.file && mem.file.size > 0) {
    return mem.file;
  }

  // 2. IndexedDB media_blobs store
  try {
    const db = await getDB();
    if (db.objectStoreNames.contains(STORE_MEDIA_BLOBS)) {
      const res = await new Promise<any>((resolve) => {
        try {
          const tx = db.transaction(STORE_MEDIA_BLOBS, 'readonly');
          const store = tx.objectStore(STORE_MEDIA_BLOBS);
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      });
      if (res?.blob && res.blob.size > 0) {
        registerMemoryFile(id, res.blob);
        return res.blob;
      }
    }
  } catch {}

  // 2b. Check STORE_MEDIA_FILES.blobFallback
  try {
    const db = await getDB();
    if (db.objectStoreNames.contains(STORE_MEDIA_FILES)) {
      const fileRec = await new Promise<any>((resolve) => {
        try {
          const tx = db.transaction(STORE_MEDIA_FILES, 'readonly');
          const store = tx.objectStore(STORE_MEDIA_FILES);
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      });
      if (fileRec?.blobFallback && fileRec.blobFallback.size > 0) {
        registerMemoryFile(id, fileRec.blobFallback, fileRec.handle);
        return fileRec.blobFallback;
      }
    }
  } catch {}

  // 3. OPFS (Origin Private File System)
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(`video_${id}`);
      const file = await fileHandle.getFile();
      if (file && file.size > 0) {
        registerMemoryFile(id, file);
        return file;
      }
    }
  } catch {}

  // 4. Cache Storage API
  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open(CACHE_NAME);
      const match = await cache.match(`/pwa-video-stream/${id}`);
      if (match) {
        const blob = await match.blob();
        if (blob && blob.size > 0) {
          registerMemoryFile(id, blob);
          return blob;
        }
      }
    }
  } catch {}

  return undefined;
}

/**
 * Deletes binary blob from all storage layers.
 */
export async function deleteBinaryBlob(id: string): Promise<void> {
  memoryFileRegistry.delete(id);

  try {
    const db = await getDB();
    const tx = db.transaction(STORE_MEDIA_BLOBS, 'readwrite');
    tx.objectStore(STORE_MEDIA_BLOBS).delete(id);
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

// Save Directory Handle (supports authorizing whole directories at once)
export async function saveDirectoryHandle(id: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await getDB();
  try {
    if (db.objectStoreNames.contains(STORE_DIRECTORY_HANDLES)) {
      await putToStore(db, STORE_DIRECTORY_HANDLES, {
        name: handle.name,
        handle: handle,
        id: id || handle.name,
        updatedAt: Date.now(),
      });
    }
  } catch (e) {
    console.warn('Could not store in STORE_DIRECTORY_HANDLES:', e);
  }

  try {
    // Also store in media_files with a distinct directory prefix for backward compatibility
    await putToStore(db, STORE_MEDIA_FILES, {
      id: `__dir_${id || handle.name}`,
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
    const db = await getDB();
    const handleMap = new Map<string, FileSystemDirectoryHandle>();

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
          handleMap.set(r.name || r.id, r.handle);
        }
      }
    }

    // 2. Check legacy __dir_ records in STORE_MEDIA_FILES
    const mediaRecords = await new Promise<any[]>((resolve) => {
      try {
        const tx = db.transaction(STORE_MEDIA_FILES, 'readonly');
        const store = tx.objectStore(STORE_MEDIA_FILES);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });

    for (const r of mediaRecords) {
      if (r?.id?.startsWith('__dir_') && r.dirHandle) {
        handleMap.set(r.name || r.id, r.dirHandle);
      }
    }

    return Array.from(handleMap.values());
  } catch {
    return [];
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

  // Persist blob to OPFS & Cache Storage asynchronously for bulletproof reload survival
  if (file.blobFallback) {
    persistBinaryBlob(file.id, file.blobFallback).catch(() => {});
  }

  // 1. Attempt to store full record with blob fallback and handle for full offline persistence
  const fullRecord: MediaFile = {
    id: file.id,
    name: file.name,
    relativePath: file.relativePath || file.name,
    mimeType: file.mimeType,
    size: file.size,
    lastModified: file.lastModified,
    duration: file.duration,
    createdAt: file.createdAt || Date.now(),
    handle: file.handle,
    blobFallback: file.blobFallback,
  };

  try {
    await putToStore(db, STORE_MEDIA_FILES, fullRecord);
  } catch {
    // If storing with blobFallback exceeds quota or fails, store metadata & handle only
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
    blobFallback: file.blobFallback,
  });
  if (file.blobFallback) {
    await persistBinaryBlob(file.id, file.blobFallback);
  }
}

export async function saveMediaFilesBatch(files: MediaFile[]): Promise<{ savedCount: number; errors: number }> {
  const db = await getDB();
  
  // Register all in memory immediately for instantaneous in-session playback
  for (const f of files) {
    registerMemoryFile(f.id, f.blobFallback, f.handle);
    if (f.blobFallback) {
      persistBinaryBlob(f.id, f.blobFallback).catch(() => {});
    }
  }

  // Save metadata & handles to IndexedDB
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
          blobFallback: f.blobFallback,
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

export function isSyntheticSampleClip(_name: string): boolean {
  // Never purge or misidentify user files
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

  const dbFiles = records
    .filter((record) => !record.id?.startsWith('__dir_'))
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
    if (!id.startsWith('__dir_') && !fileMap.has(id) && (mem.file || mem.handle)) {
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
