import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { PropertyStatus } from "@/features/properties/schemas/property.schema";

import { useCapturePropertyLead } from "../hooks/use-capture-property-lead";
import { mapPublicLeadCaptureError } from "../lib/map-public-lead-capture-error";
import {
  EMPTY_PROPERTY_INTEREST_FORM_VALUES,
  propertyInterestFormSchema,
  type PropertyInterestFormOutput,
  type PropertyInterestFormValues,
} from "../schemas/property-interest-form.schema";

interface PropertyInterestFormProps {
  tenantId: string;
  propertyId: string;
  status: PropertyStatus;
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
 * Public "Tenho interesse" form on `/properties/:id` (Prompt 046, sections 3-5). Owns its own
 * form state/validation/submit/success/error — `PropertyDetailsPage` only passes
 * `tenantId`/`propertyId`/`status` and never touches submit logic (section 5).
 *
 * Uses exclusively `capturePropertyLead()` (via `useCapturePropertyLead`) — never the
 * administrative `createLead()` (section 34) — and only ever sends `name`/`email`/`phone`/
 * `message` (section 9/35/36/37).
 *
 * Available only when `status === "ACTIVE"` (section 29/30/31); DRAFT/INACTIVE render a discreet
 * unavailable state instead of hiding the section entirely (section 32). The backend remains the
 * authority either way (section 33) — a stale-ACTIVE submit that the backend now rejects with 404
 * still surfaces through `mapPublicLeadCaptureError`, same as any other 404.
 */
export function PropertyInterestForm({ tenantId, propertyId, status }: PropertyInterestFormProps) {
  const mutation = useCapturePropertyLead(tenantId, propertyId);
  const [succeeded, setSucceeded] = useState(false);

  const form = useForm<PropertyInterestFormValues, unknown, PropertyInterestFormOutput>({
    resolver: zodResolver(propertyInterestFormSchema),
    defaultValues: EMPTY_PROPERTY_INTEREST_FORM_VALUES,
    mode: "onBlur",
  });
  const { register, formState } = form;
  const { errors } = formState;

  if (status !== "ACTIVE") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Tenho interesse</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Este imóvel não está disponível para novos contatos.
          </p>
        </CardContent>
      </Card>
    );
  }

  async function handleValid(data: PropertyInterestFormOutput) {
    // Belt-and-suspenders alongside the disabled submit button (section 18) — a second submit
    // attempt while one is already in flight is a no-op, never a second request.
    if (mutation.isPending) {
      return;
    }

    try {
      await mutation.mutateAsync(data);
      toast.success("Interesse enviado com sucesso.");
      setSucceeded(true);
      form.reset();
    } catch {
      // Surfaced below via `mutation.isError`/`mapPublicLeadCaptureError` — never rethrown, never
      // logged (section 47: no PII, and the error itself carries none either).
    }
  }

  if (succeeded) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Tenho interesse</CardTitle>
        </CardHeader>
        <CardContent>
          <div aria-live="polite" className="flex flex-col gap-1">
            <p className="font-medium">Interesse enviado com sucesso.</p>
            <p className="text-sm text-muted-foreground">
              Recebemos seu interesse. A equipe responsável poderá entrar em contato pelos dados
              informados.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const submitError = mutation.isError ? mapPublicLeadCaptureError(mutation.error) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tenho interesse</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(handleValid)} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="interest-name">Nome</Label>
            <Input
              id="interest-name"
              autoComplete="name"
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? "interest-name-error" : undefined}
              {...register("name")}
            />
            <FieldError id="interest-name-error" message={errors.name?.message} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="interest-email">E-mail</Label>
            <Input
              id="interest-email"
              type="email"
              autoComplete="email"
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? "interest-email-error" : undefined}
              {...register("email")}
            />
            <FieldError id="interest-email-error" message={errors.email?.message} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="interest-phone">Telefone</Label>
            <Input
              id="interest-phone"
              inputMode="tel"
              autoComplete="tel"
              aria-invalid={Boolean(errors.phone)}
              aria-describedby={errors.phone ? "interest-phone-error" : undefined}
              {...register("phone")}
            />
            <FieldError id="interest-phone-error" message={errors.phone?.message} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="interest-message">Mensagem</Label>
            <Textarea
              id="interest-message"
              rows={3}
              placeholder="Gostaria de saber mais sobre este imóvel."
              aria-invalid={Boolean(errors.message)}
              aria-describedby={errors.message ? "interest-message-error" : undefined}
              {...register("message")}
            />
            <FieldError id="interest-message-error" message={errors.message?.message} />
          </div>

          {submitError && (
            <p role="alert" className="text-sm text-destructive">
              {submitError}
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            Ao enviar, seus dados serão usados para contato sobre este imóvel.
          </p>

          <Button type="submit" disabled={mutation.isPending} className="w-full sm:w-fit">
            {mutation.isPending ? "Enviando..." : "Enviar interesse"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
