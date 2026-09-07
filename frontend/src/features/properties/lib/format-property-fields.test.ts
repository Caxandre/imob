import { describe, expect, it } from "vitest";

import { formatAreaM2, formatPriceBRL } from "./format-property-fields";

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
