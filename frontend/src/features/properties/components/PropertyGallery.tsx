import { useMemo, useState } from "react";
import { ImageOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import {
  getPropertyDetailImageUrl,
  getPropertyThumbnailImageUrl,
} from "../lib/get-property-media-image";
import type { PropertyMedia } from "../schemas/property-media.schema";

interface PropertyGalleryProps {
  media: PropertyMedia[];
  title: string;
}

// Returns the cover, falling back to the first item by position. Only ever called where the
// array is already known to be non-empty — throws instead of a non-null assertion/cast so that
// invariant stays visible rather than silently trusted (Prompt 038, section 18).
function pickDefaultMedia(sorted: PropertyMedia[]): PropertyMedia {
  const chosen = sorted.find((item) => item.is_cover) ?? sorted[0];
  if (chosen === undefined) {
    throw new Error("pickDefaultMedia called with an empty array");
  }
  return chosen;
}

/**
 * Pure presentation + local selection (Prompt 038, section 17) — never makes an HTTP call of its
 * own; `media` is already-loaded data from `usePropertyMedia`. Selection is `useState`, not a
 * URL/TanStack Query/Zustand (section 21) — it is transient UI state, never navigable/shared.
 * The default (cover, else first by position) is derived at render time rather than synced via
 * an effect (section 22/23): `selectedId` only ever changes on an explicit user click, and
 * whenever it doesn't point at an existing item (nothing picked yet, or the media it pointed at
 * disappeared from a refetch) `selected` below simply falls back to the default for that render
 * — never overwriting a still-valid user selection.
 */
export function PropertyGallery({ media, title }: PropertyGalleryProps) {
  const sorted = useMemo(() => [...media].sort((a, b) => a.position - b.position), [media]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (sorted.length === 0) {
    return (
      <div className="flex aspect-4/3 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted text-muted-foreground">
        <ImageOff className="size-10" aria-hidden="true" />
        <p>Imóvel sem fotos</p>
      </div>
    );
  }

  const selected =
    (selectedId !== null ? sorted.find((item) => item.id === selectedId) : undefined) ??
    pickDefaultMedia(sorted);
  const mainImageUrl = getPropertyDetailImageUrl(selected);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative aspect-4/3 w-full overflow-hidden rounded-xl bg-muted">
        <img src={mainImageUrl} alt={title} className="h-full w-full object-contain" />
        {selected.processing_status === "PROCESSING" && (
          <Badge className="absolute top-2 left-2" variant="secondary">
            Processando
          </Badge>
        )}
      </div>

      {sorted.length > 1 && (
        <div className="flex gap-2 overflow-x-auto">
          {sorted.map((item) => {
            const isSelected = item.id === selected.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={isSelected}
                aria-label={`Foto ${String(item.position + 1)}`}
                onClick={() => setSelectedId(item.id)}
                className={cn(
                  "aspect-square w-16 shrink-0 overflow-hidden rounded-md border-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  isSelected ? "border-primary" : "border-transparent",
                )}
              >
                <img
                  src={getPropertyThumbnailImageUrl(item)}
                  alt=""
                  className="h-full w-full object-cover"
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
