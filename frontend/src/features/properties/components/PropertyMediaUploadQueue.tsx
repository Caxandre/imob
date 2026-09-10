import { Button } from "@/components/ui/button";

import type {
  PropertyMediaUploadItem,
  PropertyMediaUploadStatus,
} from "../hooks/use-upload-property-media";

interface PropertyMediaUploadQueueProps {
  items: PropertyMediaUploadItem[];
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}

// Per-file status (Prompt 041, sections 19/55): upload HTTP completion ("Enviado") is
// deliberately distinct from processing completion — this queue never claims variants are
// ready, only that the original was accepted.
function statusLabel(status: PropertyMediaUploadStatus): string {
  switch (status) {
    case "pending":
      return "Aguardando";
    case "uploading":
      return "Enviando";
    case "success":
      return "Enviado";
    case "error":
      return "Erro";
  }
}

export function PropertyMediaUploadQueue({
  items,
  onRetry,
  onDismiss,
}: PropertyMediaUploadQueueProps) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2 text-sm"
        >
          <span className="truncate">{item.file.name}</span>
          <div className="flex items-center gap-2">
            <span
              className={item.status === "error" ? "text-destructive" : "text-muted-foreground"}
            >
              {item.status === "error" && item.errorMessage
                ? item.errorMessage
                : statusLabel(item.status)}
            </span>
            {item.status === "error" && (
              <Button type="button" size="sm" variant="outline" onClick={() => onRetry(item.id)}>
                Tentar novamente
              </Button>
            )}
            {item.status !== "uploading" && item.status !== "pending" && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Remover ${item.file.name} da lista de envio`}
                onClick={() => onDismiss(item.id)}
              >
                Remover
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
