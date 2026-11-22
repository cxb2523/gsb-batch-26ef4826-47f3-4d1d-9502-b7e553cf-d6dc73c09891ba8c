/**
 * Loader for the end-to-end worklet test.
 *
 * Unlike `worklet-loader.mjs` this does NOT stub the WASM packages: bare
 * `clawdio-bitcrusher` / `clawdio-moog` imports resolve to the workspace copies
 * in `node_modules` (symlinked to `modules/<name>/pkg`). It only teaches Node
 * to resolve the worklets' extensionless relative imports.
 */
const WORKLET_ROOT = new URL("../../src/workers/", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.startsWith(".") &&
    context.parentURL?.startsWith(WORKLET_ROOT.href) &&
    !/\.(ts|js|mjs)$/.test(specifier)
  ) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    return { url: candidate.href, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
