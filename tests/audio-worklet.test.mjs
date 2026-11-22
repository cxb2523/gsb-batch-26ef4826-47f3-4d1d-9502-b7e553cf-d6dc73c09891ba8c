// AudioWorklet over the runtime's ScriptProcessorNode (src/audio-worklet.js). The platform has no audioWorklet; Godot 4's
// web export loads a processor whatever its audio driver. A fake context stands in for the runtime: its
// ScriptProcessorNode records its handler, and the test hands it blocks as the audio thread would.

import assert from "node:assert/strict";

const files = new Map();
globalThis.migo = {
  getFileSystemManager: () => ({
    readFileSync(path) {
      if (!files.has(path)) throw new Error(`readFileSync:fail no such file or directory ${path}`);
      return files.get(path);
    },
  }),
};

class AudioNode {
  constructor(context) { this.context = context; this.connections = []; }
  connect(destination) { this.connections.push(destination); return destination; }
  disconnect(destination) {
    if (destination === undefined) this.connections.length = 0;
    else {
      const at = this.connections.indexOf(destination);
      if (at !== -1) this.connections.splice(at, 1);
    }
  }
}
class ScriptProcessorNode extends AudioNode {
  constructor(context, bufferSize, inputs, outputs) {
    super(context);
    this.bufferSize = bufferSize;
    this.inputs = inputs;
    this.outputs = outputs;
    this.handlers = [];
  }
  addEventListener(type, handler) { if (type === "audioprocess") this.handlers.push(handler); }
}
class GainNode extends AudioNode {
  constructor(context) { super(context); this.gain = { value: 1 }; }
}
class Buffer {
  constructor(channels, length) { this.channels = Array.from({ length: channels }, () => new Float32Array(length)); this.length = length; }
  getChannelData(c) { return this.channels[c]; }
}
class BaseAudioContext {
  constructor() { this.sampleRate = 48000; this.destination = new AudioNode(this); this.closed = false; }
  createScriptProcessor(bufferSize, inputs, outputs) { return new ScriptProcessorNode(this, bufferSize, inputs, outputs); }
  createGain() { return new GainNode(this); }
  close() { this.closed = true; return Promise.resolve(); }
}
class AudioContext extends BaseAudioContext {}

const fake = { AudioContext, ScriptProcessorNode, AudioNode };
const { installAudioWorklet } = await import("../src/audio-worklet.js");
const { AudioWorkletNode } = installAudioWorklet(fake);

/// Hand the node one block, as the audio thread would, and return the event's output.
function block(node, playbackTime, fill = () => 0) {
  const input = new Buffer(Math.max(1, node.inputs), node.bufferSize);
  input.channels.forEach((data, c) => data.forEach((_, i) => { data[i] = fill(c, i); }));
  const output = new Buffer(Math.max(1, node.outputs), node.bufferSize);
  for (const handler of node.handlers) handler({ type: "audioprocess", playbackTime, inputBuffer: input, outputBuffer: output });
  return output;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const ctx = new AudioContext();
assert.equal(typeof ctx.audioWorklet.addModule, "function", "contexts have an audioWorklet");
assert.equal(ctx.audioWorklet, ctx.audioWorklet, "one per context");

// 1. addModule evaluates the script in the worklet's scope: registerProcessor, AudioWorkletProcessor, sampleRate.
files.set("worklets/tone.js", `
  class Tone extends AudioWorkletProcessor {
    static get parameterDescriptors() { return [{ name: "gain", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" }]; }
    constructor(options) {
      super();
      this.calls = [];
      this.rate = sampleRate;
      this.options = options.processorOptions;
      this.port.onmessage = (event) => { this.port.postMessage({ echo: event.data }); };
    }
    process(inputs, outputs, parameters) {
      this.calls.push([inputs.length, inputs[0].length, outputs[0][0].length, currentFrame]);
      for (const channel of outputs[0]) channel.fill(parameters.gain[0]);
      globalThis.__lastTone = this;
      return true;
    }
  }
  registerProcessor("tone", Tone);
`);
await ctx.audioWorklet.addModule("worklets/tone.js");
await assert.rejects(ctx.audioWorklet.addModule("worklets/missing.js"), /no such file/, "a missing module rejects");
assert.throws(() => new AudioWorkletNode(ctx, "nope"), { name: "InvalidStateError" }, "an unregistered processor is refused");

// 2. A node runs its processor on a ScriptProcessorNode: each block is four quanta of 128 frames.
const node = new AudioWorkletNode(ctx, "tone", { outputChannelCount: [2], processorOptions: { voice: "a" } });
assert.ok(node instanceof AudioWorkletNode && node instanceof ScriptProcessorNode && node instanceof AudioNode);
assert.equal(node.bufferSize, 512);
assert.equal(node.outputs, 2);
assert.equal(node.connections[0] instanceof GainNode && node.connections[0].gain.value, 0, "kept in the graph by a silent path");
const out = block(node, 2.0);
const tone = globalThis.__lastTone;
assert.equal(tone.rate, 48000);
assert.deepEqual(tone.options, { voice: "a" });
assert.equal(tone.calls.length, 4);
assert.deepEqual(tone.calls.map((c) => c.slice(0, 3)), Array(4).fill([1, 0, 128]), "nothing connected in: an input of no channels");
assert.deepEqual(tone.calls.map((c) => c[3]), [96000, 96128, 96256, 96384], "currentFrame advances a quantum at a time");
assert.ok(out.channels.every((data) => data.every((s) => s === 0.5)), "the processor's output is the block's output");

// 3. Parameters: setValueAtTime takes effect at the quantum it falls in.
node.parameters.get("gain").setValueAtTime(0.25, 3.0 + 256 / 48000);
const later = block(node, 3.0);
assert.equal(later.channels[0][0], 0.5);
assert.equal(later.channels[0][256], 0.25);

// 4. Ports: messages cross as copies, after the sender's code has run.
const received = [];
node.port.onmessage = (event) => received.push(event.data);
const payload = { cmd: "chunk", data: new Float32Array([1, 2]) };
node.port.postMessage(payload);
payload.data[0] = 9;
assert.deepEqual(received, [], "not delivered synchronously");
await settle();
assert.equal(received.length, 1);
assert.deepEqual([...received[0].echo.data], [1, 2], "a copy: the sender's later write is not seen");

// 5. An input with channels once something is connected into the node.
const source = new AudioNode(ctx);
source.connect(node);
block(node, 4.0, (c, i) => i);
assert.equal(tone.calls.at(-1)[1], 2, "two input channels");

// 6. process() returning false ends it; a throw ends it and reports processorerror.
files.set("worklets/once.js", `
  registerProcessor("once", class extends AudioWorkletProcessor { process() { globalThis.__once = (globalThis.__once || 0) + 1; return false; } });
  registerProcessor("broken", class extends AudioWorkletProcessor { process() { throw new Error("boom"); } });
`);
await ctx.audioWorklet.addModule("worklets/once.js");
const once = new AudioWorkletNode(ctx, "once");
block(once, 0);
block(once, 0);
assert.equal(globalThis.__once, 1, "not called again after returning false");
const broken = new AudioWorkletNode(ctx, "broken");
let reported = null;
broken.onprocessorerror = (event) => { reported = event.type; };
const originalError = console.error;
console.error = () => {};
block(broken, 0);
console.error = originalError;
assert.equal(reported, "processorerror");
block(broken, 0);
assert.equal(reported, "processorerror", "processorerror is dispatched at most once");

// 7. Graph lifecycle: disconnect() suspends a node (no process calls, keep-alive chain released) and connect() resumes it.
files.set("worklets/life.js", `
  globalThis.__lifeLoads = (globalThis.__lifeLoads || 0) + 1;
  class Life extends AudioWorkletProcessor {
    static get parameterDescriptors() { return [{ name: "level", defaultValue: 1 }]; }
    constructor() {
      super();
      this.got = [];
      this.port.onmessage = (event) => this.got.push(event.data);
      globalThis.__lastLife = this;
    }
    process(inputs, outputs) {
      globalThis.__lifeCalls = (globalThis.__lifeCalls || 0) + 1;
      for (const channel of outputs[0]) channel.fill(0.75);
      return true;
    }
  }
  registerProcessor("life", Life);
  registerProcessor("life-broken", class extends AudioWorkletProcessor {
    static get parameterDescriptors() { return [{ name: "level", defaultValue: 1 }]; }
    process() { throw new Error("life boom"); }
  });
`);
await ctx.audioWorklet.addModule("worklets/life.js");
const life = new AudioWorkletNode(ctx, "life");
const lifeKeepAlive = life.connections[0];
assert.ok(lifeKeepAlive instanceof GainNode && lifeKeepAlive.gain.value === 0, "the keep-alive chain is a silent gain");
assert.deepEqual(lifeKeepAlive.connections, [ctx.destination], "the silent gain reaches the destination");
block(life, 10);
const callsAfterFirstBlock = globalThis.__lifeCalls;
assert.ok(callsAfterFirstBlock > 0, "a fresh node renders with nothing connected to it");

life.disconnect();
assert.deepEqual(life.connections, [], "disconnect releases the node's end of the keep-alive chain");
assert.deepEqual(lifeKeepAlive.connections, [], "the silent gain is detached from the destination");
block(life, 11);
assert.equal(globalThis.__lifeCalls, callsAfterFirstBlock, "a disconnected node's processor is not called");

const feeder = new AudioNode(ctx);
feeder.connect(life);
assert.deepEqual(life.connections, [lifeKeepAlive], "reconnect rebuilds the keep-alive chain");
assert.deepEqual(lifeKeepAlive.connections, [ctx.destination]);
block(life, 12, (c, i) => i);
assert.ok(globalThis.__lifeCalls > callsAfterFirstBlock, "the processor runs again after reconnect");

// Suspended (not ended) nodes still take parameter scheduling and port messages.
life.disconnect();
assert.doesNotThrow(() => life.parameters.get("level").setValueAtTime(0.2, 13), "a suspended node still schedules parameters");
life.port.postMessage({ whileSuspended: true });
await settle();
assert.deepEqual(globalThis.__lastLife.got, [{ whileSuspended: true }], "a suspended node's port still delivers");
feeder.connect(life);
block(life, 13);

// A node that still has an input edge stays in the graph even after its own disconnect() removes the output edge.
life.disconnect();
assert.equal(life.connections.length, 0, "the output edge goes, the input edge remains");
const callsBeforeFedBlock = globalThis.__lifeCalls;
block(life, 14);
assert.ok(globalThis.__lifeCalls > callsBeforeFedBlock, "an input edge alone keeps the processor running");
feeder.disconnect();
assert.equal(life.connections.length, 0);
block(life, 15);
const callsAfterInputRemoved = globalThis.__lifeCalls;
assert.equal(globalThis.__lifeCalls, callsAfterInputRemoved, "losing the last input suspends the node");
feeder.connect(life);
block(life, 16);
assert.ok(globalThis.__lifeCalls > callsAfterInputRemoved, "an incoming connect() resumes it");

// A suspended node can also be resumed by its own outgoing connect(), and a terminally stopped node ignores both edges.
const lifeCallsBeforeSuspend = globalThis.__lifeCalls;
life.disconnect();
const sink = new AudioNode(ctx);
life.connect(sink);
block(life, 17);
assert.ok(globalThis.__lifeCalls > lifeCallsBeforeSuspend, "the node's own connect() resumes it");
const dead = new AudioWorkletNode(ctx, "once");
const deadBefore = globalThis.__once;
block(dead, 0);
feeder.connect(dead);
dead.connect(sink);
block(dead, 0);
assert.equal(globalThis.__once, deadBefore + 1, "a terminally stopped node never resumes");

// 8. Terminal stop on process() === false: no more process calls, ports closed both ways, keep-alive chain released.
const onceBeforeTerm = globalThis.__once;
const term = new AudioWorkletNode(ctx, "once");
const termKeepAlive = term.connections[0];
block(term, 0);
assert.equal(globalThis.__once, onceBeforeTerm + 1);
block(term, 0);
assert.equal(globalThis.__once, onceBeforeTerm + 1, "process is never called again after it returns false");
assert.deepEqual(term.connections, [], "the ended node releases its keep-alive chain");
assert.deepEqual(termKeepAlive.connections, [], "the silent gain is detached from the destination");
assert.doesNotThrow(() => term.port.postMessage("late"), "postMessage after the end does not throw");
await settle(); // the closed port drops the message rather than delivering it

// A throwing processor ends just as finally: one processorerror, then silence; params and the port are shut.
const lifeBroken = new AudioWorkletNode(ctx, "life-broken");
let lifeErrors = 0;
lifeBroken.onprocessorerror = () => { lifeErrors += 1; };
const messagesBeforeEnd = globalThis.__lastLife.got.length;
console.error = () => {};
block(lifeBroken, 0);
block(lifeBroken, 0);
block(lifeBroken, 0);
console.error = originalError;
assert.equal(lifeErrors, 1, "a throw dispatches processorerror exactly once across later blocks");
const stoppedParam = lifeBroken.parameters.get("level");
for (const refuse of [
  () => stoppedParam.setValueAtTime(0.3, 1),
  () => stoppedParam.linearRampToValueAtTime(0.3, 1),
  () => stoppedParam.exponentialRampToValueAtTime(0.3, 1),
  () => stoppedParam.setTargetAtTime(0.3, 1),
  () => stoppedParam.cancelScheduledValues(1),
  () => { stoppedParam.value = 0.3; },
]) {
  assert.throws(refuse, { name: "InvalidStateError" }, "scheduling after the end throws a clear error");
}
assert.equal(stoppedParam.value, stoppedParam.defaultValue, "the getter still reads the last value after stopping");
assert.doesNotThrow(() => lifeBroken.port.postMessage({ ignored: true }), "postMessage after the end does not throw");
await settle();
assert.equal(globalThis.__lastLife.got.length, messagesBeforeEnd, "a message posted after the end is never delivered");

// 9. Context close stops every node and releases every keep-alive chain; the worklet then refuses new work.
const ctx2 = new AudioContext();
files.set("worklets/ctx.js", `
  registerProcessor("ctx-probe", class extends AudioWorkletProcessor {
    process() { globalThis.__ctxCalls = (globalThis.__ctxCalls || 0) + 1; return true; }
  });
`);
await ctx2.audioWorklet.addModule("worklets/ctx.js");
const ctxNodeA = new AudioWorkletNode(ctx2, "ctx-probe");
const ctxNodeB = new AudioWorkletNode(ctx2, "ctx-probe");
const ctxChainA = ctxNodeA.connections[0];
const ctxChainB = ctxNodeB.connections[0];
block(ctxNodeA, 0);
const ctxCallsBeforeClose = globalThis.__ctxCalls;
await ctx2.close();
assert.equal(ctx2.closed, true);
assert.deepEqual(ctxNodeA.connections, [], "close releases node A's chain");
assert.deepEqual(ctxNodeB.connections, [], "close releases node B's chain");
assert.deepEqual(ctxChainA.connections, [], "node A's silent gain is detached");
assert.deepEqual(ctxChainB.connections, [], "node B's silent gain is detached");
block(ctxNodeA, 0);
block(ctxNodeB, 0);
assert.equal(globalThis.__ctxCalls, ctxCallsBeforeClose, "no node on a closed context processes again");
await assert.rejects(ctx2.audioWorklet.addModule("worklets/ctx.js"), { name: "InvalidStateError" }, "addModule after close rejects");
assert.throws(() => new AudioWorkletNode(ctx2, "ctx-probe"), { name: "InvalidStateError" }, "a node after close is refused");
await ctx2.close(); // idempotent: closing twice is harmless

// 10. addModule is idempotent per URL: the script runs once, so its registrations happen once.
const loadsBefore = globalThis.__lifeLoads;
await ctx.audioWorklet.addModule("worklets/life.js");
await ctx.audioWorklet.addModule("worklets/life.js");
assert.equal(globalThis.__lifeLoads, loadsBefore, "re-adding the same URL does not re-evaluate the script");

// 11. What this cannot be is refused, not half-done.
assert.throws(() => new AudioWorkletNode(ctx, "tone", { numberOfOutputs: 2 }), { name: "NotSupportedError" });
assert.throws(() => new AudioWorkletNode(ctx, "tone", { numberOfInputs: 0, numberOfOutputs: 0 }), { name: "NotSupportedError" });
files.set("worklets/dup.js", 'registerProcessor("tone", class extends AudioWorkletProcessor {})');
await assert.rejects(ctx.audioWorklet.addModule("worklets/dup.js"), { name: "NotSupportedError" }, "a name is registered once");

// 12. Installing twice changes nothing; a runtime without ScriptProcessorNode gets no worklet.
assert.deepEqual(installAudioWorklet(fake), {});
assert.deepEqual(installAudioWorklet({ AudioContext: class {} }), {});

console.log("AUDIO WORKLET TEST PASSED");
