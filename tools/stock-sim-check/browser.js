/* Stock simulation consistency check, in the browser.
 *
 * check.html loads the viewer's own scripts (gcode-expander.js, parser.js, stock-sim.js) as
 * plain globals, as the viewer does, and imports this module. The checks themselves are in
 * checks.js, shared with the Node entry point, so both run the same assertions on the same
 * code. This file only adds the browser-specific parts: fetching the G-code and the page.
 */

/** Where log lines go; check.html points this at the page */
export const logLine = { current: (text) => console.log(text) };

/**
 * Run the checks on a G-code URL, using the globals check.html loaded.
 * @param {string} gcodeUrl - a file with Stock/ToolDef headers (and PriorJob lines)
 * @returns {Promise<Array>} the report entries
 */
export async function runStockSimCheckBrowser(gcodeUrl) {
    if (typeof StockSimulator === 'undefined' || typeof GCodeParser === 'undefined') {
        throw new Error('The viewer scripts must be loaded before the check');
    }
    const { checkText } = await import('./checks.js');
    const response = await fetch(gcodeUrl);
    if (!response.ok) throw new Error(`${gcodeUrl}: ${response.status} ${response.statusText}`);
    const text = await response.text();
    const globals = { GCodeParser, StockSimulator, StockProbe, StockMeshRenderer };
    return [await checkText(globals, String(gcodeUrl), text, { maxCells: 40000 })];
}

/** The resource lifecycle check, on this page's classes */
export async function runResourceLifecycleCheckBrowser() {
    const { checkResourceLifecycle } = await import('./checks.js');
    return checkResourceLifecycle(StockMeshRenderer, StockSimulator);
}

/** Run everything and print it to the page's log */
export async function runAllBrowser(gcodeUrl, log = logLine.current) {
    const report = await runStockSimCheckBrowser(gcodeUrl);
    report.push(await runResourceLifecycleCheckBrowser());
    let pass = true;
    for (const job of report) {
        pass = pass && job.pass;
        log(`${job.pass ? 'PASS' : 'FAIL'}  ${job.name}`);
        for (const check of job.checks) log(`  ${check.ok ? '✓' : '✗'} ${check.label}`);
        for (const failure of job.failures) {
            log(`  ✗ ${failure.check}`);
            if (failure.firstDifference) log(`      first difference: ${JSON.stringify(failure.firstDifference)}`);
            if (failure.got !== undefined) log(`      got ${JSON.stringify(failure.got)}, want ${JSON.stringify(failure.want)}`);
        }
    }
    return { pass, report };
}
