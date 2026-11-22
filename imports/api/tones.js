import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';

import {each} from 'lodash';

import {Sounds} from './sounds';

export const Tones = new Mongo.Collection('tones');

if (!Meteor.isServer) return false

Meteor.publish('tones', () => Tones.find())

Meteor.methods({
  'tones.insert'(tone) {
    // orphan guard: the sound may have been deleted while this call was in
    // flight (methods from different clients are not ordered). Never persist
    // a param record for a sound that no longer exists.
    if (!Sounds.findOne(tone.soundId)) return false;

    // one record per sound: replace any previous record so the mixer never
    // shows stale knobs next to the fresh ones
    Tones.remove({soundId: tone.soundId});
    Tones.insert(tone);
  },

  'tones.removeFromSoundId'(soundId) {
    Tones.remove({soundId: soundId});
  },

  'tones.removeAll'() {
    Tones.remove({});
  },

  'tones.update'(tone) {
    Tones.update(tone._id, { $set: tone })
  }
});
