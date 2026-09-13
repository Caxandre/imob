/**
 * Converts a calendar date (`YYYY-MM-DD`, from an `<input type="date">`) into the full
 * ISO-8601-with-offset datetime the backend's `created_from`/`created_to` filters expect
 * (`z.iso.datetime({ offset: true })` — verified against
 * `backend/src/modules/leads/http/lead-request.schema.ts`). The URL itself keeps the plain date
 * (nicer to read/share, matches what the date input can round-trip) — this conversion happens
 * only at the API call boundary (`listLeads`), never stored anywhere (Prompt 044, section 73).
 *
 * Deliberately UTC, not the browser's local timezone: an `<input type="date">` value has no
 * timezone of its own, and treating it as a local calendar day would make the exact filtered
 * range depend on the viewer's machine. `created_from` is always the start of that day in UTC
 * (`T00:00:00.000Z`); `created_to` is always the end of that day in UTC (`T23:59:59.999Z`).
 */
export function dateOnlyToRangeStartIso(dateOnly: string): string {
  return `${dateOnly}T00:00:00.000Z`;
}

export function dateOnlyToRangeEndIso(dateOnly: string): string {
  return `${dateOnly}T23:59:59.999Z`;
}
