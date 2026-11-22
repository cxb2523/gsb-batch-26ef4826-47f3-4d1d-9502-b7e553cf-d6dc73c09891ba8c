/**
 * Sampler session-lifecycle tests.
 *
 * These exercise: source swapping as a new playback session, gate/mode
 * coordination, fade/retry/loop timer cleanup, blob URL ownership and region
 * handling. A self-made Audio element + AudioWorkletNode simulation is used so
 * no real audio file or audio device is required.
 */
import React from 'react';
import { act, waitFor } from '@testing-library/react';
import { render, createMockStreamRef } from './test-utils';
import { Sampler, SamplerHandle, PlaybackMode } from '../components/sources/Sampler';

// ---------------------------------------------------------------------------
// Mock AudioParam / GainNode
// ---------------------------------------------------------------------------
class MockAudioParam {
  value = 1;
  setValueAtTime = jest.fn((value: number) => {
    this.value = value;
  });
  setTargetAtTime = jest.fn((value: number) => {
    this.value = value;
  });
  linearRampToValueAtTime = jest.fn((value: number) => {
    this.value = value;
  });
  exponentialRampToValueAtTime = jest.fn((value: number) => {
    this.value = value;
  });
  setValueCurveAtTime = jest.fn();
  cancelScheduledValues = jest.fn();
  cancelAndHoldAtTime = jest.fn();
}

interface MockGainNode {
  connect: jest.Mock;
  disconnect: jest.Mock;
  gain: MockAudioParam;
}

const makeGainNode = (): MockGainNode => ({
  connect: jest.fn(),
  disconnect: jest.fn(),
  gain: new MockAudioParam(),
});

// ---------------------------------------------------------------------------
// Mock AudioContext
// ---------------------------------------------------------------------------
const mediaSourceNodes: Array<{ mediaElement: unknown; connect: jest.Mock; disconnect: jest.Mock }> = [];
const gainNodes: MockGainNode[] = [];

const getOutputGainParam = (): MockAudioParam => {
  // The Sampler creates exactly one long-lived output gain node.
  expect(gainNodes.length).toBeGreaterThan(0);
  return gainNodes[0].gain;
};

class MockAudioContext {
  currentTime = 0;
  sampleRate = 44100;
  state: AudioContextState = 'running';
  destination = {} as AudioDestinationNode;
  audioWorklet = { addModule: jest.fn(() => Promise.resolve()) };
  createGain = jest.fn(() => {
    const node = makeGainNode();
    gainNodes.push(node);
    return node;
  });
  createMediaElementSource = jest.fn((element: unknown) => {
    const node = { mediaElement: element, connect: jest.fn(), disconnect: jest.fn() };
    mediaSourceNodes.push(node);
    return node;
  });
  resume = jest.fn(() => {
    this.state = 'running';
    return Promise.resolve();
  });
  suspend = jest.fn(() => {
    this.state = 'suspended';
    return Promise.resolve();
  });
  close = jest.fn(() => {
    this.state = 'closed';
    return Promise.resolve();
  });
}

// ---------------------------------------------------------------------------
// Mock Audio element
// ---------------------------------------------------------------------------
type ListenerMap = Record<string, Array<(event: unknown) => void>>;

class MockAudioElement {
  static instances: MockAudioElement[] = [];

  src = '';
  currentTime = 0;
  duration = NaN;
  paused = true;
  loop = false;
  volume = 1;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preload = '';
  crossOrigin: string | null = null;
  preservesPitch = true;
  mozPreservesPitch = true;
  webkitPreservesPitch = true;

  playCalls = 0;
  pauseCalls = 0;
  loadCalls = 0;
  /** Optional override to simulate autoplay rejection / abort. */
  playImpl: (() => Promise<void>) | null = null;

  listeners: ListenerMap = {};

  constructor() {
    MockAudioElement.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void) {
    (this.listeners[type] ||= []).push(handler);
  }

  removeEventListener(type: string, handler: (event: unknown) => void) {
    this.listeners[type] = (this.listeners[type] || []).filter((h) => h !== handler);
  }

  dispatch(type: string) {
    [...(this.listeners[type] || [])].forEach((handler) => handler({ type, target: this }));
  }

  play() {
    this.playCalls += 1;
    if (this.playImpl) return this.playImpl();
    if (this.paused) {
      this.paused = false;
      this.dispatch('play');
    }
    return Promise.resolve();
  }

  pause() {
    this.pauseCalls += 1;
    if (!this.paused) {
      this.paused = true;
      this.dispatch('pause');
    }
  }

  load() {
    this.loadCalls += 1;
  }

  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }

  listenerCount() {
    return Object.values(this.listeners).reduce((sum, list) => sum + list.length, 0);
  }

  static reset() {
    MockAudioElement.instances = [];
  }
}

// ---------------------------------------------------------------------------
// Mock AudioWorkletNode (captures gate / pitch nodes)
// ---------------------------------------------------------------------------
class MockAudioWorkletNode {
  static instances: MockAudioWorkletNode[] = [];
  name: string;
  port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: jest.fn() };
  connect = jest.fn();
  disconnect = jest.fn();

  constructor(_context: AudioContext, name: string) {
    this.name = name;
    MockAudioWorkletNode.instances.push(this);
  }

  emit(data: unknown) {
    this.port.onmessage?.({ data });
  }

  static gateNodes() {
    return MockAudioWorkletNode.instances.filter((n) => n.name === 'sampler-gate-detector');
  }

  static reset() {
    MockAudioWorkletNode.instances = [];
  }
}

// ---------------------------------------------------------------------------
// Harness setup
// ---------------------------------------------------------------------------
const originalGlobals = {
  Audio: (global as any).Audio,
  AudioContext: (global as any).AudioContext,
  webkitAudioContext: (global as any).webkitAudioContext,
  AudioWorkletNode: (global as any).AudioWorkletNode,
  FileReader: (global as any).FileReader,
};

let blobCounter = 0;

const installAudioMocks = () => {
  MockAudioElement.reset();
  MockAudioWorkletNode.reset();
  mediaSourceNodes.length = 0;
  gainNodes.length = 0;
  blobCounter = 0;

  (global as any).Audio = MockAudioElement;
  (global as any).AudioContext = MockAudioContext;
  (global as any).webkitAudioContext = MockAudioContext;
  (global as any).AudioWorkletNode = MockAudioWorkletNode;

  URL.createObjectURL = jest.fn(() => `blob:mock-${blobCounter++}`);
  URL.revokeObjectURL = jest.fn();
};

const sleep = async (ms: number) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

/** Record window timeouts created/cleared by the component under test. */
const trackWindowTimers = () => {
  const created: Array<{ id: number; delay: number }> = [];
  const cleared: number[] = [];
  const origSet = window.setTimeout.bind(window);
  const origClear = window.clearTimeout.bind(window);
  const setSpy = jest
    .spyOn(window, 'setTimeout')
    .mockImplementation(((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
      const id = origSet(fn as any, delay, ...args) as unknown as number;
      created.push({ id, delay: delay ?? 0 });
      return id as any;
    }) as typeof window.setTimeout);
  const clearSpy = jest
    .spyOn(window, 'clearTimeout')
    .mockImplementation(((id?: number) => {
      if (typeof id === 'number') cleared.push(id);
      return origClear(id as any);
    }) as typeof window.clearTimeout);
  return {
    created,
    cleared,
    /** Pending timers with a given delay (used to isolate fade/retry timers). */
    pendingWithDelay: (delay: number) =>
      created.filter((t) => t.delay === delay && !cleared.includes(t.id)).map((t) => t.id),
    restore: () => {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    },
  };
};

const renderSampler = (props: Record<string, unknown> = {}) => {
  const output = createMockStreamRef();
  const ref = React.createRef<SamplerHandle>();
  const result = render(<Sampler ref={ref} output={output} {...(props as any)} />);
  return { output, ref, ...result };
};

const getAudioElement = async (index = 0): Promise<MockAudioElement> => {
  await waitFor(() => {
    expect(MockAudioElement.instances.length).toBeGreaterThan(index);
  });
  return MockAudioElement.instances[index];
};

const getGateNode = async (): Promise<MockAudioWorkletNode> => {
  await waitFor(() => {
    expect(MockAudioWorkletNode.gateNodes().length).toBeGreaterThan(0);
  });
  return MockAudioWorkletNode.gateNodes()[0];
};

const loadMetadata = async (element: MockAudioElement, duration: number) => {
  await act(async () => {
    element.duration = duration;
    element.dispatch('loadedmetadata');
  });
};

const makeReady = async (element: MockAudioElement) => {
  await act(async () => {
    element.dispatch('canplaythrough');
  });
};

const setCurrentTimeAndTick = async (element: MockAudioElement, time: number) => {
  await act(async () => {
    element.currentTime = time;
    element.dispatch('timeupdate');
  });
};

describe('Sampler session lifecycle', () => {
  beforeEach(() => {
    installAudioMocks();
  });

  afterEach(() => {
    (global as any).Audio = originalGlobals.Audio;
    (global as any).AudioContext = originalGlobals.AudioContext;
    (global as any).webkitAudioContext = originalGlobals.webkitAudioContext;
    (global as any).AudioWorkletNode = originalGlobals.AudioWorkletNode;
    (global as any).FileReader = originalGlobals.FileReader;
  });

  describe('source swap as a new session', () => {
    it('resets playback state and releases the previous element/source node', async () => {
      const { ref, rerender, output } = renderSampler({ src: 'a.wav' });

      const first = await getAudioElement(0);
      await loadMetadata(first, 10);
      await makeReady(first);
      await act(async () => {
        await ref.current!.trigger();
      });
      expect(first.playCalls).toBeGreaterThan(0);
      expect(ref.current!.getState().duration).toBe(10);
      expect(ref.current!.getState().isReady).toBe(true);

      await act(async () => {
        rerender(<Sampler ref={ref} output={output} src="b.wav" />);
      });

      const state = ref.current!.getState();
      expect(state.isPlaying).toBe(false);
      expect(state.currentTime).toBe(0);
      expect(state.duration).toBe(0);
      expect(state.isReady).toBe(false);

      // Old element is paused, detached from its listeners and its src removed.
      expect(first.paused).toBe(true);
      expect(first.src).toBe('');
      expect(first.listenerCount()).toBe(0);

      // Old MediaElementSource is disconnected.
      expect(mediaSourceNodes[0].disconnect).toHaveBeenCalled();

      // A brand-new element/source node serves the new session.
      const second = await getAudioElement(1);
      expect(second.src).toBe('b.wav');
      expect(second).not.toBe(first);
      expect(mediaSourceNodes[1].mediaElement).toBe(second);
    });

    it('cancels a pending stop fade so it cannot pause the new session', async () => {
      const timers = trackWindowTimers();
      try {
        const { ref, rerender, output } = renderSampler({ src: 'a.wav' });
        const first = await getAudioElement(0);
        await loadMetadata(first, 10);
        await act(async () => {
          await ref.current!.trigger();
        });
        expect(first.paused).toBe(false);

        // Stop schedules a 45ms fade-out timer, then the source changes.
        await act(async () => {
          ref.current!.stop();
        });
        const pendingFade = timers.pendingWithDelay(45);
        expect(pendingFade.length).toBe(1);

        await act(async () => {
          rerender(<Sampler ref={ref} output={output} src="b.wav" />);
        });
        expect(timers.cleared).toContain(pendingFade[0]);

        const second = await getAudioElement(1);
        // Simulate the new session actively playing.
        await act(async () => {
          await second.play();
        });
        const pauseCallsAfterPlay = second.pauseCalls;

        // Let the old fade window elapse.
        await sleep(120);

        expect(second.pauseCalls).toBe(pauseCallsAfterPlay);
        expect(second.paused).toBe(false);
      } finally {
        timers.restore();
      }
    });

    it('retries once when play() is aborted (control for timer cleanup)', async () => {
      const { ref } = renderSampler({ src: 'a.wav' });
      const first = await getAudioElement(0);
      await loadMetadata(first, 10);

      let attempts = 0;
      first.playImpl = () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }
        first.paused = false;
        first.dispatch('play');
        return Promise.resolve();
      };

      await act(async () => {
        await ref.current!.trigger();
      });
      await sleep(30);

      expect(first.playCalls).toBe(2);
    });

    it('clears a pending play-retry timer when the source changes', async () => {
      const { ref, rerender, output } = renderSampler({ src: 'a.wav' });
      const first = await getAudioElement(0);
      await loadMetadata(first, 10);

      first.playImpl = () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));

      // Fake timers from here so the 0ms retry cannot fire before we swap src.
      jest.useFakeTimers();
      try {
        await act(async () => {
          await ref.current!.trigger();
        });
        // Flush the rejection handler's microtask so the retry timer exists.
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(first.playCalls).toBe(1);
        expect(jest.getTimerCount()).toBe(1);

        await act(async () => {
          rerender(<Sampler ref={ref} output={output} src="b.wav" />);
        });
        // Session teardown cancelled the retry timer.
        expect(jest.getTimerCount()).toBe(0);

        await act(async () => {
          jest.runOnlyPendingTimers();
        });
        // The stale retry must not fire against the old element.
        expect(first.playCalls).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('cleans up listeners and timers on unmount', async () => {
      const { ref, unmount } = renderSampler({ src: 'a.wav' });
      const first = await getAudioElement(0);
      await loadMetadata(first, 10);
      await act(async () => {
        await ref.current!.trigger();
      });

      await act(async () => {
        ref.current!.stop();
      });

      unmount();

      expect(first.listenerCount()).toBe(0);
      expect(first.paused).toBe(true);
      expect(mediaSourceNodes[0].disconnect).toHaveBeenCalled();

      // Pending fade timer must not fire after unmount.
      const pauseCalls = first.pauseCalls;
      await sleep(80);
      expect(first.pauseCalls).toBe(pauseCalls);
    });
  });

  describe('blob url ownership', () => {
    it('never revokes a blob URL that belongs to the new session', async () => {
      const { rerender, output } = renderSampler({ src: 'blob:old-sample' });
      await getAudioElement(0);

      await act(async () => {
        rerender(<Sampler output={output} src="blob:new-sample" />);
      });
      await getAudioElement(1);
      await sleep(10);

      expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:new-sample');
      expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:old-sample');
    });

    it('revokes a component-created blob URL once it is no longer live', async () => {
      class FailingFileReader {
        onload: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        result: string | ArrayBuffer | null = null;
        readAsDataURL() {
          setTimeout(() => this.onerror?.({ type: 'error' }), 0);
        }
      }
      (global as any).FileReader = FailingFileReader;

      const { ref } = renderSampler({});
      await waitFor(() => expect(ref.current).toBeTruthy());

      await act(async () => {
        ref.current!.loadFile(new File(['x'], 'one.wav', { type: 'audio/wav' }));
      });
      await waitFor(() => expect(ref.current!.getState().src).toMatch(/^blob:/));
      const firstUrl = ref.current!.getState().src;
      await getAudioElement(0);

      await act(async () => {
        ref.current!.loadFile(new File(['y'], 'two.wav', { type: 'audio/wav' }));
      });
      await waitFor(() => expect(ref.current!.getState().src).not.toBe(firstUrl));
      const secondUrl = ref.current!.getState().src;
      expect(secondUrl).toMatch(/^blob:/);
      await getAudioElement(1);

      await sleep(20);

      expect(URL.revokeObjectURL).toHaveBeenCalledWith(firstUrl);
      expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(secondUrl);
      expect((URL.revokeObjectURL as jest.Mock).mock.calls.filter(([url]) => url === firstUrl)).toHaveLength(1);
      expect(ref.current!.getState().fileName).toBe('two.wav');
    });

    it('revokes an in-use blob URL created by the component on unmount', async () => {
      class FailingFileReader {
        onload: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        result: string | ArrayBuffer | null = null;
        readAsDataURL() {
          setTimeout(() => this.onerror?.({ type: 'error' }), 0);
        }
      }
      (global as any).FileReader = FailingFileReader;

      const { ref, unmount } = renderSampler({});
      await waitFor(() => expect(ref.current).toBeTruthy());

      await act(async () => {
        ref.current!.loadFile(new File(['x'], 'one.wav', { type: 'audio/wav' }));
      });
      await waitFor(() => expect(ref.current!.getState().src).toMatch(/^blob:/));
      const url = ref.current!.getState().src;
      await getAudioElement(0);

      unmount();
      await sleep(10);

      expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
    });
  });

  describe('gate / playback-mode coordination', () => {
    it('does not autoplay in gate mode when the gate is low, even after async readiness', async () => {
      const gate = createMockStreamRef();
      renderSampler({ src: 'a.wav', playbackMode: 'gate', gate });
      const element = await getAudioElement(0);
      const gateNode = await getGateNode();
      expect(gateNode).toBeDefined();

      await loadMetadata(element, 10);
      await makeReady(element);
      await sleep(20);

      expect(element.playCalls).toBe(0);
      expect(element.paused).toBe(true);
    });

    it('restarts the new sample after a src change while the gate is high', async () => {
      const gate = createMockStreamRef();
      const { rerender, output } = renderSampler({ src: 'a.wav', playbackMode: 'gate', gate });
      const first = await getAudioElement(0);
      const gateNode = await getGateNode();
      await loadMetadata(first, 10);

      await act(async () => {
        gateNode.emit({ type: 'gate-on' });
      });
      expect(first.playCalls).toBeGreaterThan(0);

      await act(async () => {
        rerender(<Sampler output={output} src="b.wav" playbackMode="gate" gate={gate} />);
      });
      const second = await getAudioElement(1);
      await loadMetadata(second, 8);
      await makeReady(second);

      await waitFor(() => {
        expect(second.playCalls).toBeGreaterThan(0);
      });
      expect(second.paused).toBe(false);
    });

    it('does not interrupt a one-shot sample on a falling gate edge', async () => {
      const gate = createMockStreamRef();
      renderSampler({ src: 'a.wav', playbackMode: 'one-shot', gate });
      const element = await getAudioElement(0);
      const gateNode = await getGateNode();
      await loadMetadata(element, 10);

      await act(async () => {
        gateNode.emit({ type: 'gate-on' });
      });
      expect(element.playCalls).toBeGreaterThan(0);
      expect(element.paused).toBe(false);

      await act(async () => {
        gateNode.emit({ type: 'gate-off' });
      });
      await sleep(80);

      expect(element.paused).toBe(false);
      expect(element.pauseCalls).toBe(0);
    });

    it('stops in loop mode on a falling gate edge', async () => {
      const gate = createMockStreamRef();
      renderSampler({ src: 'a.wav', playbackMode: 'loop', gate });
      const element = await getAudioElement(0);
      const gateNode = await getGateNode();
      await loadMetadata(element, 10);

      await act(async () => {
        gateNode.emit({ type: 'gate-on' });
      });
      expect(element.paused).toBe(false);

      await act(async () => {
        gateNode.emit({ type: 'gate-off' });
      });

      await waitFor(() => {
        expect(element.paused).toBe(true);
      });
    });

    it('does not start loop mode on gate-on when gate becomes low before the swap completes', async () => {
      const gate = createMockStreamRef();
      const { rerender, output } = renderSampler({ src: 'a.wav', playbackMode: 'loop', gate });
      const first = await getAudioElement(0);
      const gateNode = await getGateNode();
      await loadMetadata(first, 10);

      await act(async () => {
        gateNode.emit({ type: 'gate-on' });
      });
      await act(async () => {
        gateNode.emit({ type: 'gate-off' });
      });
      await sleep(80);

      // Swap while the gate is low.
      await act(async () => {
        rerender(<Sampler output={output} src="b.wav" playbackMode="loop" gate={gate} />);
      });
      const second = await getAudioElement(1);
      const callsBefore = second.playCalls;
      await loadMetadata(second, 8);
      await makeReady(second);
      await sleep(30);

      expect(second.playCalls).toBe(callsBefore);
      expect(second.paused).toBe(true);
    });

    it('applies a mode switch immediately: gate -> one-shot keeps playing', async () => {
      const gate = createMockStreamRef();
      const { rerender, output } = renderSampler({ src: 'a.wav', playbackMode: 'gate', gate });
      const element = await getAudioElement(0);
      const gateNode = await getGateNode();
      await loadMetadata(element, 10);

      await act(async () => {
        gateNode.emit({ type: 'gate-on' });
      });
      expect(element.paused).toBe(false);

      await act(async () => {
        rerender(<Sampler output={output} src="a.wav" playbackMode="one-shot" gate={gate} />);
      });
      await sleep(80);

      expect(element.paused).toBe(false);
    });

    it('applies a mode switch immediately: one-shot -> gate with gate low stops', async () => {
      const gate = createMockStreamRef();
      const { rerender, output } = renderSampler({ src: 'a.wav', playbackMode: 'one-shot', gate });
      const element = await getAudioElement(0);
      const gateNode = await getGateNode();
      await loadMetadata(element, 10);

      await act(async () => {
        gateNode.emit({ type: 'gate-on' });
      });
      await act(async () => {
        gateNode.emit({ type: 'gate-off' });
      });
      expect(element.paused).toBe(false);

      await act(async () => {
        rerender(<Sampler output={output} src="a.wav" playbackMode="gate" gate={gate} />);
      });

      await waitFor(() => {
        expect(element.paused).toBe(true);
      });
    });

    it('starts playback when switching to loop mode while the gate is held high', async () => {
      const gate = createMockStreamRef();
      const { rerender, output } = renderSampler({ src: 'a.wav', playbackMode: 'one-shot', gate });
      const element = await getAudioElement(0);
      const gateNode = await getGateNode();
      await loadMetadata(element, 10);

      await act(async () => {
        gateNode.emit({ type: 'gate-on' });
      });
      // Simulate the one-shot sample having ended.
      await act(async () => {
        element.pause();
        element.currentTime = 0;
      });
      const playCallsBefore = element.playCalls;

      await act(async () => {
        rerender(<Sampler output={output} src="a.wav" playbackMode={'loop' as PlaybackMode} gate={gate} />);
      });

      await waitFor(() => {
        expect(element.playCalls).toBeGreaterThan(playCallsBefore);
      });
      expect(element.paused).toBe(false);
    });
  });

  describe('stop fade and gain convergence', () => {
    it('restores the configured gain after a stop fade', async () => {
      const { ref } = renderSampler({ src: 'a.wav', gain: 0.6 });
      const element = await getAudioElement(0);
      await loadMetadata(element, 10);

      await act(async () => {
        await ref.current!.trigger();
      });

      const gainParam = getOutputGainParam();

      await act(async () => {
        ref.current!.stop();
      });
      await sleep(90);

      expect(element.paused).toBe(true);
      expect(gainParam.value).toBeCloseTo(0.6, 5);
    });

    it('converges to the latest gain value when it changes during the fade', async () => {
      const { ref, rerender, output } = renderSampler({ src: 'a.wav', gain: 0.6 });
      const element = await getAudioElement(0);
      await loadMetadata(element, 10);
      await act(async () => {
        await ref.current!.trigger();
      });

      const gainParam = getOutputGainParam();

      await act(async () => {
        ref.current!.stop();
      });
      // Change gain while the fade-out is still pending.
      await act(async () => {
        rerender(<Sampler ref={ref} output={output} src="a.wav" gain={0.9} />);
      });
      await sleep(90);

      expect(element.paused).toBe(true);
      expect(gainParam.value).toBeCloseTo(0.9, 5);
    });

    it('starts each new session at the configured gain despite a prior fade', async () => {
      const { ref, rerender, output } = renderSampler({ src: 'a.wav', gain: 0.5 });
      const first = await getAudioElement(0);
      await loadMetadata(first, 10);
      await act(async () => {
        await ref.current!.trigger();
      });
      const gainParam = getOutputGainParam();
      await act(async () => {
        ref.current!.stop();
      });

      // Swap source in the middle of the fade.
      await act(async () => {
        rerender(<Sampler ref={ref} output={output} src="b.wav" gain={0.5} />);
      });
      const second = await getAudioElement(1);
      await loadMetadata(second, 5);
      await act(async () => {
        await ref.current!.trigger();
      });
      await sleep(80);

      expect(second.paused).toBe(false);
      expect(gainParam.value).toBeCloseTo(0.5, 5);
    });
  });

  describe('region / loop handling', () => {
    it('loops using the updated endTime after a region change', async () => {
      const gate = createMockStreamRef();
      const { rerender, output } = renderSampler({
        src: 'a.wav',
        playbackMode: 'loop',
        gate,
        startTime: 1,
        endTime: 2,
      });
      const element = await getAudioElement(0);
      const gateNode = await getGateNode();
      await loadMetadata(element, 10);

      await act(async () => {
        gateNode.emit({ type: 'gate-on' });
      });

      // Past the old end (2s) -> wraps to region start.
      await setCurrentTimeAndTick(element, 2.5);
      expect(element.currentTime).toBe(1);

      // Widen the region; 6s is now inside it and must not wrap to start.
      await act(async () => {
        rerender(
          <Sampler output={output} src="a.wav" playbackMode="loop" gate={gate} startTime={1} endTime={5} />
        );
      });
      await setCurrentTimeAndTick(element, 6);
      expect(element.currentTime).toBe(1);

      // 4s is inside the new [1,5] region and is left alone.
      await setCurrentTimeAndTick(element, 4);
      expect(element.currentTime).toBe(4);
    });

    it('survives an invalid region (end < start) without crashing', async () => {
      const gate = createMockStreamRef();
      const { ref, rerender, output } = renderSampler({
        src: 'a.wav',
        playbackMode: 'loop',
        gate,
        startTime: 1,
        endTime: 2,
      });
      const element = await getAudioElement(0);
      const gateNode = await getGateNode();
      await loadMetadata(element, 10);

      await act(async () => {
        gateNode.emit({ type: 'gate-on' });
      });

      await act(async () => {
        rerender(
          <Sampler ref={ref} output={output} src="a.wav" playbackMode="loop" gate={gate} startTime={5} endTime={2} />
        );
      });

      await setCurrentTimeAndTick(element, 6);
      await setCurrentTimeAndTick(element, 7);

      expect(element.currentTime).toBe(7);
      expect(ref.current!.getState().duration).toBe(10);
      expect(ref.current!.getState().error).toBeNull();
    });
  });
});
