/**
 * pt-BR decimal input handling for `price`/`area_m2` (Prompt 040, sections 17-19/21/65) — the
 * form shows/accepts pt-BR formatting ("." thousands, "," decimal), but the API always expects
 * the backend's own canonical decimal string (`^\d+(\.\d{1,2})?$`, mirrors
 * `backend/src/modules/properties/http/property-request.schema.ts`'s `DECIMAL_STRING_PATTERN`)
 * — never a JS `number` round-trip for money (section 18).
 */
const CANONICAL_DECIMAL_PATTERN = /^\d+(\.\d{1,2})?$/;

/**
 * Converts a pt-BR-formatted input ("1000", "1000,50", "1.000,50") into the backend's decimal
 * string, or `null` when the input doesn't parse into a valid positive decimal (garbage like
 * "abc"/"R$ foo", a negative value, or zero). Never throws.
 */
export function normalizePtBrDecimalString(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const withoutThousandsSeparators = trimmed.replace(/\./g, "");
  const withDotDecimal = withoutThousandsSeparators.replace(",", ".");

  if (!CANONICAL_DECIMAL_PATTERN.test(withDotDecimal) || Number(withDotDecimal) <= 0) {
    return null;
  }

  return withDotDecimal;
}

/**
 * The inverse direction, used only to hydrate the edit form from an already-valid API decimal
 * string (Prompt 040, section 44) — display-only, never used for validation.
 */
export function formatDecimalForPtBrInput(value: string): string {
  return Number(value).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
