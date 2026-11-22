//
// Pure sound/tone lifecycle registry.
//
// This module intentionally has NO Meteor / Tone.js / lodash imports so it can
// be unit-tested in plain Node (see tests/soundLifecycle.test.js). The
// Meteor-bound wiring lives in imports/client/components/player/sounds.js.
//
// Responsibilities:
//  - own the list of live tones (one entry per sounding sound)
//  - start/stop/dispose synths through an injected transport, tracking every
//    scheduled event so a stale scheduled callback can never start or stop a
//    synth that belongs to a newer generation of the same sound
//  - keep the persisted mixer param records in sync with the live tones:
//      * mute / delete          -> stop+dispose synth, cancel its scheduled
//                                  events, remove the persisted record
//      * successful (re)eval    -> retire the old synth, start the new one,
//                                  write a fresh record matching the new code
//      * failed eval            -> keep the old synth playing and the old
//                                  record untouched (no half-new state)
//
// CommonJS on purpose: Meteor (reify) can default-import it and plain Node can
// require() it from the test suite.
//

// transport time at which stop/dispose callbacks are scheduled (same as the
// original code: far enough to avoid clicks, near enough to feel immediate)
var STOP_TIME = 1
var START_TIME = 1

// current value of a live var tuple [name, ref, min, max, step, init]
// ref is either a Tone.Param-like object (numeric .value) or a plain object
// holding a numeric property named after the param (e.g. synth.pitchDecay)
function currentVarValue(v) {
  if (!v || v.length < 2 || v[1] == null) return undefined
  if (typeof v[1][v[0]] === 'number') return v[1][v[0]]
  return v[1].value
}

// apply the init value (v[5]) of each var to the live synth refs
function applyInitValues(vars) {
  vars.forEach(function (v) {
    if (!v || v[1] == null) return
    if (typeof v[5] === 'number') {
      if (typeof v[1][v[0]] === 'number') v[1][v[0]] = v[5]
      else v[1].value = v[5]
    }
  })
}

// drop vars whose live ref is null (they cannot be driven by the mixer).
// Done on the live entry itself so live vars and persisted record vars keep
// the same indexes (the mixer applies record vars back by index).
function pruneNullVars(entry) {
  if (!entry.options || !entry.options.vars) return
  entry.options.vars = entry.options.vars.filter(function (v) {
    if (v && v[1] != null) return true
    console.warn('the options ' + (v && v[0]) + ' is not interpreted as its value is null')
    return false
  })
}

// build the sanitized, serializable record persisted for the mixer screen.
// Never persist live Tone.js objects (circular refs, functions): only the
// current numeric value of each var, as persistedValue.
function buildRecord(entry) {
  if (!entry.options || !entry.options.vars || !entry.options.vars.length) return null
  var vars = entry.options.vars.map(function (v) {
    return [v[0], { persistedValue: currentVarValue(v) }, v[2], v[3], v[4], v[5]]
  })
  return { soundId: entry.soundId, name: entry.name, options: { vars: vars } }
}

// spread mixer (record) values back onto the live synth refs, by index
function applyRecordVars(liveVars, recordVars) {
  if (!liveVars || !recordVars) return
  recordVars.forEach(function (rv, i) {
    var live = liveVars[i]
    if (!live || !rv || live[1] == null || rv[1] == null) return
    var val = typeof rv[1].persistedValue === 'number' ? rv[1].persistedValue : rv[1][rv[0]]
    if (typeof val !== 'number') return
    if (typeof live[1][live[0]] === 'number') live[1][live[0]] = val
    else live[1].value = val
  })
}

// deps: {
//   transport:    { scheduleOnce(cb, time) -> id, clear(id) }  (Tone.Transport)
//   evalCode:     code -> {status:'ok', body:{c,e,o}} | {status:'err', body}
//   persistRecord: record -> void   (async ok, ordering must be preserved)
//   removeRecord:  soundId -> void  (async ok, ordering must be preserved)
// }
function createSoundRegistry(deps) {
  // the live tones. Mutated IN PLACE so aliases (e.g. window.tones) stay valid
  var tones = []

  // schedule a callback bound to an entry; a retired entry's pending
  // callbacks become no-ops and its event ids are cleared from the transport
  function schedule(entry, cb, time) {
    var id = deps.transport.scheduleOnce(function (t) {
      entry.scheduled = entry.scheduled.filter(function (x) { return x !== id })
      if (entry.cancelled) return
      cb(t)
    }, time)
    entry.scheduled.push(id)
    return id
  }

  function startEntry(entry) {
    // loop-type tones (objects) are started on the transport; number tones
    // are transport event ids already scheduled by the evaluated code itself
    if (entry.tone && typeof entry.tone === 'object') {
      schedule(entry, function () {
        try { entry.tone.start(0) } catch (e) { console.warn('error when start() :' + e.message) }
      }, START_TIME)
    }
  }

  // stop + release everything the entry owns. Pending starts are cancelled
  // first so a sound muted/updated in quick succession never resurrects.
  function retireEntry(entry) {
    entry.cancelled = true
    entry.scheduled.forEach(function (id) {
      try { deps.transport.clear(id) } catch (e) {}
    })
    entry.scheduled = []

    var tone = entry.tone
    if (typeof tone === 'number') {
      // transport event scheduled by the evaluated code: unschedule it
      try { deps.transport.clear(tone) } catch (e) {}
    } else if (tone && typeof tone === 'object') {
      // stop+dispose must ALWAYS run (it only touches the OLD synth objects),
      // so it is scheduled directly, not through the cancellable schedule()
      deps.transport.scheduleOnce(function () {
        try { tone.stop().dispose() } catch (e) { console.log('error when stop/dispose() :' + e.message) }
      }, STOP_TIME)
    }

    ;(entry.elementsToDispose || []).forEach(function (el) {
      if (el && typeof el.dispose === 'function') {
        deps.transport.scheduleOnce(function () {
          try { el.dispose() } catch (e) { console.log('error when dispose() :' + e.message) }
        }, STOP_TIME)
      }
    })
  }

  // stop the sound's synth (if any) and drop its persisted param record.
  // Safe to call for sounds that have no live entry (still cleans the record).
  function removeSound(soundId) {
    var removed = false
    for (var i = tones.length - 1; i >= 0; i--) {
      if (tones[i].soundId === soundId) {
        retireEntry(tones[i])
        tones.splice(i, 1)
        removed = true
      }
    }
    deps.removeRecord(soundId)
    return removed
  }

  // (re)evaluate a sound's code and (re)start its synth.
  // On eval failure the previous synth and record are left untouched.
  function updateSound(sound) {
    if (sound.muted) {
      removeSound(sound._id)
      return { status: 'ok' }
    }

    // evaluate FIRST: a failing eval must not tear down the sounding synth
    var result = deps.evalCode(sound.code)
    if (result.status === 'err') return result

    // eval succeeded: now it is safe to retire the previous generation
    removeSound(sound._id)

    var body = result.body
    var entry = {
      soundId: sound._id,
      name: sound.name,
      tone: body.c,
      elementsToDispose: body.e || [],
      options: body.o || {},
      scheduled: [],
      cancelled: false
    }
    tones.push(entry)

    pruneNullVars(entry)
    if (entry.options.vars) applyInitValues(entry.options.vars)

    startEntry(entry)

    var record = buildRecord(entry)
    if (record) deps.persistRecord(record)

    return { status: 'ok' }
  }

  return {
    tones: tones,
    updateSound: updateSound,
    removeSound: removeSound,
    find: function (soundId) {
      return tones.find(function (t) { return t.soundId === soundId })
    },
    applyRecordVars: function (soundId, recordVars) {
      var entry = tones.find(function (t) { return t.soundId === soundId })
      if (!entry || !entry.options || !entry.options.vars) return false
      applyRecordVars(entry.options.vars, recordVars)
      return true
    }
  }
}

module.exports = {
  createSoundRegistry: createSoundRegistry,
  buildRecord: buildRecord,
  applyRecordVars: applyRecordVars,
  applyInitValues: applyInitValues,
  currentVarValue: currentVarValue
}
