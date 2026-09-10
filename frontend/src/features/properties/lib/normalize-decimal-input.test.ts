import { describe, expect, it } from "vitest";

import { formatDecimalForPtBrInput, normalizePtBrDecimalString } from "./normalize-decimal-input";

describe("normalizePtBrDecimalString", () => {
  it("accepts a plain integer string", () => {
    expect(normalizePtBrDecimalString("1000")).toBe("1000");
  });

  it("accepts a comma decimal separator", () => {
    expect(normalizePtBrDecimalString("1000,50")).toBe("1000.50");
  });

  it("accepts dot thousands separators combined with a comma decimal", () => {
    expect(normalizePtBrDecimalString("1.000,50")).toBe("1000.50");
  });

  it("accepts multiple thousands separators", () => {
    expect(normalizePtBrDecimalString("1.250.000,99")).toBe("1250000.99");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizePtBrDecimalString("  1000,50  ")).toBe("1000.50");
  });

  it("rejects non-numeric garbage", () => {
    expect(normalizePtBrDecimalString("abc")).toBeNull();
  });

  it("rejects a currency-prefixed value", () => {
    expect(normalizePtBrDecimalString("R$ 1000")).toBeNull();
  });

  it("rejects zero", () => {
    expect(normalizePtBrDecimalString("0")).toBeNull();
  });

  it("rejects a negative value", () => {
    expect(normalizePtBrDecimalString("-100")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(normalizePtBrDecimalString("")).toBeNull();
    expect(normalizePtBrDecimalString("   ")).toBeNull();
  });

  it("rejects more than two decimal places", () => {
    expect(normalizePtBrDecimalString("1000,555")).toBeNull();
  });
});

describe("formatDecimalForPtBrInput", () => {
  it("formats a canonical decimal string as pt-BR with two decimal places", () => {
    expect(formatDecimalForPtBrInput("450000.00")).toBe("450.000,00");
  });

  it("formats a value with no decimal part", () => {
    expect(formatDecimalForPtBrInput("1000")).toBe("1.000,00");
  });

  it("round-trips through normalizePtBrDecimalString", () => {
    const formatted = formatDecimalForPtBrInput("92.5");
    expect(normalizePtBrDecimalString(formatted)).toBe("92.50");
  });
});
