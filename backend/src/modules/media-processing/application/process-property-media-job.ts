import type { ObjectStorage } from "../../../infrastructure/object-storage/object-storage.js";
import { ObjectStorageObjectNotFoundError } from "../../../infrastructure/object-storage/object-storage.js";
import type { PropertyMediaVariantName } from "../../properties/domain/property-media-variant.js";
import { UnsupportedPropertyMediaError } from "../domain/property-media-processing-error.js";
import type { ImageVariantProcessor } from "./image-variant-processor.js";
import type { PropertyMediaProcessingRepository } from "./property-media-processing-repository.js";

export interface ProcessPropertyMediaJobInput {
  outboxEventId: string;
  tenantId: string;
  propertyId: string;
  mediaId: string;
}

/**
 * - `ready`: variants generated, uploaded, and persisted; media is now `READY`.
 * - `failed-permanent`: the original could not be processed (missing from R2, undecodable,
 *   exceeds the pixel limit, animated/multi-page) — media is now `FAILED`, outbox processed.
 * - `already-processed`: a BullMQ replay of an already-completed job — no-op.
 * - `obsolete`: the media was deleted before or during processing — outbox marked processed,
 *   any variants already uploaded for it are cleaned up best-effort; never treated as an error.
 */
export type ProcessPropertyMediaJobOutcome =
  | { outcome: "ready" }
  | { outcome: "failed-permanent" }
  | { outcome: "already-processed" }
  | { outcome: "obsolete" };

export interface BuildPropertyMediaVariantObjectKeyInput {
  tenantId: string;
  propertyId: string;
  mediaId: string;
  variant: PropertyMediaVariantName;
}

export type BuildPropertyMediaVariantObjectKey = (input: BuildPropertyMediaVariantObjectKeyInput) => string;

export interface ProcessPropertyMediaJobDependencies {
  repository: PropertyMediaProcessingRepository;
  objectStorage: ObjectStorage;
  imageVariantProcessor: ImageVariantProcessor;
  buildVariantObjectKey: BuildPropertyMediaVariantObjectKey;
}

/**
 * Pure orchestration for one `process-property-media` job (Prompt 032, ADR-008) — BullMQ-
 * agnostic (this task, section 6/29): never imports `bullmq`, never sees a `Job`, never decides
 * retry policy. Anything it throws that isn't caught below (R2 unreachable, a transient
 * PostgreSQL error, ...) is a *transient* failure by construction — the infrastructure-layer
 * worker (`bullmq-media-processing-worker.ts`) is the only place that decides what a thrown
 * error means for BullMQ retry/backoff/exhaustion.
 *
 * Flow (section 45): load + validate context → download original → generate variants → upload
 * each variant (sequentially, section 47 — avoids three concurrent CPU/memory-heavy transforms
 * and uploads at once) → one atomic finalize transaction. No PostgreSQL transaction is ever held
 * open across the R2 read/`sharp`/R2 writes in between (section 46) — `loadContext` and
 * `finalizeReady`/`finalizeFailed` are separate, short calls.
 */
export async function processPropertyMediaJob(
  deps: ProcessPropertyMediaJobDependencies,
  input: ProcessPropertyMediaJobInput,
): Promise<ProcessPropertyMediaJobOutcome> {
  const loaded = await deps.repository.loadContext({
    outboxEventId: input.outboxEventId,
    propertyId: input.propertyId,
    mediaId: input.mediaId,
  });

  if (loaded.outcome === "already-processed") {
    return { outcome: "already-processed" };
  }
  if (loaded.outcome === "media-missing") {
    await deps.repository.markObsoleteProcessed(input.outboxEventId);
    return { outcome: "obsolete" };
  }
  if (loaded.outcome === "invalid-event") {
    // Permanent and safe (section 39/44) — never a reason to retry a linkage that can never
    // become valid on its own.
    await deps.repository.finalizeFailed({ outboxEventId: input.outboxEventId, mediaId: input.mediaId });
    return { outcome: "failed-permanent" };
  }

  const { context } = loaded;

  let original;
  try {
    original = await deps.objectStorage.getObject(context.objectKey);
  } catch (error) {
    if (error instanceof ObjectStorageObjectNotFoundError) {
      const result = await deps.repository.finalizeFailed({
        outboxEventId: input.outboxEventId,
        mediaId: input.mediaId,
      });
      return result === "media-missing" ? { outcome: "obsolete" } : { outcome: "failed-permanent" };
    }
    throw error; // R2 unreachable, network error, ... — transient, let BullMQ retry.
  }

  let variants;
  try {
    variants = await deps.imageVariantProcessor.process(original.body);
  } catch (error) {
    if (error instanceof UnsupportedPropertyMediaError) {
      const result = await deps.repository.finalizeFailed({
        outboxEventId: input.outboxEventId,
        mediaId: input.mediaId,
      });
      return result === "media-missing" ? { outcome: "obsolete" } : { outcome: "failed-permanent" };
    }
    throw error;
  }

  // Sequential, not Promise.all (section 47) — deliberately avoids three concurrent
  // encode+upload operations peaking CPU/memory/bandwidth at once for one job.
  const uploadedVariants = [];
  for (const variant of variants) {
    const objectKey = deps.buildVariantObjectKey({
      tenantId: input.tenantId,
      propertyId: context.propertyId,
      mediaId: input.mediaId,
      variant: variant.variant,
    });
    // Deterministic key (section 24/48) — a retry re-uploads to the exact same key, converging
    // rather than accumulating orphans.
    const stored = await deps.objectStorage.putObject({
      key: objectKey,
      body: variant.body,
      contentType: variant.mimeType,
      contentLength: variant.sizeBytes,
    });
    uploadedVariants.push({
      variant: variant.variant,
      objectKey: stored.key,
      publicUrl: stored.publicUrl,
      mimeType: variant.mimeType,
      width: variant.width,
      height: variant.height,
      sizeBytes: variant.sizeBytes,
    });
  }

  const finalizeResult = await deps.repository.finalizeReady({
    outboxEventId: input.outboxEventId,
    mediaId: input.mediaId,
    variants: uploadedVariants,
  });

  if (finalizeResult === "media-missing") {
    // The media was deleted between loadContext() and this point (section 62/63) — best-effort
    // cleanup of the variants just uploaded; never restores the media, never treated as an
    // error even if a delete fails here (same ADR-007 "orphan is preferable" reasoning).
    for (const uploaded of uploadedVariants) {
      await deps.objectStorage.deleteObject(uploaded.objectKey).catch(() => undefined);
    }
    return { outcome: "obsolete" };
  }

  return { outcome: "ready" };
}
