#!/usr/bin/env node
/**
 * Stock simulation consistency check.
 *
 * Runs the viewer's real parser and stock simulator (src/js/gcode-expander.js, parser.js,
 * stock-sim.js) on G-code in Node, and checks that the carved stock depends only on the
 * carving settings (hidden tools, earlier jobs) and the animation position, not on the
 * order things were changed in or moves carved part way beforehand:
 *
 *   1. Hiding a tool and showing it again gives the same heightmap as never hiding it,
 *      and a hidden tool's cuts don't stay on the stock.
 *   2. Changing the settings part way through the animation gives the same heightmap as
 *      carving straight to that position with the new settings (and the carving progress
 *      is at that position, not an old one).
 *   3. Only the vertices that actually changed are marked dirty after a settings change.
 *   4. A move carved part way in steps is carved exactly as one carved in a single go.
 *   5. Adding and removing earlier jobs part way matches building the stock with them.
 *   6. Rebuilding the simulator (or destroying it) frees its tiles and its tool and box
 *      meshes, checked with a fake WebGL context that counts live buffers.
 *
 * Usage:
 *   node tools/stock-sim-check/check.mjs [file.nc ...]
 *
 * With no files, examples/stock_sim_demo.nc is used, plus (if present) the viewer demo's
 * per-tool files, which chain with PriorJob comments.
 *
 * In a browser, open check.html: it loads the same scripts as the viewer does and runs the
 * same checks from checks.js.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    checkJob, checkResourceLifecycle, checkText, parse
} from './checks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');

/**
 * Load the viewer's browser scripts into a sandbox and return its classes, so the check
 * uses exactly the code the viewer runs. (Top-level `class` declarations don't become
 * properties of the sandbox object, so they're fetched explicitly afterwards.)
 */
export function loadViewer(root = repoRoot) {
    const context = vm.createContext({
        console,
        performance: { now: () => performance.now() }
    });
    const files = ['gcode-expander.js', 'parser.js', 'stock-sim.js'];
    for (const file of files) {
        const source = fs.readFileSync(path.join(root, 'src', 'js', file), 'utf8');
        vm.runInContext(source, context, { filename: file });
    }
    return vm.runInContext(
        '({ GCodeParser, StockSimulator, StockProbe, StockMeshRenderer, compileStockTool, guessStockToolFromName })',
        context);
}

/** Run every check on the given G-code files (or the default sample) and report. */
export async function runStockSimCheck(files = [], options = {}, globals = loadViewer(options.root || repoRoot)) {
    const report = [];
    const root = options.root || repoRoot;

    if (files.length === 0) {
        files = [path.join(root, 'examples', 'stock_sim_demo.nc')];
        if (fs.existsSync(files[0]) === false) {
            report.push({ name: files[0], pass: false, checks: [], failures: [{ check: 'sample file is missing' }] });
        }
    }

    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        report.push(await checkText(globals, file, text, { maxCells: options.maxCells }));
    }

    // The demo job (a chain of prior jobs), if it's there
    const demo = options.demo === false ? [] : demoJobs(root);
    const parsed = [];
    for (const job of demo) parsed.push(await parse(globals, job.text));
    for (let i = Math.max(1, demo.length - 2); i < demo.length; i++) {
        // Check the last two files, where the chain has a couple of earlier jobs
        const prior = parsed.slice(0, i).map(({ parser, segments }) => ({
            segments, tools: parser.simMeta.tools
        }));
        const { parser, segments } = parsed[i];
        report.push(await checkJob(globals, demo[i].file, segments, parser.simMeta.tools,
            parser.simMeta.stock, { maxCells: options.maxCells || 30000, prior }));
    }

    return report;
}

/**
 * The viewer demo's per-tool files chain with PriorJob comments: each is checked with the
 * files before it as earlier jobs.
 */
export function demoJobs(root = repoRoot) {
    const folder = path.join(root, 'examples', 'viewer-demo');
    if (!fs.existsSync(folder)) return [];
    const order = ['ViewerDemo_T1_flat.nc', 'ViewerDemo_T2_bullnose.nc', 'ViewerDemo_T3_ball.nc',
        'ViewerDemo_T4_vbit.nc', 'ViewerDemo_T5_drill.nc', 'ViewerDemo_T6_chamfer.nc',
        'ViewerDemo_T7_taperball.nc'];
    const jobs = [];
    for (const file of order) {
        const full = path.join(folder, file);
        if (!fs.existsSync(full)) continue;
        jobs.push({ file: `viewer-demo/${file}`, text: fs.readFileSync(full, 'utf8') });
    }
    return jobs;
}

/** Print a report in the Node console */
export function printReport(report) {
    let pass = true;
    for (const job of report) {
        const mark = job.pass ? 'PASS' : 'FAIL';
        console.log(`\n${mark}  ${job.name}`);
        for (const check of job.checks) console.log(`  ${check.ok ? '✓' : '✗'} ${check.label}`);
        for (const failure of job.failures) {
            pass = false;
            console.log(`  ✗ ${failure.check}`);
            if (failure.firstDifference) console.log(`      first difference: ${JSON.stringify(failure.firstDifference)}`);
            if (failure.got !== undefined) console.log(`      got ${JSON.stringify(failure.got)}, want ${JSON.stringify(failure.want)}`);
        }
        if (job.failures.length === 0) console.log(`  all ${job.checks.length} checks passed`);
    }
    console.log(pass ? '\nAll stock simulation checks passed.' : '\nSome stock simulation checks FAILED.');
    return pass;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
    const globals = loadViewer();
    runStockSimCheck(process.argv.slice(2), {}, globals).then(report => {
        report.push(checkResourceLifecycle(globals.StockMeshRenderer, globals.StockSimulator));
        const pass = printReport(report);
        process.exitCode = pass ? 0 : 1;
    }).catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
