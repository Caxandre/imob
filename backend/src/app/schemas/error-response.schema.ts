/**
 * Standard error envelope returned by every HTTP error response in this API (validation
 * failures, conflicts, and the global error handler's controlled 500) — see
 * `build-app.ts`'s `setErrorHandler` and `tenant-routes.ts`. Registered once via
 * `app.addSchema()` and referenced with `$ref` from route schemas so every error response is
 * documented against the exact same shape, never a copy that can drift.
 */
export const errorResponseSchema = {
  $id: "ErrorResponse",
  title: "ErrorResponse",
  type: "object",
  description: "Error envelope shared by every non-2xx JSON response in this API.",
  properties: {
    statusCode: { type: "integer", description: "HTTP status code, repeated in the body." },
    error: { type: "string", description: 'Short error name, e.g. "Bad Request".' },
    message: { type: "string", description: "Human-readable error message." },
    details: {
      type: "array",
      description: "Per-field validation issues. Present only for request validation failures.",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          message: { type: "string" },
        },
        required: ["path", "message"],
      },
    },
  },
  required: ["statusCode", "error", "message"],
} as const;
