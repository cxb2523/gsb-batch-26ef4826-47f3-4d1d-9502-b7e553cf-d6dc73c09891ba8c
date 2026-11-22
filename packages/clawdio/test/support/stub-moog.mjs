/**
 * Stub `clawdio-moog` WASM bindings. See stub-bitcrusher.mjs.
 */
export const calls = [];

export function resetCalls() {
  calls.length = 0;
}

export class MoogModule {
  static new(cutoff, resonance) {
    return new MoogModule(cutoff, resonance);
  }

  constructor(cutoff, resonance) {
    this.cutoff = cutoff;
    this.resonance = resonance;
    calls.push({ method: "new", args: [cutoff, resonance] });
  }

  set_cutoff(cutoff) {
    this.cutoff = cutoff;
    calls.push({ method: "set_cutoff", args: [cutoff] });
  }

  set_resonance(resonance) {
    this.resonance = resonance;
    calls.push({ method: "set_resonance", args: [resonance] });
  }

  process(samples) {
    return samples;
  }
}

export default async function init() {
  calls.push({ method: "init", args: [] });
}
