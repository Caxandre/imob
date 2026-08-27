import { defineConfig } from "drizzle-kit";

// Separate from drizzle.config.ts (Control Plane) on purpose — the Tenant Data Plane has its
// own schema and its own migrations directory, never generated or applied together with the
// Control Plane's. dbCredentials is unused by `generate` (no real database connection is
// needed to diff the schema against the existing snapshots) — kept only for parity with the
// Control Plane config and any future `push`/`studio` use.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/infrastructure/database/tenant/schema.ts",
  out: "./drizzle/tenant",
  dbCredentials: {
    url: process.env.TENANT_MIGRATION_DATABASE_URL ?? "",
  },
});
