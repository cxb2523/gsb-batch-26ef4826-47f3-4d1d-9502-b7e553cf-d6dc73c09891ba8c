import React from 'react';
import RScheduledSource from './../base/scheduled-source.js';

export default class RConstantSource extends RScheduledSource {
  constructor(props) {
    super(props);

    this.params = {
      offset: props.offset
    };

    this.instantiateNode = this.instantiateNode.bind(this);
    this.readyToPlay = true;
    this.onEnded = this.onEnded.bind(this);
  }

  /**
   * Creates the underlying ConstantSourceNode, or replaces it after it ended
   * (a ConstantSourceNode can only be started once). Latest params are applied
   * and incoming connections are re-pointed to the replacement.
   */
  instantiateNode(forceRebuild) {
    if (!this.node || forceRebuild) {
      this.renewNode(() => {
        const node = this.context.audio.createConstantSource();
        node.addEventListener('ended', this.onEnded);
        return node;
      });
    }

    this.updateParams = this.updateParams.bind(this);
    this.updateParams(this.props);
  }

  componentWillMount() {
    super.componentWillMount();
    this.instantiateNode();
  }
}
