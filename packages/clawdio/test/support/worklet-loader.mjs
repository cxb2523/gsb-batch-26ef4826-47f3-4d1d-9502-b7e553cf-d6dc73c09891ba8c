/**
 * Module loader used by the worklet tests.
 *
 * Two jobs:
 * 1. Map the bare `clawdio-bitcrusher` / `clawdio-moog` specifiers to local
 *    stubs, so the tests can run without building WASM or installing the
 *    published packages.
 * 2. Resolve extensionless relative imports (`./types`, `./utils`) to the
 *    actual `.ts` sources, the way Vite does for the worklet bundle.
 */
const WORKLET_ROOT = new URL("../../src/workers/", import.meta.url);

const stubs = {
  "clawdio-bitcrusher": new URL("./stub-bitcrusher.mjs", import.meta.url).href,
  "clawdio-moog": new URL("./stub-moog.mjs", import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  if (stubs[specifier]) {
    return { url: stubs[specifier], shortCircuit: true };
  }

  if (specifier.startsWith(".") && context.parentURL?.startsWith(WORKLET_ROOT.href)) {
    // Only add an extension when the file is in our workers directory and the
    // specifier doesn't already carry one.
    const hasExtension = /\.(ts|js|mjs)$/.test(specifier);
    if (!hasExtension) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      return { url: candidate.href, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
