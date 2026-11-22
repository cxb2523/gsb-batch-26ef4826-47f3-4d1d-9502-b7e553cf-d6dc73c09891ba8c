import { ZONE_TO_CODE } from './keymap';

export interface TouchPoint {
  identifier: number;
  x: number;
  y: number;
}

export interface TouchInputOptions {
  press(code: string, source: string): void;
  release(code: string, source: string): void;
  startAudio(): void;
  /** Zone index under a screen coordinate, or -1 when outside the board. */
  getZoneAt(x: number, y: number): number;
}

const ZONE_COUNT = 9;

/** Stable source id for a touch point, namespaced away from the keyboard. */
export const touchSource = (identifier: number) => `touch:${identifier}`;

/**
 * The touch input path, extracted from React so it can be exercised in tests.
 *
 * Each touch point is an independent *owner* of a key code. Pressing a zone
 * is deduped by the game session exactly like a keyboard press, so two
 * fingers on the same zone (or keyboard + touch) do not double-trigger.
 * Sliding out of the board, `touchend`, `touchcancel`, a level generation
 * change, or unmount all release the note that touch was holding.
 */
export class TouchInputController {
  private readonly touchToZone = new Map<number, number>();
  /** Touch ids that were down across a level change; ignored until lifted. */
  private readonly suppressed = new Set<number>();
  private readonly options: TouchInputOptions;
  private readonly listeners = new Set<() => void>();
  private cachedZones: boolean[] = new Array<boolean>(ZONE_COUNT).fill(false);

  constructor(options: TouchInputOptions) {
    this.options = options;
  }

  /** Subscribe to zone-highlight changes (for React rendering). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Stable snapshot of the pressed-zone highlight array. */
  get zonesSnapshot(): boolean[] {
    return this.cachedZones;
  }

  /** Zone indices with at least one active touch (for rendering). */
  getPressedZones(): boolean[] {
    const zones = new Array<boolean>(ZONE_COUNT).fill(false);
    for (const zone of this.touchToZone.values()) {
      zones[zone] = true;
    }
    return zones;
  }

  /** Active touch identifiers (for diagnostics/tests). */
  get activeTouchIds(): number[] {
    return Array.from(this.touchToZone.keys());
  }

  touchStart(points: readonly TouchPoint[]): void {
    this.options.startAudio();
    for (const point of points) {
      if (this.touchToZone.has(point.identifier)) continue;
      const zone = this.options.getZoneAt(point.x, point.y);
      if (zone === -1) continue;
      // A finger that survived a level change must not start the new level.
      if (this.suppressed.has(point.identifier)) continue;
      this.touchToZone.set(point.identifier, zone);
      this.options.press(ZONE_TO_CODE[zone], touchSource(point.identifier));
    }
    this.commitZones();
  }

  touchMove(points: readonly TouchPoint[]): void {
    for (const point of points) {
      const oldZone = this.touchToZone.get(point.identifier);
      const newZone = this.options.getZoneAt(point.x, point.y);
      if (oldZone === newZone) continue;

      // A finger we never saw touchstart+down for (e.g. it was already on the
      // glass when this level's overlay mounted) is not a real press. Ignore
      // it until it lifts, mirroring the "held key must be re-pressed" rule.
      if (oldZone === undefined && !this.suppressed.has(point.identifier)) {
        this.suppressed.add(point.identifier);
      }

      if (oldZone !== undefined) {
        this.touchToZone.delete(point.identifier);
        this.options.release(ZONE_TO_CODE[oldZone], touchSource(point.identifier));
      }
      if (newZone !== -1 && !this.suppressed.has(point.identifier)) {
        this.touchToZone.set(point.identifier, newZone);
        this.options.press(ZONE_TO_CODE[newZone], touchSource(point.identifier));
      }
    }
    this.commitZones();
  }

  touchEnd(points: readonly TouchPoint[]): void {
    for (const point of points) {
      this.suppressed.delete(point.identifier);
      this.releaseTouch(point.identifier);
    }
  }

  /**
   * Release every active touch (level generation change / unmount).
   * Those fingers are then suppressed until they lift, so a finger that was
   * already down when the level started cannot begin the new level — matching
   * the keyboard rule that a held key must be released and pressed again.
   */
  releaseAll(): void {
    for (const identifier of Array.from(this.touchToZone.keys())) {
      this.suppressed.add(identifier);
      this.releaseTouch(identifier);
    }
  }

  private releaseTouch(identifier: number): void {
    const zone = this.touchToZone.get(identifier);
    if (zone === undefined) return;
    this.touchToZone.delete(identifier);
    this.options.release(ZONE_TO_CODE[zone], touchSource(identifier));
    this.commitZones();
  }

  private commitZones(): void {
    this.cachedZones = this.getPressedZones();
    for (const listener of Array.from(this.listeners)) listener();
  }
}
