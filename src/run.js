"use strict";

document.addEventListener( "gsui", ( { detail: d } ) => console.warn( `uncatched event: "${ d.$event }"`, d.$args, d.$target ) );

// The service worker is registered as early as possible (the registration
// lives in src/serviceWorkerLifecycle.js, loaded before this file). Here the
// startup flow only asks for a version switch once the user decided to start,
// so a version installed while the splash screen was displayed never
// interrupts or reloads the page on its own.
const gsDAWLoadLib = src => window.GSDAWOffline
	? GSDAWOffline.loadScript( src )
	: GSUloadJSFile( src );

new Promise( resolve => {
	const el = $( "#splashScreen" );
	const elFirefox = el.$query( "[data-alert=firefox]" );

	GSUonFirefox
		? elFirefox.$css( "display", "block" )
		: elFirefox.$remove();
	el.$addAttr( "data-loaded" )
		.$query( "button" )
		.$onclick( () => {
			el.$addAttr( "data-starting" );
			GSUsetTimeout( resolve, .1 );
		} )
		.$disabled( false );
} )
	.then( () => {
		// Start switching to a waiting version right away, in parallel with
		// the audio context resume, but await it before the libraries are
		// loaded: the startup flow is not interrupted (no reload, no extra
		// click) and the loads below hit the newly active version. When no
		// version is waiting this resolves immediately.
		const switched = window.GSDAWOffline
			? GSDAWOffline.activateWaitingVersion()
			: Promise.resolve( { switched: false } );

		return gswaContext.$resume()
			.then( () => switched )
			.then( info => {
				if ( info.switched ) {
					console.info( `Service worker: switched to v${ info.version }` );
				}
			} );
	} )
	.then( () => gsDAWLoadLib( "assets/gsuiLibrarySamples-v1.js" ) )
	.then( () => gsDAWLoadLib( "assets/gsuiWaveletList-v1.js" ) )
	.then( () => {
		const daw = new GSDAW();
		const el = $( "#splashScreen" );

		daw.$init();
		el.$addAttr( "data-started" );
		GSUsetTimeout( () => el.$remove(), .8 );
		// window.$daw = daw.getDAWCore();
	} );
