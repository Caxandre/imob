import { Button } from "@/components/ui/button";

interface LeadDetailsErrorStateProps {
  onRetry: () => void;
}

// Generic lead load failure — distinct from the 404 state. Never renders the raw ApiError
// body/stack, same convention as `PropertyDetailsErrorState`.
export function LeadDetailsErrorState({ onRetry }: LeadDetailsErrorStateProps) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-muted-foreground">Não foi possível carregar o lead.</p>
      <Button variant="outline" onClick={onRetry}>
        Tentar novamente
      </Button>
    </main>
  );
}
