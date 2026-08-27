/** Registered via `app.addSchema()` and referenced by `health.route.ts`. */
export const healthResponseSchema = {
  $id: "HealthResponse",
  title: "HealthResponse",
  type: "object",
  description: "Liveness status of the API process.",
  properties: {
    status: { type: "string", enum: ["ok"] },
  },
  required: ["status"],
  examples: [{ status: "ok" }],
} as const;
