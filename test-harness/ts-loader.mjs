/**
 * Node ESM loader for the test harness:
 * 1. Resolves extensionless relative imports (./PulseChannel) to .ts files.
 * 2. Lets Node's built-in type stripping handle the .ts source.
 * 3. Adds CJS named-export interop for dependencies like @tonejs/midi whose
 *    UMD/CommonJS build sets `exports.Midi` but ships no ESM wrapper, so
 *    `import { Midi } from '@tonejs/midi'` resolves under Node.
 *
 * Node 24 strips TypeScript types natively; it only needs help resolving the
 * repo's extensionless import specifiers (Vite resolves those in the browser).
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  // Only intercept relative specifiers without an extension.
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !/\.[a-zA-Z0-9]+$/.test(specifier)
  ) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : '';
    const base = pathResolve(dirname(parentPath), specifier);
    const candidates = [base + '.ts', pathResolve(base, 'index.ts')];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return {
          url: pathToFileURL(candidate).href,
          shortCircuit: true,
        };
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  // Intercept the bare @tonejs/midi specifier (resolved to a file: URL) and
  // wrap its CJS module so its named exports are visible to ESM importers.
  // The generated module uses createRequire (available via node:module) so it
  // works regardless of which loader thread evaluates it.
  if (url.includes('@tonejs/midi/build/Midi.js')) {
    const mod = require('@tonejs/midi');
    const names = Object.keys(mod).filter((k) => k !== 'default' && k !== '__esModule');
    const source = [
      "import { createRequire } from 'node:module';",
      "const _require = createRequire(process.cwd() + '/');",
      "const _mod = _require('@tonejs/midi');",
      ...names.map((k) => `export const ${k} = _mod[${JSON.stringify(k)}];`),
      'export default _mod;',
    ].join('\n');
    return {
      format: 'module',
      source,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
