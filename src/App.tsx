import { useAtom, useSetAtom } from 'jotai';
import { RefreshCw, Home, Maximize, Minimize } from 'lucide-react';
import { screenAtom, selectedLevelInfoAtom, currentLevelIndexAtom, finalTimeAtom } from './atoms/gameAtoms';
import GameContainer from './components/GameContainer';
import { useGameLogic } from './hooks/useGameLogic';
import { useEffect, useState } from 'react';
import TouchOverlay from './components/TouchOverlay';
import { useScreenOrientation } from './hooks/useScreenOrientation';
import { useFullscreen } from './hooks/useFullscreen';
import { gameSession } from './lib/sessionStore';

const isTouchDevice = () => 'ontouchstart' in window || navigator.maxTouchPoints > 0;

function App() {
  const { isFullscreen, toggleFullscreen } = useFullscreen();
  const { lockOrientation, unlockOrientation } = useScreenOrientation();
  const [screen, setScreen] = useAtom(screenAtom);
  const setSelectedLevelInfo = useSetAtom(selectedLevelInfoAtom);
  const setCurrentLevelIndex = useSetAtom(currentLevelIndexAtom);
  const setFinalTime = useSetAtom(finalTimeAtom);
  const { resetGameState } = useGameLogic();
  const [showTouchOverlay, setShowTouchOverlay] = useState(false);

  useEffect(() => {
    setShowTouchOverlay(isTouchDevice());
  }, []);

  const handleBackToMenu = () => {
    // End the level session (releases notes, clears keys/step/timer) before
    // the game screen unmounts.
    gameSession.stop();
    setSelectedLevelInfo(null);
    setCurrentLevelIndex(-1);
    setFinalTime(0);
    unlockOrientation();
    setScreen('levelSelect');
  };

  const handleToggleFullscreen = () => {
    toggleFullscreen();
    lockOrientation('landscape');
  };

  return (
    <div
      className={`font-sans flex justify-center items-center bg-emerald-500 text-white overflow-hidden select-none relative ${
        isFullscreen ? 'h-screen w-screen' : 'h-svh w-svw'
      }`}
    >
      {screen === 'game' && showTouchOverlay && <TouchOverlay />}
      {screen === 'game' && (
        <div className="absolute top-4 right-4 flex items-center gap-4 z-20">
          <button
            onClick={handleToggleFullscreen}
            className="p-2 text-white/50 hover:text-white transition-colors cursor-pointer"
            title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
          >
            {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
          </button>
          <button
            onClick={resetGameState}
            className="p-2 text-white/50 hover:text-white transition-colors cursor-pointer"
            title="Restart Level"
          >
            <RefreshCw size={20} />
          </button>
          <button
            onClick={handleBackToMenu}
            className="p-2 text-white/50 hover:text-white transition-colors cursor-pointer"
            title="Back to Menu"
          >
            <Home size={20} />
          </button>
        </div>
      )}
      <GameContainer />
    </div>
  );
}

export default App;
