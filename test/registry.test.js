/**
 * Unit tests for the connection registry, focused on the precise
 * connect/disconnect semantics of Web Audio.
 */
const { ConnectionRegistry, isAudioParam } = require('../src/base/connection-registry.js');
const { MockAudioContext, MockAudioNode } = require('./mock-audio.js');

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const setup = () => {
  const context = new MockAudioContext();
  const registry = new ConnectionRegistry();
  const source = new MockAudioNode(context, 'source');
  const target = new MockAudioNode(context, 'target');
  target.gain = context._createNode('gain', { gain: 1 }).gain;
  target.gain._owner = target;
  return { context, registry, source, target };
};

module.exports = [
  {
    name: 'registry: identical edges are only created once',
    fn: () => {
      const { context, registry, source, target } = setup();
      const spec = { destination: target, target, param: null, output: 0, input: 0 };

      registry.reconcile('owner', source, [ spec, spec ]);

      assert(context.connectionCount() === 1,
        `expected a single connection, got ${context.connectionCount()}`);
      assert(registry.edges.length === 1, 'expected one recorded edge');

      // a later reconcile with the same spec must not add another connection
      registry.reconcile('owner', source, [ spec ]);
      assert(context.connectionCount() === 1, 'reconcile must be idempotent');
    }
  },
  {
    name: 'registry: the same destination on different channels is preserved',
    fn: () => {
      const { context, registry, source, target } = setup();

      registry.reconcile('owner', source, [
        { destination: target, target, param: null, output: 0, input: 0 },
        { destination: target, target, param: null, output: 1, input: 0 },
        { destination: target, target, param: null, output: 0, input: 1 }
      ]);

      assert(context.connectionCount() === 3,
        `expected three distinct channel connections, got ${context.connectionCount()}`);
    }
  },
  {
    name: 'registry: AudioParam edges are removed without touching the node edge',
    fn: () => {
      const { context, registry, source, target } = setup();

      registry.reconcile('owner', source, [
        { destination: target, target, param: null, output: 0, input: 0 },
        { destination: target, target: target.gain, param: 'gain', output: 0, input: undefined }
      ]);

      assert(context.connectionCount() === 2, 'node edge and param edge exist');

      registry.reconcile('owner', source, [
        { destination: target, target, param: null, output: 0, input: 0 }
      ]);

      const remaining = context._edges;
      assert(remaining.length === 1, 'only the node edge should remain');
      assert(remaining[0].param === null, 'the remaining edge is the node input edge');
    }
  },
  {
    name: 'registry: removal is precise and leaves unrelated connections alone',
    fn: () => {
      const { context, registry, source, target } = setup();
      const other = new MockAudioNode(context, 'other');

      // a connection created behind the registry's back (e.g. by user code)
      source.connect(other);

      registry.reconcile('owner', source, [
        { destination: target, target, param: null, output: 0, input: 0 }
      ]);
      registry.removeByOwner('owner');

      const remaining = context._edges;
      assert(remaining.length === 1 && remaining[0].destination === other,
        `the un-owned connection must survive, got ${remaining.length} edge(s)`);
    }
  },
  {
    name: 'registry: retiring a node re-points recorded incoming edges, not its own outputs',
    fn: () => {
      const { context, registry, source, target } = setup();
      const upstream = new MockAudioNode(context, 'upstream');
      const replacement = new MockAudioNode(context, 'replacement');

      const upstreamSpec = { destination: target, target, param: null, output: 0, input: 0 };
      const selfSpec = { destination: upstream, target: upstream, param: null, output: 0, input: 0 };

      // edges recorded through the registry, as the library creates them
      registry.connect('upstream-owner', upstream, upstreamSpec);
      registry.connect('target-owner', target, selfSpec);

      registry.retarget(target, replacement);

      const edges = context._edges;
      assert(edges.some(edge => edge.source === upstream && edge.destination === replacement),
        'the recorded upstream edge moved to the replacement');
      assert(!edges.some(edge => edge.source === upstream && edge.destination === target),
        'the upstream edge to the retired node is gone');
      assert(edges.some(edge => edge.source === target && edge.destination === upstream),
        'the retired node keeps its own outgoing edge (handled by its owner)');
    }
  },
  {
    name: 'registry: isAudioParam recognises AudioParams and rejects nodes',
    fn: () => {
      const { context, target } = setup();
      assert(isAudioParam(target.gain), 'a mock AudioParam should be detected');
      assert(!isAudioParam(target), 'an AudioNode is not an AudioParam');
      assert(!isAudioParam(null), 'null is not an AudioParam');
    }
  },
  {
    name: 'registry: a failed precise disconnect falls back and stays consistent',
    fn: () => {
      const { context, registry, source, target } = setup();

      // two edges to the same target on different channels
      registry.connect('owner', source,
        { destination: target, target, param: null, output: 0, input: 0 });
      registry.connect('owner', source,
        { destination: target, target, param: null, output: 1, input: 0 });

      // make the precise disconnect throw, as browsers do for edges which are
      // already gone, and record a target-wide disconnect instead
      const originalDisconnect = source.disconnect.bind(source);
      source.disconnect = function () {
        if (arguments.length === 3) throw new Error('InvalidAccessError');
        return originalDisconnect.apply(source, arguments);
      };

      registry.removeBySource(source);

      assert(context.connectionCount() === 0,
        `the fallback removes every edge to the target, got ${context.connectionCount()}`);
      assert(registry.edges.length === 0,
        `the registry must mirror the fallback, got ${registry.edges.length} recorded edge(s)`);
    }
  }
];
