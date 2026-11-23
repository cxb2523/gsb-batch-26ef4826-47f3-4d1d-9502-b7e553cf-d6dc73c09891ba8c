import React from 'react';

import {
  RAudioContext,
  RBiquadFilter,
  RDelay,
  RGain,
  ROscillator,
  RPipeline,
  RSplit,
  RStereoPanner
} from '../index.js';

const nodeName = (node, context) => {
  if (!node || !node.constructor) return String(node);
  if (node === context.destination) return 'destination';
  return node.constructor.name;
};

/**
 * Connection lifecycle demo.
 *
 * Everything the library promises about the AudioNode lifecycle can be
 * observed here without leaving the page:
 *  - inserting/removing `children` re-wires the neighbours without leaving
 *    duplicate or stale connections ("insert a filter", "mount tail branch");
 *  - routing into a second gain (`destination` change) moves the output and
 *    drops the old edge;
 *  - a scheduled source (`ROscillator` with `start`/`stop`) which finishes is
 *    rebuilt with the current `frequency`/`type`/`detune` and re-scheduled
 *    from the latest `start`/`stop` props;
 *  - unmounting a branch removes the connections of its upstream neighbours,
 *    so nothing keeps feeding a destroyed node.
 *
 * The connection list below is read from `window.RAudioConnections` (the
 * registry the library uses to reconcile edges, exposed when `debug` is on),
 * so it reflects the real AudioNode graph rather than the JSX.
 */
export default class LifecycleExample extends React.Component {
  constructor() {
    super();

    this.state = {
      frequency: 440,
      type: 'triangle',
      gain: 1,
      stop: 2,
      start: 0,
      withFilter: true,
      rerouteToSecondGain: false,
      showTail: true,
      lastEnded: '–'
    };

    this.audioContext = null;

    this.set = key => event => {
      const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
      this.setState({ [key]: value });
    };

    this.restart = () => {
      if (!this.audioContext) return;
      const now = this.audioContext.currentTime;
      // `start` is an absolute AudioContext time, like in native Web Audio
      this.setState({ start: now, stop: now + 2 });
    };

    this.onOscillatorEnded = () => {
      this.setState({ lastEnded: new Date().toLocaleTimeString() });
    };
  }

  componentDidMount() {
    // keep the connection list in sync with the AudioContext clock while the
    // graph is being rebuilt in the background
    this.timer = setInterval(() => this.forceUpdate(), 500);
  }

  componentWillUnmount() {
    clearInterval(this.timer);
  }

  describeConnections() {
    if (!this.audioContext || !window.RAudioConnections) return [];

    const registry = window.RAudioConnections;

    return registry.edges.map(edge => {
      const target = edge.param
        ? `${nodeName(edge.destination, this.audioContext)}.${edge.param}`
        : nodeName(edge.destination, this.audioContext);

      return `${nodeName(edge.source, this.audioContext)} -> ${target}`;
    });
  }

  render() {
    const {
      frequency, type, gain, start, stop,
      withFilter, rerouteToSecondGain, showTail, lastEnded
    } = this.state;

    const connections = this.describeConnections();

    return (
      <RAudioContext debug={true} onInit={ctx => this.audioContext = ctx}>
        <article>
          <h1>Connection lifecycle</h1>
          <p>
            Re-render the graph with the controls below. <code>RPipeline</code>,
            <code>RSplit</code> and the destination getters they pass down all
            change, and the connection list reflects the real AudioNode graph.
          </p>
          <p>
            <label>
              Frequency&nbsp;
              <input type="range" min="100" max="1000" step="10"
                value={frequency} onChange={this.set('frequency')}/>
              &nbsp;<code>{Number(frequency).toFixed(0)} Hz</code>
            </label>
          </p>
          <p>
            <label>
              Waveform&nbsp;
              <select value={type} onChange={this.set('type')}>
                <option value="sine">sine</option>
                <option value="square">square</option>
                <option value="triangle">triangle</option>
                <option value="sawtooth">sawtooth</option>
              </select>
            </label>
          </p>
          <p>
            <label>
              Stop time&nbsp;
              <input type="number" min="0" max="5" step="0.1"
                value={stop} onChange={this.set('stop')}/>
            </label>
            &nbsp;
            <button onClick={this.restart}>Restart the 2 second window from now</button>
            <br/>
            <small>
              When the oscillator finishes it is rebuilt and re-scheduled from the
              latest props. Last <code>ended</code>: {lastEnded}
            </small>
          </p>
          <p>
            <label>
              <input type="checkbox" checked={withFilter} onChange={this.set('withFilter')}/>
              &nbsp;insert an <code>RBiquadFilter</code> in the chain (children change)
            </label>
          </p>
          <p>
            <label>
              <input type="checkbox" checked={rerouteToSecondGain}
                onChange={this.set('rerouteToSecondGain')}/>
              &nbsp;route into a second <code>RGain</code> (destination change)
            </label>
          </p>
          <p>
            <label>
              <input type="checkbox" checked={showTail} onChange={this.set('showTail')}/>
              &nbsp;mount the tail branch (unmounting removes its upstream edges)
            </label>
          </p>

          <p>
            <strong>Connections ({connections.length}):</strong>
            <ul>
              {connections.map((edge, index) => (
                <li key={index}><code>{edge}</code></li>
              ))}
            </ul>
          </p>
        </article>

        <RPipeline>
          <ROscillator
            key="carrier"
            start={Number(start)}
            stop={Number(stop)}
            frequency={Number(frequency)}
            type={type}
            detune={0}
            onEnded={this.onOscillatorEnded}/>

          {withFilter ? <RBiquadFilter key="filter" frequency={800} Q={1} type="lowpass"/> : null}

          <RGain key="main" gain={Number(gain)}/>

          {rerouteToSecondGain ? <RGain key="alt" gain={Number(gain) * 0.5}/> : null}

          <RSplit>
            <RGain gain={0.5} key="branches-a"/>
            <RStereoPanner pan={-0.5} key="branches-b"/>
            {
              showTail
                ? (
                  <RPipeline key="tail">
                    <RDelay delayTime={0.1}/>
                    <RGain gain={0.4}/>
                  </RPipeline>
                )
                : null
            }
          </RSplit>
        </RPipeline>
      </RAudioContext>
    );
  }
}
