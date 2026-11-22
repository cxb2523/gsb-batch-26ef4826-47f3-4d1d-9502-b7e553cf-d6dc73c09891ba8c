import { defaults, directiveRegex, idPrefix, spaceDelimiter, specialSymbol } from "@/constants";
import { composeProps, createElementWithProps } from "@/lib/dom";
import {
  addToQueue,
  clearQueue,
  clearQueueHook,
  clearQueueUnload,
  dequeue,
  emit,
  isQueueHead,
  markUtteranceEnded,
  removeSessionFromQueue,
  speakFromQueue,
  subscribe,
} from "@/lib/queue";
import { findCharIndex, getIndex, indexText, isParent, isSetStateFunction, nodeToKey, nodeToWords, parent, stripDirectives, toText } from "@/lib/react";
import { setState, state } from "@/lib/state";
import { cancel, getProgress, isMobile, parse, sanitize, shouldHighlightNextPart, splitNode, textToChunks } from "@/lib/utils";
import type {
  DirectiveEvent,
  DivProps,
  NodeProps,
  SpeakingWord,
  SpeakProps,
  SpeechStatus,
  SpeechSynthesisEventName,
  SpeechSynthesisUtteranceProps,
  SpeechUtterancesQueue,
  State,
  UpdateMode,
  UseSpeakOptions,
  UseSpeechOptions,
  UseSpeechOptionsInternal,
  VoidFunction,
} from "@/types";
import { cloneElement, forwardRef, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** DOM nodes temporarily rewritten to render a highlight. */
type HighlightSnapshot = { element: HTMLElement; originalTextContent: string; container: HTMLElement };

/** A single run of speech, from `start()` until it ends or is replaced. */
type SpeechSession = {
  id: string;
  utterance: SpeechSynthesisUtterance;
  timers: Set<ReturnType<typeof setTimeout>>;
  active: boolean;
  /** Whether this session registered the global `beforeunload` handler. */
  listensForUnload: boolean;
};

/** Monotonic counter used to build globally unique session ids. */
let sessionSequence = 0;

function useStableValue<T>(value: T, mode: UpdateMode, delay: number) {
  const [stableValue, setStableValue] = useState(value);
  const lastUpdated = useRef(0);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    if (mode === "immediate" || delay <= 0) timeout = setTimeout(() => setStableValue(value), 0);
    else if (mode === "debounce") timeout = setTimeout(() => setStableValue(value), delay);
    else if (mode === "throttle") {
      const now = Date.now();
      const elapsed = now - lastUpdated.current;
      timeout = setTimeout(
        () => {
          setStableValue(value);
          lastUpdated.current = Date.now();
        },
        Math.max(0, delay - elapsed),
      );
    }

    return () => {
      if (timeout) clearTimeout(timeout);
    };
  }, [value, mode, delay]);

  return stableValue;
}

export function useQueue() {
  const [queue, setQueue] = useState<SpeechUtterancesQueue>([]);

  useEffect(() => subscribe(setQueue), []);

  return { queue, dequeue, clearQueue: clearQueueHook };
}

export function useSpeak(options?: UseSpeakOptions) {
  const [speechProps, setSpeechProps] = useState<SpeakProps>({ text: "" });
  const { start, ...speechInterface } = useSpeech({ ...speechProps, ...options, stableText: true, autoPlay: false });

  const speak = useCallback((text: ReactNode, options: SpeechSynthesisUtteranceProps = {}) => setSpeechProps({ text, ...options }), []);

  useEffect(() => {
    if (speechProps.text) start();
  }, [speechProps]);

  return { speak, start, ...speechInterface };
}

export function useSpeech(speechProps: UseSpeechOptions) {
  const { uniqueId, normalizedText, reactContent, ...speechInterface } = useSpeechInternal(speechProps);

  return speechInterface;
}

/** @internal */
export function useSpeechInternal({
  id,
  text,
  stableText = false,
  pitch = defaults.pitch,
  rate = defaults.rate,
  volume = defaults.volume,
  lang = defaults.lang,
  voiceURI = defaults.voice,
  autoPlay = false,
  preserveUtteranceQueue = false,
  highlightText = false,
  showOnlyHighlightedText = false,
  highlightMode = "word",
  highlightProps,
  highlightContainerProps,
  enableDirectives = false,
  updateMode = "immediate",
  updateDelay = 0,
  maxChunkSize,
  onError = console.error,
  onStart,
  onResume,
  onPause,
  onStop,
  onBoundary,
  onQueueChange,
}: UseSpeechOptionsInternal) {
  const [speechStatus, speechStatusRef, setSpeechStatus] = useStateRef<SpeechStatus>("stopped");
  const [speakingWord, speakingWordRef, setSpeakingWord] = useStateRef<SpeakingWord>(null);
  const { createUtterance, updateProps } = useSpeechSynthesisUtterance();
  const highlightRef = useRef(false);
  const directiveRef = useRef<{ event: DirectiveEvent; delay: number; abortDelay?: VoidFunction }>({ event: null, delay: 0 });
  /** The session that currently owns the utterance, queue entry and timers. */
  const sessionRef = useRef<SpeechSession | null>(null);
  /** Pending 500ms parameter-change switch, so it can be cancelled on replacement. */
  const pendingParamSwitchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A `start()` request that arrived before the new text finished debouncing. */
  const pendingStartRef = useRef(false);
  /** DOM nodes modified by the highlight effect, restored when speech ends. */
  const highlightSnapshotsRef = useRef<HighlightSnapshot[]>([]);

  /** Always expose the latest callbacks and params to deferred work (timers, utterance events). */
  const callbacksRef = useRef({ onError, onStart, onResume, onPause, onStop, onBoundary, onQueueChange });
  const paramsRef = useRef({ pitch, rate, volume, lang, voiceURI });
  useLayoutEffect(() => {
    callbacksRef.current = { onError, onStart, onResume, onPause, onStop, onBoundary, onQueueChange };
    paramsRef.current = { pitch, rate, volume, lang, voiceURI };
  });

  const uniqueId = useMemo(() => `${idPrefix}${id ?? crypto.randomUUID()}`, [id]);
  const key = useMemo(() => (stableText ? text : nodeToKey(text)), [text, stableText]);
  const stableKey = useStableValue(key, updateMode, updateDelay);
  const stringifiedVoices = useMemo(() => voiceURI.toString(), [voiceURI]);
  const normalizedText = useMemo(() => (isValidElement(text) ? [text] : text), [stableKey]);
  const { indexedText, sanitizedText, speechText, words } = useMemo(() => {
    const strippedText = enableDirectives ? stripDirectives(normalizedText) : normalizedText;
    const words = nodeToWords(strippedText);
    const sanitizedText = `${spaceDelimiter}${sanitize(toText(enableDirectives ? normalizedText : words))}`;
    const speechText = (stripDirectives(sanitizedText) as string).trimStart();
    return { indexedText: indexText(strippedText, uniqueId), sanitizedText, speechText, words };
  }, [enableDirectives, normalizedText]);
  const chunks = useMemo(() => textToChunks(sanitizedText, maxChunkSize, enableDirectives), [enableDirectives, maxChunkSize, sanitizedText]);

  const reactContent = useMemo(() => (showOnlyHighlightedText ? highlightedText(indexedText) : indexedText), [speakingWord, showOnlyHighlightedText, highlightMode, indexedText]);
  const Text = useCallback(
    forwardRef<HTMLDivElement, DivProps>((props, ref) => (
      <div ref={ref} {...composeProps(uniqueId, props)}>
        {reactContent}
      </div>
    )),
    [reactContent],
  );

  function reset(event: DirectiveEvent = null) {
    directiveRef.current.abortDelay?.();
    directiveRef.current = { event, delay: 0 };
  }

  function resumeEventHandler() {
    setSpeechStatus("started");
    callbacksRef.current.onResume?.();
  }

  function pauseEventHandler() {
    setSpeechStatus("paused");
    callbacksRef.current.onPause?.();
  }

  function clearPendingParamSwitch() {
    if (pendingParamSwitchRef.current === null) return;
    clearTimeout(pendingParamSwitchRef.current);
    pendingParamSwitchRef.current = null;
  }

  function clearSessionTimers(session: SpeechSession) {
    session.timers.forEach((timeout) => clearTimeout(timeout));
    session.timers.clear();
  }

  function scheduleSessionTimer(session: SpeechSession, handler: VoidFunction, delay: number) {
    const timeout = setTimeout(() => {
      session.timers.delete(timeout);
      if (session.active && sessionRef.current === session) handler();
    }, delay);
    session.timers.add(timeout);
    return timeout;
  }

  function detachUtteranceEvents(utterance: SpeechSynthesisUtterance) {
    utterance.onstart = null;
    utterance.onend = null;
    utterance.onerror = null;
    utterance.onboundary = null;
  }

  /** Restores DOM nodes rewritten by highlighting, without clobbering content React already replaced. */
  function restoreHighlightedDom() {
    const snapshots = highlightSnapshotsRef.current;
    highlightSnapshotsRef.current = [];
    snapshots.forEach(({ element, originalTextContent, container }) => {
      if (element.isConnected && element.contains(container)) element.textContent = originalTextContent;
    });
  }

  /**
   * Tears down a session: queued entry, pending timers, listeners and utterance
   * callbacks. This is what guarantees that a replaced session cannot speak,
   * highlight, or call back into a newer session.
   */
  function teardownSession(
    session: SpeechSession,
    {
      cancelSpeech = true,
      stopReason = "manual",
      speakNext = false,
      notifyStop = false,
    }: { cancelSpeech?: boolean; stopReason?: State["stopReason"]; speakNext?: boolean; notifyStop?: boolean } = {},
  ) {
    if (!session.active) {
      if (sessionRef.current === session) sessionRef.current = null;
      return;
    }
    session.active = false;
    if (sessionRef.current === session) sessionRef.current = null;

    // Only the queue head is actually driving `speechSynthesis`; a queued entry
    // must never cancel (or advance) another instance's speech.
    const wasHead = isQueueHead(session.utterance);
    clearSessionTimers(session);
    clearPendingParamSwitch();
    detachUtteranceEvents(session.utterance);
    if (cancelSpeech && wasHead) cancel(stopReason);

    // `beforeunload` is a shared global listener: only remove it when this very
    // session installed it, so stopping a queued instance cannot deafen the one
    // that is still speaking.
    if (session.listensForUnload) {
      session.listensForUnload = false;
      window.removeEventListener("beforeunload", clearQueueUnload);
    }
    removeSessionFromQueue(session.id, callbacksRef.current.onQueueChange);
    restoreHighlightedDom();
    highlightRef.current = false;
    setSpeakingWord(null);
    setSpeechStatus("stopped");

    if (speakNext) speakFromQueue();
    if (notifyStop) callbacksRef.current.onStop?.();
  }

  function start() {
    const synth = window.speechSynthesis;
    if (!synth) return onError(new Error("Browser not supported! Try some other browser."));
    if (speechStatusRef.current === "paused") {
      if (directiveRef.current.event === "pause") speakFromQueue();
      synth.resume();
      return resumeEventHandler();
    }
    if (speechStatusRef.current === "queued") return;

    // The text key changes immediately, but `stableKey` (and therefore the
    // chunks) only follows once the debounce/throttle window elapses. Starting
    // now would speak the previous content, so wait for the new chunks and
    // start from the effect that observes the stabilized signature.
    if (stableKey !== key) {
      pendingStartRef.current = true;
      return;
    }
    pendingStartRef.current = false;
    // Captured before teardown: a manual restart of an already-speaking
    // instance must speak immediately rather than wait behind itself.
    const wasStarted = speechStatusRef.current === "started";

    // A manual start replaces whatever this hook was previously doing. The
    // previous session belongs to this hook instance, so cancelling it can
    // never interrupt another instance's speech.
    const previousSession = sessionRef.current;
    if (previousSession) teardownSession(previousSession, { cancelSpeech: true });

    const createdUtterance = createUtterance();
    if (!createdUtterance) return onError(new Error("Browser not supported! Try some other browser."));
    const utterance = createdUtterance;

    const session: SpeechSession = { id: `${uniqueId}:${++sessionSequence}`, utterance, timers: new Set(), active: true, listensForUnload: false };
    sessionRef.current = session;

    let currentChunk = 0;
    let currentText = chunks[currentChunk] || "";
    let processedTextLength = -spaceDelimiter.length;
    utterance.text = currentText.trimStart();
    let offset = processedTextLength + currentText.length - utterance.text.length;
    let specialSymbolOffset = 0;
    updateProps(utterance, paramsRef.current);

    function handleDirectives() {
      let skip = false;
      while (currentChunk < chunks.length) {
        const match = directiveRegex.exec(currentText);
        if (!match) {
          if (!skip) return true;
          processedTextLength += currentText.length;
        } else {
          const key = match[1];
          const value = parse(match[2] ?? "");
          switch (key) {
            case "delay":
              directiveRef.current.delay += value as number;
              break;
            case "pitch":
            case "rate":
            case "volume":
            case "lang":
            case "voice":
              updateProps(utterance, { [key]: value === "default" ? defaults[key] : value });
              break;
            case "skip":
              if (typeof value === "boolean") skip = value;
              break;
          }
        }
        currentText = chunks[++currentChunk] ?? "";
      }

      return false;
    }

    function startEventHandler() {
      if (!session.active) return;
      if (!session.listensForUnload) {
        session.listensForUnload = true;
        window.addEventListener("beforeunload", clearQueueUnload);
      }
      setState({ stopReason: "auto" });
      highlightRef.current = true;
      // A preserved queue may have started this entry long after `start()` set
      // it to "queued"; now that it is actually being spoken it is "started".
      if (speechStatusRef.current === "queued") setSpeechStatus("started");
      if (directiveRef.current.event || directiveRef.current.delay) reset();
      else callbacksRef.current.onStart?.();
      callbacksRef.current.onBoundary?.({ progress: getProgress(offset, speechText.length) });
    }

    async function stopEventHandler() {
      // The utterance has finished (naturally, via cancel, or via an error), so
      // it may be spoken again for the next chunk.
      markUtteranceEnded(utterance);
      if (!session.active) return;

      if (state.stopReason === "auto" && currentChunk < chunks.length - 1) {
        processedTextLength += currentText.length;
        currentText = chunks[++currentChunk] ?? "";
        const continueSpeech = !enableDirectives || handleDirectives();
        if (continueSpeech) {
          utterance.text = currentText.trimStart();
          offset = processedTextLength + currentText.length - utterance.text.length;
          if (speechStatusRef.current === "paused") return reset("pause");
          const { delay } = directiveRef.current;
          directiveRef.current.event = "change";
          if (!delay) return speakFromQueue();
          const timeout = scheduleSessionTimer(session, speakFromQueue, delay);
          directiveRef.current.abortDelay = () => {
            clearTimeout(timeout);
            session.timers.delete(timeout);
          };
          return;
        }
      }
      if (state.stopReason === "change") {
        if (speakingWordRef.current) {
          const currentLength = utterance.text.length;
          utterance.text = utterance.text.slice(speakingWordRef.current.charIndex).trimStart();
          offset += currentLength - utterance.text.length;
          setSpeakingWord(null);
        }
        return speakFromQueue();
      }
      if (state.stopReason === "auto") callbacksRef.current.onBoundary?.({ progress: 100 });
      teardownSession(session, { cancelSpeech: synth.paused, speakNext: true, notifyStop: true });
    }

    function boundaryEventHandler(event: SpeechSynthesisEvent) {
      if (!session.active) return;
      const { charIndex, charLength, name } = event as SpeechSynthesisEvent & { name: SpeechSynthesisEventName };
      if (name === "word") {
        const isSpecialSymbol = +(utterance.text[charIndex + charLength] === specialSymbol);
        const index = findCharIndex(words, offset + specialSymbolOffset + charIndex - isSpecialSymbol);
        if (shouldHighlightNextPart(highlightMode, utterance, charIndex) || parent(index) !== parent(speakingWordRef.current?.index))
          setSpeakingWord({ index, charIndex: isSpecialSymbol ? charIndex + charLength + 1 : charIndex, length: isSpecialSymbol || charLength });
        if (isSpecialSymbol) specialSymbolOffset -= charLength + 1;
      }
      callbacksRef.current.onBoundary?.({ progress: getProgress(offset + charIndex + charLength, speechText.length) });
    }

    utterance.onstart = startEventHandler;
    utterance.onend = stopEventHandler;
    utterance.onerror = stopEventHandler;
    utterance.onboundary = boundaryEventHandler;

    if (!preserveUtteranceQueue) clearQueue();
    addToQueue({ text: speechText, utterance, setSpeechStatus, sessionId: session.id }, callbacksRef.current.onQueueChange);
    if (!synth.speaking) {
      setSpeechStatus("started");
      return speakFromQueue();
    }
    // Preserved queues must wait their turn: do not interrupt the instance that
    // is already speaking. `startEventHandler` promotes this entry to "started"
    // once `speakFromQueue` actually reaches it.
    if (preserveUtteranceQueue && !wasStarted) {
      setSpeechStatus("queued");
      return;
    }
    setSpeechStatus("started");
    cancel();
    speakFromQueue();
  }

  function pause() {
    if (isMobile(false) || speechStatusRef.current === "queued") return stop();
    if (speechStatusRef.current === "started") {
      if (directiveRef.current.delay) reset("pause");
      else window.speechSynthesis?.pause();
      pauseEventHandler();
    }
  }

  function stop({ status = speechStatusRef.current, stopReason = "manual" }: { status?: SpeechStatus; stopReason?: State["stopReason"] } = {}) {
    // Cancel a start still waiting on the text debounce, even when nothing is
    // speaking yet ("stopped" would otherwise return early below).
    pendingStartRef.current = false;
    if (status === "stopped") return;
    const session = sessionRef.current;
    if (status === "queued") {
      if (session) teardownSession(session, { cancelSpeech: false });
      else setSpeechStatus("stopped");
      return;
    }
    reset();
    if (session) {
      teardownSession(session, { cancelSpeech: true, stopReason, speakNext: true, notifyStop: true });
      return;
    }
    cancel(stopReason);
    setSpeakingWord(null);
    setSpeechStatus("stopped");
  }

  function highlightedText(node: ReactNode, index = ""): ReactNode {
    if (!highlightText || !isParent(index, speakingWord?.index)) return;
    switch (typeof node) {
      case "number":
        node = String(node);
      case "string":
        const highlighted = splitNode(highlightMode, node as string, speakingWord)[1];
        return (
          <span {...highlightContainerProps}>
            <mark {...highlightProps}>{highlighted}</mark>
          </span>
        );
    }
    if (Array.isArray(node)) return node.map((child, i) => highlightedText(child, getIndex(index, i)));
    if (isValidElement<NodeProps>(node)) return cloneElement(node, { children: highlightedText(node.props.children, index) });
  }

  // Replace the current session whenever the spoken content changes (the text
  // key or `enableDirectives`). Tearing the old session down first guarantees
  // that stale chunk timers, listeners and utterance callbacks cannot outlive
  // it. The same cleanup covers unmount.
  useLayoutEffect(() => {
    return () => {
      const session = sessionRef.current;
      if (!session) return;
      const status = speechStatusRef.current;
      const isSpeaking = status === "started" || status === "paused";
      teardownSession(session, { cancelSpeech: isSpeaking, speakNext: isSpeaking, notifyStop: isSpeaking });
    };
  }, [stableKey, enableDirectives]);

  useLayoutEffect(() => {
    highlightRef.current = false;
    // A `start()` that arrived while the text was still debouncing resumes here,
    // now that the chunks reflect the current text.
    if (autoPlay || pendingStartRef.current) {
      pendingStartRef.current = false;
      start();
    }
  }, [autoPlay, stableKey, enableDirectives]);

  useLayoutEffect(() => {
    if (!highlightText || !highlightRef.current || showOnlyHighlightedText || !speakingWord) return;

    const parts = speakingWord.index.split("-");
    const parentIndex = parts.slice(0, -1).join("-");

    const elements = Array.from(document.getElementsByClassName(`${uniqueId}${parentIndex}`)) as HTMLElement[];
    const snapshots: HighlightSnapshot[] = [];
    elements.forEach((element) => {
      const originalTextContent = element.textContent;
      const [before, highlighted, after] = splitNode(highlightMode, element.textContent, speakingWord);

      const container = createElementWithProps("span", highlightContainerProps);
      const mark = createElementWithProps("mark", highlightProps);
      mark.textContent = highlighted;

      if (before) container.appendChild(document.createTextNode(before));
      container.appendChild(mark);
      if (after) container.appendChild(document.createTextNode(after));

      element.textContent = "";
      element.appendChild(container);
      snapshots.push({ element, originalTextContent, container });
    });
    highlightSnapshotsRef.current.push(...snapshots);

    return () => {
      highlightSnapshotsRef.current = highlightSnapshotsRef.current.filter((snapshot) => !snapshots.includes(snapshot));
      snapshots.forEach(({ element, originalTextContent, container }) => {
        if (element.isConnected && element.contains(container)) element.textContent = originalTextContent;
      });
    };
  }, [speakingWord, highlightText, showOnlyHighlightedText, highlightMode]);

  useEffect(() => {
    if (speechStatusRef.current !== "started") return;
    const session = sessionRef.current;
    const timeout = setTimeout(() => {
      if (pendingParamSwitchRef.current === timeout) pendingParamSwitchRef.current = null;
      // The session may have been replaced by a text change while this was pending.
      if (!session || sessionRef.current !== session || !session.active) return;
      if (speechStatusRef.current !== "started") return;
      updateProps(session.utterance, paramsRef.current);
      if (directiveRef.current.delay) return;
      // Only the queue head is actually being spoken. A queued instance must
      // never cancel another instance's speech just because its props changed.
      if (!isQueueHead(session.utterance)) return;
      cancel("change");
      emit(callbacksRef.current.onQueueChange);
    }, 500);
    pendingParamSwitchRef.current = timeout;
    return () => {
      clearTimeout(timeout);
      if (pendingParamSwitchRef.current === timeout) pendingParamSwitchRef.current = null;
    };
  }, [pitch, rate, volume, lang, stringifiedVoices]);

  return {
    uniqueId,
    normalizedText,
    reactContent,
    Text,
    speechStatus,
    isInQueue: speechStatus === "started" || speechStatus === "queued",
    start,
    pause,
    stop: () => stop(),
  };
}

function useSpeechSynthesisUtterance() {
  const { voices } = useVoices();

  function createUtterance(): SpeechSynthesisUtterance | null {
    if (typeof window === "undefined" || !window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") return null;
    return new SpeechSynthesisUtterance();
  }

  function updateProps(utterance: SpeechSynthesisUtterance | null, { pitch, rate, volume, lang, voiceURI }: SpeechSynthesisUtteranceProps) {
    if (!utterance) return;
    if (pitch !== undefined) utterance.pitch = pitch;
    if (rate !== undefined) utterance.rate = rate;
    if (volume !== undefined) utterance.volume = volume;
    if (lang !== undefined) utterance.lang = lang;
    if (voiceURI === undefined) return;
    if (!voiceURI) {
      utterance.voice = null;
      return;
    }
    if (!Array.isArray(voiceURI)) voiceURI = [voiceURI];
    for (let i = 0; i < voiceURI.length; i++) {
      const uri = voiceURI[i];
      const voice = voices.find((voice) => voice.voiceURI === uri);
      if (voice) {
        utterance.voice = voice;
        if (!lang) utterance.lang = voice.lang;
        return;
      }
    }
  }

  return { createUtterance, updateProps };
}

function useStateRef<T>(init: T) {
  const [state, setState] = useState(init);
  const ref = useRef(init);

  function setStateRef(value: T) {
    const next = isSetStateFunction(value) ? value(ref.current) : value;
    ref.current = next;
    setState(next);
  }

  return [state, ref, setStateRef] as const;
}

export function useVoices() {
  const [languages, setLanguages] = useState<string[]>([]);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  function setData(voices: SpeechSynthesisVoice[]) {
    setLanguages(Array.from(new Set(voices.map(({ lang }) => lang))));
    setVoices(voices);
  }

  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const voices = synth.getVoices();
    if (voices.length) setData(voices);
    else {
      const onVoicesChanged = () => setData(synth.getVoices());
      synth.addEventListener("voiceschanged", onVoicesChanged);
      return () => synth.removeEventListener("voiceschanged", onVoicesChanged);
    }
  }, []);

  return { languages, voices };
}
