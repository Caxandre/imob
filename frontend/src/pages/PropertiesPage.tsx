import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";

import { Button } from "@/components/ui/button";
import { env } from "@/lib/env";

import { PropertiesEmptyState } from "@/features/properties/components/PropertiesEmptyState";
import { PropertiesErrorState } from "@/features/properties/components/PropertiesErrorState";
import { PropertyCard } from "@/features/properties/components/PropertyCard";
import { PropertyCardSkeleton } from "@/features/properties/components/PropertyCardSkeleton";
import {
  PropertyFilterForm,
  type VisibleFilters,
} from "@/features/properties/components/PropertyFilterForm";
import { PropertyPagination } from "@/features/properties/components/PropertyPagination";
import { PropertySortSelect } from "@/features/properties/components/PropertySortSelect";
import { TenantNotConfiguredState } from "@/features/properties/components/TenantNotConfiguredState";
import { useProperties } from "@/features/properties/hooks/use-properties";
import {
  hasActiveFilters,
  parsePropertyFilters,
  serializePropertyFilters,
  type PropertyFilters,
  type PropertySortField,
  type SortOrder,
} from "@/features/properties/schemas/property-filters.schema";

const SKELETON_COUNT = 6;

/**
 * `/properties` (Prompt 037B, section 6): URL → parsed filters → `useProperties` → UI. Never
 * calls `fetch()` directly — all HTTP goes through `useProperties` → `listProperties` →
 * `apiFetch`. The tenant check happens here, before anything else mounts, so a missing/invalid
 * `VITE_TENANT_ID` never results in a request (section 61) — `PropertiesPageContent` (which
 * calls `useProperties`) is only ever mounted once a tenant id is known to exist.
 */
export function PropertiesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parsePropertyFilters(searchParams), [searchParams]);

  if (env.tenantId === undefined) {
    return <TenantNotConfiguredState />;
  }

  function applyFilters(visibleFilters: VisibleFilters) {
    // Section 43: applying filters always resets to the default (first) page.
    setSearchParams(serializePropertyFilters({ ...filters, ...visibleFilters, page: undefined }));
  }

  function changeSort(sort: PropertySortField, order: SortOrder) {
    setSearchParams(serializePropertyFilters({ ...filters, sort, order, page: undefined }));
  }

  function changePage(page: number) {
    setSearchParams(serializePropertyFilters({ ...filters, page }));
  }

  function clearFilters() {
    setSearchParams(new URLSearchParams());
  }

  return (
    <PropertiesPageContent
      tenantId={env.tenantId}
      filters={filters}
      onApplyFilters={applyFilters}
      onChangeSort={changeSort}
      onChangePage={changePage}
      onClearFilters={clearFilters}
    />
  );
}

interface PropertiesPageContentProps {
  tenantId: string;
  filters: PropertyFilters;
  onApplyFilters: (filters: VisibleFilters) => void;
  onChangeSort: (sort: PropertySortField, order: SortOrder) => void;
  onChangePage: (page: number) => void;
  onClearFilters: () => void;
}

function PropertiesPageContent({
  tenantId,
  filters,
  onApplyFilters,
  onChangeSort,
  onChangePage,
  onClearFilters,
}: PropertiesPageContentProps) {
  const query = useProperties(tenantId, filters);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Imóveis</h1>
        <Button asChild>
          <Link to="/properties/new">Novo imóvel</Link>
        </Button>
      </div>

      <div className="flex flex-col gap-4 rounded-xl border p-4">
        <PropertyFilterForm filters={filters} onApply={onApplyFilters} onClear={onClearFilters} />
        <PropertySortSelect sort={filters.sort} order={filters.order} onChange={onChangeSort} />
      </div>

      {query.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: SKELETON_COUNT }, (_, index) => (
            <PropertyCardSkeleton key={index} />
          ))}
        </div>
      ) : query.isError ? (
        <PropertiesErrorState onRetry={() => query.refetch()} />
      ) : query.data.data.length === 0 ? (
        <PropertiesEmptyState hasActiveFilters={hasActiveFilters(filters)} />
      ) : (
        <>
          {query.isFetching && <p className="text-sm text-muted-foreground">Atualizando...</p>}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {query.data.data.map((property) => (
              <PropertyCard key={property.id} property={property} />
            ))}
          </div>
          <PropertyPagination pagination={query.data.pagination} onChangePage={onChangePage} />
        </>
      )}
    </main>
  );
}
