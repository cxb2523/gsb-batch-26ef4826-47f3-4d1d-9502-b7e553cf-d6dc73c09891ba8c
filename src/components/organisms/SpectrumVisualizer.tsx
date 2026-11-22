/* SPDX-License-Identifier: MIT
   Copyright (c) 2026 Arnold Wender / Wender Media
   ────────────────────────────────────────────────────────── */
import { useCallback } from 'react';
import { CanvasVisualizer } from '../atoms/CanvasVisualizer';
import { drawSpectrum } from '../../lib/visualizers/spectrum';
import { useAudioAnalyzer } from '../../lib/audio/useAudioAnalyzer';

/* Module-level constant — avoids a Float32Array allocation + fill every RAF
   frame when no analyser is connected yet. */
const EMPTY_SPECTRUM = new Float32Array(1024).fill(-100);

export function SpectrumVisualizer() {
  const { analyzerRef, pollOnFrame } = useAudioAnalyzer();

  const draw = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number, _time: number) => {
    pollOnFrame();

    if (analyzerRef.current) {
      drawSpectrum(ctx, width, height, analyzerRef.current.getFrequencyData());
    } else {
      drawSpectrum(ctx, width, height, EMPTY_SPECTRUM);
    }
  }, [analyzerRef, pollOnFrame]);

  return (
    <div className="h-full w-full" style={{ backgroundColor: 'var(--color-bg)' }}>
      <CanvasVisualizer draw={draw} />
    </div>
  );
}
