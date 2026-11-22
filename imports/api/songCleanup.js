//
// Pure helper for cleaning song documents from orphan sound references.
// CommonJS with no imports so it can be unit-tested in plain Node
// (see tests/songCleanup.test.js) and default-imported by Meteor.
//

// song: { sounds: [soundId...], selectedSound: soundId|false, ... }
// soundExists: soundId -> boolean
// returns the $set payload removing references to sounds that no longer exist
function cleanSongDoc(song, soundExists) {
  var sounds = (song.sounds || []).filter(function (sid) { return soundExists(sid) })

  var selectedSound = song.selectedSound
  if (selectedSound && !soundExists(selectedSound)) selectedSound = false

  return { sounds: sounds, selectedSound: selectedSound }
}

module.exports = { cleanSongDoc: cleanSongDoc }
