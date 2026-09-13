import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";

import { Button } from "@/components/ui/button";
import { env } from "@/lib/env";

import {
  LeadFilterForm,
  type VisibleFilters,
} from "@/features/leads/components/LeadFilterForm";
import { LeadPagination } from "@/features/leads/components/LeadPagination";
import { LeadsEmptyState } from "@/features/leads/components/LeadsEmptyState";
import { LeadsErrorState } from "@/features/leads/components/LeadsErrorState";
import { LeadsTableSkeleton } from "@/features/leads/components/LeadsTableSkeleton";
import { LeadTable } from "@/features/leads/components/LeadTable";
import { TenantNotConfiguredState } from "@/features/leads/components/TenantNotConfiguredState";
import { useLeads } from "@/features/leads/hooks/use-leads";
import {
  hasActiveLeadFilters,
  parseLeadFilters,
  serializeLeadFilters,
  type LeadFilters,
} from "@/features/leads/schemas/lead-filters.schema";

/**
 * `/leads` (Prompt 044, section 12/17): URL → parsed filters → `useLeads` → UI. Never calls
 * `fetch()` directly — all HTTP goes through `useLeads` → `listLeads` → `apiFetch`. The tenant
 * check happens here, before anything else mounts, so a missing/invalid `VITE_TENANT_ID` never
 * results in a request (same convention as `PropertiesPage`).
 */
export function LeadsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseLeadFilters(searchParams), [searchParams]);

  if (env.tenantId === undefined) {
    return <TenantNotConfiguredState />;
  }

  function applyFilters(visibleFilters: VisibleFilters) {
    // Applying filters always resets to the default (first) page.
    setSearchParams(serializeLeadFilters({ ...filters, ...visibleFilters, page: undefined }));
  }

  function changePage(page: number) {
    setSearchParams(serializeLeadFilters({ ...filters, page }));
  }

  function clearFilters() {
    setSearchParams(new URLSearchParams());
  }

  return (
    <LeadsPageContent
      tenantId={env.tenantId}
      filters={filters}
      onApplyFilters={applyFilters}
      onChangePage={changePage}
      onClearFilters={clearFilters}
    />
  );
}

interface LeadsPageContentProps {
  tenantId: string;
  filters: LeadFilters;
  onApplyFilters: (filters: VisibleFilters) => void;
  onChangePage: (page: number) => void;
  onClearFilters: () => void;
}

function LeadsPageContent({
  tenantId,
  filters,
  onApplyFilters,
  onChangePage,
  onClearFilters,
}: LeadsPageContentProps) {
  const query = useLeads(tenantId, filters);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Leads</h1>
        <Button asChild>
          <Link to="/leads/new">Novo lead</Link>
        </Button>
      </div>

      <div className="flex flex-col gap-4 rounded-xl border p-4">
        <LeadFilterForm filters={filters} onApply={onApplyFilters} onClear={onClearFilters} />
      </div>

      {query.isPending ? (
        <LeadsTableSkeleton />
      ) : query.isError ? (
        <LeadsErrorState onRetry={() => query.refetch()} />
      ) : query.data.data.length === 0 ? (
        <LeadsEmptyState hasActiveFilters={hasActiveLeadFilters(filters)} />
      ) : (
        <>
          {query.isFetching && <p className="text-sm text-muted-foreground">Atualizando...</p>}
          <LeadTable leads={query.data.data} />
          <LeadPagination pagination={query.data.pagination} onChangePage={onChangePage} />
        </>
      )}
    </main>
  );
}
