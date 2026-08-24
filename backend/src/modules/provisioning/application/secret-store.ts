/**
 * The credential a tenant's application role connects with. Deliberately excludes host and
 * database — those belong to the cluster/tenant_databases registry, not the secret itself.
 */
export interface TenantDatabaseSecret {
  username: string;
  password: string;
}

/**
 * Stores and retrieves tenant database credentials by reference (ADR-003). No production
 * implementation exists yet — see provisioning's test-support directory for a fake used only
 * in tests. Never store a real secret in plaintext on disk.
 */
export interface SecretStore {
  put(secretReference: string, secret: TenantDatabaseSecret): Promise<void>;
  get(secretReference: string): Promise<TenantDatabaseSecret | undefined>;
  delete(secretReference: string): Promise<void>;
}
