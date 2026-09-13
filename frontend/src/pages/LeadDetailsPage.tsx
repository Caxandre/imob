import { Link, useParams } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/http/api-error";

import { LeadDetailsErrorState } from "@/features/leads/components/LeadDetailsErrorState";
import { LeadDetailsSkeleton } from "@/features/leads/components/LeadDetailsSkeleton";
import { LeadNotFoundState } from "@/features/leads/components/LeadNotFoundState";
import { TenantNotConfiguredState } from "@/features/leads/components/TenantNotConfiguredState";
import { useLead } from "@/features/leads/hooks/use-lead";
import {
  formatLeadDateTime,
  LEAD_SOURCE_LABELS,
  LEAD_STATUS_BADGE_VARIANT,
  LEAD_STATUS_LABELS,
} from "@/features/leads/lib/format-lead-fields";
import { isValidLeadId } from "@/features/leads/lib/is-valid-lead-id";
import { PROPERTY_STATUS_LABELS } from "@/features/properties/lib/format-property-fields";

/**
 * `/leads/:id` (Prompt 044, section 28): route param → hook → composition. Never fetches
 * directly. The id is validated as a UUID and the tenant is checked *before* anything that could
 * fire a request mounts (section 29), same convention as `PropertyDetailsPage`.
 */
export function LeadDetailsPage() {
  const { id } = useParams();

  if (!isValidLeadId(id)) {
    return <LeadNotFoundState />;
  }

  if (env.tenantId === undefined) {
    return <TenantNotConfiguredState />;
  }

  return <LeadDetailsPageContent tenantId={env.tenantId} leadId={id} />;
}

function LeadDetailsPageContent({ tenantId, leadId }: { tenantId: string; leadId: string }) {
  const leadQuery = useLead(tenantId, leadId);

  if (leadQuery.isPending) {
    return <LeadDetailsSkeleton />;
  }

  if (leadQuery.isError) {
    if (leadQuery.error instanceof ApiError && leadQuery.error.status === 404) {
      return <LeadNotFoundState />;
    }
    return <LeadDetailsErrorState onRetry={() => leadQuery.refetch()} />;
  }

  const lead = leadQuery.data;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Button asChild variant="ghost" className="w-fit">
          <Link to="/leads">Voltar para leads</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to={`/leads/${leadId}/edit`}>Editar</Link>
        </Button>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={LEAD_STATUS_BADGE_VARIANT[lead.status]}>
            {LEAD_STATUS_LABELS[lead.status]}
          </Badge>
          <Badge variant="secondary">{LEAD_SOURCE_LABELS[lead.source]}</Badge>
        </div>

        <h1 className="text-2xl font-semibold">{lead.name}</h1>

        <Card>
          <CardContent className="flex flex-col gap-2 pt-6">
            {lead.email && (
              <a href={`mailto:${lead.email}`} className="text-sm hover:underline">
                {lead.email}
              </a>
            )}
            {lead.phone && (
              <a href={`tel:${lead.phone}`} className="text-sm hover:underline">
                {lead.phone}
              </a>
            )}
            {!lead.email && !lead.phone && (
              <p className="text-sm text-muted-foreground">Nenhum contato informado.</p>
            )}
          </CardContent>
        </Card>

        {/* The property summary comes directly from the Lead response's own `property` field
            (a single JOIN on the backend) — never a separate `GET /properties/:id` here
            (section 31/32/112). */}
        {lead.property && (
          <Card>
            <CardContent className="flex items-center justify-between gap-4 pt-6">
              <div>
                <p className="text-sm text-muted-foreground">Imóvel associado</p>
                <Link to={`/properties/${lead.property.id}`} className="font-medium hover:underline">
                  {lead.property.title}
                </Link>
              </div>
              <Badge variant="ghost">{PROPERTY_STATUS_LABELS[lead.property.status]}</Badge>
            </CardContent>
          </Card>
        )}

        {lead.message && (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-muted-foreground">Mensagem</p>
            <p className="whitespace-pre-line">{lead.message}</p>
          </div>
        )}

        {lead.notes && (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-muted-foreground">Observação</p>
            <p className="whitespace-pre-line">{lead.notes}</p>
          </div>
        )}

        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          <span>Criado em {formatLeadDateTime(lead.created_at)}</span>
          <span>Atualizado em {formatLeadDateTime(lead.updated_at)}</span>
        </div>
      </div>
    </main>
  );
}
