/**
 * Stub `clawdio-bitcrusher` WASM bindings.
 *
 * Mirrors the wasm-bindgen surface the worklet touches and records every call
 * so tests can assert on ordering / values without compiling Rust.
 */
export const calls = [];

export function resetCalls() {
  calls.length = 0;
}

export class BitcrusherModule {
  static new(bits) {
    return new BitcrusherModule(bits);
  }

  constructor(bits) {
    this.bits = bits;
    this.phaser = 0;
    this.last = 0;
    calls.push({ method: "new", args: [bits] });
  }

  set_bits(bits) {
    this.bits = bits;
    calls.push({ method: "set_bits", args: [bits] });
  }

  process(samples) {
    return samples;
  }
}

export default async function init() {
  calls.push({ method: "init", args: [] });
}
