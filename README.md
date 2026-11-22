# 🐇 Bunny Hop Chronicles

A browser bunny-hop game: `W A S D` to move, the mouse to steer, `Space` or the
mouse wheel to jump, and a sideways mouse swing in mid-air to build speed —
the honest Source-style air-accel rule, not an approximation of it.

Everything is plain TypeScript with no dependencies and no build step required
to *play*: the simulation runs at a hard 128 Hz, rendering only interpolates,
and the whole thing is a Canvas 2D page you can host from any static server.

```bash
npm run serve        # builds the browser modules, serves on :8080
npm test             # 90 unit/integration tests, no dependencies
npm run acceptance   # loads the real page in headless Chrome and plays it
npm run verify       # build + tests + headless acceptance
```

Open <http://localhost:8080/examples/site/> and click the canvas to lock the
mouse.

---

## What the game actually does

### Fixed-step physics (128 Hz + accumulator)

The simulation advances **only** in whole `1/128 s` steps. Each animation frame
feeds its real elapsed time to an accumulator; the loop runs however many whole
ticks that time buys and keeps the remainder as `alpha`.

- A 60 Hz machine and a 240 Hz machine see the *same* physics; the high-refresh
  machine just gets more interpolated pictures.
- A long stall (backgrounded tab, breakpoint, GC pause) is clamped per frame
  (`SIM.maxFrameDeltaSeconds`), and pausing **drops** the accumulator, so
  resuming can never replay ten minutes of ticks and teleport you into a wall.
- `Clock.alpha` is used by the renderer only. Physics state is written in one
  place: `Game.stepTick`.

### Mouse motion split across ticks

Input is gathered per frame, but each tick needs its own command. Mouse motion
from a frame is divided evenly across that frame's ticks with running-total
differencing, so the per-tick parts sum to exactly the frame total (a dropped
remainder would be refresh-rate-dependent aim drift). If a frame produces zero
ticks, nothing is consumed: the motion and any jump latch stay pending.

Tests assert that the *same hand movement* produces the same total rotation at
60 Hz and 240 Hz.

### Honest air acceleration

```
wish speed in the air = min(intent speed, 30 u/s)
per-tick gain         = airAccel × wishSpeed × dt      // never clamped to headroom
```

The wish *speed* is capped at 30 u/s, but the gain is not clamped to the
remaining headroom. Hold a strafe key and sweep the yaw so the wish direction
stays roughly perpendicular to your velocity, and every tick adds a little
sideways speed. Friction never sees it (you're airborne), so speed climbs
without bound. That is the mechanic; `tests/physics.test.ts` checks both halves
of the rule and that a swept mouse climbs past the 250 u/s ground cap.

The ground is ordinary: friction first, then acceleration clamped to
`maxGroundSpeed`. You cannot build speed by running.

### Pointer lock and pausing

- Mouse motion is ignored unless the pointer is locked.
- The first `mousemove` after locking is swallowed (browsers report a bogus jump
  from the cursor's old screen position).
- Losing lock or blurring the window pauses; motion and latches are cleared.
- Input is DOM-agnostic in its core (`InputBuffer`), with a thin `bindInput`
  adapter, so the pointer-lock rules are unit-tested without a browser.

### Jump edges and auto-hop

Jump is **edge-triggered**: a keydown (not a repeat) or a wheel notch latches
exactly one press, delivered on the first tick of the frame. Holding `Space`
never bunny-hops by itself when auto-hop is off.

With auto-hop **on** (default), the body re-jumps on the exact tick it lands,
and only if jump is held. It never touches direction or speed. Turn it off in
the pause menu and own the landings yourself.

### The course: `bhop_ascent`

Six stages, twenty-four pads plus a start deck, a checkpoint at the end of
every stage, and a finish deck. Pads climb 22 u per hop along a spiral; gaps
widen from 46 u to 78 u while pads shrink from 124 u to 90 u. A fall returns you
to the last checkpoint and **the clock keeps running** — falling costs time, not
your run. Best time and settings live in `localStorage` (invalid or missing data
is handled gracefully; private-mode storage that throws is survivable).

---

## Play

- **Move:** `W A S D`
- **Look:** mouse (pointer lock required)
- **Jump:** `Space`, left click while locked, or the mouse wheel
- **Pause / settings:** `P` or `Esc`
- **Restart:** `R` (also in the pause menu)
- **Toggle auto-hop:** `H` (also in the pause menu)

The pause menu holds auto-hop, mouse sensitivity and "clear personal best".

## Layout

```
src/
  config.ts            every tunable constant
  math.ts              vectors, angles, interpolation helpers
  physics/
    collision.ts       AABBs, axis-separated movement, support queries
    body.ts            the fixed-timestep bunny-hop step (pure)
  sim/
    clock.ts           fixed-step accumulator + even splitter
  input/
    input.ts           pointer-lock-aware InputBuffer + DOM adapter
  game/
    course.ts          bhop_ascent geometry (data → brushes + checkpoints)
    run.ts             run clock, checkpoints, falls, splits
    loop.ts            the Game: clock + input + physics + run state
    save.ts            localStorage records/settings, defensively parsed
  render/
    canvas.ts          read-only, interpolating Canvas 2D renderer
  bot/
    bot.ts             scripted bot = course completability proof
tests/                 90 tests: clock, physics, input, course, run, save,
                       loop, render, and the full bot run
examples/site/         the playable page (index.html + game/main.ts)
tools/
  build-site.mjs       transpiles src/ → examples/site/game/src/ (no deps)
  serve.mjs            zero-dependency static server
  acceptance.mjs       headless-Chrome acceptance check
```

## Running the checks

```bash
node --test "tests/*.test.ts"   # or: npm test
node tools/build-site.mjs
node tools/acceptance.mjs       # needs Chrome/Edge; SKIPs cleanly if absent
```

The map test is the interesting one: `src/bot/bot.ts` samples candidate
`(strafe, yaw-rate)` pairs against a copy of the physics body before each hop,
keeps the one that actually lands near the next pad's centre, and replays it.
It only presses keys a human can press and respects a bounded yaw rate. If it
finishes the course, the course is completable; if a map edit breaks that, the
test fails.

## Modding notes

- All numbers are in `src/config.ts`. `PHYSICS` is passed into the pure step,
  so tests and experiments can build their own configs.
- The course is data (`STAGES`, `START`); `buildCourse()` emits both the
  renderer geometry and the collider from one definition.
- Physics, clock, input core, course, run, save and the bot are DOM-free and
  run under plain Node (>= 22.6, for built-in TypeScript stripping).
- The renderer reads the body and never writes to it; the camera's pitch lives
  only in the view and cannot change a hop.

## Licence

Free as in "read every line, take it apart, put it back together wrong". See
`LICENSE`.
