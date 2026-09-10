import { z } from "zod";

import {
  formatDecimalForPtBrInput,
  normalizePtBrDecimalString,
} from "../lib/normalize-decimal-input";
import type { PropertyDetail } from "./property.schema";
import { propertyStatusSchema, propertyTypeSchema, transactionTypeSchema } from "./property.schema";

/**
 * Form-level validation for `PropertyForm` (Prompt 040, section 11) — deliberately distinct
 * from the API response schema (`propertyDetailSchema`): the form works with raw string input
 * values (what HTML inputs actually produce), while the *output* of this schema (after
 * `zodResolver` runs it on submit) is the normalized, backend-shaped request payload —
 * `z.input<typeof propertyFormSchema>` for `defaultValues`/registered fields,
 * `z.output<typeof propertyFormSchema>` for what `onSubmit` receives. Max lengths mirror
 * `backend/src/modules/properties/http/property-request.schema.ts` (verified directly against
 * that file, not invented here) so a value that would be rejected by the API is caught inline
 * before submit.
 */
const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 5000;
const ADDRESS_FIELD_MAX_LENGTH = 200;
const NUMBER_MAX_LENGTH = 20;
const POSTAL_CODE_MAX_LENGTH = 20;

// Optional free-text field: trimmed, length-checked, empty string becomes `null` (never sent as
// `""` — the backend's own nullable text fields require a non-empty string when present at all,
// section 24/71).
function optionalTextField(maxLength: number, fieldLabel: string) {
  return z
    .string()
    .trim()
    .max(maxLength, `${fieldLabel} deve ter no máximo ${maxLength} caracteres`)
    .transform((value) => (value.length === 0 ? null : value));
}

// Non-negative integer field (bedrooms/bathrooms/parking_spaces): empty string becomes `null`,
// distinct from `0` (section 20/72) — digits only, no decimals/sign.
function optionalNonNegativeIntField(fieldLabel: string) {
  return z
    .string()
    .trim()
    .transform((value) => (value.length === 0 ? null : value))
    .refine(
      (value) => value === null || /^\d+$/.test(value),
      `${fieldLabel} deve ser um número inteiro não negativo`,
    )
    .transform((value) => (value === null ? null : Number(value)));
}

const titleSchema = z
  .string()
  .trim()
  .min(1, "Título é obrigatório")
  .max(TITLE_MAX_LENGTH, `Título deve ter no máximo ${TITLE_MAX_LENGTH} caracteres`);

// Required decimal field (price): empty is invalid, unparseable/non-positive is invalid.
const priceSchema = z
  .string()
  .trim()
  .min(1, "Preço é obrigatório")
  .transform((value, ctx) => {
    const normalized = normalizePtBrDecimalString(value);
    if (normalized === null) {
      ctx.addIssue({
        code: "custom",
        message: "Preço inválido — use um valor como 1000 ou 1.000,50",
      });
      return z.NEVER;
    }
    return normalized;
  });

// Optional decimal field (area_m2): empty becomes `null`; a non-empty value must still parse.
const areaM2Schema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (value.length === 0) {
      return null;
    }
    const normalized = normalizePtBrDecimalString(value);
    if (normalized === null) {
      ctx.addIssue({ code: "custom", message: "Área inválida — use um valor como 92 ou 92,50" });
      return z.NEVER;
    }
    return normalized;
  });

// Brazilian UF: empty becomes `null`; otherwise must be exactly 2 letters. Uppercased here too
// (the backend already does this, section 22) so the displayed/dirty-compared value stays
// consistent with what the API will echo back.
const stateSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((value) => value.length === 0 || value.length === 2, "Estado deve ter 2 letras (UF)")
  .transform((value) => (value.length === 0 ? null : value));

export const propertyFormSchema = z.object({
  title: titleSchema,
  description: optionalTextField(DESCRIPTION_MAX_LENGTH, "Descrição"),
  property_type: propertyTypeSchema,
  transaction_type: transactionTypeSchema,
  status: propertyStatusSchema,
  price: priceSchema,
  bedrooms: optionalNonNegativeIntField("Quartos"),
  bathrooms: optionalNonNegativeIntField("Banheiros"),
  parking_spaces: optionalNonNegativeIntField("Vagas"),
  area_m2: areaM2Schema,
  street: optionalTextField(ADDRESS_FIELD_MAX_LENGTH, "Rua"),
  number: optionalTextField(NUMBER_MAX_LENGTH, "Número"),
  complement: optionalTextField(ADDRESS_FIELD_MAX_LENGTH, "Complemento"),
  neighborhood: optionalTextField(ADDRESS_FIELD_MAX_LENGTH, "Bairro"),
  city: optionalTextField(ADDRESS_FIELD_MAX_LENGTH, "Cidade"),
  state: stateSchema,
  postal_code: optionalTextField(POSTAL_CODE_MAX_LENGTH, "CEP"),
});

// What `PropertyForm`'s inputs/`defaultValues` work with — every field is a plain string (what
// an HTML input actually produces), including the enum fields (their input type is still the
// literal string union, just never a bare `string`).
export type PropertyFormValues = z.input<typeof propertyFormSchema>;

// What `onSubmit` receives once `zodResolver` validates+transforms the form (Prompt 040, section
// 11) — the normalized request payload shape: decimal strings, `null` for cleared optional
// fields, numbers for the small integer fields.
export type PropertyFormOutput = z.output<typeof propertyFormSchema>;

export const EMPTY_PROPERTY_FORM_VALUES: PropertyFormValues = {
  title: "",
  description: "",
  property_type: "APARTMENT",
  transaction_type: "SALE",
  status: "DRAFT",
  price: "",
  bedrooms: "",
  bathrooms: "",
  parking_spaces: "",
  area_m2: "",
  street: "",
  number: "",
  complement: "",
  neighborhood: "",
  city: "",
  state: "",
  postal_code: "",
};

// Hydrates the edit form from the already-loaded property (Prompt 040, section 44) — `null`
// becomes `""` for text/enum-like inputs, decimal strings are reformatted to pt-BR for display.
// Never used for validation; only `propertyFormSchema` decides what's valid.
export function propertyToFormValues(property: PropertyDetail): PropertyFormValues {
  return {
    title: property.title,
    description: property.description ?? "",
    property_type: property.property_type,
    transaction_type: property.transaction_type,
    status: property.status,
    price: formatDecimalForPtBrInput(property.price),
    bedrooms: property.bedrooms === null ? "" : String(property.bedrooms),
    bathrooms: property.bathrooms === null ? "" : String(property.bathrooms),
    parking_spaces: property.parking_spaces === null ? "" : String(property.parking_spaces),
    area_m2: property.area_m2 === null ? "" : formatDecimalForPtBrInput(property.area_m2),
    street: property.street ?? "",
    number: property.number ?? "",
    complement: property.complement ?? "",
    neighborhood: property.neighborhood ?? "",
    city: property.city ?? "",
    state: property.state ?? "",
    postal_code: property.postal_code ?? "",
  };
}

/**
 * Builds the PATCH payload from only the fields React Hook Form marked dirty (Prompt 040,
 * sections 27/28/70) — an untouched field is omitted entirely (backend interprets an absent key
 * as "leave unchanged"), never sent as `undefined`.
 */
export function pickDirtyFormFields(
  output: PropertyFormOutput,
  dirtyFields: Partial<Record<keyof PropertyFormOutput, unknown>>,
): Partial<PropertyFormOutput> {
  // A plain string-keyed accumulator, not `Partial<PropertyFormOutput>` (this task): assigning
  // `output[key]` for a `key` typed as the full `keyof` union loses the correlation between a
  // specific key and its value type, which TypeScript correctly refuses on the precisely-typed
  // target. The cast back on return is the single, narrow point where that's re-asserted — every
  // value written here always came from `output` itself, keyed by one of its own keys.
  const payload: Record<string, unknown> = {};

  for (const key of Object.keys(dirtyFields) as (keyof PropertyFormOutput)[]) {
    if (dirtyFields[key]) {
      payload[key] = output[key];
    }
  }

  return payload as Partial<PropertyFormOutput>;
}
