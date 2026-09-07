import { z } from "zod";

/**
 * The only module in this codebase allowed to read `import.meta.env` directly (this task,
 * sections 29/30) — enforced by `eslint.config.js`'s `no-restricted-syntax` rule, scoped off
 * only for this file. Every other module imports the already-validated `env` export below,
 * never Vite's raw env object.
 */
const envSchema = z.object({
  VITE_API_URL: z.url("VITE_API_URL must be a valid URL"),
  // Optional (Prompt 037B, sections 8-10): only Tenant Data Plane features (Properties) need a
  // tenant to call the API — the app must still boot without it (e.g. to render the Home page).
  // An empty string (unset in `.env`) is treated the same as "absent", never as an invalid UUID.
  VITE_TENANT_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.uuid("VITE_TENANT_ID must be a valid UUID").optional(),
  ),
});

function loadEnv() {
  const parsed = envSchema.safeParse(import.meta.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    // Fails fast at module load — same philosophy as the backend's own env parsing (CLAUDE.md):
    // an invalid/missing configuration must never silently fall back to a guessed default.
    throw new Error(`Invalid frontend environment configuration: ${details}`);
  }

  return parsed.data;
}

const parsedEnv = loadEnv();

export const env = {
  apiUrl: parsedEnv.VITE_API_URL,
  tenantId: parsedEnv.VITE_TENANT_ID,
} as const;

/**
 * Explicit accessor (Prompt 037B, section 10) for features that require Tenant Data Plane
 * access — throws instead of silently proceeding with `undefined`. Callers that need to render a
 * dedicated "tenant not configured" state (e.g. `PropertiesPage`) should check `env.tenantId`
 * directly instead of catching this; this function is for API-layer code that must never run
 * without a tenant.
 */
export function requireTenantId(): string {
  if (env.tenantId === undefined) {
    throw new Error(
      "VITE_TENANT_ID is not configured — required for Tenant Data Plane features (see .env.example).",
    );
  }

  return env.tenantId;
}
