import { describe, expect, it } from "vitest";

import {
  EMPTY_LEAD_FORM_VALUES,
  leadFormSchema,
  leadToFormValues,
  NO_PROPERTY_VALUE,
  pickDirtyLeadFormFields,
  toCreateLeadInput,
} from "./lead-form.schema";

function validFormValues() {
  return {
    ...EMPTY_LEAD_FORM_VALUES,
    name: "Maria Souza",
    email: "maria@example.com",
    phone: "",
  };
}

describe("leadFormSchema", () => {
  it("accepts a lead with only email", () => {
    const result = leadFormSchema.safeParse(validFormValues());

    expect(result.success).toBe(true);
  });

  it("accepts a lead with only phone", () => {
    const result = leadFormSchema.safeParse({ ...validFormValues(), email: "", phone: "11999990000" });

    expect(result.success).toBe(true);
  });

  it("accepts a lead with both email and phone", () => {
    const result = leadFormSchema.safeParse({ ...validFormValues(), phone: "11999990000" });

    expect(result.success).toBe(true);
  });

  it("rejects a lead with neither email nor phone", () => {
    const result = leadFormSchema.safeParse({ ...validFormValues(), email: "", phone: "" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("Informe pelo menos um e-mail ou telefone.");
      expect(result.error.issues[0]?.path).toEqual(["email"]);
    }
  });

  it("rejects a missing name", () => {
    const result = leadFormSchema.safeParse({ ...validFormValues(), name: "" });

    expect(result.success).toBe(false);
  });

  it("normalizes email by trimming and lowercasing, mirroring the backend", () => {
    const result = leadFormSchema.parse({ ...validFormValues(), email: "  Maria@EXAMPLE.com  " });

    expect(result.email).toBe("maria@example.com");
  });

  it("rejects a malformed email", () => {
    const result = leadFormSchema.safeParse({ ...validFormValues(), email: "not-an-email" });

    expect(result.success).toBe(false);
  });

  it("rejects a phone with disallowed characters", () => {
    const result = leadFormSchema.safeParse({
      ...validFormValues(),
      email: "",
      phone: "call me maybe",
    });

    expect(result.success).toBe(false);
  });

  it("transforms empty message/notes to null", () => {
    const result = leadFormSchema.parse({ ...validFormValues(), message: "", notes: "" });

    expect(result.message).toBeNull();
    expect(result.notes).toBeNull();
  });

  it("transforms the no-property sentinel to null", () => {
    const result = leadFormSchema.parse({ ...validFormValues(), property_id: NO_PROPERTY_VALUE });

    expect(result.property_id).toBeNull();
  });

  it("keeps a real property id as-is", () => {
    const propertyId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const result = leadFormSchema.parse({ ...validFormValues(), property_id: propertyId });

    expect(result.property_id).toBe(propertyId);
  });
});

describe("leadToFormValues", () => {
  it("hydrates from a loaded lead, mapping null to empty string / the no-property sentinel", () => {
    const values = leadToFormValues({
      id: "l1",
      property_id: null,
      name: "Maria Souza",
      email: null,
      phone: "11999990000",
      status: "CONTACTED",
      source: "WEBSITE",
      message: null,
      notes: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      property: null,
    });

    expect(values).toEqual({
      name: "Maria Souza",
      email: "",
      phone: "11999990000",
      property_id: NO_PROPERTY_VALUE,
      status: "CONTACTED",
      source: "WEBSITE",
      message: "",
      notes: "",
    });
  });
});

describe("pickDirtyLeadFormFields", () => {
  const output = leadFormSchema.parse(validFormValues());

  it("returns an empty object when nothing is dirty", () => {
    expect(pickDirtyLeadFormFields(output, {})).toEqual({});
  });

  it("includes only the dirty field(s) — altering only status", () => {
    const dirty = { status: true } as const;

    expect(pickDirtyLeadFormFields({ ...output, status: "CONTACTED" }, dirty)).toEqual({
      status: "CONTACTED",
    });
  });

  it("includes an explicit null for a dirty nullable field that was cleared", () => {
    const dirty = { email: true } as const;

    expect(pickDirtyLeadFormFields({ ...output, email: null }, dirty)).toEqual({ email: null });
  });

  it("includes multiple dirty fields together — adding phone and clearing email", () => {
    const dirty = { email: true, phone: true } as const;

    expect(
      pickDirtyLeadFormFields({ ...output, email: null, phone: "11988887777" }, dirty),
    ).toEqual({ email: null, phone: "11988887777" });
  });

  it("includes an explicit null for a cleared property association", () => {
    const dirty = { property_id: true } as const;

    expect(pickDirtyLeadFormFields({ ...output, property_id: null }, dirty)).toEqual({
      property_id: null,
    });
  });
});

describe("toCreateLeadInput", () => {
  it("strips status from the create payload", () => {
    const output = leadFormSchema.parse(validFormValues());

    const input = toCreateLeadInput(output);

    expect(input).not.toHaveProperty("status");
    expect(input).toEqual({
      name: output.name,
      email: output.email,
      phone: output.phone,
      property_id: output.property_id,
      source: output.source,
      message: output.message,
      notes: output.notes,
    });
  });
});
