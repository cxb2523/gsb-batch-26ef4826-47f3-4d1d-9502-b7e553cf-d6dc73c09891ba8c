// AudioWorklet over the runtime's ScriptProcessorNode.
//
// The platform's WebAudioContext has no audioWorklet: its API reference names none, and createScriptProcessor is how it
// runs script on audio. A web game that uses a worklet stops at `ctx.audioWorklet.addModule` -- Godot 4's web export
// loads its position-reporting processor whatever its audio driver, and its default driver is a worklet.
//
// Here the processors run on the game's own thread, on a ScriptProcessorNode: each of its blocks is cut into the
// 128-frame render quanta a processor's process() is called with. What content sees is the AudioWorklet API --
// addModule, registerProcessor, AudioWorkletProcessor and its port, AudioWorkletNode with its port and parameters. What
// it costs is the ScriptProcessorNode's latency (two blocks of BLOCK frames) and that a processor shares the game's
// thread, which is where a single-threaded web export's audio is mixed anyway.
//
// Lifecycle follows the real graph: a fresh node is held by a silent gain chain so a node connected to nothing still
// renders, but node.disconnect() suspends it (processor uncalled, chain released) until a connect() resumes it; a
// context close, a process() returning false or a process() throwing ends the node for good -- the chain is torn down,
// both message ports close and parameter scheduling refuses -- with processorerror dispatched at most once.

import { readScript } from "./worker.js";
import DOMException from "./dom-exception.js";

const QUANTUM = 128;
// Frames per ScriptProcessorNode block: four quanta. Smaller than a game's own output buffer (Godot's is about 1024
// frames), so a block never asks for more than the processor has been given; ~21 ms of latency at 48 kHz.
const BLOCK = 512;

// --- MessagePort, in-thread -------------------------------------------------------------------------------------------

/// A copy of `value` as postMessage would deliver it: a structured clone of the kinds a game posts to its processor.
function cloneMessage(value, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  let copy;
  if (ArrayBuffer.isView(value)) {
    copy = value.slice();
  } else if (value instanceof ArrayBuffer) {
    copy = value.slice(0);
  } else if (Array.isArray(value)) {
    copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(cloneMessage(item, seen));
    return copy;
  } else if (value instanceof Map) {
    copy = new Map();
    seen.set(value, copy);
    for (const [k, v] of value) copy.set(cloneMessage(k, seen), cloneMessage(v, seen));
    return copy;
  } else if (value instanceof Set) {
    copy = new Set();
    seen.set(value, copy);
    for (const v of value) copy.add(cloneMessage(v, seen));
    return copy;
  } else if (value instanceof Date) {
    copy = new Date(value.getTime());
  } else {
    copy = {};
    seen.set(value, copy);
    for (const key of Object.keys(value)) copy[key] = cloneMessage(value[key], seen);
    return copy;
  }
  seen.set(value, copy);
  return copy;
}

class WorkletPort {
  constructor() {
    this._peer = null;
    this._listeners = [];
    this._closed = false;
    this.onmessage = null;
    this.onmessageerror = null;
  }

  /// Delivered to the other end on a later microtask, as a copy: after the caller's own code has run, before the next
  /// block -- what a message between the game and the audio thread amounts to here.
  postMessage(message) {
    const peer = this._peer;
    if (this._closed || peer === null || peer._closed) return;
    const data = cloneMessage(message);
    queueMicrotask(() => peer._deliver(data));
  }

  _deliver(data) {
    if (this._closed) return;
    const event = { type: "message", data, target: this, currentTarget: this, ports: [] };
    for (const handler of [this.onmessage, ...this._listeners]) {
      if (typeof handler !== "function") continue;
      try {
        handler.call(this, event);
      } catch (error) {
        console.error("[migo-web-adapter] an AudioWorklet message handler threw:", error);
      }
    }
  }

  addEventListener(type, listener) {
    if (type === "message" && typeof listener === "function" && !this._listeners.includes(listener)) this._listeners.push(listener);
  }

  removeEventListener(type, listener) {
    if (type !== "message") return;
    const at = this._listeners.indexOf(listener);
    if (at !== -1) this._listeners.splice(at, 1);
  }

  start() {}

  close() {
    this._closed = true;
  }
}

function portPair() {
  const a = new WorkletPort();
  const b = new WorkletPort();
  a._peer = b;
  b._peer = a;
  return [a, b];
}

// --- AudioParam for a processor's parameterDescriptors ---------------------------------------------------------------

/// A parameter as a processor sees it: one value per quantum (k-rate), taken from the events scheduled on it.
class WorkletParam {
  constructor(descriptor, initial) {
    this.defaultValue = descriptor.defaultValue ?? 0;
    this.minValue = descriptor.minValue ?? -3.4028234663852886e38;
    this.maxValue = descriptor.maxValue ?? 3.4028234663852886e38;
    this.automationRate = descriptor.automationRate ?? "a-rate";
    this._value = initial ?? this.defaultValue;
    this._events = [];
    // A node that has left the graph for good (process returned false/threw, or the context closed) schedules nothing.
    this._stopped = false;
  }

  get value() {
    return this._value;
  }

  set value(v) {
    if (this._stopped) throw new DOMException("the AudioWorkletNode is no longer processing", "InvalidStateError");
    this._events.length = 0;
    this._value = Number(v);
  }

  _schedule(value, time) {
    if (this._stopped) throw new DOMException("the AudioWorkletNode is no longer processing", "InvalidStateError");
    this._events.push({ time: Number(time), value: Number(value) });
    this._events.sort((x, y) => x.time - y.time);
    return this;
  }

  setValueAtTime(value, time) {
    return this._schedule(value, time);
  }

  // Ramps arrive at their value at their end time: a k-rate approximation.
  linearRampToValueAtTime(value, time) {
    return this._schedule(value, time);
  }

  exponentialRampToValueAtTime(value, time) {
    return this._schedule(value, time);
  }

  setTargetAtTime(value, time) {
    return this._schedule(value, time);
  }

  cancelScheduledValues(time) {
    if (this._stopped) throw new DOMException("the AudioWorkletNode is no longer processing", "InvalidStateError");
    this._events = this._events.filter((event) => event.time < Number(time));
    return this;
  }

  _stop() {
    this._stopped = true;
    this._events.length = 0;
  }

  _at(time) {
    while (this._events.length > 0 && this._events[0].time <= time) this._value = this._events.shift().value;
    return Math.min(this.maxValue, Math.max(this.minValue, this._value));
  }
}

// --- AudioWorklet, one per context ----------------------------------------------------------------------------------

let constructingPort = null;

/// The base of the processors content registers. Its port is the one the node being constructed holds the other end of.
class AudioWorkletProcessor {
  constructor() {
    if (constructingPort === null) throw new TypeError("AudioWorkletProcessor is constructed by an AudioWorkletNode");
    this.port = constructingPort;
  }
}

class AudioWorklet {
  constructor(context) {
    this._context = context;
    this._processors = new Map();
    // addModule is idempotent per URL: a module's script is evaluated once, the first time it is asked for.
    this._modules = new Set();
    this._closed = false;
    // Every node this worklet has built, so a context close can stop them all; entries vanish with the node itself.
    this._nodes = new Set();
    if (typeof FinalizationRegistry === "function") {
      this._finalizer = new FinalizationRegistry((record) => this._nodes.delete(record.node));
    }
    const worklet = this;
    // AudioWorkletGlobalScope: what a processor script sees before the game's globals.
    this._scope = {
      AudioWorkletProcessor,
      registerProcessor(name, processor) {
        name = String(name);
        if (name === "") throw new DOMException("a processor needs a name", "NotSupportedError");
        if (worklet._processors.has(name)) throw new DOMException(`a processor "${name}" is already registered`, "NotSupportedError");
        if (typeof processor !== "function" || !(processor.prototype instanceof AudioWorkletProcessor || processor === AudioWorkletProcessor)) {
          throw new TypeError("registerProcessor takes a class extending AudioWorkletProcessor");
        }
        const descriptors = processor.parameterDescriptors;
        worklet._processors.set(name, { processor, descriptors: Array.isArray(descriptors) ? descriptors : [] });
      },
      sampleRate: context.sampleRate,
      currentFrame: 0,
      currentTime: 0,
    };
  }

  /// Evaluates the processor script at `url` (a path in the game's package, a blob: or data: URL) in the worklet's
  /// scope. The same URL is evaluated only once: later calls resolve without re-running the script or re-registering
  /// its processors (a repeated registration in a re-run would also be an error of its own). Rejects with what stopped
  /// the first evaluation, and with InvalidStateError once the context has closed.
  addModule(url) {
    if (this._closed) {
      return Promise.reject(new DOMException("the AudioContext is closed", "InvalidStateError"));
    }
    const key = String(url);
    if (this._modules.has(key)) return Promise.resolve();
    try {
      const source = readScript(url);
      const run = new Function("__migoWorkletScope", "with (__migoWorkletScope) {\n" + source + "\n}");
      run.call(this._scope, this._scope);
      this._modules.add(key);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

const worklets = new WeakMap();
function workletOf(context) {
  let worklet = worklets.get(context);
  if (worklet === undefined) {
    worklet = new AudioWorklet(context);
    worklets.set(context, worklet);
  }
  return worklet;
}

// --- AudioWorkletNode -----------------------------------------------------------------------------------------------

const nodeState = new WeakMap();
// Graph edges touching worklet nodes: what feeds a node (its inputs) and where a node feeds (its outputs). Connection
// tracking on both ends is what lets disconnect() decide whether the node still belongs to the graph.
const incoming = new WeakMap();
const outgoing = new WeakMap();

function incomingOf(node) {
  let set = incoming.get(node);
  if (set === undefined) { set = new Set(); incoming.set(node, set); }
  return set;
}
function outgoingOf(node) {
  let set = outgoing.get(node);
  if (set === undefined) { set = new Set(); outgoing.set(node, set); }
  return set;
}

/// Whether the node is still in the live graph: it starts there even with nothing connected (the silent keep-alive
/// chain stands in for a downstream), and leaves only once content itself disconnects it with neither an input nor an
/// output edge left. A later connect() puts it back.
function inGraph(state) {
  return !state.everDisconnected || incomingOf(state.node).size > 0 || outgoingOf(state.node).size > 0;
}

export function installAudioWorklet(global) {
  const AudioContextClass = global.AudioContext;
  const ScriptProcessorNode = global.ScriptProcessorNode;
  const AudioNode = global.AudioNode;
  if (typeof AudioContextClass !== "function" || typeof ScriptProcessorNode !== "function") return {};
  const base = Object.getPrototypeOf(AudioContextClass.prototype) && "createScriptProcessor" in Object.getPrototypeOf(AudioContextClass.prototype)
    ? Object.getPrototypeOf(AudioContextClass.prototype)
    : AudioContextClass.prototype;
  if ("audioWorklet" in base) return {};

  Object.defineProperty(base, "audioWorklet", {
    get() {
      return workletOf(this);
    },
    enumerable: true,
    configurable: true,
  });

  // Wrap the graph's connect/disconnect once, keeping the originals for the adapter's own keep-alive wiring. Internal
  // calls carry an internal flag so the silent chain never counts as a content edge (and never suspends its own node).
  const INTERNAL = Symbol("migoWorkletInternal");
  const rawConnect = AudioNode && AudioNode.prototype.connect;
  const rawDisconnect = AudioNode && AudioNode.prototype.disconnect;
  if (AudioNode && typeof rawConnect === "function" && !rawConnect._migoWorkletAware) {
    const wrappedConnect = function (destination, ...rest) {
      const result = rawConnect.call(this, destination, ...rest);
      if (rest[0] === INTERNAL) return result;
      if (destination && nodeState.has(destination)) {
        incomingOf(destination).add(this);
        enterGraph(nodeState.get(destination));
      }
      if (nodeState.has(this)) {
        outgoingOf(this).add(destination);
        // An outgoing edge can itself bring a suspended node back into the graph.
        enterGraph(nodeState.get(this));
      }
      return result;
    };
    wrappedConnect._migoWorkletAware = true;
    AudioNode.prototype.connect = wrappedConnect;
  }
  if (AudioNode && typeof rawDisconnect === "function" && !rawDisconnect._migoWorkletAware) {
    const wrappedDisconnect = function (destination, ...rest) {
      // Let the underlying node throw first (an edge that does not exist), as a real AudioNode would.
      rawDisconnect.call(this, destination, ...rest);
      if (rest[0] === INTERNAL) return;
      const isWorkletSource = nodeState.has(this);
      if (destination === undefined) {
        for (const target of outgoingOf(this)) {
          if (nodeState.has(target)) incomingOf(target).delete(this);
        }
        if (isWorkletSource) outgoingOf(this).clear();
      } else if (destination !== null) {
        if (isWorkletSource) outgoingOf(this).delete(destination);
        if (nodeState.has(destination)) incomingOf(destination).delete(this);
      }
      if (isWorkletSource) {
        const state = nodeState.get(this);
        state.everDisconnected = true;
        leaveGraph(state);
      } else if (destination && nodeState.has(destination)) {
        leaveGraph(nodeState.get(destination));
      }
    };
    wrappedDisconnect._migoWorkletAware = true;
    AudioNode.prototype.disconnect = wrappedDisconnect;
  }

  const connectNode = (node, destination) =>
    (typeof rawConnect === "function" ? rawConnect : ScriptProcessorNode.prototype.connect).call(node, destination, INTERNAL);
  const disconnectNode = (node, destination) => {
    if (typeof rawDisconnect === "function") rawDisconnect.call(node, destination, INTERNAL);
  };

  /// (Re)attach the silent path to the destination that keeps an in-graph node rendering, and resume its processor.
  function attachChain(state) {
    if (state.stopped || state.chainAttached) return;
    const { node, keepAlive } = state;
    connectNode(node, keepAlive);
    connectNode(keepAlive, state.worklet._context.destination);
    state.chainAttached = true;
  }

  /// Release the silent path: a suspended or ended node must not keep nodes of its own alive.
  function detachChain(state) {
    if (!state.chainAttached) return;
    const { node, keepAlive } = state;
    try { disconnectNode(node, keepAlive); } catch { /* already gone */ }
    try { disconnectNode(keepAlive, state.worklet._context.destination); } catch { /* already gone */ }
    state.chainAttached = false;
  }

  function enterGraph(state) {
    if (!state || state.stopped) return;
    state.everDisconnected = false;
    attachChain(state);
  }

  function leaveGraph(state) {
    if (!state || state.stopped) return;
    if (!inGraph(state)) detachChain(state);
  }

  /// The end that cannot be undone: process() returned false or threw, or the context closed. No further process()
  /// calls, no more messages either way, no parameter scheduling, and the keep-alive chain is released.
  function stopNode(state) {
    if (state.stopped) return;
    state.stopped = true;
    detachChain(state);
    state.processor = null;
    for (const param of state.parameters.values()) param._stop();
    state.port.close();
    state.processorPort.close();
    state.worklet._nodes.delete(state.node);
    if (state.worklet._finalizer) state.worklet._finalizer.unregister(state.node);
  }

  /// Context close: every node on it stops processing and gives up its keep-alive chain; addModule/building afterwards
  /// is refused.
  function shutdownWorklet(worklet) {
    if (worklet._closed) return;
    worklet._closed = true;
    for (const node of [...worklet._nodes]) {
      const state = nodeState.get(node);
      if (state) stopNode(state);
    }
    worklet._nodes.clear();
  }

  function runBlock(node, event) {
    const state = nodeState.get(node);
    if (!state || state.stopped || !inGraph(state)) return;
    const { worklet, parameters, inputChannels, outputChannels } = state;
    const processor = state.processor;
    if (!processor) return;
    const scope = worklet._scope;
    const rate = scope.sampleRate;
    const inputData = [];
    for (let c = 0; c < inputChannels; c++) inputData.push(event.inputBuffer.getChannelData(c));
    const outputData = [];
    for (let c = 0; c < outputChannels; c++) outputData.push(event.outputBuffer.getChannelData(c));
    const values = {};
    for (let at = 0; at + QUANTUM <= event.outputBuffer.length; at += QUANTUM) {
      scope.currentTime = event.playbackTime + at / rate;
      scope.currentFrame = Math.round(scope.currentTime * rate);
      const inputs = state.numberOfInputs === 0 ? [] : [incomingOf(node).size > 0 ? inputData.map((d) => d.subarray(at, at + QUANTUM)) : []];
      const outputs = state.numberOfOutputs === 0 ? [] : [outputData.map((d) => d.subarray(at, at + QUANTUM))];
      for (const [name, param] of parameters) {
        const block = values[name] || (values[name] = new Float32Array(1));
        block[0] = param._at(scope.currentTime);
      }
      let keepGoing;
      try {
        keepGoing = processor.process(inputs, outputs, values);
      } catch (error) {
        // A throw ends the node exactly once: a second block must neither call process() nor re-dispatch the event.
        stopNode(state);
        console.error("[migo-web-adapter] AudioWorkletProcessor.process threw:", error);
        if (!state.errorReported) {
          state.errorReported = true;
          const handler = state.onprocessorerror;
          if (typeof handler === "function") {
            try {
              handler.call(node, { type: "processorerror", error, target: node, currentTarget: node });
            } catch (e) {
              console.error("[migo-web-adapter] onprocessorerror threw:", e);
            }
          }
        }
        return;
      }
      if (!keepGoing) {
        stopNode(state);
        return;
      }
    }
  }

  // A context close has to reach the worklet. Wrap the prototype's close; contexts whose class defines none (the test
  // double, or an older runtime) get an instance method lazily, so ctx.close() still means something there.
  if (typeof base.close === "function" && !base.close._migoWorkletAware) {
    const close = base.close;
    const wrappedClose = function (...args) {
      const result = close.apply(this, args);
      shutdownWorklet(workletOf(this));
      return result;
    };
    wrappedClose._migoWorkletAware = true;
    base.close = wrappedClose;
  } else if (typeof base.close !== "function") {
    base.close = function () {
      shutdownWorklet(workletOf(this));
      return Promise.resolve();
    };
  }

  function AudioWorkletNode(context, name, options = {}) {
    if (!new.target) throw new TypeError("AudioWorkletNode must be constructed with new");
    const worklet = workletOf(context);
    if (worklet._closed) throw new DOMException("the AudioContext is closed", "InvalidStateError");
    const definition = worklet._processors.get(String(name));
    if (!definition) throw new DOMException(`no processor "${name}" is registered: addModule first`, "InvalidStateError");
    const numberOfInputs = options.numberOfInputs ?? 1;
    const numberOfOutputs = options.numberOfOutputs ?? 1;
    if (numberOfInputs > 1 || numberOfOutputs > 1) {
      throw new DOMException("an AudioWorkletNode here has at most one input and one output", "NotSupportedError");
    }
    if (numberOfInputs === 0 && numberOfOutputs === 0) {
      throw new DOMException("an AudioWorkletNode needs an input or an output", "NotSupportedError");
    }
    const inputChannels = numberOfInputs === 0 ? 0 : (options.channelCount ?? 2);
    const outputChannels = numberOfOutputs === 0
      ? 0
      : (Array.isArray(options.outputChannelCount) && options.outputChannelCount.length > 0 ? options.outputChannelCount[0] : inputChannels || 1);

    const node = context.createScriptProcessor(BLOCK, inputChannels, outputChannels);
    Object.setPrototypeOf(node, new.target.prototype);

    const [nodePort, processorPort] = portPair();
    const parameters = new Map();
    const initial = options.parameterData || {};
    for (const descriptor of definition.descriptors) {
      parameters.set(descriptor.name, new WorkletParam(descriptor, initial[descriptor.name]));
    }
    constructingPort = processorPort;
    let processor;
    try {
      processor = new definition.processor({
        numberOfInputs,
        numberOfOutputs,
        outputChannelCount: [outputChannels],
        parameterData: initial,
        processorOptions: cloneMessage(options.processorOptions),
      });
    } finally {
      constructingPort = null;
    }
    const state = {
      node, worklet, processor, parameters, inputChannels, outputChannels, numberOfInputs, numberOfOutputs,
      port: nodePort, processorPort, stopped: false, everDisconnected: false, chainAttached: false,
      keepAlive: null, onprocessorerror: null, errorReported: false,
    };
    nodeState.set(node, state);
    worklet._nodes.add(node);
    if (worklet._finalizer) worklet._finalizer.register(node, { node }, node);
    node.addEventListener("audioprocess", (event) => runBlock(node, event));
    // An AudioWorkletNode is processed whether or not anything downstream reads it (a node that only reports, like
    // Godot's position processor, is connected to nothing): a silent path to the destination keeps it in the graph
    // until content disconnects it. It is the same chain detachChain() later releases and enterGraph() rebuilds.
    const keepAlive = context.createGain();
    keepAlive.gain.value = 0;
    state.keepAlive = keepAlive;
    attachChain(state);
    return node;
  }
  AudioWorkletNode.prototype = Object.create(ScriptProcessorNode.prototype, {
    constructor: { value: AudioWorkletNode, writable: true, configurable: true },
    port: { get() { return nodeState.get(this)?.port; }, enumerable: true, configurable: true },
    parameters: { get() { return nodeState.get(this)?.parameters; }, enumerable: true, configurable: true },
    onprocessorerror: {
      get() { return nodeState.get(this)?.onprocessorerror ?? null; },
      set(handler) { const state = nodeState.get(this); if (state) state.onprocessorerror = typeof handler === "function" ? handler : null; },
      enumerable: true,
      configurable: true,
    },
  });

  return { AudioWorkletNode, AudioWorkletProcessor };
}

export { AudioWorkletProcessor };
