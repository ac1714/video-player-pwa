/**
 * Local File & Directory Ingestion Service
 * 
 * Supports:
 * 1. Recursive folder selection via HTML5 webkitdirectory input (works inside iframes & all browsers)
 * 2. File System Access API showDirectoryPicker / showOpenFilePicker with automatic graceful fallback
 * 3. HTML5 Drag-and-drop recursive folder traversal via webkitGetAsEntry
 * 4. Storing File/Blob objects and FileSystemFileHandle in IndexedDB for seamless cross-tab playback
 */

import { MediaFile } from '../types';
import { saveMediaFilesBatch, saveMediaFile, registerMemoryFile, getAllMediaFiles, saveDirectoryHandle, getMediaFile } from './db';

export function extractVideoDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    try {
      if (typeof document === 'undefined') return resolve(0);
      const video = document.createElement('video');
      video.preload = 'metadata';
      const url = URL.createObjectURL(blob);
      video.src = url;
      video.onloadedmetadata = () => {
        const d = video.duration;
        URL.revokeObjectURL(url);
        resolve(!isNaN(d) && isFinite(d) && d > 0 ? d : 0);
      };
      video.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(0);
      };
      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch {}
        resolve(0);
      }, 3000);
    } catch {
      resolve(0);
    }
  });
}

const SUPPORTED_EXTENSIONS = [
  '.mp4',
  '.m4v',
  '.m4p',
  '.mp4v',
  '.webm',
  '.mkv',
  '.mov',
  '.qt',
  '.avi',
  '.wmv',
  '.asf',
  '.flv',
  '.f4v',
  '.ts',
  '.mts',
  '.m2ts',
  '.ogv',
  '.ogg',
  '.3gp',
  '.3g2',
  '.mpg',
  '.mpeg',
  '.m1v',
  '.m2v',
  '.vob',
  '.divx',
  '.rm',
  '.rmvb',
  '.h264',
  '.hevc',
  '.264',
  '.av1',
  '.h265',
  '.265',
  '.vp9',
  '.m3u8',
  '.mpd',
];

const SUPPORTED_MIME_PREFIX = 'video/';

export function isVideoFile(fileName: string, mimeType?: string): boolean {
  if (mimeType && mimeType.toLowerCase().startsWith(SUPPORTED_MIME_PREFIX)) {
    return true;
  }
  const cleanName = fileName.split('?')[0].split('#')[0].trim().toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => cleanName.endsWith(ext));
}

export function getMimeFromFilename(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v') || lower.endsWith('.mp4v')) return 'video/mp4';
  if (lower.endsWith('.mov') || lower.endsWith('.qt')) return 'video/quicktime';
  if (lower.endsWith('.mkv')) return 'video/x-matroska';
  if (lower.endsWith('.ogv') || lower.endsWith('.ogg')) return 'video/ogg';
  if (lower.endsWith('.avi')) return 'video/x-msvideo';
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.m2ts')) return 'video/mp2t';
  if (lower.endsWith('.flv') || lower.endsWith('.f4v')) return 'video/x-flv';
  if (lower.endsWith('.wmv') || lower.endsWith('.asf')) return 'video/x-ms-wmv';
  if (lower.endsWith('.3gp') || lower.endsWith('.3g2')) return 'video/3gpp';
  if (lower.endsWith('.mpg') || lower.endsWith('.mpeg') || lower.endsWith('.vob')) return 'video/mpeg';
  return 'video/mp4';
}

export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `file_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export function isInsideIframe(): boolean {
  try {
    return typeof window !== 'undefined' && window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * Process a FileList or File[] into MediaFile records and persist into IndexedDB
 * Matches existing catalog records to preserve playlist associations, ratings, and IDs.
 * Streams batches progressively to onProgress callback so catalog updates instantaneously.
 */
export async function ingestFileList(
  files: FileList | File[],
  onProgress?: (batch: MediaFile[], totalCollected: number) => void
): Promise<{ count: number; files: MediaFile[] }> {
  const existingFiles = await getAllMediaFiles();
  const existingByName = new Map<string, MediaFile>();
  for (const ef of existingFiles) {
    existingByName.set(ef.name.toLowerCase(), ef);
    if (ef.relativePath) {
      existingByName.set(ef.relativePath.toLowerCase(), ef);
    }
  }

  const collected: MediaFile[] = [];
  const list = Array.from(files);
  const CHUNK_SIZE = 20;
  let currentChunk: MediaFile[] = [];

  for (const f of list) {
    if (isVideoFile(f.name, f.type)) {
      const relPath = (f as any).webkitRelativePath || f.name;
      const matchedExisting = existingByName.get(relPath.toLowerCase()) || existingByName.get(f.name.toLowerCase());

      const fileId = matchedExisting ? matchedExisting.id : generateUUID();
      registerMemoryFile(fileId, f);

      const cachedDur = matchedExisting?.duration || (() => {
        try {
          const val = localStorage.getItem(`pwa_video_duration_${fileId}`);
          return val ? parseFloat(val) : undefined;
        } catch {
          return undefined;
        }
      })();

      if (!cachedDur) {
        extractVideoDuration(f).then((dur) => {
          if (dur > 0) {
            try {
              localStorage.setItem(`pwa_video_duration_${fileId}`, String(dur));
            } catch {}
            getMediaFile(fileId).then((dbRec) => {
              if (dbRec && dbRec.duration !== dur) {
                dbRec.duration = dur;
                saveMediaFile(dbRec).catch(() => {});
              }
            });
          }
        });
      }

      const record: MediaFile = {
        id: fileId,
        name: f.name,
        relativePath: relPath,
        mimeType: f.type || getMimeFromFilename(f.name),
        size: f.size,
        lastModified: f.lastModified,
        duration: cachedDur,
        createdAt: matchedExisting ? matchedExisting.createdAt : Date.now(),
      };

      collected.push(record);
      currentChunk.push(record);
      existingByName.set(record.name.toLowerCase(), record);
      if (record.relativePath) {
        existingByName.set(record.relativePath.toLowerCase(), record);
      }

      if (currentChunk.length >= CHUNK_SIZE) {
        if (onProgress) {
          onProgress(currentChunk, collected.length);
        }
        await saveMediaFilesBatch(currentChunk);
        currentChunk = [];
      }
    }
  }

  if (currentChunk.length > 0) {
    if (onProgress) {
      onProgress(currentChunk, collected.length);
    }
    await saveMediaFilesBatch(currentChunk);
  }

  return {
    count: collected.length,
    files: collected,
  };
}

/**
 * Ingest folder using HTML5 webkitdirectory input
 * This is 100% compatible across Chrome, Safari, Firefox, Edge, and works within iframes.
 * NOTE: We deliberately do NOT set accept="video/*" on webkitdirectory input because macOS
 * and Windows dialogs disable folder selection if an accept filter is present on directory input.
 */
export function pickFolderViaInput(
  onProgress?: (batch: MediaFile[], totalCollected: number) => void
): Promise<{ count: number; files: MediaFile[] }> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    (input as any).webkitdirectory = true;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.setAttribute('mozdirectory', '');
    input.className = 'sr-only';
    input.style.position = 'fixed';
    input.style.top = '-9999px';
    input.style.left = '-9999px';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';

    let settled = false;

    const cleanup = () => {
      try {
        if (input.parentNode) {
          input.parentNode.removeChild(input);
        }
      } catch {}
    };

    input.onchange = async () => {
      if (settled) return;
      settled = true;
      try {
        const fileList = input.files;
        if (!fileList || fileList.length === 0) {
          cleanup();
          resolve({ count: 0, files: [] });
          return;
        }

        const result = await ingestFileList(fileList, onProgress);
        cleanup();
        resolve(result);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    input.oncancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ count: 0, files: [] });
    };

    document.body.appendChild(input);

    try {
      input.click();
    } catch (clickErr) {
      cleanup();
      reject(clickErr);
    }
  });
}

/**
 * Recursively traverses a FileSystemDirectoryHandle and collects all video files
 * Emits batches progressively to onProgress callback so catalog shows files immediately
 */
async function scanDirectory(
  dirHandle: FileSystemDirectoryHandle,
  collected: MediaFile[],
  pathPrefix: string = '',
  existingByName?: Map<string, MediaFile>,
  onProgress?: (batch: MediaFile[], totalCollected: number) => void
): Promise<void> {
  let lookup = existingByName;
  if (!lookup) {
    const existingFiles = await getAllMediaFiles();
    lookup = new Map<string, MediaFile>();
    for (const ef of existingFiles) {
      lookup.set(ef.name.toLowerCase(), ef);
      if (ef.relativePath) {
        lookup.set(ef.relativePath.toLowerCase(), ef);
      }
    }
  }

  const videoHandles: FileSystemFileHandle[] = [];
  const subDirs: FileSystemDirectoryHandle[] = [];

  try {
    // Robust async iterator handling across different browser implementations:
    // Some implementations yield FileSystemHandle directly;
    // others yield [name, FileSystemHandle] tuples from entries() or [Symbol.asyncIterator]().
    const iterator = typeof (dirHandle as any).values === 'function'
      ? (dirHandle as any).values()
      : typeof (dirHandle as any).entries === 'function'
      ? (dirHandle as any).entries()
      : (dirHandle as any)[Symbol.asyncIterator]();

    for await (const rawItem of iterator) {
      const entry: FileSystemHandle = Array.isArray(rawItem) ? rawItem[1] : rawItem;
      if (!entry || !entry.kind) continue;

      if (entry.kind === 'file') {
        const fileHandle = entry as FileSystemFileHandle;
        if (isVideoFile(fileHandle.name)) {
          videoHandles.push(fileHandle);
        }
      } else if (entry.kind === 'directory') {
        subDirs.push(entry as FileSystemDirectoryHandle);
      }
    }
  } catch (iterErr) {
    console.warn(`Could not iterate directory ${dirHandle.name}:`, iterErr);
  }

  // Process video handles in parallel chunks of 20 for maximum speed and instant catalog rendering
  const CHUNK_SIZE = 20;
  for (let i = 0; i < videoHandles.length; i += CHUNK_SIZE) {
    const chunk = videoHandles.slice(i, i + CHUNK_SIZE);
    const resolvedChunk = await Promise.all(
      chunk.map(async (fileHandle) => {
        try {
          const file = await fileHandle.getFile();
          const relPath = pathPrefix ? `${pathPrefix}/${fileHandle.name}` : fileHandle.name;
          const matched = lookup!.get(relPath.toLowerCase()) || lookup!.get(fileHandle.name.toLowerCase());
          const fileId = matched ? matched.id : generateUUID();

          registerMemoryFile(fileId, file, fileHandle);
          return {
            id: fileId,
            name: fileHandle.name,
            relativePath: relPath,
            mimeType: file.type || getMimeFromFilename(fileHandle.name),
            size: file.size,
            lastModified: file.lastModified,
            handle: fileHandle,
            createdAt: matched ? matched.createdAt : Date.now(),
          } as MediaFile;
        } catch (e) {
          console.warn(`Could not read metadata for ${fileHandle.name}:`, e);
          return null;
        }
      })
    );

    const validBatch = resolvedChunk.filter((item): item is MediaFile => item !== null);
    if (validBatch.length > 0) {
      collected.push(...validBatch);
      for (const item of validBatch) {
        lookup!.set(item.name.toLowerCase(), item);
        if (item.relativePath) {
          lookup!.set(item.relativePath.toLowerCase(), item);
        }
      }
      // Immediately notify the UI so files appear without waiting on disk persistence
      if (onProgress) {
        onProgress(validBatch, collected.length);
      }
      await saveMediaFilesBatch(validBatch);
    }
  }

  // Recurse subdirectories and stream files with continuous progress
  for (const subDir of subDirs) {
    try {
      const nextPrefix = pathPrefix ? `${pathPrefix}/${subDir.name}` : subDir.name;
      await scanDirectory(subDir, collected, nextPrefix, lookup, onProgress);
    } catch (e) {
      console.warn(`Could not traverse directory ${subDir.name}:`, e);
    }
  }
}

/**
 * Re-links missing or ungranted FileSystemFileHandles by scanning a chosen directory handle
 */
export async function relinkFolderHandles(dirHandle: FileSystemDirectoryHandle): Promise<{ matched: number; matchedFiles: MediaFile[] }> {
  const existingFiles = await getAllMediaFiles();
  if (existingFiles.length === 0) return { matched: 0, matchedFiles: [] };

  const existingByName = new Map<string, MediaFile>();
  for (const f of existingFiles) {
    existingByName.set(f.name.toLowerCase().trim(), f);
    if (f.relativePath) {
      const norm = f.relativePath.replace(/\\/g, '/').toLowerCase().trim();
      existingByName.set(norm, f);
      existingByName.set(norm.replace(/^\/+/, ''), f);
    }
  }

  let matched = 0;
  const updatedTargets: MediaFile[] = [];

  async function traverse(currentDir: FileSystemDirectoryHandle, currentPath: string = '') {
    const iterator = typeof (currentDir as any).values === 'function'
      ? (currentDir as any).values()
      : typeof (currentDir as any).entries === 'function'
      ? (currentDir as any).entries()
      : (currentDir as any)[Symbol.asyncIterator]();

    for await (const rawItem of iterator) {
      const entry: FileSystemHandle = Array.isArray(rawItem) ? rawItem[1] : rawItem;
      if (!entry || !entry.kind) continue;

      if (entry.kind === 'file') {
        const fileHandle = entry as FileSystemFileHandle;
        const relPath = currentPath ? `${currentPath}/${fileHandle.name}` : fileHandle.name;
        const cleanRel = relPath.replace(/^\/+/, '').toLowerCase().trim();
        const target = existingByName.get(cleanRel) || existingByName.get(fileHandle.name.toLowerCase().trim());
        if (target) {
          try {
            const file = await fileHandle.getFile();
            target.handle = fileHandle;
            target.blobFallback = file;
            target.size = file.size;
            target.lastModified = file.lastModified;
            registerMemoryFile(target.id, file, fileHandle);
            updatedTargets.push(target);
            matched++;
          } catch (e) {
            console.warn('Error re-linking file:', e);
          }
        }
      } else if (entry.kind === 'directory') {
        const nextPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
        await traverse(entry as FileSystemDirectoryHandle, nextPath);
      }
    }
  }

  await traverse(dirHandle);
  if (updatedTargets.length > 0) {
    await saveMediaFilesBatch(updatedTargets);
  }
  await saveDirectoryHandle(dirHandle.name, dirHandle);
  return { matched, matchedFiles: updatedTargets };
}

/**
 * Re-links existing media files in the catalog from a FileList or array of File objects
 * (e.g. from an HTML5 directory picker <input webkitdirectory> or multi-file picker).
 * Does NOT create duplicate records, preserves IDs, playlists, metadata, and persistent blobs.
 */
export async function relinkFilesFromList(
  fileList: FileList | File[],
  onProgress?: (matchedCount: number, totalProcessed: number) => void
): Promise<{ matched: number; total: number; matchedFiles: MediaFile[] }> {
  const existingFiles = await getAllMediaFiles();
  if (existingFiles.length === 0) return { matched: 0, total: 0, matchedFiles: [] };

  const existingByName = new Map<string, MediaFile>();
  for (const f of existingFiles) {
    existingByName.set(f.name.toLowerCase().trim(), f);
    if (f.relativePath) {
      const norm = f.relativePath.replace(/\\/g, '/').toLowerCase().trim();
      existingByName.set(norm, f);
      existingByName.set(norm.replace(/^\/+/, ''), f);
    }
  }

  let matched = 0;
  const list = Array.from(fileList);
  const updatedRecords: MediaFile[] = [];

  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    const relPath = ((file as any).webkitRelativePath || file.name).replace(/\\/g, '/').trim();
    const cleanRel = relPath.replace(/^\/+/, '');
    const fileName = file.name.trim();

    let target =
      existingByName.get(cleanRel.toLowerCase()) ||
      existingByName.get(fileName.toLowerCase());

    // If not matched, try matching without extension
    if (!target) {
      const baseName = fileName.replace(/\.[^/.]+$/, '').toLowerCase();
      for (const [key, val] of existingByName.entries()) {
        const valBase = val.name.replace(/\.[^/.]+$/, '').toLowerCase();
        if (key === baseName || valBase === baseName) {
          target = val;
          break;
        }
      }
    }

    if (target) {
      target.blobFallback = file;
      target.size = file.size;
      target.lastModified = file.lastModified;
      registerMemoryFile(target.id, file);
      updatedRecords.push(target);
      matched++;
    }

    if (onProgress && (i % 5 === 0 || i === list.length - 1)) {
      onProgress(matched, i + 1);
    }
  }

  // If a single file was selected and no exact name matched, but only one file is in the catalog:
  if (matched === 0 && list.length === 1 && existingFiles.length === 1) {
    const single = existingFiles[0];
    single.blobFallback = list[0];
    single.size = list[0].size;
    single.lastModified = list[0].lastModified;
    registerMemoryFile(single.id, list[0]);
    updatedRecords.push(single);
    matched = 1;
  }

  if (updatedRecords.length > 0) {
    await saveMediaFilesBatch(updatedRecords);
  }

  return { matched, total: list.length, matchedFiles: updatedRecords };
}

/**
 * Universal folder re-link picker:
 * Uses HTML5 webkitdirectory which works 100% inside iframes without SecurityError.
 * Reconnects all matching files in the catalog without duplicating or modifying playlists.
 */
export function pickFolderToRelink(
  onProgress?: (matchedCount: number, total: number) => void
): Promise<{ matched: number; total: number; matchedFiles: MediaFile[] }> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    (input as any).webkitdirectory = true;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.setAttribute('mozdirectory', '');
    input.className = 'sr-only';
    input.style.position = 'fixed';
    input.style.top = '-9999px';
    input.style.left = '-9999px';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';

    let settled = false;
    const cleanup = () => {
      try {
        if (input.parentNode) input.parentNode.removeChild(input);
      } catch {}
    };

    input.onchange = async () => {
      if (settled) return;
      settled = true;
      try {
        const fileList = input.files;
        if (!fileList || fileList.length === 0) {
          cleanup();
          resolve({ matched: 0, total: 0, matchedFiles: [] });
          return;
        }
        const res = await relinkFilesFromList(fileList, onProgress);
        cleanup();
        resolve(res);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    input.oncancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ matched: 0, total: 0, matchedFiles: [] });
    };

    document.body.appendChild(input);
    try {
      input.click();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

/**
 * Universal video files re-link picker:
 * Allows user to pick multiple video files to reconnect matching catalog entries.
 */
export function pickFilesToRelink(
  onProgress?: (matchedCount: number, total: number) => void
): Promise<{ matched: number; total: number; matchedFiles: MediaFile[] }> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'video/*,.mp4,.webm,.mkv,.mov,.m4v,.ogv,.avi,.ts';
    input.className = 'sr-only';
    input.style.position = 'fixed';
    input.style.top = '-9999px';
    input.style.left = '-9999px';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';

    let settled = false;
    const cleanup = () => {
      try {
        if (input.parentNode) input.parentNode.removeChild(input);
      } catch {}
    };

    input.onchange = async () => {
      if (settled) return;
      settled = true;
      try {
        const fileList = input.files;
        if (!fileList || fileList.length === 0) {
          cleanup();
          resolve({ matched: 0, total: 0, matchedFiles: [] });
          return;
        }
        const res = await relinkFilesFromList(fileList, onProgress);
        cleanup();
        resolve(res);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    input.oncancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ matched: 0, total: 0, matchedFiles: [] });
    };

    document.body.appendChild(input);
    try {
      input.click();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

/**
 * 1. Folder Ingestion
 * Uses File System Access API when available,
 * and seamlessly falls back to HTML webkitdirectory input in unsupported contexts.
 * Streams discovered video files immediately to onProgress for zero perceived latency.
 */
export async function pickFolderAndIngest(
  onProgress?: (batch: MediaFile[], totalCollected: number) => void
): Promise<{ count: number; files: MediaFile[] }> {
  if ('showDirectoryPicker' in window && !isInsideIframe()) {
    try {
      // Calling showDirectoryPicker with NO options to prevent browser rejection
      // @ts-expect-error - showDirectoryPicker on window
      const dirHandle: FileSystemDirectoryHandle = await window.showDirectoryPicker();

      await saveDirectoryHandle(dirHandle.name, dirHandle).catch(() => {});

      const collected: MediaFile[] = [];
      await scanDirectory(dirHandle, collected, '', undefined, onProgress);

      return {
        count: collected.length,
        files: collected,
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { count: 0, files: [] };
      }
      console.warn('showDirectoryPicker failed, delegating to caller:', err);
      throw err;
    }
  }

  // Universal HTML5 webkitdirectory fallback
  return pickFolderViaInput(onProgress);
}

/**
 * 2. Direct File Ingestion using showOpenFilePicker or HTML file input
 */
export async function pickFilesAndIngest(
  onProgress?: (batch: MediaFile[], totalCollected: number) => void
): Promise<{ count: number; files: MediaFile[] }> {
  if ('showOpenFilePicker' in window) {
    try {
      // @ts-expect-error - showOpenFilePicker on window
      const handles: FileSystemFileHandle[] = await window.showOpenFilePicker({
        multiple: true,
        types: [
          {
            description: 'Video Files (*.mp4, *.webm, *.mkv, *.mov, *.m4v, *.avi)',
            accept: {
              'video/*': ['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.ogv', '.avi', '.ts'],
            },
          },
        ],
      });

      const existingFiles = await getAllMediaFiles();
      const existingByName = new Map<string, MediaFile>();
      for (const ef of existingFiles) {
        existingByName.set(ef.name.toLowerCase(), ef);
        if (ef.relativePath) {
          existingByName.set(ef.relativePath.toLowerCase(), ef);
        }
      }

      const collected: MediaFile[] = [];
      const CHUNK_SIZE = 20;
      for (let i = 0; i < handles.length; i += CHUNK_SIZE) {
        const chunk = handles.slice(i, i + CHUNK_SIZE);
        const resolved = await Promise.all(
          chunk.map(async (handle) => {
            try {
              const file = await handle.getFile();
              const matched = existingByName.get(handle.name.toLowerCase());
              const fileId = matched ? matched.id : generateUUID();

              registerMemoryFile(fileId, file, handle);
              return {
                id: fileId,
                name: handle.name,
                mimeType: file.type || getMimeFromFilename(handle.name),
                size: file.size,
                lastModified: file.lastModified,
                handle: handle,
                createdAt: matched ? matched.createdAt : Date.now(),
              } as MediaFile;
            } catch (err) {
              console.warn(`Could not read file ${handle.name}:`, err);
              return null;
            }
          })
        );

        const valid = resolved.filter((r): r is MediaFile => r !== null);
        if (valid.length > 0) {
          collected.push(...valid);
          if (onProgress) {
            onProgress(valid, collected.length);
          }
          await saveMediaFilesBatch(valid);
        }
      }

      return {
        count: collected.length,
        files: collected,
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { count: 0, files: [] };
      }
      console.warn('showOpenFilePicker failed, attempting file input fallback:', err);
    }
  }

  // Fallback: programmatic <input type="file">
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'video/*,.mp4,.webm,.mkv,.mov,.m4v,.ogv,.avi,.ts';
    input.style.position = 'fixed';
    input.style.top = '-9999px';
    input.style.left = '-9999px';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';

    let settled = false;

    const cleanup = () => {
      try {
        if (input.parentNode) {
          input.parentNode.removeChild(input);
        }
      } catch {}
    };

    input.onchange = async () => {
      if (settled) return;
      settled = true;
      try {
        const fileList = input.files;
        if (!fileList || fileList.length === 0) {
          cleanup();
          resolve({ count: 0, files: [] });
          return;
        }

        const result = await ingestFileList(fileList, onProgress);
        cleanup();
        resolve(result);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    input.oncancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ count: 0, files: [] });
    };

    document.body.appendChild(input);

    try {
      input.click();
    } catch (clickErr) {
      cleanup();
      reject(clickErr);
    }
  });
}

/**
 * 3. Drag and Drop Ingestion
 * Recursively extracts files and FileSystemHandles from DataTransfer items
 */
async function getFilesFromEntry(entry: any): Promise<File[]> {
  if (!entry) return [];
  if (entry.isFile) {
    return new Promise((resolve) => {
      entry.file(
        (f: File) => resolve([f]),
        (err: any) => {
          console.warn('Error reading file entry:', err);
          resolve([]);
        }
      );
    });
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const files: File[] = [];
    const readEntries = (): Promise<any[]> => {
      return new Promise((resolve) => {
        reader.readEntries(
          (entries: any[]) => resolve(entries || []),
          (err: any) => {
            console.warn('Error reading directory entries:', err);
            resolve([]);
          }
        );
      });
    };

    let batch: any[];
    do {
      batch = await readEntries();
      for (const child of batch) {
        const subFiles = await getFilesFromEntry(child);
        files.push(...subFiles);
      }
    } while (batch && batch.length > 0);

    return files;
  }
  return [];
}

export async function ingestDroppedItems(
  dataTransfer: DataTransfer,
  onProgress?: (batch: MediaFile[], totalCollected: number) => void
): Promise<{ count: number; files: MediaFile[] }> {
  // First attempt native FileSystemHandles from DataTransferItems (preserves persistent handles!)
  if (dataTransfer.items && dataTransfer.items.length > 0) {
    const existingFiles = await getAllMediaFiles();
    const existingByName = new Map<string, MediaFile>();
    for (const ef of existingFiles) {
      existingByName.set(ef.name.toLowerCase(), ef);
      if (ef.relativePath) {
        existingByName.set(ef.relativePath.toLowerCase(), ef);
      }
    }

    const collectedWithHandles: MediaFile[] = [];
    let hadHandleSupport = false;

    for (let i = 0; i < dataTransfer.items.length; i++) {
      const item = dataTransfer.items[i];
      if (item.kind === 'file' && 'getAsFileSystemHandle' in item) {
        hadHandleSupport = true;
        try {
          // @ts-expect-error getAsFileSystemHandle
          const handle = await item.getAsFileSystemHandle();
          if (handle) {
            if (handle.kind === 'file') {
              const fileHandle = handle as FileSystemFileHandle;
              if (isVideoFile(fileHandle.name)) {
                const file = await fileHandle.getFile();
                const matched = existingByName.get(fileHandle.name.toLowerCase());
                const fileId = matched ? matched.id : generateUUID();

                registerMemoryFile(fileId, file, fileHandle);
                const record: MediaFile = {
                  id: fileId,
                  name: fileHandle.name,
                  mimeType: file.type || getMimeFromFilename(fileHandle.name),
                  size: file.size,
                  lastModified: file.lastModified,
                  handle: fileHandle,
                  createdAt: matched ? matched.createdAt : Date.now(),
                };
                collectedWithHandles.push(record);
                if (onProgress) {
                  onProgress([record], collectedWithHandles.length);
                }
              }
            } else if (handle.kind === 'directory') {
              await scanDirectory(handle as FileSystemDirectoryHandle, collectedWithHandles, handle.name, existingByName, onProgress);
            }
          }
        } catch (e) {
          console.warn('Could not extract handle from dropped item:', e);
        }
      }
    }

    if (hadHandleSupport && collectedWithHandles.length > 0) {
      await saveMediaFilesBatch(collectedWithHandles);
      return {
        count: collectedWithHandles.length,
        files: collectedWithHandles,
      };
    }
  }

  // Fallback: standard webkitGetAsEntry or files
  const collectedRawFiles: File[] = [];

  if (dataTransfer.items && dataTransfer.items.length > 0) {
    const promises: Promise<File[]>[] = [];
    for (let i = 0; i < dataTransfer.items.length; i++) {
      const item = dataTransfer.items[i];
      if (item.kind === 'file') {
        const entry = (item as any).webkitGetAsEntry ? (item as any).webkitGetAsEntry() : null;
        if (entry) {
          promises.push(getFilesFromEntry(entry));
        } else {
          const file = item.getAsFile();
          if (file) collectedRawFiles.push(file);
        }
      }
    }
    const nested = await Promise.all(promises);
    for (const group of nested) {
      collectedRawFiles.push(...group);
    }
  } else if (dataTransfer.files && dataTransfer.files.length > 0) {
    for (let i = 0; i < dataTransfer.files.length; i++) {
      collectedRawFiles.push(dataTransfer.files[i]);
    }
  }

  return ingestFileList(collectedRawFiles, onProgress);
}


