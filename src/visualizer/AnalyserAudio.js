import { extend } from '../../lib/util/object.js';
import Looper from '../../lib/util/Looper.js';

/**
 * The AnalyserAudio component forms the backbone for all audio visualizations in the player.
 * It uses the Web Audio API to perform real-time frequency and time-domain analysis on audio streams.
 * This base class is meant to be subclassed by visual components that make use of the analysis data to render visual effects.
 * It is not intended to be used directly.
 *
 * The analysis nodes are managed strictly in line with the player's lifecycle: they are created and attached to the
 * `AudioChain` only while the current media and engine support audio analysis, and they are removed and disconnected
 * again on every source change (`data/ready`) or engine switch before the chain for the new media is built.
 * The delayed loop stop used after pausing is cancelled on source changes, replay and destruction, so it can never
 * stop or touch a loop belonging to a different source.
 * @exports module:src/visualizer/AnalyserAudio
 * @requires lib/util/object
 * @requires lib/util/Looper
 * @author   Frank Kudermann - alphanull
 * @version  1.1.0
 * @license  MIT
 */
export default class AnalyserAudio {

    /**
     * Holds the instance configuration for this component.
     * Config object extended by subclasses for specific visualizer settings.
     * @type     {Object}
     * @property {boolean} [audioOnly=false]    If `true`, analysis is active only for audio streams.
     * @property {number}  [channels=1]         Number of audio channels.
     * @property {number}  [hiPass=0]           High-pass filter cutoff value.
     * @property {number}  [loPass=0]           Low-pass filter cutoff value.
     * @property {number}  [fftSize=512]        FFT size for frequency analysis.
     * @property {number}  [minDecibels=-120]   Minimum decibels for analysis.
     * @property {number}  [maxDecibels=0]      Maximum decibels for analysis.
     * @property {number}  [smoothingTime=0.8]  Smoothing time constant for analysis.
     * @property {number}  [stopDelay=1000]     Delay (in ms) after which the analysis loop is stopped when paused.
     */
    #config;

    /**
     * Reference to the main player instance.
     * @type {module:src/core/Player}
     */
    #player;

    /**
     * Holds tokens of subscriptions to player events, for later unsubscribe.
     * @type {number[]}
     */
    #subscriptions;

    /**
     * Secret key only known to the player instance and initialized components.
     * Used to be able to restrict access to API methods in conjunction with secure mode.
     * @type {symbol}
     */
    #apiKey;

    /**
     * Audio analysis data.
     * @property {ChannelSplitterNode} splitter       The channel splitter node used to divide the audio signal into channels.
     * @property {AnalyserNode[]}      analysers      Array of AnalyserNode objects for each channel.
     * @property {Uint8Array[]}        frequencyData  Array of Uint8Array storing frequency data for each channel.
     * @property {Uint8Array[]}        waveformData   Array of Uint8Array storing time-domain data for each channel.
     */
    #audio = {
        splitter: null,
        analysers: [],
        frequencyData: [],
        waveformData: []
    };

    /**
     * Use the shared AudioContext from the player's Audio Manager.
     * @type {AudioContext}
     */
    #audioCtx;

    /**
     * Flag indicating if analysis is active for the current media / engine.
     * @type {boolean}
     */
    #isActive = false;

    /**
     * Flag indicating the component has been destroyed. All further event handlers and API calls become no-ops.
     * @type {boolean}
     */
    #destroyed = false;

    /**
     * Flag indicating that playback is currently paused. While paused the loop keeps running for the
     * configured stop delay, but no new analysis data is collected or rendered.
     * @type {boolean}
     */
    #isPaused = false;

    /**
     * Render Loop Instance, used for updating the scrubber.
     * @type {module:lib/util/Looper}
     */
    #renderLoop;

    /**
     * ID of the stop delay timeout. `0` means no delayed stop is pending.
     * @type {number}
     */
    #stopDelayId = 0;

    /**
     * Number of analysis iterations actually executed (paused/destroyed ticks are not counted).
     * Useful as a read-only liveness signal for tests and diagnostics.
     * @type {number}
     */
    tickCount = 0;

    /**
     * Creates an instance of the AnalyserAudio component.
     * @param {module:src/core/Player} player  Reference to the main player instance.
     * @param {Object}                 config  Configuration object for the AnalyserAudio component. This is passed from the subclass.
     * @param {symbol}                 apiKey  Token for extended access to the player API.
     */
    constructor(player, config = {}, apiKey) {

        const audioCtx = player.audio.getContext(apiKey);

        if (!config || !audioCtx) return [false];

        const configExt = extend({
            audioOnly: true,
            channels: 1,
            hiPass: 0,
            loPass: 0,
            fftSize: 512,
            minDecibels: -120,
            maxDecibels: 0,
            smoothingTime: 0.8,
            stopDelay: 1000
        }, config);

        this.#player = player;
        this.#apiKey = apiKey;
        this.#config = configExt;
        this.#audioCtx = audioCtx;
        this.#renderLoop = new Looper(() => this.#tick());

        this.#subscriptions = [
            this.#player.subscribe('data/ready', this.#onDataReady),
            this.#player.subscribe('player/engine/set', this.#onEngineSet),
            this.#player.subscribe('media/play', this.startLoop.bind(this)),
            this.#player.subscribe('media/pause', this.stopLoop.bind(this))
        ];

        this.#initAnalysers();
        this.#player.audio.addNode(this.#audio.splitter, null, 99, apiKey);

    }

    /**
     * Handles "data/ready" events (i.e. a source switch) by rebuilding the analysis nodes
     * and activating audio analysis based on the new media type.
     * The old nodes are always removed and disconnected first, so they can never be reattached
     * to the chain of the new source, and any pending pause stop delay is cancelled.
     * @param {module:src/core/Data~mediaItem} mediaItem            Object containing media type info.
     * @param {string}                         mediaItem.mediaType  Type of the media ('video' or 'audio').
     * @listens module:src/core/Data#data/ready
     */
    #onDataReady = ({ mediaType }) => {

        if (this.#destroyed) return;

        // a source switch invalidates any pending delayed stop of the former source's loop
        this.#cancelStopDelay();
        this.#renderLoop.stop();
        this.#isPaused = false;

        // tear down the analysis nodes of the previous source before deciding about the new one
        this.#teardownAnalysers();

        this.#isActive = this.#config.audioOnly ? mediaType === 'audio' : true;
        this.#player.dom.getElement(this.#apiKey).classList.toggle('has-audio-analyser', this.#isActive);

        if (this.#isActive) {
            this.#initAnalysers();
            this.#player.audio.addNode(this.#audio.splitter, null, 99, this.#apiKey);
        }

    };

    /**
     * Handles engine switches. The analysis nodes are rebuilt so they only ever belong to the
     * currently active engine's audio chain: they are removed when the new engine cannot filter
     * audio, and (re)created when it can and the current media type is eligible for analysis.
     * @param {Object}  data                        Event payload of `player/engine/set`.
     * @param {Object}  data.from                   Old engine descriptor.
     * @param {Object}  data.to                     New engine descriptor.
     * @listens module:src/core/Player#player/engine/set
     */
    #onEngineSet = ({ from, to }) => {

        if (this.#destroyed) return;

        const wasFilterable = Boolean(from?.capabilities?.filterAudio),
              isFilterable = Boolean(to?.capabilities?.filterAudio);

        if (wasFilterable === isFilterable) return;

        this.#cancelStopDelay();
        this.#renderLoop.stop();
        this.#isPaused = false;

        if (!isFilterable) {
            this.#teardownAnalysers();
            return;
        }

        if (this.#isActive) {
            this.#initAnalysers();
            this.#player.audio.addNode(this.#audio.splitter, null, 99, this.#apiKey);
        }

    };

    /**
     * Initializes the audio analysers for each channel.
     * Creates a ChannelSplitter and an Analyser for each channel, and connects them.
     * No-op if analysers already exist or the component has been destroyed.
     */
    #initAnalysers() {

        if (this.#destroyed || this.#audio.splitter) return;

        this.#audio.splitter = this.#audioCtx.createChannelSplitter(this.#config.channels);

        for (let i = 0; i < this.#config.channels; i += 1) {
            const analyser = this.#audioCtx.createAnalyser();
            analyser.fftSize = this.#config.fftSize;
            analyser.minDecibels = this.#config.minDecibels;
            analyser.maxDecibels = this.#config.maxDecibels;
            analyser.smoothingTime = this.#config.smoothingTime;

            this.#audio.frequencyData.push(new Uint8Array(analyser.frequencyBinCount));
            this.#audio.waveformData.push(new Uint8Array(analyser.frequencyBinCount));
            this.#audio.analysers.push(analyser);
        }

        this.#audio.analysers.forEach((analyser, index) => {
            this.#audio.splitter.connect(analyser, index);
        });

    }

    /**
     * Removes the current analysis nodes from the AudioChain, disconnects them and releases
     * the node references together with their data arrays. Safe to call when nothing is set up.
     */
    #teardownAnalysers() {

        const { splitter, analysers } = this.#audio;

        if (!splitter) return;

        // remove from the chain first (rebuilds the graph without the analyser), then disconnect
        this.#player?.audio?.removeNode(splitter, null, this.#apiKey);

        try {
            splitter.disconnect();
        } catch {}

        analysers.forEach(analyser => {
            try {
                analyser.disconnect();
            } catch {}
        });

        this.#audio = {
            splitter: null,
            analysers: [],
            frequencyData: [],
            waveformData: []
        };

    }

    /**
     * Cancels a pending delayed loop stop, if any.
     */
    #cancelStopDelay() {

        if (this.#stopDelayId) {
            clearTimeout(this.#stopDelayId);
            this.#stopDelayId = 0;
        }

    }

    /**
     * Per-tick wrapper around the subclassed analysis loop.
     * While playback is paused (during the stop delay cooldown), no new data is collected and nothing is rendered.
     */
    #tick() {

        if (this.#destroyed || this.#isPaused) return;
        this.tickCount += 1;
        this.analyseLoop();

    }

    /**
     * Starts the audio analysis loop.
     * Any pending delayed stop is cancelled, so a replay always runs against the current source.
     * @listens module:src/core/Media#media/play
     */
    startLoop() {

        if (this.#destroyed || !this.#isActive) return;

        this.#cancelStopDelay();
        this.#isPaused = false;
        this.#renderLoop.start();

    }

    /**
     * Stops the audio analysis loop after a configured delay.
     * The delay is used so that the visualization can "cool down" without being frozen in place.
     * During the delay the loop stays alive but does not collect or render new data.
     * The pending timer is always cancelled on source change, replay or destruction,
     * so it can never stop a loop belonging to another source or to a destroyed component.
     * @listens module:src/core/Media#media/pause
     */
    stopLoop() {

        if (this.#destroyed || !this.#isActive) return;

        this.#cancelStopDelay();
        this.#isPaused = true;
        this.#stopDelayId = setTimeout(() => {
            this.#stopDelayId = 0;
            if (this.#destroyed) return;
            this.#isPaused = false;
            this.#renderLoop.stop();
        }, this.#config.stopDelay);

    }

    /**
     * Main loop for audio analysis. Retrieves frequency and time domain data, then schedules the next iteration.
     * Used by subclasses in their own rendering loops for collecting data from the analyser.
     * @returns {Object} Object containing both `frequencyData` and `waveformData`.
     */
    analyseLoop() {

        this.#audio.analysers.forEach((analyser, index) => {
            analyser.getByteFrequencyData(this.#audio.frequencyData[index]);
            analyser.getByteTimeDomainData(this.#audio.waveformData[index]);
        });

        return {
            frequencyData: this.#audio.frequencyData,
            waveformData: this.#audio.waveformData
        };

    }

    /**
     * Tears down the AnalyserAudio component.
     * Cancels the stop delay and the render loop, disconnects the audio nodes and removes them from
     * the AudioChain, unsubscribes from all events and releases every reference.
     * Safe to call repeatedly; late events arriving afterwards are no-ops and never throw.
     */
    destroy() {

        if (this.#destroyed) return;
        this.#destroyed = true;

        this.#cancelStopDelay();
        this.#renderLoop.destroy();

        this.#teardownAnalysers();

        this.#player.unsubscribe(this.#subscriptions);
        this.#player = this.#audio = this.#audioCtx = this.#apiKey = null;

    }

    /**
     * Reduces the size of the frequency array to the target size by averaging groups of frequencyData.
     * @param   {number[]} inputArray  Original frequency data array.
     * @param   {number}   targetSize  Desired size of the output array.
     * @returns {number[]}             The reduced frequency data array.
     */
    static reduceFrequencies(inputArray, targetSize) {
        const inputSize = inputArray.length;

        // If the target size is equal to or larger than the input size, return a copy of the array
        if (inputSize <= targetSize) return inputArray.slice(); // Return a copy of the array

        const groupSize = Math.floor(inputSize / targetSize);

        // Array with the averaged values, using map and slice
        return Array.from({ length: targetSize }, (_, i) => {
            const start = i * groupSize,
                  end = i === targetSize - 1 ? inputSize : (i + 1) * groupSize,
                  group = inputArray.slice(start, end);

            // Calculate the average of the current group
            return group.reduce((sum, value) => sum + value, 0) / group.length;
        });
    }
}
