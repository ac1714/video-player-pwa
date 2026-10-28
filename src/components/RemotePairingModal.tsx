/**
 * Phone Remote pairing modal (Chromebook side).
 * Shows a QR code once; afterwards the phone reconnects automatically.
 */

import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Smartphone, X, Copy, Check, RotateCcw, Power, Wifi, Loader2, AlertTriangle, PauseCircle } from 'lucide-react';
import { remoteHost, type HostStatusSnapshot } from '../lib/remote/remoteHost';
import { getRemoteUrl } from '../lib/remote/protocol';
import { setDeviceRole } from '../lib/remote/remoteClient';

interface Props {
  status: HostStatusSnapshot;
  onClose: () => void;
}

export function RemoteStatusDot({ status }: { status: HostStatusSnapshot }) {
  const connected = status.connectedDevices.length > 0;
  const cls = !status.enabled
    ? 'bg-neutral-400'
    : connected
    ? 'bg-emerald-500'
    : status.status === 'online'
    ? 'bg-sky-500'
    : status.status === 'error'
    ? 'bg-rose-500'
    : 'bg-amber-500 animate-pulse';
  return (
    <span className="relative flex h-2 w-2">
      {connected && <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${cls}`} />
    </span>
  );
}

export const RemotePairingModal: React.FC<Props> = ({ status, onClose }) => {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const pairing = status.pairing;
  const url = pairing && status.enabled ? getRemoteUrl(pairing) : null;

  useEffect(() => {
    if (!url) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(url, { margin: 1, width: 480, errorCorrectionLevel: 'M', color: { dark: '#0a0a0a', light: '#ffffff' } })
      .then((d) => !cancelled && setQrDataUrl(d))
      .catch(() => !cancelled && setQrDataUrl(null));
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copyLink = () => {
    if (!url) return;
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const statusLine = (() => {
    if (!status.enabled) return { icon: <Power className="w-3.5 h-3.5" />, text: 'Phone remote is off', tone: 'text-neutral-500' };
    if (status.connectedDevices.length > 0)
      return {
        icon: <Wifi className="w-3.5 h-3.5" />,
        text: `Connected: ${status.connectedDevices.join(', ')}`,
        tone: 'text-emerald-600 dark:text-emerald-400',
      };
    switch (status.status) {
      case 'online':
        return { icon: <Wifi className="w-3.5 h-3.5" />, text: 'Ready — waiting for your phone', tone: 'text-sky-600 dark:text-sky-400' };
      case 'standby':
        return {
          icon: <PauseCircle className="w-3.5 h-3.5" />,
          text: 'Another Video Player tab is hosting the remote',
          tone: 'text-neutral-500',
        };
      case 'error':
        return { icon: <AlertTriangle className="w-3.5 h-3.5" />, text: status.error || 'Error', tone: 'text-rose-600 dark:text-rose-400' };
      default:
        return {
          icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
          text: status.error || 'Connecting to pairing server…',
          tone: 'text-amber-600 dark:text-amber-400',
        };
    }
  })();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="remote-pairing-title"
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 p-5 shadow-2xl text-neutral-900 dark:text-neutral-100 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 text-black">
              <Smartphone className="w-4 h-4" />
            </div>
            <div>
              <h3 id="remote-pairing-title" className="text-sm font-bold">
                Phone Remote
              </h3>
              <p className="text-[11px] text-neutral-500">Control playback without touching your cast session</p>
            </div>
          </div>
          <button id="remote-modal-close-btn" onClick={onClose} className="p-1 text-neutral-400 hover:text-neutral-900 dark:hover:text-white cursor-pointer" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className={`flex items-center gap-2 text-xs font-medium ${statusLine.tone}`}>
          {statusLine.icon}
          <span className="truncate">{statusLine.text}</span>
        </div>

        {/* Quick action to switch THIS device to Remote Control */}
        <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold text-amber-600 dark:text-amber-400">Using this device as your remote?</p>
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate">Switch to the mobile remote interface</p>
          </div>
          <button
            id="modal-open-remote-mode-btn"
            onClick={() => {
              setDeviceRole('remote');
              const u = new URL(window.location.href);
              u.searchParams.set('view', 'remote');
              window.location.href = u.toString();
            }}
            className="shrink-0 px-3 py-1.5 rounded-lg bg-gradient-to-r from-amber-400 to-orange-500 hover:brightness-110 text-black text-xs font-bold active:scale-95 transition shadow-sm"
          >
            Open Remote
          </button>
        </div>

        {!status.enabled ? (
          <div className="space-y-3">
            <div className="p-3 rounded-xl bg-neutral-100 dark:bg-neutral-900 text-xs text-neutral-600 dark:text-neutral-400 space-y-1.5">
              <p>Pair your phone once by scanning a QR code. After that it reconnects automatically whenever you open the remote — no rescanning.</p>
              <p>Commands go directly between your devices on your Wi-Fi; your videos never leave this computer.</p>
            </div>
            <button
              id="remote-enable-btn"
              onClick={() => remoteHost.enable()}
              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 hover:brightness-110 text-black text-sm font-bold transition cursor-pointer active:scale-[0.98] shadow-lg shadow-amber-500/20"
            >
              Enable Phone Remote
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-col items-center gap-3">
              <div className="relative p-3 rounded-2xl bg-white shadow-inner border border-neutral-200">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="QR code to pair your phone" className="w-56 h-56" />
                ) : (
                  <div className="w-56 h-56 flex items-center justify-center text-neutral-400">
                    <Loader2 className="w-6 h-6 animate-spin" />
                  </div>
                )}
              </div>
              <p className="text-xs text-neutral-500 text-center max-w-xs">
                Scan with your phone’s camera. Then use <span className="font-semibold">Add to Home screen</span> on the phone for one-tap access later.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                id="remote-copy-link-btn"
                onClick={copyLink}
                className="flex items-center justify-center gap-1.5 py-2 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-semibold transition cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy link'}
              </button>
              <button
                id="remote-disable-btn"
                onClick={() => remoteHost.disable()}
                className="flex items-center justify-center gap-1.5 py-2 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-semibold transition cursor-pointer"
              >
                <Power className="w-3.5 h-3.5" />
                Turn off
              </button>
            </div>

            <div className="pt-2 border-t border-neutral-200 dark:border-neutral-800">
              {confirmReset ? (
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-rose-600 dark:text-rose-400 font-medium">Unpair all phones?</span>
                  <div className="flex gap-2">
                    <button onClick={() => setConfirmReset(false)} className="px-2.5 py-1 rounded-md text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer">
                      Cancel
                    </button>
                    <button
                      id="remote-confirm-reset-btn"
                      onClick={() => {
                        remoteHost.resetPairing();
                        setConfirmReset(false);
                      }}
                      className="px-2.5 py-1 rounded-md bg-rose-500 text-white font-semibold cursor-pointer"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  id="remote-reset-pairing-btn"
                  onClick={() => setConfirmReset(true)}
                  className="w-full flex items-center justify-between text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 transition cursor-pointer"
                >
                  <span>Reset pairing (forget all phones)</span>
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </>
        )}

        <p className="text-[11px] text-neutral-400 leading-relaxed">
          Keep this Video Player page open while casting. Tip: play the first video from this computer each session so the
          browser grants folder access — after that the phone can switch videos freely.
        </p>
      </div>
    </div>
  );
};
