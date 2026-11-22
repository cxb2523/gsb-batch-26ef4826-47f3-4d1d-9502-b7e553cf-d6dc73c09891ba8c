import { OpusStreamDecoder } from 'opus-stream-decoder';
import { DecodedAudioPlaybackBuffer } from './modules/decoded-audio-playback-buffer.mjs';

const decoder = new OpusStreamDecoder({ onDecode });
const playbackBuffer = new DecodedAudioPlaybackBuffer({ onFlush });
let sessionId, flushTimeoutId, decodingSessionId;

function evalSessionId(newSessionId) {
  // detect new session and reset decoder/playback buffer state
  if (sessionId === newSessionId) {
    return;
  }

  sessionId = newSessionId;

  // Drop any flush scheduled by the previous session; otherwise its buffered
  // samples would be posted tagged with the new sessionId and played there.
  if (flushTimeoutId) {
    clearTimeout(flushTimeoutId);
    flushTimeoutId = null;
  }

  playbackBuffer.reset();
}

self.onmessage = async (evt) => {
  const { decode, reset, sessionId: messageSessionId } = evt.data;

  if (reset) {
    // Discard all state carried over from the previous session.
    sessionId = messageSessionId;
    if (flushTimeoutId) {
      clearTimeout(flushTimeoutId);
      flushTimeoutId = null;
    }
    playbackBuffer.reset();
    return;
  }

  if (!decode) {
    return;
  }

  evalSessionId(messageSessionId);
  const decodeSessionId = messageSessionId;

  await decoder.ready;

  // A newer session may have started while we were waiting for the decoder.
  if (sessionId !== decodeSessionId) {
    return;
  }

  // Persist until the next decode() call: onDecode runs for the session that
  // is currently being decoded, even if it fires asynchronously.
  decodingSessionId = decodeSessionId;
  decoder.decode(new Uint8Array(decode));
};

function onDecode({ left, right, samplesDecoded, sampleRate }) {
  // Decoder recovers when it receives new files, and samplesDecoded is negative.
  // For cause, see https://github.com/AnthumChris/opus-stream-decoder/issues/7
  if (samplesDecoded < 0) {
    return;
  }

  // Ignore samples produced for a session that is no longer current.
  if (!decodingSessionId || decodingSessionId !== sessionId) {
    return;
  }

  playbackBuffer.add({ left, right});
  scheduleLastFlush(decodingSessionId);
}

function onFlush({ left, right }) {
  if (!left.length) {
    return;
  }

  const decoded = {
    channelData: [left, right],
    length: left.length,
    numberOfChannels: 2,
    sampleRate: 48000
  };

  self.postMessage(
    { decoded, sessionId },
    [
      decoded.channelData[0].buffer,
      decoded.channelData[1].buffer
    ]
  );
}

// No End of file is signaled from decoder. This ensures last bytes always flush
function scheduleLastFlush(flushSessionId) {
  if (flushTimeoutId) {
    clearTimeout(flushTimeoutId);
  }
  flushTimeoutId = setTimeout(_ => {
    flushTimeoutId = null;
    // Never flush the previous session's leftovers into a newer session.
    if (flushSessionId !== sessionId) {
      return;
    }
    playbackBuffer.flush();
  }, 100);
}
