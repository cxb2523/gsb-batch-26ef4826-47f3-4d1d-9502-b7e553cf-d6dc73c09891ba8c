import { useSpeech } from "@/hooks";
import type { SpeechStatus, UseSpeechOptions } from "@/types";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";

type HarnessProps = Partial<UseSpeechOptions> & {
  text: ReactNode;
  /** Receives the latest hook result so tests can drive start/pause/stop. */
  apiRef: { current: null | ReturnType<typeof useSpeech> };
  renderText?: boolean;
};

function Harness({ apiRef, renderText = true, ...options }: HarnessProps) {
  const api = useSpeech(options as UseSpeechOptions);
  apiRef.current = api;

  if (!renderText) return null;
  const { Text } = api;
  return <Text />;
}

export function renderSpeech(options: Omit<HarnessProps, "apiRef">) {
  const apiRef: { current: null | ReturnType<typeof useSpeech> } = { current: null };
  const result = render(<Harness {...options} apiRef={apiRef} />);
  return {
    ...result,
    get api() {
      if (!apiRef.current) throw new Error("hook not mounted");
      return apiRef.current;
    },
    get status(): SpeechStatus {
      if (!apiRef.current) throw new Error("hook not mounted");
      return apiRef.current.speechStatus;
    },
    rerenderSpeech(next: Omit<HarnessProps, "apiRef">) {
      result.rerender(<Harness {...next} apiRef={apiRef} />);
    },
  };
}
