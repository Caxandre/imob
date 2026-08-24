/**
 * Stores and retrieves secrets by reference (ADR-003). Deliberately untyped at this
 * boundary: a real secrets provider (AWS Secrets Manager, Vault, ...) returns arbitrary
 * JSON it makes no compile-time promise about, so `SecretStore` must not assert a shape it
 * cannot guarantee. Callers validate the retrieved payload against a concrete schema (see
 * `database-credential.ts` and `cluster-admin-credential-resolver.ts`) — never cast it
 * unchecked. No production implementation exists yet; see the provisioning module's
 * test-support directory for a fake used only in tests/local development.
 */
export interface SecretStore {
  put(secretReference: string, value: unknown): Promise<void>;
  get(secretReference: string): Promise<unknown | undefined>;
  delete(secretReference: string): Promise<void>;
}
