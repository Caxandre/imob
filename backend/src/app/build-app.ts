import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastify, { type FastifyError, type FastifyInstance } from "fastify";

import { createLoggerOptions } from "../infrastructure/logger/logger.js";
import { healthRoute } from "./routes/health.route.js";

export function buildApp(): FastifyInstance {
  const app = fastify({
    logger: createLoggerOptions(),
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    request.log.error({ err: error }, "request failed");

    if (statusCode < 500) {
      reply.status(statusCode).send({
        statusCode,
        error: error.name,
        message: error.message,
      });
      return;
    }

    reply.status(500).send({
      statusCode: 500,
      error: "Internal Server Error",
      message: "An unexpected error occurred",
    });
  });

  void app.register(swagger, {
    openapi: {
      info: {
        title: "Imob Backend API",
        version: "0.1.0",
      },
    },
  });

  void app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  void app.register(healthRoute);

  return app;
}
