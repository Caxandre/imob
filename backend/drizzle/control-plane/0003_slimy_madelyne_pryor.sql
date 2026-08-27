ALTER TABLE "provisioning_jobs" ADD COLUMN "execution_token" uuid;--> statement-breakpoint
ALTER TABLE "provisioning_jobs" ADD COLUMN "execution_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provisioning_jobs" ADD COLUMN "execution_lease_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "provisioning_jobs_running_execution_lease_idx" ON "provisioning_jobs" USING btree ("execution_lease_until") WHERE "provisioning_jobs"."status" = 'RUNNING';--> statement-breakpoint
ALTER TABLE "provisioning_jobs" ADD CONSTRAINT "provisioning_jobs_execution_lease_requires_token" CHECK ("provisioning_jobs"."execution_lease_until" IS NULL OR "provisioning_jobs"."execution_token" IS NOT NULL);