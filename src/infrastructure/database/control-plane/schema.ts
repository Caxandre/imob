import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const tenantStatus = pgEnum("tenant_status", [
  "PROVISIONING",
  "READY",
  "FAILED",
  "SUSPENDED",
]);

export const databaseClusterStatus = pgEnum("database_cluster_status", ["ACTIVE", "INACTIVE"]);

export const tenantDatabaseStatus = pgEnum("tenant_database_status", [
  "PROVISIONING",
  "READY",
  "FAILED",
]);

export const provisioningJobType = pgEnum("provisioning_job_type", ["CREATE_DATABASE"]);

export const provisioningJobStatus = pgEnum("provisioning_job_status", [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
]);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  status: tenantStatus("status").notNull().default("PROVISIONING"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const databaseClusters = pgTable("database_clusters", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  // Free-form string rather than an enum: new providers must not require a migration.
  provider: text("provider").notNull(),
  region: text("region").notNull(),
  status: databaseClusterStatus("status").notNull().default("ACTIVE"),
  // Pointer to where credentials are stored, never the credentials themselves.
  secretReference: text("secret_reference").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tenantDatabases = pgTable(
  "tenant_databases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Unique: a tenant owns exactly one database in the current architecture.
    tenantId: uuid("tenant_id")
      .notNull()
      .unique()
      .references(() => tenants.id, { onDelete: "restrict", onUpdate: "restrict" }),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => databaseClusters.id, { onDelete: "restrict", onUpdate: "restrict" }),
    databaseName: text("database_name").notNull(),
    // Pointer to where credentials are stored, never the credentials themselves.
    secretReference: text("secret_reference").notNull(),
    schemaVersion: integer("schema_version").notNull().default(0),
    status: tenantDatabaseStatus("status").notNull().default("PROVISIONING"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Database names only need to be unique within their own cluster.
    unique("tenant_databases_cluster_id_database_name_unique").on(t.clusterId, t.databaseName),
    check("tenant_databases_schema_version_non_negative", sql`${t.schemaVersion} >= 0`),
  ],
);

export const provisioningJobs = pgTable(
  "provisioning_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict", onUpdate: "restrict" }),
    type: provisioningJobType("type").notNull(),
    status: provisioningJobStatus("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    // Free-form step label; the set of steps is expected to change, so no enum yet.
    currentStep: text("current_step"),
    // Short failure summary only — never a full stack trace.
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Jobs are expected to be listed per tenant; the FK column is not indexed automatically.
    index("provisioning_jobs_tenant_id_idx").on(t.tenantId),
    check("provisioning_jobs_attempts_non_negative", sql`${t.attempts} >= 0`),
  ],
);
