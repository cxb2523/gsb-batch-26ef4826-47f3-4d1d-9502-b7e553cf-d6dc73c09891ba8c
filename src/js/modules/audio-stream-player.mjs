import { BufferedStreamReader } from './buffered-stream-reader.mjs';

// 100ms allows enough time for the largest 60ms Opus frame to decode before
// the first AudioBuffer is scheduled.
const INITIAL_START_DELAY = 100 / 1000;

/* A single streaming playback session.
 *
 * Every start() creates a new session with a unique, monotonically increasing
 * id.  Readers, worker callbacks and scheduled AudioBufferSourceNodes all
 * capture the id of the session they belong to, so anything that arrives after
 * a reset/close (late download progress, late decoder messages, late onended
 * callbacks) is ignored instead of leaking into the next session or reviving
 * counters that were just cleared.
 */
export class AudioStreamPlayer {
  // these shouldn't change once set
  _worker;
  _url;
  _readBufferSize;

  // these are reset for every playback session
  _sessionId;            // id of the active session, null when closed
  _lastSessionId = 0;    // source of monotonically increasing session ids
  _audioCtx;             // Created/Closed when this player starts/stops audio
  _reader;               // BufferedStreamReader of the active session
  _audioSrcNodes;        // Used to fix Safari Bug https://github.com/AnthumChris/fetch-stream-audio/issues/1
  _totalTimeScheduled;   // time scheduled of all AudioBuffers
  _playStartedAt;        // audioContext.currentTime of first sched
  _abCreated;            // AudioBuffers created
  _abEnded;              // AudioBuffers played/ended
  _skips;                // audio skipping caused by slow download
  _downloadStartTime;    // performance.now() at start of session

  constructor(url, readBufferSize, decoderName) {
    switch (decoderName) {
      case 'PCM': this._worker =  new Worker('../worker-decoder-wav.js'); break;
      case 'OPUS': this._worker = new Worker('../worker-decoder-opus.js'); break;
      default: throw Error('Unsupported decoderName', decoderName);
    }

    this._worker.onerror = event => {
      // A worker error is only meaningful for the session that is still open.
      if (this._sessionId) {
        this._updateState({ error: event.message });
      }
    };
    this._worker.onmessage = this._onWorkerMessage.bind(this);

    // pause for now
    // this._audioCtx.suspend().then(_ => console.log('audio paused'));

    this._url = url;
    this._readBufferSize = readBufferSize;
    this._reset();
  }

  // Clears all session-scoped state.  Does not perform any cleanup; use
  // _teardown()/close() for that.
  _reset() {
    this._sessionId = null;
    this._audioCtx = null;
    this._reader = null;
    this._audioSrcNodes = [];
    this._totalTimeScheduled = 0;
    this._playStartedAt = 0;
    this._abCreated = 0;
    this._abEnded = 0;
    this._skips = 0;
    this._downloadStartTime = 0;
  }

  // Stops and disconnects every scheduled source node.  Their onended handlers
  // are removed first so they cannot change the counters of a later session.
  _stopScheduledAudio() {
    const nodes = this._audioSrcNodes;
    this._audioSrcNodes = [];

    for (const node of nodes) {
      node.onended = null;
      try { node.stop(); } catch (e) { /* already stopped */ }
      try { node.disconnect(); } catch (e) { /* already disconnected */ }
    }
  }

  _closeAudioContext() {
    const audioCtx = this._audioCtx;
    this._audioCtx = null;
    if (!audioCtx) return;

    try {
      const closing = audioCtx.close();
      if (closing && typeof closing.catch === 'function') {
        closing.catch(_ => {});
      }
    } catch (e) {
      // context may already be closed
    }
  }

  // Abort the download, drop scheduled audio, close the AudioContext and clear
  // every session counter.  Idempotent.
  _teardown() {
    const reader = this._reader;
    this._reader = null;
    if (reader) {
      reader.abort();
    }

    this._stopScheduledAudio();
    this._closeAudioContext();
    this._reset();
  }

  close() {
    this._teardown();
  }

  // Returns true when the session started, false when it failed synchronously.
  start() {
    // Starting again without an explicit reset must not inherit the previous
    // session's reader, schedule time, counters or AudioContext.
    this._teardown();

    const sessionId = ++this._lastSessionId;
    this._sessionId = sessionId;
    this._downloadStartTime = performance.now();

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx({ latencyHint: 'interactive' });
      this._audioCtx = audioCtx;

      // Reset decoder state (buffers, queued flushes, WAV header state) before
      // any bytes of this session reach the worker.
      this._worker.postMessage({ reset: true, sessionId });

      const reader = new BufferedStreamReader(new Request(this._url), this._readBufferSize);

      // Capture sessionId so late data from this reader is never mistaken for
      // data of a newer session.
      reader.onRead = progress => this._downloadProgress(sessionId, progress);
      reader.onBufferFull = chunk => this._decode(sessionId, chunk);

      this._reader = reader;

      reader.read()
      .catch(e => {
        if (this._sessionId !== sessionId) return;
        this._updateState({ error: e.toString() });
      });
    } catch (e) {
      // e.g. AudioContext quota exceeded or an invalid URL: fail this session
      // cleanly instead of leaving a half-started one behind.
      this._updateState({ error: e.toString() });
      this._teardown();
      return false;
    }

    this.resume();
    return true;
  }

  pause() {
    const audioCtx = this._audioCtx;
    if (!audioCtx) return;
    audioCtx.suspend()
      .then(_ => {
        if (this._audioCtx === audioCtx) this._updateState({ playState: 'paused' });
      })
      .catch(_ => {});
  }

  resume() {
    const audioCtx = this._audioCtx;
    if (!audioCtx) return;
    audioCtx.resume()
      .then(_ => {
        if (this._audioCtx === audioCtx) this._updateState({ playState: 'playing' });
      })
      .catch(_ => {});
  }

  _updateState(props) {
    // Nothing may touch the UI (or the counters) once a session ended.
    if (!this._sessionId) return;

    const abState = !this._abCreated ? {} : {
      abCreated: this._abCreated,
      abEnded: this._abEnded,
      abRemaining: Math.max(0, this._abCreated - this._abEnded),
      skips: this._skips
    };
    const state = Object.assign(abState, props);
    if (this.onUpdateState) {
      this.onUpdateState(state);
    }
  }

  _decode(sessionId, { bytes }) {
    if (this._sessionId !== sessionId) return;
    if (!bytes || !bytes.byteLength) return;

    this._worker.postMessage({ decode: bytes.buffer, sessionId }, [bytes.buffer]);
  }

  // Prevent race condition by checking sessionId
  _onWorkerMessage(event) {
    const data = event && event.data;
    if (!data || !data.decoded || !data.decoded.channelData) return;

    const { decoded, sessionId } = data;
    // Late messages from a previous session are dropped, never adopted.
    if (!this._sessionId || sessionId !== this._sessionId) {
      return;
    }

    this._schedulePlayback(decoded, sessionId);
  }

  _downloadProgress(sessionId, { totalRead, totalBytes }) {
    if (this._sessionId !== sessionId) return;

    const elapsed = performance.now() - this._downloadStartTime;
    this._updateState({
      bytesRead: totalRead,
      bytesTotal: totalBytes,
      dlRate: elapsed > 0 ? totalRead * 8 / elapsed : 0
    });
  }

  _schedulePlayback({ channelData, length, numberOfChannels, sampleRate }, sessionId) {
    const audioCtx = this._audioCtx;
    if (this._sessionId !== sessionId || !audioCtx) return;

    // createBuffer() rejects zero-length buffers, e.g. an empty final decode.
    if (!length) return;

    const audioSrc = audioCtx.createBufferSource();
    let audioBuffer;
    try {
      audioBuffer = audioCtx.createBuffer(numberOfChannels, length, sampleRate);
    } catch (e) {
      // e.g. unsupported sample rate: drop this chunk, keep the session alive.
      try { audioSrc.disconnect(); } catch (ignored) { /* noop */ }
      return;
    }

    let hasEnded = false;
    audioSrc.onended = () => {
      if (hasEnded) return;
      hasEnded = true;

      // The session may have been reset between scheduling and this callback.
      if (this._sessionId !== sessionId || this._audioCtx !== audioCtx) return;

      const index = this._audioSrcNodes.indexOf(audioSrc);
      if (index !== -1) {
        this._audioSrcNodes.splice(index, 1);
      }

      if (this._abEnded < this._abCreated) {
        this._abEnded++;
      }
      this._updateState();
    };

    this._abCreated++;
    // adding also ensures onended callback is fired in Safari
    this._audioSrcNodes.push(audioSrc);
    this._updateState();

    // Use performant copyToChannel() if browser supports it
    for (let c = 0; c < numberOfChannels; c++) {
      if (audioBuffer.copyToChannel) {
        audioBuffer.copyToChannel(channelData[c], c);
      } else {
        const toChannel = audioBuffer.getChannelData(c);
        for (let i = 0; i < channelData[c].length; i++) {
          toChannel[i] = channelData[c][i];
        }
      }
    }

    let startDelay = 0;
    // initialize first play position.  initial clipping/choppiness sometimes occurs and intentional start latency needed
    // read more: https://github.com/WebAudio/web-audio-api/issues/296#issuecomment-257100626
    if (!this._playStartedAt) {
      startDelay = INITIAL_START_DELAY;
      this._playStartedAt = audioCtx.currentTime + startDelay;
      this._updateState({ latency: performance.now() - this._downloadStartTime + startDelay * 1000 });
    }

    audioSrc.buffer = audioBuffer;
    audioSrc.connect(audioCtx.destination);

    const startAt = this._playStartedAt + this._totalTimeScheduled;
    if (audioCtx.currentTime >= startAt) {
      this._skips++;
      this._updateState();
    }
    audioSrc.start(startAt);

    this._totalTimeScheduled += audioBuffer.duration;
  }
}
