import { describe, expect, it } from "vitest";

import {
  EMPTY_PROPERTY_INTEREST_FORM_VALUES,
  propertyInterestFormSchema,
} from "./property-interest-form.schema";

function validFormValues() {
  return {
    ...EMPTY_PROPERTY_INTEREST_FORM_VALUES,
    name: "Maria Souza",
    email: "maria@example.com",
    phone: "",
  };
}

describe("propertyInterestFormSchema", () => {
  it("requires a name", () => {
    const result = propertyInterestFormSchema.safeParse({ ...validFormValues(), name: "" });

    expect(result.success).toBe(false);
  });

  it("accepts email only", () => {
    const result = propertyInterestFormSchema.safeParse(validFormValues());

    expect(result.success).toBe(true);
  });

  it("accepts phone only", () => {
    const result = propertyInterestFormSchema.safeParse({
      ...validFormValues(),
      email: "",
      phone: "11999990000",
    });

    expect(result.success).toBe(true);
  });

  it("accepts both email and phone", () => {
    const result = propertyInterestFormSchema.safeParse({
      ...validFormValues(),
      phone: "11999990000",
    });

    expect(result.success).toBe(true);
  });

  it("rejects neither email nor phone, with the same message/path as the admin form", () => {
    const result = propertyInterestFormSchema.safeParse({
      ...validFormValues(),
      email: "",
      phone: "",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("Informe pelo menos um e-mail ou telefone.");
      expect(result.error.issues[0]?.path).toEqual(["email"]);
    }
  });

  it("transforms empty optional fields to null", () => {
    const result = propertyInterestFormSchema.parse({
      ...validFormValues(),
      phone: "",
      message: "",
    });

    expect(result.phone).toBeNull();
    expect(result.message).toBeNull();
  });

  it("keeps a non-empty message", () => {
    const result = propertyInterestFormSchema.parse({
      ...validFormValues(),
      message: "Gostaria de agendar uma visita.",
    });

    expect(result.message).toBe("Gostaria de agendar uma visita.");
  });

  it("normalizes email by trimming and lowercasing", () => {
    const result = propertyInterestFormSchema.parse({
      ...validFormValues(),
      email: "  Maria@EXAMPLE.com  ",
    });

    expect(result.email).toBe("maria@example.com");
  });

  it("rejects a malformed email", () => {
    const result = propertyInterestFormSchema.safeParse({
      ...validFormValues(),
      email: "not-an-email",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a phone with disallowed characters", () => {
    const result = propertyInterestFormSchema.safeParse({
      ...validFormValues(),
      email: "",
      phone: "call me maybe",
    });

    expect(result.success).toBe(false);
  });

  it("never exposes property_id/status/source/notes fields on the output", () => {
    const result = propertyInterestFormSchema.parse(validFormValues());

    expect(result).not.toHaveProperty("property_id");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("source");
    expect(result).not.toHaveProperty("notes");
    expect(Object.keys(result).sort()).toEqual(["email", "message", "name", "phone"]);
  });
});
