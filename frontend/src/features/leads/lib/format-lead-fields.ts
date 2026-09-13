import type { LeadSource, LeadStatus } from "../schemas/lead.schema";

// Centralized labels (Prompt 044, sections 19/20/74/75) — every place that renders a
// status/source badge or select option imports these, never a second inline mapping.
export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  NEW: "Novo",
  CONTACTED: "Contatado",
  QUALIFIED: "Qualificado",
  WON: "Convertido",
  LOST: "Perdido",
};

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  MANUAL: "Manual",
  WEBSITE: "Site",
  WHATSAPP: "WhatsApp",
  PORTAL: "Portal",
  OTHER: "Outro",
};

// Reuses the shadcn `Badge` variants already used by Properties (section 76) — no parallel
// design system. Purely presentational grouping: WON reads as a positive outcome, LOST as a
// negative one, everything else as neutral/in-progress.
export const LEAD_STATUS_BADGE_VARIANT: Record<
  LeadStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  NEW: "secondary",
  CONTACTED: "outline",
  QUALIFIED: "outline",
  WON: "default",
  LOST: "destructive",
};

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
});

// Display-only formatting for `created_at`/`updated_at` (ISO strings from the API) — never used
// for filtering/comparison logic, only rendering.
export function formatLeadDateTime(isoDateTime: string): string {
  return dateTimeFormatter.format(new Date(isoDateTime));
}
