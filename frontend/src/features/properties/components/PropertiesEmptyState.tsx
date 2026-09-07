interface PropertiesEmptyStateProps {
  hasActiveFilters: boolean;
}

export function PropertiesEmptyState({ hasActiveFilters }: PropertiesEmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed p-10 text-center text-muted-foreground">
      <p>Nenhum imóvel encontrado.</p>
      {hasActiveFilters && <p className="text-sm">Tente ajustar os filtros.</p>}
    </div>
  );
}
