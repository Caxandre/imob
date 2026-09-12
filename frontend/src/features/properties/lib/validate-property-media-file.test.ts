import { describe, expect, it } from "vitest";

import {
  describePropertyMediaFileValidationError,
  MAX_PROPERTY_MEDIA_FILE_SIZE_BYTES,
  validatePropertyMediaFile,
} from "./validate-property-media-file";

function file(name: string, type: string, sizeBytes: number): File {
  const blob = new Blob([new Uint8Array(sizeBytes)], { type });
  return new File([blob], name, { type });
}

describe("validatePropertyMediaFile", () => {
  it("accepts a valid JPEG", () => {
    expect(validatePropertyMediaFile(file("a.jpg", "image/jpeg", 1000))).toBeNull();
  });

  it("accepts a valid PNG", () => {
    expect(validatePropertyMediaFile(file("a.png", "image/png", 1000))).toBeNull();
  });

  it("accepts a valid WebP", () => {
    expect(validatePropertyMediaFile(file("a.webp", "image/webp", 1000))).toBeNull();
  });

  it("rejects an unsupported MIME type", () => {
    expect(validatePropertyMediaFile(file("a.gif", "image/gif", 1000))).toBe("unsupported-type");
  });

  it("rejects a non-image file", () => {
    expect(validatePropertyMediaFile(file("a.pdf", "application/pdf", 1000))).toBe(
      "unsupported-type",
    );
  });

  it("rejects a file over the 10 MB limit", () => {
    expect(
      validatePropertyMediaFile(
        file("a.jpg", "image/jpeg", MAX_PROPERTY_MEDIA_FILE_SIZE_BYTES + 1),
      ),
    ).toBe("too-large");
  });

  it("accepts a file exactly at the 10 MB limit", () => {
    expect(
      validatePropertyMediaFile(file("a.jpg", "image/jpeg", MAX_PROPERTY_MEDIA_FILE_SIZE_BYTES)),
    ).toBeNull();
  });
});

describe("describePropertyMediaFileValidationError", () => {
  it("describes an unsupported type", () => {
    expect(describePropertyMediaFileValidationError("unsupported-type")).toMatch(/JPEG|PNG|WebP/);
  });

  it("describes an oversized file", () => {
    expect(describePropertyMediaFileValidationError("too-large")).toMatch(/10 ?MB/);
  });
});
