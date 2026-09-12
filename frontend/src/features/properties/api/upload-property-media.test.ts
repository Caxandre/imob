import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/http/api-fetch";

import { uploadPropertyMedia } from "./upload-property-media";

vi.mock("@/lib/http/api-fetch", () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROPERTY_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function validResponse() {
  return {
    id: "m1",
    property_id: PROPERTY_ID,
    public_url: "https://example.com/original.jpg",
    mime_type: "image/jpeg",
    size_bytes: 1000,
    original_filename: "foto.jpg",
    position: 0,
    is_cover: true,
    processing_status: "PROCESSING",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    variants: { thumbnail: null, card: null, detail: null },
  };
}

describe("uploadPropertyMedia", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue(validResponse());
  });

  it("calls POST /api/v1/properties/:id/media with X-Tenant-Id and a FormData body", async () => {
    const file = new File(["x"], "foto.jpg", { type: "image/jpeg" });
    await uploadPropertyMedia(TENANT_ID, PROPERTY_ID, file);

    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    const [path, options] = mockedApiFetch.mock.calls[0]!;
    expect(path).toBe(`/api/v1/properties/${PROPERTY_ID}/media`);
    expect(options?.method).toBe("POST");
    expect(options?.headers).toEqual({ "X-Tenant-Id": TENANT_ID });
    expect(options?.body).toBeInstanceOf(FormData);
  });

  it("sends the file under the 'file' field", async () => {
    const file = new File(["x"], "foto.jpg", { type: "image/jpeg" });
    await uploadPropertyMedia(TENANT_ID, PROPERTY_ID, file);

    const [, options] = mockedApiFetch.mock.calls[0]!;
    const formData = options?.body as FormData;
    expect(formData.get("file")).toBe(file);
  });

  it("validates and returns the parsed response", async () => {
    const file = new File(["x"], "foto.jpg", { type: "image/jpeg" });
    const result = await uploadPropertyMedia(TENANT_ID, PROPERTY_ID, file);

    expect(result).toEqual(validResponse());
  });

  it("throws when the response does not match the contract", async () => {
    mockedApiFetch.mockResolvedValue({ id: "only-id" });

    const file = new File(["x"], "foto.jpg", { type: "image/jpeg" });
    await expect(uploadPropertyMedia(TENANT_ID, PROPERTY_ID, file)).rejects.toThrow();
  });
});
