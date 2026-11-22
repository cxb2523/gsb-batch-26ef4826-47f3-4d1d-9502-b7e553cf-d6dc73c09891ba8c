/**
 * End-to-end worklet test against the real WASM builds.
 *
 * Boots the actual `AudioWorkletProcessor` sources from `src/workers` and feeds
 * them the `wasm-bindgen` output in `modules/<name>/pkg` (via the workspace
 * symlinks in `node_modules`). This is the acceptance scenario: initialize,
 * then move a parameter and confirm the samples produced by the worklet change.
 *
 * Requires the modules to be built (`yarn build:modules`, or:
 *   cargo build --target wasm32-unknown-unknown --release
 *   wasm-bindgen --target web --out-dir modules/<name>/pkg ...)
 *
 * Skipped automatically when the WASM output is missing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const ROOT = new URL("../../../modules/", import.meta.url);
const wasmPaths = {
  bitcrusher: new URL("bitcrusher/pkg/clawdio_bitcrusher_bg.wasm", ROOT),
  moog: new URL("moog/pkg/clawdio_moog_bg.wasm", ROOT),
};

const built =
  existsSync(wasmPaths.bitcrusher) && existsSync(wasmPaths.moog);
const skip = built ? false : "WASM modules not built (run `yarn build:modules`)";

if (built) {
  class FakePort {
    messages = [];
    onmessage = null;
    postMessage(message) {
      this.messages.push(message);
    }
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

  await import("../src/workers/bitcrusher.ts");
  await import("../src/workers/moog.ts");

  globalThis.__clawdioProcessors = registered;
}

const BLOCK = 128;
const sine = () =>
  Float32Array.from({ length: BLOCK }, (_, i) => Math.sin(i * 0.05));

/** Run one worklet quantum and return the produced output samples. */
const runQuantum = (processor) => {
  const input = sine();
  const outputs = [[new Float32Array(BLOCK)]];
  processor.process([[input]], outputs);
  return Array.from(outputs[0][0]);
};

const differs = (a, b) => a.some((value, i) => value !== b[i]);
const allFinite = (samples) => samples.every(Number.isFinite);

/**
 * Send `init-wasm` and wait until the processor reports `wasm-loaded`.
 *
 * This mirrors the real node wrapper in `src/nodes/utils.ts`: the browser only
 * sends `init-module` after that reply, so the module is guaranteed to exist.
 */
const bootWasm = async (processor, wasmPath) => {
  const wasm = await readFile(wasmPath);
  await processor.port.deliver({ type: "init-wasm", data: wasm.buffer });

  const sawLoaded = () =>
    processor.port.messages.some((message) => message.type === "wasm-loaded");
  for (let i = 0; i < 1000 && !sawLoaded(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(sawLoaded(), true, "worklet should report wasm-loaded");
};

test(
  "bitcrusher worklet: init then set-bits changes rendered samples",
  { skip },
  async () => {
    const Processor = globalThis.__clawdioProcessors.get("clawdio-bitcrusher");
    const processor = new Processor();

    await bootWasm(processor, wasmPaths.bitcrusher);
    await processor.port.deliver({ type: "init-module", data: { bits: 8 } });

    // Let a few quanta settle at 8 bits.
    runQuantum(processor);
    runQuantum(processor);
    const coarse8bit = runQuantum(processor);

    await processor.port.deliver({ type: "set-bits", data: 2 });
    const firstAfterSet = runQuantum(processor);

    assert.equal(
      differs(coarse8bit, firstAfterSet),
      true,
      "output must change after set-bits"
    );

    // The crusher is a sample-and-hold, so one held sample can survive from
    // the previous quantum. Let a couple quanta flush before asserting on the
    // quantization grid.
    runQuantum(processor);
    const crushed = runQuantum(processor);
    assert.equal(allFinite(crushed), true);

    // 2-bit samples sit on a 0.25 grid.
    for (const sample of crushed) {
      const steps = sample / 0.25;
      assert.ok(Math.abs(steps - Math.round(steps)) < 1e-5);
    }
  }
);

test(
  "bitcrusher worklet: set-bits before init-module still takes effect",
  { skip },
  async () => {
    const Processor = globalThis.__clawdioProcessors.get("clawdio-bitcrusher");
    const processor = new Processor();

    // Slider message arrives before WASM is ready.
    await processor.port.deliver({ type: "set-bits", data: 2 });

    await bootWasm(processor, wasmPaths.bitcrusher);
    await processor.port.deliver({ type: "init-module", data: { bits: 8 } });

    runQuantum(processor);
    runQuantum(processor);
    const output = runQuantum(processor);

    assert.equal(allFinite(output), true);
    // A 2-bit crusher only resolves 0.25 steps; the cached value won over the
    // 8-bit init config.
    for (const sample of output) {
      const steps = sample / 0.25;
      assert.ok(
        Math.abs(steps - Math.round(steps)) < 1e-5,
        `sample ${sample} is not on the 2-bit grid`
      );
    }
  }
);

test(
  "bitcrusher worklet: invalid set-bits is clamped, output stays finite",
  { skip },
  async () => {
    const Processor = globalThis.__clawdioProcessors.get("clawdio-bitcrusher");
    const processor = new Processor();

    await bootWasm(processor, wasmPaths.bitcrusher);
    await processor.port.deliver({ type: "init-module", data: { bits: 4 } });

    for (const bad of [-1000, 0, 1e9, Number.NaN, Number.POSITIVE_INFINITY]) {
      await processor.port.deliver({ type: "set-bits", data: bad });
      const output = runQuantum(processor);
      assert.equal(allFinite(output), true, `non-finite output for bits=${bad}`);
    }
  }
);

test(
  "moog worklet: init then set-cutoff / set-resonance changes rendered samples",
  { skip },
  async () => {
    const Processor = globalThis.__clawdioProcessors.get("clawdio-moog");
    const processor = new Processor();

    await bootWasm(processor, wasmPaths.moog);
    await processor.port.deliver({
      type: "init-module",
      data: { cutoff: 0.05, resonance: 0.1 },
    });

    // Warm up the filter state.
    for (let i = 0; i < 20; i++) runQuantum(processor);
    const lowCutoff = runQuantum(processor);

    await processor.port.deliver({ type: "set-cutoff", data: 0.9 });
    const highCutoff = runQuantum(processor);

    assert.equal(
      differs(lowCutoff, highCutoff),
      true,
      "output must change after set-cutoff"
    );

    await processor.port.deliver({ type: "set-resonance", data: 0.9 });
    const highResonance = runQuantum(processor);

    assert.equal(
      differs(highCutoff, highResonance),
      true,
      "output must change after set-resonance"
    );
    assert.equal(allFinite(highResonance), true);
  }
);

test(
  "moog worklet: early parameters reach the module and invalid values stay finite",
  { skip },
  async () => {
    const Processor = globalThis.__clawdioProcessors.get("clawdio-moog");
    const processor = new Processor();

    // Both messages arrive before init-module.
    await processor.port.deliver({ type: "set-cutoff", data: 0.9 });
    await processor.port.deliver({ type: "set-resonance", data: 0.95 });

    await bootWasm(processor, wasmPaths.moog);
    await processor.port.deliver({
      type: "init-module",
      data: { cutoff: 0.05, resonance: 0.1 },
    });

    const high = runQuantum(processor);

    const control = new Processor();
    await bootWasm(control, wasmPaths.moog);
    await control.port.deliver({
      type: "init-module",
      data: { cutoff: 0.05, resonance: 0.1 },
    });
    const low = runQuantum(control);

    assert.equal(
      differs(low, high),
      true,
      "cached parameters should win over the init config"
    );

    for (const bad of [-10, 100, Number.NaN, Number.POSITIVE_INFINITY]) {
      await processor.port.deliver({ type: "set-cutoff", data: bad });
      await processor.port.deliver({ type: "set-resonance", data: bad });
      assert.equal(allFinite(runQuantum(processor)), true);
    }
  }
);
