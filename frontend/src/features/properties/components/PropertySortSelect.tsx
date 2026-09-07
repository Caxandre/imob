import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { PropertySortField, SortOrder } from "../schemas/property-filters.schema";

type SortOption = { value: string; label: string; sort: PropertySortField; order: SortOrder };

/**
 * The four options exposed visually (section 46), mapped to the backend's real `sort`/`order`
 * params (section 47) — the backend itself uses `sort`/`order`, not `sort`/`direction`.
 */
const DEFAULT_OPTION: SortOption = {
  value: "created_at:desc",
  label: "Mais recentes",
  sort: "created_at",
  order: "desc",
};

const SORT_OPTIONS: SortOption[] = [
  DEFAULT_OPTION,
  { value: "price:asc", label: "Menor preço", sort: "price", order: "asc" },
  { value: "price:desc", label: "Maior preço", sort: "price", order: "desc" },
  { value: "area_m2:desc", label: "Maior área", sort: "area_m2", order: "desc" },
];

interface PropertySortSelectProps {
  sort: PropertySortField | undefined;
  order: SortOrder | undefined;
  onChange: (sort: PropertySortField, order: SortOrder) => void;
}

export function PropertySortSelect({ sort, order, onChange }: PropertySortSelectProps) {
  const current =
    SORT_OPTIONS.find((option) => option.sort === sort && option.order === order) ?? DEFAULT_OPTION;

  function handleChange(value: string) {
    const option = SORT_OPTIONS.find((candidate) => candidate.value === value) ?? DEFAULT_OPTION;
    onChange(option.sort, option.order);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="property-sort">Ordenar por</Label>
      <Select value={current.value} onValueChange={handleChange}>
        <SelectTrigger id="property-sort" className="w-full sm:w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
