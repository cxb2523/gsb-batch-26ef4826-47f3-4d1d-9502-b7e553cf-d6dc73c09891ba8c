import { useLayoutEffect, useEffect, useState, Suspense } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  currentLevelAtom,
  levelDataAtom,
  screenAtom,
  finalTimeAtom,
  restartTokenAtom,
} from '../atoms/gameAtoms';
import { gameSession } from '../lib/sessionStore';
import { useGameSession } from '../hooks/useGameSession';
import Dot from './Dot';
import { KEY_LABELS } from '../lib/keymap';
import type { Level } from '../lib/level';

/**
 * Ticks a re-render every animation frame while `enabled`, so the elapsed
 * time label stays live. The timer origin itself lives in the game session
 * and is only set by a real key/touch press.
 */
function useAnimationTick(enabled: boolean) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const loop = () => {
      setTick((tick) => (tick + 1) % 100000);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [enabled]);
}

function Timer({ startTime }: { startTime: number }) {
  useAnimationTick(startTime !== 0);

  return (
    <span className="text-2xl font-bold min-w-20 text-right">
      {startTime === 0 ? '0.00s' : `${((Date.now() - startTime) / 1000).toFixed(2)}s`}
    </span>
  );
}

/**
 * Loads the selected level, then binds the shared game session to it.
 * Data is fetched under Suspense and the session only begins once it is in
 * hand, so input can never reach a half-initialised level.
 *
 * On mount / level change / restart token it calls `begin`, which opens a new
 * audio session and resets held keys, player state, step and timer origin.
 * On unmount (back to menu, level finished) it calls `stop`, releasing notes.
 * Because this is a `useLayoutEffect`, all of that happens before paint.
 */
function LevelSession({ children }: { children: (level: Level) => React.ReactNode }) {
  const level = useAtomValue(currentLevelAtom);
  const restartToken = useAtomValue(restartTokenAtom);
  const setLevelData = useSetAtom(levelDataAtom);
  const setFinalTime = useSetAtom(finalTimeAtom);
  const setScreen = useSetAtom(screenAtom);
  // The level the session has actually been begun for. Until the layout
  // effect below runs, we render nothing, so one level's UI can never be
  // painted with another level's session state.
  const [sessionLevel, setSessionLevel] = useState<Level | null>(null);

  useLayoutEffect(() => {
    if (!level) return;

    gameSession.onComplete = (time) => {
      setFinalTime(time);
      setScreen('result');
    };
    setLevelData(level);
    gameSession.begin(level);
    setSessionLevel(level);

    return () => {
      gameSession.onComplete = null;
      gameSession.stop();
      setSessionLevel(null);
    };
    // `restartToken` intentionally re-runs this to restart in place.
  }, [level, restartToken, setLevelData, setFinalTime, setScreen]);

  if (!level) {
    return <div>Error: Level data is missing.</div>;
  }

  if (sessionLevel !== level) {
    return null;
  }

  return <ConnectedContent level={level}>{children}</ConnectedContent>;
}

function ConnectedContent({
  level,
  children,
}: {
  level: Level;
  children: (level: Level) => React.ReactNode;
}) {
  const snapshot = useGameSession();
  // Never paint one level's dots/steps with another level's state.
  if (snapshot.level !== level) return null;
  return <>{children(level)}</>;
}

function GameScreen() {
  return (
    <Suspense fallback={<div className="text-center p-8">Loading level...</div>}>
      <LevelSession>
        {(level) => <GameContent level={level} />}
      </LevelSession>
    </Suspense>
  );
}

function GameContent({ level }: { level: Level }) {
  const snapshot = useGameSession();
  const { playerState, currentStep, startTime } = snapshot;
  const targetPattern = level.patterns[currentStep];

  const renderDots = (pattern: number[], isPlayer: boolean) => {
    return pattern.map((isPressedValue, index) => (
      <Dot
        key={index}
        variant={index === 4 ? 'space' : 'key'}
        isPressed={isPressedValue === 1}
        isPlayer={isPlayer}
        isTarget={!isPlayer}
      />
    ));
  };

  return (
    <section className="w-[90%] max-w-3xl p-5 rounded-2xl bg-black/10 backdrop-blur-lg border border-white/20">
      <header className="flex justify-between items-center mb-5">
        <h2 className="text-2xl font-bold">{level.name}</h2>
        <Timer startTime={startTime} />
      </header>

      {/* Target Pattern */}
      <div className="flex justify-center items-center gap-4 mb-2.5">
        {renderDots(targetPattern, false)}
      </div>

      {/* Player Pattern */}
      <div className="flex justify-center items-center gap-4">
        {renderDots(playerState, true)}
      </div>

      {/* Key Labels */}
      <div className="flex justify-center items-center gap-4 mt-4">
        {KEY_LABELS.map((label, index) => (
          <div
            key={label}
            className={`h-16 flex justify-center items-center text-3xl font-black text-white/30 ${
              index === 4 ? 'w-32 text-2xl' : 'w-16'
            }`}
          >
            {label}
          </div>
        ))}
      </div>

      <div className="text-center text-lg font-bold mt-5">
        Step {currentStep + 1} / {level.patterns.length}
      </div>
    </section>
  );
}

export default GameScreen;
