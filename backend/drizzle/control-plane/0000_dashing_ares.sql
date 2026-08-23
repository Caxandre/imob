CREATE TYPE "public"."database_cluster_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."provisioning_job_status" AS ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."provisioning_job_type" AS ENUM('CREATE_DATABASE');--> statement-breakpoint
CREATE TYPE "public"."tenant_database_status" AS ENUM('PROVISIONING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('PROVISIONING', 'READY', 'FAILED', 'SUSPENDED');--> statement-breakpoint
CREATE TABLE "database_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"region" text NOT NULL,
	"status" "database_cluster_status" DEFAULT 'ACTIVE' NOT NULL,
	"secret_reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_clusters_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "provisioning_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" "provisioning_job_type" NOT NULL,
	"status" "provisioning_job_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"current_step" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provisioning_jobs_attempts_non_negative" CHECK ("provisioning_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tenant_databases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"database_name" text NOT NULL,
	"secret_reference" text NOT NULL,
	"schema_version" integer DEFAULT 0 NOT NULL,
	"status" "tenant_database_status" DEFAULT 'PROVISIONING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_databases_tenant_id_unique" UNIQUE("tenant_id"),
	CONSTRAINT "tenant_databases_cluster_id_database_name_unique" UNIQUE("cluster_id","database_name"),
	CONSTRAINT "tenant_databases_schema_version_non_negative" CHECK ("tenant_databases"."schema_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "tenant_status" DEFAULT 'PROVISIONING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "provisioning_jobs" ADD CONSTRAINT "provisioning_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "tenant_databases" ADD CONSTRAINT "tenant_databases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "tenant_databases" ADD CONSTRAINT "tenant_databases_cluster_id_database_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."database_clusters"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "provisioning_jobs_tenant_id_idx" ON "provisioning_jobs" USING btree ("tenant_id");