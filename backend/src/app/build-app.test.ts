import { describe, expect, it } from "vitest";

import { buildTestApp } from "./test-support/build-test-app.js";

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const app = buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });

    await app.close();
  });
});
