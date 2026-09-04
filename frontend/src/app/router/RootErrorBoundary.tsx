import { isRouteErrorResponse, Link, useRouteError } from "react-router";

import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary (this task, section 23/44) — React Router's own `errorElement`
 * mechanism, not a custom framework: any error thrown during a route's render/loader/action
 * surfaces here instead of producing a blank page.
 */
export function RootErrorBoundary() {
  const error = useRouteError();

  const message = isRouteErrorResponse(error)
    ? `${String(error.status)} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Unexpected error";

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button asChild>
        <Link to="/">Back to home</Link>
      </Button>
    </main>
  );
}
