import { Link } from "react-router";

import { Badge } from "@/components/ui/badge";

import {
  formatLeadDateTime,
  LEAD_SOURCE_LABELS,
  LEAD_STATUS_BADGE_VARIANT,
  LEAD_STATUS_LABELS,
} from "../lib/format-lead-fields";
import type { LeadWithProperty } from "../schemas/lead.schema";

interface LeadTableProps {
  leads: LeadWithProperty[];
}

/**
 * Table responsiva com markup semântico simples (Prompt 044, section 14) — nenhum componente
 * `Table` do shadcn ainda existe no projeto e nenhuma dependência de data-grid foi adicionada.
 * `notes`/`message` nunca aparecem aqui (section 13) — só os campos de identificação/triagem.
 *
 * O nome do lead e o resumo da property são cada um o seu próprio `Link` (section 15/104) — a
 * linha inteira não é um único `<a>` porque um `<a>` aninhado dentro de outro é HTML inválido, e
 * a linha precisa oferecer duas navegações distintas (`/leads/:id` e `/properties/:id`) sem que
 * clicar em uma dispare a outra.
 */
export function LeadTable({ leads }: LeadTableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b bg-muted/50 text-left text-muted-foreground">
            <th className="p-3 font-medium">Nome</th>
            <th className="p-3 font-medium">Status</th>
            <th className="p-3 font-medium">Origem</th>
            <th className="p-3 font-medium">Contato</th>
            <th className="p-3 font-medium">Imóvel</th>
            <th className="p-3 font-medium">Criado em</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr key={lead.id} className="border-b last:border-0 hover:bg-muted/30">
              <td className="p-3 font-medium">
                <Link
                  to={`/leads/${lead.id}`}
                  className="hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {lead.name}
                </Link>
              </td>
              <td className="p-3">
                <Badge variant={LEAD_STATUS_BADGE_VARIANT[lead.status]}>
                  {LEAD_STATUS_LABELS[lead.status]}
                </Badge>
              </td>
              <td className="p-3">
                <Badge variant="secondary">{LEAD_SOURCE_LABELS[lead.source]}</Badge>
              </td>
              <td className="p-3">
                <div className="flex flex-col gap-0.5 text-muted-foreground">
                  {lead.email && <span>{lead.email}</span>}
                  {lead.phone && <span>{lead.phone}</span>}
                </div>
              </td>
              <td className="p-3">
                {lead.property ? (
                  <Link
                    to={`/properties/${lead.property.id}`}
                    className="hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {lead.property.title}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="p-3 text-muted-foreground">{formatLeadDateTime(lead.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
