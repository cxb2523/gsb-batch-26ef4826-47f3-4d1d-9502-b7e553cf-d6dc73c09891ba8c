// Thin wrapper around the synthesis worklet. Nothing is sampled or downloaded.
export class Sound {
  constructor() { this.ctx = null; this.node = null; this.muted = false; this.ready = false; }
  async start() {
    if (this.ctx) { this.ctx.resume().catch(() => {}); return; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      await this.ctx.audioWorklet.addModule('js/engine-worklet.js');
      this.node = new AudioWorkletNode(this.ctx, 'flight-sound', { numberOfInputs: 0, outputChannelCount: [2] });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0;
      this.node.connect(this.gain).connect(this.ctx.destination);
      this.ready = true;
    } catch (err) {
      // No audio is a degraded but perfectly flyable sim: swallow the failure,
      // drop whatever half-started context there is, and let the next Fly try.
      console.warn('audio unavailable', err);
      try { if (this.ctx && this.ctx.close) this.ctx.close(); } catch (e) { /* already gone */ }
      this.ctx = null; this.node = null; this.gain = null; this.ready = false;
    }
  }
  setLevel(v) { if (this.ready) this.gain.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.15); }
  update(params) { if (this.ready) this.node.port.postMessage(params); }
  // The cockpit warning summary, posted every frame. A null clears every channel
  // at once, so a restart or an aircraft change cannot leave an old horn going.
  warn(w) { if (this.ready) this.node.port.postMessage({ warn: w || null }); }
  touch(strength) { if (this.ready) this.node.port.postMessage({ touch: strength }); }
}
