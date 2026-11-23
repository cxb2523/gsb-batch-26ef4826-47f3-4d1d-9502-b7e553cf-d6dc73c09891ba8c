/**
 * A small, deterministic Web Audio mock used by the lifecycle tests.
 *
 * It models the parts of the Web Audio API that r-audio relies on, most
 * importantly the exact semantics of `connect`/`disconnect`:
 *   - `disconnect()` removes all outgoing edges of a node;
 *   - `disconnect(node)` removes all edges to that node (but not to its params);
 *   - `disconnect(node, output)` / `disconnect(node, output, input)` are precise;
 *   - `disconnect(param)` removes edges to that AudioParam and is the only valid
 *     call for a param target (channel arguments throw `InvalidAccessError`).
 *
 * The mock also implements scheduled sources (`start`/`stop`/`ended`) with a
 * controllable `AudioContext.currentTime`, so "the source naturally ends" can
 * be reproduced without real time passing.
 */

class InvalidAccessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidAccessError';
  }
}

class MockAudioParam {
  constructor(owner, name, value = 0) {
    this._owner = owner;
    this._name = name;
    this.value = value;
    this._events = [];
  }

  setValueAtTime(value, time) {
    this.value = value;
    this._events.push([ 'set', value, time ]);
    return this;
  }

  linearRampToValueAtTime(value, time) {
    this.value = value;
    this._events.push([ 'linear', value, time ]);
    return this;
  }

  exponentialRampToValueAtTime(value, time) {
    this.value = value;
    this._events.push([ 'exponential', value, time ]);
    return this;
  }
}

const isParam = target => target instanceof MockAudioParam;

class MockAudioNode {
  constructor(context, typeName) {
    this.context = context;
    this.typeName = typeName;
    this._outgoing = [];
    this._ended = false;
    this._listeners = {};
  }

  addEventListener(name, fn) {
    (this._listeners[name] = this._listeners[name] || []).push(fn);
  }

  removeEventListener(name, fn) {
    const list = this._listeners[name] || [];
    const index = list.indexOf(fn);
    if (index !== -1) list.splice(index, 1);
  }

  _dispatch(name, event) {
    (this._listeners[name] || []).slice().forEach(fn => fn(event));
  }

  connect(target, output, input) {
    if (isParam(target)) {
      if (arguments.length > 1) {
        throw new InvalidAccessError('Channel arguments are not allowed for AudioParam targets');
      }

      const edge = {
        source: this,
        destination: target._owner,
        target,
        param: target._name,
        output: 0,
        input: null
      };
      this.context._edges.push(edge);
      this._outgoing.push(edge);
      return target;
    }

    if (!(target instanceof MockAudioNode)) {
      throw new TypeError('connect() expects an AudioNode or AudioParam');
    }

    const edge = {
      source: this,
      destination: target,
      target,
      param: null,
      output: output || 0,
      input: input || 0
    };
    this.context._edges.push(edge);
    this._outgoing.push(edge);
    return target;
  }

  disconnect(...args) {
    const matches = edge => {
      if (args.length === 0) return true;

      const first = args[0];

      if (isParam(first)) {
        if (args.length > 1) {
          throw new InvalidAccessError('Channel arguments are not allowed for AudioParam targets');
        }
        return edge.target === first;
      }

      if (!(first instanceof MockAudioNode)) {
        throw new TypeError('disconnect() expects an AudioNode, AudioParam or no arguments');
      }

      if (edge.destination !== first || edge.param) return false;
      if (args.length >= 2 && edge.output !== args[1]) return false;
      if (args.length >= 3 && edge.input !== args[2]) return false;

      return true;
    };

    this._outgoing
      .filter(matches)
      .forEach(edge => this.context._removeEdge(edge));
  }
}

/**
 * Base class for nodes that can be started and stopped.
 */
class MockScheduledSource extends MockAudioNode {
  constructor(context, typeName) {
    super(context, typeName);
    this._started = false;
    this._stopTime = null;
  }

  start(when = 0, offset = 0, duration) {
    if (this._started) {
      throw new InvalidAccessError('The source node cannot be started more than once');
    }

    this._started = true;
    this.startTime = when;
    this.offset = offset;
    this.duration = duration;
    this.context._scheduled.push(this);
  }

  stop(when = 0) {
    this._stopTime = when;
    this.context._flushEnded();
  }

  _maybeEnd(now) {
    if (!this._started || this._ended) return;

    let endTime = this._stopTime;
    if (this.duration !== undefined && this.duration !== null) {
      const durationEnd = this.startTime + this.duration;
      endTime = endTime === null ? durationEnd : Math.min(endTime, durationEnd);
    }

    if (endTime !== null && endTime <= now) {
      this._ended = true;
      this._dispatch('ended', { type: 'ended', target: this });
    }
  }
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this._edges = [];
    this._scheduled = [];
    // every scheduled source created so far (started or not)
    this._scheduledSources = [];
    this._closed = false;
    this.destination = new MockAudioNode(this, 'destination');
    this.state = 'running';
  }

  _removeEdge(edge) {
    const index = this._edges.indexOf(edge);
    if (index !== -1) this._edges.splice(index, 1);

    const ownerIndex = edge.source._outgoing.indexOf(edge);
    if (ownerIndex !== -1) edge.source._outgoing.splice(ownerIndex, 1);
  }

  /**
   * Moves the mocked AudioContext time forward, firing `ended` events for
   * scheduled sources that finish.
   */
  advance(time) {
    this.currentTime = time;
    this._flushEnded();
  }

  _flushEnded() {
    this._scheduled.forEach(node => node._maybeEnd(this.currentTime));
  }

  /**
   * All current edges in the mocked graph, in a readable form.
   */
  edges() {
    return this._edges.map(edge => ({
      source: edge.source.typeName,
      destination: edge.param ? edge.destination.typeName : edge.destination.typeName,
      param: edge.param,
      targetType: edge.param ? 'param:' + edge.param : 'node',
      output: edge.output,
      input: edge.input,
      raw: edge
    }));
  }

  /**
   * Number of distinct connections in the mocked graph.
   */
  connectionCount() {
    return this._edges.length;
  }

  /**
   * Finds every node of the given mocked type ("gain", "oscillator", ...).
   */
  nodesOfType(typeName) {
    const found = new Set();

    if (this.destination.typeName === typeName) found.add(this.destination);

    const visit = node => {
      if (!node || found.has(node)) return;
      if (node.typeName === typeName) found.add(node);

      node._outgoing.forEach(edge => {
        if (edge.destination.typeName === typeName) found.add(edge.destination);
      });
    };

    this._edges.forEach(edge => {
      visit(edge.source);
      visit(edge.destination);
    });

    this._scheduledSources.forEach(visit);

    return Array.from(found);
  }

  /**
   * Every scheduled source created so far, whether or not it was started.
   */
  scheduledSources(typeName) {
    return this._scheduledSources.filter(node =>
      !typeName || node.typeName === typeName);
  }

  // public API used by r-audio
  resume() { this.state = 'running'; }
  suspend() { this.state = 'suspended'; }
  close() { this.state = 'closed'; this._closed = true; }

  createPeriodicWave() { return { type: 'periodic-wave' }; }

  _createNode(typeName, params) {
    const node = new MockAudioNode(this, typeName);

    Object.keys(params || {}).forEach(name => {
      node[name] = new MockAudioParam(node, name, params[name]);
    });

    return node;
  }

  createGain() { return this._createNode('gain', { gain: 1 }); }
  createDelay(maxDelayTime) { void maxDelayTime; return this._createNode('delay', { delayTime: 0 }); }
  createBiquadFilter() { return this._createNode('biquad', { frequency: 350, detune: 0, Q: 1, gain: 0 }); }
  createStereoPanner() { return this._createNode('stereo-panner', { pan: 0 }); }
  createDynamicsCompressor() {
    return this._createNode('compressor', {
      threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25
    });
  }
  createAnalyser() {
    const node = this._createNode('analyser', {});
    node.fftSize = 2048;
    node.frequencyBinCount = 1024;
    return node;
  }
  createConvolver() {
    const node = this._createNode('convolver', {});
    node.buffer = null;
    node.normalize = true;
    return node;
  }
  createWaveShaper() {
    const node = this._createNode('wave-shaper', {});
    node.curve = null;
    node.oversample = 'none';
    return node;
  }
  createPanner() {
    return this._createNode('panner', {
      positionX: 0, positionY: 0, positionZ: 0,
      orientationX: 0, orientationY: 0, orientationZ: 0
    });
  }
  createChannelSplitter(channelCount) {
    const node = this._createNode('channel-splitter', {});
    node.channelCount = channelCount;
    return node;
  }
  createChannelMerger(channelCount) {
    const node = this._createNode('channel-merger', {});
    node.channelCount = channelCount;
    return node;
  }
  createIIRFilter() { return this._createNode('iir-filter', {}); }
  createMediaElementSource(element) {
    const node = this._createNode('media-element-source', {});
    node.element = element;
    return node;
  }
  createMediaStreamSource(stream) {
    const node = this._createNode('media-stream-source', {});
    node.stream = stream;
    return node;
  }

  createOscillator() {
    const node = new MockScheduledSource(this, 'oscillator');
    node.frequency = new MockAudioParam(node, 'frequency', 440);
    node.detune = new MockAudioParam(node, 'detune', 0);
    node.type = 'sine';
    node.setPeriodicWave = wave => { node.periodicWave = wave; };
    this._scheduledSources.push(node);
    return node;
  }

  createConstantSource() {
    const node = new MockScheduledSource(this, 'constant-source');
    node.offset = new MockAudioParam(node, 'offset', 1);
    this._scheduledSources.push(node);
    return node;
  }

  createBufferSource() {
    const node = new MockScheduledSource(this, 'buffer-source');
    node.buffer = null;
    node.detune = new MockAudioParam(node, 'detune', 0);
    node.playbackRate = new MockAudioParam(node, 'playbackRate', 1);
    node.loop = false;
    node.loopStart = 0;
    node.loopEnd = 0;
    this._scheduledSources.push(node);
    // non-looping buffer sources end when their buffer would have finished
    node._maybeEnd = now => {
      if (!node._started || node._ended || node.loop) return;

      let endTime = node._stopTime;
      const duration = node.duration !== undefined && node.duration !== null
        ? node.duration
        : (node.buffer && node.buffer.duration) || null;

      if (duration !== null) {
        const durationEnd = node.startTime + duration;
        endTime = endTime === null ? durationEnd : Math.min(endTime, durationEnd);
      }

      if (endTime !== null && endTime <= now) {
        node._ended = true;
        node._dispatch('ended', { type: 'ended', target: node });
      }
    };
    return node;
  }
}

module.exports = {
  MockAudioContext,
  MockAudioNode,
  MockAudioParam,
  MockScheduledSource,
  InvalidAccessError
};
