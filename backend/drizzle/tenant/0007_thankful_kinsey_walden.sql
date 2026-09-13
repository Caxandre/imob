CREATE TYPE "public"."lead_source" AS ENUM('MANUAL', 'WEBSITE', 'WHATSAPP', 'PORTAL', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('NEW', 'CONTACTED', 'QUALIFIED', 'WON', 'LOST');--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"status" "lead_status" DEFAULT 'NEW' NOT NULL,
	"source" "lead_source" DEFAULT 'MANUAL' NOT NULL,
	"message" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_contact_channel_required" CHECK ("leads"."email" IS NOT NULL OR "leads"."phone" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "leads_created_at_id_idx" ON "leads" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "leads_source_idx" ON "leads" USING btree ("source");--> statement-breakpoint
CREATE INDEX "leads_property_id_idx" ON "leads" USING btree ("property_id");