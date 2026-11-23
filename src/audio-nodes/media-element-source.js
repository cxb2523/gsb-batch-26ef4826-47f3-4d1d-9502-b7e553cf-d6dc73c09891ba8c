import React from 'react';
import RAudioNode from './../base/audio-node.js';

export default class RMediaElementSource extends RAudioNode {
  constructor(props) {
    super(props);

    this.params = {};

    this.createNode = this.createNode.bind(this);
  }

  createNode() {
    if (this.node) {
      // the old node is retired: its outgoing connections are dropped and
      // incoming ones are re-pointed by `renewNode`
      this.renewNode(() => this.context.audio.createMediaElementSource(this.props.element));
      return;
    }

    this.node = this.context.audio.createMediaElementSource(this.props.element);
    this.context.nodes.set(this.props.identifier, this.node);
  }

  componentWillMount() {
    super.componentWillMount();

    if (!this.node) {
      this.createNode();
    }

    this.updateParams = this.updateParams.bind(this);
    this.updateParams(this.props);
  }

  componentWillReceiveProps(nextProps) {
    super.componentWillReceiveProps(nextProps);
    if (nextProps.element !== this.props.element) this.createNode();
  }
}
