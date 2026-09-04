import { z } from "zod";

/**
 * The only module in this codebase allowed to read `import.meta.env` directly (this task,
 * sections 29/30) — enforced by `eslint.config.js`'s `no-restricted-syntax` rule, scoped off
 * only for this file. Every other module imports the already-validated `env` export below,
 * never Vite's raw env object.
 */
const envSchema = z.object({
  VITE_API_URL: z.url("VITE_API_URL must be a valid URL"),
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
} as const;
