// store some DOM elements
var allTabContents = document.querySelectorAll(".tab");
var allTabThumbs = document.querySelectorAll(".thumb");
var mutexTabsArray = Array.from(document.querySelectorAll(".mutex"));
var output = document.getElementById('output');
var playButton = document.getElementById('c_play');
var stopButton = document.getElementById('c_stop');
var helpButton = document.getElementById('c_help');
var paramsButton = document.getElementById('c_params');

// ========== TAB SWITCHING ==========
var allTabContents = document.querySelectorAll(".tab_content");
var allTabThumbs = document.querySelectorAll(".tab_thumb");
function tabClick(event) {
	event.preventDefault();
	document.querySelector('.active_content').classList.remove('active_content');
	document.querySelector('.active_thumb').classList.remove('active_thumb');
	document.querySelector(this.hash).classList.add('active_content');
	this.classList.add('active_thumb');
};
for (var i = 0; allTabThumbs[i]; i++) {
	allTabThumbs[i].addEventListener('click', tabClick);
}
var refElement = document.getElementById('quick_ref')
if (refElement) {
	fetch(staticRoot + "ugen_reference.html", {
		method: "get"
	}).then(function(response) {
		return response.text();
	}).then(function(data) {
		refElement.innerHTML = data;
	});
}
var descElement = document.getElementById("PDesc");
if (descElement) {
	var urlEx = /(\b(https?|ftp|file):\S+\.\S+[^\.\s])/gm;
	descElement.innerHTML = descElement.innerHTML.replace(urlEx, "<a href='$1'>$1</a>");
}

// ========== EMSCRIPTEN / AUDIO LIFECYCLE ==========
var playing = false;
var gotError = false;
var audioCtx = false;
var scriptNode = false;
// guards against overlapping play() calls (e.g. rapid clicks) so that
// two audio contexts can never be live at the same time
var isStarting = false;

var disconnectScriptNode = function() {
	if (!scriptNode) return;
	try { scriptNode.onaudioprocess = null; } catch (e) {}
	try { scriptNode.disconnect(); } catch (e) {}
	scriptNode = false;
};

// Fully tear down the current audio context and its script processing node.
// Safe to call repeatedly and when nothing is playing.
var cleanupStopAudio = function() {
	disconnectScriptNode();
	if (audioCtx) {
		var ctxToClose = audioCtx;
		audioCtx = false;
		try { ctxToClose.suspend(); } catch (e) {}
		try { ctxToClose.close(); } catch (e) {}
	}
	playing = false;
	isStarting = false;
	if (playButton)
		playButton.classList.remove("playing");
};

var makeScriptNode = function(stereo) {
	// buf size, input channels, output channels
	scriptNode = audioCtx.createScriptProcessor(4096, 0, stereo ? 2 : 1);
	scriptNode.onaudioprocess = function(evt) {
		var num_frames = evt.outputBuffer.length;
		var ptr = stereo ? sporthem_process_stereo(num_frames) : sporthem_process(num_frames);
		if (!ptr) return;
		var num_channels = evt.outputBuffer.numberOfChannels;
		for (var chidx = 0; chidx < num_channels; chidx++) {
			var ch = evt.outputBuffer.getChannelData(chidx);
			for (var i = 0; i < num_frames; i++) {
				ch[i] = HEAPF32[(ptr>>2) + ((num_channels*i)+chidx)]
			}
		}
	}
	scriptNode.connect(audioCtx.destination);
};

var initStartAudio = function () {
	audioCtx = new AudioContext({sampleRate: 44100});
	makeScriptNode(false);
};

var initStartAudioStereo = function () {
	audioCtx = new AudioContext({sampleRate: 44100});
	makeScriptNode(true);
};


window.masher_stereo = false;
var play = function () {
	// a start sequence is already in progress: never stack a second one
	if (isStarting) return;
	// completely release any audio context / nodes left from the previous play
	cleanupStopAudio();
	gotError = false;
	isStarting = true;
	if (playButton)
		playButton.classList.add("playing");
	try {
		sporthem_compile(editor.getValue().replace(/\t/g , " "));
		// compile errors are reported through Module.printErr
		if (gotError)
			throw new Error("sporth compile error");
		if (editor.getValue().startsWith('# stereo')) {
			window.masher_stereo = true;
			initStartAudioStereo();
		} else {
			window.masher_stereo = false;
			initStartAudio();
		}
	} catch (err) {
		// make sure the button and state return to "ready to play"
		cleanupStopAudio();
		return;
	}
	if (gotError) {
		cleanupStopAudio();
		return;
	}
	// (re)build sliders from the script that is actually playing and push
	// their current values into the audio engine
	parseParams();
	playing = true;
	isStarting = false;
};
var stop = function() {
	cleanupStopAudio();
};
var Module = {
	print: function(text) {
	},
	printErr: function(text) {
		showError(text);
		gotError = true;
		// a compile/runtime error must always leave the app in a clean,
		// playable state with the button matching the real audio state
		cleanupStopAudio();
	},
	onRuntimeInitialized: function () {
		cwrap('sporthem_init', 'number')();
		sporthem_compile = cwrap('sporthem_compile', 'number', ['string']);
		sporthem_getp = cwrap('sporthem_getp', 'number', ['number']);
		sporthem_setp = cwrap('sporthem_setp', 'number', ['number', 'number']);
		sporthem_process = cwrap('sporthem_process', 'number', ['number']);
		sporthem_process_stereo = cwrap('sporthem_process_stereo', 'number', ['number']);
		if (editor) parseParams();
		var playLoading = document.getElementById("play_loading");
		if (playLoading) {
			playLoading.classList.add("nodisplay");
			playButton.classList.remove("nodisplay");
		}
	},
};
var errorContainer = document.getElementById("errors");
function showError(err) {
	var errDiv = document.createElement("div");
	errDiv.textContent = err;
	errorContainer.appendChild(errDiv);
	tipDiv.classList.remove("on");
	window.setTimeout(function() {
		if (errDiv.parentNode === errorContainer)
			errorContainer.removeChild(errDiv);
	}, 3000);
}

// ========== EDITOR ==========
var ugenList = Object.keys(ugen_ref).map(function(index) { return index });
var ugenRegex = '(?:' + ugenList.join('|') + ')\\b';
CodeMirror.defineSimpleMode("sporth", {
  start: [
	// Rules are matched in the order in which they appear
	{regex: ugenRegex, token: "keyword"},
	{regex: /0x[a-f\d]+|[-+]?(?:\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/i, token: "number"},
	{regex: /#.*/, token: "comment"},
	{regex: /[-+\/*=<>!]+/, token: "operator"},
	// Sporth: treat strings as "variables"
	{regex: /[a-z$][\w$]*/, token: "variable"},
	{regex: /"(?:[^\\]|\\.)*?(?:"|$)/, token: "variable"},
  ]
});
var editorArea, editor;
var lastWord = "";
var tipDiv = document.getElementById("tooltip");
function updateTooltip() {
	var cmWord = editor.findWordAt(editor.getCursor());
	var word = editor.getRange(cmWord.anchor, cmWord.head);
	if (word == lastWord)
		return;
	lastWord = word;
	if (!(word in ugen_ref)) {
		tipDiv.classList.remove("on");
		return;
	}
	var info = ugen_ref[word];
	var out = "";
	if ("Args" in info) {
		out += info["Args"].join(", ") + " ";
	}
	out += "<b>" + word + "</b><br><i>" + info["Description"] + "</i>";
	updateTooltipPos();
	showTooltip(out);
}
function updateTooltipPos() {
	if(editor.cursorCoords().top > (editor.getScrollInfo().clientHeight * 0.5))
		tipDiv.classList.add("top");
	else
		tipDiv.classList.remove("top");
}
function showTooltip(txt) {
	if (errorContainer.childElementCount)
		return;
	tipDiv.innerHTML = txt;
	tipDiv.classList.add("on");
}
editorArea = document.getElementById('editor_area');
if (editorArea != null) {
	editor = CodeMirror.fromTextArea(editorArea, {
		mode: "sporth",
		lineNumbers: true,
		theme: "masher-light",
		extraKeys: {
			'Ctrl-Enter': play,
			'Ctrl-Space': stop,
		}
	});
	editor.on("keyHandled", updateTooltip);
	editor.on("cursorActivity", updateTooltip);
	editor.on("scroll", updateTooltipPos);
	editor.on("changes", function(cm) {
		changed = true;
	});
	editor.setSize("100%", "100%");
	window.onresize = function() {editor.refresh();};
}
var url = new URL(window.location.href);
var urlScript = url.searchParams.get("script");
if (url.pathname == "/new" && urlScript != null)
	editor.setValue(urlScript);


// ========== CONTROLS ==========
var slidersDiv = document.getElementById("sliders");
var noParamsDiv = document.getElementById("no_params");
var firstParse = true;
// live values of the parameter sliders, keyed by parameter name
var sliderValues = {};
// re-parse the current editor script, (re)build every parameter slider and
// push the current slider values into the running audio engine
function parseParams() {
	if (!slidersDiv) return;
	sliderValues = sporthParam_createSliders(slidersDiv, editor.getValue(), sliderValues);
	sporthParam_setPvalues(editor.getValue(), sliderValues);
	if (slidersDiv.innerHTML === "")
		noParamsDiv.className = "";
	else
		noParamsDiv.className = "nodisplay";
	if (firstParse) {
		firstParse = false;
		if (Object.keys(sliderValues).length == 0) return;
		document.body.classList.toggle("paramson");
		editor.refresh();
	}
}
if (editor) {
	if (helpButton)
		helpButton.addEventListener('click', function() {
			document.body.classList.remove("paramson");
			document.body.classList.toggle("helpon");
			editor.refresh();
		});
	if (paramsButton)
		paramsButton.addEventListener('click', function() {
			document.body.classList.remove("helpon");
			document.body.classList.toggle("paramson");
			editor.refresh();
		});
	playButton.addEventListener('click', function() {
		play();
	});
	stopButton.addEventListener('click', function() {
		stop();
	});
}


// ========== AUTOSAVE (per-patch identity) ==========
// Each editable context keeps its own draft in localStorage, keyed by its
// identity:
//   - a brand new patch ("/new", "/continue")      -> "new"
//   - an existing patch ("/patch/<id>")            -> "patch:<id>"
//   - the interactive tutorial ("/learn/...")      -> "learn"
// Tutorial drafts live under their own key and can never overwrite the
// drafts of the user's own new or existing patches.
var DRAFT_STORE_PREFIX = 'AudioMasher_draft_';
var LEGACY_DRAFT_KEY = 'AudioMasher_last_patch';

function getCurrentDraftKey() {
	var patchIdElement = document.getElementById('PId');
	if (patchIdElement && patchIdElement.textContent)
		return DRAFT_STORE_PREFIX + 'patch:' + patchIdElement.textContent;
	if (url.pathname === '/new' || url.pathname === '/continue')
		return DRAFT_STORE_PREFIX + 'new';
	if (url.pathname === '/learn' || url.pathname.indexOf('/learn/') === 0)
		return DRAFT_STORE_PREFIX + 'learn';
	return null;
}
function readDraft(key) {
	if (key === null) return null;
	return localStorage.getItem(key);
}
// Migrate the single legacy draft once, so existing users do not lose their
// saved work when the per-patch draft storage is introduced.
(function migrateLegacyDraft() {
	var legacy = localStorage.getItem(LEGACY_DRAFT_KEY);
	if (legacy === null) return;
	var newKey = DRAFT_STORE_PREFIX + 'new';
	if (localStorage.getItem(newKey) === null)
		localStorage.setItem(newKey, legacy);
	localStorage.removeItem(LEGACY_DRAFT_KEY);
})();

var restoreLink = document.querySelector('.restore_link');
var currentDraftKey = getCurrentDraftKey();
var changed = false;

function autoSave() {
	// only pages with an editor and a draft identity can autosave;
	// the tutorial writes to its own "learn" key, never to user patch drafts
	if (!currentDraftKey || !editor) return;
	if (changed) {
		localStorage.setItem(currentDraftKey, editor.getValue());
		changed = false;
		if (restoreLink)
			restoreLink.classList.remove("on");
	}
}
window.setInterval(autoSave, 10000);

// On editor pages the link restores *this* page's own draft in place;
// on pages without an editor it keeps its original navigation behaviour
// (the server renders the new-patch page and calls restoreAutosave()).
if (restoreLink && currentDraftKey && readDraft(currentDraftKey) !== null)
	restoreLink.classList.add("on");
if (restoreLink && editor) {
	restoreLink.addEventListener('click', function(event) {
		event.preventDefault();
		restoreAutosave();
	});
}

function restoreAutosave() {
	if (!editor) return;
	var draft = readDraft(currentDraftKey);
	if (draft === null) return;
	// rebuild sliders from the restored script rather than from any
	// slider state left over from a previous script
	sliderValues = {};
	editor.setValue(draft);
	// re-parse the restored script so the sliders match its parameters,
	// and push the (script-derived) slider values into the audio engine
	parseParams();
	if (restoreLink)
		restoreLink.classList.remove("on");
	changed = false;
}


// ========== MODALS ==========
function setupModal(cfg, parent) {
	var m = {};
	m.show = function(event) {
		event.preventDefault();
		m.front.innerHTML = cfg.content;
		m.progress = document.getElementById("modal_progress");
		m.form = document.querySelector("#modal_front form");
		m.cross = document.getElementById("close_modal");
		if (editor && m.form) {
			var contentSender = document.createElement("input");
			contentSender.type = "hidden";
			contentSender.name = "main_script";
			contentSender.value = editor.getValue();
			m.form.appendChild(contentSender);
		}
		// add modal's event listeners
		document.body.addEventListener('keyup', m.handleEsc);
		m.cross.addEventListener('click', m.hide);
		m.back.addEventListener('click', m.hide);
		if (m.form) m.form.addEventListener('submit', m.submit);
		// show it once everything is set up
		m.back.classList.add("on");
		m.front.classList.add("on");
		var firstInput = m.form.querySelectorAll("input")[0]
		if (firstInput) firstInput.focus();
		setupModals(m.front);
		if(cfg.onReady)
			cfg.onReady(m);
	};
	m.hide = function(event) {
		event.preventDefault();
		m.back.classList.remove("on");
		m.front.classList.remove("on");
		// remove modal's event listeners
		document.body.removeEventListener('keyup', m.handleEsc);
		m.cross.removeEventListener('click', m.hide);
		m.back.removeEventListener('click', m.hide);
		if (m.form) m.form.removeEventListener('submit', m.submit);
	};
	m.handleEsc = function(event) {
		if (event.keyCode == 27) // esc
			m.hide(event);
	};
	m.submit = function(event) {
		event.preventDefault();
		// send ajax request
		m.progress.innerHTML = "sending request...";
		fetch(cfg.postURL, {
			method: 'post',
			credentials: 'include',
			body: new FormData(m.form)
		}).then(function(response) {
			return response.json();
		}).then(function(data) {
			m.result = data;
			if (!m.result.success || cfg.alwaysConfirm)
				alert(m.result.message);
			m.progress.innerHTML = "&nbsp;";
			if(m.result.success)
				cfg.onSuccess(m);
		});
	};
	m.back = document.getElementById("modal_back");
	m.front = document.getElementById("modal_front");
	var triggerLinks = parent.querySelectorAll(cfg.triggerLinks);
	for (var i = 0; triggerLinks[i]; i++) {
		triggerLinks[i].addEventListener('click', m.show);
	}
}
function setupModals(parent) {
	for (var i = 0; modals[i]; i++) {
		setupModal(modals[i], parent)
	}
}

modals = [
	{
		triggerLinks: "a[href='#login_modal']",
		content: 
			'<h2>Log in</h2>'+
			'<a id=close_modal>[close]</a>'+
			'<form>'+
			'<div class="label">username:</div>'+
			'<input type=text name=username><br>'+
			'<br>'+
			'<div class="label">password:</div>'+
			'<input type=password name=password><br>'+
			'<br><hr><center>'+
			'<input type=submit value=OK><br>'+
			'</form>'+
			'<div id=modal_progress>&nbsp;</div><br></center>'+
			'<center>or <a href="#signup_modal">create an account</a></center>',
		postURL: "/api/login",
		onSuccess: function(modal) { location = "/continue"; },
	},
	{
		triggerLinks: "a[href='#signup_modal']",
		content: 
			'<h2>Create Account</h2>'+
			'<a id=close_modal>[close]</a>'+
			'Create an account in order to post patches.<br><br>'+
			'<form>'+
			'<div class="label">username:</div>'+
			'<input type=text name=username><br>'+
			'<br>'+
			'<div class="label">password:</div>'+
			'<input type=password name=password><br>'+
			'<br>'+
			'<div class="label">email (optional):</div>'+
			'<input type=text name=email><br>'+
			'<br><hr><center>'+
			'<input type=submit value="create account"><br>'+
			'</form>'+
			'<div id=modal_progress>&nbsp;</div><br></center>'+
			'<center>or <a href="#login_modal">log in</a></center>',
		postURL: "/api/signup",
		onSuccess: function(modal) { location = "/continue"; },
		alwaysConfirm: true,
	},
	{
		triggerLinks: "a[href='#post_modal']",
		content: 
			'<h2>Post Patch</h2>'+
			'<a id=close_modal>[close]</a>'+
			'<form>'+
			'Title:<br>'+
			'<input type=text name=title id=formtitle><br>'+
			'Description:<br>'+
			'<textarea name=desc id=formdesc></textarea><br>'+
			'<br><hr><center>'+
			'<input type=submit value=OK><br>'+
			'</form>'+
			'<div id=modal_progress>&nbsp;</div><br></center>',
		postURL: "/api/post",
		onReady: function(modal) {
			if (document.getElementById("PTitle")) {
				document.getElementById("formtitle").value = document.getElementById("PTitle").textContent;
				document.getElementById("formdesc").value = "Fork of " + 
					document.getElementById("PTitle").textContent +
					" by " +
					document.getElementById("PAuthor").textContent;
			}
		},
		onSuccess: function(modal) { location = "/patch/" + modal.result.patchId; },
		alwaysConfirm: true,
	},
	{
		triggerLinks: "a[href='#update_modal']",
		content: 
			'<h2>Update Patch</h2>'+
			'<a id=close_modal>[close]</a>'+
			'<form>'+
			'Title:<br>'+
			'<input type=text name=title id=formtitle><br>'+
			'Description:<br>'+
			'<textarea name=desc id=formdesc></textarea><br>'+
			'<br><hr><center>'+
			'<input type=hidden name=update_id id=formid>'+
			'<input type=submit value=OK><br>'+
			'</form>'+
			'<div id=modal_progress>&nbsp;</div><br></center>'+
			'<center>or <a href="#post_modal">post as a new patch</a></center>',
		postURL: "/api/update",
		onReady: function(modal) {
			document.getElementById("formtitle").value = document.getElementById("PTitle").textContent;
			document.getElementById("formdesc").value = document.getElementById("PDesc").textContent;
			document.getElementById("formid").value = document.getElementById("PId").textContent;
		},
		onSuccess: function(modal) { location = "/patch/" + modal.result.patchId; },
		alwaysConfirm: true,
	},
	{
		triggerLinks: "a[href='#delete_modal']",
		content: 
			'<h2>Delete Patch</h2>'+
			'<a id=close_modal>[close]</a>'+
			'<form><br>'+
			'Are you sure you want to delete "<span id=STitle></span>"? This is not reversible.'+
			'<input type=hidden name=delete_id id=formid>'+
			'<br><br><hr><center>'+
			'<input type=submit value="Yes, delete this patch">'+
			'&nbsp;&nbsp;<button id=formno>No</button><br>'+
			'</form>'+
			'<div id=modal_progress>&nbsp;</div><br></center>',
		postURL: "/api/delete",
		onReady: function(modal) {
			document.getElementById("STitle").innerText = document.getElementById("PTitle").textContent;
			document.getElementById("formid").value = document.getElementById("PId").textContent;
			document.getElementById("formno").onclick = modal.hide;
		},
		onSuccess: function(modal) { location = "/browse"; },
		alwaysConfirm: true,
	},
];


setupModals(document);


