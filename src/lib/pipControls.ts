/**
 * Floating Picture-in-Picture Video Controls Window
 * Uses Document Picture-in-Picture API (or popup window fallback)
 * to display ONLY the video playback controls in an always-on-top window,
 * leaving the actual video playing on the main screen.
 */

export interface PipControlsHandlers {
  getTitle: () => string;
  getCurrentTime: () => number;
  getDuration: () => number;
  getIsPlaying: () => boolean;
  getIsMuted: () => boolean;
  onPlayPause: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (time: number) => void;
  onSkip: (deltaSeconds: number) => void;
  onToggleMute: () => void;
  onClose?: () => void;
}

let activePipWindow: any = null;
let isUserScrubbingPip = false;

function formatTime(secs: number): string {
  if (!secs || isNaN(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export function isPipControlsActive(): boolean {
  return activePipWindow !== null && !activePipWindow.closed;
}

export function closePipControls(): void {
  if (activePipWindow) {
    try {
      activePipWindow.close();
    } catch {}
    activePipWindow = null;
  }
}

export async function openPipControls(handlers: PipControlsHandlers): Promise<boolean> {
  // If already open, close it (toggle behavior)
  if (isPipControlsActive()) {
    closePipControls();
    return false;
  }

  const docPip = typeof window !== 'undefined' && (window as any).documentPictureInPicture;
  let pipWin: any = null;

  try {
    if (docPip && typeof docPip.requestWindow === 'function') {
      pipWin = await docPip.requestWindow({
        width: 380,
        height: 160,
      });
    } else {
      // Fallback popup window for browsers without documentPictureInPicture
      const left = window.screenLeft + (window.outerWidth - 380) - 20;
      const top = window.screenTop + 60;
      pipWin = window.open(
        '',
        'pwa_video_pip_controls',
        `width=380,height=160,left=${left},top=${top},resizable=yes,scrollbars=no,status=no`
      );
    }
  } catch (err) {
    console.warn('Could not open Picture-in-Picture controls window:', err);
    return false;
  }

  if (!pipWin) return false;

  activePipWindow = pipWin;

  // Build controls document
  const doc = pipWin.document;
  doc.title = 'Video Controls';
  doc.body.style.margin = '0';
  doc.body.style.padding = '0';
  doc.body.style.background = '#0a0a0a';
  doc.body.style.color = '#ffffff';
  doc.body.style.overflow = 'hidden';
  doc.body.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  const container = doc.createElement('div');
  container.style.cssText =
    'display:flex; flex-direction:column; justify-content:space-between; height:100vh; padding:12px 14px; box-sizing:border-box; background:#0f172a; color:#fff; user-select:none;';

  // 1. Top row: Badge, Title & Close
  const topRow = doc.createElement('div');
  topRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px;';

  const titleGroup = doc.createElement('div');
  titleGroup.style.cssText = 'display:flex; align-items:center; gap:6px; min-width:0; flex:1;';

  const badge = doc.createElement('span');
  badge.textContent = 'PIP CONTROLS';
  badge.style.cssText =
    'font-size:10px; font-weight:800; color:#f59e0b; background:rgba(245,158,11,0.15); border:1px solid rgba(245,158,11,0.3); border-radius:4px; padding:2px 6px; letter-spacing:0.5px; flex-shrink:0;';
  titleGroup.appendChild(badge);

  const titleEl = doc.createElement('span');
  titleEl.id = 'pip-title';
  titleEl.textContent = handlers.getTitle();
  titleEl.style.cssText =
    'font-size:12px; font-weight:600; color:#f1f5f9; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
  titleGroup.appendChild(titleEl);

  topRow.appendChild(titleGroup);

  const closeBtn = doc.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close Floating Controls';
  closeBtn.style.cssText =
    'background:rgba(255,255,255,0.08); border:none; color:#94a3b8; font-size:12px; cursor:pointer; width:22px; height:22px; border-radius:6px; display:flex; align-items:center; justify-content:center; flex-shrink:0;';
  closeBtn.onmouseenter = () => { closeBtn.style.color = '#fff'; closeBtn.style.background = 'rgba(255,255,255,0.18)'; };
  closeBtn.onmouseleave = () => { closeBtn.style.color = '#94a3b8'; closeBtn.style.background = 'rgba(255,255,255,0.08)'; };
  closeBtn.onclick = () => {
    closePipControls();
  };
  topRow.appendChild(closeBtn);

  container.appendChild(topRow);

  // 2. Middle row: Timeline Scrubber
  const midRow = doc.createElement('div');
  midRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin:4px 0;';

  const curTimeEl = doc.createElement('span');
  curTimeEl.id = 'pip-cur-time';
  curTimeEl.textContent = formatTime(handlers.getCurrentTime());
  curTimeEl.style.cssText =
    'font-size:11px; font-variant-numeric:tabular-nums; color:#94a3b8; width:38px; text-align:right; flex-shrink:0; font-family:monospace;';
  midRow.appendChild(curTimeEl);

  const scrubber = doc.createElement('input');
  scrubber.id = 'pip-scrubber';
  scrubber.type = 'range';
  scrubber.min = '0';
  const initialDur = handlers.getDuration();
  scrubber.max = String(initialDur > 0 ? initialDur : 100);
  scrubber.step = '0.1';
  scrubber.value = String(handlers.getCurrentTime());
  scrubber.style.cssText =
    'flex:1; height:4px; accent-color:#f59e0b; cursor:pointer; background:#334155; border-radius:2px;';

  scrubber.onmousedown = () => { isUserScrubbingPip = true; };
  scrubber.ontouchstart = () => { isUserScrubbingPip = true; };
  scrubber.oninput = () => {
    const val = parseFloat(scrubber.value);
    curTimeEl.textContent = formatTime(val);
  };
  scrubber.onchange = () => {
    isUserScrubbingPip = false;
    const val = parseFloat(scrubber.value);
    handlers.onSeek(val);
  };
  scrubber.onmouseup = () => { isUserScrubbingPip = false; };
  scrubber.ontouchend = () => { isUserScrubbingPip = false; };

  // Safety listeners on document to release scrubbing state if mouse leaves window
  doc.addEventListener('pointerup', () => { isUserScrubbingPip = false; });
  doc.addEventListener('touchend', () => { isUserScrubbingPip = false; });

  midRow.appendChild(scrubber);

  const durTimeEl = doc.createElement('span');
  durTimeEl.id = 'pip-dur-time';
  durTimeEl.textContent = formatTime(initialDur);
  durTimeEl.style.cssText =
    'font-size:11px; font-variant-numeric:tabular-nums; color:#94a3b8; width:38px; flex-shrink:0; font-family:monospace;';
  midRow.appendChild(durTimeEl);

  container.appendChild(midRow);

  // 3. Bottom row: Playback Controls
  const botRow = doc.createElement('div');
  botRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:6px;';

  const leftControls = doc.createElement('div');
  leftControls.style.cssText = 'display:flex; align-items:center; gap:8px;';

  // Prev
  const prevBtn = doc.createElement('button');
  prevBtn.innerHTML = '⏮';
  prevBtn.title = 'Previous Video';
  prevBtn.style.cssText =
    'background:#1e293b; border:1px solid #334155; color:#f8fafc; border-radius:8px; width:34px; height:34px; font-size:14px; cursor:pointer; display:flex; align-items:center; justify-content:center;';
  prevBtn.onclick = () => handlers.onPrev();
  leftControls.appendChild(prevBtn);

  // -10s
  const rewBtn = doc.createElement('button');
  rewBtn.textContent = '-10s';
  rewBtn.title = 'Rewind 10 Seconds';
  rewBtn.style.cssText =
    'background:#1e293b; border:1px solid #334155; color:#94a3b8; border-radius:8px; padding:0 8px; height:34px; font-size:11px; font-weight:600; cursor:pointer;';
  rewBtn.onclick = () => handlers.onSkip(-10);
  leftControls.appendChild(rewBtn);

  // Play/Pause
  const playBtn = doc.createElement('button');
  playBtn.id = 'pip-play-btn';
  playBtn.innerHTML = handlers.getIsPlaying() ? '⏸' : '▶';
  playBtn.title = handlers.getIsPlaying() ? 'Pause' : 'Play';
  playBtn.style.cssText =
    'background:#f59e0b; border:none; color:#0f172a; border-radius:50%; width:38px; height:38px; font-size:16px; font-weight:bold; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 12px rgba(245,158,11,0.3);';
  playBtn.onclick = () => {
    handlers.onPlayPause();
  };
  leftControls.appendChild(playBtn);

  // +10s
  const fwdBtn = doc.createElement('button');
  fwdBtn.textContent = '+10s';
  fwdBtn.title = 'Forward 10 Seconds';
  fwdBtn.style.cssText =
    'background:#1e293b; border:1px solid #334155; color:#94a3b8; border-radius:8px; padding:0 8px; height:34px; font-size:11px; font-weight:600; cursor:pointer;';
  fwdBtn.onclick = () => handlers.onSkip(10);
  leftControls.appendChild(fwdBtn);

  // Next
  const nextBtn = doc.createElement('button');
  nextBtn.innerHTML = '⏭';
  nextBtn.title = 'Next Video';
  nextBtn.style.cssText =
    'background:#1e293b; border:1px solid #334155; color:#f8fafc; border-radius:8px; width:34px; height:34px; font-size:14px; cursor:pointer; display:flex; align-items:center; justify-content:center;';
  nextBtn.onclick = () => handlers.onNext();
  leftControls.appendChild(nextBtn);

  botRow.appendChild(leftControls);

  // Mute
  const muteBtn = doc.createElement('button');
  muteBtn.id = 'pip-mute-btn';
  muteBtn.innerHTML = handlers.getIsMuted() ? '🔇' : '🔊';
  muteBtn.title = handlers.getIsMuted() ? 'Unmute' : 'Mute';
  muteBtn.style.cssText =
    'background:#1e293b; border:1px solid #334155; color:#94a3b8; border-radius:8px; width:34px; height:34px; font-size:14px; cursor:pointer; display:flex; align-items:center; justify-content:center;';
  muteBtn.onclick = () => {
    handlers.onToggleMute();
    muteBtn.innerHTML = handlers.getIsMuted() ? '🔇' : '🔊';
  };
  botRow.appendChild(muteBtn);

  container.appendChild(botRow);
  doc.body.appendChild(container);

  pipWin.addEventListener('pagehide', () => {
    activePipWindow = null;
    if (handlers.onClose) {
      handlers.onClose();
    }
  });

  return true;
}

export function updatePipControlsState(
  currentTime: number,
  duration: number,
  isPlaying: boolean,
  trackName?: string,
  isMuted?: boolean
): void {
  if (!activePipWindow || activePipWindow.closed) return;

  try {
    const doc = activePipWindow.document;
    if (!doc) return;

    if (trackName) {
      const titleEl = doc.getElementById('pip-title');
      if (titleEl && titleEl.textContent !== trackName) {
        titleEl.textContent = trackName;
      }
    }

    const scrubber = doc.getElementById('pip-scrubber') as HTMLInputElement | null;
    const durTimeEl = doc.getElementById('pip-dur-time');

    if (duration > 0) {
      if (scrubber && parseFloat(scrubber.max) !== duration) {
        scrubber.max = String(duration);
      }
      if (durTimeEl) {
        durTimeEl.textContent = formatTime(duration);
      }
    } else {
      if (scrubber && parseFloat(scrubber.max) !== 100) {
        scrubber.max = '100';
      }
      if (durTimeEl) {
        durTimeEl.textContent = '0:00';
      }
    }

    if (!isUserScrubbingPip) {
      if (scrubber) {
        scrubber.value = String(currentTime);
      }
      const curTimeEl = doc.getElementById('pip-cur-time');
      if (curTimeEl) {
        curTimeEl.textContent = formatTime(currentTime);
      }
    }

    const playBtn = doc.getElementById('pip-play-btn');
    if (playBtn) {
      playBtn.innerHTML = isPlaying ? '⏸' : '▶';
      playBtn.title = isPlaying ? 'Pause' : 'Play';
    }

    if (isMuted !== undefined) {
      const muteBtn = doc.getElementById('pip-mute-btn');
      if (muteBtn) {
        muteBtn.innerHTML = isMuted ? '🔇' : '🔊';
      }
    }
  } catch {}
}
