import { Button } from "@/components/ui/button";

import type { PropertyPagination as PropertyPaginationData } from "../schemas/property.schema";

interface PropertyPaginationProps {
  pagination: PropertyPaginationData;
  onChangePage: (page: number) => void;
}

// Never rendered by the caller when `total === 0` (section 51 — "Página 1 de 0" never appears).
export function PropertyPagination({ pagination, onChangePage }: PropertyPaginationProps) {
  const { page, total_pages } = pagination;

  return (
    <div className="flex items-center justify-center gap-3">
      <Button variant="outline" disabled={page <= 1} onClick={() => onChangePage(page - 1)}>
        Anterior
      </Button>
      <span className="text-sm text-muted-foreground">
        Página {page} de {total_pages}
      </span>
      <Button
        variant="outline"
        disabled={page >= total_pages}
        onClick={() => onChangePage(page + 1)}
      >
        Próxima
      </Button>
    </div>
  );
}
