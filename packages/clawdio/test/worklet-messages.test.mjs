/**
 * Worklet message-ordering tests.
 *
 * These run the real AudioWorkletProcessor sources from `src/workers` against
 * stubbed WASM bindings (see `./support`). They verify the parameter-update
 * plumbing that cannot easily be observed in a browser:
 *  - `set-*` after init-module forwards to the Rust module setter
 *  - `set-*` before init-module is cached and used to construct the module
 *  - `init-module` keeps its existing behavior when no early messages arrived
 *
 * Run with: npm test (see packages/clawdio/package.json)
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as bitcrusherStub from "./support/stub-bitcrusher.mjs";
import * as moogStub from "./support/stub-moog.mjs";

// --- Minimal AudioWorkletGlobalScope shims -------------------------------

class FakePort {
  messages = [];
  onmessage = null;

  postMessage(message) {
    this.messages.push(message);
  }

  /** Deliver a message the way the browser would (async, like real ports). */
  async deliver(payload) {
    await this.onmessage({ data: payload });
  }
}

globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = new FakePort();
  }
};

const registered = new Map();
globalThis.registerProcessor = (name, ctor) => registered.set(name, ctor);

// Importing the worklets registers their processors.
const bitcrusherModule = await import("../src/workers/bitcrusher.ts");
const moogModule = await import("../src/workers/moog.ts");

const BitcrusherWorklet = registered.get("clawdio-bitcrusher");
const MoogWorklet = registered.get("clawdio-moog");

assert.equal(BitcrusherWorklet, bitcrusherModule.default ?? BitcrusherWorklet);
assert.ok(BitcrusherWorklet, "bitcrusher processor should be registered");
assert.ok(MoogWorklet, "moog processor should be registered");

// Smallest valid WebAssembly module (magic + version), so the worklet's
// `WebAssembly.compile()` call in `initWasm` resolves instead of rejecting.
const EMPTY_WASM = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const initWasm = (worklet) =>
  worklet.port.deliver({ type: "init-wasm", data: EMPTY_WASM.buffer });

beforeEach(() => {
  bitcrusherStub.resetCalls();
  moogStub.resetCalls();
});

/**
 * Stub calls excluding the `init` entry recorded when the WASM module loads.
 * These tests care about module construction and setter forwarding only.
 */
const ops = (stub) => stub.calls.filter((call) => call.method !== "init");

// --- Bitcrusher -----------------------------------------------------------

test("bitcrusher: set-bits after init-module forwards to module.set_bits", async () => {
  const worklet = new BitcrusherWorklet();

  await initWasm(worklet);
  await worklet.port.deliver({ type: "init-module", data: { bits: 4 } });

  assert.deepEqual(ops(bitcrusherStub), [{ method: "new", args: [4] }]);
  assert.equal(worklet.worklet.bits, 4);

  await worklet.port.deliver({ type: "set-bits", data: 2 });

  assert.deepEqual(ops(bitcrusherStub), [
    { method: "new", args: [4] },
    { method: "set_bits", args: [2] },
  ]);
  assert.equal(worklet.bits, 2);
  assert.equal(worklet.worklet.bits, 2, "underlying module must be updated");
});

test("bitcrusher: set-bits before init-module is used to construct module", async () => {
  const worklet = new BitcrusherWorklet();

  await initWasm(worklet);
  // Slider moved while WASM was still spinning up.
  await worklet.port.deliver({ type: "set-bits", data: 6 });

  assert.equal(ops(bitcrusherStub).length, 0, "module not created yet");
  assert.equal(worklet.pendingBits, 6);

  await worklet.port.deliver({ type: "init-module", data: { bits: 4 } });

  // Module is built from the cached value, not the stale init config.
  assert.deepEqual(ops(bitcrusherStub), [{ method: "new", args: [6] }]);
  assert.equal(worklet.worklet.bits, 6);
  assert.equal(worklet.pendingBits, null, "cache is cleared after init");
});

test("bitcrusher: init-module alone keeps existing behavior", async () => {
  const worklet = new BitcrusherWorklet();

  await initWasm(worklet);
  await worklet.port.deliver({ type: "init-module", data: { bits: 8 } });

  assert.deepEqual(ops(bitcrusherStub), [{ method: "new", args: [8] }]);
  assert.equal(worklet.bits, 8);
});

test("bitcrusher: set-normfreq is applied on the next process call", async () => {
  const worklet = new BitcrusherWorklet();

  await initWasm(worklet);
  await worklet.port.deliver({ type: "init-module", data: { bits: 4 } });
  await worklet.port.deliver({ type: "set-normfreq", data: 0.9 });

  const seen = [];
  const module = worklet.worklet;
  module.process = (_samples, normfreq) => {
    seen.push(normfreq);
    return new Float32Array(4);
  };

  const outputs = [[new Float32Array(4)]];
  worklet.process([[new Float32Array(4)]], outputs);

  assert.deepEqual(seen, [0.9]);
});

test("bitcrusher: process before any module is a no-op", () => {
  const worklet = new BitcrusherWorklet();
  const outputs = [[new Float32Array(4)]];
  assert.equal(worklet.process([[new Float32Array(4)]], outputs), true);
  assert.deepEqual(Array.from(outputs[0][0]), [0, 0, 0, 0]);
});

// --- Moog -----------------------------------------------------------------

test("moog: set-cutoff / set-resonance after init-module forward to setters", async () => {
  const worklet = new MoogWorklet();

  await initWasm(worklet);
  await worklet.port.deliver({
    type: "init-module",
    data: { cutoff: 0.065, resonance: 3.5 },
  });

  assert.deepEqual(ops(moogStub), [{ method: "new", args: [0.065, 3.5] }]);

  await worklet.port.deliver({ type: "set-cutoff", data: 0.4 });
  await worklet.port.deliver({ type: "set-resonance", data: 0.8 });

  assert.deepEqual(ops(moogStub), [
    { method: "new", args: [0.065, 3.5] },
    { method: "set_cutoff", args: [0.4] },
    { method: "set_resonance", args: [0.8] },
  ]);
  assert.equal(worklet.worklet.cutoff, 0.4);
  assert.equal(worklet.worklet.resonance, 0.8);
});

test("moog: early set-cutoff and set-resonance both win over init config", async () => {
  const worklet = new MoogWorklet();

  await initWasm(worklet);
  await worklet.port.deliver({ type: "set-cutoff", data: 0.2 });
  await worklet.port.deliver({ type: "set-resonance", data: 0.6 });

  assert.equal(ops(moogStub).length, 0);

  await worklet.port.deliver({
    type: "init-module",
    data: { cutoff: 0.065, resonance: 3.5 },
  });

  assert.deepEqual(ops(moogStub), [{ method: "new", args: [0.2, 0.6] }]);
  assert.equal(worklet.pendingCutoff, null);
  assert.equal(worklet.pendingResonance, null);
});

test("moog: only an early cutoff supplied keeps configured resonance", async () => {
  const worklet = new MoogWorklet();

  await initWasm(worklet);
  await worklet.port.deliver({ type: "set-cutoff", data: 0.3 });
  await worklet.port.deliver({
    type: "init-module",
    data: { cutoff: 0.065, resonance: 1.2 },
  });

  assert.deepEqual(ops(moogStub), [{ method: "new", args: [0.3, 1.2] }]);
});

test("moog: init-module defaults are preserved when config omits values", async () => {
  const worklet = new MoogWorklet();

  await initWasm(worklet);
  await worklet.port.deliver({ type: "init-module", data: {} });

  assert.deepEqual(ops(moogStub), [{ method: "new", args: [0.065, 3.5] }]);
});
