CREATE TYPE "public"."property_status" AS ENUM('DRAFT', 'ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."property_type" AS ENUM('HOUSE', 'APARTMENT', 'LAND', 'COMMERCIAL', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('SALE', 'RENT');--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"property_type" "property_type" NOT NULL,
	"transaction_type" "transaction_type" NOT NULL,
	"status" "property_status" DEFAULT 'DRAFT' NOT NULL,
	"price" numeric(15, 2) NOT NULL,
	"bedrooms" integer,
	"bathrooms" integer,
	"parking_spaces" integer,
	"area_m2" numeric(10, 2),
	"street" text,
	"number" text,
	"complement" text,
	"neighborhood" text,
	"city" text,
	"state" varchar(2),
	"postal_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "properties_price_positive" CHECK ("properties"."price" > 0),
	CONSTRAINT "properties_bedrooms_non_negative" CHECK ("properties"."bedrooms" IS NULL OR "properties"."bedrooms" >= 0),
	CONSTRAINT "properties_bathrooms_non_negative" CHECK ("properties"."bathrooms" IS NULL OR "properties"."bathrooms" >= 0),
	CONSTRAINT "properties_parking_spaces_non_negative" CHECK ("properties"."parking_spaces" IS NULL OR "properties"."parking_spaces" >= 0),
	CONSTRAINT "properties_area_m2_positive" CHECK ("properties"."area_m2" IS NULL OR "properties"."area_m2" > 0)
);
--> statement-breakpoint
CREATE INDEX "properties_created_at_id_idx" ON "properties" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);