import { useEffect, useCallback, useRef } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { restartTokenAtom, screenAtom } from '../atoms/gameAtoms';
import { audioManager } from '../lib/audio';
import { gameSession } from '../lib/sessionStore';
import { KeyboardInputController } from '../lib/keyboardInput';

/**
 * Mounts the single keyboard input path for the whole app.
 * All dedup / auto-repeat / cross-level key-hold handling lives in
 * `KeyboardInputController`, which is shared with the test suite.
 */
export function useGameLogic() {
  const setRestartToken = useSetAtom(restartTokenAtom);
  const [screen] = useAtom(screenAtom);
  const screenRef = useRef(screen);

  // Keep the latest screen without re-registering listeners (which would
  // drop the physically-held key set on every screen change).
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  useEffect(() => {
    const controller = new KeyboardInputController({
      isLevelActive: () => gameSession.getSnapshot().active,
      isMenu: () => screenRef.current === 'levelSelect',
      press: (code) => gameSession.press(code, 'keyboard'),
      release: (code) => gameSession.release(code, 'keyboard'),
      startAudio: () => {
        if (!audioManager.isInitialized()) {
          void audioManager.start().catch(() => {
            // Audio is best-effort; gameplay continues silently on failure.
          });
        }
      },
      playMenuNote: (key) => audioManager.playNote(key),
      releaseMenuNote: (key) => audioManager.releaseNote(key),
      releaseAllHeld: () => {
        gameSession.releaseSource('keyboard');
        audioManager.releaseAll();
      },
    });

    const handleKeyDown = (e: KeyboardEvent) => controller.handleKeyDown(e);
    const handleKeyUp = (e: KeyboardEvent) => controller.handleKeyUp(e);
    const handleBlur = () => controller.handleBlur();
    const handleVisibility = () => {
      if (document.hidden) controller.handleBlur();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibility);
      controller.handleBlur();
    };
  }, []);

  const resetGameState = useCallback(() => {
    setRestartToken((token) => token + 1);
  }, [setRestartToken]);

  return { resetGameState };
}
