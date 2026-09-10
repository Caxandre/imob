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

import {
  PROPERTY_STATUS_LABELS,
  PROPERTY_TYPE_LABELS,
  TRANSACTION_TYPE_LABELS,
} from "../lib/format-property-fields";
import {
  propertyFormSchema,
  type PropertyFormOutput,
  type PropertyFormValues,
} from "../schemas/property-form.schema";
import {
  propertyStatusSchema,
  propertyTypeSchema,
  transactionTypeSchema,
} from "../schemas/property.schema";

interface PropertyFormProps {
  mode: "create" | "edit";
  defaultValues: PropertyFormValues;
  onSubmit: (
    values: PropertyFormOutput,
    dirtyFields: Partial<Record<keyof PropertyFormOutput, unknown>>,
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
 * Reusable across `/properties/new` and `/properties/:id/edit` (Prompt 040, section 9) — a
 * single typed form, never duplicated between create/edit. `defaultValues` is set once at
 * mount (React Hook Form's uncontrolled `defaultValues`, never the controlled `values` prop) —
 * the edit page hydrates it once from the loaded property and never resyncs it on a background
 * refetch, so an in-progress edit is never overwritten (section 44/45).
 */
export function PropertyForm({
  mode,
  defaultValues,
  onSubmit,
  onCancel,
  isSubmitting,
  submitError,
}: PropertyFormProps) {
  const form = useForm<PropertyFormValues, unknown, PropertyFormOutput>({
    resolver: zodResolver(propertyFormSchema),
    defaultValues,
    mode: "onBlur",
  });
  const { register, control, formState } = form;
  const { errors, isDirty } = formState;

  function handleValid(data: PropertyFormOutput) {
    return onSubmit(data, formState.dirtyFields);
  }

  // Edit mode with nothing changed: the button is disabled rather than letting a no-op submit
  // reach the API (section 29) — PATCH would reject an empty body anyway.
  const saveDisabled = isSubmitting || (mode === "edit" && !isDirty);

  return (
    <form onSubmit={form.handleSubmit(handleValid)} className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Informações principais</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="property-title">Título *</Label>
            <Input
              id="property-title"
              autoComplete="off"
              aria-invalid={Boolean(errors.title)}
              aria-describedby={errors.title ? "property-title-error" : undefined}
              {...register("title")}
            />
            <FieldError id="property-title-error" message={errors.title?.message} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="property-description">Descrição</Label>
            <Textarea
              id="property-description"
              rows={4}
              aria-invalid={Boolean(errors.description)}
              aria-describedby={errors.description ? "property-description-error" : undefined}
              {...register("description")}
            />
            <FieldError id="property-description-error" message={errors.description?.message} />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="property-type">Tipo *</Label>
              <Controller
                control={control}
                name="property_type"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="property-type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {propertyTypeSchema.options.map((value) => (
                        <SelectItem key={value} value={value}>
                          {PROPERTY_TYPE_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="property-transaction-type">Transação *</Label>
              <Controller
                control={control}
                name="transaction_type"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="property-transaction-type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {transactionTypeSchema.options.map((value) => (
                        <SelectItem key={value} value={value}>
                          {TRANSACTION_TYPE_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="property-status">Status *</Label>
              <Controller
                control={control}
                name="status"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="property-status" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {propertyStatusSchema.options.map((value) => (
                        <SelectItem key={value} value={value}>
                          {PROPERTY_STATUS_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5 sm:w-56">
            <Label htmlFor="property-price">Preço *</Label>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-sm text-muted-foreground">
                R$
              </span>
              <Input
                id="property-price"
                inputMode="decimal"
                placeholder="450.000,00"
                aria-invalid={Boolean(errors.price)}
                aria-describedby={errors.price ? "property-price-error" : undefined}
                {...register("price")}
              />
            </div>
            <FieldError id="property-price-error" message={errors.price?.message} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Características</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="property-bedrooms">Quartos</Label>
            <Input
              id="property-bedrooms"
              inputMode="numeric"
              aria-invalid={Boolean(errors.bedrooms)}
              aria-describedby={errors.bedrooms ? "property-bedrooms-error" : undefined}
              {...register("bedrooms")}
            />
            <FieldError id="property-bedrooms-error" message={errors.bedrooms?.message} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="property-bathrooms">Banheiros</Label>
            <Input
              id="property-bathrooms"
              inputMode="numeric"
              aria-invalid={Boolean(errors.bathrooms)}
              aria-describedby={errors.bathrooms ? "property-bathrooms-error" : undefined}
              {...register("bathrooms")}
            />
            <FieldError id="property-bathrooms-error" message={errors.bathrooms?.message} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="property-parking-spaces">Vagas</Label>
            <Input
              id="property-parking-spaces"
              inputMode="numeric"
              aria-invalid={Boolean(errors.parking_spaces)}
              aria-describedby={errors.parking_spaces ? "property-parking-spaces-error" : undefined}
              {...register("parking_spaces")}
            />
            <FieldError
              id="property-parking-spaces-error"
              message={errors.parking_spaces?.message}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="property-area">Área (m²)</Label>
            <Input
              id="property-area"
              inputMode="decimal"
              placeholder="92,50"
              aria-invalid={Boolean(errors.area_m2)}
              aria-describedby={errors.area_m2 ? "property-area-error" : undefined}
              {...register("area_m2")}
            />
            <FieldError id="property-area-error" message={errors.area_m2?.message} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Localização</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="property-street">Rua</Label>
            <Input id="property-street" autoComplete="address-line1" {...register("street")} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="property-number">Número</Label>
            <Input id="property-number" {...register("number")} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="property-complement">Complemento</Label>
            <Input
              id="property-complement"
              autoComplete="address-line2"
              {...register("complement")}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="property-neighborhood">Bairro</Label>
            <Input id="property-neighborhood" {...register("neighborhood")} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="property-city">Cidade</Label>
            <Input id="property-city" autoComplete="address-level2" {...register("city")} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="property-state">Estado (UF)</Label>
            <Input
              id="property-state"
              maxLength={2}
              autoComplete="address-level1"
              aria-invalid={Boolean(errors.state)}
              aria-describedby={errors.state ? "property-state-error" : undefined}
              {...register("state")}
            />
            <FieldError id="property-state-error" message={errors.state?.message} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="property-postal-code">CEP</Label>
            <Input
              id="property-postal-code"
              autoComplete="postal-code"
              {...register("postal_code")}
            />
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
