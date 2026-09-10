import { Badge } from "@/components/ui/badge";

import {
  formatPriceBRL,
  formatPropertyAddress,
  PROPERTY_STATUS_LABELS,
  PROPERTY_TYPE_LABELS,
  TRANSACTION_TYPE_LABELS,
} from "../lib/format-property-fields";
import type { PropertyDetail } from "../schemas/property.schema";
import { PropertyFeatures } from "./PropertyFeatures";

interface PropertyMainInfoProps {
  property: PropertyDetail;
}

// Reuses the same badges/labels/currency helper as `PropertyCard` (Prompt 038, sections 30/31)
// — never a second set of labels for the same enums.
export function PropertyMainInfo({ property }: PropertyMainInfoProps) {
  const address = formatPropertyAddress(property);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{PROPERTY_TYPE_LABELS[property.property_type]}</Badge>
        <Badge variant="outline">{TRANSACTION_TYPE_LABELS[property.transaction_type]}</Badge>
        <Badge variant="ghost">{PROPERTY_STATUS_LABELS[property.status]}</Badge>
      </div>

      <h1 className="text-2xl font-semibold">{property.title}</h1>
      <p className="text-2xl font-semibold">{formatPriceBRL(property.price)}</p>

      {address && <p className="text-muted-foreground">{address}</p>}

      <PropertyFeatures property={property} />

      {/* Empty/null description never renders a block (Prompt 038, section 33). */}
      {property.description && <p className="whitespace-pre-line">{property.description}</p>}
    </div>
  );
}
