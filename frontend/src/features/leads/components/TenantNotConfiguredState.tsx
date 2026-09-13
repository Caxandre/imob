// Never shows the (missing) tenant UUID — just a short, actionable message. Shown instead of
// mounting any data-fetching component, so no request is ever made (Prompt 044, section 7).
// Feature-scoped copy of Properties' own component (CLAUDE.md: never mix Leads code into
// Properties, and vice versa).
export function TenantNotConfiguredState() {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-1 rounded-xl border border-dashed p-10 text-center">
        <p className="font-medium">Tenant de desenvolvimento não configurado.</p>
        <p className="text-sm text-muted-foreground">
          Defina <code>VITE_TENANT_ID</code> em <code>frontend/.env</code> para acessar os leads.
        </p>
      </div>
    </div>
  );
}
