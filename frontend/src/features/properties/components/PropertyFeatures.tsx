import { BedDouble, Car, Ruler, ShowerHead } from "lucide-react";

import { formatAreaM2 } from "../lib/format-property-fields";
import type { PropertyDetail } from "../schemas/property.schema";

interface PropertyFeaturesProps {
  property: PropertyDetail;
}

interface Feature {
  icon: typeof BedDouble;
  label: string;
  value: string;
}

// Only non-null fields render (Prompt 038, section 34/55) — never "0 quartos" for an absent value.
export function PropertyFeatures({ property }: PropertyFeaturesProps) {
  const area = formatAreaM2(property.area_m2);

  const features: Feature[] = [
    property.bedrooms !== null
      ? { icon: BedDouble, label: "Quartos", value: String(property.bedrooms) }
      : null,
    property.bathrooms !== null
      ? { icon: ShowerHead, label: "Banheiros", value: String(property.bathrooms) }
      : null,
    property.parking_spaces !== null
      ? { icon: Car, label: "Vagas", value: String(property.parking_spaces) }
      : null,
    area !== null ? { icon: Ruler, label: "Área", value: area } : null,
  ].filter((feature): feature is Feature => feature !== null);

  if (features.length === 0) {
    return null;
  }

  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {features.map((feature) => (
        <div
          key={feature.label}
          className="flex flex-col items-center gap-1 rounded-lg border p-3 text-center"
        >
          <feature.icon className="size-5 text-muted-foreground" aria-hidden="true" />
          <dd className="font-medium">{feature.value}</dd>
          <dt className="text-xs text-muted-foreground">{feature.label}</dt>
        </div>
      ))}
    </dl>
  );
}
