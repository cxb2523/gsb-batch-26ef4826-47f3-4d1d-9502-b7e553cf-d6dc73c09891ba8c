/**
 * WASM acceptance tests.
 *
 * These exercise the real `wasm-bindgen` output for the Bitcrusher and Moog
 * modules (built with `cargo build --target wasm32-unknown-unknown` +
 * `wasm-bindgen`, output in `modules/<name>/pkg`). They cover the runtime
 * behavior that Rust unit tests can only approximate:
 *  - a setter changes the output on the very next `process` call
 *  - invalid values are clamped and never produce NaN/Inf
 *
 * The whole suite is skipped when the modules haven't been built, so a plain
 * `node --test` on a fresh checkout still passes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const ROOT = new URL("../../../modules/", import.meta.url);

const bitcrusherPkg = new URL("bitcrusher/pkg/clawdio_bitcrusher.js", ROOT);
const bitcrusherWasm = new URL(
  "bitcrusher/pkg/clawdio_bitcrusher_bg.wasm",
  ROOT
);
const moogPkg = new URL("moog/pkg/clawdio_moog.js", ROOT);
const moogWasm = new URL("moog/pkg/clawdio_moog_bg.wasm", ROOT);

const built =
  existsSync(bitcrusherWasm) &&
  existsSync(bitcrusherPkg) &&
  existsSync(moogWasm) &&
  existsSync(moogPkg);

const skip = built
  ? false
  : "WASM modules not built (run `yarn build:modules`)";

const sine = (n) => Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.01));
const allFinite = (samples) => [...samples].every(Number.isFinite);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

let BitcrusherModule;
let MoogModule;

if (built) {
  const [b, m] = await Promise.all([
    import(bitcrusherPkg.href),
    import(moogPkg.href),
  ]);
  await b.default({ module_or_path: await readFile(bitcrusherWasm) });
  await m.default({ module_or_path: await readFile(moogWasm) });
  BitcrusherModule = b.BitcrusherModule;
  MoogModule = m.MoogModule;
}

test("bitcrusher: set_bits changes the next process output", { skip }, () => {
  const module = BitcrusherModule.new(4);
  const before = module.process(sine(1024), 0.42);

  module.set_bits(2);
  assert.equal(module.bits(), 2);

  const after = module.process(sine(1024), 0.42);
  assert.equal(same(before, after), false, "output should reflect new depth");
  assert.equal(allFinite(after), true);
});

test("bitcrusher: 2-bit output is quantized to a 0.25 grid", { skip }, () => {
  const module = BitcrusherModule.new(2);
  const output = module.process(sine(512), 0.42);
  for (const sample of output) {
    const steps = sample / 0.25;
    assert.ok(
      Math.abs(steps - Math.round(steps)) < 1e-5,
      `sample ${sample} is not on the 2-bit grid`
    );
  }
});

test("bitcrusher: set_bits clamps hostile values", { skip }, () => {
  const module = BitcrusherModule.new(4);

  module.set_bits(-100);
  assert.equal(module.bits(), 1);

  module.set_bits(1e6);
  assert.equal(module.bits(), 32);

  const beforeNan = module.bits();
  module.set_bits(NaN);
  assert.equal(module.bits(), beforeNan, "NaN should be ignored");

  assert.equal(allFinite(module.process(sine(512), 0.42)), true);
});

test("moog: set_cutoff changes the next process output", { skip }, () => {
  const module = MoogModule.new(0.05, 0.3);
  module.process(sine(512)); // prime internal state
  const before = module.process(sine(1024));

  module.set_cutoff(0.9);
  assert.ok(Math.abs(module.cutoff() - 0.9) < 1e-6);

  const after = module.process(sine(1024));
  assert.equal(same(before, after), false, "output should reflect new cutoff");
  assert.equal(allFinite(after), true);
});

test("moog: set_resonance changes the next process output", { skip }, () => {
  const module = MoogModule.new(0.5, 0.0);
  module.process(sine(512));
  const before = module.process(sine(1024));

  module.set_resonance(0.9);
  assert.ok(Math.abs(module.resonance() - 0.9) < 1e-6);

  const after = module.process(sine(1024));
  assert.equal(same(before, after), false, "output should reflect new resonance");
  assert.equal(allFinite(after), true);
});

test("moog: setters clamp hostile values and stay finite", { skip }, () => {
  const module = MoogModule.new(0.5, 0.5);

  module.set_cutoff(-10);
  assert.equal(module.cutoff(), 0);
  module.set_cutoff(10);
  assert.equal(module.cutoff(), 1);
  module.set_resonance(-10);
  assert.equal(module.resonance(), 0);

  const cutoffBefore = module.cutoff();
  const resonanceBefore = module.resonance();
  module.set_cutoff(NaN);
  module.set_resonance(NaN);
  assert.equal(module.cutoff(), cutoffBefore);
  assert.equal(module.resonance(), resonanceBefore);

  for (const cutoff of [-10, 0, 0.5, 1, 10, Infinity]) {
    for (const resonance of [-10, 0, 0.95, 100, 1000, Infinity]) {
      module.set_cutoff(cutoff);
      module.set_resonance(resonance);
      assert.equal(
        allFinite(module.process(sine(256))),
        true,
        `non-finite output for cutoff=${cutoff} resonance=${resonance}`
      );
    }
  }
});
