import { env } from "@/lib/env";

import { ApiError } from "./api-error";

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  /**
   * A plain value is serialized as JSON automatically — never pass an already-stringified
   * body. A `FormData` instance (multipart uploads, Prompt 041 sections 6/7) is passed straight
   * through instead: never JSON-stringified, and never given a manual `Content-Type` — the
   * browser sets `multipart/form-data` with its own boundary, which a hardcoded header would
   * break.
   */
  body?: unknown;
}

function hasStringMessage(value: unknown): value is { message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
  );
}

/**
 * Minimal HTTP client (this task, section 27/31) — `fetch` directly, no Axios. Owns exactly:
 * base URL (from the centralized `env` module, never `import.meta.env` here or anywhere else),
 * common headers, JSON parsing, and HTTP-error-to-`ApiError` translation. Deliberately never
 * sets `Authorization`/`X-Tenant-Id`/any auth header (section 32/33) — that decision belongs to
 * a future feature, not this foundation. No timeout/retry here either (section 36) — retry
 * policy belongs to TanStack Query, per call site.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;
  const isFormData = body instanceof FormData;

  const response = await fetch(`${env.apiUrl}${path}`, {
    ...rest,
    headers: {
      Accept: "application/json",
      ...(body !== undefined && !isFormData ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
  });

  // 204 No Content — and any other body-less success — never attempts to parse JSON (section 35).
  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const data: unknown = response.status === 204 || !isJson ? undefined : await response.json();

  if (!response.ok) {
    const message = hasStringMessage(data)
      ? data.message
      : response.statusText || `Request failed (${response.status})`;
    throw new ApiError(response.status, message, data);
  }

  return data as T;
}
