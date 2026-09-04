/**
 * Minimal typed HTTP error (this task, section 34) — deliberately not a hierarchy of subclasses
 * per status code; `status` is enough for callers (e.g. TanStack Query error handling) to branch
 * on when they need to. `body` is whatever the server's JSON response contained, if any — never
 * guaranteed to be present or of any particular shape, so callers must narrow it themselves.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}
