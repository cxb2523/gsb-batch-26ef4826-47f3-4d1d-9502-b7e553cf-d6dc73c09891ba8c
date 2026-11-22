/* MagicMirror²
 * Module: MMM-Videoplayer
 *
 * By Erik Pettersson
 * Assisted by Timo Pettersson
 * Based on the MMM-videoPlay Module by Sungje KIM
 *
 * MIT Licensed.
 */
Module.register("MMM-Videoplayer", {
	defaults: {
		defaultvideo: "/modules/MMM-Videoplayer/video/mov_bbb.mp4",
		//video: "/modules/MMM-Videoplayer/video/mov_bbb.mp4", // This can also be a link to a mp4 file on the internet.
		//videolist: ["/modules/MMM-Videoplayer/video/test01.mp4", "/modules/MMM-Videoplayer/video/test02.mp4", "/modules/MMM-Videoplayer/video/test03.mp4"], // Can also be links to a mp4 files on the internet.
		random: false, // Play the videos randomly.
		loop: true, // Repeat the video list.
		hideonstart: false, // If set to true, the player will hide it self when a clip is loaded (and just started playing). Then when the player is shown again it will continue play the clip and hide itself again when the next clip is loaded (and just starts playing) and so on.
		fadeSpeed: 1000, // The speed to hide the module (milliseconds).
		showcontrols: false, // Set to true if you want the video controls to show.
		preload: "auto", // Can be set to: "auto", "metadata", "none".
		autoplay: true, // If set to true, sound (muted below) has to be true, otherwise the video will not auto play.
		muted: true, // Mute the sound. If auto play is true, this needs to be true as well, otherwise the video will not auto play.
		pauseonhide: true, // If true the module will pause the video when hidden.
		resumeonshow: true, // If true the module will resume the video when shown.
		notification: "VIDEOPLAYER1" // Unique notification string for this player.
	},

	// Loading the CSS
	getStyles: function () {
		return ["MMM-Videoplayer.css"];
	},

	// Pause, play, replay and next video control via notifications using "TOGGLE", "REPLAY" or "NEXT".
	notificationReceived: function (notification, payload) {
		if (notification === this.config.notification) {
			if (payload === "TOGGLE") {
				this.toggleVideo();
			} else if (payload === "NEXT") {
				this.nextVideo();
			} else if (payload === "REPLAY") {
				this.replayVideo();
			}
		}
	},

	// Toggle play/pause (from a notification or another module).
	toggleVideo: function () {
		// A manual toggle is a user decision: it clears any automatic
		// pause state so a later "show" does not override it.
		this.pausedByHide = false;
		if (this.video.paused) {
			this.video.play();
		} else {
			this.video.pause();
		}
	},

	// What happens when the module is hidden.
	suspend: function () {
		// Only pause (and remember why) if the video is actually playing.
		// If the user already paused it manually, leave that state alone.
		if (this.config.pauseonhide && !this.video.paused) {
			this.video.pause();
			this.pausedByHide = true;
		}
	},

	// What happens when the module is shown.
	resume: function () {
		// Only resume if the pause was caused by the hide itself. A clip the
		// user paused manually (via TOGGLE) must stay paused.
		if (this.config.resumeonshow && this.pausedByHide) {
			this.pausedByHide = false;
			this.video.play();
		}
	},

	// Restart the currently playing (or last played) clip from the start.
	replayVideo: function () {
		if (this.currentVideo) {
			this.pausedByHide = false;
			this.video.setAttribute("src", this.currentVideo);
			this.video.load();
			this.video.play();
		}
	},

	// Single entry point for advancing the playlist. Used by the "ended"
	// event, the "NEXT" notification and the initial load in getDom().
	nextVideo: function () {
		// Queue exhausted: refill it from the played list when looping,
		// otherwise stop safely instead of running out of bounds.
		if (this.videoArray.length === 0) {
			if (!this.config.loop || this.playedVideoArray.length === 0) {
				this.stopVideo();
				return;
			}
			this.videoArray = this.playedVideoArray;
			this.playedVideoArray = [];
		}

		// Pick the next clip. Random picks any remaining clip, sequential
		// always takes the first one left in the queue. Because played clips
		// are removed from the queue, a random round never repeats a clip.
		if (this.config.random) {
			this.currentVideoIndex = Math.floor(Math.random() * this.videoArray.length);
		} else {
			this.currentVideoIndex = 0;
		}

		// Move the clip from the queue to the played list and make it current.
		this.currentVideo = this.videoArray.splice(this.currentVideoIndex, 1)[0];
		this.playedVideoArray.push(this.currentVideo);

		// A new clip always starts playing, so any previous automatic pause
		// state no longer applies.
		this.pausedByHide = false;
		this.video.setAttribute("src", this.currentVideo);
		this.video.load();
		this.video.play();

		// Hide after the new clip has started playing. The hide triggers
		// suspend(), which pauses the clip (once) if pauseonhide is set.
		// If the module is already hidden there is nothing more to do, so
		// the hide -> pause -> show -> resume cycle can not loop.
		if (this.config.hideonstart && !this.hidden) {
			this.hide(this.config.fadeSpeed);
		}
	},

	// Stops the player when there is nothing left to play.
	stopVideo: function () {
		this.currentVideo = null;
		if (this.video) {
			this.video.pause();
		}
	},

	// Send the module. :)
	getDom: function () {
		// Setup the video arrays and state.
		this.videoArray = [];
		this.playedVideoArray = [];
		this.currentVideo = null;
		this.currentVideoIndex = 0;
		this.pausedByHide = false;

		// Checks if anything is defined in the config (video or videolist).
		if (!this.config.video && !this.config.videolist) {
			// If not, adds the default clip.
			this.videoArray = [this.config.defaultvideo];
		} else {
			// If videolist is defined, adds them to the array.
			if (this.config.videolist) {
				this.videoArray = this.config.videolist.slice();
			}
			// If video is defined add that first in the array.
			if (this.config.video) {
				this.videoArray.unshift(this.config.video);
			}
		}

		// Build the player.
		var wrapper = document.createElement("div");

		// Adds the video
		this.video = document.createElement("video");

		// Adds the ended event so we know.
		this.video.addEventListener("ended", this.nextVideo.bind(this), false);

		// Adds the rest of the payer video tag settings.
		this.video.muted = this.config.muted;
		this.video.autoplay = this.config.autoplay;
		this.video.loop = false;
		this.video.controls = this.config.showcontrols;
		this.video.preload = this.config.preload;
		this.video.id = this.identifier + "_video";

		// Loads the first video (through the same advance path as everything else).
		this.nextVideo();

		// Wrap it up.
		wrapper.appendChild(this.video);

		//Sends it back to the dom.
		return wrapper;
	}
});
