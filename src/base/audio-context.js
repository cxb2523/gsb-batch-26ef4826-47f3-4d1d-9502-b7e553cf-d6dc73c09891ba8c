import React from 'react';
import PropTypes from 'prop-types';
import RComponent from './component.js';
import { getConnectionRegistry } from './connection-registry.js';

window.AudioContext = window.AudioContext || window.webkitAudioContext || null;
if (!window.AudioContext) {
  throw new Error(
    'Could not find AudioContext. This may be because your browser does not support Web Audio.');
}

/**
 * Contains and manages the Web Audio graph.
 * All immediate children connect directly to its Destination.
 *
 * @class      RAudioContext (name)
 */
export default class RAudioContext extends React.Component {
  constructor(props) {
    super(props);
    // repository of all nodes in the graph
    // keyed by Symbols
    this.nodes = new Map();

    this._context = new AudioContext(props.options);

    if (this.props.onInit) this.props.onInit(this._context);

    if (this.props.debug) {
      window.RAudioNodeMap = this.nodes;
      // exposes the connection registry (`.edges`) for inspection in the
      // debug UI and the browser lifecycle example
      window.RAudioConnections = getConnectionRegistry(this._context);
    }
  }

  componentWillMount() {
    this._context.resume();
  }

  getChildContext() {
    return {
      audio: this._context,
      debug: this.props.debug,
      nodes: this.nodes
    };
  }

  componentWillUnmount() {
    // Tear down every connection made through this context's registry so no
    // node keeps referencing a destroyed graph, then release the context.
    const registry = getConnectionRegistry(this._context);
    registry.reset();
    this.nodes.clear();
    this._context.suspend();
  }

  render() {
    const children = React.Children
      .toArray(this.props.children)
      .map(child => {
        if (!RComponent.isPrototypeOf(child.type)) return child;

        const audioContextProps = {
          destination: () => this._context.destination,
          identifier: Symbol(child.type.name)
        };

        return React.cloneElement(child, audioContextProps);
      });

    if (this.props.debug) {
      return (
        <div>
          <strong>RAudioContext</strong>
          <ul>
            {children}
          </ul>
        </div>
      );
    }

    return children || [];
  }
}

RAudioContext.childContextTypes = {
  audio: PropTypes.instanceOf(AudioContext),
  nodes: PropTypes.instanceOf(Map),
  debug: PropTypes.bool
};
