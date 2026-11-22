import { vi } from "vitest";

/**
 * A controllable stand-in for the Web Speech API. `speak` dispatches `onstart`
 * synchronously (like Chrome does for short utterances) and `finishCurrent`
 * completes the active utterance the way the browser does when it reaches the
 * end of the text. Nothing is timed: the tests decide when speech progresses.
 *
 * `cancel()` mirrors the real API by firing the utterance's `end` event
 * asynchronously (on the next macrotask), not from inside the `cancel()` call.
 * That ordering is what makes stale callbacks observable.
 */
export class FakeUtterance {
  text = "";
  lang = "";
  voice: SpeechSynthesisVoice | null = null;
  volume = 1;
  rate = 1;
  pitch = 1;
  onstart: ((event: SpeechSynthesisEvent) => void) | null = null;
  onend: ((event: SpeechSynthesisEvent) => void) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;
  onboundary: ((event: SpeechSynthesisEvent) => void) | null = null;
  onmark: ((event: SpeechSynthesisEvent) => void) | null = null;
  onpause: ((event: SpeechSynthesisEvent) => void) | null = null;
  onresume: ((event: SpeechSynthesisEvent) => void) | null = null;
}

type Voice = { voiceURI: string; lang: string };

/**
 * A record of one `speechSynthesis.speak` call. The hook reuses a single
 * utterance and mutates `text` per chunk, so the values are snapshotted at call
 * time — exactly what the real browser would have spoken.
 */
export type SpeakCall = {
  text: string;
  pitch: number;
  rate: number;
  volume: number;
  lang: string;
  voice: SpeechSynthesisVoice | null;
  /** The live utterance instance that was passed to `speak`. */
  utterance: FakeUtterance;
};

export type FakeSpeech = {
  /** Every utterance passed to `speechSynthesis.speak`, in order. */
  speakCalls: SpeakCall[];
  cancelCount: number;
  /** The utterance currently being spoken, if any. */
  current(): FakeUtterance | null;
  /** The text of the utterance currently being spoken, if any. */
  currentText(): string | null;
  /** Whether `speechSynthesis.speaking` should report true. */
  isSpeaking(): boolean;
  /** Whether `speechSynthesis.paused` should report true. */
  isPaused(): boolean;
  /** Completes the active utterance naturally (fires `onend`). */
  finishCurrent(): void;
  /** Emits a boundary event on the active utterance. */
  boundary(charIndex: number, charLength: number, name?: string): void;
  /** Voices returned by `getVoices`. */
  voices: Voice[];
  addEventListenerCount: number;
  removeEventListenerCount: number;
};

function event(utterance: FakeUtterance, name: string): SpeechSynthesisEvent {
  return { type: name, utterance, charIndex: 0, charLength: 0, elapsedTime: 0, name } as unknown as SpeechSynthesisEvent;
}

export function installFakeSpeech(): FakeSpeech {
  let current: FakeUtterance | null = null;
  let currentText: string | null = null;
  let paused = false;
  let cancelCount = 0;
  let addEventListenerCount = 0;
  let removeEventListenerCount = 0;
  const speakCalls: SpeakCall[] = [];
  const utteranceInstances: FakeUtterance[] = [];

  class FakeSpeechSynthesisUtterance extends FakeUtterance {
    constructor() {
      super();
      utteranceInstances.push(this);
    }
  }

  const synth = {
    get speaking() {
      return current !== null;
    },
    get pending() {
      return false;
    },
    get paused() {
      return paused;
    },
    speak(utterance: FakeUtterance) {
      speakCalls.push({ text: utterance.text, pitch: utterance.pitch, rate: utterance.rate, volume: utterance.volume, lang: utterance.lang, voice: utterance.voice, utterance });
      current = utterance;
      currentText = utterance.text;
      paused = false;
      utterance.onstart?.(event(utterance, "start"));
    },
    cancel() {
      cancelCount++;
      const cancelled = current;
      current = null;
      currentText = null;
      paused = false;
      if (!cancelled) return;
      // Match real browsers: the `end` event arrives asynchronously.
      setTimeout(() => cancelled.onend?.(event(cancelled, "end")), 0);
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    getVoices() {
      return fake.voices;
    },
    addEventListener() {
      addEventListenerCount++;
    },
    removeEventListener() {
      removeEventListenerCount++;
    },
  };

  const fake: FakeSpeech = {
    speakCalls,
    get cancelCount() {
      return cancelCount;
    },
    get addEventListenerCount() {
      return addEventListenerCount;
    },
    get removeEventListenerCount() {
      return removeEventListenerCount;
    },
    voices: [],
    current: () => current,
    currentText: () => currentText,
    isSpeaking: () => current !== null,
    isPaused: () => paused,
    finishCurrent() {
      const finished = current;
      if (!finished) return;
      current = null;
      currentText = null;
      finished.onend?.(event(finished, "end"));
    },
    boundary(charIndex, charLength, name = "word") {
      current?.onboundary?.({ type: "boundary", utterance: current, charIndex, charLength, elapsedTime: 0, name } as unknown as SpeechSynthesisEvent);
    },
  };

  vi.stubGlobal("SpeechSynthesisUtterance", FakeSpeechSynthesisUtterance);
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
  Object.defineProperty(globalThis, "speechSynthesis", { configurable: true, value: synth });

  return fake;
}
