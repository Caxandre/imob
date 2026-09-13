import { Button } from "@/components/ui/button";

import type { LeadPagination as LeadPaginationData } from "../schemas/lead.schema";

interface LeadPaginationProps {
  pagination: LeadPaginationData;
  onChangePage: (page: number) => void;
}

// Never rendered by the caller when `total === 0` — same convention as `PropertyPagination`
// (feature-scoped duplication is intentional, CLAUDE.md: never mix Leads/Properties code).
export function LeadPagination({ pagination, onChangePage }: LeadPaginationProps) {
  const { page, total_pages } = pagination;

  return (
    <div className="flex items-center justify-center gap-3">
      <Button variant="outline" disabled={page <= 1} onClick={() => onChangePage(page - 1)}>
        Anterior
      </Button>
      <span className="text-sm text-muted-foreground">
        Página {page} de {total_pages}
      </span>
      <Button variant="outline" disabled={page >= total_pages} onClick={() => onChangePage(page + 1)}>
        Próxima
      </Button>
    </div>
  );
}
