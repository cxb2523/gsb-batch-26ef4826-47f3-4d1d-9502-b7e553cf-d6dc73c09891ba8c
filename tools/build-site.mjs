/**
 * Build the playable page's JavaScript from the TypeScript sources.
 *
 * The browser gets plain ES modules, one .js file per .ts file, with the same
 * relative layout under `examples/site/game/src/`. Relative import specifiers
 * ending in `.ts` are rewritten to `.js`. No bundler, no dependencies: this
 * uses Node's built-in TypeScript type stripping plus a small specifier
 * rewrite, which is all these files need (their syntax is "erasable" — no
 * enums, no parameter properties, no namespaces).
 *
 * Usage: node tools/build-site.mjs
 */

import { stripTypeScriptTypes } from 'node:module';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const srcRoot = join(repoRoot, 'src');
const siteRoot = join(repoRoot, 'examples', 'site');
const outRoot = join(siteRoot, 'game', 'src');

const SKIP = new Set(['index.ts', 'types.ts']);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.ts')) yield full;
  }
}

function rewriteSpecifiers(code) {
  // `from './x.ts'` and bare `import './x.ts'` both need the extension swap.
  return code.replace(/(from\s+|import\s+)(['"])([^'"]+)\.ts\2/g, (_m, prefix, quote, spec) => {
    return `${prefix}${quote}${spec}.js${quote}`;
  });
}

async function transpile(sourcePath, outPath) {
  const source = await readFile(sourcePath, 'utf8');
  const transformed = stripTypeScriptTypes(source, { mode: 'transform' });
  const js = rewriteSpecifiers(transformed);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, js, 'utf8');
}

async function main() {
  await rm(outRoot, { recursive: true, force: true });
  let count = 0;
  for await (const file of walk(srcRoot)) {
    const rel = relative(srcRoot, file);
    if (SKIP.has(rel.replaceAll('\\', '/'))) continue;
    await transpile(file, join(outRoot, rel.replace(/\.ts$/, '.js')));
    count++;
  }
  // The browser entry lives next to the page, so the .ts sources it imports
  // resolve to the same copied tree.
  const mainPath = join(siteRoot, 'game', 'main.ts');
  await transpile(mainPath, join(siteRoot, 'game', 'main.js'));
  count++;
  console.log(`build-site: wrote ${count} modules to ${relative(repoRoot, outRoot)}`);
}

await main();
