/**
 * Video File Rename Modal
 * 
 * Supports:
 * 1. Renaming the video record in the PWA IndexedDB database and all active playlists
 * 2. Renaming the actual physical file on the user's hard drive / Chromebook via FileSystemFileHandle.move()
 *    when browser File System Access API readwrite permissions are available
 */

import React, { useEffect, useState, useRef } from 'react';
import { Edit2, HardDrive, Info, X, Check, FileVideo } from 'lucide-react';
import { MediaFile } from '../types';
import { renameMediaFile } from '../lib/db';
import { syncChannel } from '../lib/syncChannel';

interface RenameModalProps {
  file: MediaFile | null;
  onClose: () => void;
  onSuccess: (updated: { id: string; name: string; renamedOnDisk: boolean; message: string }) => void;
}

export const RenameModal: React.FC<RenameModalProps> = ({ file, onClose, onSuccess }) => {
  const [nameWithoutExt, setNameWithoutExt] = useState<string>('');
  const [extension, setExtension] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (file) {
      const lastDot = file.name.lastIndexOf('.');
      if (lastDot !== -1) {
        setNameWithoutExt(file.name.slice(0, lastDot));
        setExtension(file.name.slice(lastDot));
      } else {
        setNameWithoutExt(file.name);
        setExtension('');
      }
      setErrorMessage(null);
      setTimeout(() => inputRef.current?.select(), 80);
    }
  }, [file]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!file) return null;

  const hasPhysicalHandle = Boolean(file.handle && typeof (file.handle as any).move === 'function');

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = nameWithoutExt.trim();
    if (!trimmed) {
      setErrorMessage('Filename cannot be empty.');
      return;
    }

    const finalName = `${trimmed}${extension}`;
    if (finalName === file.name) {
      onClose();
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const result = await renameMediaFile(file.id, finalName);
      if (result.success) {
        syncChannel.post({
          type: 'FILE_RENAMED',
          payload: {
            trackId: file.id,
            newName: result.finalName,
            renamedOnDisk: result.renamedOnDisk,
          },
        });
        onSuccess({
          id: file.id,
          name: result.finalName,
          renamedOnDisk: result.renamedOnDisk,
          message: result.message,
        });
        onClose();
      } else {
        setErrorMessage(result.message);
      }
    } catch (err: any) {
      console.error('Rename error:', err);
      setErrorMessage(err?.message || 'Failed to rename video.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        id="rename-file-modal"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 p-5 shadow-2xl text-neutral-900 dark:text-neutral-100 space-y-4 animate-in fade-in duration-150"
      >
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <Edit2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-neutral-900 dark:text-neutral-100">
                Rename Video File
              </h3>
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                Update how this video is named
              </p>
            </div>
          </div>
          <button
            id="close-rename-modal-btn"
            onClick={onClose}
            className="p-1 text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition cursor-pointer"
            title="Cancel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Current Path Info */}
        <div className="p-2.5 rounded-lg bg-neutral-100 dark:bg-neutral-900/80 border border-neutral-200 dark:border-neutral-800 text-xs space-y-1">
          <div className="flex items-center gap-1.5 text-neutral-500">
            <FileVideo className="w-3.5 h-3.5" />
            <span className="font-semibold text-neutral-700 dark:text-neutral-300">Current filename:</span>
          </div>
          <p className="font-mono text-[11px] text-neutral-800 dark:text-neutral-200 truncate pl-5" title={file.name}>
            {file.name}
          </p>
          {file.relativePath && file.relativePath !== file.name && (
            <p className="text-[10px] text-neutral-400 truncate pl-5">
              Folder: {file.relativePath}
            </p>
          )}
        </div>

        {/* Rename Form */}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="rename-input" className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1.5">
              New Name
            </label>
            <div className="flex items-center rounded-lg bg-neutral-100 dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 focus-within:ring-2 focus-within:ring-amber-500 overflow-hidden">
              <input
                id="rename-input"
                ref={inputRef}
                type="text"
                value={nameWithoutExt}
                onChange={(e) => setNameWithoutExt(e.target.value)}
                placeholder="Enter new filename..."
                className="flex-1 px-3 py-2 text-xs bg-transparent outline-none text-neutral-900 dark:text-neutral-100 font-medium"
              />
              {extension && (
                <span className="px-2.5 py-2 text-xs text-neutral-400 bg-neutral-200 dark:bg-neutral-800 font-mono select-none border-l border-neutral-300 dark:border-neutral-700">
                  {extension}
                </span>
              )}
            </div>
          </div>

          {/* Capability Explanation Banner */}
          <div className={`p-2.5 rounded-lg border text-[11px] leading-relaxed flex items-start gap-2 ${
            hasPhysicalHandle
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-900 dark:text-emerald-200'
              : 'bg-amber-500/10 border-amber-500/30 text-amber-900 dark:text-amber-200'
          }`}>
            <HardDrive className="w-3.5 h-3.5 shrink-0 mt-0.5 text-current opacity-80" />
            <p>
              {hasPhysicalHandle
                ? 'Direct Disk Access: Your browser will also rename the physical file on your Chromebook/hard drive.'
                : 'Library Name: Will rename this video in your PWA catalog & playlists (disk file unchanged as it was imported without a direct writable handle).'}
            </p>
          </div>

          {errorMessage && (
            <p className="text-xs text-rose-500 font-medium">{errorMessage}</p>
          )}

          {/* Modal Actions */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-neutral-200 dark:border-neutral-800">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-3.5 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-semibold text-neutral-700 dark:text-neutral-300 transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              id="confirm-rename-btn"
              type="submit"
              disabled={isSubmitting || !nameWithoutExt.trim()}
              className="px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold transition shadow-sm cursor-pointer disabled:opacity-40 flex items-center gap-1.5 active:scale-95"
            >
              <Check className="w-3.5 h-3.5" />
              <span>{isSubmitting ? 'Renaming...' : 'Save & Rename'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
