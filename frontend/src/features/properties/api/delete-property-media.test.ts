import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/http/api-fetch";

import { deletePropertyMedia } from "./delete-property-media";

vi.mock("@/lib/http/api-fetch", () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROPERTY_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const MEDIA_ID = "m1";

describe("deletePropertyMedia", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue(undefined);
  });

  it("calls DELETE /api/v1/properties/:id/media/:mediaId with X-Tenant-Id", async () => {
    await deletePropertyMedia(TENANT_ID, PROPERTY_ID, MEDIA_ID);

    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/properties/${PROPERTY_ID}/media/${MEDIA_ID}`,
      {
        method: "DELETE",
        headers: { "X-Tenant-Id": TENANT_ID },
      },
    );
  });

  it("resolves without a return value for the 204 response", async () => {
    await expect(deletePropertyMedia(TENANT_ID, PROPERTY_ID, MEDIA_ID)).resolves.toBeUndefined();
  });
});
