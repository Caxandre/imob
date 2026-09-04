import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { Toaster } from "@/components/ui/sonner";

import { createAppQueryClient } from "./query-client";

/**
 * Single composition root for cross-cutting providers (this task, section 26) — kept out of
 * `main.tsx` so the entrypoint stays a plain "mount App" file. `useState(createAppQueryClient)`
 * (lazy initializer) constructs exactly one `QueryClient` per component instance, never a fresh
 * one on every render.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createAppQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster />
    </QueryClientProvider>
  );
}
