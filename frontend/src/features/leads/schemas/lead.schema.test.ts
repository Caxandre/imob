import { describe, expect, it } from "vitest";

import { leadListResponseSchema, leadSchema, leadWithPropertySchema } from "./lead.schema";

function validLead() {
  return {
    id: "7c2e5a1b-4d6f-4a8c-b3e7-1f9a2d5c8e40",
    property_id: null,
    name: "Maria Souza",
    email: "maria.souza@example.com",
    phone: "+55 11 99999-0000",
    status: "NEW",
    source: "MANUAL",
    message: "Tenho interesse neste apartamento.",
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function validLeadWithProperty() {
  return {
    ...validLead(),
    property_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    property: {
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      title: "Apartamento no Centro",
      status: "ACTIVE",
    },
  };
}

describe("leadSchema", () => {
  it("accepts the POST/PATCH response shape, which never has a property field", () => {
    const result = leadSchema.safeParse(validLead());

    expect(result.success).toBe(true);
  });

  it("strips an unexpected property field rather than rejecting the response", () => {
    const result = leadSchema.safeParse(validLeadWithProperty());

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("property");
  });

  it("accepts nullable email/phone as null, distinct from an empty string", () => {
    const result = leadSchema.safeParse({ ...validLead(), email: null, phone: "11999990000" });

    expect(result.success).toBe(true);
  });

  it("rejects a response with an unknown status", () => {
    const result = leadSchema.safeParse({ ...validLead(), status: "CONVERTED" });

    expect(result.success).toBe(false);
  });

  it("rejects a response with an unknown source", () => {
    const result = leadSchema.safeParse({ ...validLead(), source: "FACEBOOK" });

    expect(result.success).toBe(false);
  });

  it("rejects a response missing a required field", () => {
    const rest: Record<string, unknown> = validLead();
    delete rest.name;

    const result = leadSchema.safeParse(rest);

    expect(result.success).toBe(false);
  });
});

describe("leadWithPropertySchema", () => {
  it("accepts a lead with a property summary", () => {
    const result = leadWithPropertySchema.safeParse(validLeadWithProperty());

    expect(result.success).toBe(true);
  });

  it("accepts a lead with property: null", () => {
    const result = leadWithPropertySchema.safeParse({ ...validLead(), property: null });

    expect(result.success).toBe(true);
  });

  it("rejects a response missing the property field entirely", () => {
    const result = leadWithPropertySchema.safeParse(validLead());

    expect(result.success).toBe(false);
  });

  it("rejects a property summary missing a required field", () => {
    const result = leadWithPropertySchema.safeParse({
      ...validLead(),
      property: { id: "x", title: "Casa" },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a property summary with an unknown status", () => {
    const result = leadWithPropertySchema.safeParse({
      ...validLead(),
      property: { id: "x", title: "Casa", status: "SOLD" },
    });

    expect(result.success).toBe(false);
  });
});

describe("leadListResponseSchema", () => {
  it("accepts a valid paginated list response", () => {
    const result = leadListResponseSchema.safeParse({
      data: [validLeadWithProperty()],
      pagination: { page: 1, limit: 20, total: 1, total_pages: 1 },
    });

    expect(result.success).toBe(true);
  });

  it("rejects a response missing the pagination envelope", () => {
    const result = leadListResponseSchema.safeParse({ data: [validLeadWithProperty()] });

    expect(result.success).toBe(false);
  });

  it("rejects a list item without a property field (list items must be LeadWithProperty)", () => {
    const result = leadListResponseSchema.safeParse({
      data: [validLead()],
      pagination: { page: 1, limit: 20, total: 1, total_pages: 1 },
    });

    expect(result.success).toBe(false);
  });
});
