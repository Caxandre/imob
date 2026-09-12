import { useState } from "react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

import { useArchiveProperty } from "../hooks/use-archive-property";
import { useUpdateProperty } from "../hooks/use-update-property";
import type { PropertyStatus } from "../schemas/property.schema";

interface PropertyLifecycleActionsProps {
  tenantId: string;
  propertyId: string;
  status: PropertyStatus;
}

/**
 * Explicit domain actions for the property lifecycle (Prompt 042, sections 3/4/11) — never a
 * raw status `<select>`. Exactly one action is ever shown, chosen by the property's current
 * status (section 32):
 *
 * - `DRAFT` → "Ativar imóvel" (`PATCH { status: "ACTIVE" }`, no confirmation — section 16).
 * - `ACTIVE` → "Arquivar imóvel" (`DELETE`, confirmed via `AlertDialog` — section 15).
 * - `INACTIVE` → "Reativar imóvel" (`PATCH { status: "ACTIVE" }`, no confirmation — section 17).
 *
 * Activate and reactivate both reuse `useUpdateProperty` (section 12/13) — same request shape,
 * same cache behavior; a second mutation just for status would duplicate it for no reason.
 * Archive is never sent as `PATCH { status: "INACTIVE" }` — `DELETE` is the backend's own
 * archive semantics (section 6), never reinvented client-side. No optimistic UI change
 * (section 55): the badge only reflects a new status once the backend confirms it.
 */
export function PropertyLifecycleActions({
  tenantId,
  propertyId,
  status,
}: PropertyLifecycleActionsProps) {
  const updateMutation = useUpdateProperty(tenantId, propertyId);
  const archiveMutation = useArchiveProperty(tenantId, propertyId);

  const [activateError, setActivateError] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [reactivateError, setReactivateError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Any lifecycle mutation in flight disables every lifecycle action (section 18/42) — avoids
  // a double-submit; only one action is ever visible per status anyway, but this also covers
  // the moment right after a successful mutation, before the new status has re-rendered.
  const isPending = updateMutation.isPending || archiveMutation.isPending;

  async function handleActivate() {
    setActivateError(null);
    try {
      await updateMutation.mutateAsync({ status: "ACTIVE" });
      toast.success("Imóvel ativado.");
    } catch {
      setActivateError("Não foi possível ativar o imóvel.");
    }
  }

  async function handleReactivate() {
    setReactivateError(null);
    try {
      await updateMutation.mutateAsync({ status: "ACTIVE" });
      toast.success("Imóvel reativado.");
    } catch {
      setReactivateError("Não foi possível reativar o imóvel.");
    }
  }

  async function handleConfirmArchive() {
    setArchiveError(null);
    try {
      await archiveMutation.mutateAsync();
      toast.success("Imóvel arquivado.");
      setConfirmOpen(false);
    } catch {
      setArchiveError("Não foi possível arquivar o imóvel.");
      setConfirmOpen(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "DRAFT" && (
        <Button type="button" disabled={isPending} onClick={() => void handleActivate()}>
          {updateMutation.isPending ? "Ativando..." : "Ativar imóvel"}
        </Button>
      )}

      {status === "ACTIVE" && (
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="outline" disabled={isPending}>
              {archiveMutation.isPending ? "Arquivando..." : "Arquivar imóvel"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Arquivar imóvel?</AlertDialogTitle>
              <AlertDialogDescription>
                O imóvel ficará inativo e poderá ser reativado posteriormente.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Cancelar</AlertDialogCancel>
              <AlertDialogAction type="button" onClick={() => void handleConfirmArchive()}>
                Arquivar
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {status === "INACTIVE" && (
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={() => void handleReactivate()}
        >
          {updateMutation.isPending ? "Reativando..." : "Reativar imóvel"}
        </Button>
      )}

      {activateError && <p className="text-sm text-destructive">{activateError}</p>}
      {archiveError && <p className="text-sm text-destructive">{archiveError}</p>}
      {reactivateError && <p className="text-sm text-destructive">{reactivateError}</p>}
    </div>
  );
}
