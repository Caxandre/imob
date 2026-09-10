import { describe, expect, it } from "vitest";

import { formatAreaM2, formatPriceBRL, formatPropertyAddress } from "./format-property-fields";

describe("formatPriceBRL", () => {
  it("formats a decimal string as BRL currency", () => {
    expect(formatPriceBRL("450000.00")).toMatch(/R\$\s*450\.000,00/);
  });

  it("formats cents correctly", () => {
    expect(formatPriceBRL("99.90")).toMatch(/R\$\s*99,90/);
  });
});

describe("formatAreaM2", () => {
  it("formats a decimal string with the m² suffix", () => {
    expect(formatAreaM2("120.00")).toBe("120 m²");
  });

  it("returns null when area is null, distinct from a 0 area", () => {
    expect(formatAreaM2(null)).toBeNull();
  });
});

function address(overrides: Partial<Parameters<typeof formatPropertyAddress>[0]> = {}) {
  return {
    street: null,
    number: null,
    complement: null,
    neighborhood: null,
    city: null,
    state: null,
    postal_code: null,
    ...overrides,
  };
}

describe("formatPropertyAddress", () => {
  it("composes a full address defensively", () => {
    expect(
      formatPropertyAddress(
        address({
          street: "Rua das Flores",
          number: "100",
          complement: "Apto 12",
          neighborhood: "Centro",
          city: "Florianópolis",
          state: "SC",
          postal_code: "88000-000",
        }),
      ),
    ).toBe("Rua das Flores, 100 - Apto 12 · Centro · Florianópolis - SC · 88000-000");
  });

  it("never produces 'undefined, undefined' when most fields are null", () => {
    const result = formatPropertyAddress(address({ city: "Recife" }));

    expect(result).not.toMatch(/undefined/);
    expect(result).toBe("Recife");
  });

  it("returns null when every field is null", () => {
    expect(formatPropertyAddress(address())).toBeNull();
  });
});
