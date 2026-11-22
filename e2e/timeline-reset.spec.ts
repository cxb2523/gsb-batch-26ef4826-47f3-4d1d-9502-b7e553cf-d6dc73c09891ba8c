import { test, expect, type Page } from '@playwright/test';
import { addObject } from './helpers';

function animatedGlb() {
  const positions = Buffer.alloc(36);
  [-1, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, i) => positions.writeFloatLE(value, i * 4));
  const keys = Buffer.alloc(56);
  [0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 3, 0, 0].forEach((value, i) => keys.writeFloatLE(value, i * 4));
  const binary = Buffer.concat([positions, keys]);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'MovingMesh' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' },
      { bufferView: 3, componentType: 5126, count: 2, type: 'VEC3' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 8 },
      { buffer: 0, byteOffset: 44, byteLength: 24 }, { buffer: 0, byteOffset: 68, byteLength: 24 }
    ],
    buffers: [{ byteLength: binary.length }],
    animations: [{ name: 'First',
      samplers: [{ input: 1, output: 2, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }]
  };
  const text = Buffer.from(JSON.stringify(gltf));
  const json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  text.copy(json);
  const header = Buffer.alloc(12);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + binary.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length); jsonHeader.write('JSON', 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length); binHeader.write('BIN\0', 4);
  return Buffer.concat([header, jsonHeader, json, binHeader, binary]);
}

function silentWav(samples = 16000) {
  const wave = Buffer.alloc(44 + samples * 2);
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(samples * 2, 40);
  return wave;
}

type TrackedAudio = HTMLAudioElement & { __released?: boolean };

const waitForFrames = (page: Page) =>
  page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function canvasDiff(page: Page, a: Buffer, b: Buffer) {
  return page.evaluate(async ([left, right]) => {
    const read = async (value: string) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${value}`)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const first = await read(left);
    const second = await read(right);
    let total = 0;
    for (let index = 0; index < first.length; index++) total += Math.abs(first[index] - second[index]);
    return total / first.length;
  }, [a.toString('base64'), b.toString('base64')]);
}

async function setupTrackedScene(page: Page) {
  await page.addInitScript(() => {
    const proto = HTMLAudioElement.prototype;
    const play = proto.play;
    proto.play = function (this: HTMLAudioElement) {
      const win = window as Window & { timelinePreviewAudio?: TrackedAudio[] };
      win.timelinePreviewAudio ??= [];
      if (!win.timelinePreviewAudio.includes(this as TrackedAudio)) win.timelinePreviewAudio.push(this as TrackedAudio);
      return play.call(this);
    };
    const removeAttribute = proto.removeAttribute;
    proto.removeAttribute = function (this: HTMLAudioElement, name: string) {
      if (name === 'src') (this as TrackedAudio).__released = true;
      return removeAttribute.call(this, name);
    };
  });
  await page.goto('/');
  await page.locator('#model-upload').setInputFiles({ name: 'animated.glb', mimeType: 'model/gltf-binary', buffer: animatedGlb() });
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("return { update() { document.body.dataset.clipPosition = String(object.getObjectByName('MovingMesh').position.x); } };");
  await page.getByRole('button', { name: 'Sounds', exact: true }).click();
  await page.locator('#sound-upload').setInputFiles({ name: 'timeline.wav', mimeType: 'audio/wav', buffer: silentWav(32000) });
  await expect(page.getByRole('region', { name: 'Sounds' }).getByText('timeline.wav', { exact: true })).toBeVisible();
  // Configure model clip and sound while the model is still the selected object.
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByLabel('Timeline duration').fill('3');
  await page.getByRole('button', { name: 'Add GLB clip' }).click();
  await page.getByRole('button', { name: 'Add object sound' }).click();
  // Adding the heading selects it; timeline model controls are no longer rendered after this.
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Reset heading');
  // Two web channels on the same element: restoration must run only once per element.
  await page.getByLabel('Timeline channel').selectOption('web.opacity');
  await page.getByRole('button', { name: 'Add channel' }).click();
  await page.getByLabel('web.opacity keyframe value').first().fill('0');
  await page.getByLabel('Timeline channel').selectOption('web.x');
  await page.getByRole('button', { name: 'Add channel' }).click();
  await page.getByLabel('web.x keyframe value').last().fill('120');
}

const clipPosition = (page: Page) =>
  page.locator('body').getAttribute('data-clip-position').then(value => Number(value ?? NaN));

const modelPosition = (page: Page) => page.evaluate(async () => {
  const modulePath = '/src/store/editorStore.ts';
  const { useEditorStore } = await import(/* @vite-ignore */ modulePath);
  const root = useEditorStore.getState().sceneObjects[0]?.object;
  const target = root?.getObjectByName?.('MovingMesh') ?? root;
  return target?.position.x ?? NaN;
});

const audioStates = (page: Page) => page.evaluate(() =>
  ((window as Window & { timelinePreviewAudio?: TrackedAudio[] }).timelinePreviewAudio ?? [])
    .map(audio => ({
      paused: audio.paused,
      released: audio.__released === true,
      src: audio.getAttribute('src'),
      idlSrc: audio.src,
      // networkState 0 = NETWORK_EMPTY: Chromium keeps currentSrc text after load() even with no resource.
      networkState: audio.networkState
    })));

const someAudioPlaying = (page: Page) => page.evaluate(() =>
  ((window as Window & { timelinePreviewAudio?: TrackedAudio[] }).timelinePreviewAudio ?? [])
    .some(audio => !audio.paused));

// load() releases the media resource asynchronously; assert the release contract Chromium exposes.
const expectAllAudioReleased = async (page: Page, count: number) => {
  await expect.poll(async () => {
    const states = await audioStates(page);
    if (states.length !== count) return false;
    return states.every(state => state.paused && state.released &&
      state.src === null && state.idlSrc === '' && state.networkState === 0);
  }, { timeout: 5000 }).toBe(true);
};

const headingOpacity = (page: Page) =>
  page.getByRole('heading', { name: 'Reset heading' })
    .evaluate(element => Number(getComputedStyle(element).opacity));

const collectErrors = (page: Page) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
};

test('closing timeline preview restores clip pose and web styles and stays silent', async ({ page }) => {
  const errors = collectErrors(page);
  await setupTrackedScene(page);
  const heading = page.getByRole('heading', { name: 'Reset heading' });
  await waitForFrames(page);
  const baseline = await page.locator('canvas').screenshot();
  const styleBefore = await heading.getAttribute('style');
  const opacityBefore = Number(await heading.evaluate(element => getComputedStyle(element).opacity));
  const transformBefore = await heading.evaluate(element => getComputedStyle(element).transform);

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect.poll(async () => Number(await page.getByLabel('Timeline preview time').inputValue())).toBeCloseTo(0, 5);
  await waitForFrames(page);
  // Deterministic frame at second 0, used to prove a later re-entry starts cleanly.
  const zeroFrame = await page.locator('canvas').screenshot();
  await page.getByLabel('Timeline preview time').fill('1.5');
  await waitForFrames(page);
  // Timeline is visibly driving both the model pose and the web element mid-preview.
  expect(await canvasDiff(page, baseline, await page.locator('canvas').screenshot())).toBeGreaterThan(1);
  expect(Number(await heading.evaluate(element => getComputedStyle(element).opacity))).toBeCloseTo(0.5, 1);
  expect(await heading.evaluate(element => getComputedStyle(element).transform)).not.toBe(transformBefore);
  const styleDuring = await heading.getAttribute('style');
  expect(styleDuring).toContain('opacity');
  expect(styleDuring).toContain('translate');

  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await waitForFrames(page);
  // Model animation is back at the initial pose.
  expect(await canvasDiff(page, baseline, await page.locator('canvas').screenshot())).toBeLessThan(0.5);
  // Web element inline styles match the state before the timeline intervened.
  const styleAfter = await heading.getAttribute('style');
  expect(styleAfter).toBe(styleBefore);
  expect(styleAfter ?? '').not.toContain('translate');
  expect(styleAfter ?? '').not.toMatch(/animation\s*:\s*none/);
  expect(Number(await heading.evaluate(element => getComputedStyle(element).opacity))).toBeCloseTo(opacityBefore, 3);
  expect(await heading.evaluate(element => getComputedStyle(element).transform)).toBe(transformBefore);
  // Preview is silent: no sound player was ever instantiated.
  expect(await audioStates(page)).toEqual([]);
  expect(errors).toEqual([]);

  // A second preview starts cleanly from second 0: its frame matches the first preview's t=0 frame.
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect.poll(async () => Number(await page.getByLabel('Timeline preview time').inputValue())).toBeCloseTo(0, 5);
  await waitForFrames(page);
  expect(await canvasDiff(page, zeroFrame, await page.locator('canvas').screenshot())).toBeLessThan(0.5);
  await page.getByLabel('Timeline preview time').fill('1.5');
  await waitForFrames(page);
  expect(Number(await heading.evaluate(element => getComputedStyle(element).opacity))).toBeCloseTo(0.5, 1);
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await waitForFrames(page);
  expect(await heading.getAttribute('style')).toBe(styleBefore);
  expect(Number(await heading.evaluate(element => getComputedStyle(element).opacity))).toBeCloseTo(opacityBefore, 3);
  // After the second close the model is back at its initial pose again.
  expect(await canvasDiff(page, baseline, await page.locator('canvas').screenshot())).toBeLessThan(0.5);
  expect(errors).toEqual([]);
});

test('stopping formal playback resets model pose, releases sound players and restores web styles', async ({ page }) => {
  const errors = collectErrors(page);
  await setupTrackedScene(page);
  const heading = page.getByRole('heading', { name: 'Reset heading' });
  const opacityBefore = Number(await heading.evaluate(element => getComputedStyle(element).opacity));
  const transformBefore = await heading.evaluate(element => getComputedStyle(element).transform);

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => clipPosition(page)).toBeGreaterThan(0.25);
  await expect.poll(() => headingOpacity(page)).toBeLessThan(opacityBefore - 0.05);
  expect(await heading.evaluate(element => getComputedStyle(element).transform)).not.toBe(transformBefore);
  const firstRunCount = (await audioStates(page)).length;
  expect(firstRunCount).toBeGreaterThan(0);
  await expect.poll(() => someAudioPlaying(page)).toBe(true);

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  // Model animation time is back at zero and stays there.
  await expect.poll(() => modelPosition(page)).toBeCloseTo(0, 5);
  const styleAfter = await heading.getAttribute('style');
  expect(styleAfter ?? '').not.toContain('translate');
  expect(styleAfter ?? '').not.toMatch(/animation\s*:\s*none/);
  expect(Number(await heading.evaluate(element => getComputedStyle(element).opacity))).toBeCloseTo(opacityBefore, 3);
  expect(await heading.evaluate(element => getComputedStyle(element).transform)).toBe(transformBefore);
  // Sound players are paused and fully released: no src attribute and no live media resource.
  await expectAllAudioReleased(page, firstRunCount);
  expect(errors).toEqual([]);

  // A second playback run starts from second 0 with fresh players; released ones stay dead.
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => clipPosition(page)).toBeGreaterThan(0.25);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => modelPosition(page)).toBeCloseTo(0, 5);
  const finalCount = (await audioStates(page)).length;
  expect(finalCount).toBeGreaterThan(firstRunCount);
  // Players from both runs are paused and fully released; none keeps a src or keeps playing.
  await expectAllAudioReleased(page, finalCount);
  expect(errors).toEqual([]);
});

test('closing preview without any media or channels does not throw', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByLabel('Timeline preview time').fill('2.5');
  await waitForFrames(page);
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await waitForFrames(page);
  expect(errors).toEqual([]);

  // A timeline that only carries a web channel also closes cleanly.
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByLabel('Timeline channel').selectOption('web.opacity');
  await page.getByRole('button', { name: 'Add channel' }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByLabel('Timeline preview time').fill('2.5');
  await waitForFrames(page);
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await waitForFrames(page);
  expect(errors).toEqual([]);
});
