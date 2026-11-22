/**
 * The sound life of one race: what the driver does when a race starts, pauses, ends and the next one
 * begins. The real DRIVER1.BIN is not in the repository and never will be, so these run against a driver
 * image built here: the same tables at the same offsets the port reads (song bank, sound bank, instrument
 * records, the four engine records, the silence list), with a two-song bank and a handful of short effects.
 *
 * Two facts about the driver decide every one of these tests:
 *  - ah=6 / ah=7 only set a flag. Fn 021a honours it at the start of the next tick, so a test that asked
 *    for a stop and looked at the chip without ticking would be testing nothing.
 *  - An engine note is one note held down and re-bent; fn 0294 never keys it off between notes. So a pause
 *    cannot just clear flags: the note has to be released, and on resume the game writes the pitch the car
 *    has then, not the one it had when Space went down.
 */
import { describe, it, expect } from 'vitest';
import { SoundDriver, type OplSink } from '../../src/engine/sound/driver';
import { OPL2, OPL_RATE } from '../../src/engine/sound/opl2';
import type { SoundPort } from '../../src/engine/sound/port';
import { playSoundCalls } from '../../src/engine/sound/port';
import { Race } from '../../src/engine/race';
import { DataSegment } from '../../src/engine/memory';

const TICK_RATE = 70.086;

/** Registers 0xa0/0xb0 of the OPL channel the driver picked for an engine record. */
function writesBetween(log: Log, from: number): [number, number][] { return log.writes.slice(from); }

class Log implements OplSink {
  readonly writes: [number, number][] = [];
  write(reg: number, value: number): void { this.writes.push([reg, value]); }
  from(at: number): [number, number][] { return this.writes.slice(at); }
}

/** The chip, with everything written to it also recorded. */
class ChipLog extends OPL2 implements OplSink {
  readonly writes: [number, number][] = [];
  override write(reg: number, value: number): void { this.writes.push([reg, value]); super.write(reg, value); }
  from(at: number): [number, number][] { return this.writes.slice(at); }
}

/**
 * A driver image just big enough to be the real one: every table the port reads at its documented offset.
 *
 *  0008  4 engine records (instrument 0x70, one note, a bend the game rewrites, a loop)
 *  09d3  key-scale block table
 *  0a38  the one-octave F-number table
 *  1038  channel -> operator pair (the chip's own numbering)
 *  104a  the silence list: quiet every operator, then 0000
 *  10cc  loudness -> attenuation table (all zero, so every note is at full scale)
 *  114d  the register shadow, as the real driver ships it: all 0xff
 *  124d  the empty sequence 0x9a jumps to
 *  1254  PIT ticks per game tick, as fn 321c's ah=2 leaves it
 *  1271  the sixteen channel records
 *  13d1  the two eight-slot request queues
 *  13f0  the three pointers
 *  13f6  the note table (128 bytes) and the instrument records
 *  1d00  the sound bank: three short effects
 *  1e00  the song bank: two looping songs, two tracks and one track
 */
function driverImage(): Uint8Array {
  const m = new Uint8Array(0x2200);
  const w8 = (at: number, v: number): void => { m[at] = v & 0xFF; };
  const w16 = (at: number, v: number): void => { m[at] = v & 0xFF; m[at + 1] = (v >> 8) & 0xFF; };

  // the engine records: instrument, loop point, note, then the bend and the loop the game rewrites
  const record = [0x00, 0x92, 0x70, 0x00, 0x9C, 0x00, 0x23, 0x7F, 0x01, 0x95, 0x30, 0x00, 0x98, 0x00, 0x00, 0x00];
  for (let car = 0; car < 4; car++) record.forEach((b, i) => w8(0x0008 + car * 0x10 + i, b));

  // channel -> operator pair, in the chip's numbering
  const ops = [[0, 3], [1, 4], [2, 5], [8, 11], [9, 12], [10, 13], [16, 19], [17, 20], [18, 21]] as const;
  ops.forEach(([a, b], i) => w16(0x1038 + i * 2, a | (b << 8)));

  for (let i = 0; i < 0x300; i++) w16(0x0A38 + i * 2, 0x200 + ((i * 2) & 0x7FF));

  let at = 0x104A;
  const pair = (reg: number, value: number): void => { w8(at++, reg); w8(at++, value); };
  pair(0x01, 0x20); pair(0xBD, 0x00); pair(0x08, 0x00);
  for (let chan = 0; chan < 9; chan++) pair(0xB0 + chan, 0x00);   // key every channel off
  for (let op = 0; op < 0x16; op++) { pair(0x40 + op, 0x3F); pair(0x60 + op, 0xFF); pair(0x80 + op, 0xFF); }
  pair(0, 0);

  m.fill(0xFF, 0x114D, 0x114D + 0x100);                    // the shadow the driver ships
  w8(0x124D, 0x00); w8(0x124E, 0x91);                      // the empty sequence: one delta, one end
  w16(0x1254, 0x4287);                                     // what fn 321c's ah=2 hands the driver

  // instrument records, after the 128-byte note table
  const records = 0x13F6 + 0x80;
  const instrument = (n: number): void => {
    const r = records + n * 0x10;
    [0xF0, 0xF0, 0x0F, 0x0F, 0x01, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02]
      .forEach((b, i) => w8(r + i, b));
  };
  instrument(1); instrument(0x70);
  w16(0x13F4, 0x13F6);                                     // -> note table, then the records

  // the sound bank: count, offsets, then three short effects that stay up for a while
  const bank = 0x1D00;
  w8(bank, 3);
  const sound = (n: number, body: number[]): void => {
    const rel = 0x10 + (n - 1) * 0x18;
    w16(bank + 1 + (n - 1) * 2, rel);
    body.forEach((b, i) => w8(bank + rel + i, b));
  };
  // instrument, note, velocity, a long wait, end
  sound(1, [0x00, 0x92, 0x01, 0x00, 0x23, 0x64, 0x7F, 0x91]);
  sound(2, [0x00, 0x92, 0x01, 0x00, 0x30, 0x64, 0x7F, 0x91]);
  sound(3, [0x00, 0x92, 0x01, 0x00, 0x28, 0x64, 0x7F, 0x91]);
  w16(0x13F2, bank);

  // the song bank: two songs, both looping, the first on two channels and the second on one
  const songs = 0x1E00;
  w8(songs, 2);
  w16(songs + 1, 5);                                       // header table at bank+5
  w16(songs + 5, 9); w16(songs + 7, 40);                   // the two headers, relative to the bank
  const header = (rel: number, tracks: number, trackRels: number[]): void => {
    w16(songs + rel, 0xC8C8);                              // tempo: bytes 0xc8 * 0xc8
    w8(songs + rel + 2, tracks);
    trackRels.forEach((t, i) => w16(songs + rel + 3 + i * 2, t));
  };
  header(9, 2, [20, 30]);
  header(40, 1, [44]);
  const track = (rel: number, chan: number, note: number): void => {
    // delta 0, use channel, loop point, delta 0, note+velocity, delta 0x40, loop
    [0x00, 0x80 | chan, 0x00, 0x9C, 0x00, note, 0x64, 0x40, 0x98].forEach((b, i) => w8(songs + rel + i, b));
  };
  track(20, 0, 0x30); track(30, 1, 0x28); track(44, 2, 0x36);
  w16(0x13F0, songs);

  return m;
}

/** A SoundPort over the driver, as SoundOutput is over the driver plus Web Audio. */
class DriverPort implements SoundPort {
  constructor(private readonly drv: SoundDriver) {}
  setSong(n: number): void { this.drv.setSong(n); }
  songPlaying(n: number): boolean { return this.drv.songPlaying(n); }
  play(n: number, music = false): void { this.drv.play(n, music); }
  isPlaying(n: number): boolean { return this.drv.isPlaying(n); }
  stopAll(): void { this.drv.stopAll(); }
  stopVoices(): void { this.drv.stopVoices(); }
  engine(car: number, pitch: number, running: boolean): void { this.drv.engine(car, pitch, running); }
  suspend(): void { this.drv.suspend(); }
  resume(): void { this.drv.resume(); }
  beginRace(): void { this.drv.beginRace(); }
  endRace(): void { this.drv.endRace(); }
}

/** Renders `ticks` driver ticks of OPL output, at the driver's own tick rate. */
function render(opl: OPL2, drv: SoundDriver, ticks: number, chunk = new Float32Array(Math.round(OPL_RATE / TICK_RATE))): number {
  let peak = 0;
  for (let t = 0; t < ticks; t++) {
    drv.tick();
    opl.render(chunk);
    for (const v of chunk) peak = Math.max(peak, Math.abs(v));
  }
  return peak;
}

describe('one race of sound', () => {
  it('honours ah=6 at the next tick, not when it is asked for', () => {
    const opl = new ChipLog();
    const drv = new SoundDriver(driverImage(), opl);
    drv.init();
    drv.play(1);
    expect(render(opl, drv, 1)).toBeGreaterThan(0.01);       // the queue gave it a channel and it sounds
    expect(drv.isPlaying(1)).toBe(true);
    expect(drv.playingVoices).toBe(1);

    const before = opl.writes.length;
    drv.stopAll();
    // nothing yet: the driver's next tick has not run, the note is still on its channel, and the chip keeps
    // making the noise it was making
    expect(drv.isPlaying(1)).toBe(true);
    expect(drv.playingVoices).toBe(1);
    expect(opl.writes.length).toBe(before);
    const tail = new Float32Array(Math.round(OPL_RATE / TICK_RATE / 2));
    opl.render(tail);
    expect(Math.max(...tail.map(Math.abs))).toBeGreaterThan(0.01);

    drv.tick();
    expect(drv.isPlaying(1)).toBe(false);
    expect(drv.playingVoices).toBe(0);
    expect(opl.writes.length).toBeGreaterThan(before);       // the silence list went out
    render(opl, drv, 1);                                     // the release tail
    expect(render(opl, drv, 2)).toBe(0);                     // and the chip really is quiet
  });

  it('ah=7 stops the song tracks and leaves the effects queue playing', () => {
    const drv = new SoundDriver(driverImage(), new Log());
    drv.init();
    drv.setSong(1);
    drv.tick();
    drv.play(1);
    drv.tick();
    expect(drv.songPlaying(1)).toBe(true);
    expect(drv.playingVoices).toBe(3);                       // two song tracks and the effect

    drv.stopVoices();
    expect(drv.playingVoices).toBe(3);                       // deferred, like ah=6
    drv.tick();
    expect(drv.songPlaying(1)).toBe(false);
    expect(drv.isPlaying(1)).toBe(true);                     // the effect was never the song's to stop
    expect(drv.playingVoices).toBe(1);
  });

  it('holds the sequencer through a pause and resumes on the pitch the car has now', () => {
    const opl = new ChipLog();
    const log = opl;
    const drv = new SoundDriver(driverImage(), opl);
    drv.init();
    log.writes.length = 0;                                   // the reset is not what this is about

    drv.engine(0, 0x30, true);                               // a car doing about 480
    expect(render(opl, drv, 6)).toBeGreaterThan(0.01);       // it is making a noise
    expect(drv.isPlaying(0x40)).toBe(true);
    const oldA0 = log.from(0).filter(([r]) => r >= 0xA0 && r < 0xA9).map(([, v]) => v);
    expect(oldA0.length).toBeGreaterThan(0);

    drv.suspend();
    drv.tick();                                              // the pause lands on the tick boundary
    expect(drv.paused).toBe(true);
    expect(drv.isPlaying(0x40)).toBe(false);                 // the held note was released
    expect(drv.playingVoices).toBe(0);

    render(opl, drv, 1);                                     // the release tail
    expect(render(opl, drv, 4)).toBe(0);                     // then the chip is silent

    const held = log.writes.length;
    render(opl, drv, 20);                                    // a held sequencer does not move
    expect(log.writes.length).toBe(held);
    expect(render(opl, drv, 1)).toBe(0);

    // resume and let the game write the new speed: the engine note is started again from scratch
    drv.resume();
    expect(drv.paused).toBe(false);
    expect(drv.isPlaying(0x40)).toBe(false);
    drv.engine(0, 0x60, true);
    expect(render(opl, drv, 4)).toBeGreaterThan(0.01);
    expect(drv.isPlaying(0x40)).toBe(true);
    const newA0 = log.from(held + 1).filter(([r]) => r >= 0xA0 && r < 0xA9).map(([, v]) => v);
    expect(newA0.length).toBeGreaterThan(0);
    expect(newA0).not.toEqual(oldA0);

    // the same note started on a fresh driver, one that never heard the old pitch, writes the same bytes
    const fresh = new ChipLog();
    const freshDrv = new SoundDriver(driverImage(), fresh);
    freshDrv.init();
    fresh.writes.length = 0;
    freshDrv.engine(0, 0x60, true);
    for (let t = 0; t < 4; t++) freshDrv.tick();
    const freshA0 = fresh.from(0).filter(([r]) => r >= 0xA0 && r < 0xA9).map(([, v]) => v);
    expect(freshA0.length).toBeGreaterThan(0);
    expect(newA0.slice(0, freshA0.length)).toEqual(freshA0);
  });

  it('leaves nothing of the last race for the next one', () => {
    const drv = new SoundDriver(driverImage(), new Log());
    const port = new DriverPort(drv);
    drv.init();

    port.beginRace();
    port.play(1);
    port.engine(0, 0x30, true);                              // an engine note, as the race loop writes one
    drv.tick();
    port.play(2);                                            // queued but no tick has picked it up yet
    expect(drv.isPlaying(1)).toBe(true);
    expect(drv.isPlaying(0x40)).toBe(true);

    port.endRace();                                          // fn 3104: ah=6
    expect(drv.isPlaying(1)).toBe(true);                     // still deferred to the boundary
    drv.tick();                                              // the boundary
    expect(drv.isPlaying(1)).toBe(false);
    expect(drv.isPlaying(2)).toBe(false);                    // the queue was emptied with the stop
    expect(drv.isPlaying(0x40)).toBe(false);
    expect(drv.playingVoices).toBe(0);

    // the next race: a clean driver, and a sound finds a channel at once rather than waiting for one
    port.beginRace();
    port.resume();
    expect(drv.playingVoices).toBe(0);
    port.play(1);
    drv.tick();
    expect(drv.isPlaying(1)).toBe(true);
    expect(drv.playingVoices).toBe(1);

    // the menu music can take over after a race
    port.endRace();
    drv.tick();
    port.setSong(1);
    drv.tick();
    expect(drv.songPlaying(1)).toBe(true);
    expect(drv.playingVoices).toBe(2);                       // the song's own tracks
  });

  it('lets a screen that stops and re-asks for the same song be heard again', () => {
    // title(): ah=7, ah=6, then song 1. If ah=9 still called song 1 "playing" the request would be skipped
    // and the tick's stop would leave the title silent; this is the port's answer to that.
    const drv = new SoundDriver(driverImage(), new ChipLog());
    const port = new DriverPort(drv);
    drv.init();
    port.setSong(1);
    drv.tick();
    expect(port.songPlaying(1)).toBe(true);

    port.stopVoices();
    port.stopAll();
    expect(port.songPlaying(1)).toBe(false);                 // ah=9 answers no at once
    port.setSong(1);                                         // so the screen asks again
    drv.tick();
    expect(port.songPlaying(1)).toBe(true);
    expect(drv.playingVoices).toBe(2);
  });

  it('releases the old song channels when the screen asks for another song', () => {
    const log = new Log();
    const drv = new SoundDriver(driverImage(), log);
    drv.init();

    drv.setSong(1);
    drv.tick();
    expect(drv.songPlaying(1)).toBe(true);
    expect(drv.playingVoices).toBe(2);                       // channels 0 and 1

    const at = log.writes.length;
    drv.setSong(2);
    drv.tick();
    expect(drv.songPlaying(1)).toBe(false);
    expect(drv.songPlaying(2)).toBe(true);
    expect(drv.playingVoices).toBe(1);                       // only the new song's one track

    const keys = writesBetween(log, at).filter(([r]) => r >= 0xB0 && r < 0xB9);
    // the old song's second channel (1) is keyed off; the new song's own channel (2) is keyed on
    expect(keys.some(([r, v]) => r === 0xB1 && (v & 0x20) === 0)).toBe(true);
    expect(keys.some(([r, v]) => r === 0xB2 && (v & 0x20) !== 0)).toBe(true);
  });
});

describe('the pause wiring in the race', () => {
  it('asks the port to suspend, drains the ah=6 it queued, and resumes at the end', () => {
    const ds = new DataSegment();
    ds.w16(0x0F64, 1);                                       // the AdLib driver
    const calls: string[] = [];
    const port: SoundPort = {
      setSong: () => undefined,
      songPlaying: () => false,
      play: () => undefined,
      isPlaying: () => false,
      stopAll: () => { calls.push('stopAll'); },
      stopVoices: () => { calls.push('stopVoices'); },
      engine: () => undefined,
      suspend: () => { calls.push('suspend'); },
      resume: () => { calls.push('resume'); },
    };
    const race = new Race(ds);
    race.sound = port;

    ds.w8(0x107D, 0);                                      // fn 2d5b overwrites [107d] from this argument
    race.stepPhysics(0, 0x02);                             // ... and [107c] from its second: Space
    expect(race.pauseStage).toBe(1);
    expect(calls).toContain('suspend');
    expect(race.sounds).toContainEqual({ fn: 6, arg: 0 });

    // the page drains the race's queue every frame, the pause included, so the ah=6 lands on the driver's
    // next tick rather than being acted on here
    playSoundCalls(port, race.sounds);
    expect(calls).toContain('stopAll');
    expect(race.sounds.length).toBe(0);

    expect(race.pauseStep()).toBe(true);                   // the banner, waiting for a key
    ds.w8(0x107E, 0x1C);                                   // a key, released
    expect(race.pauseStep()).toBe(true);                   // taken: on to the wait for the next press
    expect(race.pauseStep()).toBe(true);                   // that press is the one just seen
    expect(race.pauseStep()).toBe(false);                  // and the race carries on
    expect(race.paused).toBe(false);
    expect(calls).toContain('resume');
    expect(calls.filter(c => c === 'resume').length).toBe(1);
  });
});
