/**
 * The far calls the game makes to its sound driver (see re/notes/90-sound.md), as the port sees them.
 *
 * `suspend`/`resume`/`beginRace`/`endRace` are the port's own: the original has no game-level lifecycle,
 * because the driver keeps running for ever and each screen asks for what it wants. A browser is not so
 * forgiving, so the page says out loud where a race starts, where it ends and where it is paused.
 */
export interface SoundPort {
  /** ah=4 / ah=9: the song a screen asks for, and which one is playing. */
  setSong(song: number): void;
  songPlaying(song: number): boolean;
  /** ah=5 and ah=8: queue a sound effect on the effects queue, or on the second one. */
  play(sound: number, music?: boolean): void;
  /** ah=0a: is that sound already on a channel? */
  isPlaying(sound: number): boolean;
  /** ah=6 / ah=7: stop everything, or just the song's own tracks. Both land on the next tick. */
  stopAll(): void;
  stopVoices(): void;
  /**
   * fn 7b46: the engine note of one car. The game writes the pitch straight into the looping sequence the
   * driver keeps for that car and starts it if it is not already running.
   */
  engine(car: number, pitch: number, running: boolean): void;

  /** A game pause: quiet the chip and hold the sequencer until `resume`, both at a tick boundary. */
  suspend?(): void;
  /** The pause is over. The engine notes pick up again from the pitch the game next writes. */
  resume?(): void;
  /** A race is about to start: both queues and every channel are let go now, not on the next tick. */
  beginRace?(): void;
  /** A race has ended: ah=6, with its queues emptied so nothing of the race reaches the menu. */
  endRace?(): void;
}

/** A queued ah call from the race: `fn` is ah, `arg` is al. */
export interface SoundRequest { fn: number; arg: number; }

/**
 * What the page does with the race's queue of ah calls, one step at a time. fn 6 and 7 are the two stop
 * requests: the driver itself defers them to its next tick, which is why they must be handed on rather than
 * acted on here. The queue is emptied afterwards, as the page has always done.
 */
export function playSoundCalls(port: SoundPort, calls: SoundRequest[]): void {
  for (const { fn, arg } of calls) {
    switch (fn) {
      case 6: port.stopAll(); break;
      case 7: port.stopVoices(); break;
      case 8: port.play(arg, true); break;
      case 0x0A: if (!port.isPlaying(arg)) port.play(arg); break;
      default: port.play(arg); break;
    }
  }
  calls.length = 0;
}
