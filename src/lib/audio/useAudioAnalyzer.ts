/* SPDX-License-Identifier: MIT
   Copyright (c) 2026 Arnold Wender / Wender Media
   ──────────────────────────────────────────────────────────
   useAudioAnalyzer — binds an AudioAnalyzer wrapper to the
   currently valid analyser node and rebuilds it whenever the
   takeover state swaps nodes (recording start/stop, engine
   switch, re-evaluation, context replacement) or falls back
   to the shared master analyser.
   ────────────────────────────────────────────────────────── */
import { useCallback, useEffect, useRef } from 'react';
import { AudioAnalyzer } from './analyzer';
import { getStrudelAnalyser } from './strudel-tap';

/**
 * Polls getStrudelAnalyser() from a RAF loop and keeps an AudioAnalyzer in
 * sync with the node it returns.
 *
 * The wrapper is rebuilt on EVERY node identity change, including a change to
 * null: continuing to read the old wrapper would draw buffers from an analyser
 * the takeover state has disconnected (visualization frozen on its last
 * frame). Polling cadence matches the previous visualizer behaviour — the
 * first three frames and then every 15th frame (~250ms).
 */
export function useAudioAnalyzer() {
  const analyzerRef = useRef<AudioAnalyzer | null>(null);
  const lastNodeRef = useRef<AnalyserNode | null>(null);
  const frameCount = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const pollOnFrame = useCallback(() => {
    frameCount.current++;
    if (frameCount.current % 15 !== 0 && frameCount.current > 3) return;

    void getStrudelAnalyser()
      .then((node) => {
        if (!mountedRef.current || node === lastNodeRef.current) return;
        lastNodeRef.current = node;
        /* Rebuild for a new node; drop the wrapper when nothing is tap-able
         * yet so the component renders its empty state instead of a stale
         * frame from a discarded analyser. */
        analyzerRef.current = node ? new AudioAnalyzer(node) : null;
      })
      .catch(() => {
        /* Tap momentarily unavailable — keep drawing the current wrapper. */
      });
  }, []);

  return { analyzerRef, pollOnFrame };
}
