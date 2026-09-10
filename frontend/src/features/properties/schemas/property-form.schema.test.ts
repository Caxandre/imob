import { describe, expect, it } from "vitest";

import {
  EMPTY_PROPERTY_FORM_VALUES,
  pickDirtyFormFields,
  propertyFormSchema,
  propertyToFormValues,
  type PropertyFormOutput,
  type PropertyFormValues,
} from "./property-form.schema";
import type { PropertyDetail } from "./property.schema";

function validFormValues(overrides: Partial<PropertyFormValues> = {}): PropertyFormValues {
  return {
    ...EMPTY_PROPERTY_FORM_VALUES,
    title: "Apartamento no Centro",
    property_type: "APARTMENT",
    transaction_type: "SALE",
    status: "ACTIVE",
    price: "450000,00",
    ...overrides,
  };
}

describe("propertyFormSchema", () => {
  it("accepts a fully filled valid form", () => {
    const result = propertyFormSchema.safeParse(
      validFormValues({
        description: "Ótima localização",
        bedrooms: "3",
        bathrooms: "2",
        parking_spaces: "1",
        area_m2: "92,50",
        street: "Rua Exemplo",
        number: "123",
        complement: "Apto 12",
        neighborhood: "Centro",
        city: "São Paulo",
        state: "sp",
        postal_code: "01000-000",
      }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        title: "Apartamento no Centro",
        description: "Ótima localização",
        property_type: "APARTMENT",
        transaction_type: "SALE",
        status: "ACTIVE",
        price: "450000.00",
        bedrooms: 3,
        bathrooms: 2,
        parking_spaces: 1,
        area_m2: "92.50",
        street: "Rua Exemplo",
        number: "123",
        complement: "Apto 12",
        neighborhood: "Centro",
        city: "São Paulo",
        state: "SP",
        postal_code: "01000-000",
      });
    }
  });

  it("accepts the minimal required fields, converting every empty optional field to null", () => {
    const result = propertyFormSchema.safeParse(validFormValues());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBeNull();
      expect(result.data.bedrooms).toBeNull();
      expect(result.data.bathrooms).toBeNull();
      expect(result.data.parking_spaces).toBeNull();
      expect(result.data.area_m2).toBeNull();
      expect(result.data.street).toBeNull();
      expect(result.data.number).toBeNull();
      expect(result.data.complement).toBeNull();
      expect(result.data.neighborhood).toBeNull();
      expect(result.data.city).toBeNull();
      expect(result.data.state).toBeNull();
      expect(result.data.postal_code).toBeNull();
    }
  });

  it("rejects an empty title", () => {
    const result = propertyFormSchema.safeParse(validFormValues({ title: "" }));

    expect(result.success).toBe(false);
  });

  it("rejects a title made only of whitespace", () => {
    const result = propertyFormSchema.safeParse(validFormValues({ title: "   " }));

    expect(result.success).toBe(false);
  });

  it("rejects an invalid property_type", () => {
    const result = propertyFormSchema.safeParse({
      ...validFormValues(),
      property_type: "MANSION",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an invalid transaction_type", () => {
    const result = propertyFormSchema.safeParse({
      ...validFormValues(),
      transaction_type: "LEASE",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a required but empty price", () => {
    const result = propertyFormSchema.safeParse(validFormValues({ price: "" }));

    expect(result.success).toBe(false);
  });

  it("rejects a non-numeric price", () => {
    const result = propertyFormSchema.safeParse(validFormValues({ price: "R$ foo" }));

    expect(result.success).toBe(false);
  });

  it("rejects a zero price", () => {
    const result = propertyFormSchema.safeParse(validFormValues({ price: "0" }));

    expect(result.success).toBe(false);
  });

  it("accepts nullable numeric fields left empty", () => {
    const result = propertyFormSchema.safeParse(
      validFormValues({ bedrooms: "", bathrooms: "", parking_spaces: "" }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bedrooms).toBeNull();
      expect(result.data.bathrooms).toBeNull();
      expect(result.data.parking_spaces).toBeNull();
    }
  });

  it("accepts zero for nullable numeric fields, distinct from empty/null", () => {
    const result = propertyFormSchema.safeParse(validFormValues({ bedrooms: "0" }));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bedrooms).toBe(0);
    }
  });

  it("rejects a negative numeric field", () => {
    const result = propertyFormSchema.safeParse(validFormValues({ bedrooms: "-1" }));

    expect(result.success).toBe(false);
  });

  it("rejects a decimal value for an integer-only field", () => {
    const result = propertyFormSchema.safeParse(validFormValues({ bedrooms: "1.5" }));

    expect(result.success).toBe(false);
  });

  it("rejects an invalid area_m2", () => {
    const result = propertyFormSchema.safeParse(validFormValues({ area_m2: "abc" }));

    expect(result.success).toBe(false);
  });

  it("rejects a state that isn't exactly 2 letters", () => {
    const result = propertyFormSchema.safeParse(validFormValues({ state: "São Paulo" }));

    expect(result.success).toBe(false);
  });

  it("uppercases a lowercase state", () => {
    const result = propertyFormSchema.safeParse(validFormValues({ state: "sp" }));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.state).toBe("SP");
    }
  });
});

describe("propertyToFormValues", () => {
  function property(overrides: Partial<PropertyDetail> = {}): PropertyDetail {
    return {
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      title: "Apartamento no Centro",
      description: null,
      property_type: "APARTMENT",
      transaction_type: "SALE",
      status: "ACTIVE",
      price: "450000.00",
      bedrooms: null,
      bathrooms: null,
      parking_spaces: null,
      area_m2: null,
      street: null,
      number: null,
      complement: null,
      neighborhood: null,
      city: null,
      state: null,
      postal_code: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("formats price as a pt-BR decimal string", () => {
    expect(propertyToFormValues(property()).price).toBe("450.000,00");
  });

  it("converts null fields to empty strings", () => {
    const values = propertyToFormValues(property());

    expect(values.description).toBe("");
    expect(values.bedrooms).toBe("");
    expect(values.area_m2).toBe("");
    expect(values.street).toBe("");
    expect(values.state).toBe("");
  });

  it("preserves zero as a distinct string from empty", () => {
    expect(propertyToFormValues(property({ bedrooms: 0 })).bedrooms).toBe("0");
  });

  it("formats area_m2 as pt-BR when present", () => {
    expect(propertyToFormValues(property({ area_m2: "92.50" })).area_m2).toBe("92,50");
  });
});

describe("pickDirtyFormFields", () => {
  const output: PropertyFormOutput = {
    title: "Novo título",
    description: null,
    property_type: "APARTMENT",
    transaction_type: "SALE",
    status: "ACTIVE",
    price: "450000.00",
    bedrooms: 0,
    bathrooms: null,
    parking_spaces: null,
    area_m2: null,
    street: null,
    number: null,
    complement: null,
    neighborhood: null,
    city: null,
    state: null,
    postal_code: null,
  };

  it("includes only the fields marked dirty", () => {
    const payload = pickDirtyFormFields(output, { title: true });

    expect(payload).toEqual({ title: "Novo título" });
  });

  it("sends null for a dirty field the user cleared", () => {
    const payload = pickDirtyFormFields(output, { description: true });

    expect(payload).toEqual({ description: null });
  });

  it("sends zero (not omitted, not null) for a dirty numeric field set to zero", () => {
    const payload = pickDirtyFormFields(output, { bedrooms: true });

    expect(payload).toEqual({ bedrooms: 0 });
  });

  it("returns an empty object when nothing is dirty", () => {
    expect(pickDirtyFormFields(output, {})).toEqual({});
  });

  it("never includes an untouched field, even if dirtyFields marks it false", () => {
    const payload = pickDirtyFormFields(output, { title: true, price: false });

    expect(payload).toEqual({ title: "Novo título" });
    expect(payload).not.toHaveProperty("price");
  });
});
