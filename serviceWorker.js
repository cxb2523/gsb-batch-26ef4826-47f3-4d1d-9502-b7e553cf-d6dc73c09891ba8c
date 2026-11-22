"use strict";

// -----------------------------------------------------------------------------
// Offline cache lifecycle
//
// The cache is versioned: every published version gets its own cache
// (`daw-<version>`), installed atomically and deleted only when a newer
// version takes over. This guarantees that a fallback never reads a resource
// left over by a previous version.
//
// VERSION is the single source of truth used by the service worker. It must
// stay in sync with `build-conf.json` -> "version" (the value injected into
// the page at build time). `node tools/check-service-worker.mjs` verifies it,
// together with the precache list below. See SERVICE-WORKER.md for the local
// upgrade simulation.
// -----------------------------------------------------------------------------

const VERSION = "2.60.2";

const CACHE_PREFIX = "daw-";
const CACHE_NAME = `${ CACHE_PREFIX }${ VERSION }`;

// Cache created by the previous, unversioned service worker.
const LEGACY_CACHE_NAMES = [ "daw" ];

// This list must contain every resource the startup script (src/run.js)
// loads, otherwise going offline leaves the app unable to boot. In
// particular the waveform library is `gsuiWaveletList-v1.js`; the no longer
// used `gswaPeriodicWavesList-v1.js` is deliberately absent.
// `tools/check-service-worker.mjs` cross-checks this list with src/run.js.
const PRECACHE_URLS = [
	"/",
	"/index.html",
	"/manifest.json",
	"/assets/ico.svg",
	"/assets/logo/gs-gs-logo.svg",
	"/assets/logo/gs-gridsound-logo-animated.svg",
	"/assets/gsuiLibrarySamples-v1.js",
	"/assets/gsuiWaveletList-v1.js",
	"/assets/fonts/fa-brands-400.woff2",
	"/assets/fonts/fa-duotone-900.woff2",
	"/assets/fonts/unica-one-400-latin.woff2",
	"/assets/fonts/montserrat-500-latin.woff2",
	"/assets/fonts/montserrat-700-latin.woff2",
	"/assets/fonts/inconsolata-400-latin.woff2",
];

// -----------------------------------------------------------------------------
// Install: fill the current version's cache.
//
// `cache: "reload"` bypasses the HTTP cache so a version never inherits a
// stale copy of an asset. If any request fails the whole installation is
// rolled back (cache removed, install rejected), so the previous version
// stays in charge instead of exposing a half-filled cache.
//
// Note: `self.skipWaiting()` is intentionally NOT called here. While a new
// version is installed but not activated, pages opened with the old version
// keep being served by the old worker/cache. The page asks for the switch
// when the user starts the DAW (see src/serviceWorkerLifecycle.js).
// -----------------------------------------------------------------------------
self.addEventListener( "install", event => {
	event.waitUntil( ( async () => {
		// A re-install of the same version (re-registration, failed update
		// retry, ...) must not destroy a cache that is still valid: remember
		// whether this install created it and roll back only in that case.
		const preexisting = await caches.has( CACHE_NAME );
		const cache = await caches.open( CACHE_NAME );

		try {
			await cache.addAll( PRECACHE_URLS.map( url => new Request( url, { cache: "reload" } ) ) );
		} catch ( err ) {
			if ( !preexisting ) {
				await caches.delete( CACHE_NAME );
			}
			throw err;
		}
	} )() );
} );

// -----------------------------------------------------------------------------
// Activate: drop the caches of the older versions (and the legacy unversioned
// one) and take control of the pages that are already open, so their next
// requests use the new version.
// -----------------------------------------------------------------------------
self.addEventListener( "activate", event => {
	event.waitUntil( ( async () => {
		const names = await caches.keys();

		await Promise.all(
			names.filter( isOutdatedCache ).map( name => caches.delete( name ) )
		);
		await self.clients.claim();
	} )() );
} );

// Only caches of *older* versions are removed, plus the legacy unversioned
// one. A cache of a newer version may belong to an installation in progress
// (v3 installing while v2 activates): deleting it would leave that version
// waiting with an empty cache, so it is preserved.
function isOutdatedCache( name ) {
	if ( name === CACHE_NAME ) {
		return false;
	}
	if ( LEGACY_CACHE_NAMES.includes( name ) ) {
		return true;
	}
	return name.startsWith( CACHE_PREFIX ) &&
		compareVersions( name.slice( CACHE_PREFIX.length ), VERSION ) < 0;
}

function compareVersions( a, b ) {
	const pa = a.split( "." ).map( Number );
	const pb = b.split( "." ).map( Number );

	for ( let i = 0; i < Math.max( pa.length, pb.length ); i++ ) {
		const na = pa[ i ] || 0;
		const nb = pb[ i ] || 0;

		if ( na !== nb ) {
			return na < nb ? -1 : 1;
		}
	}
	return 0;
}

// -----------------------------------------------------------------------------
// Messages
//   SKIP_WAITING: sent by the page (after the user clicked "start") to let a
//                 waiting version activate without reloading the page.
//   GET_VERSION:  read-only introspection used by tests and manual checks.
// -----------------------------------------------------------------------------
self.addEventListener( "message", event => {
	const data = event.data;

	if ( !data || typeof data !== "object" ) {
		return;
	}
	if ( data.type === "SKIP_WAITING" ) {
		event.waitUntil( self.skipWaiting() );
	} else if ( data.type === "GET_VERSION" ) {
		event.ports[ 0 ]?.postMessage( { version: VERSION, cacheName: CACHE_NAME } );
	}
} );

// -----------------------------------------------------------------------------
// Fetch: network first, then the *current version's* cache only.
//
// `caches.match()` must not be used here: it searches every cache, including
// a leftover cache of a previous version. Opening CACHE_NAME explicitly ties
// every fallback to the version handled by this worker.
// -----------------------------------------------------------------------------
self.addEventListener( "fetch", event => {
	const req = event.request;

	if ( req.method !== "GET" ) {
		return;
	}
	if ( new URL( req.url ).origin !== self.location.origin ) {
		return;
	}
	event.respondWith(
		// `no-cache` revalidates same-origin assets instead of trusting a
		// possibly stale HTTP-cached copy.
		fetch( req, { cache: "no-cache" } ).catch( () => matchCurrentVersion( req ) )
	);
} );

async function matchCurrentVersion( req ) {
	// `caches.open()` creates the cache when it is missing. A worker whose
	// version has just been replaced can still handle a request from a page
	// that is being taken over; re-creating the deleted cache would resurrect
	// a stale, empty version. Fail instead.
	if ( !( await caches.has( CACHE_NAME ) ) ) {
		return Response.error();
	}
	const cache = await caches.open( CACHE_NAME );
	let res = await cache.match( req );

	// Built CSS references some assets with a cache-busting query string
	// (`?1`), while the precache list stores them without it.
	if ( !res ) {
		res = await cache.match( req, { ignoreSearch: true } );
	}
	if ( !res && req.mode === "navigate" ) {
		res = await cache.match( "/index.html" ) || await cache.match( "/" );
	}
	return res || Response.error();
}
