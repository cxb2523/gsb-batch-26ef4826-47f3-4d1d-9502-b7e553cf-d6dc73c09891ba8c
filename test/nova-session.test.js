// Integration-level tests for the combat-session token that the evolved Frost
// Nova's delayed pulse is bound to. Constructing a real Game needs a DOM, so
// we install a tiny stub before dynamically importing `src/main.js` (imports
// are hoisted, hence the dynamic import). Everything else — the nova pulse
// itself — is exercised at the Weapon level in weapons.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal DOM / host shim: just enough surface for Game's constructor, the UI
// cache lookups, storage fallback and audio engine to no-op.
// ---------------------------------------------------------------------------
function makeEl(id) {
    return {
        id,
        width: 0,
        height: 0,
        style: { setProperty() {}, removeProperty() {} },
        innerHTML: '',
        textContent: '',
        dataset: {},
        children: [],
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        _listeners: {},
        addEventListener(ev, fn) {
            (this._listeners[ev] ||= []).push(fn);
        },
        removeEventListener() {},
        querySelector() {
            return null;
        },
        querySelectorAll() {
            return [];
        },
        appendChild() {},
        insertBefore() {},
        setAttribute() {},
        getAttribute() {
            return null;
        },
        focus() {},
        getContext() {
            return new Proxy(
                {},
                {
                    get: () => () => {}
                }
            );
        },
        getBoundingClientRect() {
            return { width: 0, height: 0, left: 0, top: 0 };
        }
    };
}

function installHostStubs() {
    const els = new Map();
    const getEl = (id) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
    };
    Object.defineProperty(globalThis, 'document', {
        value: {
            getElementById: getEl,
            createElement: (tag) => makeEl(`created-${tag}`),
            addEventListener() {},
            removeEventListener() {},
            body: makeEl('body'),
            documentElement: makeEl('html'),
            querySelector: () => null,
            querySelectorAll: () => [],
            hidden: false
        },
        configurable: true,
        writable: true
    });
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    Object.defineProperty(globalThis, 'window', {
        value: {
            addEventListener() {},
            removeEventListener() {},
            innerWidth: 1280,
            innerHeight: 800,
            matchMedia: () => ({ matches: false, addEventListener() {} }),
            localStorage: storage
        },
        configurable: true,
        writable: true
    });
    Object.defineProperty(globalThis, 'localStorage', {
        value: storage,
        configurable: true,
        writable: true
    });
    Object.defineProperty(globalThis, 'navigator', {
        value: { userAgent: 'node', vibrate() {} },
        configurable: true
    });
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    Object.defineProperty(globalThis, 'location', {
        value: { hostname: 'localhost' },
        configurable: true,
        writable: true
    });
}

installHostStubs();
const { Game } = await import('../src/main.js');
const { EffectLayer } = await import('../src/effects.js');

function newGame() {
    return new Game();
}

test('Game: start() opens a new combat session and clears the spatial index', () => {
    const g = newGame();
    const before = g.combatSessionId;
    g.spatial.insert({ x: 0, y: 0 }); // leftover from a prior fight
    g.start();
    assert.equal(g.combatSessionId, before + 1);
    assert.equal(g.spatial.size, 0, 'index must not describe the previous run');
});

test('Game: gameOver() ends the combat session (invalidates pending pulses)', () => {
    const g = newGame();
    g.start();
    g.save.settings.damageNumbers = false; // keep gameOver path quiet
    const during = g.combatSessionId;
    g.gameOver();
    assert.equal(g.combatSessionId, during + 1);
});

test('Game: a pulse scheduled by run A cannot damage run B after restart', () => {
    const g = newGame();
    g.start();

    // Run A: capture the session the pulse is bound to, exactly as _fireNova
    // does, and queue it in the real effect layer.
    const runA = g.combatSessionId;
    const runAEnemy = {
        x: 0,
        y: 0,
        hp: 100,
        hits: 0,
        takeDamage(d) {
            this.hp -= d;
            this.hits++;
        }
    };
    g.enemies = [runAEnemy];
    g.spatial.insertAll(g.enemies);
    let settled = 0;
    g.effects.schedule(0.4, () => {
        if (g.combatSessionId !== runA) return;
        settled++;
    });

    // Player dies / restarts before the 0.4s elapses.
    g.gameOver();
    g.start();
    const runBEnemy = {
        x: 0,
        y: 0,
        hp: 100,
        hits: 0,
        takeDamage(d) {
            this.hp -= d;
            this.hits++;
        }
    };
    g.enemies = [runBEnemy];
    g.spatial.insertAll(g.enemies);

    // Drive simulation time past the pulse deadline.
    for (let i = 0; i < 6; i++) g.effects.update(0.1);

    assert.equal(settled, 0, 'stale pulse must not settle against the new run');
    assert.equal(runBEnemy.hits, 0);
});

test('Game: start() clears the index so stale queries see nothing', () => {
    const g = newGame();
    const ghost = { x: 10, y: 10 };
    g.spatial.insert(ghost);
    g.start();
    assert.deepEqual(g.spatial.queryRect(0, 0, 1000), []);
});

test('EffectLayer still fires live-session pulses (sanity check)', () => {
    // Guard against the previous test passing merely because nothing fires.
    const fx = new EffectLayer();
    let fired = 0;
    fx.schedule(0.4, () => fired++);
    for (let i = 0; i < 6; i++) fx.update(0.1);
    assert.equal(fired, 1);
});
