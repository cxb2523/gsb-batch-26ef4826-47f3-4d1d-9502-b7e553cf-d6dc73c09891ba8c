/**
 * Builds a small, valid SMF (format 1) MIDI file in-memory: one melodic track
 * plus a drum track on MIDI channel 10 (zero-based channel 9), so the v2
 * ChannelMapper routes percussion to the noise channels.
 *
 * Pure byte generation — no dependency on @tonejs/midi at write time.
 */

function writeVarLen(value) {
  let v = Math.max(0, Math.floor(value));
  const out = [v & 0x7f];
  while ((v >>= 7) > 0) {
    out.unshift((v & 0x7f) | 0x80);
  }
  return out;
}

function str(s) {
  return Array.from(s).map((c) => c.charCodeAt(0) & 0xff);
}

function u16(n) {
  return [(n >> 8) & 0xff, n & 0xff];
}

function u32(n) {
  return [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function chunk(id, data) {
  return [...str(id), ...u32(data.length), ...data];
}

/**
 * @param {object} opts
 * @param {number} opts.ppq ticks per quarter
 * @param {number} opts.bpm
 * @param {Array<{pitch:number, startTick:number, durationTicks:number, velocity:number}>} opts.melody
 * @param {Array<{pitch:number, startTick:number, durationTicks:number, velocity:number}>} opts.drums
 */
export function buildMidi({ ppq = 480, bpm = 120, melody = [], drums = [] }) {
  // Track 0: tempo map only.
  const tempoMpqn = Math.round(60000000 / bpm);
  const tempoTrack = chunk('MTrk', [
    0x00, 0xff, 0x51, 0x03,
    (tempoMpqn >> 16) & 0xff,
    (tempoMpqn >> 8) & 0xff,
    tempoMpqn & 0xff,
    0x00, 0xff, 0x2f, 0x00,
  ]);

  const noteTrack = (channel, notes) => {
    const events = [];
    for (const n of notes) {
      events.push({ tick: n.startTick, on: true, pitch: n.pitch, velocity: n.velocity });
      events.push({
        tick: n.startTick + Math.max(1, n.durationTicks),
        on: false,
        pitch: n.pitch,
        velocity: 0,
      });
    }
    events.sort((a, b) => (a.tick - b.tick) || (a.on ? 1 : -1));
    const data = [];
    let last = 0;
    for (const e of events) {
      data.push(...writeVarLen(e.tick - last));
      const status = (e.on ? 0x90 : 0x80) | (channel & 0x0f);
      data.push(status, e.pitch & 0x7f, e.velocity & 0x7f);
      last = e.tick;
    }
    data.push(0x00, 0xff, 0x2f, 0x00);
    return chunk('MTrk', data);
  };

  const melodyTrack = noteTrack(0, melody); // channel 1
  const drumTrack = noteTrack(9, drums); // channel 10 = drums

  const header = chunk('MThd', [
    ...u16(1), // format 1
    ...u16(3), // 3 tracks
    ...u16(ppq),
  ]);

  const bytes = [...header, ...tempoTrack, ...melodyTrack, ...drumTrack];
  return new Uint8Array(bytes).buffer;
}

/** A simple 8-bar groove: kick on beats 1/3, snare on 2/4, hats every eighth. */
export function buildDrumGrooveMidi({ bars = 2, ppq = 480, bpm = 120 } = {}) {
  const drums = [];
  const beat = ppq;
  const eighth = ppq / 2;
  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * 4 * beat;
    // Kick: beats 1 and 3 (MIDI 36)
    drums.push({ pitch: 36, startTick: barStart, durationTicks: eighth, velocity: 110 });
    drums.push({ pitch: 36, startTick: barStart + 2 * beat, durationTicks: eighth, velocity: 100 });
    // Snare: beats 2 and 4 (MIDI 38)
    drums.push({ pitch: 38, startTick: barStart + beat, durationTicks: eighth, velocity: 95 });
    drums.push({ pitch: 38, startTick: barStart + 3 * beat, durationTicks: eighth, velocity: 95 });
    // Hi-hat every eighth (MIDI 42 closed)
    for (let i = 0; i < 8; i++) {
      drums.push({
        pitch: 42,
        startTick: barStart + i * eighth,
        durationTicks: eighth / 2,
        velocity: 70,
      });
    }
  }

  // A simple bass line so the song isn't percussion-only.
  const melody = [];
  const roots = [36, 36, 43, 41]; // C C G F across bars
  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * 4 * beat;
    melody.push({
      pitch: roots[bar % roots.length],
      startTick: barStart,
      durationTicks: 2 * beat,
      velocity: 90,
    });
    melody.push({
      pitch: roots[bar % roots.length] + 7,
      startTick: barStart + 2 * beat,
      durationTicks: beat,
      velocity: 80,
    });
  }

  return buildMidi({ ppq, bpm, melody, drums });
}
