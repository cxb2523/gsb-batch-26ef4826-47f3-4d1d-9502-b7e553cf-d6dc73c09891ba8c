import Tone from 'tone';
import { Meteor } from 'meteor/meteor'

import { evalCode } from '../code/evalCode';
import soundLifecycle from './soundLifecycle';

// The registry owns the whole synth/param-record lifecycle:
//  - mute or delete  -> stop+dispose the synth, cancel its scheduled
//                       transport events, remove the persisted param record
//  - successful eval -> retire the old synth, start the new one, persist a
//                       fresh record matching the current code's options
//  - failed eval     -> old synth keeps playing, old record kept
const registry = soundLifecycle.createSoundRegistry({
  transport: Tone.Transport,
  evalCode: code => evalCode(code),
  persistRecord: record => Meteor.call('tones.insert', record),
  removeRecord: soundId => Meteor.call('tones.removeFromSoundId', soundId),
})

// live tones, mutated in place by the registry so this alias stays valid
// (read by observeTones in ./tones to apply mixer knob changes)
window.tones = registry.tones

// when a sound is created or its code/muted flag changes
export let updateSound = sound => registry.updateSound(sound)

// when a sound gets removed
export let removeSound = sound => registry.removeSound(sound._id)

export let tonesRegistry = registry
