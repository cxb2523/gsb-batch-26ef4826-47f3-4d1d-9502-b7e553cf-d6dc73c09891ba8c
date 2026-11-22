// Browser-side verification for Scritch's cancellable track switching.
//
// Run with:  node tests/verify-switching.mjs
//
// The script boots a local static server (tests/lib/harness.mjs), starts a
// headless Chrome over the DevTools protocol, and drives the real player.
// It needs no third-party packages and does not modify the repository.  If
// Chrome is not found automatically, set CHROME_PATH to a Chrome/Chromium
// executable.
//
// Scenarios covered:
//   1. Rapid consecutive track switches -- the old prefetch is aborted and
//      its object URL released; only the current track's address is applied.
//   2. Video <-> audio round trip -- the cover is hidden for video and the
//      correct per-track (or global) cover returns for audio, with the
//      preview progress bar/time reset.
//   3. A late prefetch response can never overwrite the current track, even
//      when it resolves after the switch has already happened (verified with
//      AbortController.abort disabled so the response genuinely arrives).
//   4. The progress bar cannot be rewritten while the user is dragging it,
//      including when a prefetch resolves mid-drag.

import { startServer, launchBrowser, sleep } from './lib/harness.mjs';

const results = [];
let failures = 0;

function check(name, condition, detail) {
    if (condition) {
        results.push({ name, ok: true });
        console.log(`  PASS  ${name}`);
    } else {
        failures++;
        results.push({ name, ok: false, detail });
        console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`);
    }
}

function eq(name, actual, expected) {
    check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// "12.3456%" -> 12.3456
function pct(value) {
    return parseFloat(String(value || '0').replace('%', '')) || 0;
}

// Poll a page-side predicate, re-using the harness's waitFor but with a label.
async function waitFor(page, fn, label, timeout = 12000) {
    return page.waitFor(fn, { label, timeout });
}

// --- page-side inspection helpers ------------------------------------------

const STATE = `(() => {
    const s = window.__scritchTest;
    return s ? s.state() : null;
})()`;

async function state(page) {
    return page.evaluate(STATE);
}

async function clickTrack(page, index) {
    await page.evaluate(`(() => { window.__scritchTest.clickTrack(${index}); })()`);
}

// --- test hooks injected into the page -------------------------------------
// Adds a small read-only introspection surface plus a scripted "drag" that
// dispatches the same pointer events the real UI listens for.

const TEST_HOOKS = `
(() => {
    const api = {
        state() {
            const cur = (typeof currentEntry !== 'undefined') ? currentEntry : null;
            const img = document.getElementById('mediaImage');
            const video = document.getElementById('mediaVideo');
            const scrubber = document.getElementById('scrubber');
            const fill = document.getElementById('scrubberFill');
            const timeEl = document.querySelector('#controls .time');
            let entries = [];
            try {
                entries = media.map(e => ({
                    title: e.title,
                    source: e.source,
                    file: e.file,
                    objectUrl: e.objectUrl || null,
                    hasObjectUrl: !!e.objectUrl,
                    inFlight: !!e.loadInFlight,
                    aborted: !!e.prefetchAborted,
                    hasController: !!e.prefetchController,
                    error: !!e.error,
                    type: e.type || 'audio',
                    cover: e.cover || null,
                    duration: e.duration,
                }));
            } catch (err) { /* media not defined yet */ }
            return {
                currentTitle: cur ? cur.title : null,
                currentType: cur ? (cur.type || 'audio') : null,
                currentFile: cur ? cur.file : null,
                currentSource: cur ? cur.source : null,
                currentObjectUrl: cur ? (cur.objectUrl || null) : null,
                started: cur ? !!cur.started : null,
                loading: cur ? !!cur.loading : null,
                playerSrc: document.getElementById('player').getAttribute('src'),
                videoSrc: video.getAttribute('src'),
                videoActive: video.classList.contains('active'),
                imageSrc: img.getAttribute('src'),
                imageVisible: img.style.visibility !== 'hidden',
                imageClassActive: img.classList.contains('active'),
                scrubberLeft: scrubber.style.left,
                scrubberWidth: fill.style.width,
                timeText: timeEl ? timeEl.innerHTML : null,
                scrubPosition: (typeof scrubPosition !== 'undefined') ? scrubPosition : null,
                dragging: (typeof scrubberDragged !== 'undefined') ? scrubberDragged : null,
                objectUrlCount: (window.__scritchTest && window.__scritchTest.urlLog) ? window.__scritchTest.urlLog.length : 0,
                urlLog: (window.__scritchTest && window.__scritchTest.urlLog) ? window.__scritchTest.urlLog.slice() : [],
                entries,
            };
        },
        clickTrack(i) {
            const trackEl = document.getElementById('tracks').children[i];
            if (!trackEl) throw new Error('no track ' + i);
            trackEl.querySelector('.main').dispatchEvent(new MouseEvent('click', {bubbles:true}));
            trackEl.querySelector('button').click();
        },
        // begin a drag at a fractional position [0..1] across the scrubber
        dragStart(fraction) {
            const c = document.getElementById('scrubberTrackContainer');
            const r = c.getBoundingClientRect();
            const x = r.left + Math.max(1, Math.min(r.width - 1, r.width * fraction));
            const y = r.top + r.height / 2;
            c.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, clientX:x, clientY:y, pointerId:1, pointerType:'mouse'}));
            return {x, y};
        },
        dragMove(fraction) {
            const c = document.getElementById('scrubberTrackContainer');
            const r = c.getBoundingClientRect();
            const x = r.left + Math.max(1, Math.min(r.width - 1, r.width * fraction));
            const y = r.top + r.height / 2;
            document.dispatchEvent(new PointerEvent('pointermove', {bubbles:true, clientX:x, clientY:y, pointerId:1, pointerType:'mouse'}));
            return {x, y};
        },
        dragEnd() {
            document.dispatchEvent(new PointerEvent('pointerup', {bubbles:true, pointerId:1, pointerType:'mouse'}));
        },
        // reset all fetch instrumentation
        resetUrls() {
            window.__scritchTest.urlLog.length = 0;
        },
        // Make AbortController.abort a no-op so a held fetch cannot actually
        // be cancelled; the response will genuinely arrive late and must be
        // rejected by the prefetch token guard instead.
        disableAbort() {
            window.__origAbort = AbortController.prototype.abort;
            AbortController.prototype.abort = function() {};
        },
        restoreAbort() {
            if (window.__origAbort) AbortController.prototype.abort = window.__origAbort;
        },
        // Query the real guard for a given entry/token pair.
        guard(entryIndex, token) {
            return prefetchIsLive(media[entryIndex], token);
        },
        entryToken(entryIndex) {
            return media[entryIndex].prefetchToken;
        },
        // Force a prefetch to resolve while a drag is in progress.  Reuses
        // the track's real (already valid) object URL and runs the real
        // source-application helper.  Returns whether it was deferred.
        applySourceNow(i) {
            const entry = media[i];
            entry.file = entry.objectUrl || entry.source;
            entry.appliedSrc = null;
            entry.pendingSrc = null;
            applyEntrySource(entry);
            return { pending: !!entry.pendingSrc, applied: entry.appliedSrc };
        },
        pendingSrc(i) {
            return media[i].pendingSrc || null;
        },
    };
    window.__scritchTest = Object.assign(window.__scritchTest || {}, api);
})();
`;

// Instrument fetch/createObjectURL/revokeObjectURL as early as possible so
// the test can see which requests were started and which URLs were released.
const INSTRUMENT = `
(() => {
    const log = [];
    window.__scritchTest = Object.assign(window.__scritchTest || {}, { urlLog: log });
    const origFetch = window.fetch;
    window.fetch = function(resource, options) {
        const url = typeof resource === 'string' ? resource : (resource && resource.url) || '';
        const entry = { phase: 'fetch:start', url, aborted: false, at: Date.now() };
        log.push(entry);
        const p = origFetch.apply(this, arguments);
        if (options && options.signal) {
            options.signal.addEventListener('abort', () => { entry.aborted = true; entry.abortedAt = Date.now(); });
        }
        return p;
    };
    const origCreate = URL.createObjectURL.bind(URL);
    const origRevoke = URL.revokeObjectURL.bind(URL);
    const created = new Set();
    URL.createObjectURL = function(blob) {
        const u = origCreate(blob);
        created.add(u);
        log.push({ phase: 'createObjectURL', url: u, at: Date.now() });
        return u;
    };
    URL.revokeObjectURL = function(u) {
        created.delete(u);
        log.push({ phase: 'revokeObjectURL', url: u, at: Date.now() });
        return origRevoke(u);
    };
    window.__scritchTest.liveObjectUrls = () => Array.from(created);
})();
`;

// --- scenario setup --------------------------------------------------------

// config used by most scenarios: 2 audio tracks + 1 video + 1 audio so we can
// do rapid switches and a video round-trip on distinct, easy-to-check covers.
const CONFIG = {
    title: 'test album',
    cover: 'cover-global.png',
    media: [
        { file: 'sample-alpha.wav', title: 'Alpha', cover: 'cover-alpha.png', feature: true },
        { file: 'sample-bravo.wav', title: 'Bravo' },
        { file: 'sample-video.webm', title: 'Video', type: 'video' },
        { file: 'sample-delta.wav', title: 'Delta', cover: 'cover-bravo.png', previewStart: 0.2, previewEnd: 1.2, originalDuration: '0:04' },
    ],
    theme: { coverSize: 480, layoutStyle: 'vertical', infoStyle: 'overlaid', contentWidth: 400, nativePlayer: false },
};

async function newPlayer(browser, server, { instrument = false } = {}) {
    const page = await browser.newPage();
    const errors = [];
    page.on('Runtime.exceptionThrown', p => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
    page.on('Log.entryAdded', p => { if (p.entry.level === 'error') errors.push(p.entry.text); });
    if (instrument) await page.addInitScript(INSTRUMENT);
    await page.addInitScript(TEST_HOOKS);
    await page.navigate(server.url);
    // tracks are created once config.json is fetched
    await waitFor(page, `(() => !!window.__scritchTest && document.getElementById('tracks') && document.getElementById('tracks').children.length === ${CONFIG.media.length})()`, 'player tracks', 15000);
    // let the first track's prefetch settle so scenario timing is predictable
    await sleep(250);
    page.pageErrors = errors;
    return page;
}

// --- scenarios -------------------------------------------------------------

// A gate is a promise the server waits on before sending a throttled response.
function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { gate: promise, release };
}

async function scenarioRapidSwitch(browser, server) {
    console.log('\nScenario 1: rapid consecutive track switches');
    server.setRoute('/config.json', CONFIG);
    // Install the throttle BEFORE the page loads so the startup prefetch of
    // Bravo is the request we hold open.
    let bravoGate = gate();
    server.throttle('/media/sample-bravo.wav', { gate: bravoGate.gate, release: bravoGate.release });
    const page = await newPlayer(browser, server, { instrument: true });

    // Hold Bravo's media fetch so it is guaranteed to still be in flight
    // when we switch away from it.
    // Alpha is current (featured).  Switch quickly: Alpha -> Bravo -> Video.
    await clickTrack(page, 0);
    await sleep(80);
    await clickTrack(page, 1);          // Bravo: its fetch is now gated
    await sleep(120);
    const duringBravo = await state(page);
    check('switched to Bravo', duringBravo.currentTitle === 'Bravo', duringBravo.currentTitle);

    await clickTrack(page, 2);          // Video: Bravo should be cancelled
    await sleep(150);

    const afterSwitch = await state(page);
    eq('current track is Video', afterSwitch.currentTitle, 'Video');
    eq('current type is video', afterSwitch.currentType, 'video');
    check('Bravo prefetch was aborted', afterSwitch.entries[1].aborted === true, JSON.stringify(afterSwitch.entries[1]));
    check('Bravo fetch marked aborted in instrumentation',
        afterSwitch.urlLog.some(e => e.phase === 'fetch:start' && e.url.includes('sample-bravo.wav') && e.aborted),
        JSON.stringify(afterSwitch.urlLog.filter(e => e.url.includes('sample-bravo'))));
    check('Bravo has no live object URL', !afterSwitch.entries[1].hasObjectUrl, JSON.stringify(afterSwitch.entries[1]));

    // Release the held Bravo response; because it was aborted it must not be
    // applied to the player or visible state.
    server.release('/media/sample-bravo.wav');
    await sleep(400);

    const afterRelease = await state(page);
    eq('still on Video after late release', afterRelease.currentTitle, 'Video');
    eq('player src is not Bravo', afterRelease.playerSrc && afterRelease.playerSrc.includes('sample-bravo'), false);
    check('Bravo never created a surviving object URL',
        !afterRelease.entries[1].hasObjectUrl,
        JSON.stringify(afterRelease.entries[1]));

    // The object URL created for the abandoned Bravo prefetch (if any ever
    // got created) must be revoked, and every still-live object URL must be
    // owned by exactly one track entry -- no orphan blobs.
    const revoked = new Set(afterRelease.urlLog.filter(e => e.phase === 'revokeObjectURL').map(e => e.url));
    const liveCreated = afterRelease.urlLog
        .filter(e => e.phase === 'createObjectURL')
        .map(e => e.url)
        .filter(u => !revoked.has(u));
    const entryOwned = new Set(afterRelease.entries.filter(e => e.objectUrl).map(e => e.objectUrl));
    const orphaned = liveCreated.filter(u => !entryOwned.has(u));
    check('every live object URL is owned by a track entry', orphaned.length === 0,
        'orphaned: ' + JSON.stringify(orphaned) + ' owned: ' + JSON.stringify([...entryOwned]));

    check('no page errors', page.pageErrors.length === 0, page.pageErrors.join('\n'));
    await page.close();
}

async function scenarioVideoRoundTrip(browser, server) {
    console.log('\nScenario 2: video <-> audio round trip with covers and scrubber reset');
    server.setRoute('/config.json', CONFIG);
    const page = await newPlayer(browser, server);

    // Start on Alpha (own cover).
    await clickTrack(page, 0);
    await waitFor(page, `(() => { const s = window.__scritchTest.state(); return s.currentTitle === 'Alpha' && s.imageSrc && s.imageSrc.includes('cover-alpha'); })()`, 'Alpha cover');
    const alpha = await state(page);
    check('Alpha shows its own cover', alpha.imageSrc.includes('cover-alpha'), alpha.imageSrc);
    check('Alpha cover visible', alpha.imageVisible === true && alpha.imageClassActive === true, JSON.stringify({v: alpha.imageVisible, a: alpha.imageClassActive}));

    // Move the progress bar away from zero so we can prove it resets.
    await page.evaluate(`window.__scritchTest.dragStart(0.7)`);
    await page.evaluate(`window.__scritchTest.dragMove(0.7)`);
    await page.evaluate(`window.__scritchTest.dragEnd()`);
    await sleep(120);

    // Switch to the video track.
    await clickTrack(page, 2);
    await waitFor(page, `(() => { const s = window.__scritchTest.state(); return s.currentTitle === 'Video' && s.videoActive; })()`, 'video active');
    const videoState = await state(page);
    eq('video track type', videoState.currentType, 'video');
    check('video element active', videoState.videoActive === true);
    check('cover hidden while video plays', videoState.imageVisible === false, JSON.stringify({ visible: videoState.imageVisible, cls: videoState.imageClassActive }));
    check('scrubber reset to start for video', videoState.scrubberLeft === '0%' && videoState.scrubberWidth === '0%', JSON.stringify({ l: videoState.scrubberLeft, w: videoState.scrubberWidth }));
    check('time readout reset for video', /0:00/.test(videoState.timeText), videoState.timeText);

    // Back to the audio track with its own cover.
    await clickTrack(page, 0);
    await waitFor(page, `(() => { const s = window.__scritchTest.state(); return s.currentTitle === 'Alpha' && s.imageVisible && s.imageSrc && s.imageSrc.includes('cover-alpha'); })()`, 'Alpha cover restored');
    const backToAlpha = await state(page);
    check('Alpha cover restored after video', backToAlpha.imageSrc.includes('cover-alpha'), backToAlpha.imageSrc);
    check('Alpha cover visible again', backToAlpha.imageVisible === true);
    check('Alpha progress reset after video', backToAlpha.scrubberLeft === '0%' && backToAlpha.scrubberWidth === '0%', JSON.stringify({ l: backToAlpha.scrubberLeft, w: backToAlpha.scrubberWidth }));

    // A track with no own cover must fall back to the global cover.
    await clickTrack(page, 1);
    await waitFor(page, `(() => { const s = window.__scritchTest.state(); return s.currentTitle === 'Bravo' && s.imageSrc && s.imageSrc.includes('cover-global'); })()`, 'global cover fallback');
    const bravo = await state(page);
    check('track without own cover uses global cover', bravo.imageSrc.includes('cover-global'), bravo.imageSrc);

    // And a track with a different own cover gets that one.
    await clickTrack(page, 3);
    await waitFor(page, `(() => { const s = window.__scritchTest.state(); return s.currentTitle === 'Delta' && s.imageSrc && s.imageSrc.includes('cover-bravo'); })()`, 'Delta cover');
    const delta = await state(page);
    check('Delta shows its own cover', delta.imageSrc.includes('cover-bravo'), delta.imageSrc);
    check('Delta progress reset on switch', delta.scrubberLeft === '0%', delta.scrubberLeft);

    check('no page errors', page.pageErrors.length === 0, page.pageErrors.join('\n'));
    await page.close();
}

async function scenarioLateResponse(browser, server) {
    console.log('\nScenario 3: a late prefetch response must not overwrite the current track');
    server.setRoute('/config.json', CONFIG);
    // Hold Delta's media response before load so its startup prefetch is the
    // request we hold open.
    let deltaGate = gate();
    server.throttle('/media/sample-delta.wav', { gate: deltaGate.gate, release: deltaGate.release });
    const page = await newPlayer(browser, server, { instrument: true });

    // Make the abort a no-op: the held Delta request will genuinely finish
    // and deliver its bytes after we have switched away.  The only thing
    // that can stop it from being applied is the prefetch token guard.
    await page.evaluate(`window.__scritchTest.disableAbort()`);

    // Go to Alpha, then Delta (its prefetch is gated), then back to Alpha
    // before Delta's response arrives.
    await clickTrack(page, 0);
    await sleep(80);
    await clickTrack(page, 3);          // Delta, gated
    await sleep(120);
    const onDelta = await state(page);
    eq('on Delta while its fetch is held', onDelta.currentTitle, 'Delta');

    const staleToken = await page.evaluate(`window.__scritchTest.entryToken(3)`);
    check('Delta had a live prefetch token', staleToken !== null && staleToken !== undefined, String(staleToken));

    await clickTrack(page, 0);          // back to Alpha, invalidating Delta
    await sleep(150);
    const backOnAlpha = await state(page);
    eq('back on Alpha', backOnAlpha.currentTitle, 'Alpha');
    check('Delta prefetch token invalidated on switching away',
        !(await page.evaluate(`window.__scritchTest.guard(3, ${JSON.stringify(staleToken)})`)),
        'guard still accepted the stale token');
    const alphaSrcBefore = backOnAlpha.currentFile;

    // Now release the held Delta bytes.  The page has already moved on and
    // the abort was disabled, so this response DOES arrive -- the token
    // guard must discard it.
    server.release('/media/sample-delta.wav');
    await sleep(700);

    const afterLate = await state(page);
    eq('still on Alpha after late Delta response', afterLate.currentTitle, 'Alpha');
    eq('Alpha player src unchanged by late response', afterLate.currentFile, alphaSrcBefore);
    check('Alpha cover still shown', afterLate.imageSrc && afterLate.imageSrc.includes('cover-alpha'), afterLate.imageSrc);
    check('late Delta did not create a live object URL', !afterLate.entries[3].hasObjectUrl, JSON.stringify(afterLate.entries[3]));
    check('Delta file fell back to the network source',
        afterLate.entries[3].file === afterLate.entries[3].source,
        JSON.stringify({ file: afterLate.entries[3].file, source: afterLate.entries[3].source }));

    // The held request must have been served (abort was disabled), proving
    // the guard and not the abort is what protected the player.
    const reqs = await (await fetch(`${server.origin}/__control/requests`)).json();
    const deltaReq = reqs.find(r => r.path === '/media/sample-delta.wav');
    check('server served the abandoned Delta request', !!deltaReq && deltaReq.released === true,
        JSON.stringify(deltaReq || reqs.map(r => r.path)));

    await page.evaluate(`window.__scritchTest.restoreAbort()`);

    check('no page errors', page.pageErrors.length === 0, page.pageErrors.join('\n'));
    await page.close();
}

async function scenarioScrubDuringLateLoad(browser, server) {
    console.log('\nScenario 4: a drag is not overwritten by a late load result');
    server.setRoute('/config.json', CONFIG);
    const page = await newPlayer(browser, server);

    // Land on Delta and let it load fully so the scrubber is usable.
    await clickTrack(page, 3);
    await waitFor(page, `(() => { const s = window.__scritchTest.state(); return s.currentTitle === 'Delta' && s.scrubberLeft !== '' && !s.loading; })()`, 'Delta loaded', 15000);

    // --- part A: a late metadata update must not move the thumb ----------
    await page.evaluate(`window.__scritchTest.dragStart(0.6)`);
    await page.evaluate(`window.__scritchTest.dragMove(0.6)`);
    await sleep(150);
    const dragging = await state(page);
    check('drag in progress', dragging.dragging === true);
    const heldLeft = dragging.scrubberLeft;

    // Force a late duration/metadata update for the current track while the
    // user is still dragging; this used to snap the thumb back to 0.
    await page.evaluate(`(() => { updateDuration(currentEntry, currentEntry.duration); })()`);
    await sleep(120);
    const afterLateUpdate = await state(page);
    check('late metadata update did not move the thumb', afterLateUpdate.scrubberLeft === heldLeft,
        `held ${heldLeft}, now ${afterLateUpdate.scrubberLeft}`);
    check('track still being dragged', afterLateUpdate.dragging === true);

    // Release; the position should be committed, not reset.
    await page.evaluate(`window.__scritchTest.dragEnd()`);
    await sleep(200);
    const afterEnd = await state(page);
    check('drag released (metadata)', afterEnd.dragging === false);
    check('released position preserved after late metadata', afterEnd.scrubberLeft === heldLeft,
        `held ${heldLeft}, now ${afterEnd.scrubberLeft}`);

    // --- part B: a prefetch completing mid-drag is queued, not applied ---
    // Delta is a preview track, so its scrub region is only the preview
    // sub-bar; 0.1 lands well inside it (0.6 would clamp to the edge).
    await page.evaluate(`window.__scritchTest.dragStart(0.1)`);
    await page.evaluate(`window.__scritchTest.dragMove(0.1)`);
    await sleep(120);
    const dragB = await state(page);
    const heldB = dragB.scrubberLeft;
    check('part B drag landed at a fresh position', heldB !== afterEnd.scrubberLeft,
        `A=${afterEnd.scrubberLeft}, B=${heldB}`);
    const appliedMidDrag = await page.evaluate(`window.__scritchTest.applySourceNow(3)`);
    check('late prefetched source deferred during drag', appliedMidDrag.pending === true && appliedMidDrag.applied === null,
        JSON.stringify(appliedMidDrag));
    const stillHeld = await state(page);
    check('thumb unmoved by late source', stillHeld.scrubberLeft === heldB,
        `held ${heldB}, now ${stillHeld.scrubberLeft}`);

    await page.evaluate(`window.__scritchTest.dragEnd()`);
    await sleep(300);
    check('queued source flushed on release', (await page.evaluate(`window.__scritchTest.pendingSrc(3)`)) === null);
    const afterB = await state(page);
    check('released position preserved after late source',
        Math.abs(pct(afterB.scrubberLeft) - pct(heldB)) < 0.5 && pct(afterB.scrubberLeft) > 1,
        `held ${heldB}, now ${afterB.scrubberLeft}`);

    check('no page errors', page.pageErrors.length === 0, page.pageErrors.join('\n'));
    await page.close();
}

// --- main ------------------------------------------------------------------

async function main() {
    const server = await startServer();
    let browser;
    try {
        browser = await launchBrowser({ headless: true });
        await scenarioRapidSwitch(browser, server);
        await scenarioVideoRoundTrip(browser, server);
        await scenarioLateResponse(browser, server);
        await scenarioScrubDuringLateLoad(browser, server);
    } catch (err) {
        failures++;
        console.error('\nFATAL:', err && err.stack || err);
    } finally {
        if (browser) await browser.close();
        await server.close();
    }

    const passed = results.filter(r => r.ok).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    if (failures > 0) {
        console.log(`\n${failures} failure(s):`);
        results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}: ${r.detail || ''}`));
    }
    process.exit(failures > 0 ? 1 : 0);
}

main();
