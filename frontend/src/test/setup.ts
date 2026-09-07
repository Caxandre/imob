import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import "@testing-library/jest-dom/vitest";

// `globals: true` isn't set in vite.config.ts, so Testing Library's own auto-cleanup (which
// relies on a global `afterEach`) never registers — without this, a `render()` in one test can
// still be in the DOM when the next test's `queryBy...` runs.
afterEach(cleanup);

// jsdom doesn't implement these (used by Radix's Select, added for Prompt 037B) — without a
// no-op stub, interacting with a `Select` in tests throws `... is not a function`.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
