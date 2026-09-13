interface LeadsEmptyStateProps {
  hasActiveFilters: boolean;
}

export function LeadsEmptyState({ hasActiveFilters }: LeadsEmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed p-10 text-center text-muted-foreground">
      <p>
        {hasActiveFilters ? "Nenhum lead corresponde aos filtros." : "Nenhum lead encontrado."}
      </p>
    </div>
  );
}
