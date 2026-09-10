import { Button } from "@/components/ui/button";

interface PropertyDetailsErrorStateProps {
  onRetry: () => void;
}

// Generic property load failure (Prompt 038, section 45) — distinct from the 404 state. Never
// renders the raw ApiError body/stack, same pattern as `PropertiesErrorState`.
export function PropertyDetailsErrorState({ onRetry }: PropertyDetailsErrorStateProps) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-muted-foreground">Não foi possível carregar o imóvel.</p>
      <Button variant="outline" onClick={onRetry}>
        Tentar novamente
      </Button>
    </main>
  );
}
