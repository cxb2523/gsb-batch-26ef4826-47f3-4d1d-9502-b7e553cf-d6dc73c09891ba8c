/**
 * Installs the loader hooks used by `node --test`.
 *
 * Usage: node --import ./test/support/register-loader.mjs --test test/
 */
import { register } from "node:module";

register("./worklet-loader.mjs", import.meta.url);
