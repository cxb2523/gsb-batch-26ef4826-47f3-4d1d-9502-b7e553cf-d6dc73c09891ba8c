/**
 * Installs the real-WASM loader for the end-to-end worklet test.
 *
 * Usage: node --import ./test/support/register-real-loader.mjs \
 *          --test test/worklet-wasm.e2e.mjs
 */
import { register } from "node:module";

register("./real-loader.mjs", import.meta.url);
