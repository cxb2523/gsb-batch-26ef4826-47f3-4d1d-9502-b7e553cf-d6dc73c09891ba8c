/**
 * Bookkeeping of all AudioNode connections created by r-audio.
 *
 * Web Audio's `disconnect` API is overloaded in subtle ways:
 *  - `disconnect()` removes every outgoing connection of a node;
 *  - `disconnect(destinationNode)` removes every connection to that node;
 *  - `disconnect(destinationNode, output, input)` removes a single edge;
 *  - `disconnect(destinationParam)` removes every connection to an AudioParam
 *    (channel arguments are not allowed for AudioParam targets).
 *
 * Blindly calling `disconnect()` (as the original implementation did) tears
 * down connections which are not owned by the component and makes it
 * impossible to tell which edges are still needed after a re-render.
 * This registry keeps track of the exact edges each component owns so that
 * they can be reconciled (added/removed) one by one.
 *
 * A registry is kept per AudioContext in a WeakMap, so it does not leak and
 * works for any RAudioContext instance.
 */

const registries = new WeakMap();

/**
 * Detects AudioParams without relying on the global constructor being present
 * (it is absent in e.g. Node-based test environments with a mocked Web Audio).
 */
const isAudioParam = value => {
  if (!value || typeof value !== 'object') return false;

  if (typeof AudioParam !== 'undefined' && value instanceof AudioParam) return true;

  // duck-typing fallback
  return typeof value.setValueAtTime === 'function' && 'value' in value;
};

const normalizeParam = spec => spec.param || null;
const normalizeOutput = spec => (spec.param ? 0 : (spec.output || 0));
const normalizeInput = spec => (spec.param ? 0 : (spec.input === undefined || spec.input === null ? 0 : spec.input));

/**
 * Two connection specs describe the same edge when they share the source,
 * the target (AudioNode or AudioParam), and - for AudioNode targets - the
 * output and input channels.
 */
const sameEdge = (edge, spec, source) => {
  if (edge.source !== source) return false;
  if (edge.target !== spec.target) return false;
  if (edge.param !== normalizeParam(spec)) return false;

  // AudioParam connections do not carry channel information
  if (edge.param) return true;

  return edge.output === normalizeOutput(spec) &&
    edge.input === normalizeInput(spec);
};

class ConnectionRegistry {
  constructor() {
    this.edges = [];
  }

  edgesForOwner(owner) {
    return this.edges.filter(edge => edge.owner === owner);
  }

  hasEdge(source, spec) {
    return this.edges.some(edge => sameEdge(edge, spec, source));
  }

  /**
   * Creates a single connection and records it.
   * Duplicate edges (same source, target and channels) are ignored.
   */
  connect(owner, source, spec) {
    if (!spec || !spec.target || this.hasEdge(source, spec)) return null;

    const edge = {
      owner,
      source,
      // the AudioNode the edge points at, even when the actual target is its AudioParam
      destination: spec.destination || spec.target,
      target: spec.target,
      param: normalizeParam(spec),
      output: normalizeOutput(spec),
      input: normalizeInput(spec)
    };

    try {
      if (edge.param) {
        source.connect(edge.target);
      } else {
        source.connect(edge.target, edge.output, edge.input);
      }
    } catch (e) {
      console.warn('Could not create audio connection', e); // eslint-disable-line no-console
      return null;
    }

    this.edges.push(edge);
    return edge;
  }

  /**
   * Removes a recorded edge using the most precise disconnect call available.
   */
  disconnectEdge(edge) {
    const index = this.edges.indexOf(edge);
    if (index === -1) return;
    this.edges.splice(index, 1);

    try {
      if (edge.param) {
        edge.source.disconnect(edge.target);
      } else {
        edge.source.disconnect(edge.target, edge.output, edge.input);
      }
      return;
    } catch (e) {
      // The precise edge is already gone (e.g. the source node ended or the
      // connection was removed by its owner). There is nothing left to do.
      if (edge.param) {
        try {
          edge.source.disconnect(edge.target);
        } catch (e2) {
          // nothing left to disconnect
        }
        return;
      }
    }

    // Fall back to a target-wide disconnect, which removes every connection
    // from this source to this node. Only do that when it succeeds, and drop
    // the matching siblings from the registry as well so the bookkeeping stays
    // consistent with the actual graph.
    try {
      edge.source.disconnect(edge.target);
    } catch (e) {
      return;
    }

    this.edges
      .filter(other =>
        other.source === edge.source && other.target === edge.target && !other.param)
      .forEach(other => {
        const otherIndex = this.edges.indexOf(other);
        if (otherIndex !== -1) this.edges.splice(otherIndex, 1);
      });
  }

  /**
   * Brings the edges owned by `owner` from `source` in sync with `desired`.
   * Edges which are no longer wanted are removed (including edges still
   * recorded from a previous AudioNode instance of the same owner), and
   * missing ones are created exactly once.
   *
   * @param      {RComponent}  owner    the component owning the edges
   * @param      {AudioNode}  source    the AudioNode the edges start from
   * @param      {Array}  desired       array of edge specs
   */
  reconcile(owner, source, desired) {
    const desiredSpecs = [];

    desired.forEach(spec => {
      if (!spec || !spec.target) return;
      if (desiredSpecs.some(existing => sameEdge({ source }, spec, source))) return;
      desiredSpecs.push(spec);
    });

    this.edgesForOwner(owner).forEach(edge => {
      // Connections made from a node which has since been replaced are stale.
      // Edges which are not part of the new desired set are removed too.
      const stillWanted = edge.source === source &&
        desiredSpecs.some(spec => sameEdge(edge, spec, source));

      if (!stillWanted) this.disconnectEdge(edge);
    });

    desiredSpecs.forEach(spec => {
      if (!this.hasEdge(source, spec)) this.connect(owner, source, spec);
    });
  }

  /**
   * Removes all outgoing connections recorded for the given owner.
   */
  removeByOwner(owner) {
    this.edgesForOwner(owner).forEach(edge => this.disconnectEdge(edge));
  }

  /**
   * Removes all outgoing connections recorded for the given AudioNode.
   */
  removeBySource(source) {
    this.edges.filter(edge => edge.source === source).forEach(edge => this.disconnectEdge(edge));
  }

  /**
   * Removes every incoming connection which targets the given node, including
   * connections made to any of its AudioParams.
   */
  removeByTarget(node) {
    this.edges
      .filter(edge => edge.destination === node || edge.target === node)
      .forEach(edge => this.disconnectEdge(edge));
  }

  /**
   * Re-points incoming connections from `oldNode` to `newNode`.
   *
   * This is used when a source node has to be re-instantiated (Web Audio
   * scheduled sources can only be started once): upstream nodes stay wired
   * to the same graph location without having to re-render.
   *
   * @return     {boolean}  whether every incoming edge could be re-pointed
   */
  retarget(oldNode, newNode) {
    if (!oldNode || !newNode || oldNode === newNode) return true;

    let complete = true;

    this.edges
      // Only re-point *incoming* edges. Edges whose source is the old node
      // are the node's own outgoing connections and are reconciled by the
      // node itself (a self-loop must not be re-pointed to the dead node).
      .filter(edge => edge.destination === oldNode && edge.source !== oldNode)
      .forEach(edge => {
        let newTarget = newNode;

        if (edge.param) {
          newTarget = newNode[edge.param];
          if (!isAudioParam(newTarget)) {
            // the replacement node does not expose the same AudioParam
            this.disconnectEdge(edge);
            complete = false;
            return;
          }
        }

        const spec = {
          destination: newNode,
          target: newTarget,
          param: edge.param,
          output: edge.output,
          input: edge.input
        };

        // Create the replacement edge before dropping the old one so that
        // audio never has a gap.
        if (!this.hasEdge(edge.source, spec)) {
          this.connect(edge.owner, edge.source, spec);
        }
        this.disconnectEdge(edge);
      });

    return complete;
  }

  /**
   * Forcibly removes every recorded connection.
   */
  reset() {
    this.edges.slice().forEach(edge => this.disconnectEdge(edge));
    this.edges = [];
  }
}

const getConnectionRegistry = audioContext => {
  if (!audioContext) return new ConnectionRegistry();

  let registry = registries.get(audioContext);

  if (!registry) {
    registry = new ConnectionRegistry();
    registries.set(audioContext, registry);
  }

  return registry;
};

export {
  ConnectionRegistry,
  getConnectionRegistry,
  isAudioParam
};
