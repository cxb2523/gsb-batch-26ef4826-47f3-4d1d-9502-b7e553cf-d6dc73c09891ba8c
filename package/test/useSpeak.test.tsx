import { useSpeak } from "@/hooks";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeSpeech, type FakeSpeech } from "./fake-speech";

let fake: FakeSpeech;

beforeEach(() => {
  fake = installFakeSpeech();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** `useSpeech` stabilizes even `stableText` updates on a zero-delay timer. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("useSpeak", () => {
  it("speaks the text passed to the latest speak() call, never a stale one", async () => {
    const { result } = renderHook(() => useSpeak());

    act(() => result.current.speak("First utterance"));
    await waitFor(() => expect(fake.speakCalls.map((call) => call.text)).toEqual(["First utterance"]));
    expect(result.current.speechStatus).toBe("started");

    act(() => result.current.speak("Second utterance"));
    await waitFor(() => expect(fake.speakCalls.map((call) => call.text).at(-1)).toBe("Second utterance"));

    // The replaced utterance is detached, and the old text is never spoken again.
    const firstUtterance = fake.speakCalls[0]!.utterance;
    expect(firstUtterance.onend).toBeNull();
    await act(flush);
    expect(fake.speakCalls.map((call) => call.text)).toEqual(["First utterance", "Second utterance"]);
    expect(result.current.speechStatus).toBe("started");
  });

  it("stops speaking empty text when speak() receives an empty string", async () => {
    const { result } = renderHook(() => useSpeak());

    act(() => result.current.speak(""));
    await act(flush);

    expect(fake.speakCalls).toHaveLength(0);
    expect(result.current.speechStatus).toBe("stopped");
  });
});
