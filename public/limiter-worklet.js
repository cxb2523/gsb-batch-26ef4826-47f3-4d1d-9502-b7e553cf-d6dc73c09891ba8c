import { LookaheadLimiter } from './limiter-core.js';

class UmbraOutputLimiter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.limiter = new LookaheadLimiter(sampleRate, 2);
    this.port.onmessage = ({ data }) => {
      // reset() in place: allocating a limiter here would run on the audio thread, and every
      // bypass toggle would risk a GC pause inside the render quantum.
      if (data?.type === 'reset') this.limiter.reset();
    };
  }

  process(inputs, outputs) {
    this.limiter.process(inputs[0] ?? [], outputs[0]);
    return true;
  }
}

registerProcessor('umbra-output-limiter', UmbraOutputLimiter);
