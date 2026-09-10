import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { env } from "@/lib/env";
import { ApiError } from "@/lib/http/api-error";

import { PropertyDetailsErrorState } from "@/features/properties/components/PropertyDetailsErrorState";
import { PropertyForm } from "@/features/properties/components/PropertyForm";
import { PropertyFormSkeleton } from "@/features/properties/components/PropertyFormSkeleton";
import { PropertyNotFoundState } from "@/features/properties/components/PropertyNotFoundState";
import { TenantNotConfiguredState } from "@/features/properties/components/TenantNotConfiguredState";
import { useProperty } from "@/features/properties/hooks/use-property";
import { useUpdateProperty } from "@/features/properties/hooks/use-update-property";
import { isValidPropertyId } from "@/features/properties/lib/is-valid-property-id";
import {
  pickDirtyFormFields,
  propertyToFormValues,
  type PropertyFormOutput,
} from "@/features/properties/schemas/property-form.schema";

/**
 * `/properties/:id/edit` (Prompt 040, section 8): validate route id → load property → hydrate
 * `PropertyForm` → update mutation. Id validation and the tenant check both happen before
 * `useProperty` ever mounts (same pattern as `PropertyDetailsPage`), so an invalid id or a
 * missing tenant never fires a request.
 */
export function EditPropertyPage() {
  const { id } = useParams();

  if (!isValidPropertyId(id)) {
    return <PropertyNotFoundState />;
  }

  if (env.tenantId === undefined) {
    return <TenantNotConfiguredState />;
  }

  return <EditPropertyPageContent tenantId={env.tenantId} propertyId={id} />;
}

function EditPropertyPageContent({
  tenantId,
  propertyId,
}: {
  tenantId: string;
  propertyId: string;
}) {
  const navigate = useNavigate();
  const propertyQuery = useProperty(tenantId, propertyId);
  const mutation = useUpdateProperty(tenantId, propertyId);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (propertyQuery.isPending) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
        <h1 className="text-2xl font-semibold">Editar imóvel</h1>
        <PropertyFormSkeleton />
      </main>
    );
  }

  if (propertyQuery.isError) {
    if (propertyQuery.error instanceof ApiError && propertyQuery.error.status === 404) {
      return <PropertyNotFoundState />;
    }
    return <PropertyDetailsErrorState onRetry={() => propertyQuery.refetch()} />;
  }

  const property = propertyQuery.data;

  async function handleSubmit(
    values: PropertyFormOutput,
    dirtyFields: Partial<Record<keyof PropertyFormOutput, unknown>>,
  ) {
    const payload = pickDirtyFormFields(values, dirtyFields);

    // Nothing actually changed (section 29) — the Save button is already disabled for this
    // case, but this guard also covers it defensively without ever calling PATCH with an empty
    // body (which the backend would reject anyway).
    if (Object.keys(payload).length === 0) {
      navigate(`/properties/${propertyId}`);
      return;
    }

    setSubmitError(null);
    try {
      await mutation.mutateAsync(payload);
      toast.success("Imóvel atualizado com sucesso.");
      navigate(`/properties/${propertyId}`);
    } catch {
      setSubmitError("Não foi possível salvar o imóvel.");
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Editar imóvel</h1>
        <p className="text-sm text-muted-foreground">{property.title}</p>
      </div>
      {/* `key` + `defaultValues` hydrate the form exactly once from the loaded property
          (Prompt 040, section 44/45) — a background refetch never resets in-progress edits,
          since `PropertyForm` never resyncs `defaultValues` after mount. */}
      <PropertyForm
        key={property.id}
        mode="edit"
        defaultValues={propertyToFormValues(property)}
        onSubmit={handleSubmit}
        onCancel={() => navigate(`/properties/${propertyId}`)}
        isSubmitting={mutation.isPending}
        submitError={submitError}
      />
    </main>
  );
}
