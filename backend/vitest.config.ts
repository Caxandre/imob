import { defineConfig } from "vitest/config";

import { CONTROL_PLANE_TEST_DATABASE_URL } from "./test/control-plane-test-db.js";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    // Integration tests share one Control Plane test database, so they must not run
    // against it concurrently.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      CONTROL_PLANE_DATABASE_URL: CONTROL_PLANE_TEST_DATABASE_URL,
      REDIS_URL: "redis://localhost:6379",
    },
  },
});
