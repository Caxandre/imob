import { randomBytes } from "node:crypto";

import type { TenantDatabaseCredential } from "./database-credential.js";

/**
 * 32 bytes (256 bits) of `crypto.randomBytes` — comfortably more entropy than a PostgreSQL
 * credential needs to resist offline guessing, with room to spare. Not tied to tenantId or
 * any other input: two calls always produce independent, unrelated passwords.
 */
const PASSWORD_BYTES = 32;

/**
 * `base64url` (RFC 4648 §5): alphabet is `[A-Za-z0-9_-]` only — no `+`, `/`, or `=` padding
 * to escape, so the password is safe to hand to PostgreSQL client libraries and shell/env
 * contexts without extra quoting logic. Not intended to be human-typed; not embedded into a
 * connection string by this function.
 */
function generatePassword(): string {
  return randomBytes(PASSWORD_BYTES).toString("base64url");
}

/**
 * Generates a fresh tenant application role credential. `username` is always the
 * deterministic `roleName` produced by the Prompt 011 naming functions — never random.
 * `password` is freshly generated on every call; this function has no notion of "the
 * existing password for this role" and performs no I/O — see ADR-003 "Idempotency" for how a
 * future `DatabaseProvisioner` decides whether a new password is actually needed.
 */
export function createTenantDatabaseCredential(roleName: string): TenantDatabaseCredential {
  return {
    username: roleName,
    password: generatePassword(),
  };
}
