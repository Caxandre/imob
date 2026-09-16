import { ApiError } from "@/lib/http/api-error";

/**
 * Maps a `capturePropertyLead` failure to a single safe, user-facing message (Prompt 046,
 * sections 22/23/24/25/26/28) — centralizes the status-code branching here instead of spreading
 * `instanceof ApiError` / `.status` checks across components. Never surfaces the raw response
 * body or infrastructure details.
 *
 * - 400: local validation already runs first (`propertyInterestFormSchema`), so a 400 here means
 *   something the client-side check didn't catch — a generic, non-technical message is enough.
 * - 404: the property doesn't exist or is no longer `ACTIVE` (the backend deliberately makes
 *   these indistinguishable — section 23/33).
 * - 429: the per-IP rate limit (5/min) was hit. No countdown is shown — the backend doesn't
 *   guarantee a retry duration (section 44).
 * - 409/503: tenant infrastructure isn't ready/available — same safe message either way, never
 *   exposing which (section 25).
 * - anything else (network failure, 500, ...): generic fallback (section 26).
 */
export function mapPublicLeadCaptureError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 400:
        return "Verifique os dados informados.";
      case 404:
        return "Este imóvel não está disponível para receber novos contatos.";
      case 429:
        return "Muitas tentativas em pouco tempo. Aguarde um momento e tente novamente.";
      case 409:
      case 503:
        return "Não foi possível enviar seu interesse agora. Tente novamente mais tarde.";
      default:
        return "Não foi possível enviar seu interesse.";
    }
  }

  return "Não foi possível enviar seu interesse.";
}
