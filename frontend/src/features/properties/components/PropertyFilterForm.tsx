import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { PROPERTY_TYPE_LABELS, TRANSACTION_TYPE_LABELS } from "../lib/format-property-fields";
import { propertyFiltersSchema, type PropertyFilters } from "../schemas/property-filters.schema";
import { propertyTypeSchema, transactionTypeSchema } from "../schemas/property.schema";

/** The subset of filters this form controls (section 39) — everything else (status,
 * bathrooms_min, parking_spaces_min, area_min/area_max, sort, order, page) stays parseable via
 * the URL/API without a visible control (section 40) and is left untouched on submit. */
export type VisibleFilters = Pick<
  PropertyFilters,
  | "q"
  | "property_type"
  | "transaction_type"
  | "city"
  | "state"
  | "price_min"
  | "price_max"
  | "bedrooms_min"
>;

const ALL_VALUE = "all";

/**
 * Form-level validation (React Hook Form + Zod, section 38): light per-field checks that give
 * the user real inline feedback for a clearly wrong value (e.g. "abc" in a price field), while
 * every field stays optional. The heavier job of turning raw strings into a normalized
 * `PropertyFilters` (trimming, uppercasing the UF, string→number) is delegated to
 * `propertyFiltersSchema` on submit — the same schema URL parsing uses — so there is exactly one
 * definition of "what a valid filter value looks like".
 */
const formSchema = z.object({
  q: z.string().max(120, "Máximo de 120 caracteres"),
  property_type: z.union([propertyTypeSchema, z.literal(ALL_VALUE)]),
  transaction_type: z.union([transactionTypeSchema, z.literal(ALL_VALUE)]),
  city: z.string().max(200, "Máximo de 200 caracteres"),
  state: z.string().refine((value) => value === "" || /^[A-Za-z]{2}$/.test(value), {
    message: "UF deve ter 2 letras",
  }),
  price_min: z.string().refine((value) => value === "" || /^\d+(\.\d{1,2})?$/.test(value), {
    message: "Valor inválido",
  }),
  price_max: z.string().refine((value) => value === "" || /^\d+(\.\d{1,2})?$/.test(value), {
    message: "Valor inválido",
  }),
  bedrooms_min: z.string().refine((value) => value === "" || /^\d+$/.test(value), {
    message: "Deve ser um número inteiro",
  }),
});
type FormValues = z.infer<typeof formSchema>;

function toFormValues(filters: VisibleFilters): FormValues {
  return {
    q: filters.q ?? "",
    property_type: filters.property_type ?? ALL_VALUE,
    transaction_type: filters.transaction_type ?? ALL_VALUE,
    city: filters.city ?? "",
    state: filters.state ?? "",
    price_min: filters.price_min ?? "",
    price_max: filters.price_max ?? "",
    bedrooms_min: filters.bedrooms_min !== undefined ? String(filters.bedrooms_min) : "",
  };
}

function toVisibleFilters(values: FormValues): VisibleFilters {
  return propertyFiltersSchema
    .pick({
      q: true,
      property_type: true,
      transaction_type: true,
      city: true,
      state: true,
      price_min: true,
      price_max: true,
      bedrooms_min: true,
    })
    .parse({
      ...values,
      property_type: values.property_type === ALL_VALUE ? "" : values.property_type,
      transaction_type: values.transaction_type === ALL_VALUE ? "" : values.transaction_type,
    });
}

interface PropertyFilterFormProps {
  filters: VisibleFilters;
  onApply: (filters: VisibleFilters) => void;
  onClear: () => void;
}

export function PropertyFilterForm({ filters, onApply, onClear }: PropertyFilterFormProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    // Keeps the form synced whenever the URL changes from outside it — back/forward/manual edit
    // (section 45) — instead of only seeding an initial value.
    values: toFormValues(filters),
  });

  function onSubmit(values: FormValues) {
    onApply(toVisibleFilters(values));
  }

  return (
    <form
      onSubmit={form.handleSubmit(onSubmit)}
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="property-filter-q">Busca</Label>
        <Input
          id="property-filter-q"
          placeholder="Título, bairro, cidade..."
          {...form.register("q")}
        />
        {form.formState.errors.q && (
          <p className="text-xs text-destructive">{form.formState.errors.q.message}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="property-filter-type">Tipo</Label>
        <Controller
          control={form.control}
          name="property_type"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="property-filter-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE}>Todos</SelectItem>
                {Object.entries(PROPERTY_TYPE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="property-filter-transaction">Transação</Label>
        <Controller
          control={form.control}
          name="transaction_type"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="property-filter-transaction" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE}>Todas</SelectItem>
                {Object.entries(TRANSACTION_TYPE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="property-filter-city">Cidade</Label>
        <Input id="property-filter-city" {...form.register("city")} />
        {form.formState.errors.city && (
          <p className="text-xs text-destructive">{form.formState.errors.city.message}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="property-filter-state">Estado (UF)</Label>
        <Input id="property-filter-state" maxLength={2} {...form.register("state")} />
        {form.formState.errors.state && (
          <p className="text-xs text-destructive">{form.formState.errors.state.message}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="property-filter-price-min">Preço mínimo</Label>
        <Input id="property-filter-price-min" inputMode="decimal" {...form.register("price_min")} />
        {form.formState.errors.price_min && (
          <p className="text-xs text-destructive">{form.formState.errors.price_min.message}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="property-filter-price-max">Preço máximo</Label>
        <Input id="property-filter-price-max" inputMode="decimal" {...form.register("price_max")} />
        {form.formState.errors.price_max && (
          <p className="text-xs text-destructive">{form.formState.errors.price_max.message}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="property-filter-bedrooms-min">Quartos mínimos</Label>
        <Input
          id="property-filter-bedrooms-min"
          inputMode="numeric"
          {...form.register("bedrooms_min")}
        />
        {form.formState.errors.bedrooms_min && (
          <p className="text-xs text-destructive">{form.formState.errors.bedrooms_min.message}</p>
        )}
      </div>

      <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
        <Button type="submit">Aplicar filtros</Button>
        <Button type="button" variant="outline" onClick={onClear}>
          Limpar filtros
        </Button>
      </div>
    </form>
  );
}
