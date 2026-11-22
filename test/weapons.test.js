// Unit tests for the Weapon class. We import the real Weapon, then stub the
// minimal player/game scaffolding each scenario needs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Weapon } from '../src/weapons.js';
import { WEAPONS } from '../src/data.js';
import { CONFIG } from '../src/config.js';
import { EffectLayer } from '../src/effects.js';
import { SpatialHash } from '../src/spatial-hash.js';

// Minimal player that satisfies every getter Weapon touches.
function makePlayer({ crit = 0, dmgMult = 1, cdMult = 1, areaMult = 1 } = {}) {
    return {
        x: 0,
        y: 0,
        passives: {},
        getDamageMult: () => dmgMult,
        getCooldownMult: () => cdMult,
        getAreaMult: () => areaMult,
        getCritChance: () => crit,
        weapons: []
    };
}

// Minimal game that records floating-text calls.
function makeGame() {
    const texts = [];
    return {
        texts,
        createFloatingText(text, x, y, color, opts) {
            texts.push({ text, x, y, color, opts });
        },
        createParticles() {},
        audio: { shoot() {}, explosion() {} },
        projectiles: [],
        enemies: [],
        mines: []
    };
}

// Evolved Frost Nova: its delayed pulse is the thing under test here, so we
// drive time through a real EffectLayer instead of wall-clock timers.
function makeEvolvedNova() {
    const w = new Weapon(WEAPONS.FROST_NOVA);
    while (!w.isEvolved()) w.levelUp();
    return w;
}

// A game with a real EffectLayer + spatial index and a hand-managed roster.
function makeNovaGame(player, enemies) {
    const g = makeGame();
    g.player = player;
    g.enemies = enemies;
    g.effects = new EffectLayer();
    g.spatial = new SpatialHash(CONFIG.SPATIAL_CELL_SIZE);
    g.combatSessionId = 1;
    return g;
}

// Enemy stub: tracks every damage application so double-settles are visible.
function makeEnemy(x, y, hp = 1000, id = 'e') {
    return {
        x,
        y,
        id,
        hp,
        hits: [],
        takeDamage(d) {
            this.hp -= d;
            this.hits.push(d);
        }
    };
}

// Advance the effect delay queue until the nova's 0.4s pulse has fired.
function tickPulse(g, dt = 0.1, steps = 6) {
    for (let i = 0; i < steps; i++) g.effects.update(dt);
}

test('Weapon: starts at level 1', () => {
    const w = new Weapon(WEAPONS.WHIP);
    assert.equal(w.level, 1);
    assert.equal(w.id, 'whip');
});

test('Weapon: levelUp increments', () => {
    const w = new Weapon(WEAPONS.WHIP);
    w.levelUp();
    assert.equal(w.level, 2);
    w.levelUp();
    assert.equal(w.level, 3);
});

test('Weapon: isEvolved is false below evolveLevel', () => {
    const w = new Weapon(WEAPONS.WHIP);
    for (let i = 1; i < WEAPONS.WHIP.evolveLevel; i++) {
        assert.equal(w.isEvolved(), false, `lvl ${w.level}`);
        w.levelUp();
    }
});

test('Weapon: isEvolved becomes true at exactly evolveLevel', () => {
    const w = new Weapon(WEAPONS.WHIP);
    for (let i = 1; i < WEAPONS.WHIP.evolveLevel; i++) w.levelUp();
    assert.equal(w.level, WEAPONS.WHIP.evolveLevel);
    assert.equal(w.isEvolved(), true);
});

test('Weapon: isEvolved stays true past evolveLevel', () => {
    const w = new Weapon(WEAPONS.WHIP);
    for (let i = 1; i < 10; i++) w.levelUp();
    assert.equal(w.isEvolved(), true);
});

test('Weapon: isEvolved false when def has no evolveLevel', () => {
    const w = new Weapon({ id: 'no_evo', baseDamage: 1, baseCooldown: 1, baseRange: 1 });
    assert.equal(w.isEvolved(), false);
    w.level = 100;
    assert.equal(w.isEvolved(), false);
});

test('Weapon: damage scales +20% per level', () => {
    const w = new Weapon(WEAPONS.WHIP);
    const p = makePlayer();
    const lvl1 = w.getDamage(p);
    w.levelUp(); // level 2
    const lvl2 = w.getDamage(p);
    w.levelUp();
    w.levelUp();
    w.levelUp(); // level 5 (evolved)
    const lvl5 = w.getDamage(p);
    assert.ok(Math.abs(lvl2 / lvl1 - 1.2) < 1e-6);
    assert.ok(Math.abs(lvl5 / lvl1 - (1 + 4 * 0.2)) < 1e-6);
});

test('Weapon: damage multiplier from player is respected', () => {
    const w = new Weapon(WEAPONS.WHIP);
    const base = w.getDamage(makePlayer({ dmgMult: 1 }));
    const buffed = w.getDamage(makePlayer({ dmgMult: 2 }));
    assert.equal(buffed, base * 2);
});

test('Weapon: cooldown shrinks by 8% per level', () => {
    const w = new Weapon(WEAPONS.WHIP);
    const p = makePlayer();
    const cd1 = w.getCooldown(p);
    w.levelUp();
    const cd2 = w.getCooldown(p);
    assert.ok(cd2 < cd1);
    assert.ok(Math.abs(cd2 / cd1 - 0.92) < 1e-6);
});

test('Weapon: range grows +10% per level with areaMult', () => {
    const w = new Weapon(WEAPONS.WHIP);
    const r1 = w.getRange(makePlayer());
    w.levelUp();
    const r2 = w.getRange(makePlayer());
    assert.ok(Math.abs(r2 / r1 - 1.1) < 1e-6);
    // AreaMult stacks multiplicatively.
    const rBig = w.getRange(makePlayer({ areaMult: 2 }));
    assert.ok(Math.abs(rBig / r2 - 2) < 1e-6);
});

test('Weapon: crit chance 0 never produces a crit', () => {
    const w = new Weapon(WEAPONS.WHIP);
    const p = makePlayer({ crit: 0 });
    const g = makeGame();
    // Repeat so we'd catch any leakage.
    for (let i = 0; i < 200; i++) {
        const dmg = w._rollCrit(p, g, 100, 0, 0, '#fff');
        assert.equal(dmg, 100);
    }
    for (const t of g.texts) assert.notEqual(t.opts?.crit, true);
});

test('Weapon: crit chance 1 always produces a 2× crit', () => {
    const w = new Weapon(WEAPONS.WHIP);
    const p = makePlayer({ crit: 1 });
    const g = makeGame();
    for (let i = 0; i < 100; i++) {
        const dmg = w._rollCrit(p, g, 50, 0, 0, '#fff');
        assert.equal(dmg, 100);
    }
    for (const t of g.texts) assert.equal(t.opts?.crit, true);
});

test('Weapon: crit chance ~0.5 lands inside 30–70% band over 5000 rolls', () => {
    const w = new Weapon(WEAPONS.WHIP);
    const p = makePlayer({ crit: 0.5 });
    const g = makeGame();
    let crits = 0;
    for (let i = 0; i < 5000; i++) {
        const dmg = w._rollCrit(p, g, 100, 0, 0, '#fff');
        if (dmg === 200) crits++;
    }
    const ratio = crits / 5000;
    assert.ok(ratio > 0.3 && ratio < 0.7, `ratio=${ratio}`);
});

test('Weapon: orbit shard count starts at projectileCount and scales', () => {
    const w = new Weapon(WEAPONS.ORBIT);
    const p = makePlayer();
    assert.equal(w.getOrbitShardCount(p), WEAPONS.ORBIT.projectileCount);
    w.levelUp();
    w.levelUp(); // level 3 → +1 shard
    assert.equal(w.getOrbitShardCount(p), WEAPONS.ORBIT.projectileCount + 1);
});

test('Weapon: orbit shard count doubles after evolve', () => {
    const w = new Weapon(WEAPONS.ORBIT);
    for (let i = 1; i < WEAPONS.ORBIT.evolveLevel; i++) w.levelUp();
    assert.ok(w.isEvolved());
    const p = makePlayer();
    const count = w.getOrbitShardCount(p);
    assert.ok(count >= WEAPONS.ORBIT.projectileCount * 2);
});

test('Weapon: orbit shard count is clamped to 12', () => {
    const w = new Weapon(WEAPONS.ORBIT);
    for (let i = 0; i < 20; i++) w.levelUp();
    const p = makePlayer();
    p.passives = { cooldown: { count: 10, def: { effect: {} } } };
    assert.ok(w.getOrbitShardCount(p) <= 12);
});

test('Weapon: config WEAPON_MAX_LEVEL + evolveLevel agree on 5', () => {
    // Regression: make sure the CONFIG cap and the data.js evolveLevel don't
    // drift apart — the UI relies on them matching to show the evolve tag.
    assert.equal(CONFIG.WEAPON_MAX_LEVEL, 5);
    for (const w of Object.values(WEAPONS)) {
        if (w.evolveLevel) assert.equal(w.evolveLevel, 5, `weapon ${w.id}`);
    }
});

test('Weapon: nova fire applies damage + slow to nearby enemies', () => {
    const w = new Weapon(WEAPONS.FROST_NOVA);
    const p = makePlayer();
    const enemy = {
        x: 50,
        y: 0,
        hp: 100,
        takeDamage(d) {
            this.hp -= d;
        },
        slowTimer: 0,
        slowPct: 0
    };
    const farEnemy = {
        x: 9999,
        y: 0,
        hp: 100,
        takeDamage(d) {
            this.hp -= d;
        },
        slowTimer: 0,
        slowPct: 0
    };
    const g = makeGame();
    g.enemies = [enemy, farEnemy];
    g.player = p;
    g.createParticles = () => {};
    // Manually invoke via the dispatcher.
    w.fire(p, g);
    assert.ok(enemy.hp < 100, 'nearby enemy should be hit');
    assert.ok(enemy.slowTimer > 0, 'nearby enemy should be slowed');
    assert.equal(farEnemy.hp, 100, 'distant enemy should be untouched');
});

test('Weapon: drain heals the player via lifesteal', () => {
    const w = new Weapon(WEAPONS.SOUL_DRAIN);
    let healed = 0;
    const p = {
        ...makePlayer(),
        heal(n) {
            healed += n;
        }
    };
    const enemy = {
        x: 10,
        y: 0,
        hp: 200,
        takeDamage(d) {
            this.hp -= d;
        }
    };
    const g = makeGame();
    g.enemies = [enemy];
    g.player = p;
    w.fire(p, g);
    assert.ok(enemy.hp < 200, 'enemy took damage');
    assert.ok(healed > 0, 'player should have been healed by lifesteal');
});

test('Weapon: drain does nothing when no enemies in range', () => {
    const w = new Weapon(WEAPONS.SOUL_DRAIN);
    const p = {
        ...makePlayer(),
        heal() {
            throw new Error('should not heal without a target');
        }
    };
    const g = makeGame();
    g.enemies = [{ x: 99999, y: 0, hp: 100, takeDamage() {} }];
    g.player = p;
    assert.doesNotThrow(() => w.fire(p, g));
});

test('Weapon: boomerang projectile def has type=projectile + boomerang flag', () => {
    assert.equal(WEAPONS.BOOMERANG.type, 'projectile');
    assert.equal(WEAPONS.BOOMERANG.boomerang, true);
});

test('Weapon: getDamage returns 0 when baseDamage is 0', () => {
    const w = new Weapon({
        id: 'null',
        baseDamage: 0,
        baseCooldown: 1,
        baseRange: 100,
        type: 'projectile'
    });
    assert.equal(w.getDamage(makePlayer()), 0);
});

test('Weapon: getCooldown is strictly positive even at very high level', () => {
    const w = new Weapon(WEAPONS.WHIP);
    for (let i = 0; i < 50; i++) w.levelUp();
    assert.ok(w.getCooldown(makePlayer()) > 0);
});

test('Weapon: range with areaMult=0 still returns a finite number', () => {
    const w = new Weapon(WEAPONS.WHIP);
    const r = w.getRange(makePlayer({ areaMult: 0 }));
    assert.equal(r, 0);
});

test('Weapon: orbit shard damage scales with player damageMult', () => {
    const w = new Weapon(WEAPONS.ORBIT);
    const low = w.getDamage(makePlayer({ dmgMult: 1 }));
    const high = w.getDamage(makePlayer({ dmgMult: 3 }));
    assert.ok(Math.abs(high / low - 3) < 1e-6);
});

// ---------------------------------------------------------------------------
// Evolved Frost Nova — delayed second pulse. Covers the three regressions:
//   1. a pulse from a dead/finished run must not hit the next run's enemies;
//   2. the pulse settles against the *current* index, not the fire-time one;
//   3. the pulse damages each enemy exactly once, and never a removed one.
// ---------------------------------------------------------------------------
test('nova pulse: damages an in-range enemy once, at 60% of fire-time damage', () => {
    const w = makeEvolvedNova();
    const p = makePlayer();
    const e = makeEnemy(50, 0);
    const g = makeNovaGame(p, [e]);
    g.spatial.insertAll(g.enemies);

    const fireDmg = w.getDamage(p);
    w.fire(p, g);
    // First (immediate) burst already applied full damage.
    assert.deepEqual(e.hits, [fireDmg]);

    tickPulse(g);
    assert.equal(e.hits.length, 2, 'delayed pulse should land exactly once');
    assert.ok(Math.abs(e.hits[1] - fireDmg * 0.6) < 1e-9);
});

test('nova pulse: is discarded when the combat session changes (restart / death)', () => {
    const w = makeEvolvedNova();
    const p = makePlayer();
    const e = makeEnemy(50, 0);
    const g = makeNovaGame(p, [e]);
    g.spatial.insertAll(g.enemies);

    w.fire(p, g);
    const hitsAfterFire = e.hits.length;

    // Simulate the run ending: a new run bumps the session (main.js does this
    // in start()) and installs a fresh player + roster.
    const newPlayer = makePlayer();
    const newEnemy = makeEnemy(20, 0, 1000, 'next-run');
    g.combatSessionId++;
    g.player = newPlayer;
    g.enemies = [newEnemy];
    g.spatial.insertAll(g.enemies);

    tickPulse(g);
    assert.equal(newEnemy.hits.length, 0, 'old pulse must not touch the new session');
    assert.equal(e.hits.length, hitsAfterFire, 'old enemy took no extra damage');
});

test('nova pulse: is discarded if the firing player died during the delay', () => {
    const w = makeEvolvedNova();
    const p = makePlayer();
    const e = makeEnemy(50, 0);
    const g = makeNovaGame(p, [e]);
    g.spatial.insertAll(g.enemies);

    w.fire(p, g);
    const hitsAfterFire = e.hits.length;
    p.dead = true; // player dies before the 0.4s elapses

    tickPulse(g);
    assert.equal(e.hits.length, hitsAfterFire);
});

test('nova pulse: is discarded if the player object was swapped without a session bump', () => {
    // Defensive: a host that forgets to bump `combatSessionId` still must not
    // let the old pulse leak; identity of the live player is checked too.
    const w = makeEvolvedNova();
    const p = makePlayer();
    const e = makeEnemy(50, 0);
    const g = makeNovaGame(p, [e]);
    g.spatial.insertAll(g.enemies);

    w.fire(p, g);
    const hitsAfterFire = e.hits.length;
    g.player = makePlayer(); // swapped, session unchanged

    tickPulse(g);
    assert.equal(e.hits.length, hitsAfterFire);
});

test('nova pulse: settles against the current index (newly-arrived enemy is hit)', () => {
    const w = makeEvolvedNova();
    const p = makePlayer();
    const first = makeEnemy(50, 0, 1000, 'first');
    const g = makeNovaGame(p, [first]);
    g.spatial.insertAll(g.enemies);

    w.fire(p, g);

    // A fresh enemy walks into the ring during the 0.4s window and the index
    // is rebuilt — the pulse must see it.
    const late = makeEnemy(-40, 0, 1000, 'late');
    g.enemies.push(late);
    g.spatial.insertAll(g.enemies);

    tickPulse(g);
    assert.equal(late.hits.length, 1, 'late arrival should be caught by the pulse');
});

test('nova pulse: counts an enemy once even if it appears in multiple buckets', () => {
    const w = makeEvolvedNova();
    const p = makePlayer();
    const e = makeEnemy(30, 30, 1000, 'dup');
    const g = makeNovaGame(p, [e]);
    // Deliberately double-insert the same reference to model a stale index
    // that still holds an entry from before the owner moved.
    g.spatial.insert(e);
    g.spatial.insert(e);
    const fireDmg = w.getDamage(p);

    w.fire(p, g);
    const hitsAfterImmediate = e.hits.length;
    tickPulse(g);

    // The delayed pulse must add exactly one settle, and at 0.6× — the
    // duplicate bucket entry cannot make it hit twice.
    assert.equal(e.hits.length, hitsAfterImmediate + 1);
    assert.ok(Math.abs(e.hits[e.hits.length - 1] - fireDmg * 0.6) < 1e-9);
});

test('nova pulse: skips an enemy removed from the roster even if the index is stale', () => {
    const w = makeEvolvedNova();
    const p = makePlayer();
    const dead = makeEnemy(50, 0, 1000, 'dead');
    const alive = makeEnemy(-50, 0, 1000, 'alive');
    const g = makeNovaGame(p, [dead, alive]);
    g.spatial.insertAll(g.enemies);

    w.fire(p, g);
    const deadHitsAfterFire = dead.hits.length;

    // During the delay the first enemy is killed and spliced out of the
    // roster, but — simulating the reported bug — the index was not updated.
    dead.hp = 0;
    g.enemies = g.enemies.filter((x) => x !== dead);

    tickPulse(g);
    assert.equal(dead.hits.length, deadHitsAfterFire, 'removed enemy must not be hit');
    assert.equal(alive.hits.length, 2, 'surviving enemy still takes the pulse');
});

test('nova pulse: falls back to walking game.enemies when no index exists', () => {
    const w = makeEvolvedNova();
    const p = makePlayer();
    const e = makeEnemy(50, 0);
    const g = makeNovaGame(p, [e]);
    delete g.spatial; // no broad-phase index at all
    const fireDmg = w.getDamage(p);

    w.fire(p, g);
    tickPulse(g);

    assert.equal(e.hits.length, 2);
    assert.ok(Math.abs(e.hits[1] - fireDmg * 0.6) < 1e-9);
});

test('nova pulse: damage is the fire-time snapshot, ignoring later stat buffs', () => {
    const w = makeEvolvedNova();
    let dmgMult = 1;
    const p = makePlayer();
    // Rebind the player damage source so we can buff it after firing.
    p.getDamageMult = () => dmgMult;
    const e = makeEnemy(50, 0);
    const g = makeNovaGame(p, [e]);
    g.spatial.insertAll(g.enemies);

    const fireDmg = w.getDamage(p);
    w.fire(p, g);

    // Player picks up a damage passive during the delay.
    dmgMult = 5;

    tickPulse(g);
    assert.ok(
        Math.abs(e.hits[1] - fireDmg * 0.6) < 1e-9,
        `pulse should use captured ${fireDmg * 0.6}, got ${e.hits[1]}`
    );
});

test('nova pulse: only evolved nova schedules a follow-up', () => {
    const w = new Weapon(WEAPONS.FROST_NOVA); // level 1, not evolved
    assert.equal(w.isEvolved(), false);
    const p = makePlayer();
    const e = makeEnemy(50, 0);
    const g = makeNovaGame(p, [e]);
    g.spatial.insertAll(g.enemies);

    w.fire(p, g);
    assert.equal(g.effects.delays.length, 0, 'no delayed pulse before evolution');

    tickPulse(g);
    assert.equal(e.hits.length, 1, 'only the immediate burst lands');
});
