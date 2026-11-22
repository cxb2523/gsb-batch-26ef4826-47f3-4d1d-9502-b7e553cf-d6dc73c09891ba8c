#!/usr/bin/env node
// Simulate a release: bump the version in every place that carries it.
//
//   node tools/bump-version.mjs            # 2.60.2 -> 2.60.3
//   node tools/bump-version.mjs 2.61.0     # explicit version
//
// Updated files:
//   - version
//   - build-conf.json  ("version", injected into the page as GSDAW-VERSION)
//   - serviceWorker.js (VERSION)
//   - src/serviceWorkerLifecycle.js (GSDAW_VERSION)
//
// The new version makes the browser install a new service worker; the cache
// name changes accordingly, so the previous cache is dropped on activation.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve( dirname( fileURLToPath( import.meta.url ) ), ".." );
const path = name => resolve( root, name );
const read = name => readFileSync( path( name ), "utf8" );

const current = read( "build-conf.json" ).match( /"version"\s*:\s*"([^"]+)"/u )?.[ 1 ];
const explicit = process.argv[ 2 ];
const next = explicit || current.replace( /(\d+)$/u, n => String( Number( n ) + 1 ) );

if ( !/^\d+\.\d+\.\d+$/u.test( next ) ) {
	console.error( `Invalid version: "${ next }" (expected x.y.z)` );
	process.exit( 1 );
}

// Compute every new content first so a failure never leaves the repository
// with only half of its version strings updated.
const targets = [
	[ "build-conf.json", /("version"\s*:\s*)"[^"]+"/u ],
	[ "serviceWorker.js", /(const\s+VERSION\s*=\s*)"[^"]+"/u ],
	[ "src/serviceWorkerLifecycle.js", /(const\s+GSDAW_VERSION\s*=\s*)"[^"]+"/u ],
];
const updates = targets.map( ( [ name, re ] ) => {
	const src = read( name );
	const out = src.replace( re, ( _, head ) => `${ head }"${ next }"` );

	if ( out === src && !src.includes( `"${ next }"` ) ) {
		console.error( `Could not update ${ name }` );
		process.exit( 1 );
	}
	return [ name, out ];
} );

for ( const [ name, out ] of updates ) {
	writeFileSync( path( name ), out );
}
writeFileSync( path( "version" ), next );

console.log( `Version: ${ current } -> ${ next }` );
