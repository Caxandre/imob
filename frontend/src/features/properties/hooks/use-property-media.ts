import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { listPropertyMedia } from "../api/list-property-media";
import type { PropertyMediaListResponse } from "../schemas/property-media.schema";
import { propertiesQueryKeys } from "./use-properties";

export const propertyMediaQueryKeys = {
  list: (tenantId: string, propertyId: string) => ["property-media", tenantId, propertyId] as const,
};

// Prompt 041, section 25 — polls only while at least one media item is still PROCESSING.
const MEDIA_PROCESSING_POLL_INTERVAL_MS = 3000;

function hasProcessingMedia(data: PropertyMediaListResponse | undefined): boolean {
  return data?.data.some((item) => item.processing_status === "PROCESSING") ?? false;
}

/**
 * Independent from `useProperty` (Prompt 038, section 12) — both are meant to be mounted
 * together by the page so TanStack Query fires them in parallel, never one gated behind the
 * other's completion.
 *
 * Polls automatically (via TanStack Query's `refetchInterval`, never a manual `setInterval`)
 * while the currently cached list contains a `PROCESSING` item, and stops on its own once none
 * do (Prompt 041, sections 25-27) — background polling never clears already-loaded data
 * (`useQuery` keeps serving `data` while refetching, section 62). When processing settles
 * (had `PROCESSING` → no longer does), the properties catalog cache is invalidated once
 * (sections 75/76): a cover that just finished processing may now have real thumbnail/card
 * variants the catalog's cached response doesn't know about yet. The edge is tracked with a
 * ref so this only fires on the transition itself, never on every poll tick.
 */
export function usePropertyMedia(tenantId: string, propertyId: string) {
  const queryClient = useQueryClient();
  const wasProcessingRef = useRef(false);

  const query = useQuery({
    queryKey: propertyMediaQueryKeys.list(tenantId, propertyId),
    queryFn: () => listPropertyMedia(tenantId, propertyId),
    refetchInterval: (currentQuery) =>
      hasProcessingMedia(currentQuery.state.data) ? MEDIA_PROCESSING_POLL_INTERVAL_MS : false,
  });

  useEffect(() => {
    const isProcessing = hasProcessingMedia(query.data);
    if (wasProcessingRef.current && !isProcessing) {
      void queryClient.invalidateQueries({ queryKey: propertiesQueryKeys.all(tenantId) });
    }
    wasProcessingRef.current = isProcessing;
  }, [query.data, queryClient, tenantId]);

  return query;
}
