import { buildApp } from "../app/build-app.js";
import { env } from "../config/env.js";

const app = buildApp();

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
