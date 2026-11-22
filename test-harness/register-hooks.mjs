/**
 * Registers the extensionless-TS loader for the test run.
 * Usage: node --import ./test-harness/register-hooks.mjs --test ...
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(resolve(here, 'ts-loader.mjs')).href);
