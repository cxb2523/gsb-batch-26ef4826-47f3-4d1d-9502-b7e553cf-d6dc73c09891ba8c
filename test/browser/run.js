/* eslint-disable no-console */

/**
 * Bundles and runs the browser lifecycle check (`test/browser/check.js`) in
 * a real local Chrome/Chromium.
 *
 * Chrome's DevTools transport is unavailable in some sandboxes, so the check
 * is run with `--dump-dom` under a virtual-time budget instead: the page drives
 * a scripted sequence of graph mutations and writes a PASS/FAIL report into
 * `#report`, which this script parses. The bundle is written next to a
 * temporary copy of `index.html` and loaded over `file://`, which keeps the
 * check independent of any HTTP server.
 *
 * Usage:
 *   npm run test:browser
 *   CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" npm run test:browser
 *
 * `npm test` covers the same lifecycle (plus the scheduled-source rebuild)
 * against a deterministic Web Audio mock and does not need a browser.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const webpack = require('webpack');

const repoRoot = path.resolve(__dirname, '..', '..');

const CHROME = process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

const build = workdir => new Promise((resolve, reject) => {
  const config = {
    mode: 'development',
    devtool: false,
    context: path.resolve(repoRoot),
    entry: path.join(__dirname, 'check.js'),
    output: {
      path: workdir,
      filename: 'bundle.js'
    },
    resolve: { modules: [ path.join(repoRoot, 'node_modules') ] },
    module: {
      rules: [
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: 'babel-loader?presets[]=react,env'
        }
      ]
    }
  };

  webpack(config, (err, stats) => {
    if (err) return reject(err);

    const info = stats.toJson();
    if (stats.hasErrors()) return reject(new Error(info.errors.join('\n')));
    resolve();
  });
});

const decode = html => html
  .replace(/&gt;/g, '>')
  .replace(/&lt;/g, '<')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"');

const run = async () => {
  if (!fs.existsSync(CHROME)) {
    throw new Error(`Chrome not found at ${CHROME}. Set CHROME_PATH to a Chrome/Chromium binary.`);
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'raudio-browser-check-'));
  fs.copyFileSync(path.join(__dirname, 'index.html'), path.join(workdir, 'index.html'));

  await build(workdir);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raudio-chrome-profile-'));
  const pageUrl = pathToFileURL(path.join(workdir, 'index.html')).href;

  let dom;
  try {
    dom = execFileSync(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--allow-file-access-from-files',
      `--user-data-dir=${profile}`,
      '--autoplay-policy=no-user-gesture-required',
      '--virtual-time-budget=10000',
      '--dump-dom',
      pageUrl
    ], { encoding: 'utf8', timeout: 45000, stdio: [ 'ignore', 'pipe', 'ignore' ] });
  } finally {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }

  const match = dom.match(/<pre id="report">([\s\S]*?)<\/pre>/);
  if (!match) throw new Error('Could not find the report in the rendered DOM');

  const report = decode(match[1]);
  console.log(report);

  if (!/RESULT ok/.test(report)) process.exitCode = 1;
};

run().catch(e => {
  console.error(e.message || e);
  process.exitCode = 1;
});
