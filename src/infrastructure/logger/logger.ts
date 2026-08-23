import type { LoggerOptions } from "pino";

import { env } from "../../config/env.js";

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.password",
  "*.token",
  "*.secret",
  "*.connectionString",
  "*.databaseUrl",
];

// Shared by Fastify's built-in request logger and future standalone worker loggers.
export function createLoggerOptions(): LoggerOptions {
  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
  };

  if (env.NODE_ENV === "development") {
    options.transport = { target: "pino-pretty", options: { colorize: true } };
  }

  return options;
}
