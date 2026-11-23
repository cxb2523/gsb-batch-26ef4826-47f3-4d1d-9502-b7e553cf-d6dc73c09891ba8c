import React from 'react';
import RComponent from './component.js';
import { getConnectionRegistry, isAudioParam } from './connection-registry.js';

/**
 * Any RComponent that corresponds to an AudioNode is a RAudioNode
 *
 * @class      RAudioNode (name)
 */
export default class RAudioNode extends RComponent {
  constructor(props) {
    super(props);
    // internal AudioNode instance
    this.node = null;
    // dictionary of AudioNode parameters (either AudioParams or object properties)
    this.params = {};
    this.disposed = false;
    this.connectToAllDestinations = this.connectToAllDestinations.bind(this);
    this.setParam = this.setParam.bind(this);
  }

  /**
   * Returns the connection registry shared by all nodes of the current AudioContext.
   * It is used to keep track of the exact connections owned by this component
   * so they can be reconciled instead of blindly disconnected.
   */
  getRegistry() {
    return getConnectionRegistry(this.context.audio);
  }

  // recursively builds up a list of nodes pointed to by IDs or lists of IDs
  flattenPointers(destinations, flattened = []) {
    for (let element of destinations) {
      if (Array.isArray(element)) {
        this.flattenPointers(element, flattened);
      } else if (typeof element === 'symbol') {
        const resolved = this.context.nodes.get(element);

        // a symbol can point to a list of other symbols (e.g. an RSplit input list)
        if (Array.isArray(resolved)) {
          this.flattenPointers(resolved, flattened);
        } else {
          flattened.push(resolved);
        }
      } else if (element) {
        flattened.push(element);
      }
    }

    return flattened;
  }

  /**
   * Generates arguments for AudioNode.connect
   * Useful because we can, for instance, override the channel assignment logic for ChannelSplitter etc.
   *
   * @param      {function} destination The AudioNode to connect to
   * @param      {number} destinationIndex The index of the AudioNode among other destinations
   * @param      {string|null} toParam The name of the AudioParam to connect to (or undefined)
   * @param      {number} fromChannel The index of the chosen output channel of this node (default is 0)
   * @param      {number} toChannel The index of the chosen input channel of the destination node (default is 0)
   */
  getConnectionArguments(destination, destinationIndex, toParam, fromChannel = 0, toChannel = 0) {
    const connectTarget = toParam ? destination[toParam] : destination;

    return [ connectTarget ].concat(toParam ? [] : [ fromChannel, toChannel ]);
  }

  /**
   * Resolves the destination getter into a list of connection specs.
   * A spec describes one connection edge: destination node, target
   * (AudioNode or AudioParam), output channel and input channel.
   *
   * @param      {function} destinationFunction The function that returns the destinations
   * @return     {Array}  the connection specs
   */
  resolveConnectionSpecs(destinationFunction) {
    if (!destinationFunction || this.props.disconnected) return [];

    let destinations = destinationFunction();
    if (!(destinations instanceof Array)) destinations = [ destinations ];

    const toParam = this.props.connectToParam || null;

    return this.flattenPointers(destinations).map((destination, destinationIndex) => {
      if (!destination) return null;

      if (toParam && !isAudioParam(destination[toParam])) {
        // e.g. connectToParam on a destination which has no such AudioParam
        if (this.context.debug) {
          console.warn(`Cannot connect to AudioParam "${toParam}" of`, destination); // eslint-disable-line no-console
        }
        return null;
      }

      const args = this.getConnectionArguments(
        destination,
        destinationIndex,
        toParam,
        this.props.connectFromChannel,
        this.props.connectToChannel);

      return {
        destination,
        target: args[0],
        param: toParam,
        output: toParam ? 0 : (args[1] === undefined ? 0 : args[1]),
        input: toParam ? undefined : (args[2] === undefined ? 0 : args[2])
      };
    }).filter(Boolean);
  }

  /**
   * Brings this node's outgoing connections in sync with its destinations.
   * Uses the connection registry, which only adds/removes edges that actually changed,
   * so connections to destinations which did not change are left untouched and
   * destinations which are no longer referenced are removed.
   *
   * @param      {function} destinationFunction The function that will return the destinations
   * @param      {AudioNode}  webAudioNode  The web audio node
   */
  connectToAllDestinations(destinationFunction, webAudioNode) {
    if (!webAudioNode || this.disposed) return;

    this.getRegistry().reconcile(
      this,
      webAudioNode,
      this.resolveConnectionSpecs(destinationFunction));
  }

  componentWillMount() {
    super.componentWillMount();
  }

  componentWillReceiveProps(nextProps) {
    this.updateParams(nextProps);
  }

  componentWillUpdate(nextProps, nextState) {
    // update the node's record in the node registry.
    // Only remove the old entry if it still points at this node - another
    // component may have taken over the identifier in the meantime.
    if (this.props.identifier !== nextProps.identifier) {
      if (this.context.nodes.get(this.props.identifier) === this.node) {
        this.context.nodes.delete(this.props.identifier);
      }
      this.context.nodes.set(nextProps.identifier, this.node);
    }
  }

  // we use DidUpdate to connect to new destinations,
  // because WillUpdate might get called before the new destinations are ready
  componentDidUpdate(prevProps, prevState) {
    // always reconcile: destinations, connectToParam, channel overrides and the
    // `disconnected` flag can all change the set of outgoing connections
    this.connectToAllDestinations(this.props.destination, this.node);
  }

  componentWillUnmount() {
    this.disposed = true;

    if (this.node) {
      const registry = this.getRegistry();
      // remove this node's outgoing connections and every incoming connection
      // pointing at this node (or at one of its AudioParams) so upstream nodes
      // never keep sending audio to a destroyed node
      registry.removeBySource(this.node);
      registry.removeByTarget(this.node);
    }

    // only remove the registry entry if it still belongs to this node
    if (this.context.nodes.get(this.props.identifier) === this.node) {
      this.context.nodes.delete(this.props.identifier);
    }
  }

  /**
   * Replaces the internal AudioNode instance (e.g. a scheduled source which
   * ended, or a media source whose input changed). Outgoing connections owned
   * by the old node are dropped, and incoming connections are re-pointed to
   * the new node so upstream nodes stay wired to the same place in the graph.
   *
   * @param      {function}  factory  a function returning the new AudioNode
   * @return     {AudioNode}  the new node
   */
  renewNode(factory) {
    const previous = this.node;
    const registry = this.getRegistry();

    if (previous) {
      // Retire the previous instance: drop its outgoing connections and detach
      // from it before stopping it, so a synchronous/queued `ended` event
      // cannot trigger another rebuild of the node we are about to create.
      registry.removeBySource(previous);

      if (typeof this.onEnded === 'function' && previous.removeEventListener) {
        previous.removeEventListener('ended', this.onEnded);
      }

      this.node = null;

      if (typeof previous.stop === 'function') {
        try {
          previous.stop(0);
        } catch (e) {
          // already stopped or not startable
        }
      }
    }

    this.node = factory();

    if (previous && previous !== this.node) {
      // incoming edges now point at the replacement
      registry.retarget(previous, this.node);
    }

    this.context.nodes.set(this.props.identifier, this.node);
    return this.node;
  }

  resolveTransitionProps(props, propName) {
    const transitionTime = typeof props.transitionTime === 'number'
      ? props.transitionTime
      : props.transitionTime ? props.transitionTime[propName] : null;

    const transitionCurve = typeof props.transitionCurve === 'string'
      ? props.transitionCurve
      : props.transitionCurve ? props.transitionCurve[propName] : null;

    return [ transitionTime, transitionCurve ];
  }

  // updates only Web Audio-related parameters
  // (both AudioParams and regular properties)
  updateParams(props) {
    if (!this.params || !this.node) return;

    for (let p in this.params) {
      if (!(p in props)) continue;

      const [ transitionTime, transitionCurve ] = this.resolveTransitionProps(props, p);

      if (isAudioParam(this.node[p])) {
        this.setParam(this.node[p], props[p], transitionTime, transitionCurve);
      } else if (this.node.parameters && this.node.parameters.has(p)) {
        let param = this.node.parameters.get(p);
        this.setParam(param, props[p], transitionTime, transitionCurve);
      } else if (p in this.node) {
        // some browsers (e.g. Chrome) will try to set channelCount and throw an error
        // since we can't use Object.getOwnPropertyDescriptor on the AudioNodes
        // we simply wrap the action in a try-catch
        try {
          if (this.node[p] !== props[p]) this.node[p] = props[p];
        } catch(e) {
          console.warn(`Tried setting ${p} on node`, this.node); // eslint-disable-line no-console
        }
      }
    }
  }

  setParam(param, value, transitionTime, transitionCurve) {
    if (transitionCurve) {
      const fn = `${transitionCurve}RampToValueAtTime`;
      // `exponentialRamp` doesn't seem to work on Firefox, so fall back to linear
      try {
        param[fn](value, transitionTime);
      } catch (e) {
        param['linearRampToValueAtTime'](value, transitionTime);
      }
    } else {
      param.setValueAtTime(value, transitionTime || this.context.audio.currentTime);
    }
  }

  componentDidMount() {
    this.connectToAllDestinations(this.props.destination, this.node);
  }

  render() {
    if (this.context.debug) {
      return (
        <li>
          <div>
            <strong>
              {this.constructor.name} <em>{this.props.name || ''}</em>
              <sup><mark>{this.props.disconnected && 'disconnected' || ''}</mark></sup>
            </strong>
            <div>{ this.props.connectToParam ? <span> connects to <em>{this.props.connectToParam}</em></span> : null }</div>
          </div>
          <ul>
            {
              Object.keys(this.params).map((p, pi) => {
                if (!this.props[p] && this.props[p] !== 0) return null;

                let param = this.props[p];
                if (typeof this.props[p] === 'boolean') param = this.props[p].toString();

                if (!(['number', 'string', 'boolean'].includes(typeof this.props[p]))) {
                  param = param.constructor.name;
                }

                return <li key={pi}>{p}: <code>{param}</code></li>;
              })
            }
          </ul>
        </li>
      );
    }

    return null;
  }
}
