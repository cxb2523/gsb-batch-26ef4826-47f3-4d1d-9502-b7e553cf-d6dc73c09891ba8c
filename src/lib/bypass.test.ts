import { describe, it, expect } from 'vitest';
import { isBypassed, previewAfterDrag, previewAfterCommit, persistsNow, sendsBandsToActiveTab, mayMirrorBuffer, commitOnUnbypass, limiterResetsOn } from './bypass';
import { NO_PREVIEW, previewForDrag, previewForBypass } from './edit-state';
import { flatBands } from './engine-io';

const FLAT = flatBands();
const BYPASS = () => previewForBypass(FLAT);

describe('bypass outranks a drag', () => {
  it('a drag while bypassed does not downgrade the override', () => {
    // The single most important line. If a drag overwrites the preview with previewForDrag(), the
    // next push sends the edited curve to a tab the user asked to hear unshaped — and the badge
    // keeps saying the equalizer is off while it audibly is not.
    const pv = previewAfterDrag(BYPASS());
    expect(isBypassed(pv)).toBe(true);
    expect(pv.overrideBands!.every((b) => b.gain === 0)).toBe(true);
  });

  it('a drag with no bypass still opens a drag preview', () => {
    expect(previewAfterDrag(NO_PREVIEW).source).toBe('drag');
  });

  it('survives any number of drags', () => {
    let pv = BYPASS();
    for (let i = 0; i < 5; i++) pv = previewAfterDrag(pv);
    expect(isBypassed(pv)).toBe(true);
  });

  it('only the toggle ends it', () => {
    expect(previewAfterCommit(previewAfterDrag(BYPASS()))).toEqual(BYPASS());
    expect(previewAfterCommit(previewForDrag())).toEqual(NO_PREVIEW);
    expect(previewAfterCommit(NO_PREVIEW)).toEqual(NO_PREVIEW);
  });
});

describe('bypass is a draft: nothing is written while it is on', () => {
  it('suppresses persistence, and only bypass does', () => {
    expect(persistsNow(BYPASS())).toBe(false);
    expect(persistsNow(previewAfterDrag(BYPASS()))).toBe(false);
    expect(persistsNow(previewForDrag())).toBe(true);
    expect(persistsNow(NO_PREVIEW)).toBe(true);
  });

  it('suppresses the band push to the active tab', () => {
    expect(sendsBandsToActiveTab(BYPASS())).toBe(false);
    expect(sendsBandsToActiveTab(previewAfterDrag(BYPASS()))).toBe(false);
    expect(sendsBandsToActiveTab(previewForDrag())).toBe(true);
    expect(sendsBandsToActiveTab(NO_PREVIEW)).toBe(true);
  });

  it('commits the draft when bypass ends, and only if there is one', () => {
    // Toggling bypass on and off without touching anything must not write. The draft is real work
    // and gets saved; an idle listen is not an edit.
    expect(commitOnUnbypass({ dirty: true })).toBe(true);
    expect(commitOnUnbypass({ dirty: false })).toBe(false);
  });
});

describe('the buffer must keep tracking storage, even under bypass', () => {
  // The defect that made the naive patch unsafe. applyEverywhere used one flag for two questions:
  // "may I push audio to the active tab" and "may I refresh the editing buffer from storage". With
  // the graph editable and the buffer frozen for a whole bypass session, deleting that site's rule
  // in the Rules tab left the graph showing a curve that existed nowhere — and the next drag
  // committed it, against a target that had changed underneath.
  it('a bypass alone does not freeze the buffer', () => {
    expect(mayMirrorBuffer({ interacting: false, dirty: false, preview: BYPASS() })).toBe(true);
  });

  it('an unsaved draft does freeze it — that work must not be overwritten', () => {
    expect(mayMirrorBuffer({ interacting: false, dirty: true, preview: BYPASS() })).toBe(false);
  });

  it('a live gesture freezes it whether or not anything is dirty yet', () => {
    expect(mayMirrorBuffer({ interacting: true, dirty: false, preview: NO_PREVIEW })).toBe(false);
  });

  it('nothing in progress means the buffer follows storage', () => {
    expect(mayMirrorBuffer({ interacting: false, dirty: false, preview: NO_PREVIEW })).toBe(true);
  });

  it('a drag preview freezes it', () => {
    expect(mayMirrorBuffer({ interacting: false, dirty: false, preview: previewForDrag() })).toBe(false);
  });
});

describe('the output limiter is cleared exactly when bypass changes', () => {
  // One shared output stage, so the gain reduction earned by the curve the user stopped hearing
  // must not be released onto the signal that replaces it. The switch is an EDGE, not a level:
  // asking "are we bypassed" inside the mode would re-arm on every drag made against the draft.
  it('resets on entry and on exit — both directions hand over a different signal', () => {
    expect(limiterResetsOn(NO_PREVIEW, BYPASS())).toBe(true);
    expect(limiterResetsOn(BYPASS(), NO_PREVIEW)).toBe(true);
  });

  it('staying inside or outside the mode resets nothing', () => {
    expect(limiterResetsOn(NO_PREVIEW, previewForDrag())).toBe(false);
    expect(limiterResetsOn(previewForDrag(), NO_PREVIEW)).toBe(false);
    expect(limiterResetsOn(BYPASS(), BYPASS())).toBe(false);
  });

  it('a drag made while bypassed is not a transition — the mode never changed', () => {
    // previewAfterDrag keeps the bypass preview, so this is the same edge the drag handler sees.
    expect(limiterResetsOn(BYPASS(), previewAfterDrag(BYPASS()))).toBe(false);
  });

  it('a commit (which leaves a drag preview) is not a bypass transition', () => {
    expect(limiterResetsOn(previewForDrag(), previewAfterCommit(previewForDrag()))).toBe(false);
  });
});
