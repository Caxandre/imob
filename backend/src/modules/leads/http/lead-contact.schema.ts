import { z } from "zod";

/**
 * Shared contact-field validation (Prompt 045, section 8) — extracted from `lead-request.schema.ts`
 * so the administrative create/update contract and the public property-lead-capture contract
 * (`public-lead-capture-request.schema.ts`) validate `name`/`email`/`phone`/`message` and the
 * "at least one contact channel" invariant identically, never two copies that could drift.
 */
export const NAME_MAX_LENGTH = 120;
export const EMAIL_MAX_LENGTH = 254;
export const PHONE_MAX_LENGTH = 30;
export const MESSAGE_MAX_LENGTH = 2000;

// Conservative, shallow validation — digits and standard phone punctuation only, never an
// attempt to parse/normalize DDI/DDD or install an international phone number library.
const PHONE_PATTERN = /^[0-9+()\-.\s]+$/;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX_LENGTH, `email must be at most ${EMAIL_MAX_LENGTH} characters`)
  .pipe(z.email("email must be a valid email address"));

export const phoneSchema = z
  .string()
  .trim()
  .min(1, "phone must not be empty")
  .max(PHONE_MAX_LENGTH, `phone must be at most ${PHONE_MAX_LENGTH} characters`)
  .regex(PHONE_PATTERN, "phone must contain only digits and standard phone punctuation");

export function optionalEmail() {
  return emailSchema.nullish().transform((value) => value ?? null);
}

export function optionalPhone() {
  return phoneSchema.nullish().transform((value) => value ?? null);
}

export function optionalText(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .nullish()
    .transform((value) => value ?? null);
}

export const CONTACT_CHANNEL_REQUIRED_MESSAGE = "at least one contact channel (email or phone) is required";

/**
 * The one cross-field invariant every lead-creation contract shares: at least one of
 * `email`/`phone` must be present. Used as a `.refine()` predicate by both
 * `createLeadBodySchema` and `capturePropertyLeadBodySchema` — never duplicated inline.
 */
export function requireContactChannel(value: { email: string | null; phone: string | null }): boolean {
  return value.email !== null || value.phone !== null;
}
