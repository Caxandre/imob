import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { resolveBackendPath } from "../../../config/project-root.js";
import type { SecretStore } from "../application/secret-store.js";

const CURRENT_VERSION = 1;

interface SecretFileContents {
  version: number;
  secrets: Record<string, unknown>;
}

/**
 * Raised when the store file exists but its content isn't the expected `{ version, secrets }`
 * JSON shape (Prompt 039, section 15) — never returned as "secret not found", since that would
 * silently hide real data loss/corruption. The message never includes file content (only the
 * path and a fixed, non-sensitive reason).
 */
export class SecretStoreCorruptedError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Local secret store at "${filePath}" is corrupted: ${reason}`);
    this.name = "SecretStoreCorruptedError";
  }
}

/** Raised when the store file's `version` isn't one this code knows how to read (section 16) —
 * fail-fast rather than guess at an unknown format. */
export class UnsupportedSecretStoreVersionError extends Error {
  constructor(filePath: string, version: unknown) {
    super(
      `Local secret store at "${filePath}" has unsupported version ${JSON.stringify(version)} ` +
        `(expected ${CURRENT_VERSION})`,
    );
    this.name = "UnsupportedSecretStoreVersionError";
  }
}

// Local dev tool, not a production lock manager (section 19: "não construir um distributed lock
// framework") — tight retry loop over a lock *file*, not a lock *server*.
const LOCK_RETRY_DELAY_MS = 20;
const LOCK_ACQUIRE_TIMEOUT_MS = 5000;
// A lock file older than this is assumed to belong to a process that died while holding it
// (crash, kill -9) rather than one still legitimately working — our own read+write+fsync cycle
// takes single-digit milliseconds, so this is generous, not tight.
const LOCK_STALE_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;

  for (;;) {
    try {
      // "wx": exclusive create — fails with EEXIST if the lock file already exists. This is the
      // atomic primitive the whole scheme relies on (section 18).
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      // Lock file exists — is it stale (holder died) or fresh (holder still working)?
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue; // retry acquiring immediately — never steal a fresh lock (section 52).
        }
      } catch {
        // Lock file vanished between our EEXIST and this stat (the holder released it) — just
        // fall through to the retry delay and try acquiring again.
      }

      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for the local secret store lock at "${lockPath}"`, {
          cause: error,
        });
      }
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStore(filePath: string): Promise<SecretFileContents> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    // Missing file (never written yet, or the whole .local/ directory doesn't exist) is not an
    // infrastructure error — it's just an empty store (section 14).
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: CURRENT_VERSION, secrets: {} };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SecretStoreCorruptedError(filePath, "content is not valid JSON");
  }

  if (!isRecord(parsed) || !isRecord(parsed.secrets)) {
    throw new SecretStoreCorruptedError(
      filePath,
      'content does not match the expected { version, secrets } shape',
    );
  }

  if (parsed.version !== CURRENT_VERSION) {
    throw new UnsupportedSecretStoreVersionError(filePath, parsed.version);
  }

  return { version: parsed.version, secrets: parsed.secrets };
}

async function writeStoreAtomically(filePath: string, contents: SecretFileContents): Promise<void> {
  const dir = path.dirname(filePath);
  // POSIX: restrictive perms on the directory too (section 64). Windows ignores the mode bits
  // (section 65) — gitignore + "this is your own dev machine" are the real boundary there.
  await mkdir(dir, { recursive: true, mode: 0o700 });

  // Never write the final path in place (section 11): a crash mid-write must never leave a
  // torn/partial JSON file where a real secret used to be. Write to a private temp file first.
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(contents, null, 2));
    await handle.sync(); // fsync — the temp file's bytes are durable before we ever rename it.
  } finally {
    await handle.close();
  }

  // `rename()` replaces an existing destination atomically on both POSIX and Windows (libuv
  // uses MoveFileExW with MOVEFILE_REPLACE_EXISTING there) — a reader opening `filePath`
  // concurrently always gets either the complete old content or the complete new content, never
  // a partial write (section 12/20).
  await rename(tempPath, filePath);
}

/**
 * Development-only, file-backed `SecretStore` (Prompt 039) — persists secrets as JSON at
 * `filePathInput` (resolved against the backend package root unless already absolute), so a
 * tenant's application credential survives a `dev:full`/worker process restart and can be
 * shared between separate local processes that point at the same file (server, provisioning
 * worker, media outbox dispatcher, media processing worker). Never select this in production —
 * see `createRuntimeSecretStore()`.
 *
 * Concurrency: every `put`/`delete` acquires an exclusive lock file for the full
 * read-modify-write cycle (section 17/49) — this is what actually prevents a lost update between
 * two processes writing different keys around the same time, not just "avoid a torn file" (the
 * atomic rename already guarantees that on its own). `get()` never takes the lock: since writes
 * are always a full atomic replace, a concurrent reader sees either the complete old file or the
 * complete new one, never a partial one (section 20). Two concurrent writes to the *same* key
 * are still fully serialized by the lock, so the result is a clean last-write-wins — never a
 * corrupted file (section 50).
 */
export function createLocalFileSecretStore(filePathInput: string): SecretStore {
  const filePath = resolveBackendPath(filePathInput);
  const lockPath = `${filePath}.lock`;

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await acquireLock(lockPath);
    try {
      return await fn();
    } finally {
      await releaseLock(lockPath);
    }
  }

  return {
    async put(secretReference: string, value: unknown): Promise<void> {
      await withLock(async () => {
        const current = await readStore(filePath);
        current.secrets[secretReference] = value;
        await writeStoreAtomically(filePath, current);
      });
    },

    async get(secretReference: string): Promise<unknown | undefined> {
      const current = await readStore(filePath);
      return current.secrets[secretReference];
    },

    async delete(secretReference: string): Promise<void> {
      await withLock(async () => {
        const current = await readStore(filePath);
        delete current.secrets[secretReference];
        await writeStoreAtomically(filePath, current);
      });
    },
  };
}
