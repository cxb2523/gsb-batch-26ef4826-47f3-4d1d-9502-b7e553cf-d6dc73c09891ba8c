# Acceptance checks: cross-level hand-off

## Automated unit/behaviour tests (no browser, no audio device)

```bash
bun test
```

| Spec file | Covers |
| --- | --- |
| `tests/gameSession.test.ts` | Timer starts only on a real press; step advance; single completion; cross-source dedup (keyboard ↔ touch); level restart clears keys/player state/step/timer; held key from previous level cannot start the new one; `stop()` releases notes; snapshot identity. |
| `tests/keyboardInput.test.ts` | Auto-repeat and duplicate keydown filtered; key held across a level switch ignored until released and re-pressed; audio start triggered once per physical press; menu free-play notes; blur clears held keys. |
| `tests/touchInput.test.ts` | Zone→key mapping; two fingers on one zone deduped; slide between zones releases old note first; slide off the board releases; `touchcancel` releases; level switch leaves no ghost key; finger held across a level switch suppressed until lifted; finger already on the glass at mount is not a press; zone highlight snapshot. |
| `tests/audioEngine.test.ts` | No backend call before init; notes queued pre-init flush only for the session that queued them; concurrent `ensureStarted()` shares one start; level end/switch drops queued old-level notes; init retry after failure; held-note dedup; session switch silences notes. |
| `tests/handoff.test.ts` | Full wiring (real session + both input controllers + real audio engine, fake Tone backend): normal level 1 → result → level 2 hand-off; "any key" that finished a level cannot start the next; rapid double press; init-during-play flushes only current-level notes; rapid switch drops old-level note; touch through a switch; keyboard+touch same key released exactly once. |

## Automated browser acceptance (real DOM, real key/touch events)

```bash
bun run test:e2e
```

Builds the app, serves `dist` with `vite preview`, launches a headless
Chromium found automatically (Playwright's bundled headless shell, a local
Chrome/Edge, or `FD_CHROME=/path/to/chromium`), and runs 28 checks:

* **Keyboard pass** — level mount is clean; timer 0.00 until the first press;
  finishing level 1 while holding the final key; advancing with another key
  while it is still held; the held key's auto-repeat and a bare release must
  not start/advance the new level; a fresh press does; duplicate keydown
  advances once; restart and back-to-menu reset cleanly; play level 2 to
  completion from the menu; the result screen advances exactly one level.
* **Touch pass** (with touch emulation enabled before mount) — overlay
  present; zone press starts the timer; sliding between zones advances; sliding
  off the board releases without corrupting the step; restart mid-touch resets;
  the held finger cannot start the new level until lifted; a fresh touch does;
  back to menu is clean.

Both passes also assert there are no unexpected console errors. (Headless
Chromium cannot enter fullscreen; that one environmental error is ignored.)

## Manual smoke test

```bash
bun run dev
```

1. **Normal hand-off** — finish level 1, press any key on the result screen.
   Level 2 shows step 1/…, timer `0.00s`, no dots lit, no sound from level 1,
   and the timer stays at 0 until a key is pressed again.
2. **Held key** — hold the key that finishes a level through the result screen
   into the next level. The new level must not start or advance; release and
   press again to start.
3. **Rapid switch** — mash keys, then hit Restart or Back to Menu mid-play.
   No stuck dots, no hanging note, timer resets on the next level.
4. **Touch** — on a touch device drag a finger between zones: the old note
   stops as the new one starts. Drag off the board or `touchcancel`: the note
   stops. Switch level with a finger down: no ghost key, and the finger cannot
   start the new level until lifted.
5. **Audio init race** — reload and immediately press the first game key. The
   note may be deferred briefly; it plays once, never twice, and no note from a
   previous level is heard after a switch.
