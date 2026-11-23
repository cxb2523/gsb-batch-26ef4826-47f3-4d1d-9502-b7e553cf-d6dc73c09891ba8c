/**
 * Lifecycle tests for r-audio graph connections.
 *
 * These run against `test/mock-audio.js`, a deterministic Web Audio mock
 * which models connect/disconnect precisely and lets the tests move
 * `AudioContext.currentTime` forward to reproduce "the source ended".
 *
 * Run with `npm test`.
 */
require('./setup.js');

const React = require('react');
const { create } = require('react-test-renderer');
const lib = require('../index.js');

const h = React.createElement;

const {
  RAudioContext,
  RGain,
  ROscillator,
  RPipeline,
  RSplit,
  RCycle,
  RSplitChannels,
  RDelay,
  RBufferSource,
  RStereoPanner
} = lib;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

// per-object stable ids, only used to make failure messages readable
const ids = new WeakMap();
let nextId = 0;
const idOf = object => {
  if (!ids.has(object)) ids.set(object, ++nextId);
  return ids.get(object);
};

const describeEdge = edge => {
  const source = `${edge.source.typeName}#${idOf(edge.source)}`;
  const target = edge.param
    ? `${edge.destination.typeName}#${idOf(edge.destination)}.${edge.param}`
    : `${edge.destination.typeName}#${idOf(edge.destination)}`;
  const channels = edge.param ? 'param' : `[${edge.output},${edge.input}]`;
  return `${source} -> ${target} ${channels}`;
};

const describeEdges = ctx => ctx._edges.map(describeEdge);

/**
 * Fails when the same (source, target, output, input) edge was created twice.
 */
const assertNoDuplicates = ctx => {
  const keys = ctx._edges.map(edge => {
    const source = idOf(edge.source);
    const target = edge.param ? `p${idOf(edge.target)}` : `n${idOf(edge.target)}`;
    return `${source}->${target}:${edge.param || ''}:${edge.output}:${edge.input}`;
  });

  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  assert(duplicates.length === 0, `duplicate connections: ${duplicates.join(', ')}`);
};

module.exports = [
  {
    name: 'pipeline: replacing a child re-targets upstream without leaving the old edge',
    fn: () => {
      let ctx;
      const App = ({ useDelay }) => h(RAudioContext, { onInit: c => { ctx = c; } },
        h(RPipeline, null,
          h(ROscillator, { start: 0, frequency: 440, key: 'osc' }),
          useDelay
            ? h(RDelay, { delayTime: 0.2, key: 'tail' })
            : h(RGain, { gain: 0.5, key: 'tail' })
        )
      );

      const renderer = create(h(App, { useDelay: false }));
      const firstTarget = ctx._edges.find(edge =>
        edge.source.typeName === 'oscillator').destination;
      assert(ctx.connectionCount() === 2,
        `expected 2 connections after mount, got ${describeEdges(ctx)}`);

      renderer.update(h(App, { useDelay: true }));
      assert(ctx.connectionCount() === 2,
        `expected 2 connections after replacing the child, got ${describeEdges(ctx)}`);

      const oscillatorEdge = ctx._edges.find(edge =>
        edge.source.typeName === 'oscillator');
      assert(oscillatorEdge.destination.typeName === 'delay',
        `oscillator must now target the replacement, got ${describeEdges(ctx)}`);

      const staleEdges = ctx._edges.filter(edge => edge.destination === firstTarget);
      assert(staleEdges.length === 0,
        `the removed gain must receive no audio: ${describeEdges(ctx)}`);

      assertNoDuplicates(ctx);
      renderer.unmount();
      assert(ctx.connectionCount() === 0,
        `expected all connections removed on unmount, got ${describeEdges(ctx)}`);
    }
  },
  {
    name: 'pipeline: inserting a child removes the bypassed connection (destination change)',
    fn: () => {
      let ctx;
      const App = ({ insertGain }) => h(RAudioContext, { onInit: c => { ctx = c; } },
        h(RPipeline, null,
          h(ROscillator, { start: 0, frequency: 440, key: 'osc' }),
          insertGain ? h(RGain, { gain: 0.5, key: 'inserted' }) : null,
          h(RGain, { gain: 1, key: 'final' })
        )
      );

      const renderer = create(h(App, { insertGain: false }));
      const finalGain = ctx._edges.find(edge =>
        edge.source.typeName === 'oscillator').destination;
      assert(ctx.connectionCount() === 2, `baseline: ${describeEdges(ctx)}`);

      renderer.update(h(App, { insertGain: true }));
      // osc -> inserted, inserted -> final, final -> destination
      assert(ctx.connectionCount() === 3,
        `expected 3 connections after insertion, got ${describeEdges(ctx)}`);

      const oscillatorEdge = ctx._edges.find(edge =>
        edge.source.typeName === 'oscillator');
      assert(oscillatorEdge.destination !== finalGain,
        `oscillator must not keep its old direct edge to the final gain: ${describeEdges(ctx)}`);

      assertNoDuplicates(ctx);

      renderer.update(h(App, { insertGain: false }));
      assert(ctx.connectionCount() === 2,
        `expected the inserted branch to be removed, got ${describeEdges(ctx)}`);
      const restored = ctx._edges.find(edge => edge.source.typeName === 'oscillator');
      assert(restored.destination === finalGain,
        `oscillator should connect to the final gain again: ${describeEdges(ctx)}`);

      assertNoDuplicates(ctx);
      renderer.unmount();
      assert(ctx.connectionCount() === 0, 'all cleared on unmount');
    }
  },
  {
    name: 'pipeline: identifier changes keep the registry and connections consistent',
    fn: () => {
      let ctx;
      const App = ({ gain }) => h(RAudioContext, { onInit: c => { ctx = c; } },
        h(RPipeline, null,
          h(ROscillator, { start: 0, frequency: 440 }),
          h(RGain, { gain })
        )
      );

      const renderer = create(h(App, { gain: 1 }));
      assert(ctx.connectionCount() === 2, 'baseline connections');

      renderer.update(h(App, { gain: 0.5 }));
      assert(ctx.connectionCount() === 2,
        `a props update must not duplicate edges: ${describeEdges(ctx)}`);
      assertNoDuplicates(ctx);

      renderer.unmount();
      assert(ctx.connectionCount() === 0, 'cleared on unmount');
    }
  },
  {
    name: 'source: natural end rebuilds the node with the latest params',
    fn: () => {
      let ctx;
      const App = ({ frequency, type, gain, start, stop }) => h(RAudioContext, { onInit: c => { ctx = c; } },
        h(RPipeline, null,
          h(ROscillator, { start, stop, frequency, type, detune: 3 }),
          h(RGain, { gain })
        )
      );

      const renderer = create(h(App, {
        frequency: 440, type: 'triangle', gain: 1, start: 0, stop: 1
      }));

      const firstOscillator = ctx.scheduledSources()[0];
      assert(firstOscillator, 'oscillator should have been started');
      assert(firstOscillator.frequency.value === 440, 'initial frequency applied');

      ctx.advance(0.2);
      renderer.update(h(App, {
        frequency: 880, type: 'square', gain: 0.25, start: 0, stop: 1
      }));
      assert(firstOscillator.frequency.value === 880, 'frequency updated live');
      assert(firstOscillator.type === 'square', 'type updated live');

      ctx.advance(1.2); // past the stop time -> the node ends
      const rebuilt = ctx.scheduledSources()[ctx.scheduledSources().length - 1];
      assert(rebuilt && rebuilt !== firstOscillator, 'a new oscillator was created');

      // rebuilt node must carry the latest parameters
      assert(rebuilt.frequency.value === 880, 'rebuilt node keeps latest frequency');
      assert(rebuilt.detune.value === 3, 'rebuilt node keeps detune');
      assert(rebuilt.type === 'square', 'rebuilt node keeps latest type');

      // it must be wired to the same place in the graph
      assert(ctx.connectionCount() === 2,
        `rebuilt node keeps the graph intact: ${describeEdges(ctx)}`);
      assertNoDuplicates(ctx);

      // the latest start/stop props describe a window which already elapsed,
      // so the rebuilt node must stay silent (not loop forever) but remain
      // ready to play as soon as a new schedule arrives.
      assert(!rebuilt._started, 'an already elapsed window is not restarted');

      renderer.update(h(App, {
        frequency: 880, type: 'square', gain: 0.25, start: 2, stop: 3
      }));
      assert(rebuilt.startTime === 2,
        `the rebuilt node picks up the new future schedule (${rebuilt.startTime})`);
      assert(rebuilt._stopTime === 3, `new stop time applied (${rebuilt._stopTime})`);

      ctx.advance(2.5);
      assert(!rebuilt._ended, 'rebuilt node plays in the new window');

      renderer.unmount();
      assert(ctx.connectionCount() === 0, 'all connections removed on unmount');
    }
  },
  {
    name: 'source: consecutive natural ends rebuild repeatedly without leaking edges',
    fn: () => {
      let ctx;
      // Every re-render pushes the stop time further into the future, like an
      // app that keeps a tone playing; each natural end rebuilds the node.
      const App = ({ stop }) => h(RAudioContext, { onInit: c => { ctx = c; } },
        h(RPipeline, null,
          h(ROscillator, { start: 0, stop, frequency: 330, type: 'sine' }),
          h(RGain, { gain: 1 })
        )
      );

      const renderer = create(h(App, { stop: 1 }));
      assert(ctx.scheduledSources()[0]._stopTime === 1, 'first window scheduled');

      for (let cycle = 1; cycle <= 3; cycle++) {
        ctx.advance(cycle); // window `cycle` has just ended
        renderer.update(h(App, { stop: cycle + 1 }));

        assertNoDuplicates(ctx);
        assert(ctx.connectionCount() === 2,
          `cycle ${cycle}: the rebuilt node must stay connected: ${describeEdges(ctx)}`);

        const live = ctx.scheduledSources()[ctx.scheduledSources().length - 1];
        assert(live.startTime === ctx.currentTime,
          `cycle ${cycle}: rebuilt node starts now (${live.startTime})`);
        assert(live._stopTime === cycle + 1,
          `cycle ${cycle}: rebuilt node adopts the latest stop (${live._stopTime})`);
      }

      assert(ctx.scheduledSources().length >= 4, 'each cycle created a fresh source node');

      renderer.unmount();
      assert(ctx.connectionCount() === 0, 'all connections removed on unmount');
    }
  },
  {
    name: 'source: extending the stop prop reschedules the live node without rebuilding it',
    fn: () => {
      let ctx;
      const App = ({ start, stop, frequency }) => h(RAudioContext, { onInit: c => { ctx = c; } },
        h(RPipeline, null,
          h(ROscillator, { start, stop, frequency, type: 'sine', detune: 2 }),
          h(RGain, { gain: 1 })
        )
      );

      const renderer = create(h(App, { start: 0, stop: 1, frequency: 440 }));
      const first = ctx.scheduledSources()[0];
      ctx.advance(0.5);
      assert(first._stopTime === 1, 'initial stop applied');

      renderer.update(h(App, { start: 0, stop: 3, frequency: 880 }));

      assert(ctx.scheduledSources().length === 1,
        'a running node is rescheduled, not rebuilt');
      assert(first._stopTime === 3, `new stop applied to the live node (${first._stopTime})`);
      assert(first.frequency.value === 880, 'latest frequency applied');

      ctx.advance(1.2);
      assert(!first._ended, 'the extended window keeps the node playing');

      renderer.unmount();
      assert(ctx.connectionCount() === 0, 'all connections removed');
    }
  },
  {
    name: 'source: a pending future window survives an earlier natural end',
    fn: () => {
      let ctx;
      // Short buffer + a props stop far in the future, then a new window while
      // the buffer is still playing: the buffer ends naturally first and the
      // rebuild must adopt the latest window/params.
      const buffer = { duration: 0.5, sampleRate: 48000 };
      const App = ({ start, stop, frequency }) => h(RAudioContext, { onInit: c => { ctx = c; } },
        h(RPipeline, null,
          h(RBufferSource, { buffer, start, stop, playbackRate: 1, loop: false }),
          h(RGain, { gain: 1 })
        )
      );

      const renderer = create(h(App, { start: 0, stop: 1, frequency: 440 }));
      ctx.advance(0.2);
      renderer.update(h(App, { start: 2, stop: 3, frequency: 880 }));
      assert(ctx.scheduledSources()[0]._stopTime === 3, 'live node extends to 3');

      ctx.advance(0.6); // the 0.5s buffer ends naturally before the stop time
      const rebuilt = ctx.scheduledSources()[ctx.scheduledSources().length - 1];

      assert(rebuilt !== ctx.scheduledSources()[0], 'a new node was created');
      assert(rebuilt.startTime === 2, `pending window start honoured (${rebuilt.startTime})`);
      assert(rebuilt._stopTime === 3, `pending window stop honoured (${rebuilt._stopTime})`);

      renderer.unmount();
    }
  },
  {
    name: 'buffer source: natural end before props stop replays per the latest window',
    fn: () => {
      let ctx;
      // A 1s buffer with start=0, stop=3 ends naturally after 1s; the props
      // still ask for a window ending at 3, so the rebuilt node must play the
      // remainder of that window with the latest params.
      const buffer = { duration: 1, sampleRate: 48000 };
      const App = ({ playbackRate, start, stop }) => h(RAudioContext, { onInit: c => { ctx = c; } },
        h(RPipeline, null,
          h(RBufferSource, { buffer, start, stop, loop: false, playbackRate }),
          h(RGain, { gain: 1 })
        )
      );

      const renderer = create(h(App, { playbackRate: 1, start: 0, stop: 3 }));
      const first = ctx.scheduledSources()[0];
      assert(first._stopTime === 3, 'explicit stop applied');

      ctx.advance(1.1); // natural end of the 1s buffer
      const rebuilt = ctx.scheduledSources()[ctx.scheduledSources().length - 1];
      assert(rebuilt !== first, 'a new buffer source was created');
      assert(rebuilt.buffer === buffer, 'rebuilt node keeps the buffer');
      assert(rebuilt.playbackRate.value === 1, 'rebuilt node keeps playback rate');
      assert(rebuilt.startTime === ctx.currentTime, 'rebuilt node starts now');
      assert(rebuilt._stopTime === 3, `rebuilt node keeps the future stop (${rebuilt._stopTime})`);
      assertNoDuplicates(ctx);

      renderer.unmount();
      assert(ctx.connectionCount() === 0, 'all connections removed');
    }
  },
  {
    name: 'source: unmounting the parent stops upstream audio flowing to destroyed nodes',
    fn: () => {
      let ctx;
      const App = ({ show }) => h(RAudioContext, { onInit: c => { ctx = c; } },
        h(RPipeline, null,
          h(ROscillator, { start: 0, frequency: 440, key: 'osc' }),
          show ? h(RGain, { gain: 1 }) : null
        )
      );

      const renderer = create(h(App, { show: true }));
      assert(ctx.connectionCount() === 2, 'two connections at mount');

      renderer.update(h(App, { show: false }));
      // the gain unmounts; the oscillator must no longer target it (it
      // should target the context destination instead).
      assert(ctx.connectionCount() === 1,
        `only the oscillator -> destination edge should remain: ${describeEdges(ctx)}`);
      assert(ctx.edges()[0].destination === 'destination',
        'oscillator now connects straight to the destination');

      renderer.unmount();
      assert(ctx.connectionCount() === 0, 'all connections removed on unmount');
    }
  },
  {
    name: 'source: a source that ends while wired into a cycle leaves no stale edge',
    fn: () => {
      let ctx;
      const App = () => h(RAudioContext, { onInit: c => { ctx = c; } },
        h(RPipeline, null,
          h(ROscillator, { start: 0, stop: 0.5, frequency: 440, key: 'lead' }),
          h(RGain, { gain: 1 }),
          h(RCycle, null,
            h(RPipeline, null,
              h(RDelay, { delayTime: 0.1 }),
              h(RGain, { gain: 0.4, key: 'fb' })
            )
          )
        )
      );

      const renderer = create(h(App));
      const firstOscillator = ctx.nodesOfType('oscillator')[0];
      assert(firstOscillator, 'oscillator mounted');

      ctx.advance(0.6);
      const currentOscillator = ctx.nodesOfType('oscillator')[0];
      assert(currentOscillator !== firstOscillator,
        'the ended oscillator was replaced by a new one');

      // nothing may still point at (or be sourced by) the retired node
      const stale = ctx.edges().filter(edge =>
        edge.raw.source === firstOscillator || edge.raw.destination === firstOscillator);
      assert(stale.length === 0,
        `the retired oscillator must not be in the graph: ${stale.map(describeEdge)}`);

      // and the graph must be intact and connected
      assert(ctx.connectionCount() === 5,
        `cycle graph intact after the rebuild: ${describeEdges(ctx)}`);
      assertNoDuplicates(ctx);

      renderer.unmount();
      assert(ctx.connectionCount() === 0, 'all connections removed');
    }
  },
  {
    name: 'split: children changes leave no duplicate or stale branches',
    fn: () => {
      let ctx;
      const App = ({ branches }) => h(RAudioContext, { onInit: c => { ctx = c; } },
        h(RPipeline, null,
          h(ROscillator, { start: 0, frequency: 440 }),
          h(RGain, { gain: 1 }),
          h(RSplit, null,
            h(RGain, { gain: 0.3, key: 'a' }),
            branches >= 2 ? h(RDelay, { delayTime: 0.1, key: 'b' }) : null,
            h(RGain, { gain: 0.6, key: 'c' })
          )
        )
      );

      // osc -> gain, gain -> split input a, gain -> split input c,
      // a -> destination, c -> destination
      const renderer = create(h(App, { branches: 1 }));
      assert(ctx.connectionCount() === 5,
        `split with 2 branches should have 5 edges, got ${describeEdges(ctx)}`);
      assertNoDuplicates(ctx);

      renderer.update(h(App, { branches: 2 }));
      // a third branch adds its input edge and its own output edge
      assert(ctx.connectionCount() === 7,
        `adding a branch should add two edges, got ${describeEdges(ctx)}`);
      assertNoDuplicates(ctx);

      renderer.update(h(App, { branches: 1 }));
      assert(ctx.connectionCount() === 5,
        `removing a branch should remove one edge, got ${describeEdges(ctx)}`);
      assertNoDuplicates(ctx);

      renderer.unmount();
      assert(ctx.connectionCount() === 0, 'all connections removed');
    }
  },
  {
    name: 'cycle: feedback loop participates in reconciliation and teardown',
    fn: () => {
      let ctx;
      const App = ({ show }) => h(RAudioContext, { onInit: c => { ctx = c; } },
        h(RPipeline, null,
          h(ROscillator, { start: 0, frequency: 220 }),
          h(RGain, { gain: 1 }),
          h(RCycle, null,
            h(RPipeline, null,
              h(RDelay, { delayTime: 0.1 }),
              h(RGain, { gain: 0.4, key: 'fb' })
            ),
            show ? h(RStereoPanner, { pan: 0.25, key: 'pan' }) : null
          )
        )
      );

      const renderer = create(h(App, { show: true }));
      // osc -> gain, gain -> delay, gain -> panner,
      // delay -> feedback, feedback -> destination, feedback -> delay,
      // panner -> destination, panner -> panner (cycle back into itself)
      assert(ctx.connectionCount() === 8,
        `expected 8 cycle edges, got ${describeEdges(ctx)}`);
      assertNoDuplicates(ctx);

      renderer.update(h(App, { show: false }));
      assert(ctx.connectionCount() === 5,
        `removing the panner should drop exactly its edges: ${describeEdges(ctx)}`);
      assertNoDuplicates(ctx);

      renderer.unmount();
      assert(ctx.connectionCount() === 0,
        `unmounting a cycle must remove every edge: ${describeEdges(ctx)}`);
    }
  },
  {
    name: 'split channels: teardown removes every generated edge',
    fn: () => {
      let ctx;
      const App = ({ channelCount }) => h(RAudioContext, { onInit: c => { ctx = c; } },
        h(RPipeline, null,
          h(ROscillator, { start: 0, frequency: 440 }),
          h(RSplitChannels, { channelCount },
            h(RGain, { gain: 1 }),
            h(RGain, { gain: 0.5 })
          )
        )
      );

      const renderer = create(h(App, { channelCount: 2 }));
      assertNoDuplicates(ctx);

      renderer.unmount();
      assert(ctx.connectionCount() === 0,
        `RSplitChannels teardown must remove every edge: ${describeEdges(ctx)}`);
    }
  },
  {
    name: 'buffer source: natural end rebuilds the node with the latest buffer',
    fn: () => {
      let ctx;
      const bufferA = { duration: 1, sampleRate: 48000 };
      const bufferB = { duration: 2, sampleRate: 48000 };
      const App = ({ buffer, start, stop }) => h(RAudioContext, { onInit: c => { ctx = c; } },
        h(RPipeline, null,
          h(RBufferSource, { buffer, start, stop, loop: false }),
          h(RGain, { gain: 1 })
        )
      );

      const renderer = create(h(App, { buffer: bufferA, start: 0, stop: 1 }));
      const first = ctx.scheduledSources()[0];
      assert(first && first.buffer === bufferA, 'first buffer applied');

      renderer.update(h(App, { buffer: bufferB, start: 0, stop: 1 }));
      // a started buffer source cannot take a new buffer -> it is rebuilt
      const rebuilt = ctx.scheduledSources()[ctx.scheduledSources().length - 1];
      assert(rebuilt.buffer === bufferB, 'rebuilt node carries the latest buffer');

      ctx.advance(1.5);
      const afterEnd = ctx.scheduledSources()[ctx.scheduledSources().length - 1];
      assert(afterEnd.buffer === bufferB, 'node rebuilt after ended keeps the latest buffer');
      assertNoDuplicates(ctx);
      assert(ctx.connectionCount() === 2,
        `buffer source rebuild keeps the graph intact: ${describeEdges(ctx)}`);

      renderer.unmount();
      assert(ctx.connectionCount() === 0, 'all connections removed');
    }
  },
  {
    name: 'AudioParam connections are added and removed with precise arguments',
    fn: () => {
      let ctx;
      const App = ({ useParam }) => h(RAudioContext, { onInit: c => { ctx = c; } },
        h(RPipeline, null,
          h(ROscillator, { start: 0, frequency: 440, key: 'carrier' }),
          useParam ? h(ROscillator, { start: 0, frequency: 2, connectToParam: 'gain', key: 'mod' }) : null,
          h(RGain, { gain: 1, key: 'target' })
        )
      );

      const renderer = create(h(App, { useParam: false }));
      const before = ctx.connectionCount();
      assert(before === 2, `carrier -> gain -> destination: ${describeEdges(ctx)}`);

      renderer.update(h(App, { useParam: true }));
      const paramEdges = ctx._edges.filter(edge => edge.param === 'gain');
      assert(paramEdges.length === 1, 'modulator connected to the gain AudioParam');

      renderer.update(h(App, { useParam: false }));
      assert(ctx.connectionCount() === before,
        `param connection removed precisely: ${describeEdges(ctx)}`);

      const stillConnected = ctx._edges.filter(edge => edge.destination.typeName === 'gain');
      assert(stillConnected.length === 1, `the gain input connection must survive: ${describeEdges(ctx)}`);

      renderer.unmount();
      assert(ctx.connectionCount() === 0, 'all connections removed');
    }
  }
];
