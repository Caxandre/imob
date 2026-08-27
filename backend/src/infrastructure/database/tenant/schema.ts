import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Tenant Data Plane schema (ADR-001/ADR-003). Applied once per tenant database, never shared
 * — every table here belongs to exactly one tenant by virtue of living in that tenant's own
 * physical database. None of these tables carry a `tenant_id` column: the database itself is
 * the isolation boundary, so a tenant discriminator column would be redundant and would
 * reintroduce the exact shared-table risk ADR-001 rejected. Never imports Control Plane
 * tables — the two schemas are deliberately kept unaware of each other.
 */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Nullable: not every audited action has an authenticated actor (e.g. a system/background
  // job). No cascade delete — deleting a user must never delete their audit trail; the
  // reference is cleared instead so the log entry survives.
  actorUserId: uuid("actor_user_id").references(() => users.id, {
    onDelete: "set null",
    onUpdate: "restrict",
  }),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  // No foreign key: entityType varies per row, so there is no single target table to
  // reference.
  entityId: uuid("entity_id"),
  // No universal metadata shape defined yet — left schemaless on purpose.
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  // The business moment the event happened — distinct from createdAt (row insertion time),
  // and always supplied by the caller rather than defaulted, since backfilled/replayed
  // events legitimately have an occurredAt in the past.
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  // Set by the future outbox publisher (not implemented here) once the event is relayed.
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
