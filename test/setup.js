/**
 * Shared test environment: a jsdom window with a mocked Web Audio API.
 * Must be imported before any r-audio module (module evaluation reads
 * `window.AudioContext`).
 */
const { JSDOM } = require('jsdom');
const { MockAudioContext, MockAudioParam } = require('./mock-audio.js');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/'
});

global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true
});

dom.window.AudioContext = MockAudioContext;
dom.window.webkitAudioContext = MockAudioContext;
window.AudioContext = MockAudioContext;
window.webkitAudioContext = MockAudioContext;

// module code refers to bare `AudioContext`, which in a browser resolves to a
// window global; mirror that in Node.
global.AudioContext = MockAudioContext;
global.webkitAudioContext = MockAudioContext;

// AudioParam isn't a browser global in jsdom
global.AudioParam = MockAudioParam;
window.AudioParam = MockAudioParam;

// Keep React out of its "development build" warning path while keeping
// componentWillMount/ReceiveProps/Update lifecycle hooks, which this
// (React 16.5) library depends on.
global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { isDisabled: true };

// Avoid "useLayoutEffect does nothing on the server" noise
global.requestAnimationFrame = global.requestAnimationFrame || (fn => setTimeout(fn, 0));

module.exports = { dom };
