//
// Local verification for the sound/tone lifecycle registry.
// Run with: npm test   (plain Node, no Meteor / Tone.js needed)
//
// Covers:
//  1. normal toggle        mute stops+disposes the synth and removes its
//                          param record; unmute rebuilds a fresh synth+record
//  2. eval failure         old synth keeps playing, old record untouched
//  3. rapid sequences      stale scheduled transport events can never start
//                          or stop a synth of a newer generation; no orphan
//                          records when a sound is deleted mid-flight
//  4. knob -> live synth   record vars are applied back to the live refs
//

const test = require('node:test')
const assert = require('node:assert')

const lifecycle = require('../imports/client/components/player/soundLifecycle.js')

//
// FAKES
//

// minimal stand-in for Tone.Transport: scheduleOnce / clear, plus a manual
// clock. Callbacks scheduled while running are also fired if already due
// (mirrors scheduling at a transport time that lies in the past).
function createFakeTransport() {
  let nextId = 1
  const events = []
  const clearedIds = []
  return {
    events, clearedIds,
    scheduleOnce(cb, time) {
      const id = nextId++
      events.push({ id, time, cb, cancelled: false, fired: false })
      return id
    },
    clear(id) {
      clearedIds.push(id)
      const e = events.find(e => e.id === id)
      if (e) e.cancelled = true
    },
    runUntil(time) {
      for (;;) {
        const due = events.filter(e => !e.cancelled && !e.fired && e.time <= time)
        if (!due.length) break
        due.forEach(e => { e.fired = true; e.cb(time) })
      }
    },
    pending() { return events.filter(e => !e.cancelled && !e.fired).length }
  }
}

function fakeSynth() {
  return {
    started: 0, stopped: 0, disposed: 0,
    start() { this.started++; return this },
    stop() { this.stopped++; return this },
    dispose() { this.disposed++; return this }
  }
}

function fakeDisposable() {
  return { disposed: 0, dispose() { this.disposed++ } }
}

// in-order record store standing in for the Meteor methods
// (tones.insert / tones.removeFromSoundId): Meteor preserves per-client
// method order, so the store applies operations in call order.
function createRecordStore() {
  const records = new Map() // soundId -> record
  const ops = []
  return {
    records, ops,
    persist(record) { ops.push(['insert', record.soundId]); records.set(record.soundId, record) },
    remove(soundId) { ops.push(['remove', soundId]); records.delete(soundId) }
  }
}

// programmable evalCode: map code -> 'ok' (fresh synth each call) or 'err'
function createEvalCode() {
  const synths = []
  const api = {
    synths,
    ok(code, vars) {
      return () => {
        const synth = fakeSynth()
        const el = fakeDisposable()
        synths.push(synth)
        return {
          status: 'ok',
          body: { c: synth, e: [el], o: { vars: vars || [['freq', { value: 0.5 }, 0, 1, 0.01, 0.5]] } }
        }
      }
    },
    err: { status: 'err', body: 'EDITOR SYNTAX ERROR => boom' }
  }
  return api
}

function createHarness(evalImpl) {
  const transport = createFakeTransport()
  const store = createRecordStore()
  const registry = lifecycle.createSoundRegistry({
    transport,
    evalCode: evalImpl,
    persistRecord: store.persist,
    removeRecord: store.remove
  })
  return { transport, store, registry }
}

const sound = (id, code, muted) => ({ _id: id, name: 'name-' + id, code, muted: !!muted })

//
// 1. NORMAL TOGGLE
//

test('normal toggle: add -> mute -> unmute rebuilds synth and record', () => {
  const ev = createEvalCode()
  const evalImpl = code => code === 'bad' ? ev.err : ev.ok(code)()
  const { transport, store, registry } = createHarness(evalImpl)

  // add: synth created, started on the transport, record persisted
  assert.strictEqual(registry.updateSound(sound('s1', 'good')).status, 'ok')
  assert.strictEqual(registry.tones.length, 1)
  transport.runUntil(1)
  assert.strictEqual(ev.synths[0].started, 1)
  assert.ok(store.records.has('s1'), 'param record persisted')
  assert.deepStrictEqual(store.records.get('s1').options.vars[0][1], { persistedValue: 0.5 })

  // mute: synth stopped+disposed, record removed, mixer no longer sees it
  assert.strictEqual(registry.updateSound(sound('s1', 'good', true)).status, 'ok')
  assert.strictEqual(registry.tones.length, 0)
  transport.runUntil(2)
  assert.strictEqual(ev.synths[0].stopped, 1)
  assert.strictEqual(ev.synths[0].disposed, 1)
  assert.ok(!store.records.has('s1'), 'param record removed on mute')

  // unmute: a NEW synth is generated and a fresh record written
  assert.strictEqual(registry.updateSound(sound('s1', 'good')).status, 'ok')
  assert.strictEqual(registry.tones.length, 1)
  assert.strictEqual(ev.synths.length, 2, 'a new synth was created')
  transport.runUntil(3)
  assert.strictEqual(ev.synths[1].started, 1)
  assert.strictEqual(ev.synths[1].stopped, 0)
  assert.ok(store.records.has('s1'), 'param record rewritten on unmute')
})

test('delete: synth released, record removed, transport event cleared', () => {
  const ev = createEvalCode()
  const evalImpl = code => ev.ok(code)()
  const { transport, store, registry } = createHarness(evalImpl)

  registry.updateSound(sound('s1', 'good'))
  transport.runUntil(1)
  registry.removeSound('s1')
  transport.runUntil(2)

  assert.strictEqual(registry.tones.length, 0)
  assert.strictEqual(ev.synths[0].stopped, 1)
  assert.strictEqual(ev.synths[0].disposed, 1)
  assert.ok(!store.records.has('s1'))
})

test('number tones (transport events) are cleared from the transport', () => {
  const transport = createFakeTransport()
  const store = createRecordStore()
  const registry = lifecycle.createSoundRegistry({
    transport,
    evalCode: () => ({ status: 'ok', body: { c: 42, e: [], o: {} } }), // 42 = event id
    persistRecord: store.persist,
    removeRecord: store.remove
  })

  registry.updateSound(sound('s1', 'good'))
  registry.removeSound('s1')

  assert.ok(transport.clearedIds.includes(42), 'transport event 42 was cleared')
})

//
// 2. EVAL FAILURE FALLBACK
//

test('eval failure keeps the old synth playing and the old record', () => {
  const ev = createEvalCode()
  const evalImpl = code => code === 'bad' ? ev.err : ev.ok(code, [['freq', { value: 0.5 }, 0, 1, 0.01, 0.5]])()
  const { transport, store, registry } = createHarness(evalImpl)

  registry.updateSound(sound('s1', 'good'))
  transport.runUntil(1)
  assert.strictEqual(ev.synths[0].started, 1)
  const recordBefore = store.records.get('s1')
  const opsBefore = store.ops.length

  // break the code: eval fails
  const result = registry.updateSound(sound('s1', 'bad'))
  assert.strictEqual(result.status, 'err')

  // old synth untouched, still registered, still the only synth
  assert.strictEqual(registry.tones.length, 1)
  assert.strictEqual(registry.tones[0].tone, ev.synths[0])
  assert.strictEqual(ev.synths.length, 1, 'no new synth created')
  transport.runUntil(3)
  assert.strictEqual(ev.synths[0].stopped, 0, 'old synth not stopped')
  assert.strictEqual(ev.synths[0].disposed, 0, 'old synth not disposed')

  // old record untouched: no remove/insert happened
  assert.strictEqual(store.ops.length, opsBefore, 'no record operations on eval failure')
  assert.strictEqual(store.records.get('s1'), recordBefore, 'old record kept')

  // fixing the code again swaps in a new synth normally
  assert.strictEqual(registry.updateSound(sound('s1', 'good')).status, 'ok')
  transport.runUntil(4)
  assert.strictEqual(ev.synths.length, 2)
  assert.strictEqual(ev.synths[0].stopped, 1, 'old synth retired after successful re-eval')
  assert.strictEqual(ev.synths[1].started, 1)
  assert.ok(store.records.has('s1'))
})

//
// 3. RAPID SEQUENCES / RACES
//

test('rapid mute/unmute/mute: no synth ever starts, nothing leaks', () => {
  const ev = createEvalCode()
  const evalImpl = code => ev.ok(code)()
  const { transport, store, registry } = createHarness(evalImpl)

  // all of this happens before the transport fires any scheduled event
  registry.updateSound(sound('s1', 'good'))        // start scheduled
  registry.updateSound(sound('s1', 'good', true))  // muted: cancel start, stop scheduled
  registry.updateSound(sound('s1', 'good'))        // unmuted: new synth, start scheduled
  registry.updateSound(sound('s1', 'good', true))  // muted again

  transport.runUntil(5)

  assert.strictEqual(registry.tones.length, 0)
  assert.strictEqual(ev.synths.length, 2)
  ev.synths.forEach((s, i) => {
    assert.strictEqual(s.started, 0, `synth ${i} never started (stale start cancelled)`)
    assert.strictEqual(s.disposed, 1, `synth ${i} disposed`)
  })
  assert.ok(!store.records.has('s1'), 'no record left behind')
  assert.strictEqual(transport.pending(), 0, 'no dangling scheduled events')
})

test('rapid code updates: only the newest synth starts, stale stops cannot kill it', () => {
  const ev = createEvalCode()
  const evalImpl = code => ev.ok(code)()
  const { transport, store, registry } = createHarness(evalImpl)

  registry.updateSound(sound('s1', 'v1'))
  registry.updateSound(sound('s1', 'v2'))
  registry.updateSound(sound('s1', 'v3'))

  transport.runUntil(5)

  assert.strictEqual(registry.tones.length, 1)
  assert.strictEqual(registry.tones[0].tone, ev.synths[2], 'only the newest generation is live')
  assert.strictEqual(ev.synths[0].started, 0)
  assert.strictEqual(ev.synths[1].started, 0)
  assert.strictEqual(ev.synths[2].started, 1, 'newest synth started')
  assert.strictEqual(ev.synths[2].stopped, 0, 'stale scheduled stops did not touch the new synth')
  assert.strictEqual(ev.synths[2].disposed, 0)
  assert.ok(store.records.has('s1'), 'one record for the sound')
})

test('stale stop scheduled in the past cannot stop the replacement synth', () => {
  const ev = createEvalCode()
  const evalImpl = code => ev.ok(code)()
  const { transport, store, registry } = createHarness(evalImpl)

  registry.updateSound(sound('s1', 'v1'))
  transport.runUntil(1) // synth v1 starts
  assert.strictEqual(ev.synths[0].started, 1)

  // code change: old synth retired (stop scheduled), new synth started
  registry.updateSound(sound('s1', 'v2'))
  transport.runUntil(2)

  assert.strictEqual(ev.synths[0].stopped, 1, 'old synth stopped')
  assert.strictEqual(ev.synths[0].disposed, 1, 'old synth disposed')
  assert.strictEqual(ev.synths[1].started, 1, 'new synth started')
  assert.strictEqual(ev.synths[1].stopped, 0, 'new synth NOT stopped by old schedule')
  assert.strictEqual(ev.synths[1].disposed, 0)
})

test('delete before the record write lands leaves no orphan record', () => {
  const ev = createEvalCode()
  const evalImpl = code => ev.ok(code)()
  const { transport, store, registry } = createHarness(evalImpl)

  registry.updateSound(sound('s1', 'good'))
  // sound deleted before the async persistence round-trips: the remove is
  // issued after the insert (Meteor preserves method order per client)
  registry.removeSound('s1')

  // updateSound first drops any previous record, then inserts the new one;
  // the delete appends a final remove, so the store converges to empty
  assert.deepStrictEqual(store.ops.map(o => o[0]), ['remove', 'insert', 'remove'])
  assert.ok(!store.records.has('s1'), 'store converges to no record')
  assert.strictEqual(registry.tones.length, 0)

  transport.runUntil(5)
  assert.strictEqual(ev.synths[0].disposed, 1)
  assert.strictEqual(transport.pending(), 0)
})

test('mute of a sound without live entry still cleans its record', () => {
  const ev = createEvalCode()
  const evalImpl = code => ev.ok(code)()
  const { store, registry } = createHarness(evalImpl)

  store.records.set('s1', { soundId: 's1', options: { vars: [] } }) // leftover
  registry.updateSound(sound('s1', 'good', true))

  assert.ok(!store.records.has('s1'), 'stale record removed')
})

//
// 4. KNOB -> LIVE SYNTH
//

test('record vars are applied back to live synth refs (knob moves)', () => {
  const paramLike = { value: 0.5 }              // Tone.Param-like
  const plainHolder = { pitchDecay: 0.1 }       // plain object w/ named prop
  const liveVars = [
    ['freq', paramLike, 0, 1, 0.01, 0.5],
    ['pitchDecay', plainHolder, 0, 0.5, 0.001, 0.1]
  ]

  const ev = createEvalCode()
  const evalImpl = code => {
    const synth = fakeSynth()
    return { status: 'ok', body: { c: synth, e: [], o: { vars: liveVars } } }
  }
  const { registry } = createHarness(evalImpl)
  registry.updateSound(sound('s1', 'good'))

  // mixer wrote new values into the persisted record
  const recordVars = [
    ['freq', { persistedValue: 0.9 }, 0, 1, 0.01, 0.5],
    ['pitchDecay', { persistedValue: 0.3 }, 0, 0.5, 0.001, 0.1]
  ]
  assert.strictEqual(registry.applyRecordVars('s1', recordVars), true)

  assert.strictEqual(paramLike.value, 0.9, 'Tone.Param-like .value updated')
  assert.strictEqual(plainHolder.pitchDecay, 0.3, 'named numeric prop updated')

  // unknown sound -> no-op
  assert.strictEqual(registry.applyRecordVars('nope', recordVars), false)
})

test('persisted record is sanitized (no live refs) and matches current options', () => {
  const paramLike = { value: 0.7 }
  const vars = [['freq', paramLike, 0, 1, 0.01, 0.7]]

  const evalImpl = code => ({ status: 'ok', body: { c: fakeSynth(), e: [], o: { vars } } })
  const { store, registry } = createHarness(evalImpl)
  registry.updateSound(sound('s1', 'good'))

  const record = store.records.get('s1')
  assert.deepStrictEqual(record.options.vars, [['freq', { persistedValue: 0.7 }, 0, 1, 0.01, 0.7]])
  assert.notStrictEqual(record.options.vars[0][1], paramLike, 'record does not hold the live ref')
})

test('init values are applied to the live synth before persisting', () => {
  const paramLike = { value: 0.1 }
  const vars = [['freq', paramLike, 0, 1, 0.01, 0.42]] // init = 0.42

  const evalImpl = code => ({ status: 'ok', body: { c: fakeSynth(), e: [], o: { vars } } })
  const { store, registry } = createHarness(evalImpl)
  registry.updateSound(sound('s1', 'good'))

  assert.strictEqual(paramLike.value, 0.42, 'init value applied to live ref')
  assert.strictEqual(store.records.get('s1').options.vars[0][1].persistedValue, 0.42)
})
