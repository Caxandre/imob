import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { env } from "@/lib/env";

import { LeadForm } from "@/features/leads/components/LeadForm";
import { TenantNotConfiguredState } from "@/features/leads/components/TenantNotConfiguredState";
import { useCreateLead } from "@/features/leads/hooks/use-create-lead";
import {
  EMPTY_LEAD_FORM_VALUES,
  toCreateLeadInput,
  type LeadFormOutput,
} from "@/features/leads/schemas/lead-form.schema";

/**
 * `/leads/new` (Prompt 044, section 39/52): tenant check → `LeadForm` → create mutation. On
 * success, navigates to the new lead's detail page — never seeds the property-options cache,
 * which this task never touches.
 */
export function NewLeadPage() {
  if (env.tenantId === undefined) {
    return <TenantNotConfiguredState />;
  }

  return <NewLeadPageContent tenantId={env.tenantId} />;
}

function NewLeadPageContent({ tenantId }: { tenantId: string }) {
  const navigate = useNavigate();
  const mutation = useCreateLead(tenantId);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleSubmit(values: LeadFormOutput) {
    setSubmitError(null);
    try {
      const created = await mutation.mutateAsync(toCreateLeadInput(values));
      toast.success("Lead criado com sucesso.");
      navigate(`/leads/${created.id}`);
    } catch {
      // Raw ApiError body is never rendered here — a fixed, safe message, shown in the form
      // itself, never only as a toast (same convention as `NewPropertyPage`).
      setSubmitError("Não foi possível criar o lead.");
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Novo lead</h1>
      <LeadForm
        mode="create"
        tenantId={tenantId}
        defaultValues={EMPTY_LEAD_FORM_VALUES}
        onSubmit={handleSubmit}
        onCancel={() => navigate("/leads")}
        isSubmitting={mutation.isPending}
        submitError={submitError}
      />
    </main>
  );
}
