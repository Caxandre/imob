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

  it("serializes a plain object body as JSON with a Content-Type header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/things", { method: "POST", body: { title: "x" } });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ title: "x" }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("passes a FormData body through untouched, without a manual Content-Type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const formData = new FormData();
    formData.append("file", new File(["x"], "photo.jpg", { type: "image/jpeg" }));

    await apiFetch("/things/1/media", { method: "POST", body: formData });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(formData);
    // The browser (not this code) sets `multipart/form-data; boundary=...` — a manual
    // `Content-Type` here would break the boundary the browser generates.
    expect(init.headers).not.toHaveProperty("Content-Type");
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
