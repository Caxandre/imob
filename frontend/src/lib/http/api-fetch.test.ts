import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { apiUrl: "http://api.test" } }));

const { apiFetch } = await import("./api-fetch");
const { ApiError } = await import("./api-error");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("parses a successful JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(apiFetch("/things/1")).resolves.toEqual({ id: "1" });
  });

  it("returns undefined for a 204 No Content response, never attempting to parse a body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(apiFetch("/things/1", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("throws ApiError carrying the server's status and message for a 4xx JSON error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ statusCode: 404, error: "Not Found", message: "Thing not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          ),
        ),
    );

    const error: unknown = await apiFetch("/things/missing").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(404);
    expect((error as InstanceType<typeof ApiError>).message).toBe("Thing not found");
  });

  it("never makes a real network call — fetch is always stubbed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/anything");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("http://api.test/anything", expect.any(Object));
  });
});
