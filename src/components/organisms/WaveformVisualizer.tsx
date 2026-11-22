/* SPDX-License-Identifier: MIT
   Copyright (c) 2026 Arnold Wender / Wender Media
   ────────────────────────────────────────────────────────── */
import { useCallback } from 'react';
import { CanvasVisualizer } from '../atoms/CanvasVisualizer';
import { drawWaveform } from '../../lib/visualizers/waveform';
import { useAudioAnalyzer } from '../../lib/audio/useAudioAnalyzer';

/* Module-level constant — avoids a Float32Array allocation every RAF frame
   when no analyser is connected yet. */
const EMPTY_WAVEFORM = new Float32Array(2048);

export function WaveformVisualizer() {
  const { analyzerRef, pollOnFrame } = useAudioAnalyzer();

  const draw = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number, _time: number) => {
    pollOnFrame();

    if (analyzerRef.current) {
      drawWaveform(ctx, width, height, analyzerRef.current.getTimeDomainData());
    } else {
      drawWaveform(ctx, width, height, EMPTY_WAVEFORM);
    }
  }, [analyzerRef, pollOnFrame]);

  return (
    <div className="h-full w-full" style={{ backgroundColor: 'var(--color-bg)' }}>
      <CanvasVisualizer draw={draw} />
    </div>
  );
}
