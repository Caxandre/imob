CREATE TABLE "property_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"public_url" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"original_filename" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_media_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "property_media_property_id_position_key" UNIQUE("property_id","position"),
	CONSTRAINT "property_media_position_non_negative" CHECK ("property_media"."position" >= 0),
	CONSTRAINT "property_media_size_bytes_positive" CHECK ("property_media"."size_bytes" > 0),
	CONSTRAINT "property_media_mime_type_allowed" CHECK ("property_media"."mime_type" IN ('image/jpeg', 'image/png', 'image/webp'))
);
--> statement-breakpoint
ALTER TABLE "property_media" ADD CONSTRAINT "property_media_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE restrict;