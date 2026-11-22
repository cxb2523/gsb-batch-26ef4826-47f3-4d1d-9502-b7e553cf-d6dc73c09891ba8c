import { useAtomValue, useSetAtom, useAtom } from 'jotai';
import {
  finalTimeAtom,
  levelDataAtom,
  screenAtom,
  levelIndexAtom,
  currentLevelIndexAtom,
  selectedLevelInfoAtom,
} from '../atoms/gameAtoms';
import { useEffect, useCallback, useRef } from 'react';
import { useFullscreen } from '../hooks/useFullscreen';
import { useScreenOrientation } from '../hooks/useScreenOrientation';
import { gameSession } from '../lib/sessionStore';

function ResultScreen() {
  const { enterFullscreen } = useFullscreen();
  const { lockOrientation, unlockOrientation } = useScreenOrientation();
  const finalTime = useAtomValue(finalTimeAtom);
  const currentLevel = useAtomValue(levelDataAtom);
  const levelIndex = useAtomValue(levelIndexAtom);
  const [currentLevelIdx, setCurrentLevelIndex] = useAtom(currentLevelIndexAtom);
  const setScreen = useSetAtom(screenAtom);
  const setSelectedLevelInfo = useSetAtom(selectedLevelInfoAtom);

  // The previous level's session is finished; make sure nothing still sounds
  // and no stale input state survives on the result screen.
  useEffect(() => {
    gameSession.stop();
  }, []);

  const hasNextLevel = currentLevel && currentLevelIdx + 1 < levelIndex.length;

  // Guard against one key press (or auto-repeat) advancing twice.
  const advancing = useRef(false);

  const handleNextLevel = useCallback(async () => {
    if (!hasNextLevel || advancing.current) return;
    advancing.current = true;
    const nextLevelIndex = currentLevelIdx + 1;
    const nextLevelInfo = levelIndex[nextLevelIndex];

    await enterFullscreen();
    await lockOrientation('landscape');

    // The new level's session is begun by the game screen once the level data
    // has loaded, which resets keys/step/timer and opens a fresh audio
    // session. Here we only select the level and show the game screen.
    setSelectedLevelInfo(nextLevelInfo);
    setCurrentLevelIndex(nextLevelIndex);
    setScreen('game');
  }, [hasNextLevel, currentLevelIdx, levelIndex, setSelectedLevelInfo, setCurrentLevelIndex, setScreen, enterFullscreen, lockOrientation]);

  // "Any key to continue" effect. Auto-repeat and keys that were already
  // held when this screen appeared (e.g. the key that finished the level)
  // must not advance — only a fresh press counts.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      e.preventDefault();
      handleNextLevel();
    };
    if (hasNextLevel) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [hasNextLevel, handleNextLevel]);

  if (!currentLevel) {
    // Should not happen, but as a fallback
    return (
      <div className="text-center">
        <p>Error: No level data found.</p>
        <button onClick={() => setScreen('levelSelect')}>Back to Menu</button>
      </div>
    );
  }

  const finalTimeInSeconds = finalTime / 1000;
  const levelId = levelIndex[currentLevelIdx]?.id;
  const ranks = currentLevel.ranks;
  let rank = 'C';
  let rankColor = 'text-slate-500';

  if (finalTimeInSeconds <= ranks[0]) {
    rank = 'S';
    rankColor = 'text-yellow-400';
  } else if (finalTimeInSeconds <= ranks[1]) {
    rank = 'A';
    rankColor = 'text-slate-400';
  } else if (finalTimeInSeconds <= ranks[2]) {
    rank = 'B';
    rankColor = 'text-amber-700';
  }

  const handleBackToMenu = () => {
    gameSession.stop();
    unlockOrientation();
    setSelectedLevelInfo(null);
    setCurrentLevelIndex(-1);
    setScreen('levelSelect');
  };

  return (
    <section className="w-[90%] max-w-3xl p-5 rounded-2xl bg-black/10 backdrop-blur-lg border border-white/20 text-center">
      <h2 className="text-3xl font-black mb-6">Level {levelId} Complete!</h2>
      <div className={`text-9xl font-black leading-none mb-2.5 ${rankColor}`}>{rank}</div>
      <div className="text-2xl font-bold mb-8">Your Time: {finalTimeInSeconds.toFixed(2)}s</div>

      <div className="flex justify-center gap-4">
        {hasNextLevel && (
          <button onClick={handleNextLevel} className="bg-white text-emerald-600 text-lg font-bold py-3 px-5 rounded-xl cursor-pointer transition-transform hover:scale-105">
            Next Level (Any Key)
          </button>
        )}
        <button onClick={handleBackToMenu} className="bg-white text-emerald-600 text-lg font-bold py-3 px-5 rounded-xl cursor-pointer transition-transform hover:scale-105">
          Back to Menu
        </button>
      </div>
    </section>
  );
}

export default ResultScreen;
