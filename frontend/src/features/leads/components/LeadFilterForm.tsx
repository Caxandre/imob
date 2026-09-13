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

import { LEAD_SOURCE_LABELS, LEAD_STATUS_LABELS } from "../lib/format-lead-fields";
import { leadFiltersSchema, type LeadFilters } from "../schemas/lead-filters.schema";
import { leadSourceSchema, leadStatusSchema } from "../schemas/lead.schema";

/**
 * The subset of filters this form controls (Prompt 044, sections 16/19/20/21): `q`, `status`,
 * `source`, and the created-at date range. `property_id` is deliberately not a visual control
 * here (section 21, preference B) — the frontend still doesn't have a dedicated property lookup
 * endpoint, and a raw UUID input would be poor UX for a first version. It stays fully parseable
 * from the URL (`leadFiltersSchema`), so a link that already includes `property_id` keeps
 * working — this form just never renders a way to set it. `sort`/`order` are not exposed either
 * (section 16/71) — the backend's own default ordering is always used.
 */
export type VisibleFilters = Pick<
  LeadFilters,
  "q" | "status" | "source" | "created_from" | "created_to"
>;

const ALL_VALUE = "all";

const dateOnlySchema = z.string().refine((value) => value === "" || /^\d{4}-\d{2}-\d{2}$/.test(value), {
  message: "Data inválida",
});

const formSchema = z.object({
  q: z.string().max(120, "Máximo de 120 caracteres"),
  status: z.union([leadStatusSchema, z.literal(ALL_VALUE)]),
  source: z.union([leadSourceSchema, z.literal(ALL_VALUE)]),
  created_from: dateOnlySchema,
  created_to: dateOnlySchema,
});
type FormValues = z.infer<typeof formSchema>;

function toFormValues(filters: VisibleFilters): FormValues {
  return {
    q: filters.q ?? "",
    status: filters.status ?? ALL_VALUE,
    source: filters.source ?? ALL_VALUE,
    created_from: filters.created_from ?? "",
    created_to: filters.created_to ?? "",
  };
}

function toVisibleFilters(values: FormValues): VisibleFilters {
  return leadFiltersSchema.pick({ q: true, status: true, source: true, created_from: true, created_to: true }).parse({
    ...values,
    status: values.status === ALL_VALUE ? "" : values.status,
    source: values.source === ALL_VALUE ? "" : values.source,
  });
}

interface LeadFilterFormProps {
  filters: VisibleFilters;
  onApply: (filters: VisibleFilters) => void;
  onClear: () => void;
}

export function LeadFilterForm({ filters, onApply, onClear }: LeadFilterFormProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    // Keeps the form synced whenever the URL changes from outside it — same convention as
    // `PropertyFilterForm`.
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
      <div className="flex flex-col gap-1.5 lg:col-span-2">
        <Label htmlFor="lead-filter-q">Buscar por nome, email ou telefone</Label>
        <Input id="lead-filter-q" {...form.register("q")} />
        {form.formState.errors.q && (
          <p className="text-xs text-destructive">{form.formState.errors.q.message}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="lead-filter-status">Status</Label>
        <Controller
          control={form.control}
          name="status"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="lead-filter-status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE}>Todos</SelectItem>
                {leadStatusSchema.options.map((value) => (
                  <SelectItem key={value} value={value}>
                    {LEAD_STATUS_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="lead-filter-source">Origem</Label>
        <Controller
          control={form.control}
          name="source"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="lead-filter-source" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE}>Todas</SelectItem>
                {leadSourceSchema.options.map((value) => (
                  <SelectItem key={value} value={value}>
                    {LEAD_SOURCE_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="lead-filter-created-from">Criado a partir de</Label>
        <Input id="lead-filter-created-from" type="date" {...form.register("created_from")} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="lead-filter-created-to">Criado até</Label>
        <Input id="lead-filter-created-to" type="date" {...form.register("created_to")} />
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
