import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/http/api-fetch";

import { listPropertyMedia } from "./list-property-media";

vi.mock("@/lib/http/api-fetch", () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

function validMediaItem() {
  return {
    id: "m1",
    property_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    public_url: "https://example.com/original.jpg",
    mime_type: "image/jpeg",
    size_bytes: 1000,
    original_filename: "foto.jpg",
    position: 0,
    is_cover: true,
    processing_status: "READY",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    variants: { thumbnail: null, card: null, detail: null },
  };
}

describe("listPropertyMedia", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue({ data: [validMediaItem()] });
  });

  it("calls GET /api/v1/properties/:id/media with X-Tenant-Id", async () => {
    await listPropertyMedia(
      "11111111-1111-1111-1111-111111111111",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    );

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/properties/3fa85f64-5717-4562-b3fc-2c963f66afa6/media",
      { headers: { "X-Tenant-Id": "11111111-1111-1111-1111-111111111111" } },
    );
  });

  it("validates and returns the parsed response", async () => {
    const response = await listPropertyMedia(
      "11111111-1111-1111-1111-111111111111",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    );

    expect(response).toEqual({ data: [validMediaItem()] });
  });

  it("throws when the response does not match the contract", async () => {
    mockedApiFetch.mockResolvedValue({ data: [{ id: "only-id" }] });

    await expect(
      listPropertyMedia(
        "11111111-1111-1111-1111-111111111111",
        "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      ),
    ).rejects.toThrow();
  });
});
