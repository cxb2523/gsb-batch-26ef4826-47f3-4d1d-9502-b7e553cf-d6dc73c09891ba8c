import { useEffect, useRef, useState } from 'react';
import { SSTVDecoder, DecoderStats } from '@/lib/sstv/decoder';
import { SSTV_MODES } from '@/lib/sstv/constants';

export type SSTVMode = keyof typeof SSTV_MODES;

export interface AudioProcessorState {
  isRecording: boolean;
  isSupported: boolean;
  error: string | null;
  stats: DecoderStats | null;
}

export function useAudioProcessor(mode: SSTVMode = 'ROBOT36') {
  const [state, setState] = useState<AudioProcessorState>({
    isRecording: false,
    isSupported: false,
    error: null,
    stats: null,
  });

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const decoderRef = useRef<SSTVDecoder | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);

  // Latest selected mode, read by async start-up so a mode chosen while
  // getUserMedia is still pending is not lost.
  const modeRef = useRef<SSTVMode>(mode);

  // Session token: bumped on every start/stop/unmount. Async callbacks and
  // audio callbacks compare against it and bail out when they belong to an
  // older session, so nothing writes state after stop or unmount.
  const sessionRef = useRef(0);
  const isRecordingRef = useRef(false);
  const mountedRef = useRef(true);
  // Guards against two overlapping startRecording calls (double click) which
  // would otherwise build two decoders writing to the same canvas.
  const startInFlightRef = useRef(false);

  // Check browser support on mount
  useEffect(() => {
    const checkSupport = () => {
      const hasAudioContext = typeof window !== 'undefined' && 'AudioContext' in window;
      const hasMediaDevices = typeof navigator !== 'undefined' &&
                              navigator.mediaDevices &&
                              typeof navigator.mediaDevices.getUserMedia === 'function';

      setState(prev => ({
        ...prev,
        isSupported: hasAudioContext && hasMediaDevices
      }));
    };

    checkSupport();
  }, []);

  /**
   * Calculate Signal-to-Noise Ratio (SNR) in dB
   * Uses AnalyserNode to measure signal power in SSTV band vs noise floor
   */
  const calculateSNR = (): number | null => {
    const analyser = analyserRef.current;
    const audioContext = audioContextRef.current;
    if (!analyser || !audioContext) return null;

    // Get frequency data
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    const sampleRate = audioContext.sampleRate;
    const nyquist = sampleRate / 2;

    // SSTV signal band: 1200-2300 Hz (sync to white)
    const signalBandStart = 1200;
    const signalBandEnd = 2300;

    // Noise bands (outside SSTV signal)
    // Lower band: 300-1000 Hz (below SSTV)
    // Upper band: 2500-4000 Hz (above SSTV)
    const noiseBandLow1 = 300;
    const noiseBandLow2 = 1000;
    const noiseBandHigh1 = 2500;
    const noiseBandHigh2 = 4000;

    // Convert frequencies to bin indices
    const freqToBin = (freq: number) => Math.floor((freq / nyquist) * bufferLength);

    const signalBinStart = freqToBin(signalBandStart);
    const signalBinEnd = freqToBin(signalBandEnd);
    const noiseBinLow1 = freqToBin(noiseBandLow1);
    const noiseBinLow2 = freqToBin(noiseBandLow2);
    const noiseBinHigh1 = freqToBin(noiseBandHigh1);
    const noiseBinHigh2 = freqToBin(noiseBandHigh2);

    // Calculate average power in signal band
    let signalPower = 0;
    let signalCount = 0;
    for (let i = signalBinStart; i <= signalBinEnd; i++) {
      // Convert byte value (0-255) to linear power (squaring approximates power)
      signalPower += dataArray[i] * dataArray[i];
      signalCount++;
    }
    signalPower = signalPower / signalCount;

    // Calculate average power in noise bands
    let noisePower = 0;
    let noiseCount = 0;

    // Lower noise band
    for (let i = noiseBinLow1; i <= noiseBinLow2; i++) {
      noisePower += dataArray[i] * dataArray[i];
      noiseCount++;
    }

    // Upper noise band
    for (let i = noiseBinHigh1; i <= noiseBinHigh2; i++) {
      noisePower += dataArray[i] * dataArray[i];
      noiseCount++;
    }

    noisePower = noisePower / noiseCount;

    // Avoid division by zero and log of zero
    if (noisePower < 1) noisePower = 1;
    if (signalPower < 1) signalPower = 1;

    // Calculate SNR in dB: SNR = 10 * log10(signal_power / noise_power)
    const snrDb = 10 * Math.log10(signalPower / noisePower);

    return snrDb;
  };

  /**
   * Feed a chunk of captured audio to the live decoder.
   * `session` is the token captured when the audio callback was installed;
   * if the session has ended (stop/unmount/restart) the chunk is dropped.
   */
  const processAudioChunk = (samples: Float32Array, session: number) => {
    if (session !== sessionRef.current || !isRecordingRef.current || !mountedRef.current) {
      return;
    }

    const decoder = decoderRef.current;
    if (!decoder) return;

    decoder.processSamples(samples);

    const stats = decoder.getStats();
    const snr = calculateSNR();
    setState(prev => ({ ...prev, stats: { ...stats, snr } }));
  };

  const startRecording = async () => {
    if (isRecordingRef.current || startInFlightRef.current) return;
    startInFlightRef.current = true;

    // New session; anything still in flight from a previous one is stale.
    const session = ++sessionRef.current;

    try {
      // Check support at call time, not from state
      const hasAudioContext = typeof window !== 'undefined' && 'AudioContext' in window;
      const hasMediaDevices = typeof navigator !== 'undefined' &&
                              navigator.mediaDevices &&
                              typeof navigator.mediaDevices.getUserMedia === 'function';

      if (!hasAudioContext || !hasMediaDevices) {
        throw new Error('Web Audio API not supported in this browser');
      }

      // Request microphone access
      // Don't specify sampleRate - let the browser use the hardware's native rate
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      if (session !== sessionRef.current || !mountedRef.current) {
        // Stopped or unmounted while waiting for the microphone.
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      streamRef.current = stream;

      // Create audio context with default sample rate to match MediaStream
      // Firefox requires AudioContext and MediaStream to have the same sample rate
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      console.log(`AudioContext created with sample rate: ${audioContext.sampleRate} Hz`);

      // Create audio source from microphone
      const source = audioContext.createMediaStreamSource(stream);

      // Create analyser for visualization
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;

      // Connect source to analyser
      source.connect(analyser);

      // Build the decoder with the latest selected mode before any audio is
      // processed, so the very first chunk is decoded with the right mode.
      const decoder = new SSTVDecoder(audioContext.sampleRate, modeRef.current);
      decoder.start();
      decoderRef.current = decoder;
      isRecordingRef.current = true;

      const initialStats = decoder.getStats();
      const initialSnr = calculateSNR();
      setState(prev => ({
        ...prev,
        isRecording: true,
        error: null,
        stats: { ...initialStats, snr: initialSnr },
      }));

      // Try to use ScriptProcessorNode (deprecated but still works in some browsers)
      // If it fails or is not available, we'll fall back to polling via requestAnimationFrame
      let useScriptProcessor = false;
      try {
        if (typeof audioContext.createScriptProcessor === 'function') {
          const bufferSize = 4096;
          const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
          processorNodeRef.current = processor;

          processor.onaudioprocess = (event) => {
            const inputData = event.inputBuffer.getChannelData(0);
            processAudioChunk(inputData, session);
          };

          analyser.connect(processor);
          processor.connect(audioContext.destination);
          useScriptProcessor = true;
          console.log('Using ScriptProcessorNode for audio processing');
        }
      } catch (e) {
        console.warn('ScriptProcessorNode not available, using polling fallback');
      }

      // Fallback: Use requestAnimationFrame polling for Safari/iOS
      if (!useScriptProcessor) {
        // Create a silent destination to keep the graph active
        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0.001; // Very quiet so we can monitor but not hear it
        analyser.connect(silentGain);
        silentGain.connect(audioContext.destination);

        // Poll analyser for time domain data
        const pollAudio = () => {
          if (session !== sessionRef.current || !isRecordingRef.current || !analyserRef.current) {
            return;
          }

          const bufferLength = analyserRef.current.fftSize;
          const dataArray = new Float32Array(bufferLength);
          analyserRef.current.getFloatTimeDomainData(dataArray);

          processAudioChunk(dataArray, session);

          // Continue polling
          animationFrameRef.current = requestAnimationFrame(pollAudio);
        };

        console.log('Using requestAnimationFrame polling for audio processing (Safari-compatible)');
        animationFrameRef.current = requestAnimationFrame(pollAudio);
      }

    } catch (err) {
      if (session !== sessionRef.current || !mountedRef.current) {
        return;
      }

      const error = err instanceof Error ? err.message : 'Failed to access microphone';
      setState(prev => ({
        ...prev,
        error,
        isRecording: false,
      }));
    } finally {
      // Only the session that owns the in-flight flag may clear it; a newer
      // start (after a stop) must keep its own flag set.
      if (session === sessionRef.current) {
        startInFlightRef.current = false;
      }
    }
  };

  /**
   * Release every audio resource without touching React state. Safe to call
   * from an unmount cleanup. Bumping the session token first guarantees that
   * no late audio callback can write state afterwards.
   */
  const teardown = () => {
    sessionRef.current += 1;
    isRecordingRef.current = false;
    startInFlightRef.current = false;

    // Stop all tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // Disconnect audio nodes
    if (processorNodeRef.current) {
      processorNodeRef.current.onaudioprocess = null;
      processorNodeRef.current.disconnect();
      processorNodeRef.current = null;
    }

    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }

    // Close audio context
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Cancel animation frame
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    // Stop decoder but keep the stats so the image persists
    if (decoderRef.current) {
      decoderRef.current.stop();
    }
  };

  const stopRecording = () => {
    teardown();

    if (!mountedRef.current) return;

    setState(prev => ({
      ...prev,
      isRecording: false,
      // Keep stats so the decoded image remains visible
    }));
  };

  const resetDecoder = () => {
    const decoder = decoderRef.current;
    if (!decoder) return;

    const recording = isRecordingRef.current;
    decoder.reset();

    if (!mountedRef.current) return;

    if (recording) {
      // Keep showing the live (now cleared) session.
      const stats = decoder.getStats();
      const snr = calculateSNR();
      setState(prev => ({ ...prev, stats: { ...stats, snr } }));
    } else {
      // Clear stats when explicitly resetting while idle.
      setState(prev => ({ ...prev, stats: null }));
    }
  };

  // Apply a mode change to the running decoder. The decoder rebuilds its
  // image buffer, line decoder, sync detector and frequency calibration in
  // place, so microphone capture continues uninterrupted and there is only
  // ever a single decoder writing to the canvas. When not recording this
  // only records the pending mode; the decoder is created on the next start.
  useEffect(() => {
    modeRef.current = mode;

    const decoder = decoderRef.current;
    if (!decoder || !isRecordingRef.current) {
      return;
    }

    decoder.setMode(mode);

    if (!mountedRef.current) return;

    // Restart progress/stats from the new mode (line 0, new total lines).
    const stats = decoder.getStats();
    const snr = calculateSNR();
    setState(prev => ({ ...prev, stats: { ...stats, snr } }));
  }, [mode]);

  const getImageData = (): Uint8ClampedArray | null => {
    return decoderRef.current ? decoderRef.current.getImageData() : null;
  };

  const getDimensions = () => {
    if (decoderRef.current) {
      return decoderRef.current.getDimensions();
    }
    // Return dimensions based on the pending mode
    const modeConfig = SSTV_MODES[mode];
    return { width: modeConfig.width, height: modeConfig.height };
  };

  const getAnalyser = (): AnalyserNode | null => {
    return analyserRef.current;
  };

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardown();
    };
  }, []);

  return {
    state,
    startRecording,
    stopRecording,
    resetDecoder,
    getImageData,
    getDimensions,
    getAnalyser,
  };
}
