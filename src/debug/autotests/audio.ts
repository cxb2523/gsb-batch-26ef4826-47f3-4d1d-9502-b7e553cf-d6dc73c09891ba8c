import type { Game } from '../../core/Game';
import type { AudioSystem } from '../../systems/audio';
import { AudioConfig } from '../../systems/audio/config';
import { SOUND_IDS } from '../../systems/audio/sounds';
import { assert, Suite, wait } from './util';

type VoiceStats = ReturnType<AudioSystem['voiceStats']>;

/**
 * Audio acceptance: every SoundId plays without errors, the voice pool stays
 * bounded under a 500-play stress, loops/engine/siren/radio work, ambient runs.
 * Run: npm run smoke -- --systems=world,player,camera,audio --name=audio --autotest=audio
 */
export default async function audio(game: Game): Promise<void> {
  const suite = new Suite('audio', game);
  const errorsAtStart = game.debug.errorCount;
  const V = AudioConfig.voices;

  await suite.check('audio-system-loaded', () => {
    assert(game.systems.has('audio'), 'audio system missing');
    const state = game.debug.run('audio.state') as { context: string };
    assert(typeof state.context === 'string', 'audio.state has no context');
  });

  await suite.check('play-all-ids', async () => {
    const count = game.debug.run('audio.playAll') as number;
    assert(count === SOUND_IDS.length, `playAll returned ${count}, expected ${SOUND_IDS.length}`);
    await wait(count * AudioConfig.debug.playAllStaggerMs + 600);
    const v = game.debug.run('audio.voices') as VoiceStats;
    assert(v.oneShots <= V.maxOneShots, `one-shots ${v.oneShots} > cap ${V.maxOneShots}`);
    assert(v.loops <= V.maxLoops, `loops ${v.loops} > cap ${V.maxLoops}`);
    assert(game.debug.errorCount === errorsAtStart, `errors while playing: ${game.debug.errors.join(' | ')}`);
  });

  await suite.check('stress-500-plays-bounded', async () => {
    for (let i = 0; i < 500; i++) {
      const id = SOUND_IDS[(i * 7) % SOUND_IDS.length];
      game.audio.play(id, { position: { x: game.state.playerPos.x + (i % 10), y: 0, z: game.state.playerPos.z }, volume: 0.5 });
    }
    const v = game.debug.run('audio.voices') as VoiceStats;
    assert(v.oneShots <= V.maxOneShots, `one-shots ${v.oneShots} > cap ${V.maxOneShots}`);
    assert(v.loops <= V.maxLoops, `loops ${v.loops} > cap ${V.maxLoops}`);
    await wait(3000);
    const after = game.debug.run('audio.voices') as VoiceStats;
    assert(after.oneShots <= V.maxOneShots, `one-shots still ${after.oneShots} after settling`);
  });

  await suite.check('loops-engine-siren', () => {
    const engine = game.audio.loop('vehicle.engine.loop', { position: game.state.playerPos });
    assert(engine.alive, 'engine handle not alive');
    game.audio.engine(engine, 0.5, 1, 12);
    game.audio.setLoopParams(engine, { pitch: 1.1, volume: 0.8, position: { x: 1, y: 0, z: 1 } });
    const siren = game.audio.loop('vehicle.siren.loop');
    game.audio.siren(siren, true);
    game.audio.siren(siren, false);
    game.audio.stop(engine);
    game.audio.stop(siren);
    assert(!engine.alive && !siren.alive, 'stopped handles still alive');
    // Calls on a stopped handle are silent no-ops (they must not throw or touch a dead voice).
    game.audio.setLoopParams(engine, { pitch: 2 });
    game.audio.engine(engine, 1, 1, 30);
    game.audio.siren(siren, true);
    // Repeated stops are safe and leave no loop residue.
    game.audio.stop(engine);
    game.audio.stop(engine);
    const v = game.debug.run('audio.voices') as VoiceStats;
    assert(v.loops < V.maxLoops || v.stolen > 0, `loop residue after stop: ${v.loops}/${v.maxLoops}`);
  });

  await suite.check('loop-steal-invalidates-handle', () => {
    const before = game.debug.run('audio.voices') as VoiceStats;
    const handles: { alive: boolean }[] = [];
    for (let i = 0; i < V.maxLoops + 2; i++) handles.push(game.audio.loop('vehicle.engine.loop', { volume: 0.3 }));
    const after = game.debug.run('audio.voices') as VoiceStats;
    assert(after.loops <= V.maxLoops, `loops ${after.loops} > cap ${V.maxLoops}`);
    assert(after.stolen > before.stolen, 'no steal was recorded');
    const dead = handles.filter((h) => !h.alive);
    assert(dead.length >= 2, `stolen handles still alive (${dead.length} invalidated)`);
    // The dead handles accept calls without throwing.
    for (const h of dead) {
      game.audio.setLoopParams(h as never, { pitch: 2, volume: 0.5 });
      game.audio.engine(h as never, 1, 1, 20);
      game.audio.siren(h as never, true);
      game.audio.stop(h as never);
    }
    for (const h of handles) if (h.alive) game.audio.stop(h as never);
  });

  await suite.check('pause-resume-keeps-loops', async () => {
    const engine = game.audio.loop('vehicle.engine.loop');
    const before = game.debug.run('audio.state') as { context: string };
    // Drive the same events the UI pause menu emits (the ui system is optional here).
    game.events.emit('ui:paused', {});
    await wait(80);
    const paused = game.debug.run('audio.state') as { context: string };
    // A running browser context is suspended; headless stays 'unavailable'.
    if (before.context === 'running') assert(paused.context === 'suspended', `context ${paused.context} while paused`);
    game.events.emit('ui:resumed', {});
    await wait(80);
    const resumed = game.debug.run('audio.state') as { context: string };
    if (before.context === 'running') assert(resumed.context === 'running', `context ${resumed.context} after resume`);
    assert(engine.alive, 'engine handle died across pause/resume');
    game.audio.engine(engine, 0.8, 1, 20);
    game.audio.setLoopParams(engine, { pitch: 1.1, volume: 0.7 });
    game.audio.stop(engine);
    assert(!engine.alive, 'stopped handle alive after resume');
  });

  await suite.check('radio-toggle', () => {
    assert(game.debug.run('audio.radio', true) === true, 'radio did not turn on');
    const state = game.debug.run('audio.state') as { radio: boolean };
    assert(state.radio, 'state.radio false while on');
    assert(game.debug.run('audio.radio', false) === false, 'radio did not turn off');
  });

  await suite.check('bus-volume-persists', () => {
    const before = game.audio.getBusVolume('sfx');
    game.debug.run('audio.bus', 'sfx', 0.42);
    assert(Math.abs(game.audio.getBusVolume('sfx') - 0.42) < 1e-6, 'bus volume not applied');
    game.audio.setBusVolume('sfx', before);
  });

  await suite.check('ambient-bed-selected', async () => {
    await wait(1200);
    const state = game.debug.run('audio.state') as { ambient: string | null; context: string };
    if (state.context === 'unavailable') return;
    assert(typeof state.ambient === 'string', 'no ambient bed selected');
  });

  await suite.check('unknown-id-warns-only', () => {
    const errors = game.debug.errorCount;
    game.audio.play('not.a.sound' as never);
    assert(game.debug.errorCount === errors, 'unknown id produced a console.error');
  });

  await suite.check('no-errors-after-run', () => {
    assert(game.debug.errorCount === errorsAtStart, `${game.debug.errorCount - errorsAtStart} console errors: ${game.debug.errors.join(' | ')}`);
  });

  suite.finish();
}
