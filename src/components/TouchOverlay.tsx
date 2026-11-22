import { useState, useRef, useCallback, useEffect, useSyncExternalStore } from 'react';
import { gameSession } from '../lib/sessionStore';
import { TouchInputController, type TouchPoint } from '../lib/touchInput';
import { audioManager } from '../lib/audio';
import { useGameSession } from '../hooks/useGameSession';

function toPoints(e: TouchEvent): TouchPoint[] {
  return Array.from(e.changedTouches).map((touch) => ({
    identifier: touch.identifier,
    x: touch.clientX,
    y: touch.clientY,
  }));
}

/**
 * Full-screen touch surface.
 *
 * This is the touch input path. It does not synthesise KeyboardEvents:
 * `TouchInputController` reports presses/releases straight to the shared
 * `gameSession` with one source id per touch point, so touch gets the same
 * "already pressed" dedup as the keyboard. Sliding between zones releases the
 * old note before pressing the new one; leaving the board, `touchcancel`,
 * a level switch and unmount all release the held note.
 */
function TouchOverlay() {
  const { generation } = useGameSession();
  const zoneRefs = useRef<(HTMLDivElement | null)[]>([]);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [controller] = useState(
    () =>
      new TouchInputController({
        press: (code, source) => gameSession.press(code, source),
        release: (code, source) => gameSession.release(code, source),
        startAudio: () => {
          if (!audioManager.isInitialized()) {
            void audioManager.start().catch(() => {
              // Audio is best-effort; gameplay continues silently on failure.
            });
          }
        },
        getZoneAt: (x, y) => {
          for (let i = 0; i < zoneRefs.current.length; i++) {
            const node = zoneRefs.current[i];
            if (!node) continue;
            const rect = node.getBoundingClientRect();
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
              return i;
            }
          }
          return -1;
        },
      }),
  );

  // Zone highlight state is derived from the controller so it always matches
  // which notes are actually held (including after a moved-out/cancelled touch).
  const subscribe = useCallback(
    (listener: () => void) => controller.onChange(listener),
    [controller],
  );
  const pressedZones = useSyncExternalStore(
    subscribe,
    () => controller.zonesSnapshot,
    () => controller.zonesSnapshot,
  ) as boolean[];

  // A level generation change means the session cleared all held keys; drop
  // any touch bookkeeping so the overlay cannot reference a stale note.
  useEffect(() => {
    controller.releaseAll();
    return () => {
      controller.releaseAll();
    };
  }, [controller, generation]);

  useEffect(() => {
    const overlayNode = overlayRef.current;
    if (!overlayNode) return;

    const handleTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      controller.touchStart(toPoints(e));
    };
    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      controller.touchMove(toPoints(e));
    };
    const handleTouchEndOrCancel = (e: TouchEvent) => {
      e.preventDefault();
      controller.touchEnd(toPoints(e));
    };

    overlayNode.addEventListener('touchstart', handleTouchStart as EventListener, { passive: false });
    overlayNode.addEventListener('touchmove', handleTouchMove as EventListener, { passive: false });
    overlayNode.addEventListener('touchend', handleTouchEndOrCancel as EventListener, { passive: false });
    overlayNode.addEventListener('touchcancel', handleTouchEndOrCancel as EventListener, { passive: false });

    return () => {
      overlayNode.removeEventListener('touchstart', handleTouchStart as EventListener);
      overlayNode.removeEventListener('touchmove', handleTouchMove as EventListener);
      overlayNode.removeEventListener('touchend', handleTouchEndOrCancel as EventListener);
      overlayNode.removeEventListener('touchcancel', handleTouchEndOrCancel as EventListener);
    };
  }, [controller]);

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-10 flex flex-col"
      style={{ touchAction: 'none' }}
    >
      <div className="grow flex">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            ref={el => { zoneRefs.current[i] = el; }}
            className={`flex-1 h-full border-r border-white/10 ${
              pressedZones[i] ? 'bg-white/30' : 'bg-transparent'
            } transition-colors duration-200`}
          />
        ))}
      </div>
      <div
        ref={el => { zoneRefs.current[8] = el; }}
        className={`h-1/5 border-t border-white/10 ${
          pressedZones[8] ? 'bg-white/30' : 'bg-transparent'
        } transition-colors duration-200`}
      />
    </div>
  );
}

export default TouchOverlay;
