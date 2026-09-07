import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveBackendPath } from "./project-root.js";

describe("resolveBackendPath", () => {
  it("returns an already-absolute path unchanged (section 61)", () => {
    const absolute = path.resolve(path.sep, "tmp", "imob-secrets.json");

    expect(resolveBackendPath(absolute)).toBe(absolute);
  });

  it("resolves a relative path against the backend package root, not process.cwd() (section 62)", () => {
    const resolved = resolveBackendPath(".local/secrets.json");

    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(path.join(".local", "secrets.json"))).toBe(true);
    // The backend root is the directory containing this project's package.json.
    expect(existsSync(path.join(path.dirname(resolved), "..", "package.json"))).toBe(true);
  });
});
