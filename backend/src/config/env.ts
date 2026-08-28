import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    CONTROL_PLANE_DATABASE_URL: z
      .string()
      .url("CONTROL_PLANE_DATABASE_URL must be a valid PostgreSQL connection string"),
    REDIS_URL: z.string().url("REDIS_URL must be a valid Redis connection string"),

    // Provisioning dispatcher (ADR-002) — see src/workers/provisioning-dispatcher.ts.
    PROVISIONING_DISPATCH_BATCH_SIZE: z.coerce.number().int().positive().default(10),
    PROVISIONING_DISPATCH_LEASE_SECONDS: z.coerce.number().int().positive().default(30),
    PROVISIONING_DISPATCH_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),

    // Provisioning execution lease/recovery (ADR-003 "Recovery") — a completely separate
    // mechanism from the dispatch lease above, never sharing state with it (CLAUDE.md). See
    // src/workers/provisioning-worker.ts.
    PROVISIONING_EXECUTION_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
    PROVISIONING_EXECUTION_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(20_000),
    PROVISIONING_RECOVERY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
    PROVISIONING_RECOVERY_BATCH_SIZE: z.coerce.number().int().positive().default(10),

    // Tenant database cluster selection (ADR-003) — the ACTIVE database_clusters.name the
    // initial DatabaseClusterSelector implementation targets. No default: which cluster
    // tenants get provisioned into must always be an explicit choice, never an accident.
    TENANT_DATABASE_DEFAULT_CLUSTER: z
      .string()
      .min(1, "TENANT_DATABASE_DEFAULT_CLUSTER must name an ACTIVE database_clusters row"),

    // DEV-ONLY (Prompt 024): consumed exclusively by src/main/dev-full.ts, to idempotently
    // bootstrap the local database_clusters row (named TENANT_DATABASE_DEFAULT_CLUSTER) and
    // seed its admin credential into the in-memory SecretStore on startup. server.ts,
    // provisioning-worker.ts and provisioning-dispatcher.ts never read these — this changes
    // nothing about their behavior. Defaults match docker-compose.yml's postgres-tenants
    // service.
    DEV_BOOTSTRAP_CLUSTER_HOST: z.string().default("localhost"),
    DEV_BOOTSTRAP_CLUSTER_PORT: z.coerce.number().int().positive().default(5433),
    DEV_BOOTSTRAP_CLUSTER_ADMIN_USERNAME: z.string().default("postgres"),
    DEV_BOOTSTRAP_CLUSTER_ADMIN_PASSWORD: z.string().default("postgres"),

    // Cloudflare R2 (Prompt 026, ADR-006) — every field is optional here, deliberately: no
    // entrypoint that doesn't touch object storage should fail to start just because R2 isn't
    // configured yet (server.ts/provisioning-worker.ts/provisioning-dispatcher.ts never read
    // these today — no consumer is wired in this task). Presence is validated where the R2
    // adapter is actually constructed (`createCloudflareR2ObjectStorage`), which requires the
    // full set or throws `ObjectStorageConfigurationError` — never a partial config accepted
    // silently. Format IS still validated here for whatever is actually set, so a malformed
    // value fails fast at process startup rather than surfacing later as a confusing runtime
    // error from the R2 adapter.
    R2_ACCOUNT_ID: z.string().min(1, "R2_ACCOUNT_ID must be a non-empty string").optional(),
    R2_ACCESS_KEY_ID: z.string().min(1, "R2_ACCESS_KEY_ID must be a non-empty string").optional(),
    R2_SECRET_ACCESS_KEY: z.string().min(1, "R2_SECRET_ACCESS_KEY must be a non-empty string").optional(),
    R2_BUCKET: z.string().min(1, "R2_BUCKET must be a non-empty string").optional(),
    R2_PUBLIC_URL: z.string().url("R2_PUBLIC_URL must be a valid URL").optional(),
  })
  .refine(
    (data) =>
      data.PROVISIONING_EXECUTION_HEARTBEAT_INTERVAL_MS < data.PROVISIONING_EXECUTION_LEASE_SECONDS * 1000,
    {
      message:
        "PROVISIONING_EXECUTION_HEARTBEAT_INTERVAL_MS must be less than " +
        "PROVISIONING_EXECUTION_LEASE_SECONDS * 1000 — otherwise the lease can expire " +
        "before the first heartbeat renews it",
      path: ["PROVISIONING_EXECUTION_HEARTBEAT_INTERVAL_MS"],
    },
  );

function loadEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("Invalid environment configuration:");
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

export const env = loadEnv();

export type Env = typeof env;
