import { act, renderHook, waitFor } from '@testing-library/react';
import { useAudioProcessor, SSTVMode } from '../useAudioProcessor';
import { SSTV_MODES } from '@/lib/sstv/constants';

type AudioCallback = (event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void;

interface MockProcessor {
  connect: jest.Mock;
  disconnect: jest.Mock;
  onaudioprocess: AudioCallback | null;
}

let processors: MockProcessor[] = [];
let analyserMock: any;

const makeAnalyser = () => ({
  fftSize: 2048,
  frequencyBinCount: 1024,
  context: { sampleRate: 48000 },
  getByteFrequencyData: jest.fn((arr: Uint8Array) => arr.fill(0)),
  getFloatTimeDomainData: jest.fn((arr: Float32Array) => arr.fill(0)),
  connect: jest.fn(),
  disconnect: jest.fn(),
});

class MockAudioContext {
  sampleRate = 48000;
  destination = {};
  close = jest.fn().mockResolvedValue(undefined);

  createAnalyser = jest.fn(() => analyserMock);
  createGain = jest.fn(() => ({
    gain: { value: 1 },
    connect: jest.fn(),
    disconnect: jest.fn(),
  }));
  createMediaStreamSource = jest.fn(() => ({ connect: jest.fn(), disconnect: jest.fn() }));
  createScriptProcessor = jest.fn((): MockProcessor => {
    const processor: MockProcessor = {
      connect: jest.fn(),
      disconnect: jest.fn(),
      onaudioprocess: null,
    };
    processors.push(processor);
    return processor;
  });
}

const fireAudio = (processor: MockProcessor, samples: Float32Array) => {
  act(() => {
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
  });
};

const renderProcessor = (initialMode: SSTVMode = 'ROBOT36') =>
  renderHook(({ mode }: { mode: SSTVMode }) => useAudioProcessor(mode), {
    initialProps: { mode: initialMode },
  });

const start = async (result: { current: ReturnType<typeof useAudioProcessor> }) => {
  await act(async () => {
    await result.current.startRecording();
  });
};

describe('useAudioProcessor mode switching', () => {
  const originalAudioContext = (global as any).AudioContext;
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia;

  beforeEach(() => {
    processors = [];
    analyserMock = makeAnalyser();
    (global as any).AudioContext = MockAudioContext;
    (window as any).AudioContext = MockAudioContext;
    (navigator.mediaDevices as any).getUserMedia = jest.fn().mockResolvedValue({
      getTracks: jest.fn().mockReturnValue([{ stop: jest.fn(), kind: 'audio' }]),
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    (global as any).AudioContext = originalAudioContext;
    (window as any).AudioContext = originalAudioContext;
    (navigator.mediaDevices as any).getUserMedia = originalGetUserMedia;
    jest.restoreAllMocks();
  });

  test('switching while recording applies the new mode stats and dimensions', async () => {
    const { result, rerender } = renderProcessor('ROBOT36');
    await start(result);

    expect(result.current.state.isRecording).toBe(true);
    expect(result.current.state.stats?.mode).toBe('Robot 36');
    expect(result.current.state.stats?.totalLines).toBe(240);

    // Audio keeps flowing while recording.
    const processor = processors[0];
    fireAudio(processor, new Float32Array(4096));

    act(() => {
      rerender({ mode: 'PD120' });
    });

    const stats = result.current.state.stats!;
    expect(stats.mode).toBe('PD 120');
    expect(stats.totalLines).toBe(SSTV_MODES.PD120.height);
    expect(stats.currentLine).toBe(0);
    expect(stats.progress).toBe(0);
    expect(result.current.state.isRecording).toBe(true);
    expect(result.current.getDimensions()).toEqual({ width: 640, height: 496 });

    // A single decoder keeps receiving audio after the switch.
    fireAudio(processor, new Float32Array(4096));
    expect(result.current.state.stats?.mode).toBe('PD 120');
    expect(result.current.getImageData()?.length).toBe(640 * 496 * 4);
  });

  test('old mode partial image and lines do not survive the switch', async () => {
    const { result, rerender } = renderProcessor('ROBOT36');
    await start(result);

    // Simulate a partially decoded Robot36 image.
    const oldImage = result.current.getImageData()!;
    oldImage[0] = 255;
    oldImage[1] = 100;
    oldImage[2] = 50;

    act(() => {
      rerender({ mode: 'SCOTTIE_S1' });
    });

    const newImage = result.current.getImageData()!;
    expect(newImage).not.toBe(oldImage);

    let nonBlack = 0;
    for (let i = 0; i < newImage.length; i += 4) {
      if (newImage[i] !== 0 || newImage[i + 1] !== 0 || newImage[i + 2] !== 0) nonBlack++;
    }
    expect(nonBlack).toBe(0);
    expect(result.current.state.stats?.currentLine).toBe(0);
    expect(result.current.state.stats?.mode).toBe('Scottie S1');
    expect(result.current.getDimensions()).toEqual({ width: 320, height: 256 });
  });

  test('switching while not recording only updates the pending mode', async () => {
    const { result, rerender } = renderProcessor('ROBOT36');

    act(() => {
      rerender({ mode: 'PD180' });
    });

    // No decoder exists yet: no stats, no capture.
    expect(result.current.state.isRecording).toBe(false);
    expect(result.current.state.stats).toBeNull();
    expect(result.current.getDimensions()).toEqual({ width: 640, height: 496 });

    // Next start uses the pending mode directly.
    await start(result);

    expect(result.current.state.isRecording).toBe(true);
    expect(result.current.state.stats?.mode).toBe('PD 180');
    expect(result.current.state.stats?.totalLines).toBe(SSTV_MODES.PD180.height);
    expect(result.current.getDimensions()).toEqual({ width: 640, height: 496 });
  });

  test('rapid successive switches keep only the last mode and a single decoder', async () => {
    const { result, rerender } = renderProcessor('ROBOT36');
    await start(result);

    act(() => {
      rerender({ mode: 'PD120' });
      rerender({ mode: 'SCOTTIE_S2' });
      rerender({ mode: 'PD160' });
      rerender({ mode: 'ROBOT72' });
    });

    expect(result.current.state.stats?.mode).toBe('Robot 72');
    expect(result.current.state.stats?.totalLines).toBe(SSTV_MODES.ROBOT72.height);

    // Only one ScriptProcessor pipeline was ever created and it keeps feeding
    // exactly one live decoder.
    expect(processors).toHaveLength(1);
    fireAudio(processors[0], new Float32Array(4096));
    expect(result.current.state.stats?.mode).toBe('Robot 72');
    expect(result.current.getImageData()?.length).toBe(320 * 240 * 4);
  });

  test('no audio callback writes state after stop', async () => {
    const { result } = renderProcessor('PD120');
    await start(result);

    const processor = processors[0];
    fireAudio(processor, new Float32Array(4096));

    act(() => {
      result.current.stopRecording();
    });

    expect(result.current.state.isRecording).toBe(false);
    const statsAfterStop = result.current.state.stats;
    const imageAfterStop = result.current.getImageData();

    // A late in-flight audio callback must be ignored.
    fireAudio(processor, new Float32Array(4096));

    expect(result.current.state.stats).toBe(statsAfterStop);
    expect(result.current.getImageData()).toBe(imageAfterStop);
  });

  test('no audio callback writes state after unmount', async () => {
    const { result, unmount } = renderProcessor('ROBOT36');
    await start(result);

    const processor = processors[0];
    const setStateSpy = jest.spyOn(console, 'error');

    unmount();

    // Firing a late callback after unmount must not throw or warn.
    expect(() => fireAudio(processor, new Float32Array(4096))).not.toThrow();
    await waitFor(() => {
      expect(setStateSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('unmounted component'),
        expect.anything()
      );
    });
  });
});
