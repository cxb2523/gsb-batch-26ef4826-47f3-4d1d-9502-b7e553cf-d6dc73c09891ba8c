#!/usr/bin/env node
// Optional end-to-end test of the offline cache lifecycle, in a real browser.
//
// It needs `playwright-core` and a Chromium binary; neither is a dependency of
// this repository, so the test is opt-in:
//
//   npm install --no-save playwright-core
//   CHROME=/path/to/chrome node tools/offline-e2e.mjs
//
// GS_DAW_ROOT can point at the project root when the script is copied
// elsewhere (e.g. next to a scratch node_modules).
//
// It serves the real serviceWorker.js, src/serviceWorkerLifecycle.js and
// src/run.js from this repository through a small static server, with the two
// libraries replaced by distinguishable payloads, and checks:
//   1. a fresh install precaches the page entry and both libraries;
//   2. an offline boot loads both libraries from the current version;
//   3. legacy and previous-version caches are deleted on activation;
//   4. a waiting version does not disturb the page already open;
//   5. clicking start switches to the waiting version without reloading and
//      the following loads hit the new version;
//   6. an old page never borrows a newer version's cache entry;
//   7. the explicit cache fallback works when no worker controls the page.
//
// Exit code 0 = all checks passed.

import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = process.env.GS_DAW_ROOT
	? resolve( process.env.GS_DAW_ROOT )
	: resolve( dirname( fileURLToPath( import.meta.url ) ), ".." );
const CHROME = process.env.CHROME;

const read = p => readFileSync( resolve( ROOT, p ), "utf8" );
const SW_TEMPLATE = read( "serviceWorker.js" );
const LIFECYCLE = read( "src/serviceWorkerLifecycle.js" );
const RUN = read( "src/run.js" );
const V1 = JSON.parse( read( "build-conf.json" ) ).version;
const V2 = V1.replace( /(\d+)$/u, n => String( Number( n ) + 1 ) );
const PRECACHE = [ ...SW_TEMPLATE.match( /const\s+PRECACHE_URLS\s*=\s*\[([\s\S]*?)\];/u )[ 1 ]
	.matchAll( /"([^"]+)"/gu ) ].map( m => m[ 1 ] );

// ---------------------------------------------------------------- deployment
const deploy = { version: V1, samples: "v1-samples", wavelet: "v1-wavelet" };
const swSource = () => SW_TEMPLATE.replace(
	/const\s+VERSION\s*=\s*"[^"]+"/u, `const VERSION = "${ deploy.version }"` );

const appPage = () => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>GS</title></head><body>
<div id="splashScreen"><div><div></div><b>${ deploy.version }</b>
<span data-alert="firefox"><span>x</span></span><button disabled></button><a href="#">link</a></div></div>
<script>
"use strict";
class JQ {
	constructor( a ) { this.a = a; }
	$query( s ) { return new JQ( this.a.flatMap( el => [ ...el.querySelectorAll( s ) ] ) ); }
	$css() { return this; }
	$remove() { this.a.forEach( el => el.remove() ); return this; }
	$addAttr( k ) { this.a.forEach( el => el.setAttribute( k, "" ) ); return this; }
	$onclick( f ) { this.a.forEach( el => el.onclick = f ); return this; }
	$disabled( b ) { this.a.forEach( el => el.disabled = b ); return this; }
}
window.$ = s => new JQ( [ ...document.querySelectorAll( s ) ] );
window.GSUonFirefox = false;
window.GSUsetTimeout = ( fn, t ) => setTimeout( fn, t * 1000 );
window.gswaContext = { $resume: () => Promise.resolve() };
window.GSDAW = function () { this.$init = () => { window.__started = {
	samples: typeof gsuiLibrarySamples, wavelet: typeof gsuiWaveletList,
	samplesMarker: window.__samplesMarker, waveletMarker: window.__waveletMarker,
}; }; };
window.__pageLoadId = String( Math.random() );
${ LIFECYCLE }
${ RUN }
</script></body></html>`;

const server = http.createServer( ( req, res ) => {
	const p = new URL( req.url, "http://x" ).pathname;
	const send = ( body, type = "text/javascript" ) => {
		res.writeHead( 200, { "content-type": type, "cache-control": "no-store" } );
		res.end( body );
	};

	if ( p === "/" || p === "/index.html" ) {
		return send( appPage(), "text/html" );
	}
	if ( p === "/manifest.json" ) {
		return send( "{}", "application/manifest+json" );
	}
	if ( p === "/serviceWorker.js" ) {
		return send( swSource() );
	}
	if ( p === "/assets/gsuiLibrarySamples-v1.js" ) {
		return send( `window.__samplesMarker="${ deploy.samples }"; const gsuiLibrarySamples=["x"];` );
	}
	if ( p === "/assets/gsuiWaveletList-v1.js" ) {
		return send( `window.__waveletMarker="${ deploy.wavelet }"; const gsuiWaveletList=["x"];` );
	}
	if ( PRECACHE.includes( p ) ) {
		return send( `/* stub ${ p } */`, p.endsWith( ".svg" ) ? "image/svg+xml" : "application/octet-stream" );
	}
	res.writeHead( 404 );
	res.end( "not found" );
} );

const listen = () => new Promise( r => server.listen( 0, "127.0.0.1", () => r( server.address().port ) ) );

// ---------------------------------------------------------------- assertions
let failures = 0;
const results = [];
const ok = ( label, cond, detail = "" ) => {
	results.push( `${ cond ? "ok  " : "FAIL" }  ${ label }${ detail ? ` (${ detail })` : "" }` );
	if ( !cond ) {
		failures++;
	}
};

async function waitFor( fn, { timeout = 15000, label = "condition" } = {} ) {
	const t0 = Date.now();

	for (;;) {
		let v;
		try { v = await fn(); } catch { v = false; }
		if ( v ) {
			return v;
		}
		if ( Date.now() - t0 > timeout ) {
			throw new Error( `timeout waiting for ${ label }` );
		}
		await new Promise( r => setTimeout( r, 100 ) );
	}
}

const cacheKeys = page => page.evaluate( () => caches.keys() );
const cacheHas = ( page, cache, url ) => page.evaluate( ( [ c, u ] ) =>
	caches.open( c ).then( k => k.match( u ) ).then( r => !!r ), [ cache, url ] );
const swVersion = page => page.evaluate( () => GSDAWOffline.activeVersion() );

async function start( page ) {
	await page.click( "#splashScreen button" );
	await waitFor( () => page.evaluate( () => !!window.__started ), { label: "app start" } );
	return page.evaluate( () => window.__started );
}

async function scenario( name, fn ) {
	Object.assign( deploy, {
		version: V1, samples: "v1-samples", wavelet: "v1-wavelet",
	} );
	const port = await listen();
	const base = `http://127.0.0.1:${ port }`;
	const browser = await chromium.launch( { executablePath: CHROME, headless: true } );
	const context = await browser.newContext();
	const page = await context.newPage();
	const errors = [];

	page.on( "pageerror", e => errors.push( String( e ) ) );
	try {
		results.push( `\n--- ${ name } ---` );
		await fn( { page, context, base } );
	} catch ( err ) {
		ok( `${ name } did not throw`, false, err.message );
	} finally {
		if ( errors.length ) {
			ok( `${ name }: no page errors`, false, errors.join( " | " ) );
		}
		await context.close();
		await browser.close();
		await new Promise( r => server.close( r ) );
	}
}

const WAVELET = "/assets/gsuiWaveletList-v1.js";
const SAMPLES = "/assets/gsuiLibrarySamples-v1.js";

async function registerWaitingUpdate( page ) {
	deploy.version = V2;
	deploy.samples = "v2-samples";
	deploy.wavelet = "v2-wavelet";
	return page.evaluate( async () => {
		const reg = await navigator.serviceWorker.getRegistration();
		await reg.update();
		return true;
	} );
}

await scenario( "1. fresh install precaches page entry + both libraries", async ( { page, base } ) => {
	await page.goto( base + "/" );
	ok( "service worker becomes active", await page.evaluate( () => navigator.serviceWorker.ready.then( r => !!r.active ) ) );
	const keys = await cacheKeys( page );
	ok( "cache name contains the version", keys.includes( `daw-${ V1 }` ), JSON.stringify( keys ) );
	ok( "waveform library is precached", await cacheHas( page, `daw-${ V1 }`, WAVELET ) );
	ok( "sample library is precached", await cacheHas( page, `daw-${ V1 }`, SAMPLES ) );
	ok( "page entry is precached", await cacheHas( page, `daw-${ V1 }`, "/index.html" ) );
} );

await scenario( "2. offline boot serves both libraries from the current version", async ( { page, context, base } ) => {
	await page.goto( base + "/" );
	await page.evaluate( () => navigator.serviceWorker.ready );
	await waitFor( async () => ( await cacheKeys( page ) ).includes( `daw-${ V1 }` ), { label: "cache" } );
	await context.setOffline( true );
	await page.reload();
	await waitFor( () => page.evaluate( () => !!window.GSDAWOffline ), { label: "scripts served offline" } );
	const started = await start( page );
	ok( "app initialised offline", started.samples === "object" && started.wavelet === "object", JSON.stringify( started ) );
	ok( "sample library content is v1", started.samplesMarker === "v1-samples" );
	ok( "waveform library content is v1", started.waveletMarker === "v1-wavelet" );
	const loads = await page.evaluate( () => GSDAWOffline.$loads );
	ok( "both libraries recorded", loads.length === 2, JSON.stringify( loads ) );
	ok( "loads are pinned to the current version", loads.every( l => l.version === V1 ) );
} );

await scenario( "3. legacy and previous-version caches are removed on activation", async ( { page, base } ) => {
	await page.goto( base + "/" );
	await page.evaluate( async () => {
		await caches.open( "daw" ).then( c => c.put( "/assets/gsuiWaveletList-v1.js",
			new Response( 'window.__waveletMarker="legacy"; const gsuiWaveletList=[];' ) ) );
		await caches.open( "daw-0.0.1" ).then( c => c.put( "/assets/gsuiWaveletList-v1.js",
			new Response( 'window.__waveletMarker="old"; const gsuiWaveletList=[];' ) ) );
	} );
	await page.reload();
	await page.evaluate( () => navigator.serviceWorker.ready );
	await waitFor( async () => !( await cacheKeys( page ) ).includes( "daw" ), { label: "legacy cache deleted" } );
	const keys = await cacheKeys( page );
	ok( "legacy 'daw' cache deleted", !keys.includes( "daw" ), JSON.stringify( keys ) );
	ok( "previous version cache deleted", !keys.includes( "daw-0.0.1" ), JSON.stringify( keys ) );
	ok( "current version cache kept", keys.includes( `daw-${ V1 }` ) );
	const started = await start( page );
	ok( "waveform library is the current one", started.waveletMarker === "v1-wavelet", String( started.waveletMarker ) );
} );

await scenario( "4. a waiting version does not disturb the open page", async ( { page, context, base } ) => {
	await page.goto( base + "/" );
	await page.evaluate( () => navigator.serviceWorker.ready );
	await waitFor( async () => ( await cacheKeys( page ) ).includes( `daw-${ V1 }` ), { label: "v1 cache" } );
	await registerWaitingUpdate( page );
	const waiting = await waitFor( () => page.evaluate( async () => {
		const reg = await navigator.serviceWorker.getRegistration();
		return !!reg.waiting;
	} ), { label: "waiting version" } );
	ok( "new version installs and waits", waiting );
	ok( "v2 cache exists while waiting", ( await cacheKeys( page ) ).includes( `daw-${ V2 }` ) );
	ok( "page still controlled by v1", ( await swVersion( page ) ).version === V1 );
	await context.setOffline( true );
	await page.evaluate( u => GSDAWOffline.loadScript( u ), "assets/gsuiWaveletList-v1.js" );
	ok( "old page loads v1 content, not v2",
		( await page.evaluate( () => window.__waveletMarker ) ) === "v1-wavelet" );
} );

await scenario( "5. start switches to the waiting version without reload, then loads hit v2", async ( { page, context, base } ) => {
	await page.goto( base + "/" );
	await page.evaluate( () => navigator.serviceWorker.ready );
	await waitFor( async () => ( await cacheKeys( page ) ).includes( `daw-${ V1 }` ), { label: "v1 cache" } );
	const loadId = await page.evaluate( () => window.__pageLoadId );

	await registerWaitingUpdate( page );
	await waitFor( () => page.evaluate( async () => {
		const reg = await navigator.serviceWorker.getRegistration();
		return !!reg.waiting;
	} ), { label: "waiting version" } );
	await context.setOffline( true );
	const started = await start( page );
	ok( "page was not reloaded by the switch", ( await page.evaluate( () => window.__pageLoadId ) ) === loadId );
	ok( "sample library comes from v2", started.samplesMarker === "v2-samples" );
	ok( "waveform library comes from v2", started.waveletMarker === "v2-wavelet" );
	ok( "service worker is now v2", ( await swVersion( page ) ).version === V2 );
	const keys = await waitFor( async () => {
		const k = await cacheKeys( page );
		return !k.includes( `daw-${ V1 }` ) ? k : false;
	}, { label: "v1 cache removed" } ).catch( () => cacheKeys( page ) );
	ok( "v1 cache removed after activation", !keys.includes( `daw-${ V1 }` ), JSON.stringify( keys ) );
	const loads = await page.evaluate( () => GSDAWOffline.$loads );
	ok( "all loads recorded against v2", loads.length === 2 && loads.every( l => l.version === V2 ) );
} );

await scenario( "6. an old page never borrows a newer version's cache entry", async ( { page, context, base } ) => {
	await page.goto( base + "/" );
	await page.evaluate( () => navigator.serviceWorker.ready );
	await waitFor( async () => ( await cacheKeys( page ) ).includes( `daw-${ V1 }` ), { label: "v1 cache" } );
	await registerWaitingUpdate( page );
	await waitFor( () => page.evaluate( async () => {
		const reg = await navigator.serviceWorker.getRegistration();
		return !!reg.waiting;
	} ), { label: "waiting version" } );
	await page.evaluate( c => caches.open( c ).then( k => k.delete( "/assets/gsuiWaveletList-v1.js" ) ), `daw-${ V1 }` );
	await context.setOffline( true );
	const outcome = await page.evaluate( async () => {
		try {
			await GSDAWOffline.loadScript( "assets/gsuiWaveletList-v1.js" );
			return { loaded: true, marker: window.__waveletMarker };
		} catch ( err ) {
			return { loaded: false, error: String( err.message ) };
		}
	} );
	ok( "older page refuses to use the newer version's copy", outcome.loaded === false, JSON.stringify( outcome ) );
} );

await scenario( "7. explicit cache fallback works when no worker controls the page", async ( { page, context, base } ) => {
	await page.goto( base + "/" );
	await page.evaluate( () => navigator.serviceWorker.ready );
	await waitFor( async () => ( await cacheKeys( page ) ).includes( `daw-${ V1 }` ), { label: "v1 cache" } );
	await page.evaluate( async () => {
		const regs = await navigator.serviceWorker.getRegistrations();
		await Promise.all( regs.map( r => r.unregister() ) );
	} );
	await page.reload();
	await waitFor( () => page.evaluate( () => !navigator.serviceWorker.controller ), { label: "no controller" } );
	await context.setOffline( true );
	const outcome = await page.evaluate( async () => {
		await GSDAWOffline.loadScript( "assets/gsuiWaveletList-v1.js" );
		return {
			marker: window.__waveletMarker,
			wavelet: typeof gsuiWaveletList,
			load: GSDAWOffline.$loads.at( -1 ),
		};
	} );
	ok( "cache fallback executes the asset",
		outcome.marker === "v1-wavelet" && outcome.wavelet === "object" );
	ok( "cache fallback is attributed to the current version",
		outcome.load?.source === "cache" && outcome.load?.version === V1, JSON.stringify( outcome.load ) );
} );

console.log( results.join( "\n" ) );
console.log( failures ? `\n${ failures } check(s) FAILED` : "\nAll e2e checks passed" );
process.exit( failures ? 1 : 0 );
