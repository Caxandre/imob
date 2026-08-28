CREATE TYPE "public"."media_processing_status" AS ENUM('PROCESSING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."property_media_variant" AS ENUM('THUMBNAIL', 'CARD', 'DETAIL');--> statement-breakpoint
CREATE TABLE "property_media_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_media_id" uuid NOT NULL,
	"variant" "property_media_variant" NOT NULL,
	"object_key" text NOT NULL,
	"public_url" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_media_variants_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "property_media_variants_media_id_variant_key" UNIQUE("property_media_id","variant"),
	CONSTRAINT "property_media_variants_width_positive" CHECK ("property_media_variants"."width" > 0),
	CONSTRAINT "property_media_variants_height_positive" CHECK ("property_media_variants"."height" > 0),
	CONSTRAINT "property_media_variants_size_bytes_positive" CHECK ("property_media_variants"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "property_media" ADD COLUMN "processing_status" "media_processing_status" DEFAULT 'READY' NOT NULL;--> statement-breakpoint
ALTER TABLE "property_media_variants" ADD CONSTRAINT "property_media_variants_property_media_id_property_media_id_fk" FOREIGN KEY ("property_media_id") REFERENCES "public"."property_media"("id") ON DELETE cascade ON UPDATE restrict;