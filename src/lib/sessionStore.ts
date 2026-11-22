import { audioManager } from './audio';
import { GameSession } from './gameSession';
import type { AudioPort } from './audioEngine';

/**
 * The app-wide game session. One instance for the whole app: mounting a new
 * level calls `begin`, leaving a level calls `stop`/`reset`, and every input
 * source (keyboard hook, touch overlay) routes through this object.
 */
const audioPort: AudioPort = {
  playNote: (key) => audioManager.playNote(key),
  releaseNote: (key) => audioManager.releaseNote(key),
  releaseAll: () => audioManager.releaseAll(),
  beginLevelSession: () => audioManager.beginLevelSession(),
  endLevelSession: () => audioManager.endLevelSession(),
};

export const gameSession = new GameSession(audioPort);
