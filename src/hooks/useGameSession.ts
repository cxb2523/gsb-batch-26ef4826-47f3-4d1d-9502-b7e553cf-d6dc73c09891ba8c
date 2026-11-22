import { useSyncExternalStore } from 'react';
import { gameSession } from '../lib/sessionStore';
import type { GameSnapshot } from '../lib/gameSession';

const subscribe = (listener: () => void) => gameSession.subscribe(listener);
const getSnapshot = () => gameSession.getSnapshot();

/**
 * Subscribe a component to the game session. Both the game screen and the
 * touch overlay read from here, so they always agree on the current level
 * generation, held keys and step. The subscribe/getSnapshot pair is stable
 * so React does not resubscribe on every render.
 */
export function useGameSession(): GameSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
