import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/http/api-fetch";

import { reorderPropertyMedia } from "./reorder-property-media";

vi.mock("@/lib/http/api-fetch", () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROPERTY_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function mediaItem(id: string, position: number) {
  return {
    id,
    property_id: PROPERTY_ID,
    public_url: "https://example.com/original.jpg",
    mime_type: "image/jpeg",
    size_bytes: 1000,
    original_filename: "foto.jpg",
    position,
    is_cover: position === 0,
    processing_status: "READY",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    variants: { thumbnail: null, card: null, detail: null },
  };
}

describe("reorderPropertyMedia", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue({ data: [mediaItem("b", 0), mediaItem("a", 1)] });
  });

  it("calls PUT /api/v1/properties/:id/media/order with X-Tenant-Id and the full media_ids set", async () => {
    await reorderPropertyMedia(TENANT_ID, PROPERTY_ID, ["b", "a"]);

    expect(mockedApiFetch).toHaveBeenCalledWith(`/api/v1/properties/${PROPERTY_ID}/media/order`, {
      method: "PUT",
      headers: { "X-Tenant-Id": TENANT_ID },
      body: { media_ids: ["b", "a"] },
    });
  });

  it("validates and returns the parsed response", async () => {
    const result = await reorderPropertyMedia(TENANT_ID, PROPERTY_ID, ["b", "a"]);

    expect(result).toEqual({ data: [mediaItem("b", 0), mediaItem("a", 1)] });
  });

  it("throws when the response does not match the contract", async () => {
    mockedApiFetch.mockResolvedValue({ data: [{ id: "only-id" }] });

    await expect(reorderPropertyMedia(TENANT_ID, PROPERTY_ID, ["a"])).rejects.toThrow();
  });
});
