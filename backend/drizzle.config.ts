import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/infrastructure/database/control-plane/schema.ts",
  out: "./drizzle/control-plane",
  dbCredentials: {
    url: process.env.CONTROL_PLANE_DATABASE_URL ?? "",
  },
});
