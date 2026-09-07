import { BedDouble, Car, ImageOff, Ruler, ShowerHead } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { getPropertyCardImage } from "../lib/get-property-card-image";
import {
  formatAreaM2,
  formatPriceBRL,
  PROPERTY_STATUS_LABELS,
  PROPERTY_TYPE_LABELS,
  TRANSACTION_TYPE_LABELS,
} from "../lib/format-property-fields";
import type { Property } from "../schemas/property.schema";

interface PropertyCardProps {
  property: Property;
}

/**
 * Pure presentational card (Prompt 037B, section 23) — no API call of its own, receives the
 * property via props. Only renders fields that actually came back from the API (section 24):
 * `bedrooms`/`bathrooms`/`parking_spaces` are omitted entirely when `null` rather than shown as
 * "0" (section 28), and `area_m2` only renders when present (section 29).
 */
export function PropertyCard({ property }: PropertyCardProps) {
  const imageUrl = getPropertyCardImage(property);
  const location = [property.city, property.state].filter(Boolean).join(" / ");
  const area = formatAreaM2(property.area_m2);

  return (
    <Card>
      <div className="aspect-4/3 w-full overflow-hidden bg-muted">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={property.title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <ImageOff className="size-8" aria-hidden="true" />
          </div>
        )}
      </div>

      <CardHeader>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{PROPERTY_TYPE_LABELS[property.property_type]}</Badge>
          <Badge variant="outline">{TRANSACTION_TYPE_LABELS[property.transaction_type]}</Badge>
          {/* Discreet operational status (section 25) — /properties is not the public catalog
              yet, so DRAFT/INACTIVE items are shown, never filtered out implicitly. */}
          <Badge variant="ghost">{PROPERTY_STATUS_LABELS[property.status]}</Badge>
        </div>
        <CardTitle>{property.title}</CardTitle>
        {location && <p className="text-sm text-muted-foreground">{location}</p>}
      </CardHeader>

      <CardContent className="flex flex-col gap-2">
        <p className="text-lg font-semibold">{formatPriceBRL(property.price)}</p>

        <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
          {property.bedrooms !== null && (
            <span className="flex items-center gap-1">
              <BedDouble className="size-4" aria-hidden="true" />
              {property.bedrooms}
            </span>
          )}
          {property.bathrooms !== null && (
            <span className="flex items-center gap-1">
              <ShowerHead className="size-4" aria-hidden="true" />
              {property.bathrooms}
            </span>
          )}
          {property.parking_spaces !== null && (
            <span className="flex items-center gap-1">
              <Car className="size-4" aria-hidden="true" />
              {property.parking_spaces}
            </span>
          )}
          {area && (
            <span className="flex items-center gap-1">
              <Ruler className="size-4" aria-hidden="true" />
              {area}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
