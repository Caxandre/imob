/**
 * Display-only formatting for decimal-string fields (Prompt 037B, sections 26-29). The backend
 * returns `price`/`area_m2` as decimal strings precisely so the frontend never round-trips them
 * through a lossy JS `number` — these helpers convert only for rendering, never mutate the model.
 */

const currencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

export function formatPriceBRL(price: string): string {
  return currencyFormatter.format(Number(price));
}

// Absent (`null`) is distinct from `0` (section 28) — callers must not render this at all when
// it returns `null`, rather than falling back to a placeholder like "0 m²".
export function formatAreaM2(areaM2: string | null): string | null {
  if (areaM2 === null) {
    return null;
  }

  return `${Number(areaM2).toLocaleString("pt-BR")} m²`;
}

export const PROPERTY_TYPE_LABELS: Record<string, string> = {
  HOUSE: "Casa",
  APARTMENT: "Apartamento",
  LAND: "Terreno",
  COMMERCIAL: "Comercial",
  OTHER: "Outro",
};

export const TRANSACTION_TYPE_LABELS: Record<string, string> = {
  SALE: "Venda",
  RENT: "Aluguel",
};

export const PROPERTY_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Rascunho",
  ACTIVE: "Ativo",
  INACTIVE: "Inativo",
};
