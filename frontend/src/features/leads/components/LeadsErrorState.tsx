import { Button } from "@/components/ui/button";

interface LeadsErrorStateProps {
  onRetry: () => void;
}

// Never renders the raw ApiError body/stack — a fixed, user-facing message plus a retry action.
export function LeadsErrorState({ onRetry }: LeadsErrorStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
      <p className="text-muted-foreground">Não foi possível carregar os leads.</p>
      <Button variant="outline" onClick={onRetry}>
        Tentar novamente
      </Button>
    </div>
  );
}
