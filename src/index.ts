/**
 * Bunny Hop Chronicles — public module surface.
 *
 * The game is split into pure, DOM-free modules so each can be tested and
 * modded independently:
 *
 *   config        every tunable constant in one place
 *   math          vector / angle helpers
 *   physics/      collision + the fixed-timestep bunny-hop body
 *   sim/          the 128 Hz accumulator and mouse-motion splitter
 *   input/        pointer-lock-aware input buffer and frame→tick binding
 *   game/         course geometry, run clock, game loop, localStorage records
 *   render/       read-only, interpolating Canvas 2D renderer
 *   bot/          scripted bot used as a course-completability proof
 *
 * A host (the browser page, a headless test, a bot) should only need:
 *   buildCourse() + InputBuffer + Game + CanvasRenderer
 */

export * from './math.ts';
export * from './config.ts';

export * from './physics/collision.ts';
export * from './physics/body.ts';

export * from './sim/clock.ts';

export * from './input/input.ts';

export * from './game/course.ts';
export * from './game/run.ts';
export * from './game/save.ts';
export * from './game/loop.ts';

export * from './render/canvas.ts';

export * from './bot/bot.ts';
