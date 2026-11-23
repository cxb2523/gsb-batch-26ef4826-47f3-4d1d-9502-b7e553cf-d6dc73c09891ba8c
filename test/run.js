/**
 * Minimal test runner for the r-audio lifecycle tests.
 *
 * Runs `*.test.js` files from the `test/` directory. Each test module exports
 * an array of `{ name, fn }` objects; `fn` may be async. The runner prints a
 * TAP-like report and exits non-zero when a test fails.
 *
 * Usage: npm test
 */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

require('babel-register')({
  presets: [ 'env', 'react' ],
  babelrc: false
});

const run = async () => {
  const files = fs
    .readdirSync(__dirname)
    .filter(file => /\.test\.js$/.test(file))
    .sort();

  let passes = 0;
  let failures = 0;

  for (const file of files) {
    const tests = require(path.join(__dirname, file));
    const list = Array.isArray(tests) ? tests : [];

    for (const testCase of list) {
      try {
        await testCase.fn();
        passes++;
        console.log(`ok ${passes + failures} - ${file}: ${testCase.name}`);
      } catch (e) {
        failures++;
        console.log(`not ok ${passes + failures} - ${file}: ${testCase.name}`);
        console.log(String((e && e.stack) || e).replace(/^/gm, '  '));
      }
    }
  }

  console.log(`\n1..${passes + failures}`);
  console.log(`# pass ${passes}`);
  console.log(`# fail ${failures}`);

  if (failures) process.exitCode = 1;
};

run().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
