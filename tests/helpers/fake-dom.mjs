// 极简 DOM 桩：只覆盖 src/movy-subtitle-layer.js 实际用到的 API。
// 目的是让字幕层可以在纯 Node 环境里被驱动，而不引入 jsdom 之类的额外依赖。

class ClassList {
  constructor(element) { this.element = element; this.set = new Set(); }
  add(...names) { for (const name of names) if (name) this.set.add(name); }
  remove(...names) { for (const name of names) this.set.delete(name); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : !!force;
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }
  toString() { return [...this.set].join(' '); }
}

export class FakeElement {
  constructor(tagName, doc) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.dataset = {};
    this.style = {
      _props: new Map(),
      setProperty(name, value) { this._props.set(name, String(value)); },
      getPropertyValue(name) { return this._props.get(name) || ''; },
    };
    this.classList = new ClassList(this);
    this._className = '';
    this._id = '';
    this._textContent = '';
    this._html = '';
    this._classes = new Map();
  }

  get id() { return this._id; }
  set id(value) { this._id = String(value); if (this.ownerDocument) this.ownerDocument._ids.set(this._id, this); }

  get className() { return this._className; }
  set className(value) {
    this._className = String(value || '');
    for (const name of this._className.split(/\s+/).filter(Boolean)) this.classList.add(name);
  }

  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = String(value == null ? '' : value); }

  get innerHTML() { return this._html; }
  set innerHTML(value) {
    this._html = String(value == null ? '' : value);
    this.children = [];
    this._classes.clear();
    const re = /class="([^"]+)"/g;
    let hit;
    while ((hit = re.exec(this._html))) {
      for (const token of hit[1].split(/\s+/).filter(Boolean)) {
        if (this._classes.has(token)) continue;
        const child = new FakeElement('div', this.ownerDocument);
        child.className = token;
        this.appendChild(child);
        this._classes.set(token, child);
      }
    }
  }

  appendChild(child) {
    if (!child) return child;
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, ref) {
    const index = ref ? this.children.indexOf(ref) : -1;
    child.parentElement = this;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    return child;
  }

  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    const set = this.listeners.get(type);
    if (set) set.delete(handler);
  }

  dispatch(type, event = {}) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const handler of [...set]) handler({ target: this, ...event });
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 320, bottom: 40, width: 320, height: 40 };
  }

  querySelector(selector) {
    return this._queryAll(String(selector))[0] || null;
  }

  matches(selector) {
    const text = String(selector || '').trim();
    if (!text) return false;
    if (text.startsWith('#')) return this.id === text.slice(1);
    if (text.startsWith('.')) return this.classList.contains(text.slice(1));
    const attr = text.match(/^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const key = attr[1].replace(/^data-/, '').replace(/-([a-z])/g, (all, ch) => ch.toUpperCase());
      const value = this.dataset[key];
      if (value === undefined) return false;
      return attr[2] === undefined || String(value) === attr[2];
    }
    return this.tagName === text.toUpperCase();
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (typeof node.matches === 'function' && node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    return this._queryAll(String(selector));
  }

  _queryAll(selector) {
    // 处理 "#a .b" 这种后代选择器
    if (selector.includes(' ')) {
      const [first, ...rest] = selector.split(/\s+/).filter(Boolean);
      const roots = this._queryAll(first);
      const out = [];
      for (const root of roots) out.push(...root._queryAll(rest.join(' ')));
      return out;
    }
    if (selector.startsWith('#')) {
      const id = selector.slice(1);
      return this._ids().get(id) === this ? [this] : (this.children.flatMap((child) => child._queryAll(selector)));
    }
    if (selector.startsWith('.')) {
      const name = selector.slice(1);
      if (this._classes.has(name)) return [this._classes.get(name)];
      if (this.classList.contains(name)) return [this];
      return this.children.flatMap((child) => child._queryAll(selector));
    }
    return this.children.flatMap((child) => child._queryAll(selector));
  }

  _ids() { return this.ownerDocument ? this.ownerDocument._ids : new Map(); }
}

export class FakeDocument {
  constructor() {
    this._ids = new Map();
    this.body = new FakeElement('body', this);
    this.listeners = new Map();
    this.fullscreenElement = null;
  }

  createElement(tag) { return new FakeElement(tag, this); }

  querySelector(selector) { return this.body.querySelector(selector); }

  querySelectorAll(selector) { return this.body.querySelectorAll(selector); }

  register(id, element) {
    element.id = id;
    this.body.appendChild(element);
    this._ids.set(id, element);
    return element;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    const set = this.listeners.get(type);
    if (set) set.delete(handler);
  }

  dispatch(type, event = {}) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const handler of [...set]) handler({ type, ...event });
  }
}

export function createFakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    clear() { map.clear(); },
    _map: map,
  };
}

export function createFakeWindow({ storage, document } = {}) {
  const timers = new Set();
  const intervals = new Set();
  const win = {
    localStorage: storage,
    document,
    innerWidth: 1280,
    innerHeight: 720,
    __cfSubReady: false,
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    setTimeout(handler, ms) {
      const id = setTimeout(() => { timers.delete(id); handler(); }, Math.min(Number(ms) || 0, 50));
      timers.add(id);
      return id;
    },
    clearTimeout(id) { timers.delete(id); clearTimeout(id); },
    setInterval(handler, ms) {
      const id = setInterval(handler, ms);
      intervals.add(id);
      // 测试中不希望后台 tick 干扰断言：立即停掉，仅保留 id 语义。
      clearInterval(id);
      return id;
    },
    clearInterval(id) { intervals.delete(id); clearInterval(id); },
    _clearAll() {
      for (const id of timers) clearTimeout(id);
      for (const id of intervals) clearInterval(id);
      timers.clear(); intervals.clear();
    },
  };
  return win;
}
