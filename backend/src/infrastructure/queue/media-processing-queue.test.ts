import { describe, expect, it } from "vitest";

import {
  MEDIA_PROCESSING_QUEUE_NAME,
  PROCESS_PROPERTY_MEDIA_JOB_NAME,
  processPropertyMediaJobPayloadSchema,
} from "./media-processing-queue.js";

const VALID_ID = "11111111-1111-4111-8111-111111111111";

describe("media processing queue contract", () => {
  it("uses a queue name distinct from tenant-provisioning", () => {
    expect(MEDIA_PROCESSING_QUEUE_NAME).toBe("media-processing");
  });

  it("uses the documented job name", () => {
    expect(PROCESS_PROPERTY_MEDIA_JOB_NAME).toBe("process-property-media");
  });
});

describe("processPropertyMediaJobPayloadSchema", () => {
  it("accepts a payload with only tenantId/propertyId/mediaId, all valid UUIDs", () => {
    const result = processPropertyMediaJobPayloadSchema.safeParse({
      tenantId: VALID_ID,
      propertyId: VALID_ID,
      mediaId: VALID_ID,
    });

    expect(result.success).toBe(true);
  });

  it.each(["tenantId", "propertyId", "mediaId"])("rejects a missing %s", (missingField) => {
    const payload: Record<string, string> = { tenantId: VALID_ID, propertyId: VALID_ID, mediaId: VALID_ID };
    delete payload[missingField];

    expect(processPropertyMediaJobPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects a non-UUID field", () => {
    const result = processPropertyMediaJobPayloadSchema.safeParse({
      tenantId: "not-a-uuid",
      propertyId: VALID_ID,
      mediaId: VALID_ID,
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unknown extra field — e.g. an accidental credential/public_url", () => {
    const result = processPropertyMediaJobPayloadSchema.safeParse({
      tenantId: VALID_ID,
      propertyId: VALID_ID,
      mediaId: VALID_ID,
      publicUrl: "https://example.com/leaked",
    });

    expect(result.success).toBe(false);
  });
});
