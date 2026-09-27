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
let activeHandlers: PipControlsHandlers | null = null;

export function updatePipHandlers(handlers: PipControlsHandlers): void {
  activeHandlers = handlers;
}

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

const ICON_PLAY = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>`;
const ICON_PREV = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z"></path><path d="M3 20V4"></path></svg>`;
const ICON_NEXT = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"></path><path d="M21 4v16"></path></svg>`;
const ICON_REWIND_1M = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6a2 2 0 0 0-3.414-1.414l-6 6a2 2 0 0 0 0 2.828l6 6A2 2 0 0 0 12 18z"></path><path d="M22 6a2 2 0 0 0-3.414-1.414l-6 6a2 2 0 0 0 0 2.828l6 6A2 2 0 0 0 22 18z"></path></svg>`;
const ICON_FORWARD_1M = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 12 18z"></path><path d="M2 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 2 18z"></path></svg>`;
const ICON_MUTE = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;
const ICON_UNMUTE = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>`;

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
        width: 390,
        height: 150,
      });
    } else {
      // Fallback popup window for browsers without documentPictureInPicture
      const left = window.screenLeft + (window.outerWidth - 390) - 20;
      const top = window.screenTop + 60;
      pipWin = window.open(
        '',
        'pwa_video_pip_controls',
        `width=390,height=150,left=${left},top=${top},resizable=yes,scrollbars=no,status=no`
      );
    }
  } catch (err) {
    console.warn('Could not open Picture-in-Picture controls window:', err);
    return false;
  }

  activePipWindow = pipWin;
  activeHandlers = handlers;

  // Build controls document
  const doc = pipWin.document;
  doc.title = 'Video Controls';

  // Inject sleek black & white CSS styling
  const style = doc.createElement('style');
  style.textContent = `
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    html, body {
      background: #000000;
      color: #ffffff;
      height: 100%;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      user-select: none;
      -webkit-user-select: none;
    }
    .pip-container {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      height: 100vh;
      padding: 12px 16px;
      background: #000000;
      box-sizing: border-box;
    }
    .pip-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #141414;
      border: 1px solid #262626;
      color: #ffffff;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
      outline: none;
    }
    .pip-btn:hover {
      background: #262626;
      border-color: #404040;
      color: #ffffff;
    }
    .pip-btn:active {
      transform: scale(0.93);
    }
    .pip-btn-play {
      background: #ffffff !important;
      border: 1px solid #ffffff !important;
      color: #000000 !important;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.12s ease, background 0.15s ease, box-shadow 0.15s ease;
      box-shadow: 0 2px 10px rgba(255, 255, 255, 0.25);
    }
    .pip-btn-play:hover {
      background: #f4f4f5 !important;
      transform: scale(1.06);
      box-shadow: 0 4px 16px rgba(255, 255, 255, 0.35);
    }
    .pip-btn-play:active {
      transform: scale(0.92);
    }
    .pip-range {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 4px;
      background: #262626;
      border-radius: 2px;
      outline: none;
      cursor: pointer;
      accent-color: #ffffff;
    }
    .pip-range::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #ffffff;
      cursor: pointer;
      box-shadow: 0 0 6px rgba(255, 255, 255, 0.7);
      transition: transform 0.1s ease;
    }
    .pip-range::-webkit-slider-thumb:hover {
      transform: scale(1.25);
    }
    .pip-range::-moz-range-thumb {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #ffffff;
      border: none;
      cursor: pointer;
    }
  `;
  doc.head.appendChild(style);

  const container = doc.createElement('div');
  container.className = 'pip-container';

  // 1. Top row: Badge, Title & Close
  const topRow = doc.createElement('div');
  topRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px;';

  const titleGroup = doc.createElement('div');
  titleGroup.style.cssText = 'display:flex; align-items:center; gap:8px; min-width:0; flex:1;';

  const badge = doc.createElement('span');
  badge.textContent = 'PIP';
  badge.style.cssText =
    'font-size:10px; font-weight:800; color:#000000; background:#ffffff; border-radius:4px; padding:2px 6px; letter-spacing:0.8px; flex-shrink:0;';
  titleGroup.appendChild(badge);

  const titleEl = doc.createElement('span');
  titleEl.id = 'pip-title';
  titleEl.textContent = handlers.getTitle();
  titleEl.style.cssText =
    'font-size:12px; font-weight:600; color:#f4f4f5; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
  titleGroup.appendChild(titleEl);

  topRow.appendChild(titleGroup);

  container.appendChild(topRow);

  // 2. Middle row: Timeline Scrubber
  const midRow = doc.createElement('div');
  midRow.style.cssText = 'display:flex; align-items:center; gap:10px; margin:4px 0;';

  const curTimeEl = doc.createElement('span');
  curTimeEl.id = 'pip-cur-time';
  curTimeEl.textContent = formatTime(handlers.getCurrentTime());
  curTimeEl.style.cssText =
    'font-size:11px; font-variant-numeric:tabular-nums; color:#a1a1aa; width:38px; text-align:right; flex-shrink:0; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-weight:500;';
  midRow.appendChild(curTimeEl);

  const scrubber = doc.createElement('input');
  scrubber.id = 'pip-scrubber';
  scrubber.type = 'range';
  scrubber.className = 'pip-range';
  scrubber.min = '0';
  const initialDur = handlers.getDuration();
  scrubber.max = String(initialDur > 0 ? initialDur : 100);
  scrubber.step = '0.1';
  scrubber.value = String(handlers.getCurrentTime());

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
    'font-size:11px; font-variant-numeric:tabular-nums; color:#a1a1aa; width:38px; flex-shrink:0; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-weight:500;';
  midRow.appendChild(durTimeEl);

  container.appendChild(midRow);

  // 3. Bottom row: Playback Controls (Clean Black & White)
  const botRow = doc.createElement('div');
  botRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px;';

  const leftControls = doc.createElement('div');
  leftControls.style.cssText = 'display:flex; align-items:center; gap:8px;';

  // Prev
  const prevBtn = doc.createElement('button');
  prevBtn.className = 'pip-btn';
  prevBtn.innerHTML = ICON_PREV;
  prevBtn.title = 'Previous Video';
  prevBtn.style.cssText = 'width:34px; height:34px; border-radius:8px;';
  prevBtn.onclick = () => {
    if (activeHandlers?.onPrev) activeHandlers.onPrev();
  };
  leftControls.appendChild(prevBtn);

  // Skip -1 minute
  const rewBtn = doc.createElement('button');
  rewBtn.className = 'pip-btn';
  rewBtn.innerHTML = ICON_REWIND_1M;
  rewBtn.title = 'Rewind 1 Minute (-60s)';
  rewBtn.style.cssText = 'width:34px; height:34px; border-radius:8px;';
  rewBtn.onclick = () => {
    if (activeHandlers?.onSkip) activeHandlers.onSkip(-60);
  };
  leftControls.appendChild(rewBtn);

  // Play/Pause (Pure White Button with Black Icon)
  const playBtn = doc.createElement('button');
  playBtn.id = 'pip-play-btn';
  playBtn.className = 'pip-btn-play';
  playBtn.innerHTML = handlers.getIsPlaying() ? ICON_PAUSE : ICON_PLAY;
  playBtn.title = handlers.getIsPlaying() ? 'Pause' : 'Play';
  playBtn.onclick = () => {
    if (activeHandlers?.onPlayPause) {
      activeHandlers.onPlayPause();
    }
  };
  leftControls.appendChild(playBtn);

  // Skip +1 minute
  const fwdBtn = doc.createElement('button');
  fwdBtn.className = 'pip-btn';
  fwdBtn.innerHTML = ICON_FORWARD_1M;
  fwdBtn.title = 'Fast Forward 1 Minute (+60s)';
  fwdBtn.style.cssText = 'width:34px; height:34px; border-radius:8px;';
  fwdBtn.onclick = () => {
    if (activeHandlers?.onSkip) activeHandlers.onSkip(60);
  };
  leftControls.appendChild(fwdBtn);

  // Next
  const nextBtn = doc.createElement('button');
  nextBtn.className = 'pip-btn';
  nextBtn.innerHTML = ICON_NEXT;
  nextBtn.title = 'Next Video';
  nextBtn.style.cssText = 'width:34px; height:34px; border-radius:8px;';
  nextBtn.onclick = () => {
    if (activeHandlers?.onNext) activeHandlers.onNext();
  };
  leftControls.appendChild(nextBtn);

  botRow.appendChild(leftControls);

  // Mute / Unmute
  const muteBtn = doc.createElement('button');
  muteBtn.id = 'pip-mute-btn';
  muteBtn.className = 'pip-btn';
  muteBtn.innerHTML = handlers.getIsMuted() ? ICON_MUTE : ICON_UNMUTE;
  muteBtn.title = handlers.getIsMuted() ? 'Unmute' : 'Mute';
  muteBtn.style.cssText = 'width:34px; height:34px; border-radius:8px;';
  muteBtn.onclick = () => {
    if (activeHandlers?.onToggleMute) {
      activeHandlers.onToggleMute();
      const muted = activeHandlers.getIsMuted ? activeHandlers.getIsMuted() : false;
      muteBtn.innerHTML = muted ? ICON_MUTE : ICON_UNMUTE;
      muteBtn.title = muted ? 'Unmute' : 'Mute';
    }
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
      playBtn.innerHTML = isPlaying ? ICON_PAUSE : ICON_PLAY;
      playBtn.title = isPlaying ? 'Pause' : 'Play';
    }

    if (isMuted !== undefined) {
      const muteBtn = doc.getElementById('pip-mute-btn');
      if (muteBtn) {
        muteBtn.innerHTML = isMuted ? ICON_MUTE : ICON_UNMUTE;
        muteBtn.title = isMuted ? 'Unmute' : 'Mute';
      }
    }
  } catch {}
}
