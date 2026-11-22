import assert from "node:assert/strict";
import { PerspectiveCamera } from "three";
import { uniform } from "three/tsl";
import { test } from "vitest";
import GTVBAONode from "../src/GTVBAONode.js";
import { GTVBAO_PRESETS, applyGtvbaoPreset } from "../src/GTVBAOPresets.js";

type Disposable = { addEventListener(type: "dispose", listener: () => void): void };
type MaterialLike = Disposable & { version: number };
type RenderTargetLike = Disposable & { width: number; height: number };
type MipNode = { value: Disposable & { image: { width: number; height: number } } };

type Internals = {
  _aoRenderTarget: RenderTargetLike;
  _debugRenderTarget: RenderTargetLike;
  _resolution: { value: { x: number; y: number } };
  _depthPrefilter: { _textures: unknown[] };
  _materials: Map<string, MaterialLike>;
  _material: MaterialLike;
  _fragmentContext: object | null;
  _refreshMaterialFragmentNode(): void;
};

function createNode() {
  return new GTVBAONode(uniform(1) as never, null, new PerspectiveCamera());
}

function internalsOf(node: GTVBAONode) {
  return node as unknown as Internals;
}

function mipSizes(node: GTVBAONode) {
  const nodes = node.getDepthMipNodes() as unknown as MipNode[];
  return nodes.map(({ value }) => [value.image.width, value.image.height]);
}

// The AO target, the debug target, the depth prefilter and _resolution must
// always agree on one AO size; the inactive target stays at 1x1.
function assertLayout(node: GTVBAONode, aoWidth: number, aoHeight: number, debugActive = false) {
  const internals = internalsOf(node);
  const active = debugActive ? internals._debugRenderTarget : internals._aoRenderTarget;
  const inactive = debugActive ? internals._aoRenderTarget : internals._debugRenderTarget;
  assert.equal(active.width, aoWidth, "active target width");
  assert.equal(active.height, aoHeight, "active target height");
  assert.equal(inactive.width, 1, "inactive target width");
  assert.equal(inactive.height, 1, "inactive target height");
  assert.deepEqual(mipSizes(node)[0], [aoWidth, aoHeight], "depth MIP level 0");
  assert.equal(internals._resolution.value.x, aoWidth, "_resolution.x");
  assert.equal(internals._resolution.value.y, aoHeight, "_resolution.y");
}

test("GTVBAONode keeps AO, debug target, depth MIPs and _resolution in sync across preset switches", () => {
  const node = createNode();
  node.setSize(640, 360);
  assertLayout(node, 640, 360);

  // Balanced renders at half resolution; the preset change resizes everything.
  applyGtvbaoPreset(node, "Balanced");
  assert.equal(node.resolutionScale, 0.5);
  assertLayout(node, 320, 180);
  // The next setSize must not early-return on the stale _lastSize.
  node.setSize(640, 360);
  assertLayout(node, 320, 180);

  applyGtvbaoPreset(node, "High");
  assert.equal(node.resolutionScale, 1);
  assertLayout(node, 640, 360);
  node.setSize(640, 360);
  assertLayout(node, 640, 360);

  // The GUI writes resolutionScale directly; the round trip stays consistent.
  node.resolutionScale = 0.5;
  assertLayout(node, 320, 180);
  node.setSize(640, 360);
  assertLayout(node, 320, 180);
  node.resolutionScale = 1;
  assertLayout(node, 640, 360);
  node.setSize(640, 360);
  assertLayout(node, 640, 360);

  node.dispose();
});

test("GTVBAONode returns the inactive target to 1x1 on every debug view switch", () => {
  const node = createNode();
  node.setSize(640, 360);

  for (const debugMode of [2, 1, 5]) {
    node.debugMode.value = debugMode;
    // The switch is eager: no setSize is needed to rebalance the targets.
    assertLayout(node, 640, 360, true);
    node.setSize(640, 360);
    assertLayout(node, 640, 360, true);

    node.debugMode.value = 0;
    assertLayout(node, 640, 360);
    node.setSize(640, 360);
    assertLayout(node, 640, 360);
  }

  // The debug target follows the AO resolution, not the full resolution.
  node.resolutionScale = 0.5;
  node.setSize(640, 360);
  node.debugMode.value = 3;
  assertLayout(node, 320, 180, true);
  node.debugMode.value = 0;
  assertLayout(node, 320, 180);

  node.dispose();
});

test("GTVBAONode dispose releases every cached material, render target and depth MIP texture", () => {
  const node = createNode();
  const internals = internalsOf(node);
  // Simulate the post-setup() state so variant changes build cached materials.
  internals._fragmentContext = {};
  internals._refreshMaterialFragmentNode();
  node.stepCount.value = 5;
  node.stepCount.value = 7;
  node.setSize(320, 180);

  const disposed = new Set<Disposable>();
  const track = (resource: Disposable) => resource.addEventListener("dispose", () => disposed.add(resource));
  const materials = new Set([...internals._materials.values()]);
  materials.add(internals._material);
  for (const material of materials) track(material);
  track(internals._aoRenderTarget);
  track(internals._debugRenderTarget);
  const mipTextures = (node.getDepthMipNodes() as unknown as MipNode[]).map(({ value }) => value);
  assert.equal(internals._depthPrefilter._textures.length, 5);
  for (const texture of mipTextures) track(texture);

  node.dispose();

  for (const material of materials) assert.ok(disposed.has(material), "material disposed");
  assert.ok(disposed.has(internals._aoRenderTarget), "AO target disposed");
  assert.ok(disposed.has(internals._debugRenderTarget), "debug target disposed");
  for (const texture of mipTextures) assert.ok(disposed.has(texture), "depth MIP texture disposed");
  assert.equal(internals._materials.size, 0);
  assert.equal(internals._depthPrefilter._textures.length, 0);

  // Disposal is idempotent.
  node.dispose();
});

test("GTVBAONode releases the depth prefilter while depth MIPs are off and rebuilds it at the current size", () => {
  const node = createNode();
  const internals = internalsOf(node);
  node.setSize(640, 360);
  assert.deepEqual(mipSizes(node)[0], [640, 360]);

  node.useDepthMips.value = false;
  // The release is eager, and the MIP nodes fall back to 1x1 placeholders.
  assert.equal(internals._depthPrefilter._textures.length, 0);
  assert.deepEqual(mipSizes(node), [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1]]);

  // Resize while disabled; the prefilter stays released.
  node.resolutionScale = 0.5;
  node.setSize(640, 360);
  assert.equal(internals._depthPrefilter._textures.length, 0);

  // Re-enabling rebuilds immediately at the new AO size, not the stale one.
  node.useDepthMips.value = true;
  assert.deepEqual(mipSizes(node), [[320, 180], [160, 90], [80, 45], [40, 23], [20, 12]]);
  node.setSize(640, 360);
  assert.deepEqual(mipSizes(node), [[320, 180], [160, 90], [80, 45], [40, 23], [20, 12]]);

  // Presets drive the same release/rebuild through useDepthMips.
  applyGtvbaoPreset(node, { ...GTVBAO_PRESETS.Balanced, useDepthMips: false });
  assert.equal(internals._depthPrefilter._textures.length, 0);
  applyGtvbaoPreset(node, "Balanced");
  assert.deepEqual(mipSizes(node), [[320, 180], [160, 90], [80, 45], [40, 23], [20, 12]]);

  node.dispose();
});
