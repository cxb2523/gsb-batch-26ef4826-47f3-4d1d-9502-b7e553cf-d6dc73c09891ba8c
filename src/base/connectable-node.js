import React from 'react';
import RAudioNode from './audio-node.js';

/**
 * Any RAudioNode that can be connected to is a RConnectableNode
 *
 * @class      RConnectableNode (name)
 */
export default class RConnectableNode extends RAudioNode {
  componentWillUnmount() {
    // RAudioNode.componentWillUnmount removes every connection owned by this
    // node as well as every incoming connection recorded in the registry.
    super.componentWillUnmount();

    // `parent` is provided by graph components for nodes that could have been
    // connected to before the registry existed (or by custom connectables).
    // Keep the fallback, but make it precise: only remove the edge from the
    // parent to this node instead of disconnecting all of the parent's outputs.
    if (this.node && this.props.parent) {
      const parents = this.props.parent();

      this.flattenPointers(parents).forEach(parentPointer => {
        const parent = typeof parentPointer === 'symbol'
          ? this.context.nodes.get(parentPointer)
          : parentPointer;

        if (!parent || parent.disconnect !== 'function') return;

        try {
          parent.disconnect(this.node);
        } catch (e) {
          // there was no such connection - that is fine
        }
      });
    }
  }
}
