import { describe, expect, it } from "vitest";

import {
  hasActiveFilters,
  parsePropertyFilters,
  serializePropertyFilters,
} from "./property-filters.schema";

describe("parsePropertyFilters", () => {
  it("parses a full set of valid params", () => {
    const params = new URLSearchParams({
      q: "praia",
      status: "ACTIVE",
      property_type: "HOUSE",
      transaction_type: "SALE",
      city: "Florianópolis",
      state: "sc",
      price_min: "100000",
      price_max: "500000.50",
      bedrooms_min: "2",
      bathrooms_min: "1",
      parking_spaces_min: "1",
      area_min: "50",
      area_max: "200.5",
      sort: "price",
      order: "asc",
      page: "3",
    });

    const filters = parsePropertyFilters(params);

    expect(filters).toEqual({
      q: "praia",
      status: "ACTIVE",
      property_type: "HOUSE",
      transaction_type: "SALE",
      city: "Florianópolis",
      state: "SC",
      price_min: "100000",
      price_max: "500000.50",
      bedrooms_min: 2,
      bathrooms_min: 1,
      parking_spaces_min: 1,
      area_min: "50",
      area_max: "200.5",
      sort: "price",
      order: "asc",
      page: 3,
    });
  });

  it("returns an empty object for an empty query string", () => {
    expect(parsePropertyFilters(new URLSearchParams())).toEqual({});
  });

  it("drops an invalid page instead of throwing", () => {
    const filters = parsePropertyFilters(new URLSearchParams({ page: "-1" }));

    expect(filters.page).toBeUndefined();
  });

  it("drops a non-numeric price_min instead of throwing", () => {
    const filters = parsePropertyFilters(new URLSearchParams({ price_min: "abc" }));

    expect(filters.price_min).toBeUndefined();
  });

  it("drops an unknown status instead of throwing", () => {
    const filters = parsePropertyFilters(new URLSearchParams({ status: "banana" }));

    expect(filters.status).toBeUndefined();
  });

  it("drops unknown query params silently", () => {
    const filters = parsePropertyFilters(new URLSearchParams({ unknown_param: "x" }));

    expect(filters).toEqual({});
  });

  it("ignores an unrelated invalid param without dropping the valid ones", () => {
    const filters = parsePropertyFilters(new URLSearchParams({ q: "praia", page: "-1" }));

    expect(filters).toEqual({ q: "praia" });
  });
});

describe("serializePropertyFilters", () => {
  it("omits undefined and empty-string params", () => {
    const params = serializePropertyFilters({ q: "praia", city: undefined, state: undefined });

    expect(params.toString()).toBe("q=praia");
  });

  it("omits page when it is 1 or unset", () => {
    expect(serializePropertyFilters({ page: 1 }).has("page")).toBe(false);
    expect(serializePropertyFilters({}).has("page")).toBe(false);
  });

  it("includes page when greater than 1", () => {
    const params = serializePropertyFilters({ page: 2 });

    expect(params.get("page")).toBe("2");
  });

  it("round-trips through parse", () => {
    const original = { q: "praia", property_type: "HOUSE", page: 2 } as const;
    const roundTripped = parsePropertyFilters(serializePropertyFilters(original));

    expect(roundTripped).toEqual(original);
  });
});

describe("hasActiveFilters", () => {
  it("is false when no filter is set", () => {
    expect(hasActiveFilters({})).toBe(false);
  });

  it("is false when only sort/order/page are set", () => {
    expect(hasActiveFilters({ sort: "price", order: "asc", page: 2 })).toBe(false);
  });

  it("is true when a real filter is set", () => {
    expect(hasActiveFilters({ city: "Florianópolis" })).toBe(true);
  });
});
