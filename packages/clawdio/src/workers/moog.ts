import init, { MoogModule } from "clawdio-moog";
import type {
  AudioWorkletEventMessage,
  AudioWorkletInitWasmEvent,
} from "./types";
import { initWasm } from "./utils";

export interface MoogEventInitModule
  extends AudioWorkletEventMessage<MoogOptions> {
  type: "init-module";
  data: MoogOptions;
}

export interface MoogEventSetCutoff extends AudioWorkletEventMessage<number> {
  type: "set-cutoff";
  data: number;
}
export interface MoogEventSetResonance
  extends AudioWorkletEventMessage<number> {
  type: "set-resonance";
  data: number;
}

export type MoogOptions = {
  cutoff: number;
  resonance: number;
};

class MoogWorklet extends AudioWorkletProcessor {
  worklet: MoogModule | null = null;
  cutoff = 0.065;
  resonance = 3.5;

  /**
   * Parameter messages received before the WASM module was initialized.
   * They're applied once `init-module` arrives so early messages aren't lost.
   */
  pendingCutoff: number | null = null;
  pendingResonance: number | null = null;

  constructor() {
    super();

    this.port.onmessage = (event) => this.onmessage(event.data);
  }

  onmessage = (
    event:
      | AudioWorkletInitWasmEvent
      | MoogEventInitModule
      | MoogEventSetCutoff
      | MoogEventSetResonance
  ) => {
    // Handle loading WASM module
    initWasm(event as AudioWorkletInitWasmEvent, init, this.port);

    if (event.type === "init-module") {
      const {
        cutoff = this.cutoff,
        resonance = this.resonance,
      } = event.data;

      // Values that arrived before init-module take precedence over the
      // initial config, so a slider moved during startup still wins.
      this.cutoff = this.pendingCutoff ?? cutoff;
      this.resonance = this.pendingResonance ?? resonance;
      this.pendingCutoff = null;
      this.pendingResonance = null;

      this.worklet = MoogModule.new(this.cutoff, this.resonance);
    }

    // Setters for internal properties (since we can't mutate this directly)
    if (event.type === "set-cutoff") {
      this.cutoff = event.data;
      if (this.worklet) {
        // Forward to the Rust module so the next process() uses the new value.
        this.worklet.set_cutoff(event.data);
      } else {
        // WASM not ready yet - remember it for init-module.
        this.pendingCutoff = event.data;
      }
    }
    if (event.type === "set-resonance") {
      this.resonance = event.data;
      if (this.worklet) {
        this.worklet.set_resonance(event.data);
      } else {
        this.pendingResonance = event.data;
      }
    }
  };

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    // Check if we have worklet initialized
    if (this.worklet == null) return true;

    inputs.forEach((channels, channelIndex) => {
      channels.forEach((inputSamples, sampleIndex) => {
        // We check again since TS insists (and maybe it changes over course of loop?)
        if (this.worklet == null) return true;

        // Process samples using Rust WASM module
        const processing = this.worklet.process(inputSamples);

        // Make sure you loop through each output value and assign it manually
        // can't just assign a whole array
        processing.forEach(
          (val, index) => (outputs[channelIndex][sampleIndex][index] = val)
        );
      });
    });

    // outputs = inputs;

    return true;
  }
}

registerProcessor("clawdio-moog", MoogWorklet);
