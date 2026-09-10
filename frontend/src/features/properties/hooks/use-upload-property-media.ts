import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { uploadPropertyMedia } from "../api/upload-property-media";
import {
  describePropertyMediaFileValidationError,
  validatePropertyMediaFile,
} from "../lib/validate-property-media-file";
import { runWithConcurrency } from "../lib/run-with-concurrency";
import { propertyMediaQueryKeys } from "./use-property-media";
import { propertiesQueryKeys } from "./use-properties";

// Prompt 041, section 15 — bounded so selecting many files at once never fires unlimited
// parallel requests; not high enough to need a real queue library.
const MAX_CONCURRENT_UPLOADS = 3;

export type PropertyMediaUploadStatus = "pending" | "uploading" | "success" | "error";

export interface PropertyMediaUploadItem {
  id: string;
  file: File;
  status: PropertyMediaUploadStatus;
  errorMessage?: string;
}

let uploadItemSequence = 0;
function nextUploadItemId(): string {
  uploadItemSequence += 1;
  return `upload-${String(uploadItemSequence)}`;
}

/**
 * Prompt 041, sections 5/13-20/55-57: one request per file — the backend accepts exactly one
 * file per upload call, so multiple selected files are never batched into a single request.
 * Each file gets its own tracked status (`pending` → `uploading` → `success`/`error`), so a
 * 5-file batch with 1 failure is reported as 4 successes + 1 error, never "the batch failed" or
 * "the batch succeeded". This is a plain hook with local state rather than a single TanStack
 * `useMutation` — a mutation models one in-flight operation with one shared pending state, which
 * can't represent N independently-tracked concurrent uploads; cache invalidation (the part that
 * *is* TanStack Query's job) still happens per successful item below.
 */
export function useUploadPropertyMedia(tenantId: string, propertyId: string) {
  const queryClient = useQueryClient();
  const [items, setItems] = useState<PropertyMediaUploadItem[]>([]);

  function patchItem(id: string, patch: Partial<PropertyMediaUploadItem>) {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async function runUpload(item: PropertyMediaUploadItem) {
    // Client-side check only (section 16/17) — the backend remains the real authority on MIME
    // (magic bytes) and size (multipart parser limit); this only avoids a pointless network
    // round trip for an obviously-invalid file.
    const validationError = validatePropertyMediaFile(item.file);
    if (validationError) {
      patchItem(item.id, {
        status: "error",
        errorMessage: describePropertyMediaFileValidationError(validationError),
      });
      return;
    }

    patchItem(item.id, { status: "uploading", errorMessage: undefined });
    try {
      await uploadPropertyMedia(tenantId, propertyId, item.file);
      patchItem(item.id, { status: "success" });
      // Invalidated per successful item (not once at the end of the whole batch) so the grid
      // fills in progressively as each photo actually lands (section 11-12/74: an upload can
      // change the catalog's cover, e.g. the first photo of an empty gallery).
      void queryClient.invalidateQueries({
        queryKey: propertyMediaQueryKeys.list(tenantId, propertyId),
      });
      void queryClient.invalidateQueries({ queryKey: propertiesQueryKeys.all(tenantId) });
    } catch {
      patchItem(item.id, { status: "error", errorMessage: "Não foi possível enviar esta foto." });
    }
  }

  async function uploadFiles(files: File[]) {
    const newItems: PropertyMediaUploadItem[] = files.map((file) => ({
      id: nextUploadItemId(),
      file,
      status: "pending",
    }));
    setItems((prev) => [...prev, ...newItems]);

    await runWithConcurrency(newItems, MAX_CONCURRENT_UPLOADS, (item) => runUpload(item));
  }

  function retryItem(id: string) {
    const item = items.find((candidate) => candidate.id === id);
    if (item) {
      void runUpload(item);
    }
  }

  function dismissItem(id: string) {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  const isUploading = items.some(
    (item) => item.status === "pending" || item.status === "uploading",
  );

  return { items, uploadFiles, retryItem, dismissItem, isUploading };
}
