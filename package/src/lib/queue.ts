import { cancel } from "@/lib/utils";
import type { CleanupHandler, QueueChangeEventHandler, SpeechQueue, SpeechQueueItem } from "@/types";

const queue: SpeechQueue = [];

const queueListeners: QueueChangeEventHandler[] = [];

/**
 * The utterance that has most recently been handed to `speechSynthesis.speak`.
 * It is kept around so that concurrent calls to `speakFromQueue` (which can
 * happen when several effects and event handlers run in the same tick) do not
 * enqueue the exact same utterance more than once. The same utterance object is
 * reused while one session walks through its text chunks, so the hook clears
 * this marker as soon as an utterance ends (`markUtteranceEnded`).
 */
let activeUtterance: SpeechSynthesisUtterance | null = null;

/** @internal */
export function addToQueue(item: SpeechQueueItem, callback?: QueueChangeEventHandler): number {
  queue.push(item);
  emit(callback);
  return queue.length - 1;
}

export function clearQueue(cancelSpeech = false, start = 0, emitEvent = false) {
  // Remove entries before cancelling so a cancelled utterance's completion
  // handler cannot start speaking an entry that is already being dropped.
  const removed = queue.splice(start);
  removed.forEach(({ utterance, setSpeechStatus }) => {
    if (utterance === activeUtterance) activeUtterance = null;
    setSpeechStatus("stopped");
  });
  if (cancelSpeech) {
    activeUtterance = null;
    cancel();
  }
  if (emitEvent) emit();
}

/**
 * Removes every queue entry that belongs to `sessionId` while leaving entries
 * owned by other speech instances untouched. Each removed entry is notified so
 * its hook can transition to `"stopped"` instead of leaving a stale item in the
 * queue.
 *
 * @returns `true` when at least one entry was removed.
 */
export function removeSessionFromQueue(sessionId: string, callback?: QueueChangeEventHandler): boolean {
  if (!sessionId) return false;
  let removed = false;
  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i];
    if (!item || item.sessionId !== sessionId) continue;
    queue.splice(i, 1);
    if (item.utterance === activeUtterance) activeUtterance = null;
    item.setSpeechStatus("stopped");
    removed = true;
  }
  if (removed) emit(callback);
  return removed;
}

/**
 * Marks the given utterance (or the active one when omitted) as finished so
 * that it may be spoken again. Sessions reuse a single utterance instance for
 * all of their chunks, which makes this explicit hand-off necessary.
 */
export function markUtteranceEnded(utterance?: SpeechSynthesisUtterance) {
  if (utterance === undefined || activeUtterance === utterance) activeUtterance = null;
}

export const clearQueueHook = () => clearQueue(true, 1, true);

export const clearQueueUnload = () => clearQueue(true, 1);

export function dequeue(index: number = 0) {
  if (index === 0) cancel();
  else removeFromQueue(index);
}

export function emit(callback?: QueueChangeEventHandler) {
  const utteranceQueue = queue.map(({ text, utterance: { pitch, rate, volume, lang, voice } }) => ({ text, pitch, rate, volume, lang, voice }));
  queueListeners.forEach((listener) => listener(utteranceQueue));
  callback?.(utteranceQueue);
}

export function removeFromQueue(utterance: SpeechSynthesisUtterance, callback?: QueueChangeEventHandler): void;
export function removeFromQueue(utterance: number): void;
export function removeFromQueue(utterance: SpeechSynthesisUtterance | number, callback?: QueueChangeEventHandler) {
  const index = typeof utterance === "number" ? utterance : queue.findIndex((item) => item.utterance === utterance);
  if (index === -1) return;
  const [item] = queue.splice(index, 1);
  if (item) {
    if (item.utterance === activeUtterance) activeUtterance = null;
    if (index === 0) cancel();
    else item.setSpeechStatus("stopped");
    emit(callback);
  }
}

export function speakFromQueue() {
  const item = queue[0];
  if (!item) return;
  const { utterance } = item;
  // The same utterance instance is reused across chunks of a single session, so
  // re-entrant calls (e.g. a delayed directive timer firing while the previous
  // chunk is still being spoken) must not call `speak` twice for one utterance.
  if (activeUtterance === utterance) return;
  activeUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

/** @internal Whether `utterance` is the entry currently at the head of the queue. */
export function isQueueHead(utterance: SpeechSynthesisUtterance): boolean {
  return queue[0]?.utterance === utterance;
}

export function subscribe(callback: QueueChangeEventHandler): CleanupHandler {
  queueListeners.push(callback);
  return () => {
    const index = queueListeners.indexOf(callback);
    if (index !== -1) queueListeners.splice(index, 1);
  };
}
