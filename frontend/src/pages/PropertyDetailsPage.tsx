import { Link, useParams } from "react-router";

import { Button } from "@/components/ui/button";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/http/api-error";

import { PropertyDetailsErrorState } from "@/features/properties/components/PropertyDetailsErrorState";
import { PropertyDetailsSkeleton } from "@/features/properties/components/PropertyDetailsSkeleton";
import { PropertyGallery } from "@/features/properties/components/PropertyGallery";
import { PropertyGalleryErrorState } from "@/features/properties/components/PropertyGalleryErrorState";
import { PropertyGallerySkeleton } from "@/features/properties/components/PropertyGallerySkeleton";
import { PropertyMainInfo } from "@/features/properties/components/PropertyMainInfo";
import { PropertyNotFoundState } from "@/features/properties/components/PropertyNotFoundState";
import { TenantNotConfiguredState } from "@/features/properties/components/TenantNotConfiguredState";
import { useProperty } from "@/features/properties/hooks/use-property";
import { usePropertyMedia } from "@/features/properties/hooks/use-property-media";
import { isValidPropertyId } from "@/features/properties/lib/is-valid-property-id";

/**
 * `/properties/:id` (Prompt 038, section 6): route param → hooks → composition. Never fetches
 * directly. The id is validated as a UUID and the tenant is checked *before* anything that could
 * fire a request mounts (sections 7/48) — an invalid id or a missing tenant never results in a
 * network call.
 */
export function PropertyDetailsPage() {
  const { id } = useParams();

  if (!isValidPropertyId(id)) {
    return <PropertyNotFoundState />;
  }

  if (env.tenantId === undefined) {
    return <TenantNotConfiguredState />;
  }

  return <PropertyDetailsPageContent tenantId={env.tenantId} propertyId={id} />;
}

interface PropertyDetailsPageContentProps {
  tenantId: string;
  propertyId: string;
}

function PropertyDetailsPageContent({ tenantId, propertyId }: PropertyDetailsPageContentProps) {
  // Mounted together so both requests fire in parallel (Prompt 038, section 12) — never
  // property-then-media in sequence.
  const propertyQuery = useProperty(tenantId, propertyId);
  const mediaQuery = usePropertyMedia(tenantId, propertyId);

  if (propertyQuery.isPending) {
    return <PropertyDetailsSkeleton />;
  }

  if (propertyQuery.isError) {
    if (propertyQuery.error instanceof ApiError && propertyQuery.error.status === 404) {
      return <PropertyNotFoundState />;
    }
    return <PropertyDetailsErrorState onRetry={() => propertyQuery.refetch()} />;
  }

  const property = propertyQuery.data;

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <Button asChild variant="ghost" className="w-fit">
          <Link to="/properties">Voltar para imóveis</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to={`/properties/${propertyId}/edit`}>Editar</Link>
        </Button>
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <div>
          {mediaQuery.isPending ? (
            <PropertyGallerySkeleton />
          ) : mediaQuery.isError ? (
            <PropertyGalleryErrorState onRetry={() => mediaQuery.refetch()} />
          ) : (
            <PropertyGallery media={mediaQuery.data.data} title={property.title} />
          )}
        </div>

        <PropertyMainInfo property={property} />
      </div>
    </main>
  );
}
