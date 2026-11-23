import React from 'react';
import RScheduledSource from './../base/scheduled-source.js';

export default class RBufferSource extends RScheduledSource {
  constructor(props) {
    super(props);

    this.params = {
      buffer: props.buffer || null,
      detune: props.detune || 0,
      loop: props.loop || false,
      loopStart: props.loopStart || 0,
      loopEnd: props.loopEnd || 0,
      playbackRate: props.playbackRate || 1
    };

    this.onEnded = this.onEnded.bind(this);
    this.instantiateNode = this.instantiateNode.bind(this);
  }

  /**
   * Creates the underlying AudioBufferSourceNode, or replaces it after it
   * ended (an AudioBufferSourceNode can only be started once). The latest
   * props are applied to the node and incoming connections are re-pointed
   * to the replacement.
   */
  instantiateNode(forceRebuild) {
    if (!this.node || forceRebuild) {
      this.renewNode(() => {
        const node = this.context.audio.createBufferSource();
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

  componentDidMount() {
    this.readyToPlay = !!this.props.buffer;
    // RScheduledSource.componentDidMount -> connected + schedule()
    super.componentDidMount();
  }

  shouldStartWithPropsChange(prevProps, currentProps) {
    return prevProps.buffer !== currentProps.buffer;
  }

  componentDidUpdate(prevProps, prevState) {
    this.readyToPlay = !!this.props.buffer;

    // An AudioBufferSourceNode cannot take a new buffer once it started, so
    // rebuild it when the buffer changes. `instantiateNode` applies the
    // latest params to the replacement, the connection registry re-points
    // incoming edges, and the scheduling step below re-schedules it using the
    // latest start/stop props.
    if (this.shouldStartWithPropsChange(prevProps, this.props) && this.playbackScheduled) {
      this.playbackScheduled = false;
      this.startTime = null;
      this.appliedStopTime = null;
      this.instantiateNode(true);
    }

    super.componentDidUpdate(prevProps, prevState);
  }
}
