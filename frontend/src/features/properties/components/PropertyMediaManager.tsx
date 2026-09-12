import { useRef, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

import { useDeletePropertyMedia } from "../hooks/use-delete-property-media";
import { usePropertyMedia } from "../hooks/use-property-media";
import { useReorderPropertyMedia } from "../hooks/use-reorder-property-media";
import { useSetPropertyMediaCover } from "../hooks/use-set-property-media-cover";
import { useUploadPropertyMedia } from "../hooks/use-upload-property-media";
import { ALLOWED_PROPERTY_MEDIA_MIME_TYPES } from "../lib/validate-property-media-file";
import type { PropertyMedia } from "../schemas/property-media.schema";
import type { PropertyStatus } from "../schemas/property.schema";
import { PropertyGalleryErrorState } from "./PropertyGalleryErrorState";
import { PropertyMediaManagerItem } from "./PropertyMediaManagerItem";
import { PropertyMediaManagerSkeleton } from "./PropertyMediaManagerSkeleton";
import { PropertyMediaUploadQueue } from "./PropertyMediaUploadQueue";

interface PropertyMediaManagerProps {
  tenantId: string;
  propertyId: string;
  propertyStatus: PropertyStatus;
}

const FILE_INPUT_ACCEPT = ALLOWED_PROPERTY_MEDIA_MIME_TYPES.join(",");

function sortByPosition(media: PropertyMedia[]): PropertyMedia[] {
  return [...media].sort((a, b) => a.position - b.position);
}

/**
 * Dedicated gallery administration component (Prompt 041, sections 3/4) — rendered as a
 * sibling section below `PropertyForm` on `/properties/:id/edit`, never nested inside its
 * `<form>` (section 82: a click here must never trigger the textual form's submit). Deliberately
 * separate from the public `PropertyGallery` (section 64) — they never share a component, only
 * the display-URL helpers (section 65).
 */
export function PropertyMediaManager({
  tenantId,
  propertyId,
  propertyStatus,
}: PropertyMediaManagerProps) {
  const mediaQuery = usePropertyMedia(tenantId, propertyId);
  const upload = useUploadPropertyMedia(tenantId, propertyId);
  const reorderMutation = useReorderPropertyMedia(tenantId, propertyId);
  const coverMutation = useSetPropertyMediaCover(tenantId, propertyId);
  const deleteMutation = useDeletePropertyMedia(tenantId, propertyId);

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Upload is blocked for an archived property (backend 409, Prompt 041 section 48) — the UI
  // reflects that up front rather than only surfacing the eventual error. Reorder/cover/delete
  // stay enabled: the backend allows all three for an archived property (sections 37/79/80),
  // and the existing gallery keeps rendering regardless (section 49).
  const uploadDisabledForStatus = propertyStatus === "INACTIVE";

  // Any pending mutation disables the rest (section 46/47) — avoids e.g. delete + set-cover on
  // the same item, or reorder racing an in-progress upload.
  const anyMutationPending =
    upload.isUploading ||
    reorderMutation.isPending ||
    coverMutation.isPending ||
    deleteMutation.isPending;

  function handleFilesSelected(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) {
      return;
    }
    void upload.uploadFiles(Array.from(fileList));
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function handleSetCover(mediaId: string) {
    setCoverError(null);
    try {
      await coverMutation.mutateAsync(mediaId);
      toast.success("Capa atualizada.");
    } catch {
      setCoverError("Não foi possível definir a capa.");
    }
  }

  async function handleMove(sorted: PropertyMedia[], index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= sorted.length) {
      return;
    }

    // New order built locally (Prompt 041, section 44) purely to compute the mutation payload
    // — never rendered before the backend confirms (section 45: no optimistic update).
    const reordered = [...sorted];
    const [moved] = reordered.splice(index, 1);
    if (moved) {
      reordered.splice(targetIndex, 0, moved);
    }

    setReorderError(null);
    try {
      await reorderMutation.mutateAsync(reordered.map((item) => item.id));
      toast.success("Ordem atualizada.");
    } catch {
      setReorderError("Não foi possível reordenar as fotos.");
    }
  }

  async function handleConfirmDelete() {
    if (!pendingDeleteId) {
      return;
    }
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync(pendingDeleteId);
      toast.success("Foto excluída.");
    } catch {
      setDeleteError("Não foi possível excluir a foto.");
    } finally {
      setPendingDeleteId(null);
    }
  }

  const sorted = mediaQuery.data ? sortByPosition(mediaQuery.data.data) : [];

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Fotos do imóvel</h2>

      {uploadDisabledForStatus ? (
        <p className="text-sm text-muted-foreground">
          Envio de fotos desabilitado — o imóvel está arquivado.
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={FILE_INPUT_ACCEPT}
            className="hidden"
            id="property-media-file-input"
            aria-label="Adicionar fotos"
            disabled={anyMutationPending}
            onChange={(event) => handleFilesSelected(event.target.files)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={anyMutationPending}
            onClick={() => fileInputRef.current?.click()}
          >
            Adicionar fotos
          </Button>
        </div>
      )}

      {upload.items.length > 0 && (
        <PropertyMediaUploadQueue
          items={upload.items}
          onRetry={upload.retryItem}
          onDismiss={upload.dismissItem}
        />
      )}

      {reorderError && <p className="text-sm text-destructive">{reorderError}</p>}
      {coverError && <p className="text-sm text-destructive">{coverError}</p>}
      {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}

      {mediaQuery.isPending ? (
        <PropertyMediaManagerSkeleton />
      ) : mediaQuery.isError ? (
        <PropertyGalleryErrorState onRetry={() => mediaQuery.refetch()} />
      ) : sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma foto cadastrada.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {sorted.map((item, index) => (
            <PropertyMediaManagerItem
              key={item.id}
              media={item}
              photoNumber={index + 1}
              isFirst={index === 0}
              isLast={index === sorted.length - 1}
              disabled={anyMutationPending}
              onSetCover={() => void handleSetCover(item.id)}
              onMoveLeft={() => void handleMove(sorted, index, -1)}
              onMoveRight={() => void handleMove(sorted, index, 1)}
              onDeleteRequest={() => setPendingDeleteId(item.id)}
            />
          ))}
        </div>
      )}

      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeleteId(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir esta foto?</AlertDialogTitle>
            <AlertDialogDescription>Essa ação remove a foto da galeria.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancelar</AlertDialogCancel>
            <AlertDialogAction type="button" onClick={() => void handleConfirmDelete()}>
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
