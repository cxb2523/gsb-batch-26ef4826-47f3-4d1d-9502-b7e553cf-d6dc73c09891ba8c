# Incremental analysis

## StreamingAnalyzer

Construct a StreamingAnalyzer with sampleRate, frameSize, hopSize and optional retainFrames. Push consecutive sample chunks in order. Each call returns newly completed frames; framesOut exposes retained history. reset clears both samples and frame position.

Chunk boundaries do not change frame results. Hop sizes may overlap frames or skip samples. Internal sample storage remains bounded, and retained history is limited independently from incoming chunk length. A retainFrames value of zero is useful when the caller consumes emitted frames immediately.

Streaming analysis does not own an audio device. Feed it decoded file chunks, an application stream or captured samples. It produces signal descriptors, not transcription tokens. Keep acquisition timestamps separately if the producer can pause or drop data.

## Converting the input rate

Microphone and file sources rarely run at the analysis rate a user picked. Pass `sourceSampleRate` next to `sampleRate`; it defaults to `sampleRate`, and when the two differ the analyzer converts on the fly:

```js
const analyzer = new StreamingAnalyzer({
  sampleRate: 16000, // analysis rate
  sourceSampleRate: 48000, // microphone or file rate
  frameSize: 512,
  hopSize: 256,
});

for (const chunk of chunks) frames.push(...analyzer.push(chunk));
frames.push(...analyzer.flush()); // source stream ended
```

Conversion reuses the windowed-sinc kernel of `resample(..., 'sinc')`, so the emitted frames match "resample the whole recording, then frame it" with the same `frameSize`/`hopSize`. Frame counts, RMS and centroid agree with that batch result; chunk split positions still make no difference.

A converted output sample depends on nearby source samples in both directions, so a frame is emitted only after every source sample it needs has arrived. `flush()` completes the frames at the end of the stream; call it once after the final push. It returns frames, exactly like `push`, and pushing after it continues the same session. A same-rate analyzer never needs it and `flush()` returns an empty array.

## Switching the analysis rate

Call `setSampleRate(nextRate, nextSourceRate?)` to start a new session. It drops the ring buffer, the received count, retained history and the unfinished tail of the previous session, so the next frame begins at the new session's first complete frame. Nothing from the old rate mixes into the new one.

When both rates already match the current session the call returns without resetting. When `sourceSampleRate` was declared at construction the input rate stays pinned unless a new one is passed — changing the analysis rate should not silently reinterpret incoming samples. Without a declared input rate, the input follows the analysis rate.

Rates and the sinc kernel budget are validated before any state changes. An invalid rate or a ratio whose kernel exceeds its budget throws, and the analyzer keeps its current session and remains usable for further pushes.
