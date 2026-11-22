#!/usr/bin/env node
// Local, dependency-free verification of the offline cache lifecycle.
//
//   node tools/check-service-worker.mjs
//
// Checks
//  1. the version in build-conf.json (injected into the page as GSDAW-VERSION)
//     matches the constants of serviceWorker.js and src/serviceWorkerLifecycle.js;
//  2. the precache list of serviceWorker.js contains every resource the
//     startup script (src/run.js) loads at startup;
//  3. the precache list contains the page entry points;
//  4. the obsolete waveform library is not precached any more;
//  5. the cache name is derived from the version and the activation step
//     deletes the caches of the other versions.
//
// Exit code 0 = OK, 1 = at least one check failed.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve( dirname( fileURLToPath( import.meta.url ) ), ".." );
const read = name => readFileSync( resolve( root, name ), "utf8" );
const failures = [];
const passes = [];

const check = ( label, ok, detail = "" ) => {
	( ok ? passes : failures ).push( label + ( detail ? ` (${ detail })` : "" ) );
};

// -----------------------------------------------------------------------------
const buildConf = JSON.parse( read( "build-conf.json" ) );
const sw = read( "serviceWorker.js" );
const life = read( "src/serviceWorkerLifecycle.js" );
const run = read( "src/run.js" );

function constOf( source, name ) {
	const m = source.match( new RegExp( `const\\s+${ name }\\s*=\\s*"([^"]+)"`, "u" ) );
	return m?.[ 1 ] ?? null;
}
function arrayOf( source, name ) {
	const m = source.match( new RegExp( `const\\s+${ name }\\s*=\\s*\\[([\\s\\S]*?)\\];`, "u" ) );
	return m ? [ ...m[ 1 ].matchAll( /"([^"]+)"/gu ) ].map( x => x[ 1 ] ) : null;
}

// 1. version consistency --------------------------------------------------------
const confVersion = buildConf.version;
const swVersion = constOf( sw, "VERSION" );
const lifeVersion = constOf( life, "GSDAW_VERSION" );

check( "build-conf.json version is set", Boolean( confVersion ), confVersion || "missing" );
check( "serviceWorker.js VERSION matches build-conf.json",
	swVersion === confVersion, `${ swVersion } vs ${ confVersion }` );
check( "src/serviceWorkerLifecycle.js GSDAW_VERSION matches build-conf.json",
	lifeVersion === confVersion, `${ lifeVersion } vs ${ confVersion }` );

// 2. precache list matches the startup script ----------------------------------
const precache = arrayOf( sw, "PRECACHE_URLS" );

check( "serviceWorker.js has a PRECACHE_URLS list", Array.isArray( precache ) );
if ( precache ) {
	const startupAssets = [ ...run.matchAll( /"([^"]+\.js)"/gu ) ]
		.map( m => m[ 1 ] )
		.filter( src => !src.includes( "/" ) || src.startsWith( "assets/" ) );

	check( "startup script loads at least one asset", startupAssets.length > 0 );
	for ( const asset of startupAssets ) {
		check( `precache list contains startup asset ${ asset }`,
			precache.includes( "/" + asset.replace( /^\/+/u, "" ) ) );
	}
	check( "precache list contains the sample library",
		precache.includes( "/assets/gsuiLibrarySamples-v1.js" ) );
	check( "precache list contains the waveform library",
		precache.includes( "/assets/gsuiWaveletList-v1.js" ) );

	// 3. page entry points --------------------------------------------------------
	for ( const entry of [ "/", "/index.html" ] ) {
		check( `precache list contains page entry ${ entry }`, precache.includes( entry ) );
	}

	// 4. obsolete library ---------------------------------------------------------
	check( "precache list no longer contains gswaPeriodicWavesList-v1.js",
		!precache.some( u => u.includes( "gswaPeriodicWavesList" ) ) );
	check( "startup script no longer loads gswaPeriodicWavesList-v1.js",
		!run.includes( "gswaPeriodicWavesList" ) );
	check( "no duplicated entries in precache list",
		new Set( precache ).size === precache.length );
}

// 5. versioned cache lifecycle -------------------------------------------------
check( "cache name is derived from the version",
	/CACHE_NAME\s*=\s*`\$\{\s*CACHE_PREFIX\s*\}\$\{\s*VERSION\s*\}`/u.test( sw ) );
check( "activation deletes the caches of older versions",
	/self\.addEventListener\(\s*"activate"/u.test( sw ) &&
	/isOutdatedCache/u.test( sw ) &&
	/caches\.delete/u.test( sw ) );
check( "cache cleanup is restricted to older versions",
	/compareVersions/u.test( sw ) );
check( "activation takes control of open pages",
	/self\.clients\.claim\(\)/u.test( sw ) );
check( "fetch falls back to the current version's cache only",
	/CACHE_NAME/u.test( sw ) &&
	!/caches\.match\(/u.test( sw.replace( /\/\/.*$/gmu, "" ) ) );

// -----------------------------------------------------------------------------
for ( const p of passes ) {
	console.log( `  ok  ${ p }` );
}
if ( failures.length ) {
	console.error( "" );
	for ( const f of failures ) {
		console.error( `FAIL  ${ f }` );
	}
	console.error( `\n${ failures.length } check(s) failed.` );
	process.exit( 1 );
}
console.log( `\nAll ${ passes.length } checks passed (version ${ confVersion }).` );
