import { describe, expect, it } from "vitest";

import {
  MAX_ORIGINAL_FILENAME_LENGTH,
  propertyMediaIdParamsSchema,
  reorderPropertyMediaBodySchema,
  sanitizeOriginalFilename,
} from "./property-media-request.schema.js";

const VALID_ID = "11111111-1111-4111-8111-111111111111";
const VALID_ID_2 = "22222222-2222-4222-8222-222222222222";

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

describe("propertyMediaIdParamsSchema", () => {
  it("accepts two valid UUIDs", () => {
    const result = propertyMediaIdParamsSchema.safeParse({ id: VALID_ID, mediaId: VALID_ID_2 });
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID id", () => {
    expect(propertyMediaIdParamsSchema.safeParse({ id: "not-a-uuid", mediaId: VALID_ID_2 }).success).toBe(false);
  });

  it("rejects a non-UUID mediaId", () => {
    expect(propertyMediaIdParamsSchema.safeParse({ id: VALID_ID, mediaId: "not-a-uuid" }).success).toBe(false);
  });
});

describe("reorderPropertyMediaBodySchema", () => {
  it("accepts a non-empty array of valid UUIDs", () => {
    const result = reorderPropertyMediaBodySchema.safeParse({ media_ids: [VALID_ID, VALID_ID_2] });
    expect(result.success).toBe(true);
  });

  it("accepts an empty array", () => {
    expect(reorderPropertyMediaBodySchema.safeParse({ media_ids: [] }).success).toBe(true);
  });

  it("rejects duplicate ids", () => {
    const result = reorderPropertyMediaBodySchema.safeParse({ media_ids: [VALID_ID, VALID_ID] });
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID entry", () => {
    expect(reorderPropertyMediaBodySchema.safeParse({ media_ids: ["not-a-uuid"] }).success).toBe(false);
  });

  it("rejects an unknown field (e.g. a client-supplied position)", () => {
    const result = reorderPropertyMediaBodySchema.safeParse({ media_ids: [VALID_ID], position: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects a missing media_ids field", () => {
    expect(reorderPropertyMediaBodySchema.safeParse({}).success).toBe(false);
  });
});
