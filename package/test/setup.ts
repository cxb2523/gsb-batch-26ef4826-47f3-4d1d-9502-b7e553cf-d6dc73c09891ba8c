import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

// React 19 requires this flag for `act` to work in a jsdom environment.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
});
