/**
 * Minimal, deterministic mock of the Web Audio API surface used by the v2
 * Game Boy engine. It records the audio graph (connections, gain automation,
 * source start/stop) so tests can assert lifecycle behavior without a browser.
 *
 * Designed for Node --import with a loader that resolves extensionless TS.
 */

let currentTime = 0;

export function __advanceTime(seconds) {
  currentTime += seconds;
}
export function __resetTime() {
  currentTime = 0;
}

class AudioParam {
  constructor(value = 0) {
    this.value = value;
    this._events = [];
  }
  setValueAtTime(v, t) {
    this._events.push({ type: 'setValueAtTime', value: v, time: t });
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v, t) {
    this._events.push({ type: 'linearRamp', value: v, time: t });
    return this;
  }
  exponentialRampToValueAtTime(v, t) {
    this._events.push({ type: 'exponentialRamp', value: v, time: t });
    return this;
  }
  setTargetAtTime(v, t, c) {
    this._events.push({ type: 'setTarget', value: v, time: t, constant: c });
    return this;
  }
  cancelScheduledValues(t) {
    this._events = this._events.filter((e) => e.time < t);
    return this;
  }
}

class AudioNode {
  constructor(ctx) {
    this.context = ctx;
    this.connected = [];
    this.numberOfInputs = 1;
    this.numberOfOutputs = 1;
    this.channelCount = 2;
  }
  connect(dest) {
    this.connected.push(dest);
    return dest;
  }
  disconnect(dest) {
    if (dest === undefined) {
      this.connected.length = 0;
    } else {
      const i = this.connected.indexOf(dest);
      if (i >= 0) this.connected.splice(i, 1);
    }
  }
}

export class GainNode extends AudioNode {
  constructor(ctx, opts) {
    super(ctx);
    this.gain = new AudioParam(opts?.gain ?? 1);
  }
}

export class DynamicsCompressorNode extends AudioNode {
  constructor(ctx) {
    super(ctx);
    this.threshold = new AudioParam(-24);
    this.knee = new AudioParam(30);
    this.ratio = new AudioParam(12);
    this.attack = new AudioParam(0.003);
    this.release = new AudioParam(0.25);
  }
}

export class BiquadFilterNode extends AudioNode {
  constructor(ctx) {
    super(ctx);
    this.type = 'lowpass';
    this.frequency = new AudioParam(350);
    this.Q = new AudioParam(1);
    this.gain = new AudioParam(0);
    this.detune = new AudioParam(0);
  }
}

export class WaveShaperNode extends AudioNode {
  constructor(ctx) {
    super(ctx);
    this.curve = null;
    this.oversample = 'none';
  }
}

export class OscillatorNode extends AudioNode {
  constructor(ctx) {
    super(ctx);
    this.frequency = new AudioParam(440);
    this.detune = new AudioParam(0);
    this.type = 'sine';
    this._onended = null;
    this._started = null;
    this._stopped = null;
    this._periodicWave = null;
  }
  get onended() {
    return this._onended;
  }
  set onended(fn) {
    this._onended = fn;
  }
  setPeriodicWave(w) {
    this._periodicWave = w;
  }
  start(t) {
    this._started = t ?? ctxNow();
  }
  stop(t) {
    if (this._stopped !== null) {
      throw new Error('OscillatorNode already stopped');
    }
    this._stopped = t ?? ctxNow();
    pendingEnded.push(this);
  }
}

export class AudioBufferSourceNode extends AudioNode {
  constructor(ctx) {
    super(ctx);
    this.buffer = null;
    this.loop = false;
    this.playbackRate = new AudioParam(1);
    this._onended = null;
    this._started = null;
    this._stopped = null;
  }
  get onended() {
    return this._onended;
  }
  set onended(fn) {
    this._onended = fn;
  }
  start(t) {
    this._started = t ?? ctxNow();
  }
  stop(t) {
    if (this._stopped !== null) {
      throw new Error('AudioBufferSourceNode already stopped');
    }
    this._stopped = t ?? ctxNow();
    pendingEnded.push(this);
  }
}

export class PeriodicWave {}

export class AudioBuffer {
  constructor({ length, numberOfChannels, sampleRate }) {
    this.length = length;
    this.numberOfChannels = numberOfChannels;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(ch) {
    return this._channels[ch];
  }
}

// Nodes whose stop() has been scheduled; flushEnded() fires their onended,
// mirroring what the real audio thread does once a node reaches its stop time.
const pendingEnded = [];

export function flushEnded() {
  const nodes = pendingEnded.splice(0);
  for (const n of nodes) {
    if (typeof n.onended === 'function') {
      n.onended(new Event('ended'));
    }
  }
}

export function pendingEndedCount() {
  return pendingEnded.length;
}

function ctxNow() {
  return currentTime;
}

export class AudioDestinationNode extends AudioNode {}

export class AudioContext {
  constructor() {
    this.sampleRate = 44100;
    this.state = 'running';
    this.destination = new AudioDestinationNode(this);
    this.currentTime = 0;
    // currentTime is a getter in real contexts; mirror with a live value.
    Object.defineProperty(this, 'currentTime', {
      get: () => currentTime,
      configurable: true,
    });
  }
  createGain() {
    return new GainNode(this);
  }
  createDynamicsCompressor() {
    return new DynamicsCompressorNode(this);
  }
  createBiquadFilter() {
    return new BiquadFilterNode(this);
  }
  createWaveShaper() {
    return new WaveShaperNode(this);
  }
  createOscillator() {
    return new OscillatorNode(this);
  }
  createBufferSource() {
    return new AudioBufferSourceNode(this);
  }
  createBuffer(numberOfChannels, length, sampleRate) {
    return new AudioBuffer({ numberOfChannels, length, sampleRate });
  }
  createPeriodicWave() {
    return new PeriodicWave();
  }
  async resume() {
    this.state = 'running';
  }
  async suspend() {
    this.state = 'suspended';
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

// OfflineAudioContext mirrors AudioContext but additionally records a
// simulated render. startRendering() resolves an AudioBuffer whose samples are
// synthesized from the scheduled source->gain graph: every buffer source
// contributes its (LFSR) samples, scaled by its gain envelope and by the
// static gains of every node on its path to the destination. This is enough
// to assert that noise channels produce non-zero output energy.
export class OfflineAudioContext extends AudioContext {
  constructor(numberOfChannels, length, sampleRate) {
    super();
    this._length = length;
    this._channels = numberOfChannels;
    this._sampleRate = sampleRate;
    this.scheduledSources = [];
    const origCreateSource = this.createBufferSource.bind(this);
    this.createBufferSource = () => {
      const s = origCreateSource();
      this.scheduledSources.push(s);
      return s;
    };
  }

  /** Static product of .gain.value along a node's forward path to destination. */
  _pathGain(node) {
    let gain = 1;
    let current = node;
    const guard = new Set();
    while (current && current !== this.destination && !guard.has(current)) {
      guard.add(current);
      // Our engine graph is a linear chain (source -> gain -> ... -> dest),
      // so the first connected child is the next hop.
      const next = current.connected && current.connected[0];
      if (!next) break;
      if (next.gain && typeof next.gain.value === 'number') {
        gain *= next.gain.value;
      }
      current = next;
    }
    return gain;
  }

  _collectNodes() {
    const seen = new Set();
    const stack = [...this.scheduledSources];
    while (stack.length) {
      const node = stack.pop();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      for (const child of node.connected || []) stack.push(child);
    }
    return seen;
  }

  async startRendering() {
    const out = new AudioBuffer({
      length: this._length,
      numberOfChannels: this._channels,
      sampleRate: this._sampleRate,
    });
    const left = out.getChannelData(0);
    const right = out.getChannelData(1);

    for (const source of this.scheduledSources) {
      if (!source.buffer || source._started === null) continue;
      const startSample = Math.max(0, Math.round(source._started * this._sampleRate));
      const stopSample = source._stopped !== null
        ? Math.round(source._stopped * this._sampleRate)
        : startSample + source.buffer.length;
      const pathGain = this._pathGain(source);
      const input = source.buffer.getChannelData(0);

      // Per-source envelope gain node is its direct (only) connection.
      const envGain = source.connected[0];
      const envEvents = (envGain && envGain.gain ? envGain.gain._events : [])
        .slice()
        .sort((a, b) => a.time - b.time);

      for (let i = 0; i < input.length && startSample + i < stopSample && startSample + i < this._length; i++) {
        const t = (startSample + i) / this._sampleRate;
        const env = evaluateEnvelope(envEvents, t);
        const v = input[i] * env * pathGain;
        const idx = startSample + i;
        left[idx] += v;
        right[idx] += v;
      }
    }

    // Clamp to [-1, 1] like a real render.
    for (let i = 0; i < this._length; i++) {
      left[i] = Math.max(-1, Math.min(1, left[i]));
      right[i] = Math.max(-1, Math.min(1, right[i]));
    }

    // Mirror the real audio thread: every scheduled node reaches its stop.
    flushEnded();
    return out;
  }
}

/** Piecewise-linear evaluation of a recorded gain automation timeline. */
function evaluateEnvelope(events, t) {
  if (events.length === 0) return 1;
  if (t <= events[0].time) return events[0].value;
  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i];
    const b = events[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time || 1e-6;
      const frac = (t - a.time) / span;
      if (b.type === 'exponentialRamp') {
        return a.value * Math.pow(b.value / Math.max(a.value, 1e-6), frac);
      }
      return a.value + (b.value - a.value) * frac;
    }
  }
  return events[events.length - 1].value;
}

// Default globals used when code references bare AudioContext/OfflineAudioContext.
export function installGlobals() {
  globalThis.AudioContext = AudioContext;
  globalThis.OfflineAudioContext = OfflineAudioContext;
  globalThis.AudioBuffer = AudioBuffer;
  globalThis.Event = globalThis.Event || class Event {
    constructor(type) {
      this.type = type;
    }
  };
}
