import { Link } from "react-router";

import { Button } from "@/components/ui/button";

// Shown both for an obviously-invalid `:id` (never sent as a request) and a real 404 from
// `GET /api/v1/leads/:id` — same convention as `PropertyNotFoundState`.
export function LeadNotFoundState() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">Lead não encontrado.</h1>
      <Button asChild variant="outline">
        <Link to="/leads">Voltar para leads</Link>
      </Button>
    </main>
  );
}
