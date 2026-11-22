/**
 * Stock simulation checks, shared by the Node entry point (check.mjs) and the browser page
 * (check.html via browser.js). No Node or DOM APIs: the viewer's classes are passed in, so
 * the same assertions run on exactly the code the viewer loads, in either place.
 */

/** Parse G-code text with the viewer's parser (globals: { GCodeParser }) */
export async function parse(globals, text) {
    const parser = new globals.GCodeParser();
    const segments = await parser.parseString(text);
    return { parser, segments };
}

export const heightEqual = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
};

export function firstDifference(a, b, sim) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return {
                vertex: i,
                x: +(sim.stock.xmin + (i % sim.vx) * sim.dx).toFixed(4),
                y: +(sim.stock.ymin + Math.floor(i / sim.vx) * sim.dy).toFixed(4),
                a: a[i], b: b[i], delta: +(a[i] - b[i]).toFixed(6)
            };
        }
    }
    return null;
}

/**
 * Run the checks on one parsed job. Returns { name, pass, checks, failures }.
 * @param {Object} globals - { StockSimulator } (and GCodeParser, for checkText)
 * @param {string} name
 * @param {Array} segments - this job's moves
 * @param {Map} tools - T number -> tool definition (parser.simMeta.tools)
 * @param {Object} stock - { xmin, xmax, ymin, ymax, zmin, zmax }
 * @param {Object} [options] - { maxCells, prior: [{ segments, tools }] }
 */
export async function checkJob(globals, name, segments, tools, stock, options = {}) {
    const { StockSimulator } = globals;
    const maxCells = options.maxCells || 40000;
    const prior = options.prior || [];
    const checks = [];
    const failures = [];

    const make = (settings = {}) => {
        const sim = new StockSimulator(stock, tools, { maxCells });
        sim.setPriorJobs(settings.prior || prior);
        sim.setHiddenTools(settings.hidden || []);
        sim.setSegments(segments);
        return sim;
    };
    const heights = (sim) => Array.from(sim.heights);
    const expect = (label, ok, detail) => {
        checks.push({ label, ok });
        if (!ok) failures.push(detail ? { check: label, ...detail } : { check: label });
        return ok;
    };
    const sameAs = (label, live, reference, sim) => {
        const a = heights(live), b = heights(reference);
        return expect(label, heightEqual(a, b), heightEqual(a, b) ? null : {
            firstDifference: firstDifference(a, b, sim)
        });
    };

    // Tools that cut, and one to hide: the first to cut, so it cuts early in the job
    const cutting = [...new Set(segments.filter(s => s.type === 'cut').map(s => s.tool || 0))];
    const hiddenTool = cutting.length > 1 ? cutting[0] : null;
    const total = segments.length;
    // A frame position past some cutting by a tool that stays visible: there the stock is
    // cut, so a settings change that reset the carving would show uncut stock
    const otherCut = segments.findIndex(s => s.type === 'cut' && (s.tool || 0) !== hiddenTool);
    const mid = otherCut >= 0
        ? Math.min(total, Math.max(otherCut + 1, Math.floor(total * 0.55)))
        : Math.floor(total * 0.55);
    const midProgress = 0.35;

    // 1. Hide a tool, then show it again: same as never hiding it
    if (hiddenTool !== null) {
        const base = make({});
        base.advanceTo(total);
        const shown = heights(base);

        const toggled = make({});
        toggled.advanceTo(total);
        toggled.setHiddenTools([hiddenTool]);
        toggled.advanceTo(total);
        const hiddenHeights = heights(toggled);

        // The hidden tool's cuts must not remain: hide it from the start and compare
        const never = make({ hidden: [hiddenTool] });
        never.advanceTo(total);
        sameAs(`hidden tool T${hiddenTool}: matches carving with it hidden from the start`,
            toggled, never, never);

        toggled.setHiddenTools([]);
        toggled.advanceTo(total);
        sameAs(`show T${hiddenTool} again: matches never hiding it`, toggled, base, base);

        expect(`hidden tool T${hiddenTool}: its cuts are gone while hidden`,
            !heightEqual(hiddenHeights, shown));
    } else {
        checks.push({ label: '(only one cutting tool: the hide/show check is skipped)', ok: true });
    }

    // 2. Change the settings part way through: same as carving straight there
    if (hiddenTool !== null) {
        const frameTarget = mid, frameProgress = midProgress;
        const changed = make({});
        changed.advanceTo(Math.floor(total * 0.3), Infinity, midProgress);
        changed.advanceTo(frameTarget, Infinity, frameProgress);
        changed.setHiddenTools([hiddenTool]);
        changed.setPriorJobs(prior);

        // Right away, with no further advanceTo (as the renderer sees it on that frame)
        const direct = make({ hidden: [hiddenTool] });
        direct.advanceTo(frameTarget, Infinity, frameProgress);
        sameAs('a settings change carves straight to the current position (no reset shown)',
            changed, direct, direct);

        changed.advanceTo(mid, Infinity, midProgress);
        sameAs('settings changed mid-animation: matches carving straight to that position',
            changed, direct, direct);
        expect('settings changed mid-animation: carving progress is at the animation position',
            changed.carvedIndex === direct.carvedIndex,
            { got: changed.carvedIndex, want: direct.carvedIndex });

        // 3. The dirty region covers only what changed
        changed.clearDirty();
        // The renderer's copy of the stock, as it has it now
        const shownBefore = heights(changed);
        changed.setHiddenTools([]);
        const changedRows = [], changedCols = [];
        for (let j = 0; j < changed.vy; j++) {
            for (let i = 0; i < changed.vx; i++) {
                if (changed.heights[j * changed.vx + i] !== shownBefore[j * changed.vx + i]) {
                    changedRows.push(j);
                    changedCols.push(i);
                }
            }
        }
        const wantJ0 = changedRows.length ? Math.min(...changedRows) : Infinity;
        const wantJ1 = changedRows.length ? Math.max(...changedRows) : -Infinity;
        const wantI0 = changedCols.length ? Math.min(...changedCols) : Infinity;
        const wantI1 = changedCols.length ? Math.max(...changedCols) : -Infinity;
        expect('dirty region starts at the first changed row and column',
            changed.dirtyMin === wantJ0 && changed.dirtyMinI === wantI0,
            { got: [changed.dirtyMin, changed.dirtyMinI], want: [wantJ0, wantI0] });
        expect('dirty region ends at the last changed row and column',
            changed.dirtyMax === wantJ1 && changed.dirtyMaxI === wantI1,
            { got: [changed.dirtyMax, changed.dirtyMaxI], want: [wantJ1, wantI1] });
        expect('dirty region is smaller than the whole grid',
            changed.isDirty && (changed.dirtyMax - changed.dirtyMin) < changed.vy - 1,
            { got: [changed.dirtyMin, changed.dirtyMax], gridRows: changed.vy });

        // What the stock shows right after the change is the position the animation is at,
        // not the carved start it would show if the change reset it
        changed.clearDirty();
        changed.setHiddenTools([hiddenTool]);
        const directHidden = make({ hidden: [hiddenTool] });
        directHidden.advanceTo(mid, Infinity, midProgress);
        sameAs('a settings change leaves the stock at the animation position, not reset',
            changed, directHidden, directHidden);
    }

    // 4. A move carved in steps is carved as one carved in a single go
    {
        const live = make({});
        const step = Math.max(1, Math.floor(total * 0.25));
        live.advanceTo(step, Infinity, 0.2);
        live.advanceTo(step, Infinity, 0.55);
        live.advanceTo(step, Infinity, 0.9);
        live.advanceTo(step + 1, Infinity, 0);

        const once = make({});
        once.advanceTo(step, Infinity, 0.9);
        once.advanceTo(step + 1, Infinity, 0);

        sameAs('a move carved part way in steps matches a single carve to the same point',
            live, once, once);
    }

    // 5. Earlier jobs: adding them part way matches building the stock with them
    if (prior.length > 0) {
        const changed = make({ prior: [] });
        changed.advanceTo(mid, Infinity, midProgress);
        changed.setPriorJobs(prior);
        changed.advanceTo(mid, Infinity, midProgress);
        const direct = make({ prior });
        direct.advanceTo(mid, Infinity, midProgress);
        sameAs('earlier jobs added mid-animation: match building the stock with them',
            changed, direct, direct);
        expect('earlier jobs added mid-animation: carving progress is at the animation position',
            changed.carvedIndex === direct.carvedIndex,
            { got: changed.carvedIndex, want: direct.carvedIndex });

        const removed = make({ prior });
        removed.advanceTo(mid, Infinity, midProgress);
        removed.setPriorJobs([]);
        removed.advanceTo(mid, Infinity, midProgress);
        const without = make({ prior: [] });
        without.advanceTo(mid, Infinity, midProgress);
        sameAs('earlier jobs removed mid-animation: match building the stock without them',
            removed, without, without);
    }

    return { name, pass: failures.length === 0, checks, failures };
}

/**
 * Check one G-code text with the given viewer globals (used by both entry points).
 * @returns {Promise<Object>} the job's report entry
 */
export async function checkText(globals, name, text, options = {}) {
    const { parser, segments } = await parse(globals, text);
    const meta = parser.simMeta;
    if (!meta.stock || segments.length === 0) {
        return { name, pass: false, checks: [], failures: [{ check: 'no Stock header or no moves' }] };
    }
    return checkJob(globals, name, segments, meta.tools, meta.stock,
        { maxCells: options.maxCells || 40000, prior: options.prior || [] });
}

/**
 * A stand-in WebGL context: every buffer it hands out is counted, so the check can see
 * whether a rebuilt StockMeshRenderer deleted the old one's buffers or just dropped them.
 */
export function fakeGL() {
    const live = new Set();
    let created = 0;
    const gl = {
        ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, STATIC_DRAW: 3, DYNAMIC_DRAW: 4,
        FLOAT: 5, UNSIGNED_BYTE: 6, BYTE: 7, UNSIGNED_SHORT: 8,
        VERTEX_SHADER: 9, FRAGMENT_SHADER: 10, COMPILE_STATUS: 11, LINK_STATUS: 12,
        TRIANGLES: 13, LINES: 14, POLYGON_OFFSET_FILL: 15,
        createBuffer: () => { const b = { id: ++created }; live.add(b); return b; },
        deleteBuffer: (b) => live.delete(b),
        createShader: () => ({}),
        shaderSource() {}, compileShader() {},
        getShaderParameter: () => true,
        getShaderInfoLog: () => '',
        createProgram: () => ({}),
        attachShader() {}, linkProgram() {},
        getProgramParameter: () => true,
        getProgramInfoLog: () => '',
        getAttribLocation: () => 0,
        getUniformLocation: () => ({}),
        useProgram() {}, uniformMatrix4fv() {}, uniform1f() {}, uniform2f() {}, uniform3f() {},
        enableVertexAttribArray() {}, disableVertexAttribArray() {}, vertexAttribPointer() {},
        bindBuffer() {}, bufferData() {}, bufferSubData() {}, drawArrays() {}, drawElements() {},
        enable() {}, disable() {}, polygonOffset() {}, deleteProgram() {}
    };
    Object.defineProperty(gl, 'liveBuffers', { get: () => live.size });
    gl.isLive = (buffer) => live.has(buffer);
    return gl;
}

/**
 * Rebuilding the simulator must free the old one's tiles and its tool and box meshes;
 * destroy() must free everything (checked with fakeGL's buffer count).
 * @returns {Object} { name, pass, checks, failures } like a job's report entry
 */
export function checkResourceLifecycle(StockMeshRenderer, StockSimulator) {
    const checks = [];
    const failures = [];
    const expect = (label, ok, detail) => {
        checks.push({ label, ok });
        if (!ok) failures.push(detail ? { check: label, ...detail } : { check: label });
    };

    const gl = fakeGL();
    const camera = {
        getBasis: () => ({
            back: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 0, z: 1 }, right: { x: 1, y: 0, z: 0 }
        })
    };
    const mvp = new Float32Array(16);
    const stock = { xmin: 0, xmax: 20, ymin: 0, ymax: 20, zmin: -5, zmax: 0 };
    const tools = new Map([[1, { shape: 'flat', diameter: 4 }], [2, { shape: 'ball', diameter: 6 }]]);
    const segments = [
        { type: 'cut', tool: 1, toolNumber: 1, start: { x: 2, y: 2, z: 0 }, end: { x: 18, y: 18, z: -2 } },
        { type: 'cut', tool: 2, toolNumber: 2, start: { x: 2, y: 18, z: 0 }, end: { x: 18, y: 2, z: -2 } }
    ];

    const renderer = new StockMeshRenderer(gl);
    const makeSim = () => {
        const sim = new StockSimulator(stock, tools, { maxCells: 2000 });
        sim.setSegments(segments);
        sim.advanceTo(segments.length);
        return sim;
    };
    // A renderer's own buffers (the skirt) are made in its constructor, so measure from
    // there: what the simulator adds must come back off when it's replaced or destroyed
    const base = gl.liveBuffers;

    const first = makeSim();
    renderer.setSimulator(first);
    renderer.draw(mvp, camera, 'light');
    renderer.drawTool(mvp, camera, { x: 5, y: 5, z: 0 }, first.tools.get(2), [1, 1, 1], 0);
    renderer.drawBox(mvp, camera, { x: 0, y: 0, z: 0 }, [5, 5, 1], [1, 1, 1]);
    const afterFirst = gl.liveBuffers;
    expect('a drawn simulator allocates tiles and solid meshes', afterFirst > base,
        { got: afterFirst, base });
    // The first simulator's own buffers, to check they're deleted (not just dropped)
    const oldTiles = renderer.tiles.map(t => [t.z, t.normal]);
    const oldSolids = [...renderer.toolMeshes.values(), ...renderer.boxMeshes.values()]
        .map(mesh => [mesh.position, mesh.normal]);
    const oldBuffers = [...oldTiles.flat(), ...oldSolids.flat()];

    const second = makeSim();
    renderer.setSimulator(second);
    // Every buffer of the old simulator is gone; the new one has its own tiles and no
    // solid meshes yet (they're built when drawn, from the new tools)
    expect('rebuilding the simulator frees the old tiles and tool and box meshes',
        oldBuffers.every(b => !gl.isLive(b)),
        { oldStillLive: oldBuffers.filter(b => gl.isLive(b)).length, of: oldBuffers.length });
    expect('rebuilding the simulator drops the old tile and mesh references',
        renderer.sim === second && renderer.tiles.length > 0 &&
        !renderer.toolMeshes && !renderer.boxMeshes,
        { tiles: renderer.tiles.length, toolMeshes: !!renderer.toolMeshes, boxMeshes: !!renderer.boxMeshes });
    renderer.draw(mvp, camera, 'light');
    renderer.drawTool(mvp, camera, { x: 5, y: 5, z: 0 }, second.tools.get(1), [1, 1, 1], 0);
    renderer.drawBox(mvp, camera, { x: 0, y: 0, z: 0 }, [5, 5, 1], [1, 1, 1]);
    expect('the rebuilt simulator draws with its own solid meshes',
        renderer.toolMeshes.size > 0 && renderer.boxMeshes.size > 0,
        { toolMeshes: renderer.toolMeshes.size, boxMeshes: renderer.boxMeshes.size });

    renderer.destroy();
    expect('destroy releases every buffer the renderer made', gl.liveBuffers === 0,
        { got: gl.liveBuffers });
    return { name: 'resource lifecycle', pass: failures.length === 0, checks, failures };
}
