# Changelog

## Unreleased

- StreamingAnalyzer accepts a sourceSampleRate and converts incoming samples to the analysis rate with the resample sinc kernel, so frames, RMS and centroid match resampling the whole recording before framing.
- Add StreamingAnalyzer.flush() for the end-of-stream frames whose sinc kernel reaches past the last sample.
- Add StreamingAnalyzer.setSampleRate() to start a new session at another analysis rate, dropping the previous buffer, history and unfinished tail; invalid rates or over-budget ratios throw before any state changes.

## 0.1.1

- Complete browser workbench with waveform, spectrum, logarithmic spectrogram, frame inspection, playback, microphone capture and local exports.
- Add integer and floating-point WAV interchange, exact waveform peak queries and bounded incremental analysis.
- Correct mel conversion, triangular-window geometry, inverse STFT normalization, downsampling filtering and symmetric input validation.
- Verify numerical properties, every public runtime export, strict test types and executable examples.

## 0.1.0

- Establish the TypeScript DSP core, planar audio buffers, signal generators and initial transforms.
