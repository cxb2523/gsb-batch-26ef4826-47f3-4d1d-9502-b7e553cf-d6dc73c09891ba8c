export default class EventEmitter {
  constructor() {
    this.callbacks = {};
  }

  offAll(eventName) {
    // When no event name is provided, every listener on the emitter is removed.
    // This is used when a Clip is disposed so that no stale listener can ever
    // observe events from it afterwards.
    if (eventName === undefined) {
      this.callbacks = {};
      return;
    }

    if (this.callbacks[eventName]) {
      this.callbacks[eventName] = [];
    }
  }

  off(eventName, cb) {
    const callbacks = this.callbacks[eventName];
    if (!callbacks) return;
    const index = callbacks.indexOf(cb);
    if (~index) callbacks.splice(index, 1);
  }

  on(eventName, cb) {
    const callbacks = this.callbacks[eventName] || (this.callbacks[eventName] = []);
    callbacks.push(cb);
    return {
      cancel: () => this.off(eventName, cb),
    };
  }

  once(eventName, cb) {
    const _cb = (data) => {
      cb(data);
      this.off(eventName, _cb);
    };
    return this.on(eventName, _cb);
  }

  _fire(eventName, data) {
    const callbacks = this.callbacks[eventName];
    if (!callbacks) return;
    callbacks.slice().forEach((cb) => cb(data));
  }
}
