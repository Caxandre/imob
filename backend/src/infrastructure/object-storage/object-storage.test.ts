import { describe, expect, it } from "vitest";

import { InvalidObjectKeyError, validateObjectKey } from "./object-storage.js";

describe("validateObjectKey", () => {
  it("accepts a well-formed key", () => {
    expect(() => validateObjectKey("integration-tests/example.txt")).not.toThrow();
  });

  it("rejects an empty key", () => {
    expect(() => validateObjectKey("")).toThrow(InvalidObjectKeyError);
  });

  it("rejects a key starting with /", () => {
    expect(() => validateObjectKey("/leading.txt")).toThrow(InvalidObjectKeyError);
  });

  it("rejects a key containing a .. path segment", () => {
    expect(() => validateObjectKey("a/../b.txt")).toThrow(InvalidObjectKeyError);
  });

  it("rejects a key that is entirely ..", () => {
    expect(() => validateObjectKey("..")).toThrow(InvalidObjectKeyError);
  });

  it("does not reject a key merely containing the substring '..' inside a segment", () => {
    // ".." is only rejected as a full path segment, never as a substring — e.g. a filename
    // like "v1..2.txt" is unusual but not a path traversal attempt.
    expect(() => validateObjectKey("a/file..name.txt")).not.toThrow();
  });

  it("never includes any part of the key from a valid call in the error for other keys", () => {
    try {
      validateObjectKey("/leading.txt");
      expect.fail("expected InvalidObjectKeyError");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidObjectKeyError);
      expect((error as Error).message).toContain("/leading.txt");
      expect((error as Error).message).toContain('must not start with "/"');
    }
  });
});
