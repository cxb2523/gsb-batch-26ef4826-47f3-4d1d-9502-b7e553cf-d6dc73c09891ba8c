import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeSpeech, type FakeSpeech } from "./fake-speech";
import { renderSpeech } from "./harness";

let fake: FakeSpeech;

beforeEach(() => {
  vi.useFakeTimers();
  fake = installFakeSpeech();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Flush the zero-delay timers used by `useStableValue` for immediate updates. */
function flushUpdates() {
  act(() => {
    vi.advanceTimersByTime(0);
  });
}

describe("useSpeech session lifecycle", () => {
  it("replaces the session when the text changes while speaking", () => {
    const view = renderSpeech({ text: "Hello world", autoPlay: true, highlightText: true });
    flushUpdates();

    expect(view.status).toBe("started");
    expect(fake.speakCalls.map((call) => call.text)).toEqual(["Hello world"]);

    const oldUtterance = fake.speakCalls[0]!.utterance;

    // Highlight a word so the DOM is rewritten before the text arrives.
    act(() => fake.boundary(0, 5));
    expect(view.container.querySelector("mark")?.textContent).toBe("Hello");

    view.rerenderSpeech({ text: "New text", autoPlay: true, highlightText: true });
    flushUpdates();

    // The old session is fully detached: no callbacks can fire any more.
    expect(oldUtterance.onstart).toBeNull();
    expect(oldUtterance.onend).toBeNull();
    expect(oldUtterance.onerror).toBeNull();
    expect(oldUtterance.onboundary).toBeNull();

    // The new content is what gets spoken, and nothing from the old text is left.
    const spoken = fake.speakCalls.map((call) => call.text);
    expect(spoken.at(-1)).toBe("New text");
    expect(spoken.filter((text) => text.includes("Hello"))).toHaveLength(1);

    expect(view.status).toBe("started");
    expect(view.container.textContent).toBe("New text");
    expect(view.container.querySelector("mark")).toBeNull();
  });

  it("stops instead of starting when autoPlay is disabled", () => {
    const view = renderSpeech({ text: "First passage" });
    flushUpdates();

    act(() => view.api.start());
    expect(view.status).toBe("started");

    view.rerenderSpeech({ text: "Second passage" });
    flushUpdates();

    expect(view.status).toBe("stopped");
    expect(fake.speakCalls).toHaveLength(1);
  });

  it("does not replay the old chunk after a pending directive delay", () => {
    const view = renderSpeech({ text: "First [[delay=1000]] chunk", enableDirectives: true, autoPlay: true });
    flushUpdates();
    expect(fake.speakCalls).toHaveLength(1);

    // Finish the first chunk: the delay timer for the next chunk is now armed.
    act(() => fake.finishCurrent());

    view.rerenderSpeech({ text: "Replacement text", enableDirectives: true, autoPlay: true });
    flushUpdates();

    const callsAfterSwitch = fake.speakCalls.length;
    act(() => vi.advanceTimersByTime(5000));

    const spokenAfterSwitch = fake.speakCalls.slice(callsAfterSwitch).map((call) => call.text);
    expect(spokenAfterSwitch).not.toContain("chunk");
    expect(fake.speakCalls.map((call) => call.text)).toContain("Replacement text");
  });

  it("rebuilds chunks when enableDirectives flips", () => {
    const view = renderSpeech({ text: "Read [[pitch=0.5]] this", autoPlay: true });
    flushUpdates();
    expect(view.status).toBe("started");
    const withoutDirectives = fake.speakCalls.length;

    // With directives enabled the same text is chunked differently (the
    // directive becomes its own segment), so a new session must be built.
    view.rerenderSpeech({ text: "Read [[pitch=0.5]] this", enableDirectives: true, autoPlay: true });
    flushUpdates();

    expect(view.status).toBe("started");
    expect(fake.speakCalls.length).toBeGreaterThan(withoutDirectives);
    expect(view.container.textContent).toBe("Read this");
  });

  it("applies only the last parameter change in a rapid burst", () => {
    const onQueueChange = vi.fn();
    const view = renderSpeech({ text: "Parameter test", autoPlay: true, onQueueChange });
    flushUpdates();

    expect(view.status).toBe("started");
    expect(fake.cancelCount).toBe(0);
    const emits = onQueueChange.mock.calls.length;

    act(() => view.rerenderSpeech({ text: "Parameter test", autoPlay: true, rate: 1.5, onQueueChange }));
    act(() => view.rerenderSpeech({ text: "Parameter test", autoPlay: true, rate: 2, onQueueChange }));
    act(() => view.rerenderSpeech({ text: "Parameter test", autoPlay: true, rate: 3, onQueueChange }));
    flushUpdates();

    act(() => vi.advanceTimersByTime(499));
    expect(fake.cancelCount).toBe(0);

    act(() => vi.advanceTimersByTime(1));
    expect(fake.cancelCount).toBe(1);
    expect(onQueueChange.mock.calls.length - emits).toBe(1);

    // Superseded timers must not fire a second switch.
    act(() => vi.advanceTimersByTime(5000));
    expect(fake.cancelCount).toBe(1);
  });

  it("ignores a stale parameter timer that was armed before a text change", () => {
    const view = renderSpeech({ text: "Original", autoPlay: true });
    flushUpdates();

    act(() => view.rerenderSpeech({ text: "Original", autoPlay: true, rate: 2 }));
    flushUpdates();
    // The 500ms switch is now pending. Replace the text before it fires.
    view.rerenderSpeech({ text: "Rewritten", autoPlay: true, rate: 2 });
    flushUpdates();

    const callsAfterRewrite = fake.speakCalls.length;
    act(() => vi.advanceTimersByTime(5000));

    // The stale callback must not stop or re-emit for the new session.
    expect(fake.speakCalls.slice(callsAfterRewrite).map((call) => call.text)).not.toContain("Original");
    expect(view.status).toBe("started");
  });

  it("stops through teardown and restores highlighted DOM", () => {
    const view = renderSpeech({ text: "Highlight me", autoPlay: true, highlightText: true });
    flushUpdates();

    act(() => fake.boundary(0, 9));
    const mark = view.container.querySelector("mark");
    expect(mark?.textContent).toBe("Highlight");

    act(() => view.api.stop());

    expect(view.status).toBe("stopped");
    expect(view.container.querySelector("mark")).toBeNull();
    expect(view.container.textContent).toBe("Highlight me");
  });

  it("cleans up listeners and timers on unmount", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const view = renderSpeech({ text: "Unmount test", autoPlay: true });
    flushUpdates();
    expect(addSpy.mock.calls.some(([type]) => type === "beforeunload")).toBe(true);

    // Arm a parameter-change timer that must be cancelled by unmount.
    act(() => view.rerenderSpeech({ text: "Unmount test", autoPlay: true, rate: 2 }));
    flushUpdates();

    view.unmount();
    expect(removeSpy.mock.calls.some(([type]) => type === "beforeunload")).toBe(true);

    // The pending 500ms parameter switch must not run after unmount.
    const cancelCount = fake.cancelCount;
    act(() => vi.advanceTimersByTime(5000));
    expect(fake.cancelCount).toBe(cancelCount);
  });

  it("does not start text that was replaced and then stopped inside the debounce window", () => {
    const view = renderSpeech({ text: "Original text", updateMode: "debounce", updateDelay: 200 });
    flushUpdates();
    act(() => view.api.start());
    expect(view.status).toBe("started");

    // Changing the text arms a debounce; a start() request in this window must
    // wait for the new chunks instead of speaking the old ones.
    act(() => view.rerenderSpeech({ text: "Replacement text", updateMode: "debounce", updateDelay: 200 }));
    act(() => view.api.start());
    expect(view.status).toBe("started");

    // Pressing stop before the debounce elapses cancels the pending start.
    act(() => view.api.stop());

    const callsAfterStop = fake.speakCalls.length;
    act(() => vi.advanceTimersByTime(1000));

    expect(fake.speakCalls.slice(callsAfterStop).map((call) => call.text)).not.toContain("Replacement text");
    expect(view.status).toBe("stopped");
  });

  it("uses the latest callbacks after a text change", () => {
    const firstStart = vi.fn();
    const secondStart = vi.fn();
    const view = renderSpeech({ text: "Callback A", autoPlay: true, onStart: firstStart });
    flushUpdates();
    expect(firstStart).toHaveBeenCalled();

    view.rerenderSpeech({ text: "Callback B", autoPlay: true, onStart: secondStart });
    flushUpdates();

    expect(secondStart).toHaveBeenCalledWith();
    expect(firstStart).toHaveBeenCalledTimes(1);
  });

  it("highlights the new text after a mid-speech text change", () => {
    const view = renderSpeech({ text: "Alpha bravo charlie", autoPlay: true, highlightText: true });
    flushUpdates();

    act(() => fake.boundary(0, 5));
    expect(view.container.querySelector("mark")?.textContent).toBe("Alpha");

    view.rerenderSpeech({ text: "Delta echo foxtrot", autoPlay: true, highlightText: true });
    flushUpdates();

    // No highlight is left over from the replaced text.
    expect(view.container.querySelector("mark")).toBeNull();

    act(() => fake.boundary(6, 4));
    const marks = Array.from(view.container.querySelectorAll("mark"));
    expect(marks.map((mark) => mark.textContent)).toEqual(["echo"]);
    expect(view.container.textContent).toBe("Delta echo foxtrot");
  });

  it("restores manually rewritten markup when a ReactNode text changes", () => {
    const first = (
      <p>
        <span id="passage">Hello world</span>
      </p>
    );
    const second = (
      <p>
        <span id="passage">New content</span>
      </p>
    );

    const view = renderSpeech({ text: first, autoPlay: true, highlightText: true });
    flushUpdates();
    act(() => fake.boundary(0, 5));

    // Highlighting rewrites the element's children in place.
    expect(view.container.querySelector("mark")?.textContent).toBe("Hello");
    expect(view.container.querySelector("#passage")?.innerHTML).toBe("<span><mark>Hello</mark> world</span>");

    view.rerenderSpeech({ text: second, autoPlay: true, highlightText: true });
    flushUpdates();

    // The temporary markup is gone and the new content is intact — no leftover mark.
    expect(view.container.querySelector("mark")).toBeNull();
    expect(view.container.querySelector("#passage")?.textContent).toBe("New content");
    expect(view.container.querySelector("#passage")?.innerHTML).toBe("New content");
  });

  it("never continues reading chunks of replaced text", () => {
    const firstText = `${"First passage sentence. ".repeat(6)}`;
    const secondText = `${"Second passage sentence. ".repeat(6)}`;
    const view = renderSpeech({ text: firstText, maxChunkSize: 50, autoPlay: true });
    flushUpdates();

    // Speak a couple of chunks of the first text.
    act(() => fake.finishCurrent());
    act(() => fake.finishCurrent());
    const chunksOfFirstText = fake.speakCalls.filter((call) => call.text.includes("First passage")).length;
    expect(chunksOfFirstText).toBeGreaterThan(1);

    view.rerenderSpeech({ text: secondText, maxChunkSize: 50, autoPlay: true });
    flushUpdates();
    expect(view.status).toBe("started");
    const callsAfterSwitch = fake.speakCalls.length;

    // Let many more chunk boundaries elapse on the new session.
    for (let i = 0; i < 6; i++) act(() => fake.finishCurrent());

    const spokenAfterSwitch = fake.speakCalls.slice(callsAfterSwitch).map((call) => call.text);
    expect(spokenAfterSwitch.length).toBeGreaterThan(0);
    expect(spokenAfterSwitch.some((text) => text.includes("Second passage"))).toBe(true);
    expect(spokenAfterSwitch.every((text) => !text.includes("First passage"))).toBe(true);
  });

  it("does not let a queued instance's parameter change interrupt the speaker", () => {
    const first = renderSpeech({ text: "First instance text", preserveUtteranceQueue: true });
    flushUpdates();
    act(() => first.api.start());

    const second = renderSpeech({ text: "Second instance text", preserveUtteranceQueue: true });
    flushUpdates();
    act(() => second.api.start());
    expect(second.status).toBe("queued");

    const cancelCount = fake.cancelCount;
    second.rerenderSpeech({ text: "Second instance text", preserveUtteranceQueue: true, rate: 2 });
    flushUpdates();
    act(() => vi.advanceTimersByTime(5000));

    // The speaker was never cancelled and is still speaking its own text.
    expect(fake.cancelCount).toBe(cancelCount);
    expect(first.status).toBe("started");
    expect(fake.currentText()).toBe("First instance text");

    first.unmount();
    second.unmount();
  });
});

describe("useSpeech queue ownership", () => {
  it("stops only its own queued entry in a multi-instance setup", () => {
    const first = renderSpeech({ text: "First instance text", preserveUtteranceQueue: true });
    flushUpdates();
    act(() => first.api.start());
    expect(first.status).toBe("started");

    const second = renderSpeech({ text: "Second instance text", preserveUtteranceQueue: true });
    flushUpdates();
    act(() => second.api.start());
    expect(second.status).toBe("queued");

    act(() => second.api.stop());

    expect(second.status).toBe("stopped");
    expect(first.status).toBe("started");
    expect(fake.speakCalls.map((call) => call.text)).toEqual(["First instance text"]);
    expect(fake.currentText()).toBe("First instance text");

    first.unmount();
    second.unmount();
  });

  it("promotes the next instance when the speaking instance stops", () => {
    const first = renderSpeech({ text: "First instance text", preserveUtteranceQueue: true });
    flushUpdates();
    act(() => first.api.start());

    const second = renderSpeech({ text: "Second instance text", preserveUtteranceQueue: true });
    flushUpdates();
    act(() => second.api.start());
    expect(second.status).toBe("queued");

    act(() => first.api.stop());

    expect(first.status).toBe("stopped");
    expect(second.status).toBe("started");
    expect(fake.currentText()).toBe("Second instance text");

    first.unmount();
    second.unmount();
  });

  it("keeps the shared beforeunload listener while another instance is speaking", () => {
    const first = renderSpeech({ text: "First instance text", preserveUtteranceQueue: true });
    flushUpdates();
    act(() => first.api.start());

    const second = renderSpeech({ text: "Second instance text", preserveUtteranceQueue: true });
    flushUpdates();
    act(() => second.api.start());
    expect(second.status).toBe("queued");

    // Stopping the queued instance must not remove the handler that the
    // speaking instance relies on; it is registered once on window.
    const removeSpy = vi.spyOn(window, "removeEventListener");
    act(() => second.api.stop());
    expect(removeSpy.mock.calls.some(([type]) => type === "beforeunload")).toBe(false);

    // When the speaker stops, its own teardown does remove the listener.
    act(() => first.api.stop());
    expect(removeSpy.mock.calls.some(([type]) => type === "beforeunload")).toBe(true);

    first.unmount();
    second.unmount();
  });
});

describe("useSpeech public interface", () => {
  it("keeps the hook contract stable", () => {
    const view = renderSpeech({ text: "Contract", autoPlay: false });
    flushUpdates();

    expect(view.api.Text).toBeTruthy();
    expect(view.api.speechStatus).toBe("stopped");
    expect(view.api.isInQueue).toBe(false);
    expect(view.api.start).toBeTypeOf("function");
    expect(view.api.pause).toBeTypeOf("function");
    expect(view.api.stop).toBeTypeOf("function");
    expect(view.api).not.toHaveProperty("uniqueId");
  });
});
