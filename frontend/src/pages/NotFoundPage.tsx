import { Link } from "react-router";

import { Button } from "@/components/ui/button";

/** Catch-all route (this task, section 22) — every path not matched by a real route lands here. */
export function NotFoundPage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold">Página não encontrada</h1>
      <Button asChild>
        <Link to="/">Voltar para o início</Link>
      </Button>
    </main>
  );
}
