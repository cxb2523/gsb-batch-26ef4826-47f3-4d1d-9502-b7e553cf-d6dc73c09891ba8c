import { addToQueue, clearQueue, isQueueHead, markUtteranceEnded, removeSessionFromQueue, speakFromQueue, subscribe } from "@/lib/queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeSpeech, type FakeSpeech } from "./fake-speech";

let fake: FakeSpeech;

function utterance(text: string): SpeechSynthesisUtterance {
  const created = new SpeechSynthesisUtterance();
  created.text = text;
  return created;
}

beforeEach(() => {
  fake = installFakeSpeech();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("queue session ownership", () => {
  it("removes only entries belonging to the given session", () => {
    const statusA = vi.fn();
    const statusB = vi.fn();
    const statusC = vi.fn();
    const a = utterance("a");
    const b = utterance("b");
    const c = utterance("c");
    const queueChanged = vi.fn();

    addToQueue({ text: "a", utterance: a, setSpeechStatus: statusA, sessionId: "s1" }, queueChanged);
    addToQueue({ text: "b", utterance: b, setSpeechStatus: statusB, sessionId: "s2" }, queueChanged);
    addToQueue({ text: "c", utterance: c, setSpeechStatus: statusC, sessionId: "s1" }, queueChanged);

    expect(removeSessionFromQueue("s1", queueChanged)).toBe(true);

    expect(statusA).toHaveBeenCalledWith("stopped");
    expect(statusC).toHaveBeenCalledWith("stopped");
    expect(statusB).not.toHaveBeenCalled();
    expect(queueChanged).toHaveBeenLastCalledWith([expect.objectContaining({ text: "b" })]);

    // The surviving entry is still speakable.
    speakFromQueue();
    expect(fake.speakCalls.map((call) => call.utterance)).toEqual([b]);

    clearQueue();
  });

  it("reports false when no entry belongs to the session", () => {
    const status = vi.fn();
    addToQueue({ text: "only", utterance: utterance("only"), setSpeechStatus: status, sessionId: "keep" });

    expect(removeSessionFromQueue("missing")).toBe(false);
    expect(status).not.toHaveBeenCalled();

    clearQueue();
  });

  it("never speaks the same utterance twice in a row", () => {
    const other = utterance("other");
    const status = vi.fn();
    addToQueue({ text: "first", utterance: other, setSpeechStatus: status, sessionId: "s" });

    speakFromQueue();
    speakFromQueue();
    speakFromQueue();

    expect(fake.speakCalls.map((call) => call.utterance)).toEqual([other]);

    // A completed utterance may be spoken again (chunked sessions reuse one).
    markUtteranceEnded(other);
    speakFromQueue();
    expect(fake.speakCalls.map((call) => call.utterance)).toEqual([other, other]);

    clearQueue();
  });

  it("only speaks the head of the queue", () => {
    const first = utterance("first");
    const second = utterance("second");
    addToQueue({ text: "first", utterance: first, setSpeechStatus: vi.fn(), sessionId: "s1" });
    addToQueue({ text: "second", utterance: second, setSpeechStatus: vi.fn(), sessionId: "s2" });

    speakFromQueue();
    expect(fake.speakCalls.map((call) => call.utterance)).toEqual([first]);
    expect(isQueueHead(first)).toBe(true);
    expect(isQueueHead(second)).toBe(false);

    clearQueue();
  });

  it("notifies subscribers with a plain snapshot", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    addToQueue({ text: "snapshot", utterance: utterance("snapshot"), setSpeechStatus: vi.fn(), sessionId: "s" });

    expect(listener).toHaveBeenLastCalledWith([expect.objectContaining({ text: "snapshot", pitch: 1 })]);

    unsubscribe();
    clearQueue();
  });
});
