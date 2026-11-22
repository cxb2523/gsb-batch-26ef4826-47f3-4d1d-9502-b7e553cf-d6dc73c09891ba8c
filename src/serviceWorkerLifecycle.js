"use strict";

// -----------------------------------------------------------------------------
// Service worker lifecycle (client side)
//
// Responsibilities:
//  - register the service worker;
//  - expose the version/cache name currently in charge of this page;
//  - load a startup asset, falling back to the *current version's* cache when
//    the network fails (never to a leftover cache of a previous version);
//  - activate a waiting version when the user starts the DAW, without
//    reloading the page nor interrupting the startup flow.
//
// VERSION must stay identical to the one in serviceWorker.js and to
// build-conf.json -> "version". `node tools/check-service-worker.mjs` enforces
// it and `node tools/bump-version.mjs` updates all of them at once.
// -----------------------------------------------------------------------------

const GSDAW_VERSION = "2.60.2";
const GSDAW_CACHE_PREFIX = "daw-";

const GSDAWOffline = Object.freeze( {
	version: GSDAW_VERSION,
	cacheName: GSDAW_CACHE_PREFIX + GSDAW_VERSION,

	// Verbose trace, also used by the end-to-end checks (tools/offline-e2e.mjs).
	$loads: [],

	registration: GSDAWOfflineRegister,
	activeVersion: GSDAWOfflineActiveVersion,
	activateWaitingVersion: GSDAWOfflineActivateWaitingVersion,
	loadScript: GSDAWOfflineLoadScript,
} );

window.GSDAWOffline = GSDAWOffline;

// .............................................................................
// Registration
//
// The worker never calls skipWaiting() on its own: a freshly installed version
// stays in the "waiting" state so the page already opened keeps using the
// version it was loaded with (see serviceWorker.js).
// .............................................................................
function GSDAWOfflineRegister() {
	if ( !navigator.serviceWorker ) {
		return Promise.resolve( null );
	}

	return navigator.serviceWorker.register( "serviceWorker.js" )
		.then( reg => {
			( reg.installing || reg.waiting || reg.active )
				?.addEventListener( "statechange", () => console.info(
					"Service worker:", ( reg.installing || reg.waiting || reg.active )?.state ) );
			return reg;
		}, err => {
			console.warn( "Service worker registration failed:", err );
			return null;
		} );
}

const gsDAWOfflineReg = GSDAWOfflineRegister();

// .............................................................................
// Version currently in charge of this page.
//
// The controlling worker is asked for its version (message GET_VERSION). This
// is what pins a fallback to the right cache: an old page kept alive while a
// new version waits is still controlled by the old worker, so it must fall
// back to the old cache, and an old cache must never answer for a new page.
// If there is no controller (or it does not answer), the build-time constant
// is used.
// .............................................................................
function GSDAWOfflineActiveVersion() {
	const controller = navigator.serviceWorker?.controller;

	if ( !controller ) {
		return Promise.resolve( { version: GSDAW_VERSION, cacheName: GSDAWOffline.cacheName } );
	}
	return new Promise( resolve => {
		const channel = new MessageChannel();
		const fallback = () => resolve( { version: GSDAW_VERSION, cacheName: GSDAWOffline.cacheName } );
		const timer = setTimeout( fallback, 1000 );

		channel.port1.onmessage = e => {
			clearTimeout( timer );
			resolve( e.data || { version: GSDAW_VERSION, cacheName: GSDAWOffline.cacheName } );
		};
		try {
			controller.postMessage( { type: "GET_VERSION" }, [ channel.port2 ] );
		} catch ( err ) {
			clearTimeout( timer );
			fallback();
		}
	} );
}

// .............................................................................
// Turn a waiting version into the active one.
//
// If no version is waiting yet, a bounded update check is performed first
// (`registration.update()`), so a version published while this page was open
// is still picked up. When nothing new exists, this resolves immediately after
// the (very small) worker script request, without reloading the page.
//
// Resolves { switched: true, version } once the new version took control, or
// { switched: false, version } when there was nothing to do / the switch did
// not complete in time. It never rejects and never reloads the page: the
// current startup flow simply continues with the (now) active version.
// .............................................................................
function GSDAWOfflineActivateWaitingVersion( timeout = 4000, updateTimeout = 2000 ) {
	const merge = extra => GSDAWOfflineActiveVersion().then( info => ( { ...extra, ...info } ) );
	const withTimeout = ( promise, ms ) => Promise.race( [
		promise,
		new Promise( resolve => setTimeout( () => resolve( null ), ms ) ),
	] );

	return gsDAWOfflineReg.then( reg => {
		if ( !reg ) {
			return merge( { switched: false } );
		}
		const lookForUpdate = reg.waiting
			? Promise.resolve()
			: withTimeout( reg.update().catch( () => null ), updateTimeout )
				.then( () => null );

		return lookForUpdate.then( () => {
			const waiting = reg.waiting;

			if ( !waiting ) {
				return merge( { switched: false } );
			}
			return new Promise( resolve => {
				let done = false;
				const finish = switched => {
					if ( !done ) {
						done = true;
						clearTimeout( timer );
						navigator.serviceWorker.removeEventListener( "controllerchange", onChange );
						merge( { switched } ).then( resolve );
					}
				};
				const onChange = () => finish( true );
				const timer = setTimeout( () => finish( false ), timeout );

				navigator.serviceWorker.addEventListener( "controllerchange", onChange );
				waiting.postMessage( { type: "SKIP_WAITING" } );
			} );
		} );
	} );
}

// .............................................................................
// Load a startup asset.
//
// 1. Try the network through a regular <script> tag (transparently served by
//    the worker from the current version's cache when offline).
// 2. If the tag fails (no controller yet, network down, ...), read the asset
//    from the current version's cache explicitly and execute it as a classic
//    script so its top-level declarations (`const gsuiWaveletList`, ...) stay
//    visible to the rest of the application.
//
// The cache is opened by name, never with `caches.match()`, so a leftover
// cache from a previous version can never answer.
// .............................................................................
async function GSDAWOfflineLoadScript( url ) {
	try {
		await loadScriptTag( url );
		GSDAWOffline.$loads.push( { url, source: "script-tag", ...( await GSDAWOfflineActiveVersion() ) } );
	} catch ( err ) {
		const { version, cacheName } = await GSDAWOfflineActiveVersion();
		const res = await matchVersionedCache( cacheName, url );

		if ( !res ) {
			throw new Error( `"${ url }" is neither reachable nor cached in "${ cacheName }"` );
		}
		const code = await res.text();
		const blobUrl = URL.createObjectURL( new Blob( [ code ], { type: "text/javascript" } ) );

		try {
			await loadScriptTag( blobUrl );
		} finally {
			URL.revokeObjectURL( blobUrl );
		}
		GSDAWOffline.$loads.push( { url, source: "cache", version, cacheName } );
	}
}

function loadScriptTag( source ) {
	return new Promise( ( resolve, reject ) => {
		const script = document.createElement( "script" );

		script.src = source;
		script.onload = () => {
			script.remove();
			resolve();
		};
		script.onerror = () => {
			script.remove();
			reject( new Error( `Unable to load "${ source }"` ) );
		};
		document.head.append( script );
	} );
}

// Read `url` from the cache of the given version only. `caches.open()` would
// create a missing cache, so its existence is checked first: a missing
// version cache must surface as a failure, not as a silent empty cache.
function matchVersionedCache( cacheName, url ) {
	return caches.has( cacheName ).then( exists => exists
		? caches.open( cacheName )
			.then( cache => cache.match( url )
				.then( res => res || cache.match( url, { ignoreSearch: true } ) ) )
		: null );
}
