import { describe, expect, it } from "vitest";

import { ObjectStorageObjectNotFoundError, type GetObjectResult, type ObjectStorage, type PutObjectInput, type StoredObject } from "../../../infrastructure/object-storage/object-storage.js";
import { UnsupportedPropertyMediaError } from "../domain/property-media-processing-error.js";
import type { ImageVariantProcessor, ProcessedImageVariant } from "./image-variant-processor.js";
import { processPropertyMediaJob, type BuildPropertyMediaVariantObjectKey } from "./process-property-media-job.js";
import type {
  FinalizePropertyMediaResult,
  LoadPropertyMediaProcessingContextResult,
  PropertyMediaProcessingRepository,
  UploadedPropertyMediaVariant,
} from "./property-media-processing-repository.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OUTBOX_EVENT_ID = "22222222-2222-4222-8222-222222222222";
const PROPERTY_ID = "33333333-3333-4333-8333-333333333333";
const MEDIA_ID = "44444444-4444-4444-8444-444444444444";

const JOB_INPUT = { outboxEventId: OUTBOX_EVENT_ID, tenantId: TENANT_ID, propertyId: PROPERTY_ID, mediaId: MEDIA_ID };

const READY_CONTEXT: LoadPropertyMediaProcessingContextResult = {
  outcome: "ready",
  context: { mediaId: MEDIA_ID, propertyId: PROPERTY_ID, objectKey: `tenants/t/properties/p/${MEDIA_ID}.jpg`, mimeType: "image/jpeg" },
};

function fakeRepository(overrides: Partial<PropertyMediaProcessingRepository> = {}): PropertyMediaProcessingRepository {
  return {
    loadContext: async () => READY_CONTEXT,
    markObsoleteProcessed: async () => undefined,
    finalizeReady: async () => "finalized",
    finalizeFailed: async () => "finalized",
    ...overrides,
  };
}

function fakeObjectStorage(overrides: Partial<ObjectStorage> = {}): ObjectStorage {
  return {
    putObject: async (input: PutObjectInput): Promise<StoredObject> => ({
      key: input.key,
      publicUrl: `https://public-base.example/${input.key}`,
    }),
    getObject: async (): Promise<GetObjectResult> => ({ body: Buffer.from("fake-image-bytes"), contentType: "image/jpeg" }),
    deleteObject: async () => undefined,
    ...overrides,
  };
}

const SAMPLE_VARIANTS: ProcessedImageVariant[] = [
  { variant: "THUMBNAIL", body: Buffer.from("t"), mimeType: "image/webp", width: 320, height: 240, sizeBytes: 1 },
  { variant: "CARD", body: Buffer.from("c"), mimeType: "image/webp", width: 640, height: 480, sizeBytes: 1 },
  { variant: "DETAIL", body: Buffer.from("d"), mimeType: "image/webp", width: 1280, height: 960, sizeBytes: 1 },
];

function fakeImageVariantProcessor(overrides: Partial<ImageVariantProcessor> = {}): ImageVariantProcessor {
  return {
    process: async () => SAMPLE_VARIANTS,
    ...overrides,
  };
}

const buildVariantObjectKey: BuildPropertyMediaVariantObjectKey = (input) =>
  `tenants/${input.tenantId}/properties/${input.propertyId}/${input.mediaId}/${input.variant.toLowerCase()}.webp`;

describe("processPropertyMediaJob", () => {
  it("happy path: downloads the original, generates variants, uploads each, and finalizes READY", async () => {
    const putCalls: PutObjectInput[] = [];
    const finalizeCalls: { outboxEventId: string; mediaId: string; variants: UploadedPropertyMediaVariant[] }[] = [];
    const deps = {
      repository: fakeRepository({
        finalizeReady: async (input): Promise<FinalizePropertyMediaResult> => {
          finalizeCalls.push(input);
          return "finalized";
        },
      }),
      objectStorage: fakeObjectStorage({
        putObject: async (input) => {
          putCalls.push(input);
          return { key: input.key, publicUrl: `https://public-base.example/${input.key}` };
        },
      }),
      imageVariantProcessor: fakeImageVariantProcessor(),
      buildVariantObjectKey,
    };

    const outcome = await processPropertyMediaJob(deps, JOB_INPUT);

    expect(outcome).toEqual({ outcome: "ready" });
    expect(putCalls).toHaveLength(3);
    expect(putCalls.map((c) => c.key).sort()).toEqual(
      [
        `tenants/${TENANT_ID}/properties/${PROPERTY_ID}/${MEDIA_ID}/thumbnail.webp`,
        `tenants/${TENANT_ID}/properties/${PROPERTY_ID}/${MEDIA_ID}/card.webp`,
        `tenants/${TENANT_ID}/properties/${PROPERTY_ID}/${MEDIA_ID}/detail.webp`,
      ].sort(),
    );
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0]?.variants).toHaveLength(3);
  });

  it("already-processed: returns immediately, never touches ObjectStorage or the image processor", async () => {
    const getCalls: string[] = [];
    const processCalls: Buffer[] = [];
    const deps = {
      repository: fakeRepository({ loadContext: async () => ({ outcome: "already-processed" as const }) }),
      objectStorage: fakeObjectStorage({
        getObject: async (key) => {
          getCalls.push(key);
          return { body: Buffer.from("x") };
        },
      }),
      imageVariantProcessor: fakeImageVariantProcessor({
        process: async (input) => {
          processCalls.push(input);
          return SAMPLE_VARIANTS;
        },
      }),
      buildVariantObjectKey,
    };

    const outcome = await processPropertyMediaJob(deps, JOB_INPUT);

    expect(outcome).toEqual({ outcome: "already-processed" });
    expect(getCalls).toHaveLength(0);
    expect(processCalls).toHaveLength(0);
  });

  it("media-missing at load: marks the outbox obsolete-processed, never touches ObjectStorage", async () => {
    const obsoleteCalls: string[] = [];
    const getCalls: string[] = [];
    const deps = {
      repository: fakeRepository({
        loadContext: async () => ({ outcome: "media-missing" as const }),
        markObsoleteProcessed: async (id) => {
          obsoleteCalls.push(id);
        },
      }),
      objectStorage: fakeObjectStorage({
        getObject: async (key) => {
          getCalls.push(key);
          return { body: Buffer.from("x") };
        },
      }),
      imageVariantProcessor: fakeImageVariantProcessor(),
      buildVariantObjectKey,
    };

    const outcome = await processPropertyMediaJob(deps, JOB_INPUT);

    expect(outcome).toEqual({ outcome: "obsolete" });
    expect(obsoleteCalls).toEqual([OUTBOX_EVENT_ID]);
    expect(getCalls).toHaveLength(0);
  });

  it("invalid-event: finalizes FAILED (permanent), never touches ObjectStorage", async () => {
    const finalizeFailedCalls: { outboxEventId: string; mediaId: string }[] = [];
    const getCalls: string[] = [];
    const deps = {
      repository: fakeRepository({
        loadContext: async () => ({ outcome: "invalid-event" as const }),
        finalizeFailed: async (input): Promise<FinalizePropertyMediaResult> => {
          finalizeFailedCalls.push(input);
          return "finalized";
        },
      }),
      objectStorage: fakeObjectStorage({
        getObject: async (key) => {
          getCalls.push(key);
          return { body: Buffer.from("x") };
        },
      }),
      imageVariantProcessor: fakeImageVariantProcessor(),
      buildVariantObjectKey,
    };

    const outcome = await processPropertyMediaJob(deps, JOB_INPUT);

    expect(outcome).toEqual({ outcome: "failed-permanent" });
    expect(finalizeFailedCalls).toEqual([{ outboxEventId: OUTBOX_EVENT_ID, mediaId: MEDIA_ID }]);
    expect(getCalls).toHaveLength(0);
  });

  it("original missing from R2 (ObjectStorageObjectNotFoundError): finalizes FAILED (permanent), never calls the image processor", async () => {
    const processCalls: Buffer[] = [];
    const deps = {
      repository: fakeRepository(),
      objectStorage: fakeObjectStorage({
        getObject: async () => {
          throw new ObjectStorageObjectNotFoundError("some-key");
        },
      }),
      imageVariantProcessor: fakeImageVariantProcessor({
        process: async (input) => {
          processCalls.push(input);
          return SAMPLE_VARIANTS;
        },
      }),
      buildVariantObjectKey,
    };

    const outcome = await processPropertyMediaJob(deps, JOB_INPUT);

    expect(outcome).toEqual({ outcome: "failed-permanent" });
    expect(processCalls).toHaveLength(0);
  });

  it("a transient ObjectStorage failure (not NotFound) propagates unchanged — never finalized", async () => {
    const finalizeCalled: unknown[] = [];
    const transientError = new Error("R2 unreachable");
    const deps = {
      repository: fakeRepository({
        finalizeFailed: async (input) => {
          finalizeCalled.push(input);
          return "finalized" as const;
        },
      }),
      objectStorage: fakeObjectStorage({
        getObject: async () => {
          throw transientError;
        },
      }),
      imageVariantProcessor: fakeImageVariantProcessor(),
      buildVariantObjectKey,
    };

    await expect(processPropertyMediaJob(deps, JOB_INPUT)).rejects.toBe(transientError);
    expect(finalizeCalled).toHaveLength(0);
  });

  it("UnsupportedPropertyMediaError from the image processor: finalizes FAILED (permanent), never uploads any variant", async () => {
    const putCalls: PutObjectInput[] = [];
    const deps = {
      repository: fakeRepository(),
      objectStorage: fakeObjectStorage({
        putObject: async (input) => {
          putCalls.push(input);
          return { key: input.key, publicUrl: "unused" };
        },
      }),
      imageVariantProcessor: fakeImageVariantProcessor({
        process: async () => {
          throw new UnsupportedPropertyMediaError("could not decode image");
        },
      }),
      buildVariantObjectKey,
    };

    const outcome = await processPropertyMediaJob(deps, JOB_INPUT);

    expect(outcome).toEqual({ outcome: "failed-permanent" });
    expect(putCalls).toHaveLength(0);
  });

  it("a non-classified image processor failure propagates unchanged — never finalized", async () => {
    const finalizeCalled: unknown[] = [];
    const bug = new Error("unexpected bug in processor");
    const deps = {
      repository: fakeRepository({
        finalizeFailed: async (input) => {
          finalizeCalled.push(input);
          return "finalized" as const;
        },
      }),
      objectStorage: fakeObjectStorage(),
      imageVariantProcessor: fakeImageVariantProcessor({
        process: async () => {
          throw bug;
        },
      }),
      buildVariantObjectKey,
    };

    await expect(processPropertyMediaJob(deps, JOB_INPUT)).rejects.toBe(bug);
    expect(finalizeCalled).toHaveLength(0);
  });

  it("media deleted right before finalize (media-missing at finalizeReady): best-effort deletes the just-uploaded variants and reports obsolete", async () => {
    const deleteCalls: string[] = [];
    const deps = {
      repository: fakeRepository({
        finalizeReady: async (): Promise<FinalizePropertyMediaResult> => "media-missing",
      }),
      objectStorage: fakeObjectStorage({
        deleteObject: async (key) => {
          deleteCalls.push(key);
        },
      }),
      imageVariantProcessor: fakeImageVariantProcessor(),
      buildVariantObjectKey,
    };

    const outcome = await processPropertyMediaJob(deps, JOB_INPUT);

    expect(outcome).toEqual({ outcome: "obsolete" });
    expect(deleteCalls.sort()).toEqual(
      [
        `tenants/${TENANT_ID}/properties/${PROPERTY_ID}/${MEDIA_ID}/thumbnail.webp`,
        `tenants/${TENANT_ID}/properties/${PROPERTY_ID}/${MEDIA_ID}/card.webp`,
        `tenants/${TENANT_ID}/properties/${PROPERTY_ID}/${MEDIA_ID}/detail.webp`,
      ].sort(),
    );
  });

  it("media deleted right before finalize: a cleanup delete failure is swallowed, still reports obsolete", async () => {
    const deps = {
      repository: fakeRepository({
        finalizeReady: async (): Promise<FinalizePropertyMediaResult> => "media-missing",
      }),
      objectStorage: fakeObjectStorage({
        deleteObject: async () => {
          throw new Error("R2 unreachable during cleanup");
        },
      }),
      imageVariantProcessor: fakeImageVariantProcessor(),
      buildVariantObjectKey,
    };

    await expect(processPropertyMediaJob(deps, JOB_INPUT)).resolves.toEqual({ outcome: "obsolete" });
  });

  it("original missing from R2, but the media was also deleted concurrently: finalizeFailed reports media-missing → outcome obsolete", async () => {
    const deps = {
      repository: fakeRepository({
        finalizeFailed: async (): Promise<FinalizePropertyMediaResult> => "media-missing",
      }),
      objectStorage: fakeObjectStorage({
        getObject: async () => {
          throw new ObjectStorageObjectNotFoundError("some-key");
        },
      }),
      imageVariantProcessor: fakeImageVariantProcessor(),
      buildVariantObjectKey,
    };

    await expect(processPropertyMediaJob(deps, JOB_INPUT)).resolves.toEqual({ outcome: "obsolete" });
  });

  it("uploads variants sequentially, one at a time — never more than one in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const deps = {
      repository: fakeRepository(),
      objectStorage: fakeObjectStorage({
        putObject: async (input) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return { key: input.key, publicUrl: `https://public-base.example/${input.key}` };
        },
      }),
      imageVariantProcessor: fakeImageVariantProcessor(),
      buildVariantObjectKey,
    };

    await processPropertyMediaJob(deps, JOB_INPUT);

    expect(maxInFlight).toBe(1);
  });
});
