/**
 * Browser lifecycle check.
 *
 * Bundled (together with React, ReactDOM and the library) by
 * `test/browser/run.js` and executed in a real browser. It drives a scripted
 * sequence of graph mutations and writes a PASS/FAIL report into `#report`,
 * which the runner parses.
 *
 * Connection tracking is based on intercepting the real
 * `AudioNode.prototype.connect` / `disconnect`, i.e. on what the library
 * actually does to the browser's Web Audio implementation - not on the
 * library's own bookkeeping.
 *
 * Chrome does not advance `AudioContext.currentTime` under virtual time, so
 * the "scheduled source ended -> rebuild" path is covered by the Node suite
 * (`npm test`); this page verifies the connection-level behaviour against the
 * real Web Audio implementation:
 *  - children changes re-wire the graph with no duplicate or stale edges;
 *  - destination (routing) changes move the edge instead of keeping the old;
 *  - unmounting a branch removes its upstream edges;
 *  - AudioParam connections are added/removed with precise arguments.
 */
import React from 'react';
import ReactDOM from 'react-dom';

import {
  RAudioContext,
  RBiquadFilter,
  RDelay,
  RGain,
  ROscillator,
  RPipeline,
  RSplit
} from '../../index.js';

const h = React.createElement;

// ----------------------------------------------------------------------------
// connection tracking, independent of the library
// ----------------------------------------------------------------------------

const liveEdges = [];

const isAudioParam = target => typeof AudioParam !== 'undefined' && target instanceof AudioParam;

const trackConnect = (source, target, output, input) => {
  const edge = isAudioParam(target)
    ? { source, target, paramSource: true, output: 0, input: 0 }
    : { source, target, paramSource: false, output: output || 0, input: input || 0 };

  // a connection is a multiset in Web Audio, but r-audio must never create
  // the same edge twice - track counts so duplicates are detectable
  liveEdges.push(edge);
  return edge;
};

const sameEdge = (edge, source, target, output, input) => {
  if (edge.source !== source || edge.target !== target) return false;
  if (isAudioParam(target)) return true;
  return edge.output === (output || 0) && edge.input === (input || 0);
};

const trackDisconnect = (source, args) => {
  for (let index = liveEdges.length - 1; index >= 0; index--) {
    const edge = liveEdges[index];
    if (edge.source !== source) continue;

    const matches = args.length === 0 ||
      (args.length === 1 && edge.target === args[0]) ||
      (args.length === 2 && edge.target === args[0] && edge.output === args[1]) ||
      (args.length === 3 && edge.target === args[0] &&
        edge.output === args[1] && edge.input === args[2]);

    if (matches) liveEdges.splice(index, 1);
  }
};

const patchWebAudio = () => {
  const proto = AudioNode.prototype;
  const originalConnect = proto.connect;
  const originalDisconnect = proto.disconnect;

  proto.connect = function (target, output, input) {
    const result = originalConnect.apply(this, arguments);
    trackConnect(this, target, output, input);
    return result;
  };

  proto.disconnect = function () {
    const result = originalDisconnect.apply(this, arguments);
    trackDisconnect(this, arguments);
    return result;
  };
};

patchWebAudio();

// ----------------------------------------------------------------------------
// scheduled-source tracking
// ----------------------------------------------------------------------------

// every OscillatorNode the library creates, in creation order. The carrier is
// the first one: it stays mounted (stable `key`) throughout the sequence.
const createdOscillators = [];

const patchScheduledSources = () => {
  const contextProto = AudioContext.prototype;
  const originalCreateOscillator = contextProto.createOscillator;
  const originalStart = OscillatorNode.prototype.start;

  contextProto.createOscillator = function () {
    const node = originalCreateOscillator.apply(this, arguments);
    createdOscillators.push(node);
    return node;
  };

  OscillatorNode.prototype.start = function (when, offset, duration) {
    this.__startCalls = (this.__startCalls || []).concat([ { when, offset, duration } ]);
    return originalStart.apply(this, arguments);
  };

  // Headless Chrome under virtual time does not apply scheduled param values,
  // so record the writes to assert that the latest props were applied.
  const paramProto = AudioParam.prototype;
  const originalSetValue = paramProto.setValueAtTime;

  paramProto.setValueAtTime = function (value, when) {
    this.__writes = (this.__writes || []).concat([ { value, when } ]);
    return originalSetValue.apply(this, arguments);
  };
};

patchScheduledSources();

const lastWrite = param => {
  if (!param || !param.__writes || !param.__writes.length) return null;
  return param.__writes[param.__writes.length - 1];
};

const carrier = () => createdOscillators[0] || null;

// ----------------------------------------------------------------------------
// reporting helpers
// ----------------------------------------------------------------------------

const report = document.getElementById('report');
const lines = [];
let failures = 0;

const check = (name, condition, detail) => {
  if (condition) {
    lines.push(`PASS ${name}`);
  } else {
    failures++;
    lines.push(`FAIL ${name}${detail ? ' :: ' + detail : ''}`);
  }
};

let currentContext = null;

const ids = new WeakMap();
let nextId = 0;
const idOf = node => {
  if (!node) return 'none';
  if (!ids.has(node)) ids.set(node, ++nextId);
  return ids.get(node);
};

const nameOf = node => {
  if (!node) return 'none';

  if (isAudioParam(node)) return `${nameOf(node._owner || {})}.param#${idOf(node)}`;

  if (node === (currentContext && currentContext.destination)) return 'destination';
  return `${node.constructor.name}#${idOf(node)}`;
};

const edges = () => liveEdges;

const describe = () => edges().map(edge => {
  const target = edge.paramSource ? `param#${idOf(edge.target)}` : nameOf(edge.target);
  const channels = edge.paramSource ? 'param' : `[${edge.output},${edge.input}]`;
  return `${nameOf(edge.source)} -> ${target} ${channels}`;
}).join(', ');

const edgeKey = edge =>
  `${idOf(edge.source)}|${idOf(edge.target)}|${edge.paramSource ? 'p' : 'n'}|${edge.output}|${edge.input}`;

const duplicateCount = () => {
  const keys = edges().map(edgeKey);
  return keys.filter((key, index) => keys.indexOf(key) !== index).length;
};

const countOfType = type =>
  edges().filter(edge =>
    edge.source.constructor.name === type ||
    edge.target.constructor.name === type).length;

const AudioParamOwner = param => param && param.__rAudioOwner;

// ----------------------------------------------------------------------------
// scene
// ----------------------------------------------------------------------------

const App = ({ state }) => h(RAudioContext, {
  debug: false,
  onInit: ctx => { currentContext = ctx; }
},
  h(RPipeline, null,
    h(ROscillator, {
      key: 'carrier',
      start: state.start,
      stop: state.stop,
      frequency: state.frequency,
      type: state.type,
      detune: 0
    }),
    state.filter ? h(RBiquadFilter, { frequency: 800, Q: 1, type: 'lowpass', key: 'filter' }) : null,
    h(RGain, { gain: 1, key: 'main' }),
    state.altGain ? h(RGain, { gain: 0.5, key: 'alt' }) : null,
    h(RSplit, null,
      h(RGain, { gain: 0.5, key: 'a' }),
      state.tail
        ? h(RPipeline, { key: 'tail' },
          h(RDelay, { delayTime: 0.1 }),
          h(RGain, { gain: 0.4 }))
        : null,
      state.param
        ? h(RPipeline, { key: 'mod' },
          h(ROscillator, { start: 0, frequency: 2, connectToParam: 'gain', key: 'lfo' }),
          h(RGain, { gain: 1, key: 'modTarget' }))
        : null
    )
  )
);

/**
 * Expected connection counts, worked out by hand from the JSX above:
 *
 * baseline: carrier->filter, filter->main, main->a, main->tail1,
 *   a->destination, tail1->tail2, tail2->destination                     = 7
 * filter removed: carrier->main replaces carrier->filter / filter->main  = 6
 * second gain added: main->alt is inserted in place of main->...         = 8
 * modulator added: modTarget->... plus lfo->main.gain                    = 10
 * tail unmounted: the split collapses to a single branch                = 4
 */
const states = [
  { name: 'baseline', value: { filter: true, altGain: false, param: false, tail: true, start: 0, stop: 10, frequency: 440, type: 'triangle' }, count: 7 },
  {
    name: 'filter removed (children change)',
    value: { filter: false, altGain: false, param: false, tail: true, start: 0, stop: 10, frequency: 440, type: 'triangle' },
    count: 6,
    absentType: 'BiquadFilterNode'
  },
  { name: 'filter restored', value: { filter: true, altGain: false, param: false, tail: true, start: 0, stop: 10, frequency: 440, type: 'triangle' }, count: 7 },
  { name: 'second gain added (routing change)', value: { filter: true, altGain: true, param: false, tail: true, start: 0, stop: 10, frequency: 440, type: 'triangle' }, count: 8 },
  { name: 'second gain removed', value: { filter: true, altGain: false, param: false, tail: true, start: 0, stop: 10, frequency: 440, type: 'triangle' }, count: 7 },
  {
    name: 'AudioParam modulator added',
    value: { filter: true, altGain: false, param: true, tail: true, start: 0, stop: 10, frequency: 440, type: 'triangle' },
    count: 10,
    paramEdge: true
  },
  { name: 'AudioParam modulator removed', value: { filter: true, altGain: false, param: false, tail: true, start: 0, stop: 10, frequency: 440, type: 'triangle' }, count: 7 },
  {
    name: 'tail branch unmounted',
    value: { filter: true, altGain: false, param: false, tail: false, start: 0, stop: 10, frequency: 440, type: 'triangle' },
    count: 4,
    absentType: 'DelayNode'
  },
  {
    // props updated while the source is playing, then the source is made to
    // end -> the library must rebuild it with the latest params and schedule
    name: 'source ended after a props update (rebuild)',
    value: { filter: true, altGain: false, param: false, tail: false, start: 0, stop: 20, frequency: 880, type: 'square' },
    count: 4,
    sourceRebuild: { frequency: 880, type: 'square' }
  }
];

const container = document.getElementById('app');
const mount = element => { ReactDOM.render(element, container); };

const finish = () => {
  lines.push(`RESULT ${failures === 0 ? 'ok' : 'failed'}`);
  lines.push(`FAILURES ${failures}`);
  report.textContent = lines.join('\n');
  document.title = failures === 0 ? 'browser-check-ok' : 'browser-check-failed';
};

let index = 0;

const step = () => {
  const state = states[index];
  mount(h(App, { state: state.value }));

  setTimeout(() => {
    check(`${state.name}: no duplicate connections`, duplicateCount() === 0, describe());
    check(`${state.name}: connection count is ${state.count}`,
      edges().length === state.count, describe());

    if (state.absentType) {
      check(`${state.name}: no ${state.absentType} left in the graph`,
        countOfType(state.absentType) === 0, describe());
    }

    if (state.paramEdge) {
      check('modulator targets the gain AudioParam',
        edges().filter(edge => edge.paramSource).length === 1, describe());
    }

    if (states[index - 1] && states[index - 1].paramEdge) {
      check('removing the modulator keeps the gain node input edge',
        edges().filter(edge =>
          !edge.paramSource && edge.target.constructor.name === 'GainNode').length > 0,
        describe());
    }

    if (state.sourceRebuild) {
      checkSourceRebuild(state);
    }

    index++;

    if (index < states.length) {
      setTimeout(step, 30);
    } else {
      ReactDOM.unmountComponentAtNode(container);
      setTimeout(() => {
        check('unmounting the tree removes every connection', edges().length === 0, describe());
        finish();
      }, 50);
    }
  }, 60);
};

/**
 * Drives the "source ended -> rebuild" path on the real Web Audio API:
 * dispatches the `ended` event of the live carrier OscillatorNode and checks
 * that a fresh node was created, carries the latest params and start/stop
 * schedule (observed through the AudioParam/AudioNode calls it receives) and
 * is wired into the same graph position.
 */
const checkSourceRebuild = state => {
  const expected = state.sourceRebuild;
  const before = createdOscillators.length;
  const live = carrier();

  if (!live) {
    check('carrier oscillator exists', false);
    return;
  }

  const liveFrequency = lastWrite(live.frequency);
  check('carrier received the latest frequency write',
    liveFrequency && liveFrequency.value === expected.frequency,
    liveFrequency ? `frequency=${liveFrequency.value}` : 'no write recorded');
  check('carrier received the latest type',
    live.type === expected.type, `type=${live.type}`);

  live.dispatchEvent(new Event('ended'));

  const after = createdOscillators.length;
  const rebuilt = createdOscillators[after - 1];

  check('a new oscillator replaces the ended one',
    after === before + 1 && rebuilt !== live,
    `created ${after - before} node(s)`);

  if (rebuilt && rebuilt !== live) {
    const rebuiltFrequency = lastWrite(rebuilt.frequency);
    check('rebuilt node receives the latest frequency',
      rebuiltFrequency && rebuiltFrequency.value === expected.frequency,
      rebuiltFrequency ? `frequency=${rebuiltFrequency.value}` : 'no write recorded');
    check('rebuilt node receives the latest type',
      rebuilt.type === expected.type, `type=${rebuilt.type}`);
    check('rebuilt node is started with the current schedule window',
      (rebuilt.__startCalls || []).length > 0, JSON.stringify(rebuilt.__startCalls));
    check('rebuilt node is connected where the old one was',
      edges().filter(edge => edge.source === rebuilt).length > 0, describe());
    check('the ended node is no longer in the graph',
      edges().every(edge => edge.source !== live && edge.target !== live), describe());
  }
};

window.onerror = (message, source, line) => {
  lines.push(`ERROR ${message} @${line}`);
  failures++;
  finish();
};

setTimeout(step, 30);
