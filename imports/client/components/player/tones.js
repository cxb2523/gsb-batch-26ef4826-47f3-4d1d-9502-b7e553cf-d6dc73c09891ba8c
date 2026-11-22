import Tone from 'tone';
import { Meteor } from 'meteor/meteor'

import { Tones } from '/imports/api/tones';
import { find, get } from 'lodash';

import soundLifecycle from './soundLifecycle';

Meteor.subscribe('tones');

// apply the init value of each option var to the live synth refs
export let initTonesModifiers = soundLifecycle.applyInitValues

// if we have some vars inside the options that changed
// spread the change to the live tone inside window.tones to modify the sound
export let observeTones = () => {
  var handle = Tones.find().observeChanges({
    changed: function(id, field) {
      // read the fresh record: it may have been removed (sound muted/deleted
      // or re-evaluated) between the change and this callback
      let record = Tones.findOne(id)
      if (!record || !get(record, 'options.vars')) return

      let entry = find(window.tones, {soundId: record.soundId})
      if (!entry || !get(entry, 'options.vars')) return

      // indexes line up because records are built from the live vars
      soundLifecycle.applyRecordVars(entry.options.vars, record.options.vars)
    }
  })
  return handle
}
