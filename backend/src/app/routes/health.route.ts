import type { FastifyInstance } from "fastify";

export async function healthRoute(app: FastifyInstance) {
  app.get(
    "/health",
    {
      schema: {
        operationId: "healthCheck",
        summary: "Health check",
        description: "Basic liveness check for the API process.",
        tags: ["System"],
        response: {
          200: { $ref: "HealthResponse#" },
          500: { description: "Unexpected server error", $ref: "ErrorResponse#" },
        },
      },
    },
    async () => {
      return { status: "ok" as const };
    },
  );
}
