import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { env } from "@/lib/env";
import { ApiError } from "@/lib/http/api-error";

import { LeadDetailsErrorState } from "@/features/leads/components/LeadDetailsErrorState";
import { LeadForm } from "@/features/leads/components/LeadForm";
import { LeadFormSkeleton } from "@/features/leads/components/LeadFormSkeleton";
import { LeadNotFoundState } from "@/features/leads/components/LeadNotFoundState";
import { TenantNotConfiguredState } from "@/features/leads/components/TenantNotConfiguredState";
import { useLead } from "@/features/leads/hooks/use-lead";
import { useUpdateLead } from "@/features/leads/hooks/use-update-lead";
import { isValidLeadId } from "@/features/leads/lib/is-valid-lead-id";
import {
  leadToFormValues,
  pickDirtyLeadFormFields,
  type LeadFormOutput,
} from "@/features/leads/schemas/lead-form.schema";

/**
 * `/leads/:id/edit` (Prompt 044, section 54/55): validate route id → load lead → hydrate
 * `LeadForm` → update mutation. Id validation and the tenant check both happen before `useLead`
 * ever mounts (same pattern as `LeadDetailsPage`), so an invalid id or a missing tenant never
 * fires a request.
 */
export function EditLeadPage() {
  const { id } = useParams();

  if (!isValidLeadId(id)) {
    return <LeadNotFoundState />;
  }

  if (env.tenantId === undefined) {
    return <TenantNotConfiguredState />;
  }

  return <EditLeadPageContent tenantId={env.tenantId} leadId={id} />;
}

function EditLeadPageContent({ tenantId, leadId }: { tenantId: string; leadId: string }) {
  const navigate = useNavigate();
  const leadQuery = useLead(tenantId, leadId);
  const mutation = useUpdateLead(tenantId, leadId);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (leadQuery.isPending) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
        <h1 className="text-2xl font-semibold">Editar lead</h1>
        <LeadFormSkeleton />
      </main>
    );
  }

  if (leadQuery.isError) {
    if (leadQuery.error instanceof ApiError && leadQuery.error.status === 404) {
      return <LeadNotFoundState />;
    }
    return <LeadDetailsErrorState onRetry={() => leadQuery.refetch()} />;
  }

  const lead = leadQuery.data;

  async function handleSubmit(
    values: LeadFormOutput,
    dirtyFields: Partial<Record<keyof LeadFormOutput, unknown>>,
  ) {
    const payload = pickDirtyLeadFormFields(values, dirtyFields);

    // Nothing actually changed (section 62) — the Save button is already disabled for this
    // case, but this guard also covers it defensively without ever calling PATCH with an empty
    // body (which the backend would reject anyway).
    if (Object.keys(payload).length === 0) {
      navigate(`/leads/${leadId}`);
      return;
    }

    setSubmitError(null);
    try {
      await mutation.mutateAsync(payload);
      toast.success("Lead atualizado com sucesso.");
      navigate(`/leads/${leadId}`);
    } catch {
      setSubmitError("Não foi possível salvar o lead.");
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Editar lead</h1>
        <p className="text-sm text-muted-foreground">{lead.name}</p>
      </div>
      {/* `key` + `defaultValues` hydrate the form exactly once from the loaded lead — a
          background refetch never resets in-progress edits, same convention as `PropertyForm`. */}
      <LeadForm
        key={lead.id}
        mode="edit"
        tenantId={tenantId}
        defaultValues={leadToFormValues(lead)}
        initialPropertySummary={lead.property}
        onSubmit={handleSubmit}
        onCancel={() => navigate(`/leads/${leadId}`)}
        isSubmitting={mutation.isPending}
        submitError={submitError}
      />
    </main>
  );
}
