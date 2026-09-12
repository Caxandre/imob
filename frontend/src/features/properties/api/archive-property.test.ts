import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/http/api-fetch";

import { archiveProperty } from "./archive-property";

vi.mock("@/lib/http/api-fetch", () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROPERTY_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("archiveProperty", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue(undefined);
  });

  it("calls DELETE /api/v1/properties/:id with X-Tenant-Id", async () => {
    await archiveProperty(TENANT_ID, PROPERTY_ID);

    expect(mockedApiFetch).toHaveBeenCalledWith(`/api/v1/properties/${PROPERTY_ID}`, {
      method: "DELETE",
      headers: { "X-Tenant-Id": TENANT_ID },
    });
  });

  it("resolves without a return value for the 204 response", async () => {
    await expect(archiveProperty(TENANT_ID, PROPERTY_ID)).resolves.toBeUndefined();
  });

  it("propagates an error from apiFetch", async () => {
    mockedApiFetch.mockRejectedValue(new Error("boom"));

    await expect(archiveProperty(TENANT_ID, PROPERTY_ID)).rejects.toThrow("boom");
  });
});
