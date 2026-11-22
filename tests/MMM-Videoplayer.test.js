/*
 * Local tests for MMM-Videoplayer playback state transitions.
 *
 * Run with: npm test   (or: node --test tests/)
 *
 * The module file is loaded with a minimal MagicMirror² environment
 * (Module.register, document) so the real module definition can be
 * exercised without a browser.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// --- Minimal MagicMirror² / DOM environment --------------------------------

function makeFakeVideo() {
	const listeners = {};
	return {
		paused: true,
		attrs: {},
		loads: 0,
		plays: 0,
		pauses: 0,
		setAttribute(name, value) {
			this.attrs[name] = value;
		},
		addEventListener(event, callback) {
			listeners[event] = callback;
		},
		load() {
			this.loads++;
		},
		play() {
			this.plays++;
			this.paused = false;
		},
		pause() {
			this.pauses++;
			this.paused = true;
		},
		fireEnded() {
			listeners.ended();
		}
	};
}

let moduleDefinition = null;

global.Module = {
	register(name, definition) {
		moduleDefinition = definition;
	}
};

global.document = {
	createElement(tag) {
		if (tag === "video") {
			return makeFakeVideo();
		}
		return { appendChild() {} };
	}
};

require("../MMM-Videoplayer.js");

// --- Test helpers -----------------------------------------------------------

let instanceCounter = 0;

// Creates a module instance the way MagicMirror² would, including the
// hide()/show() behaviour of the core (hide triggers suspend, show
// triggers resume).
function createInstance(config = {}) {
	const instance = Object.create(moduleDefinition);
	instance.config = Object.assign({}, moduleDefinition.defaults, config);
	instance.identifier = "test_" + ++instanceCounter;
	instance.hidden = false;
	instance.hideCount = 0;
	instance.hide = function () {
		instance.hideCount++;
		instance.hidden = true;
		instance.suspend();
	};
	instance.show = function () {
		instance.hidden = false;
		instance.resume();
	};
	instance.getDom();
	return instance;
}

function notify(instance, payload) {
	instance.notificationReceived(instance.config.notification, payload);
}

const LIST = ["a.mp4", "b.mp4", "c.mp4"];

// --- Playlist advancement (single entry point) ------------------------------

test("initial load plays the first clip through the shared advance path", () => {
	const player = createInstance({ videolist: LIST.slice(), loop: false });
	assert.equal(player.currentVideo, "a.mp4");
	assert.equal(player.video.attrs.src, "a.mp4");
	assert.equal(player.video.paused, false);
	assert.deepEqual(player.playedVideoArray, ["a.mp4"]);
	assert.deepEqual(player.videoArray, ["b.mp4", "c.mp4"]);
});

test("ended event and NEXT notification advance the playlist identically", () => {
	const player = createInstance({ videolist: LIST.slice(), loop: false });
	player.video.fireEnded(); // -> b.mp4 via ended event
	assert.equal(player.currentVideo, "b.mp4");
	notify(player, "NEXT"); // -> c.mp4 via notification
	assert.equal(player.currentVideo, "c.mp4");
	assert.equal(player.video.attrs.src, "c.mp4");
	assert.deepEqual(player.playedVideoArray, LIST);
	assert.deepEqual(player.videoArray, []);
});

test("NEXT with an empty list and loop=false stops safely without throwing", () => {
	const player = createInstance({ videolist: LIST.slice(), loop: false });
	player.video.fireEnded();
	player.video.fireEnded(); // played all three clips
	assert.equal(player.currentVideo, "c.mp4");
	assert.doesNotThrow(() => notify(player, "NEXT"));
	assert.equal(player.currentVideo, null);
	assert.equal(player.video.paused, true);
	// Further NEXT / ended events stay safe.
	assert.doesNotThrow(() => notify(player, "NEXT"));
	assert.doesNotThrow(() => player.video.fireEnded());
});

test("loop=true refills the queue from the played list after a full round", () => {
	const player = createInstance({ videolist: LIST.slice(), loop: true });
	player.video.fireEnded();
	player.video.fireEnded();
	player.video.fireEnded(); // last clip ends, queue was empty -> refill
	assert.equal(player.currentVideo, "a.mp4");
	assert.deepEqual(player.playedVideoArray, ["a.mp4"]);
	assert.deepEqual(player.videoArray, ["b.mp4", "c.mp4"]);
});

test("random mode plays each clip exactly once per round", () => {
	const list = ["v1.mp4", "v2.mp4", "v3.mp4", "v4.mp4", "v5.mp4"];
	const player = createInstance({ videolist: list.slice(), random: true, loop: false });
	for (let i = 0; i < list.length - 1; i++) {
		player.video.fireEnded();
	}
	// One full round: every clip played exactly once, no repeats.
	assert.deepEqual([...player.playedVideoArray].sort(), list);
	assert.equal(player.videoArray.length, 0);
	// Round over and loop=false: next advance stops safely.
	assert.doesNotThrow(() => player.video.fireEnded());
	assert.equal(player.currentVideo, null);
});

test("random mode with loop=true starts a fresh round after a full one", () => {
	const list = ["v1.mp4", "v2.mp4", "v3.mp4"];
	const player = createInstance({ videolist: list.slice(), random: true, loop: true });
	for (let i = 0; i < list.length; i++) {
		player.video.fireEnded();
	}
	// The queue was refilled and a new round started.
	assert.equal(player.playedVideoArray.length, 1);
	assert.equal(player.videoArray.length, list.length - 1);
	assert.ok(list.includes(player.currentVideo));
});

test("an empty playlist never throws and simply stays stopped", () => {
	const player = createInstance({ videolist: [], loop: true });
	assert.equal(player.currentVideo, null);
	assert.doesNotThrow(() => notify(player, "NEXT"));
	assert.doesNotThrow(() => notify(player, "REPLAY"));
});

// --- REPLAY -----------------------------------------------------------------

test("REPLAY restarts the current clip, not another list entry", () => {
	const player = createInstance({ videolist: LIST.slice(), loop: false });
	player.video.fireEnded(); // now playing b.mp4
	const loadsBefore = player.video.loads;
	notify(player, "REPLAY");
	assert.equal(player.video.attrs.src, "b.mp4");
	assert.equal(player.currentVideo, "b.mp4");
	assert.equal(player.video.loads, loadsBefore + 1);
	assert.equal(player.video.paused, false);
	// The playlist state must not be disturbed by a replay.
	assert.deepEqual(player.playedVideoArray, ["a.mp4", "b.mp4"]);
	assert.deepEqual(player.videoArray, ["c.mp4"]);
});

test("REPLAY after a loop reset replays the new current clip", () => {
	const player = createInstance({ videolist: LIST.slice(), loop: true });
	player.video.fireEnded();
	player.video.fireEnded();
	player.video.fireEnded(); // round finished, back to a.mp4
	notify(player, "REPLAY");
	assert.equal(player.video.attrs.src, "a.mp4");
});

// --- Hide / show / notifications ---------------------------------------------

test("hide pauses and show resumes when pauseonhide/resumeonshow are set", () => {
	const player = createInstance({ videolist: LIST.slice() });
	player.hide();
	assert.equal(player.video.paused, true);
	assert.equal(player.pausedByHide, true);
	player.show();
	assert.equal(player.video.paused, false);
	assert.equal(player.pausedByHide, false);
});

test("a manual TOGGLE pause is not overridden by hide/show", () => {
	const player = createInstance({ videolist: LIST.slice() });
	notify(player, "TOGGLE"); // user pauses
	assert.equal(player.video.paused, true);
	player.hide(); // already paused: not a hide-caused pause
	assert.equal(player.pausedByHide, false);
	player.show(); // must NOT resume the user's pause
	assert.equal(player.video.paused, true);
	notify(player, "TOGGLE"); // user resumes
	assert.equal(player.video.paused, false);
});

test("TOGGLE while paused-by-hide takes over from the automatic state", () => {
	const player = createInstance({ videolist: LIST.slice() });
	player.hide();
	assert.equal(player.pausedByHide, true);
	notify(player, "TOGGLE"); // user explicitly resumes while hidden
	assert.equal(player.video.paused, false);
	assert.equal(player.pausedByHide, false);
	player.show(); // no extra state change expected
	assert.equal(player.video.paused, false);
});

test("pauseonhide=false keeps the video playing when hidden", () => {
	const player = createInstance({ videolist: LIST.slice(), pauseonhide: false });
	player.hide();
	assert.equal(player.video.paused, false);
	assert.equal(player.pausedByHide, false);
});

test("resumeonshow=false does not resume a hide-caused pause", () => {
	const player = createInstance({ videolist: LIST.slice(), resumeonshow: false });
	player.hide();
	assert.equal(player.video.paused, true);
	player.show();
	assert.equal(player.video.paused, true);
});

// --- hideonstart --------------------------------------------------------------

test("hideonstart hides once after each clip starts, without a pause loop", () => {
	const player = createInstance({ videolist: LIST.slice(), hideonstart: true });
	// First clip started -> module hidden and paused exactly once.
	assert.equal(player.hidden, true);
	assert.equal(player.hideCount, 1);
	assert.equal(player.video.paused, true);
	assert.equal(player.pausedByHide, true);

	// Shown again -> the same clip resumes.
	player.show();
	assert.equal(player.video.paused, false);
	assert.equal(player.currentVideo, "a.mp4");

	// Clip ends -> next clip starts and the module hides again (once).
	player.video.fireEnded();
	assert.equal(player.currentVideo, "b.mp4");
	assert.equal(player.hidden, true);
	assert.equal(player.hideCount, 2);
	assert.equal(player.video.paused, true);
});

test("hideonstart does not re-hide an already hidden module", () => {
	const player = createInstance({ videolist: LIST.slice(), hideonstart: true });
	// Clip ends while still hidden: advance happens, but no extra hide.
	player.video.fireEnded();
	assert.equal(player.currentVideo, "b.mp4");
	assert.equal(player.hideCount, 1);
});

// --- Notification routing ------------------------------------------------------

test("notifications for other players are ignored", () => {
	const player = createInstance({ videolist: LIST.slice() });
	player.notificationReceived("SOME_OTHER_NOTIFICATION", "NEXT");
	assert.equal(player.currentVideo, "a.mp4");
	player.notificationReceived("SOME_OTHER_NOTIFICATION", "TOGGLE");
	assert.equal(player.video.paused, false);
});
