import { z } from "zod";

import type { LeadWithProperty } from "./lead.schema";
import { leadSourceSchema, leadStatusSchema } from "./lead.schema";

/**
 * Form-level validation for `LeadForm` (Prompt 044, sections 41-46) — deliberately distinct
 * from the API response schemas: the form works with raw string input values, while the
 * *output* (after `zodResolver` runs it on submit) is the normalized request payload. Max
 * lengths and the phone pattern mirror `backend/src/modules/leads/http/lead-request.schema.ts`
 * (verified directly against that file) so a value the API would reject is caught inline.
 */
const NAME_MAX_LENGTH = 120;
const EMAIL_MAX_LENGTH = 254;
const PHONE_MAX_LENGTH = 30;
const MESSAGE_MAX_LENGTH = 2000;
const NOTES_MAX_LENGTH = 2000;

// Mirrors the backend's own conservative pattern — digits and standard phone punctuation only,
// never an attempt at DDI/DDD parsing (section 46 — no masking library).
const PHONE_PATTERN = /^[0-9+()\-.\s]+$/;

// Renders as "Nenhum imóvel" in the property select (Prompt 044, section 47/48) — Radix's
// `Select.Item` cannot use an empty string as its value, so a sentinel is required either way.
export const NO_PROPERTY_VALUE = "none";

// Empty becomes `null`; a non-empty value is normalized exactly like the backend does
// (trim + lowercase, section 45) before being format-checked.
const emailFieldSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX_LENGTH, `E-mail deve ter no máximo ${EMAIL_MAX_LENGTH} caracteres`)
  .transform((value) => (value.length === 0 ? null : value))
  .refine((value) => value === null || z.email().safeParse(value).success, {
    message: "E-mail inválido",
  });

// Empty becomes `null`; a non-empty value must match the backend's own conservative pattern.
const phoneFieldSchema = z
  .string()
  .trim()
  .max(PHONE_MAX_LENGTH, `Telefone deve ter no máximo ${PHONE_MAX_LENGTH} caracteres`)
  .transform((value) => (value.length === 0 ? null : value))
  .refine((value) => value === null || PHONE_PATTERN.test(value), {
    message: "Telefone deve conter apenas números e pontuação comum (+, (), -, espaço)",
  });

function optionalTextField(maxLength: number, fieldLabel: string) {
  return z
    .string()
    .trim()
    .max(maxLength, `${fieldLabel} deve ter no máximo ${maxLength} caracteres`)
    .transform((value) => (value.length === 0 ? null : value));
}

const propertyIdFieldSchema = z
  .string()
  .transform((value) => (value === NO_PROPERTY_VALUE ? null : value));

const leadFormFieldsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Nome é obrigatório")
    .max(NAME_MAX_LENGTH, `Nome deve ter no máximo ${NAME_MAX_LENGTH} caracteres`),
  email: emailFieldSchema,
  phone: phoneFieldSchema,
  property_id: propertyIdFieldSchema,
  // Only rendered/editable in edit mode (section 42/57) — always present in the form's values
  // either way (create's default, "NEW", is simply never touched, so it never becomes dirty and
  // never reaches the create payload — the same pattern `propertyFormSchema` already uses for
  // `status` in the opposite direction).
  status: leadStatusSchema,
  source: leadSourceSchema,
  message: optionalTextField(MESSAGE_MAX_LENGTH, "Mensagem"),
  notes: optionalTextField(NOTES_MAX_LENGTH, "Observação"),
});

/**
 * The one cross-field invariant the form can fully validate on its own (section 44/60): at
 * least one contact channel present. Applied to the *whole* resulting form state — since React
 * Hook Form always holds the complete object (existing values merged with whatever the user has
 * changed), this is already exactly the "resulting state" check the backend also performs on
 * `PATCH`, with no separate merge step needed here.
 */
export const leadFormSchema = leadFormFieldsSchema.refine(
  (data) => data.email !== null || data.phone !== null,
  { message: "Informe pelo menos um e-mail ou telefone.", path: ["email"] },
);

// What `LeadForm`'s inputs/`defaultValues` work with — every field is a plain string.
export type LeadFormValues = z.input<typeof leadFormSchema>;

// What `onSubmit` receives once `zodResolver` validates+transforms the form.
export type LeadFormOutput = z.output<typeof leadFormSchema>;

// The create request payload never includes `status` (the backend's `createLeadBodySchema` is
// `.strict()` and rejects it as an unknown key) — the create page strips it explicitly.
export type CreateLeadInput = Omit<LeadFormOutput, "status">;

// The update request payload is whatever subset of fields `pickDirtyLeadFormFields` selected.
export type UpdateLeadInput = Partial<LeadFormOutput>;

export const EMPTY_LEAD_FORM_VALUES: LeadFormValues = {
  name: "",
  email: "",
  phone: "",
  property_id: NO_PROPERTY_VALUE,
  status: "NEW",
  source: "MANUAL",
  message: "",
  notes: "",
};

// Hydrates the edit form from the already-loaded lead (section 55) — `null` becomes `""`/the
// "no property" sentinel for text/select inputs. Never used for validation.
export function leadToFormValues(lead: LeadWithProperty): LeadFormValues {
  return {
    name: lead.name,
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    property_id: lead.property_id ?? NO_PROPERTY_VALUE,
    status: lead.status,
    source: lead.source,
    message: lead.message ?? "",
    notes: lead.notes ?? "",
  };
}

/**
 * Builds the PATCH payload from only the fields React Hook Form marked dirty (section 58/61) —
 * an untouched field is omitted entirely, never sent as `undefined`. Same convention as
 * Properties' `pickDirtyFormFields`.
 */
export function pickDirtyLeadFormFields(
  output: LeadFormOutput,
  dirtyFields: Partial<Record<keyof LeadFormOutput, unknown>>,
): UpdateLeadInput {
  const payload: Record<string, unknown> = {};

  for (const key of Object.keys(dirtyFields) as (keyof LeadFormOutput)[]) {
    if (dirtyFields[key]) {
      payload[key] = output[key];
    }
  }

  return payload as UpdateLeadInput;
}

// Strips `status` for the create payload (section 42) — every other field is sent as-is,
// never picked by dirty-fields (create always sends the full normalized form, unlike edit).
// Listed explicitly (rather than destructuring `status` out) so no field is ever silently
// dropped or added without this function visibly changing.
export function toCreateLeadInput(output: LeadFormOutput): CreateLeadInput {
  return {
    name: output.name,
    email: output.email,
    phone: output.phone,
    property_id: output.property_id,
    source: output.source,
    message: output.message,
    notes: output.notes,
  };
}
