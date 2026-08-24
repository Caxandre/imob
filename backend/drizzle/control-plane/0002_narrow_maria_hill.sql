ALTER TABLE "database_clusters" ADD COLUMN "host" text NOT NULL;--> statement-breakpoint
ALTER TABLE "database_clusters" ADD COLUMN "port" integer DEFAULT 5432 NOT NULL;--> statement-breakpoint
ALTER TABLE "database_clusters" ADD CONSTRAINT "database_clusters_port_valid" CHECK ("database_clusters"."port" > 0 AND "database_clusters"."port" <= 65535);