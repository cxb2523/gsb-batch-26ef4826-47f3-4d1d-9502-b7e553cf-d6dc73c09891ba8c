/* SPDX-License-Identifier: MIT
   Copyright (c) 2026 Arnold Wender / Wender Media
   ────────────────────────────────────────────────────────── */
import { useCallback } from 'react';
import { CanvasVisualizer } from '../atoms/CanvasVisualizer';
import { drawTimeline } from '../../lib/visualizers/timeline';
import { useAudioAnalyzer } from '../../lib/audio/useAudioAnalyzer';
import { useAppStore } from '../../lib/store';

export function PatternTimeline() {
  const { analyzerRef, pollOnFrame } = useAudioAnalyzer();
  const bpm = useAppStore((s) => s.bpm);

  const draw = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number, time: number) => {
    pollOnFrame();
    const rms = analyzerRef.current?.getRmsLevel() ?? 0;
    drawTimeline(ctx, width, height, bpm, time, rms);
  }, [analyzerRef, pollOnFrame, bpm]);

  return (
    <div className="h-full w-full" style={{ backgroundColor: 'var(--color-bg)' }}>
      <CanvasVisualizer draw={draw} />
    </div>
  );
}
