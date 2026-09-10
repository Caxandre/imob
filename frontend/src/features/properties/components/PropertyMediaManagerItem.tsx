import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { getPropertyThumbnailImageUrl } from "../lib/get-property-media-image";
import type { PropertyMedia } from "../schemas/property-media.schema";

interface PropertyMediaManagerItemProps {
  media: PropertyMedia;
  photoNumber: number;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  onSetCover: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onDeleteRequest: () => void;
}

/**
 * Admin grid card (Prompt 041, sections 29-32/58-59) — thumbnail only, never the DETAIL variant
 * (section 31: this grid doesn't need the largest rendition). All actions are real `<button>`
 * elements with explicit `aria-label`s naming the photo by its 1-based position, and every
 * button is `type="button"` (section 82) — this card is never rendered inside the textual
 * `<form>`, but the type is set defensively regardless.
 */
export function PropertyMediaManagerItem({
  media,
  photoNumber,
  isFirst,
  isLast,
  disabled,
  onSetCover,
  onMoveLeft,
  onMoveRight,
  onDeleteRequest,
}: PropertyMediaManagerItemProps) {
  const thumbnailUrl = getPropertyThumbnailImageUrl(media);

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-2">
      <div className="relative aspect-square w-full overflow-hidden rounded-md bg-muted">
        <img
          src={thumbnailUrl}
          alt={`Foto ${String(photoNumber)}`}
          className="h-full w-full object-cover"
        />
        <div className="absolute top-1 left-1 flex flex-wrap gap-1">
          {media.is_cover && <Badge variant="secondary">Capa</Badge>}
          {media.processing_status === "PROCESSING" && <Badge variant="outline">Processando</Badge>}
          {media.processing_status === "FAILED" && (
            <Badge variant="destructive">Falha no processamento</Badge>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || media.is_cover}
          aria-label={`Definir foto ${String(photoNumber)} como capa`}
          onClick={onSetCover}
        >
          Definir como capa
        </Button>
      </div>

      <div className="flex items-center justify-between gap-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || isFirst}
          aria-label={`Mover foto ${String(photoNumber)} para a esquerda`}
          onClick={onMoveLeft}
        >
          ←
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || isLast}
          aria-label={`Mover foto ${String(photoNumber)} para a direita`}
          onClick={onMoveRight}
        >
          →
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          aria-label={`Excluir foto ${String(photoNumber)}`}
          onClick={onDeleteRequest}
        >
          Excluir
        </Button>
      </div>
    </div>
  );
}
