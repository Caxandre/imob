import { Button } from "@/components/ui/button";

interface PropertyGalleryErrorStateProps {
  onRetry: () => void;
}

// Media failed to load but the property itself did (Prompt 038, section 46) — scoped to the
// gallery area only, never hides the property's own data.
export function PropertyGalleryErrorState({ onRetry }: PropertyGalleryErrorStateProps) {
  return (
    <div className="flex aspect-4/3 w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-6 text-center">
      <p className="text-muted-foreground">Não foi possível carregar as fotos.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Tentar novamente
      </Button>
    </div>
  );
}
