import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/http/api-fetch";

import { setPropertyMediaCover } from "./set-property-media-cover";

vi.mock("@/lib/http/api-fetch", () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROPERTY_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const MEDIA_ID = "m1";

function validResponse() {
  return {
    id: MEDIA_ID,
    property_id: PROPERTY_ID,
    public_url: "https://example.com/original.jpg",
    mime_type: "image/jpeg",
    size_bytes: 1000,
    original_filename: "foto.jpg",
    position: 1,
    is_cover: true,
    processing_status: "READY",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    variants: { thumbnail: null, card: null, detail: null },
  };
}

describe("setPropertyMediaCover", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue(validResponse());
  });

  it("calls PATCH /api/v1/properties/:id/media/:mediaId/cover with X-Tenant-Id and no body", async () => {
    await setPropertyMediaCover(TENANT_ID, PROPERTY_ID, MEDIA_ID);

    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/properties/${PROPERTY_ID}/media/${MEDIA_ID}/cover`,
      { method: "PATCH", headers: { "X-Tenant-Id": TENANT_ID } },
    );
  });

  it("validates and returns the parsed response", async () => {
    const result = await setPropertyMediaCover(TENANT_ID, PROPERTY_ID, MEDIA_ID);

    expect(result).toEqual(validResponse());
  });

  it("throws when the response does not match the contract", async () => {
    mockedApiFetch.mockResolvedValue({ id: "only-id" });

    await expect(setPropertyMediaCover(TENANT_ID, PROPERTY_ID, MEDIA_ID)).rejects.toThrow();
  });
});
