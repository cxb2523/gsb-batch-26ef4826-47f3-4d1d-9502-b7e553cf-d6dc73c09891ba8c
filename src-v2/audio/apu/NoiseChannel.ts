/**
 * Game Boy Noise Channel
 *
 * Implements the noise channel with:
 * - LFSR-based pseudo-random noise generation
 * - 7-bit mode (tonal, metallic) and 15-bit mode (fuller noise)
 * - GB-accurate frequency calculation
 * - Envelope control
 *
 * Session/lifecycle guarantees:
 * - Every scheduled note is tracked as a "voice" (source + gain + stop time).
 * - Voices disconnect their own nodes when they end naturally.
 * - stopAll()/reset() tears down every voice from the current playback
 *   session so nothing keeps ringing into the next session, and clears the
 *   buffer cache so old-session buffers can never leak across sessions.
 * - Cached noise buffers are only reused when the ACTUAL buffer is long
 *   enough to cover the requested note plus its envelope tail, so a cache
 *   hit can never truncate a longer note.
 */

import { generateNoiseBuffer, type LFSRMode } from '../synthesis/LFSR';
import { calculateNoiseFrequency, midiToNoiseParams } from '../synthesis/FrequencyCalc';

export interface NoiseNoteResult {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  stopTime: number;
}

/** One playing (or scheduled) noise note. */
interface NoiseVoice {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  stopTime: number;
  /** True once this voice has been stopped/disposed (natural or forced). */
  disposed: boolean;
}

// Cache for noise buffers to avoid regenerating
interface NoiseBufferCache {
  buffer: AudioBuffer;
  frequency: number;
  mode: LFSRMode;
  /** Actual duration of the generated AudioBuffer, in seconds. */
  bufferDuration: number;
}

/** Extra padding added to every generated noise buffer for envelope tails. */
const BUFFER_TAIL_PADDING = 0.1;

export class NoiseChannel {
  private audioContext: AudioContext;
  private mode: LFSRMode;
  private outputNode: GainNode;

  // Cache recently used noise buffers
  private bufferCache: NoiseBufferCache[] = [];
  private maxCacheSize = 8;

  // Voices belonging to the current playback session.
  private activeVoices: Set<NoiseVoice> = new Set();

  constructor(
    audioContext: AudioContext,
    outputNode: GainNode,
    mode: LFSRMode = '15bit'
  ) {
    this.audioContext = audioContext;
    this.outputNode = outputNode;
    this.mode = mode;
  }

  /**
   * Set the LFSR mode.
   * '7bit' = more tonal, metallic sound (good for snares)
   * '15bit' = fuller noise (good for hihats, white noise effects)
   */
  setMode(mode: LFSRMode): void {
    this.mode = mode;
  }

  /**
   * Get current mode.
   */
  getMode(): LFSRMode {
    return this.mode;
  }

  /**
   * Get or create a noise buffer with the given parameters.
   *
   * A cached buffer is only returned when its ACTUAL length covers the
   * requested duration plus the envelope-tail padding. Reusing a shorter
   * buffer would cut off the release tail of a longer note.
   */
  private getNoiseBuffer(
    frequency: number,
    duration: number,
    mode: LFSRMode
  ): AudioBuffer {
    // We need enough samples for the note itself plus the release tail.
    const requiredDuration = duration + BUFFER_TAIL_PADDING;

    // Check cache first: match frequency + mode and require a long-enough
    // buffer (comparing the real AudioBuffer length, not the request length).
    const cached = this.bufferCache.find(
      c => c.frequency === frequency &&
           c.mode === mode &&
           c.bufferDuration >= requiredDuration
    );

    if (cached) {
      return cached.buffer;
    }

    // Generate a new buffer long enough for note + envelope tail.
    const requestedDuration = duration + BUFFER_TAIL_PADDING;
    const buffer = generateNoiseBuffer(
      this.audioContext,
      requestedDuration,
      frequency,
      mode
    );

    // Store the real buffer duration so future lookups compare against what
    // the AudioBuffer actually contains.
    this.bufferCache.push({
      buffer,
      frequency,
      mode,
      bufferDuration: buffer.duration,
    });

    // Trim cache if too large
    while (this.bufferCache.length > this.maxCacheSize) {
      this.bufferCache.shift();
    }

    return buffer;
  }

  /**
   * Register a freshly created source/gain pair as a session voice and wire
   * up deterministic cleanup. Returns the voice handle.
   */
  private registerVoice(
    source: AudioBufferSourceNode,
    gainNode: GainNode,
    stopTime: number
  ): NoiseVoice {
    const voice: NoiseVoice = { source, gainNode, stopTime, disposed: false };
    this.activeVoices.add(voice);

    source.onended = () => {
      this.disposeVoice(voice);
    };

    return voice;
  }

  /**
   * Disconnect a voice's nodes exactly once and drop it from tracking.
   */
  private disposeVoice(voice: NoiseVoice): void {
    if (voice.disposed) return;
    voice.disposed = true;
    this.activeVoices.delete(voice);
    try {
      voice.source.onended = null;
      voice.source.disconnect();
    } catch {
      // Already disconnected
    }
    try {
      voice.gainNode.disconnect();
    } catch {
      // Already disconnected
    }
  }

  /**
   * Play noise with raw frequency control.
   *
   * @param duration - Duration in seconds
   * @param frequency - LFSR clock frequency in Hz
   * @param velocity - Velocity (0-127)
   * @param startTime - When to start
   */
  playNoise(
    duration: number,
    frequency: number,
    velocity: number = 100,
    startTime?: number
  ): NoiseNoteResult {
    const now = startTime ?? this.audioContext.currentTime;

    // Get or generate noise buffer (guaranteed long enough for this note).
    const buffer = this.getNoiseBuffer(frequency, duration, this.mode);

    // Create source
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.loop = false;

    // Create gain for envelope
    const gain = this.audioContext.createGain();

    // Calculate gain from velocity - keep very quiet
    const maxGain = (velocity / 127) * 0.3;

    // Noise envelope: instant attack, decay to sustain, release
    const attackTime = 0.001;  // Nearly instant
    const decayTime = 0.05;    // Quick decay
    const sustainLevel = maxGain * 0.6;
    const releaseTime = 0.03;

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(maxGain, now + attackTime);
    gain.gain.linearRampToValueAtTime(sustainLevel, now + attackTime + decayTime);

    const releaseStart = now + Math.max(attackTime + decayTime, duration - releaseTime);
    gain.gain.setValueAtTime(sustainLevel, releaseStart);

    const stopTime = now + duration + releaseTime;
    gain.gain.linearRampToValueAtTime(0.001, stopTime);

    // Connect
    source.connect(gain);
    gain.connect(this.outputNode);

    // Play (the buffer always extends past stopTime thanks to tail padding).
    source.start(now);
    source.stop(stopTime + 0.01);

    this.registerVoice(source, gain, stopTime);

    return { source, gainNode: gain, stopTime };
  }

  /**
   * Play noise mapped from a MIDI note.
   * Lower notes = lower frequency noise (boomy)
   * Higher notes = higher frequency noise (hissy)
   *
   * @param midiNote - MIDI note (affects noise frequency)
   * @param duration - Duration in seconds
   * @param velocity - Velocity (0-127)
   * @param startTime - When to start
   */
  playNote(
    midiNote: number,
    duration: number,
    velocity: number = 100,
    startTime?: number
  ): NoiseNoteResult {
    const { divisorCode, clockShift } = midiToNoiseParams(midiNote);
    const frequency = calculateNoiseFrequency(divisorCode, clockShift);

    return this.playNoise(duration, frequency, velocity, startTime);
  }

  /**
   * Play a kick drum sound.
   * Short, low-frequency noise burst.
   */
  playKick(velocity: number = 100, startTime?: number): NoiseNoteResult {
    const now = startTime ?? this.audioContext.currentTime;
    const duration = 0.15;

    // Low frequency, short duration, 7-bit for more punch.
    // Include tail padding so the decay envelope is never cut off.
    const buffer = this.getNoiseBuffer(500, duration, '7bit');

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;

    const gain = this.audioContext.createGain();
    const maxGain = (velocity / 127) * 0.4;

    // Kick envelope: instant attack, fast decay
    gain.gain.setValueAtTime(maxGain, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

    source.connect(gain);
    gain.connect(this.outputNode);

    source.start(now);
    source.stop(now + duration);

    this.registerVoice(source, gain, now + duration);

    return { source, gainNode: gain, stopTime: now + duration };
  }

  /**
   * Play a snare drum sound.
   * Mid-frequency noise with some sustain.
   */
  playSnare(velocity: number = 100, startTime?: number): NoiseNoteResult {
    const now = startTime ?? this.audioContext.currentTime;
    const duration = 0.2;

    // Mid frequency, 7-bit for metallic character.
    // Include tail padding so the decay envelope is never cut off.
    const buffer = this.getNoiseBuffer(2000, duration, '7bit');

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;

    const gain = this.audioContext.createGain();
    const maxGain = (velocity / 127) * 0.3;

    // Snare envelope: fast attack, medium decay
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(maxGain, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);

    source.connect(gain);
    gain.connect(this.outputNode);

    source.start(now);
    source.stop(now + duration);

    this.registerVoice(source, gain, now + duration);

    return { source, gainNode: gain, stopTime: now + duration };
  }

  /**
   * Play a hihat sound.
   * High-frequency noise, very short.
   */
  playHihat(
    velocity: number = 100,
    open: boolean = false,
    startTime?: number
  ): NoiseNoteResult {
    const now = startTime ?? this.audioContext.currentTime;

    // High frequency, 15-bit for fuller sound
    const duration = open ? 0.3 : 0.08;
    // Include tail padding so the decay envelope is never cut off.
    const buffer = this.getNoiseBuffer(8000, duration, '15bit');

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;

    const gain = this.audioContext.createGain();
    const maxGain = (velocity / 127) * 0.2; // Hihats very quiet

    // Hihat envelope: instant attack, quick decay
    gain.gain.setValueAtTime(maxGain, now);

    if (open) {
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
    } else {
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
    }

    source.connect(gain);
    gain.connect(this.outputNode);

    source.start(now);
    source.stop(now + duration);

    this.registerVoice(source, gain, now + duration);

    return { source, gainNode: gain, stopTime: now + duration };
  }

  /**
   * Immediately stop and tear down every voice in the current session.
   *
   * Stopping the source triggers onended -> disposeVoice, but we also
   * dispose synchronously as a fallback so the gain nodes are disconnected
   * from the output immediately and no stopped-session node can keep
   * sounding into the next session.
   */
  stopAll(): void {
    const now = this.audioContext.currentTime;
    for (const voice of Array.from(this.activeVoices)) {
      try {
        voice.source.stop(now);
      } catch {
        // Node may have already stopped; still make sure it is torn down.
      }
      this.disposeVoice(voice);
    }
    this.activeVoices.clear();
  }

  /**
   * Reset the channel for a fresh playback session: stop all active voices
   * and drop the buffer cache so cached buffers from a previous session can
   * never influence a new one. Configuration (mode) is preserved.
   */
  reset(): void {
    this.stopAll();
    this.clearCache();
  }

  /**
   * Clear the buffer cache.
   */
  clearCache(): void {
    this.bufferCache = [];
  }

  /**
   * Number of voices currently tracked (for diagnostics/tests).
   */
  getActiveVoiceCount(): number {
    return this.activeVoices.size;
  }

  /**
   * Number of buffers currently cached (for diagnostics/tests).
   */
  getCacheSize(): number {
    return this.bufferCache.length;
  }
}
