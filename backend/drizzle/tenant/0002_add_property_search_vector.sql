ALTER TABLE "properties" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (
          setweight(to_tsvector('portuguese', coalesce("properties"."title", '')), 'A') ||
          setweight(to_tsvector('portuguese', coalesce("properties"."neighborhood", '')), 'B') ||
          setweight(to_tsvector('portuguese', coalesce("properties"."city", '')), 'B') ||
          setweight(to_tsvector('portuguese', coalesce("properties"."street", '')), 'C') ||
          setweight(to_tsvector('portuguese', coalesce("properties"."description", '')), 'D')
        ) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "properties_search_vector_idx" ON "properties" USING gin ("search_vector");