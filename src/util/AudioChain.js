/**
 * The `AudioChain` component implements an own audio processing chain for the player, where other components can insert their own processing chains in order to add effects, filters, analyzers or other processing.
 * This component ensures that all audio is routed through a consistent and controllable flow and also automatically suspends or resumes audio processing based on the media's playback state.
 * If no external `AudioNode`s are attached, the audio is simply passed through. As soon as other modules insert nodes into the chain, they are automatically connected in a logical sequence,
 * and disconnected when removed. Registered nodes can be added or removed at any time (e.g. when switching the source or an engine); the internal graph is rebuilt automatically
 * so that removed nodes are never reconnected and no duplicate connections are created.
 * @exports module:src/util/AudioChain
 * @author Frank Kudermann - alphanull
 * @version 1.2.0
 * @license MIT
 */
export default class AudioChain {

    /**
     * Reference to the main player instance.
     * @type {module:src/core/Player}
     */
    #player;

    /**
     * Holds tokens of subscriptions to player events, for later unsubscribe.
     * @type {number[]|undefined}
     */
    #subscriptions;

    /**
     * Holds tokens of subscriptions to engine events, for later unsubscribe.
     * @type {number[]}
     */
    #subsEngine;

    /**
     * Secret key only known to the player instance and initialized components.
     * Used to be able to restrict access to API methods in conjunction with secure mode.
     * @type {symbol}
     */
    #apiKey;

    /**
     * The Web Audio API context.
     * @type {AudioContext}
     */
    #audioContext;

    /**
     * The Master Gain Node. All nodes will eventually connect to masterGain -> speakers.
     * @type {AudioNode}
     */
    #masterGain;

    /**
     * List of registered audio nodes.
     * @type {Array<{ input: AudioNode, output: AudioNode|null, order: number }>}
     */
    #nodes = [];

    /**
     * Chain edges created by `#connectAudio()` as `[sourceNode, destinationNode]` pairs.
     * Only edges that wire registered nodes into the processing chain are tracked;
     * internal connections within a registered subgraph are deliberately excluded.
     * @type {Array<[AudioNode, AudioNode]>}
     */
    #chainEdges = [];

    /**
     * The MediaElementSourceNode connected to the video element. Will be set in `connectVideo()`.
     * @type {MediaElementAudioSourceNode|null}
     */
    #mediaSource = null;

    /**
     * Timeout id delaying suspending.
     * @type {number}
     */
    #suspendDelayId;

    /**
     * Flag indicating that this component has been destroyed.
     * Used to make late events and repeated API calls after destruction no-ops.
     * @type {boolean}
     */
    #destroyed = false;

    /**
     * Creates an instance of the AudioChain component.
     * @param {module:src/core/Player} player            The player instance.
     * @param {module:src/core/Player} parent            Reference to the parent instance.
     * @param {Object}                 [options]         Additional options.
     * @param {symbol}                 [options.apiKey]  Token for extended access to the player API.
     */
    constructor(player, parent, { apiKey }) {

        if (!player.initConfig('audioChain', true)) return [false];

        // use latencyHint: 'playback' to prevent 'bad' audio on android
        this.#audioContext = new AudioContext({ latencyHint: 'playback' });

        this.#masterGain = this.#audioContext.createGain();
        this.#masterGain.gain.value = 1;
        this.#masterGain.connect(this.#audioContext.destination);

        this.#apiKey = apiKey;

        this.#player = player;
        this.#player.setApi('audio.addNode', this.#addNode, this.#apiKey);
        this.#player.setApi('audio.removeNode', this.#removeNode, this.#apiKey);
        this.#player.setApi('audio.getContext', this.#getContext, this.#apiKey);

        this.#subsEngine = this.#player.subscribe('player/engine/set', ({ from, to, options }) => {
            if (this.#destroyed) return;
            if (!from.capabilities.filterAudio && to.capabilities.filterAudio) this.#enable(options);
            if (from.capabilities.filterAudio && !to.capabilities.filterAudio) this.#disable(options);
        });

    }

    /**
     * Provides the audio context of this component.
     * @param   {symbol}       apiKey  Token needed to grant access in secure mode.
     * @returns {AudioContext}         The current AudioContext.
     * @throws  {Error}                If safe mode access was denied.
     */
    #getContext = apiKey => {

        if (this.#apiKey && this.#apiKey !== apiKey) {
            throw new Error('[Visionplayer] Secure mode: access denied.');
        }

        return this.#audioContext;

    };

    /**
     * Inserts an audio node into the internal processing chain. This method expects the input and output (or `null` if no output is defined, as with analysers)
     * of the processing chain to be inserted, and optionally an `order` value which determines when the inserted chain will be executed.
     * The same input node is never registered twice; repeated calls for an already registered node are ignored.
     * If the chain is currently wired to a media source, the graph is rebuilt so the new node takes effect immediately.
     * @param  {AudioNode}      input    Input node receiving audio.
     * @param  {AudioNode|null} output   Output node passing audio forward (null if not chaining).
     * @param  {number}         [order]  Sorting index for node processing order.
     * @param  {symbol}         apiKey   Token needed to grant access in secure mode.
     * @throws  {Error}                  If safe mode access was denied.
     */
    #addNode = (input, output, order = 0, apiKey) => {

        if (this.#destroyed) return;

        if (this.#apiKey && this.#apiKey !== apiKey) {
            throw new Error('[Visionplayer] Secure mode: access denied.');
        }

        // never register the same processing node twice
        const existing = this.#nodes.find(n => n.input === input);
        if (existing) return;

        this.#nodes.push({ input, output, order });

        // rebuild the live graph so runtime changes (source / engine switches) are applied
        this.#rebuildAudio();

    };

    /**
     * Removes a previously added audio node from the processing chain. This method expects the input and outputs of the processing chain to be removed from the 'master chain'.
     * The node is disconnected and the remaining graph is rebuilt, so a removed node is never connected again.
     * Removing a node that is not (or no longer) registered is a safe no-op.
     * @param  {AudioNode}      input   Input node to remove.
     * @param  {AudioNode|null} output  Output node to remove.
     * @param  {symbol}         apiKey  Token needed to grant access in secure mode.
     * @throws  {Error}                  If safe mode access was denied.
     */
    #removeNode = (input, output, apiKey) => {

        if (this.#destroyed) return;

        if (this.#apiKey && this.#apiKey !== apiKey) {
            throw new Error('[Visionplayer] Secure mode: access denied.');
        }

        const idx = this.#nodes.findIndex(n => n.input === input && (n.output === output || !n.output && !output));

        if (idx < 0) return;

        const [removed] = this.#nodes.splice(idx, 1);

        // disconnect the removed subgraph from everything; internal connections of other nodes stay intact
        try {
            removed.input.disconnect();
            if (removed.output) removed.output.disconnect();
        } catch {} // node might already be disconnected (e.g. during teardown)

        this.#rebuildAudio();

    };

    /**
     * Connects the MediaElementAudioSourceNode to the Web Audio graph.
     * Ensures that only one instance of mediaSource exists.
     * @listens module:src/core/Media#media/ready
     */
    #connectVideo = () => {

        if (this.#destroyed || this.#mediaSource) return;

        const videoElem = this.#player.media.getElement(this.#apiKey);
        this.#mediaSource = this.#audioContext.createMediaElementSource(videoElem); // Create exactly one MediaElementSource for the <video>
        this.#connectAudio(); // Now wire all nodes in the chain

    };

    /**
     * Disconnects the MediaElementAudioSourceNode.
     * @listens module:src/core/Data#data/ready
     */
    #disconnectVideo = () => {

        if (!this.#mediaSource) return;

        try {
            this.#mediaSource.disconnect();
        } catch {}
        this.#mediaSource = null;

    };

    /**
     * Suspends the audio context with a delay after pausing.
     * @listens module:src/core/Media#media/pause
     */
    #suspendAudio = () => {

        if (this.#destroyed) return;

        clearTimeout(this.#suspendDelayId);
        this.#suspendDelayId = setTimeout(() => {
            if (!this.#destroyed) this.#audioContext.suspend();
        }, 2000);

    };

    /**
     * Resumes the audio context immediately when playback starts.
     * @listens module:src/core/Media#media/play
     */
    #resumeAudio = () => {

        if (this.#destroyed) return;

        clearTimeout(this.#suspendDelayId);
        this.#audioContext.resume();

    };

    /**
     * Builds the audio processing chain and connects nodes in the correct order.
     *
     * Each registered entry is fed from the output of the preceding one. Entries without an
     * own output (e.g. analysers) are treated as taps: their input is still connected to the
     * running signal, but the main path continues through the previous output so subsequent
     * nodes and the master gain keep receiving audio. Every created chain edge is recorded in
     * `#chainEdges` so it can be removed again without touching a node's internal subgraph.
     * Does nothing unless a media source is currently connected.
     */
    #connectAudio() {

        if (!this.#mediaSource) return;

        // Sort nodes by order
        const sorted = [...this.#nodes].sort((a, b) => (a.order || 0) - (b.order || 0));

        const connectEdge = (source, destination) => {
            source.connect(destination);
            this.#chainEdges.push([source, destination]);
        };

        // If there are any nodes in the chain, attach them to mediaSource
        if (sorted.length) {

            // `mainOut` tracks the end of the audible path; tap nodes do not advance it
            let mainOut = this.#mediaSource;
            for (const { input, output } of sorted) {
                connectEdge(mainOut, input); // feed this node from the current signal
                if (output) mainOut = output; // pass-through chain extends the audible path
            }
            connectEdge(mainOut, this.#masterGain);

        } else connectEdge(this.#mediaSource, this.#masterGain); // No additional nodes, directly connect mediaSource to masterGain

    }

    /**
     * Tears down exactly the chain edges previously created by `#connectAudio()`.
     * Connections *within* a registered subgraph (e.g. splitter -> analyser, or the EQ's
     * internal filter network) are intentionally preserved, and the registered nodes stay
     * registered so the graph can be rebuilt from them.
     */
    #disconnectAudio() {

        clearTimeout(this.#suspendDelayId);

        this.#chainEdges.forEach(([source, destination]) => {
            try {
                source.disconnect(destination);
            } catch {} // edge may already be gone (e.g. node disconnected during teardown)
        });
        this.#chainEdges = [];

        // re-establish the permanent master output connection in case it was removed too
        try {
            this.#masterGain.connect(this.#audioContext.destination);
        } catch {}

    }

    /**
     * Rebuilds the complete processing graph out of the currently registered nodes.
     * Removed nodes are excluded automatically, and duplicate connections are avoided
     * because the chain edges are fully disconnected before they are rewired.
     */
    #rebuildAudio() {

        this.#disconnectAudio();
        this.#connectAudio();

    }

    /**
     * Enables the audio chain subscriptions and (re)connects on media events.
     * @listens module:src/core/Player#player/engine/set
     */
    #enable() {

        // avoid duplicate subscriptions when enable is called more than once
        if (this.#subscriptions) this.#player.unsubscribe(this.#subscriptions);

        this.#subscriptions = [
            ['data/ready', this.#disconnectVideo],
            ['media/ready', this.#connectVideo],
            ['media/play', this.#resumeAudio],
            ['media/pause', this.#suspendAudio]
        ].map(([event, handler]) => this.#player.subscribe(event, handler));

    }

    /**
     * Disables the audio chain subscriptions and optionally disconnects.
     * @param {Object}  [options]                Options controlling teardown.
     * @param {boolean} [options.suspend=false]  If true, keep connections (no disconnect).
     * @listens module:src/core/Player#player/engine/set
     */
    #disable({ suspend = false } = {}) {

        if (!suspend) this.#disconnectVideo();
        if (this.#subscriptions) {
            this.#player.unsubscribe(this.#subscriptions);
            this.#subscriptions = undefined;
        }

    }

    /**
     * Completely tears down the audio system.
     * Unsubscribes from all events, removes nodes, and closes the audio context.
     * Safe to call multiple times; repeated calls are no-ops.
     */
    destroy() {

        if (this.#destroyed) return;
        this.#destroyed = true;

        clearTimeout(this.#suspendDelayId);

        this.#disconnectAudio();
        this.#disconnectVideo();

        // all registered nodes belong to components that are (or will be) destroyed themselves
        this.#nodes = [];

        this.#audioContext.close();

        this.#player.removeApi(['audio.addNode', 'audio.removeNode', 'audio.getContext'], this.#apiKey);
        if (this.#subscriptions) this.#player.unsubscribe(this.#subscriptions);
        this.#player.unsubscribe(this.#subsEngine);
        this.#player = this.#audioContext = this.#mediaSource = this.#apiKey = null;

    }

}
