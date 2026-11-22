/**
 * Browser entry point.
 *
 * Wires the real DOM to the pure modules:
 *   - keyboard / pointer lock  -> InputBuffer via bindInput
 *   - requestAnimationFrame    -> Game.update(realDelta)
 *   - the interpolated snapshot -> CanvasRenderer
 *   - HUD / overlay / pause menu -> DOM text
 *
 * All gameplay rules live in `src/`. This file is glue: read the clock, draw
 * the picture, write some text.
 *
 * Pause policy, stated once:
 *   - We play only while the pointer is locked.
 *   - Losing lock (Esc, alt-tab, click outside) pauses the game.
 *   - Clicking the canvas locks the pointer and resumes.
 *   - The pause menu is opened with P / Esc / the menu button and is the one
 *     place settings live; it does not need the pointer to be locked.
 */

import { buildCourse } from './src/game/course.ts';
import { Game, type FrameSnapshot, type GameEvent } from './src/game/loop.ts';
import { formatTime } from './src/game/run.ts';
import { InputBuffer, bindInput, KEY } from './src/input/input.ts';
import { CanvasRenderer } from './src/render/canvas.ts';
import {
  Records,
  browserStorage,
  loadSettings,
  memoryStorage,
  saveSettings,
  type Settings,
} from './src/game/save.ts';
import { GAME, VIEW } from './src/config.ts';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('This browser has no Canvas 2D support.');

const hud = {
  time: document.getElementById('hud-time')!,
  best: document.getElementById('hud-best')!,
  speed: document.getElementById('hud-speed')!,
  pad: document.getElementById('hud-pad')!,
  falls: document.getElementById('hud-falls')!,
  autohop: document.getElementById('hud-autohop')!,
  sync: document.getElementById('hud-sync')!,
};

const overlay = document.getElementById('overlay')!;
const overlayTitle = document.getElementById('overlay-title')!;
const overlayBody = document.getElementById('overlay-body')!;
const pauseMenu = document.getElementById('pause-menu')!;
const pauseToggle = document.getElementById('pause-toggle') as HTMLButtonElement;
const pauseRestart = document.getElementById('pause-restart') as HTMLButtonElement;
const pauseAutoHop = document.getElementById('pause-autohop') as HTMLInputElement;
const pauseSensitivity = document.getElementById('pause-sensitivity') as HTMLInputElement;
const pauseSensitivityLabel = document.getElementById('pause-sensitivity-value')!;
const pauseClear = document.getElementById('pause-clear') as HTMLButtonElement;

const storage = browserStorage();
const records = new Records(storage ?? memoryStorage());
const settings: Settings = loadSettings(storage);
const course = buildCourse();
const input = new InputBuffer({ maxEventPixels: VIEW.maxMouseEventPixels });
const game = new Game({
  course,
  input,
  records,
  autoHop: settings.autoHop,
  sensitivity: settings.sensitivity,
});

const renderer = new CanvasRenderer(ctx, canvas.width, canvas.height);
let lastFrame = performance.now();
let finishedShown = false;
let wantsLock = false;

// ---------------------------------------------------------------------------
// Canvas sizing: backing store at CSS pixels × devicePixelRatio (capped at 2).
// ---------------------------------------------------------------------------
function resize(): void {
  const dpr = Math.min(globalThis.devicePixelRatio ?? 1, 2);
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  renderer.resize(width, height);
}
globalThis.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Overlay / menu helpers
// ---------------------------------------------------------------------------
function showOverlay(title: string, body: string): void {
  overlayTitle.textContent = title;
  overlayBody.textContent = body;
  overlay.classList.remove('hidden');
}

function hideOverlay(): void {
  overlay.classList.add('hidden');
}

function showStartOverlay(): void {
  showOverlay(
    '🐇 Bunny Hop Chronicles',
    'Click to lock the mouse. W/A/S/D to move, Space or wheel to jump, and sweep the mouse mid-air to build speed. P pauses.',
  );
}

function syncPauseMenu(): void {
  pauseMenu.classList.toggle('hidden', !game.paused);
  pauseToggle.textContent = game.paused ? 'Resume' : 'Pause';
  pauseAutoHop.checked = game.autoHop;
  pauseSensitivity.value = String(game.sensitivity);
  pauseSensitivityLabel.textContent = `${game.sensitivity.toFixed(2)}×`;
}

function updateBestLabel(): void {
  const best = records.loadBest();
  hud.best.textContent = best ? formatTime(best.seconds) : '—';
}

function requestLock(): void {
  if (!canvas.requestPointerLock) {
    // Browser without pointer lock: play unlocked rather than not at all.
    game.setPaused(false);
    hideOverlay();
    return;
  }
  wantsLock = true;
  const result = canvas.requestPointerLock();
  if (result && typeof (result as Promise<void>).catch === 'function') {
    (result as Promise<void>).catch(() => {
      // Lock was refused (e.g. too soon after Esc). Stay paused and say so.
      wantsLock = false;
      game.setPaused(true);
      showOverlay('Click to resume', 'The browser needs a click on the game to capture the mouse.');
    });
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
bindInput(input, {
  keyboard: globalThis as unknown as {
    addEventListener(type: 'keydown' | 'keyup', handler: (e: KeyboardEvent) => void): void;
    removeEventListener(type: 'keydown' | 'keyup', handler: (e: KeyboardEvent) => void): void;
  },
  pointer: document,
  lockElement: canvas,
  requestLockOnClick: false,
  onLockChange: (locked) => {
    wantsLock = locked;
    if (locked) {
      if (finishedShown) return;
      game.setPaused(false);
      hideOverlay();
    } else if (!finishedShown) {
      // Losing lock pauses. The accumulator is reset inside Game.setPaused, so
      // returning to the tab never replays the time we were away.
      game.setPaused(true);
      showOverlay('Paused', 'Click the game to lock the mouse and resume.');
      syncPauseMenu();
    }
  },
  onBlur: (releaseAll) => {
    const onBlur = () => {
      releaseAll();
      if (!game.paused && !finishedShown) {
        game.setPaused(true);
        if (!document.pointerLockElement) showOverlay('Paused', 'Click to resume.');
        syncPauseMenu();
      }
    };
    const onVisibility = () => {
      if (document.hidden) onBlur();
    };
    globalThis.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      globalThis.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  },
});

document.addEventListener('keydown', (event) => {
  if (event.code === 'Escape') document.exitPointerLock?.();
});

canvas.addEventListener('click', () => {
  if (finishedShown) return;
  if (!document.pointerLockElement) requestLock();
});

// ---------------------------------------------------------------------------
// Pause menu
// ---------------------------------------------------------------------------
pauseToggle.addEventListener('click', () => {
  if (game.paused) {
    requestLock();
  } else {
    game.setPaused(true);
    document.exitPointerLock?.();
    syncPauseMenu();
  }
});

pauseRestart.addEventListener('click', () => {
  game.restart();
  finishedShown = false;
  game.setPaused(false);
  syncPauseMenu();
  requestLock();
});

pauseAutoHop.addEventListener('change', () => {
  game.setAutoHop(pauseAutoHop.checked);
  settings.autoHop = game.autoHop;
  saveSettings(storage, settings);
});

pauseSensitivity.addEventListener('input', () => {
  game.setSensitivity(Number(pauseSensitivity.value));
  settings.sensitivity = game.sensitivity;
  pauseSensitivityLabel.textContent = `${game.sensitivity.toFixed(2)}×`;
  saveSettings(storage, settings);
});

pauseClear.addEventListener('click', () => {
  records.clear();
  updateBestLabel();
});

// ---------------------------------------------------------------------------
// Per-frame rendering + HUD
// ---------------------------------------------------------------------------
game.setHooks({
  onFrame: (snapshot) => {
    render(snapshot);
    updateHud(snapshot);
  },
  onEvent: (event) => handleEvent(event),
});

function render(snapshot: FrameSnapshot): void {
  renderer.draw({
    previous: snapshot.previous,
    current: snapshot.body,
    // While paused, draw the latest committed tick exactly (no half-step).
    alpha: snapshot.paused ? 1 : snapshot.alpha,
    view: snapshot.view,
    run: snapshot.run,
    course,
    width: canvas.width,
    height: canvas.height,
  });
}

let lastSpeed = 0;
let syncSamples: number[] = [];

function updateHud(snapshot: FrameSnapshot): void {
  hud.time.textContent = formatTime(snapshot.run.elapsed);
  hud.speed.textContent = `${Math.round(snapshot.speed)} u/s`;
  hud.falls.textContent = String(snapshot.run.falls);
  hud.autohop.textContent = snapshot.autoHop ? 'ON' : 'OFF';

  const nextPad = course.pads[Math.min(snapshot.run.reachedPad + 1, course.pads.length - 1)];
  hud.pad.textContent = snapshot.run.reachedPad >= course.pads.length - 1 ? 'FINISH' : nextPad.name;

  // Strafe-sync meter: how much of the available per-tick air gain the last
  // few airborne ticks actually took. It only reads the player's own input;
  // it never supplies speed.
  if (!snapshot.body.onGround) {
    const gain = snapshot.speed - lastSpeed;
    const available = (60 * 30) / 128; // airAccel * airWishCap * dt
    syncSamples.push(Math.max(0, Math.min(1, gain / available)));
    if (syncSamples.length > 24) syncSamples.shift();
  } else {
    syncSamples = [];
  }
  lastSpeed = snapshot.speed;
  if (syncSamples.length > 0) {
    const avg = syncSamples.reduce((a, b) => a + b, 0) / syncSamples.length;
    const bars = Math.round(avg * 10);
    hud.sync.textContent = `${'█'.repeat(bars)}${'░'.repeat(10 - bars)}`;
  } else {
    hud.sync.textContent = '░░░░░░░░░░';
  }
}

let flashTimer: number | undefined;
function flash(message: string, color: string): void {
  overlayTitle.textContent = message;
  overlayTitle.style.color = color;
  overlayBody.textContent = '';
  overlay.classList.remove('hidden');
  if (flashTimer !== undefined) globalThis.clearTimeout(flashTimer);
  flashTimer = globalThis.setTimeout(() => {
    overlayTitle.style.color = '';
    if (!game.paused && !finishedShown) hideOverlay();
  }, 900);
}

function handleEvent(event: GameEvent): void {
  switch (event.type) {
    case 'checkpoint':
      flash(`${event.pad.name} — checkpoint`, '#48c78e');
      break;
    case 'fall':
      flash('Fell — back to checkpoint', '#f59e0b');
      break;
    case 'finish': {
      finishedShown = true;
      const best = records.loadBest();
      const isBest = event.best || (best !== null && Math.abs(best.seconds - event.seconds) < 1e-6);
      showOverlay(
        isBest ? 'New personal best!' : 'Course complete',
        `Time ${formatTime(event.seconds)} · ${game.run.falls} fall(s). Open the pause menu (P) and hit Restart to run it again.`,
      );
      updateBestLabel();
      document.exitPointerLock?.();
      break;
    }
    case 'start':
      if (!finishedShown) hideOverlay();
      break;
    case 'pause':
      syncPauseMenu();
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
function frame(now: number): void {
  const delta = (now - lastFrame) / 1000;
  lastFrame = now;
  game.update(delta);
  globalThis.requestAnimationFrame(frame);
}

updateBestLabel();
syncPauseMenu();
showStartOverlay();
// Start paused: the accumulator should not run while the overlay is up, and
// the first click will lock the pointer and start the clock.
game.setPaused(true);
globalThis.requestAnimationFrame(frame);

// A tiny debug handle for the acceptance script; harmless in play.
(globalThis as unknown as { bhop?: unknown }).bhop = {
  course,
  game,
  input,
  records,
  storageAvailable: storage !== null,
  keys: KEY,
  storageKey: GAME.storageKey,
  requestLock,
  surface: { canvas, overlay, pauseMenu },
};
