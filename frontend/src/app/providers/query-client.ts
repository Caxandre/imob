import { QueryClient } from "@tanstack/react-query";

/**
 * Defaults (this task, section 25): `refetchOnWindowFocus: false` — a SaaS admin/CRUD app
 * refetching every tab-focus is more surprising than helpful before any real query exists to
 * judge it against; `retry: 1` — one retry tolerates a single transient network blip without
 * the default 3-retry backoff delaying error feedback noticeably. No cache-time/stale-time
 * tuning here — no real query exists yet to justify a specific value over the library's own
 * default (section 25: "não adicionar cache complexo").
 */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}
