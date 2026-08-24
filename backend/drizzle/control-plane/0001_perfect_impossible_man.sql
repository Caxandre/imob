ALTER TABLE "provisioning_jobs" ADD COLUMN "dispatch_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provisioning_jobs" ADD COLUMN "dispatch_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provisioning_jobs" ADD COLUMN "dispatched_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "provisioning_jobs_pending_dispatch_idx" ON "provisioning_jobs" USING btree ("created_at") WHERE "provisioning_jobs"."status" = 'PENDING' AND "provisioning_jobs"."dispatched_at" IS NULL;--> statement-breakpoint
ALTER TABLE "provisioning_jobs" ADD CONSTRAINT "provisioning_jobs_dispatch_lease_requires_claim" CHECK ("provisioning_jobs"."dispatch_lease_until" IS NULL OR "provisioning_jobs"."dispatch_claimed_at" IS NOT NULL);