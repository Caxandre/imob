ALTER TABLE "outbox_events" ADD COLUMN "dispatch_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "dispatch_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "dispatch_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "dispatch_error" text;--> statement-breakpoint
CREATE INDEX "outbox_events_pending_dispatch_idx" ON "outbox_events" USING btree ("created_at","id") WHERE "outbox_events"."processed_at" IS NULL AND "outbox_events"."dispatched_at" IS NULL AND "outbox_events"."dispatch_failed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_dispatch_lease_requires_claim" CHECK ("outbox_events"."dispatch_lease_until" IS NULL OR "outbox_events"."dispatch_claimed_at" IS NOT NULL);