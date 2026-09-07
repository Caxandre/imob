import { Button } from "@/components/ui/button";

interface PropertiesErrorStateProps {
  onRetry: () => void;
}

// Never renders the raw ApiError body/stack (section 60) — a fixed, user-facing message plus a
// retry action is all that's shown.
export function PropertiesErrorState({ onRetry }: PropertiesErrorStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
      <p className="text-muted-foreground">Não foi possível carregar os imóveis.</p>
      <Button variant="outline" onClick={onRetry}>
        Tentar novamente
      </Button>
    </div>
  );
}
