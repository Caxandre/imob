import { Link } from "react-router";

import { Button } from "@/components/ui/button";

// Shown both for an obviously-invalid `:id` (never sent as a request) and a real 404 from
// `GET /api/v1/properties/:id` (Prompt 038, sections 7/13/47) — same user-facing outcome either
// way, distinct from the generic error state.
export function PropertyNotFoundState() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">Imóvel não encontrado.</h1>
      <Button asChild variant="outline">
        <Link to="/properties">Voltar para imóveis</Link>
      </Button>
    </main>
  );
}
