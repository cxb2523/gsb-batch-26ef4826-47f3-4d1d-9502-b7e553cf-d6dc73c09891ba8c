import React from 'react';
import RScheduledSource from './../base/scheduled-source.js';

export default class ROscillator extends RScheduledSource {
  constructor(props) {
    super(props);

    // `periodicWave` is listed for the debug view only: it has no settable
    // AudioNode property (`updateParams` skips unknown properties) and is
    // applied explicitly in `instantiateNode`/`componentWillReceiveProps`.
    this.params = {
      frequency: props.frequency,
      detune: props.detune,
      type: props.type,
      periodicWave: props.periodicWave
    };

    this.instantiateNode = this.instantiateNode.bind(this);
    this.readyToPlay = true;
  }

  /**
   * Creates the underlying OscillatorNode, or replaces it after it ended.
   * Incoming connections are re-pointed to the replacement node.
   */
  instantiateNode(forceRebuild) {
    if (!this.node || forceRebuild) {
      this.renewNode(() => {
        const node = this.context.audio.createOscillator();
        node.addEventListener('ended', this.onEnded);

        if (this.props.periodicWave) {
          node.setPeriodicWave(this.props.periodicWave);
        }

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

  componentWillReceiveProps(nextProps) {
    super.componentWillReceiveProps(nextProps);

    // `periodicWave` has no AudioParam equivalent, so it has to be set
    // explicitly. (`type` is an AudioParam-like property handled by
    // `updateParams`.) A rebuilt node receives the latest wave in
    // `instantiateNode`, so only apply it to the live node here.
    if (this.props.periodicWave !== nextProps.periodicWave && nextProps.periodicWave) {
      try {
        this.node.setPeriodicWave(nextProps.periodicWave);
      } catch (e) {
        if (this.context.debug) console.warn('Could not set periodic wave', e); // eslint-disable-line no-console
      }
    }
  }
}
