/**
 * Level data shape shared by the async level atom and the game session.
 * Kept dependency-free so the session logic can be unit tested without React.
 */
export interface Level {
  name: string;
  patterns: number[][];
  ranks: number[];
}
