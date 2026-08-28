import { describe, expect, it } from "vitest";

import { MAX_ORIGINAL_FILENAME_LENGTH, sanitizeOriginalFilename } from "./property-media-request.schema.js";

describe("sanitizeOriginalFilename", () => {
  it("returns a plain filename unchanged", () => {
    expect(sanitizeOriginalFilename("foto-sala.jpg")).toBe("foto-sala.jpg");
  });

  it("strips a relative path traversal prefix down to the basename", () => {
    expect(sanitizeOriginalFilename("../../foto.jpg")).toBe("foto.jpg");
  });

  it("strips a Windows-style absolute path down to the basename", () => {
    expect(sanitizeOriginalFilename("C:\\Users\\someone\\Pictures\\foto.jpg")).toBe("foto.jpg");
  });

  it("strips a Unix-style absolute path down to the basename", () => {
    expect(sanitizeOriginalFilename("/etc/passwd")).toBe("passwd");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeOriginalFilename("  foto.jpg  ")).toBe("foto.jpg");
  });

  it("returns null when filename is undefined", () => {
    expect(sanitizeOriginalFilename(undefined)).toBeNull();
  });

  it("returns null when nothing meaningful remains after stripping", () => {
    expect(sanitizeOriginalFilename("")).toBeNull();
    expect(sanitizeOriginalFilename("   ")).toBeNull();
    expect(sanitizeOriginalFilename("../../")).toBeNull();
  });

  it("caps length at MAX_ORIGINAL_FILENAME_LENGTH", () => {
    const longName = "a".repeat(MAX_ORIGINAL_FILENAME_LENGTH + 50);

    const result = sanitizeOriginalFilename(longName);

    expect(result).toHaveLength(MAX_ORIGINAL_FILENAME_LENGTH);
  });
});
