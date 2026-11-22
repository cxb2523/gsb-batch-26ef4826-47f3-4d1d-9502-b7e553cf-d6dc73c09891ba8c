import MohayonaoWavDecoder from './MohayonaoWavDecoder.js';

// Decoder state (cached RIFF/WAVE header) belongs to a single session.
let decoderSessionId;
let decoder = new MohayonaoWavDecoder();

self.onmessage = event => {
  const { decode, reset, sessionId } = event.data;

  if (reset) {
    // The decoder caches the RIFF/WAVE header parsed from the first chunk.
    // A new session starts with a new file, so drop that cached metadata.
    decoder = new MohayonaoWavDecoder();
    decoderSessionId = sessionId;
    return;
  }

  if (decode) {
    // Never decode bytes from a session that has already been replaced.
    if (decoderSessionId !== undefined && decoderSessionId !== sessionId) {
      return;
    }
    decoderSessionId = sessionId;

    const decoded = decoder.decodeChunkSync(decode);
    if (!decoded || !decoded.length) {
      return;
    }

    self.postMessage(
      { decoded, sessionId },
      decoded.channelData.map(({ buffer }) => buffer)
    );
  }
};
