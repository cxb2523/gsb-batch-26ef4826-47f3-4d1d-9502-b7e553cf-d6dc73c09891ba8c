import { expect, test } from '@playwright/test';

test('runtime dark, order and shared clips preserve snapshots, filters and nested leases', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const rows = await page.evaluate(() => window.rigPlayHarness.runtimeMetadataProbe());
  expect(rows).toHaveLength(4);
  for (const row of rows) {
    expect(row.poser).toBe('runtime');
    expect(row.difference, row.rig).toBeNull();
    expect(row.filterDifference, row.rig).toBeNull();
    expect(row.afterFilterDifference, row.rig).toBeNull();
    expect(row.snapshotKept, row.rig).toBe(true);
    expect(row.nestedStale, row.rig).toBe(true);
    expect(row.readonly, row.rig).toBe(true);
  }
  expect(rows.find(row => row.rig === 'figure')!.shared).toBe(true);
});

test('physics names its oracle policy and preserves nonloop timeScale, replay and movement', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const rows = await page.evaluate(() => window.rigPlayHarness.runtimePhysicsPolicyProbe());
  for (const row of rows) {
    expect(row.poser).toMatch(/^oracle: physics constraint ".+" requires player clock, seek and movement integration$/);
    expect(row.difference, row.operation).toBeNull();
    expect(row.timeDifference, row.operation).toBeNull();
  }
});

test('runtime clip movement reuses mesh rasters, inverse uses path and disappearance restores the root', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const rows = await page.evaluate(() => window.rigPlayHarness.runtimeClipRendererProbe());
  expect(rows.every(row => row.poser === 'runtime')).toBe(true);
  expect(rows[0].meshes).toBeGreaterThan(0);
  for (const row of rows.slice(1)) {
    expect(row.meshes).toBe(0);
    expect(row.reused).toBeGreaterThan(0);
  }
  expect(rows[1].clipWrites).toBe(0);
  expect(rows[2].rootClip).not.toBe(rows[1].rootClip);
  expect(rows[3].elementPaths.some(path => path.startsWith('path('))).toBe(true);
  expect(rows[3].rootClip).toBe('inset(0px)');
  expect(rows[4].rootClip).toBe('inset(0px)');
  expect(rows[4].elementPaths.every(path => path === '')).toBe(true);
  expect(rows[4].frameHasClip).toBe(false);
});

for (const rig of ['walk', 'flex', 'squash', 'portrait', 'nod', 'look', 'ride', 'figure', 'glow', 'turned', 'duo']) {
  test(`live frame exact values, snapshots and pixels: ${rig}`, async ({ page }) => {
    await page.goto('/tests/harness.html');
    await page.waitForFunction(() => Boolean(window.rigPlayHarness));
    const result = await page.evaluate(rig => window.rigPlayHarness.liveFrameProbe(rig), rig);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.numeric, `${rig}/${row.animation}: ${row.poser}`).toEqual([]);
      if (row.pixelValues > 0 && row.contentPixels > 0) expect(row.pixelDifferences, `${rig}/${row.animation}: ${row.poser}`).toBe(0);
      else console.log('LIVE_FRAME_PIXEL_SKIP', `${rig}/${row.animation}: no drawable content at the sampled times`);
      expect(row.snapshotKept).toBe(true);
      expect(row.stale).toBe(true);
      expect(row.nestedStale).toBe(true);
      expect(row.rendererStale).toBe(true);
      expect(row.readonly).toBe(true);
      if (row.poser === 'runtime') expect(row.drawIdentity).toBe(true);
      else expect(row.drawIdentity).toBeNull();
    }
    console.log('LIVE_FRAME_CASE', JSON.stringify(result));
  });
}

test('runtime composition fallback keeps time and invalidates old views', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const result = await page.evaluate(() => window.rigPlayHarness.liveFrameTransitions());
  expect(result.beforeCount).toBeGreaterThan(0);
  expect(result.composedReason).toContain('oracle: track composition');
  expect(result.composedTime).toBe(result.at);
  expect(result.oldStale).toBe(true);
  expect(result.disposed).toBe(true);
});

for (const reason of ['composition', 'environment', 'skin'] as const) {
  for (const mode of ['dom', 'canvas'] as const) {
    for (const checked of [true, false]) {
      test(`runtime→oracle fallback (${reason}, ${mode}, ${checked ? 'checked' : 'production'}): time and clip continuity, expired old borrow, fresh new frame`, async ({ page }) => {
        await page.goto('/tests/harness.html');
        await page.waitForFunction(() => Boolean(window.rigPlayHarness));
        const r = await page.evaluate(([reason, mode, checked]) => window.rigPlayHarness.liveFrameContinuityProbe(reason, mode, checked), [reason, mode, checked] as const);
        // The poser names its oracle reason and time does not jump.
        expect(r.poser).toMatch(/^oracle: /);
        expect(r.timeContinuous, `time ${r.timeBefore} → ${r.timeAfter}`).toBe(true);
        // Clip coverage carries across the switch, and the generation advances.
        expect(r.clipsContinuous, `clips ${r.clipsBefore} → ${r.clipsAfter}`).toBe(true);
        expect(r.generationAdvanced, `gen ${r.leaseGen} → ${r.freshGen}`).toBe(true);
        // Old borrows are dead to both reads and draws; the fresh one draws.
        expect(r.oldDraw).toContain('LIVE_FRAME_STALE');
        expect(r.freshDraw).toBe('drew');
        if (checked) {
          expect(r.oldRead).toContain('LIVE_FRAME_STALE');
          expect(r.oldReadNested).toContain('LIVE_FRAME_STALE');
        }
        // Disposal expires the borrow, refuses a new one, and cleans the root.
        expect(r.disposedRead).toContain('LIVE_FRAME_STALE');
        expect(r.disposedDraw).toContain('LIVE_FRAME_STALE');
        expect(r.borrowAfterDispose).toContain('LIVE_FRAME_DISPOSED');
        expect(r.childrenAfterDispose).toBe(0);
        expect(r.rootClipAfterDispose).toBe('inset(3px)');
        console.log('LIVE_FRAME_CONTINUITY', JSON.stringify(r));
      });
    }
  }
}

test('normal playback draws the same picture in dom and canvas', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  for (const animation of ['tilted', 'inverse', 'mask']) {
    const rows = await page.evaluate(animation => window.rigPlayHarness.liveFrameModeParity(animation), animation);
    expect(rows.map(row => row.mode)).toEqual(['dom', 'canvas']);
    for (const row of rows) {
      // The runtime is selected in both modes, its borrowed + detached frame
      // agrees slot-for-slot, and matches the oracle record to the bit — so the
      // two machines draw from identical numbers. Clip coverage is present.
      expect(row.poser, `${animation}/${row.mode}`).toBe('runtime');
      expect(row.frameDifference, `${animation}/${row.mode}`).toBeNull();
      expect(row.oracleDifference, `${animation}/${row.mode}`).toBeNull();
      expect(row.clipCount, `${animation}/${row.mode}`).toBeGreaterThan(0);
      if (row.drawRedrawPixelDifferences !== null) expect(row.drawRedrawPixelDifferences, `${animation}/${row.mode}`).toBe(0);
    }
    console.log('LIVE_FRAME_MODE_PARITY', JSON.stringify({ animation, rows }));
  }
});

test('planted vertex, snapshot and unchecked-lease defects fail their gates', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const corrupt = await page.evaluate(() => window.rigPlayHarness.liveFrameProbe('turned', 'vertices'));
  expect(corrupt.rows.some(row => row.poser === 'runtime' && row.numeric.length > 0)).toBe(true);
  expect(corrupt.rows.some(row => row.pixelDifferences > 0)).toBe(true);
  const unchecked = await page.evaluate(() => window.rigPlayHarness.liveFrameProbe('turned', 'lease'));
  // The mutant disables `liveFrameChecks`, so a production borrow loses its
  // proxy: direct reads and retained nested views stop throwing. The renderer
  // boundary still refuses the expired frame in every mode — that gate is not
  // a lease the caller can switch off.
  expect(unchecked.rows.some(row => row.poser === 'runtime' && !row.stale && !row.nestedStale && !row.readonly)).toBe(true);
  expect(unchecked.rows.every(row => row.poser !== 'runtime' || row.rendererStale)).toBe(true);
  const shared = await page.evaluate(() => window.rigPlayHarness.liveFrameProbe('walk', 'snapshot'));
  expect(shared.rows.some(row => row.poser === 'runtime' && !row.snapshotKept)).toBe(true);
});


test('a null attachment key without a setup attachment has coherent runtime/oracle identity', async ({ page }) => {
  await page.route('**/rigs/turned/skeleton.model.json', async route => {
    const response = await route.fetch();
    const model: { slots: Array<{ name: string; setup: string | null }>; animations: Array<{ slots: Array<{ name: string; timelines: Array<{ name: string; keys: Array<{ time: number; name: string | null }> }> }> }> } = await response.json();
    const slot = model.slots.find(value => value.name === 's');
    const timeline = model.animations[0].slots.find(value => value.name === 's')?.timelines.find(value => value.name === 'attachment');
    if (!slot || !timeline) throw Error('NULL_IDENTITY_FIXTURE: turned needs slot s and its attachment timeline');
    slot.setup = null;
    timeline.keys = [{ time: 0.25, name: null }, { time: 1, name: null }];
    await route.fulfill({ response, json: model });
  });
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const clean = await page.evaluate(() => window.rigPlayHarness.liveFrameNullIdentity());
  expect(clean.every(row => row.poser === 'runtime' && row.difference === null)).toBe(true);
  expect(clean.map(row => row.actual)).toEqual(['no-attachment', 'no-attachment', 'timeline-null', 'timeline-null', 'timeline-null']);
  const planted = await page.evaluate(() => window.rigPlayHarness.liveFrameNullIdentity(true));
  expect(planted.some(row => row.expected === 'timeline-null' && row.actual === 'no-attachment' && row.difference !== null)).toBe(true);
  console.log('LIVE_FRAME_NULL_IDENTITY', JSON.stringify({ clean, planted }));
});
