/**
 * Minimal Web Audio stand-in for unit tests: enough of `AudioContext` to build
 * the real `AudioGraph`/`Synth`/`Voice` and to observe parameter writes.
 * Not a sound implementation — it only records calls.
 */

export class FakeParam {
  value = 0;
  readonly calls: string[] = [];

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.calls.push(`setValueAtTime:${value}:${time}`);
  }

  setTargetAtTime(value: number, time: number, constant: number): void {
    this.value = value;
    this.calls.push(`setTargetAtTime:${value}:${time}:${constant}`);
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.calls.push(`linearRampToValueAtTime:${value}:${time}`);
  }

  exponentialRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.calls.push(`exponentialRampToValueAtTime:${value}:${time}`);
  }

  cancelScheduledValues(time: number): void {
    this.calls.push(`cancelScheduledValues:${time}`);
  }

  cancelAndHoldAtTime(time: number): void {
    this.calls.push(`cancelAndHoldAtTime:${time}`);
  }
}

export class FakeNode {
  readonly outputs: FakeNode[] = [];
  disconnected = false;

  connect<T extends FakeNode>(dest: T): T {
    this.outputs.push(dest);
    return dest;
  }

  disconnect(): void {
    this.disconnected = true;
    this.outputs.length = 0;
  }
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

export class FakeOscillator extends FakeNode {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeParam();
  readonly detune = new FakeParam();
  started = false;
  stopped = false;
  onended: (() => void) | null = null;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }
}

export class FakeBufferSource extends FakeNode {
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  readonly playbackRate = new FakeParam();
  started = false;
  stopped = false;
  onended: (() => void) | null = null;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }
}

export class FakeBiquad extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  readonly gain = new FakeParam();
}

export class FakeConvolver extends FakeNode {
  buffer: FakeAudioBuffer | null = null;
}

export class FakeDelay extends FakeNode {
  readonly delayTime = new FakeParam();
}

export class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
}

export class FakeWaveShaper extends FakeNode {
  curve: Float32Array | null = null;
}

export class FakePanner extends FakeNode {
  panningModel: PanningModelType = 'equalpower';
  distanceModel: DistanceModelType = 'inverse';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  readonly positionX = new FakeParam();
  readonly positionY = new FakeParam();
  readonly positionZ = new FakeParam();
}

export class FakeAudioBuffer {
  private readonly channels: Float32Array[];

  constructor(channelCount: number, length: number) {
    this.channels = Array.from({ length: channelCount }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

export class FakeListener {
  readonly positionX = new FakeParam();
  readonly positionY = new FakeParam();
  readonly positionZ = new FakeParam();
  readonly forwardX = new FakeParam();
  readonly forwardY = new FakeParam();
  readonly forwardZ = new FakeParam();
  readonly upX = new FakeParam();
  readonly upY = new FakeParam();
  readonly upZ = new FakeParam();
}

/** Every node ever created, in order — lets a test watch a single voice's params. */
export class FakeAudioContext {
  readonly sampleRate = 1000;
  currentTime = 0;
  state: AudioContextState | 'closed' = 'running';
  readonly destination = new FakeNode();
  readonly listener = new FakeListener();
  readonly nodes: FakeNode[] = [];
  resumeCalls = 0;
  suspendCalls = 0;
  closeCalls = 0;

  /** Advances the audio clock (as a running context would over real time). */
  advance(seconds: number): void {
    if (this.state === 'running') this.currentTime += seconds;
  }

  private track<T extends FakeNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  createGain(): FakeGain {
    return this.track(new FakeGain());
  }

  createOscillator(): FakeOscillator {
    return this.track(new FakeOscillator());
  }

  createBufferSource(): FakeBufferSource {
    return this.track(new FakeBufferSource());
  }

  createBiquadFilter(): FakeBiquad {
    return this.track(new FakeBiquad());
  }

  createConvolver(): FakeConvolver {
    return this.track(new FakeConvolver());
  }

  createDelay(): FakeDelay {
    return this.track(new FakeDelay());
  }

  createDynamicsCompressor(): FakeCompressor {
    return this.track(new FakeCompressor());
  }

  createWaveShaper(): FakeWaveShaper {
    return this.track(new FakeWaveShaper());
  }

  createPanner(): FakePanner {
    return this.track(new FakePanner());
  }

  createBuffer(channelCount: number, length: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channelCount, length);
  }

  resume(): Promise<void> {
    this.resumeCalls++;
    this.state = 'running';
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.suspendCalls++;
    this.state = 'suspended';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls++;
    this.state = 'closed';
    return Promise.resolve();
  }
}

const GLOBALS = ['window', 'AudioContext'] as const;

/** Installs the fakes on `globalThis`; returns a restore function. */
export function installFakeAudio(): { ctx: FakeAudioContext; restore: () => void } {
  const ctx = new FakeAudioContext();
  const saved = GLOBALS.map((key) => [key, (globalThis as Record<string, unknown>)[key]] as const);
  const win = { addEventListener(): void {}, removeEventListener(): void {} };
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).AudioContext = function AudioContextCtor(): FakeAudioContext {
    return ctx;
  };
  return {
    ctx,
    restore: () => {
      for (const [key, value] of saved) (globalThis as Record<string, unknown>)[key] = value;
    },
  };
}
