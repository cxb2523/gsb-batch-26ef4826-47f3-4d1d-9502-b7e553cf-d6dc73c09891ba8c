// Node-side test environment for modules that normally run in a browser.
//
// The production code assumes the presence of `window`, `AudioContext`,
// `document`, `URL.createObjectURL`, etc. These minimal, deterministic stubs
// provide just enough surface to exercise Loader / Clip / Player / ProtonPlayer
// without a real browser or network. HTTP itself is stubbed at the axios layer
// (see test/helpers/axiosStub.js).

global.__DEV__ = false;

class FakeAudioParam {
  constructor() {
    this.value = 1;
  }

  setValueAtTime() {
    return this;
  }
}

class FakeAudioNode {
  connect(destination) {
    this._destination = destination;
    return destination;
  }

  disconnect() {}
}

class FakeGainNode extends FakeAudioNode {
  constructor() {
    super();
    this.gain = new FakeAudioParam();
  }
}

class FakeBufferSource extends FakeAudioNode {
  constructor() {
    super();
    this.loop = false;
  }

  start() {}

  stop() {}
}

class FakeAudioBuffer {
  constructor(numberOfChannels, length, sampleRate) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this._channels = [];
    for (let i = 0; i < numberOfChannels; i += 1) {
      this._channels.push(new Float32Array(length));
    }
  }

  getChannelData(index) {
    return this._channels[index];
  }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.destination = new FakeAudioNode();
    this._time = 0;
  }

  createGain() {
    return new FakeGainNode();
  }

  createBuffer(numberOfChannels, length, sampleRate) {
    return new FakeAudioBuffer(numberOfChannels, length, sampleRate);
  }

  createBufferSource() {
    return new FakeBufferSource();
  }

  // Decoding is stubbed synchronously-ish: every byte buffer becomes a tiny
  // valid-looking AudioBuffer. Duration is derived from the byte length so
  // chunk-duration accounting remains non-zero.
  decodeAudioData(buffer, success, failure) {
    try {
      const sampleRate = 44100;
      const length = Math.max(1, Math.floor(buffer.byteLength / 4));
      const decoded = new FakeAudioBuffer(2, length, sampleRate);
      if (typeof success === 'function') {
        // Defer to mimic the async callback API without changing semantics.
        setTimeout(() => success(decoded), 0);
        return undefined;
      }
      return Promise.resolve(decoded);
    } catch (err) {
      if (typeof failure === 'function') {
        setTimeout(() => failure(err), 0);
        return undefined;
      }
      return Promise.reject(err);
    }
  }

  resume() {
    return Promise.resolve();
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.listeners = {};
    this.autoplay = false;
    this.volume = 1;
    this.src = null;
  }

  appendChild() {}

  addEventListener(name, cb) {
    (this.listeners[name] = this.listeners[name] || []).push(cb);
  }

  removeEventListener(name, cb) {
    const list = this.listeners[name];
    if (!list) return;
    const index = list.indexOf(cb);
    if (~index) list.splice(index, 1);
  }

  dispatchEvent(name, payload) {
    (this.listeners[name] || []).slice().forEach((cb) => cb(payload));
  }

  play() {
    return Promise.resolve();
  }

  pause() {}
}

const audioElement = new FakeElement('audio');

const documentStub = {
  createElement: () => new FakeElement(),
  // Clip (MediaSource path) looks up the shared <audio> element via
  // document.querySelector('audio'); it is only consulted when MediaSource is
  // available, which these stubs disable.
  querySelector: () => audioElement,
  body: new FakeElement('body'),
};

const windowStub = {
  navigator: {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
  // axios switches to its browser platform build when both `window` and
  // `document` exist; it reads `window.location.href` while loading.
  location: {
    href: 'http://localhost/',
    origin: 'http://localhost',
  },
  AudioContext: FakeAudioContext,
  webkitAudioContext: FakeAudioContext,
  // MediaSource is intentionally absent: forces the WebAudio playback path,
  // which is fully exercisable with the fake AudioContext.
  addEventListener: () => {},
  removeEventListener: () => {},
};

global.window = windowStub;
// Node 20+ exposes `navigator` as a read-only global, so assignment would
// throw. defineProperty with a configurable descriptor installs the stub
// regardless of the built-in accessor.
Object.defineProperty(global, 'navigator', {
  value: windowStub.navigator,
  configurable: true,
  writable: true,
});
global.document = documentStub;
global.AudioContext = FakeAudioContext;
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
global.cancelAnimationFrame = (id) => clearTimeout(id);

// Blob + URL.createObjectURL are used by the silence module. Blob is global in
// Node 18+; only the URL helpers need stubbing.
global.URL = global.URL || {};
global.URL.createObjectURL = () => 'blob:fake-silence';
global.URL.revokeObjectURL = () => {};

// `new Audio(...)` is used by the iOS init helper.
global.Audio = class {
  constructor() {
    this.src = null;
  }

  play() {
    return Promise.resolve();
  }
};
