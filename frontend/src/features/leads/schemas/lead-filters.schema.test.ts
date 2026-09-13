import { describe, expect, it } from "vitest";

import {
  hasActiveLeadFilters,
  parseLeadFilters,
  serializeLeadFilters,
} from "./lead-filters.schema";

describe("parseLeadFilters", () => {
  it("parses a full set of valid params", () => {
    const params = new URLSearchParams({
      q: "maria",
      status: "NEW",
      source: "WEBSITE",
      property_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      created_from: "2026-01-01",
      created_to: "2026-01-31",
      page: "2",
    });

    const filters = parseLeadFilters(params);

    expect(filters).toEqual({
      q: "maria",
      status: "NEW",
      source: "WEBSITE",
      property_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      created_from: "2026-01-01",
      created_to: "2026-01-31",
      page: 2,
    });
  });

  it("returns an empty object for an empty query string", () => {
    expect(parseLeadFilters(new URLSearchParams())).toEqual({});
  });

  it("drops a q shorter than 2 characters instead of throwing", () => {
    expect(parseLeadFilters(new URLSearchParams({ q: "a" })).q).toBeUndefined();
  });

  it("drops an unknown status instead of throwing", () => {
    expect(parseLeadFilters(new URLSearchParams({ status: "banana" })).status).toBeUndefined();
  });

  it("drops an unknown source instead of throwing", () => {
    expect(parseLeadFilters(new URLSearchParams({ source: "FACEBOOK" })).source).toBeUndefined();
  });

  it("drops a malformed property_id instead of throwing", () => {
    expect(parseLeadFilters(new URLSearchParams({ property_id: "not-a-uuid" })).property_id).toBeUndefined();
  });

  it("drops a malformed created_from instead of throwing", () => {
    expect(
      parseLeadFilters(new URLSearchParams({ created_from: "01/01/2026" })).created_from,
    ).toBeUndefined();
  });

  it("drops an invalid page instead of throwing", () => {
    expect(parseLeadFilters(new URLSearchParams({ page: "-1" })).page).toBeUndefined();
  });

  it("drops unknown query params silently", () => {
    expect(parseLeadFilters(new URLSearchParams({ unknown_param: "x" }))).toEqual({});
  });

  it("ignores an unrelated invalid param without dropping the valid ones", () => {
    expect(parseLeadFilters(new URLSearchParams({ q: "maria", page: "-1" }))).toEqual({
      q: "maria",
    });
  });
});

describe("serializeLeadFilters", () => {
  it("omits undefined and empty-string params", () => {
    const params = serializeLeadFilters({ q: "maria", status: undefined, source: undefined });

    expect(params.toString()).toBe("q=maria");
  });

  it("omits page when it is 1 or unset", () => {
    expect(serializeLeadFilters({ page: 1 }).has("page")).toBe(false);
    expect(serializeLeadFilters({}).has("page")).toBe(false);
  });

  it("includes page when greater than 1", () => {
    expect(serializeLeadFilters({ page: 2 }).get("page")).toBe("2");
  });

  it("round-trips through parse", () => {
    const original = { q: "maria", status: "NEW", page: 2 } as const;
    const roundTripped = parseLeadFilters(serializeLeadFilters(original));

    expect(roundTripped).toEqual(original);
  });
});

describe("hasActiveLeadFilters", () => {
  it("is false when no filter is set", () => {
    expect(hasActiveLeadFilters({})).toBe(false);
  });

  it("is false when only page is set", () => {
    expect(hasActiveLeadFilters({ page: 2 })).toBe(false);
  });

  it("is true when a real filter is set", () => {
    expect(hasActiveLeadFilters({ status: "NEW" })).toBe(true);
  });
});
