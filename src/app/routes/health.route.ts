import type { FastifyInstance } from "fastify";

export async function healthRoute(app: FastifyInstance) {
  app.get(
    "/health",
    {
      schema: {
        description: "Basic liveness check for the API process.",
        tags: ["health"],
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ok"] },
            },
            required: ["status"],
          },
        },
      },
    },
    async () => {
      return { status: "ok" as const };
    },
  );
}
