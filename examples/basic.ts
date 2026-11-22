// Runnable example: drive the whole course with the scripted bot.
//
//   node examples/basic.ts
//
// The bot has only the inputs a human has (strafe keys, jump, a bounded yaw
// rate), so a finished run is a completability proof for the map.

import { buildCourse } from '../src/game/course.ts';
import { runBot } from '../src/bot/bot.ts';
import { formatTime } from '../src/game/run.ts';

const course = buildCourse();
console.log(`Course: ${course.name} — ${course.pads.length} pads`);
console.log(`Checkpoints: ${course.checkpoints.map((c) => c.name).join(', ')}`);

const result = runBot(course);
console.log('');
console.log(`finished:   ${result.finished}`);
console.log(`pads:       ${result.padsCleared}/${result.totalPads}`);
console.log(`time:       ${formatTime(result.seconds)} (${result.seconds.toFixed(2)} s)`);
console.log(`hops:       ${result.hops}`);
console.log(`respawns:   ${result.respawns}`);
console.log(`peak speed: ${result.peakSpeed.toFixed(0)} u/s`);
if (!result.finished) {
  console.error(`failure: ${result.failure}`);
  process.exitCode = 1;
}
