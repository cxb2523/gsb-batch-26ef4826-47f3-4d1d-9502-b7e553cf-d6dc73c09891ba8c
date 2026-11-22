// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Arnold Wender / Wender Media

/* Unified, invalidatable Strudel/superdough audio takeover.
 *
 * The visualizer analyser and the recorder tap used to be resolved through two
 * independent code paths, each caching its own state. After a recording
 * start/stop, an engine switch or a re-evaluation one side could keep handing
 * out nodes belonging to a previous AudioContext or a previous superdough
 * output chain: the visualizer froze on its last frame, the recorder captured
 * a different signal than the one being heard, and repeated evaluations kept
 * stacking connections.
 *
 * Both consumers now resolve through ONE TapState. The state is keyed by the
 * running AudioContext and by superdough's output node, carries the single
 * AnalyserNode used for visualization, and owns every recorder edge. It is
 * replaced atomically on every invalidation (recording start/stop, engine
 * switch, re-evaluation, context replacement/close), and resolution is
 * single-flight so concurrent callers can never build duplicate connections.
 */

import { getMasterAnalyser } from './context';

/**
 * One resolved takeover of superdough's output.
 *
 * `analyser` and every recorder destination are fed by the same `outputNode`
 * on the same running `context`, so what the visualizers draw is exactly what
 * a recording captures. `recorderDestinations` mirrors the edges actually
 * established from `outputNode`, which makes each edge connect exactly once
 * per state even when acquisition races state construction.
 */
interface TapState {
  /** AudioContext superdough is running on — closed/replaced contexts invalidate the state. */
  context: AudioContext;
  /** superdough's output gain; the single node both consumers tap. */
  outputNode: AudioNode;
  /** Visualization analyser connected from outputNode. */
  analyser: AnalyserNode;
  /** Recorder destinations currently connected from outputNode. */
  recorderDestinations: Set<AudioNode>;
}

/** Current resolved state, or null while nothing valid is resolvable. */
let current: TapState | null = null;

/**
 * Bumped on every invalidation. A resolution captures its generation and only
 * publishes its result while it is still the newest one — a resolve that was
 * in flight across a reset can never resurrect a stale state.
 */
let generation = 0;

/** Single-flight guard: concurrent resolvers share one in-flight promise. */
let inflight: Promise<TapState | null> | null = null;

/**
 * Recorder destinations registered against the takeover. A destination stays
 * registered for the lifetime of a recording and is (re)connected to the
 * output node of EVERY state that exists while it is registered, so a
 * re-evaluation mid-take re-routes the take without leaking the old edge.
 */
const registeredDestinations = new Set<AudioNode>();

/**
 * Look up superdough's output node across the layouts of different releases.
 *
 * There is deliberately no fallback to `ctx.destination`: an
 * AudioDestinationNode is a terminal sink, so connecting FROM it yields no
 * signal while looking like success.
 */
function findOutputNode(
  sd: typeof import('@strudel/webaudio'),
): AudioNode | null {
  const controller = sd.getSuperdoughAudioController();
  const node =
    controller?.output?.destinationGain ??
    (controller as unknown as { destinationGain?: AudioNode })?.destinationGain ??
    (controller as unknown as { master?: AudioNode; out?: AudioNode })?.master ??
    (controller as unknown as { out?: AudioNode })?.out;
  return (node as AudioNode | undefined) ?? null;
}

/** Tear down everything a previous state owns before it is replaced/dropped. */
function teardownState(state: TapState): void {
  /* The analyser edge belongs to this state alone. */
  try {
    state.outputNode.disconnect(state.analyser);
  } catch {
    /* Already disconnected or the context is closing — safe to ignore. */
  }
  /* Recorder edges this state established. The destinations themselves stay
   * registered so the replacement state reconnects them. */
  for (const destination of state.recorderDestinations) {
    try {
      state.outputNode.disconnect(destination);
    } catch {
      /* Already disconnected — safe to ignore. */
    }
  }
  state.recorderDestinations.clear();
}

/** Build a fresh state for the running context and wire every consumer once. */
function buildState(
  context: AudioContext,
  outputNode: AudioNode,
): TapState {
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.85;
  outputNode.connect(analyser);

  const state: TapState = {
    context,
    outputNode,
    analyser,
    recorderDestinations: new Set<AudioNode>(),
  };

  /* Re-route any in-progress recordings onto the new output chain, each edge
   * exactly once. */
  for (const destination of registeredDestinations) {
    outputNode.connect(destination);
    state.recorderDestinations.add(destination);
  }

  return state;
}

/**
 * Resolve the current takeover, single-flight.
 *
 * Returns null while superdough has not initialised (its controller only
 * exists after the first note plays) or its context is suspended/closed —
 * callers fall back to the shared master analyser in that case.
 */
function resolveTap(): Promise<TapState | null> {
  if (inflight) return inflight;

  const myGeneration = generation;
  inflight = (async (): Promise<TapState | null> => {
    try {
      const sd = await import('@strudel/webaudio');

      /* An invalidation raced this resolution while the import was in flight.
       * Bail before touching any node — a stale resolve must have zero side
       * effects; the next (newer-generation) resolver builds the real state. */
      if (myGeneration !== generation) return null;

      const context = sd.getAudioContext();

      /* Skip suspended contexts — autoplay policy may create a sleeping
       * context before the user interacts. Connecting on a suspended context
       * locks in a silent tap; wait until audio is actually running. A closed
       * context can never become valid again. */
      if (!context || context.state !== 'running') return null;

      const outputNode = findOutputNode(sd);
      if (!outputNode) return null;

      /* Reuse the cached state while it still describes this live chain.
       * A closed context or a swapped output node forces a rebuild. */
      if (
        current &&
        current.context === context &&
        current.context.state === 'running' &&
        current.outputNode === outputNode
      ) {
        return current;
      }

      const previous = current;
      const state = buildState(context, outputNode);
      /* Defence in depth: an invalidation racing the synchronous work above
       * (getAudioContext/findOutputNode/buildState) still cannot publish an
       * orphaned state. */
      if (myGeneration !== generation) {
        teardownState(state);
        return null;
      }
      if (previous) teardownState(previous);
      current = state;
      return state;
    } catch {
      /* @strudel/webaudio unavailable or controller not ready. */
      return null;
    }
  })();

  void inflight.finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Returns an AnalyserNode with live audio data.
 *
 * The Strudel/superdough analyser while that chain is running, otherwise the
 * shared masterAnalyser (Tone.js + Web Audio route here). A node from a
 * closed or replaced context is never returned: the stale state is torn down
 * first.
 */
export async function getStrudelAnalyser(): Promise<AnalyserNode | null> {
  const state = await resolveTap();
  if (state && state.context.state === 'running') return state.analyser;

  /* Fallback: shared masterAnalyser (Tone.js + WebAudio route here). */
  try {
    return getMasterAnalyser();
  } catch {
    /* not ready */
  }
  return null;
}

/**
 * Returns superdough's output node, or null if it has not initialised yet.
 *
 * This is the SAME node the visualization analyser taps — the two consumers
 * can no longer resolve different chains. superdough terminates at
 * `audioContext.destination` rather than at the app's masterGain, so anything
 * that needs Strudel's signal (the recorder, an export) has to tap this node
 * directly. The controller only exists after the first note plays.
 */
export async function getStrudelOutputNode(): Promise<AudioNode | null> {
  const state = await resolveTap();
  return state?.outputNode ?? null;
}

/**
 * Register a recorder destination and connect it to the current output node.
 *
 * Single-flight: N concurrent callers share one resolution and the
 * destination is connected at most once per state. The returned node is the
 * exact output node the analyser taps (or null while superdough is not ready).
 * The edge is tracked centrally so invalidation can re-route it without the
 * recorder having to know about context/chain swaps.
 */
export async function acquireStrudelRecorderTap(
  destination: AudioNode,
): Promise<AudioNode | null> {
  const alreadyRegistered = registeredDestinations.has(destination);
  registeredDestinations.add(destination);

  const state = await resolveTap();
  if (!state) return null;

  /* buildState already connected destinations registered before the state
   * existed; only connect here when this registration came afterwards. */
  if (!alreadyRegistered && !state.recorderDestinations.has(destination)) {
    state.outputNode.connect(destination);
    state.recorderDestinations.add(destination);
  }
  return state.outputNode;
}

/**
 * Disconnect ONLY the recorder's own edge to `destination`.
 *
 * The visualization analyser hangs off the same output node and is never
 * touched here. Works even after an invalidation replaced the state, and
 * unregisters the destination so no later state reconnects it.
 */
export function releaseStrudelRecorderTap(destination: AudioNode): void {
  registeredDestinations.delete(destination);
  if (current) {
    if (current.recorderDestinations.delete(destination)) {
      try {
        current.outputNode.disconnect(destination);
      } catch {
        /* Already disconnected — safe to ignore. */
      }
    }
  }
}

/**
 * Invalidate the resolved takeover so the next call re-resolves from scratch.
 *
 * Call after recording start/stop, an engine switch or a re-evaluation — and
 * when the AudioContext is closed or replaced. The old analyser is
 * disconnected and never returned again; in-progress recordings stay
 * registered and are reconnected to the replacement chain on next resolution.
 * Eagerly kicks off a re-resolution when a recording is active so the take
 * re-routes immediately instead of waiting for the next visualizer poll.
 */
export function resetStrudelTap(): void {
  generation += 1;
  if (current) {
    teardownState(current);
    current = null;
  }
  if (registeredDestinations.size > 0) {
    void resolveTap().catch(() => {
      /* superdough not ready yet — the next poll retries. */
    });
  }
}

export async function getStrudelSampleRate(): Promise<number> {
  try {
    const { getAudioContext } = await import('@strudel/webaudio');
    return getAudioContext()?.sampleRate ?? 44100;
  } catch {
    return 44100;
  }
}
