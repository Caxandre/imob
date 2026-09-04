import { z } from "zod";

// Mirrors `UUID_PATTERN` in `modules/properties/http/property-request.schema.ts` manually —
// deliberately not imported cross-module (this task, section 4: reuses the existing Zod
// convention, not the properties module's own file) — the same small, low-risk duplication
// already used elsewhere in this codebase for enum-shaped/pattern constants.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const tenantIdParamsSchema = z.object({
  id: z.string().trim().regex(UUID_PATTERN, "id must be a valid UUID"),
});

export type TenantIdParams = z.infer<typeof tenantIdParamsSchema>;
