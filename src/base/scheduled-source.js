import React from 'react';
import RAudioNode from './audio-node.js';

/**
 * Any RAudioNode that can be scheduled to start/end is a RScheduledSource
 *
 * @class      RScheduledSource (name)
 */
export default class RScheduledSource extends RAudioNode {
  constructor(props) {
    super(props);
    this.readyToPlay = false;
    this.playbackScheduled = false;
    // AudioContext time at which the current underlying AudioNode was started
    this.startTime = null;
    // the stop time which has already been applied to the current AudioNode
    this.appliedStopTime = null;

    this.onEnded = this.onEnded.bind(this);
    this.schedule = this.schedule.bind(this);
  }

  onEnded(e) {
    // An `ended` notification from a node which was already replaced (e.g. by
    // a buffer change) must not trigger another rebuild.
    if (this.disposed || (e && e.target && e.target !== this.node)) return;

    this.playbackScheduled = false;
    this.startTime = null;
    this.appliedStopTime = null;

    // A scheduled source can only be started once, so Web Audio effectively
    // removes it from the graph after it ends. Re-create the underlying node,
    // apply the latest props to it (parameters are applied by
    // `instantiateNode`), put it back in the same place in the graph (the
    // connection registry re-points incoming edges) and re-apply the
    // start/stop schedule described by the latest props.
    this.instantiateNode(true);
    this.connectToAllDestinations(this.props.destination, this.node);
    this.schedule(true);

    if (this.props.onEnded) this.props.onEnded(e);
  }

  /**
   * Resolves the `start`/`stop`/`duration` props against the current
   * AudioContext time.
   *
   * `start` and `stop` are absolute AudioContext times, as in native Web
   * Audio, but a freshly built node cannot start in the past, so a past
   * start time is clamped to `currentTime`.
   *
   * When the node was just rebuilt after `ended` (`afterRebuild`), the
   * schedule described by the **latest** props is re-applied rather than the
   * one the retired node used:
   *  - a window whose stop time is still in the future is replayed from the
   *    current time and stops at the props' stop time;
   *  - otherwise a start time which still lies in the future is honoured
   *    exactly;
   *  - a fully elapsed window (start and stop both in the past) is not
   *    restarted: it has already played, and restarting it would make a
   *    completed one-shot source loop forever. The rebuilt node keeps the
   *    latest params and stays connected, so a later props update with a new
   *    window plays normally.
   */
  resolveScheduleTimes(afterRebuild = false) {
    const now = this.context.audio.currentTime;
    const { start, stop } = this.props;

    if (typeof start !== 'number') {
      return { startTime: null, stopTime: null };
    }

    const hasWindow = typeof stop === 'number' && stop > start;

    if (afterRebuild) {
      if (hasWindow && stop > now) {
        return { startTime: Math.max(start, now), stopTime: stop };
      }

      if (start > now) {
        return { startTime: start, stopTime: null };
      }

      return { startTime: null, stopTime: null };
    }

    return {
      startTime: Math.max(start, now),
      stopTime: hasWindow ? stop : null
    };
  }

  /**
   * Applies the start/stop schedule described by the current props.
   *
   * @param      {boolean}  afterRebuild  true when the node was just rebuilt
   *                                      after `ended`; the latest props are
   *                                      replayed relative to `currentTime`.
   */
  schedule(afterRebuild = false) {
    if (!this.node || this.disposed) return;

    const { startTime, stopTime } = this.resolveScheduleTimes(afterRebuild);

    if (startTime === null) return;

    const canStart =
      this.readyToPlay &&
      !this.playbackScheduled &&
      (stopTime === null || stopTime > startTime);

    if (canStart) {
      try {
        this.node.start(startTime, this.props.offset || 0, this.props.duration);
        this.playbackScheduled = true;
        this.startTime = startTime;
      } catch (e) {
        if (this.context.debug) console.warn('Could not start scheduled source', e); // eslint-disable-line no-console
        return;
      }
    }

    // stop() may be called again while the node is playing and replaces the
    // stop time, so only call it when the time actually changed.
    if (stopTime !== null && this.playbackScheduled && stopTime !== this.appliedStopTime) {
      try {
        this.node.stop(stopTime);
        this.appliedStopTime = stopTime;
      } catch (e) {
        if (this.context.debug) console.warn('Could not stop scheduled source', e); // eslint-disable-line no-console
      }
    }
  }

  /**
  Overriding this method enables sources to specify special conditions when playback should be rescheduled.
  e.g. BufferSource should be rescheduled if a new buffer is provided
  **/
  shouldStartWithPropsChange() {
    return false;
  }

  componentDidMount() {
    super.componentDidMount();
    this.schedule();
  }

  componentDidUpdate(prevProps, prevState) {
    super.componentDidUpdate(prevProps, prevState);

    if (prevProps.start !== this.props.start ||
        prevProps.stop !== this.props.stop ||
        prevProps.offset !== this.props.offset ||
        prevProps.duration !== this.props.duration ||
        this.shouldStartWithPropsChange(prevProps, this.props)) {
      this.schedule();
    }
  }
}
