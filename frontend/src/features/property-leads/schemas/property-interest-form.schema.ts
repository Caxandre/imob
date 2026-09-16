import { z } from "zod";

/**
 * Form-level validation for `PropertyInterestForm` (Prompt 046, sections 10-16) — a dedicated
 * schema, deliberately NOT the admin `leadFormSchema`
 * (`frontend/src/features/leads/schemas/lead-form.schema.ts`): the public capture endpoint only
 * ever accepts `name`/`email`/`phone`/`message`, never `property_id`/`status`/`source`/`notes`.
 * Limits and patterns mirror the backend contract verified directly against
 * `backend/src/modules/leads/http/public-lead-capture-request.schema.ts` and
 * `backend/src/modules/leads/domain/lead-contact.schema.ts`.
 */
const NAME_MAX_LENGTH = 120;
const EMAIL_MAX_LENGTH = 254;
const PHONE_MAX_LENGTH = 30;
const MESSAGE_MAX_LENGTH = 2000;

// Same conservative pattern as the backend — digits and standard phone punctuation only, never
// an attempt at DDI/DDD parsing (section 13 — no masking library).
const PHONE_PATTERN = /^[0-9+()\-.\s]+$/;

// Empty becomes `null` (section 16); a non-empty value is normalized exactly like the backend
// (trim + lowercase) before being format-checked.
const emailFieldSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX_LENGTH, `E-mail deve ter no máximo ${EMAIL_MAX_LENGTH} caracteres`)
  .transform((value) => (value.length === 0 ? null : value))
  .refine((value) => value === null || z.email().safeParse(value).success, {
    message: "E-mail inválido",
  });

// Empty becomes `null` (section 16); a non-empty value must match the backend's own pattern.
const phoneFieldSchema = z
  .string()
  .trim()
  .max(PHONE_MAX_LENGTH, `Telefone deve ter no máximo ${PHONE_MAX_LENGTH} caracteres`)
  .transform((value) => (value.length === 0 ? null : value))
  .refine((value) => value === null || PHONE_PATTERN.test(value), {
    message: "Telefone deve conter apenas números e pontuação comum (+, (), -, espaço)",
  });

// Empty becomes `null` (section 16) — the backend requires a non-empty message when present, but
// since an empty/whitespace-only value is never sent as a string, that backend rule is already
// satisfied by construction.
const messageFieldSchema = z
  .string()
  .trim()
  .max(MESSAGE_MAX_LENGTH, `Mensagem deve ter no máximo ${MESSAGE_MAX_LENGTH} caracteres`)
  .transform((value) => (value.length === 0 ? null : value));

const propertyInterestFormFieldsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Nome é obrigatório")
    .max(NAME_MAX_LENGTH, `Nome deve ter no máximo ${NAME_MAX_LENGTH} caracteres`),
  email: emailFieldSchema,
  phone: phoneFieldSchema,
  message: messageFieldSchema,
});

/**
 * Same contact invariant as the backend (section 14) — at least one of email/phone. Checked
 * against the whole resulting form state, same convention as `leadFormSchema`.
 */
export const propertyInterestFormSchema = propertyInterestFormFieldsSchema.refine(
  (data) => data.email !== null || data.phone !== null,
  { message: "Informe pelo menos um e-mail ou telefone.", path: ["email"] },
);

// What the form's inputs/`defaultValues` work with — every field is a plain string.
export type PropertyInterestFormValues = z.input<typeof propertyInterestFormSchema>;

// What `onSubmit` receives once `zodResolver` validates+transforms the form — also exactly the
// public API's request payload shape (section 9): name/email/phone/message, nothing else.
export type PropertyInterestFormOutput = z.output<typeof propertyInterestFormSchema>;

export const EMPTY_PROPERTY_INTEREST_FORM_VALUES: PropertyInterestFormValues = {
  name: "",
  email: "",
  phone: "",
  message: "",
};
