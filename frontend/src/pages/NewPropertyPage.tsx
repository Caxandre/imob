import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { env } from "@/lib/env";

import { PropertyForm } from "@/features/properties/components/PropertyForm";
import { TenantNotConfiguredState } from "@/features/properties/components/TenantNotConfiguredState";
import { useCreateProperty } from "@/features/properties/hooks/use-create-property";
import {
  EMPTY_PROPERTY_FORM_VALUES,
  type PropertyFormOutput,
} from "@/features/properties/schemas/property-form.schema";

/**
 * `/properties/new` (Prompt 040, section 7): tenant check → `PropertyForm` → create mutation.
 * On success, navigates to the new property's detail page (section 34) — never seeds the
 * gallery/media cache, which this task never touches.
 */
export function NewPropertyPage() {
  if (env.tenantId === undefined) {
    return <TenantNotConfiguredState />;
  }

  return <NewPropertyPageContent tenantId={env.tenantId} />;
}

function NewPropertyPageContent({ tenantId }: { tenantId: string }) {
  const navigate = useNavigate();
  const mutation = useCreateProperty(tenantId);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleSubmit(values: PropertyFormOutput) {
    setSubmitError(null);
    try {
      const created = await mutation.mutateAsync(values);
      toast.success("Imóvel criado com sucesso.");
      navigate(`/properties/${created.id}`);
    } catch {
      // Raw ApiError body is never rendered here (Prompt 040, section 39) — a fixed, safe
      // message, shown in the form itself, never only as a toast (section 55).
      setSubmitError("Não foi possível salvar o imóvel.");
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Novo imóvel</h1>
      <PropertyForm
        mode="create"
        defaultValues={EMPTY_PROPERTY_FORM_VALUES}
        onSubmit={handleSubmit}
        onCancel={() => navigate("/properties")}
        isSubmitting={mutation.isPending}
        submitError={submitError}
      />
    </main>
  );
}
