import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PROPERTY_STATUS_LABELS } from "@/features/properties/lib/format-property-fields";

import { usePropertyOptions } from "../hooks/use-property-options";
import { LEAD_SOURCE_LABELS, LEAD_STATUS_LABELS } from "../lib/format-lead-fields";
import {
  leadFormSchema,
  NO_PROPERTY_VALUE,
  type LeadFormOutput,
  type LeadFormValues,
} from "../schemas/lead-form.schema";
import { leadSourceSchema, leadStatusSchema, type LeadPropertySummary } from "../schemas/lead.schema";

interface LeadFormProps {
  mode: "create" | "edit";
  tenantId: string;
  defaultValues: LeadFormValues;
  // The lead's own already-loaded property summary (edit mode only) — guarantees the select
  // always has an option for the currently associated property even if it falls outside the
  // bounded `usePropertyOptions` page or that fetch fails (section 47/48). Never a second
  // request: this is data the caller already has from `useLead`.
  initialPropertySummary?: LeadPropertySummary | null;
  onSubmit: (
    values: LeadFormOutput,
    dirtyFields: Partial<Record<keyof LeadFormOutput, unknown>>,
  ) => void | Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
  submitError?: string | null;
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) {
    return null;
  }
  return (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  );
}

/**
 * Reusable across `/leads/new` and `/leads/:id/edit` (Prompt 044, section 40) — a single typed
 * form, never duplicated between create/edit. `defaultValues` is set once at mount (React Hook
 * Form's uncontrolled `defaultValues`, never the controlled `values` prop) — the edit page
 * hydrates it once from the loaded lead and never resyncs it on a background refetch, so an
 * in-progress edit is never overwritten (same convention as `PropertyForm`).
 */
export function LeadForm({
  mode,
  tenantId,
  defaultValues,
  initialPropertySummary,
  onSubmit,
  onCancel,
  isSubmitting,
  submitError,
}: LeadFormProps) {
  const propertyOptionsQuery = usePropertyOptions(tenantId);

  const form = useForm<LeadFormValues, unknown, LeadFormOutput>({
    resolver: zodResolver(leadFormSchema),
    defaultValues,
    mode: "onBlur",
  });
  const { register, control, formState } = form;
  const { errors, isDirty } = formState;

  function handleValid(data: LeadFormOutput) {
    return onSubmit(data, formState.dirtyFields);
  }

  // Edit mode with nothing changed: the button is disabled rather than letting a no-op submit
  // reach the API (section 62) — PATCH would reject an empty body anyway.
  const saveDisabled = isSubmitting || (mode === "edit" && !isDirty);

  const fetchedOptions = propertyOptionsQuery.data?.options ?? [];
  // Guarantees the currently-associated property always has an option, even if it fell outside
  // the bounded page or the fetch failed (section 47/48) — never silently drops the existing
  // selection.
  const propertyOptions =
    initialPropertySummary && !fetchedOptions.some((option) => option.id === initialPropertySummary.id)
      ? [initialPropertySummary, ...fetchedOptions]
      : fetchedOptions;

  return (
    <form onSubmit={form.handleSubmit(handleValid)} className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Informações do lead</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lead-name">Nome *</Label>
            <Input
              id="lead-name"
              autoComplete="off"
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? "lead-name-error" : undefined}
              {...register("name")}
            />
            <FieldError id="lead-name-error" message={errors.name?.message} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="lead-email">E-mail</Label>
              <Input
                id="lead-email"
                type="email"
                autoComplete="off"
                aria-invalid={Boolean(errors.email)}
                aria-describedby={errors.email ? "lead-email-error" : undefined}
                {...register("email")}
              />
              <FieldError id="lead-email-error" message={errors.email?.message} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="lead-phone">Telefone</Label>
              <Input
                id="lead-phone"
                inputMode="tel"
                autoComplete="off"
                aria-invalid={Boolean(errors.phone)}
                aria-describedby={errors.phone ? "lead-phone-error" : undefined}
                {...register("phone")}
              />
              <FieldError id="lead-phone-error" message={errors.phone?.message} />
            </div>
          </div>

          <div className={`grid gap-4 ${mode === "edit" ? "sm:grid-cols-2" : "sm:grid-cols-1"}`}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="lead-source">Origem</Label>
              <Controller
                control={control}
                name="source"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="lead-source" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
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

            {/* Status is only editable in edit mode (section 42/57): the backend always
                creates a lead as NEW, and unlike Properties there is no lifecycle/state
                machine restricting which transitions are allowed — PATCH accepts any status
                from any status, so a plain select is the correct, honest representation here
                (no separate "Convert"/"Lose" actions to invent). */}
            {mode === "edit" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lead-status">Status</Label>
                <Controller
                  control={control}
                  name="status"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="lead-status" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
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
            )}
          </div>

          <div className="flex flex-col gap-1.5 sm:w-80">
            <Label htmlFor="lead-property">Imóvel (opcional)</Label>
            <Controller
              control={control}
              name="property_id"
              render={({ field }) => (
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={propertyOptionsQuery.isPending}
                >
                  <SelectTrigger id="lead-property" className="w-full">
                    <SelectValue
                      placeholder={propertyOptionsQuery.isPending ? "Carregando imóveis..." : undefined}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PROPERTY_VALUE}>Nenhum imóvel</SelectItem>
                    {propertyOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.status === "ACTIVE"
                          ? option.title
                          : `${option.title} (${PROPERTY_STATUS_LABELS[option.status]})`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {propertyOptionsQuery.isError && (
              <p className="text-xs text-muted-foreground">
                Não foi possível carregar a lista de imóveis.
              </p>
            )}
            {propertyOptionsQuery.data?.truncated && (
              <p className="text-xs text-muted-foreground">
                Mostrando os {propertyOptionsQuery.data.options.length} imóveis mais recentes.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lead-message">Mensagem</Label>
            <Textarea id="lead-message" rows={3} {...register("message")} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lead-notes">Observação</Label>
            <Textarea id="lead-notes" rows={3} {...register("notes")} />
          </div>
        </CardContent>
      </Card>

      {submitError && <p className="text-sm text-destructive">{submitError}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={saveDisabled}>
          {isSubmitting ? "Salvando..." : "Salvar"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
