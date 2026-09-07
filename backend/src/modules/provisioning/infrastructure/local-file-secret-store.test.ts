import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createLocalFileSecretStore,
  SecretStoreCorruptedError,
  UnsupportedSecretStoreVersionError,
} from "./local-file-secret-store.js";

const execFileAsync = promisify(execFile);

/**
 * Every test uses its own temporary directory (Prompt 039, section 57) — never
 * `backend/.local/secrets.json`, the developer's real store. Cleaned up after each test
 * (section 58). Credentials used throughout are synthetic (section 59), never values from
 * `.env`.
 */
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "imob-secret-store-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function storeFilePath(): string {
  return path.join(tempDir, "secrets.json");
}

describe("createLocalFileSecretStore — persistence", () => {
  it("persists a secret across separate store instances at the same path (section 41)", async () => {
    const filePath = storeFilePath();
    const a = createLocalFileSecretStore(filePath);
    await a.put("tenant-databases/t1", { username: "u1", password: "p1" });

    const b = createLocalFileSecretStore(filePath);
    await expect(b.get("tenant-databases/t1")).resolves.toEqual({ username: "u1", password: "p1" });
  });

  it("updates an existing key, and the update survives across instances (section 42)", async () => {
    const filePath = storeFilePath();
    const a = createLocalFileSecretStore(filePath);
    await a.put("k", { v: "first" });
    await a.put("k", { v: "second" });

    const b = createLocalFileSecretStore(filePath);
    await expect(b.get("k")).resolves.toEqual({ v: "second" });
  });

  it("deletes a key, and the deletion survives across instances (section 43)", async () => {
    const filePath = storeFilePath();
    const a = createLocalFileSecretStore(filePath);
    await a.put("k", { v: "x" });
    await a.delete("k");

    const b = createLocalFileSecretStore(filePath);
    await expect(b.get("k")).resolves.toBeUndefined();
  });

  it("is idempotent to delete a key that never existed", async () => {
    const store = createLocalFileSecretStore(storeFilePath());
    await expect(store.delete("never-existed")).resolves.toBeUndefined();
  });
});

describe("createLocalFileSecretStore — missing / absent state", () => {
  it("creates the parent directory automatically on the first put (section 44)", async () => {
    const nested = path.join(tempDir, "nested", "dir", "secrets.json");
    const store = createLocalFileSecretStore(nested);
    await store.put("k", { v: "x" });

    await expect(readFile(nested, "utf8")).resolves.toContain('"k"');
  });

  it("returns undefined from get() when the store file doesn't exist yet (section 45)", async () => {
    const store = createLocalFileSecretStore(storeFilePath());
    await expect(store.get("missing")).resolves.toBeUndefined();
  });
});

describe("createLocalFileSecretStore — corruption and versioning", () => {
  it("throws SecretStoreCorruptedError for invalid JSON content, never a missing-secret result (section 46)", async () => {
    const filePath = storeFilePath();
    await writeFile(filePath, "{broken");
    const store = createLocalFileSecretStore(filePath);

    await expect(store.get("k")).rejects.toThrow(SecretStoreCorruptedError);
  });

  it("throws SecretStoreCorruptedError when the content doesn't match the expected shape", async () => {
    const filePath = storeFilePath();
    await writeFile(filePath, JSON.stringify({ somethingElse: true }));
    const store = createLocalFileSecretStore(filePath);

    await expect(store.get("k")).rejects.toThrow(SecretStoreCorruptedError);
  });

  it("never includes file content in the corruption error message (section 15)", async () => {
    const filePath = storeFilePath();
    await writeFile(filePath, "{ this is definitely not json and has a very specific marker XYZZY");
    const store = createLocalFileSecretStore(filePath);

    await expect(store.get("k")).rejects.toSatisfy((error: unknown) => {
      return error instanceof Error && !error.message.includes("XYZZY");
    });
  });

  it("throws UnsupportedSecretStoreVersionError for an unknown version (section 47)", async () => {
    const filePath = storeFilePath();
    await writeFile(filePath, JSON.stringify({ version: 999, secrets: {} }));
    const store = createLocalFileSecretStore(filePath);

    await expect(store.get("k")).rejects.toThrow(UnsupportedSecretStoreVersionError);
  });
});

describe("createLocalFileSecretStore — atomicity", () => {
  it("leaves the previous file intact when a write fails before the atomic rename (section 48)", async () => {
    const filePath = storeFilePath();
    const store = createLocalFileSecretStore(filePath);
    await store.put("k1", { v: "original" });

    // A BigInt can't be JSON.stringify'd — this throws synchronously inside the atomic-write
    // helper, after the temp file is opened but before anything is written or renamed. No
    // filesystem mocking needed to prove the destination file is never touched.
    await expect(store.put("k2", { v: 1n as unknown as string })).rejects.toThrow();

    const reopened = createLocalFileSecretStore(filePath);
    await expect(reopened.get("k1")).resolves.toEqual({ v: "original" });
    await expect(reopened.get("k2")).resolves.toBeUndefined();
  });
});

describe("createLocalFileSecretStore — concurrency", () => {
  it("keeps every key with no lost updates under concurrent puts to different keys (section 49)", async () => {
    const filePath = storeFilePath();
    const stores = Array.from({ length: 10 }, () => createLocalFileSecretStore(filePath));

    await Promise.all(stores.map((store, index) => store.put(`key-${index}`, { v: index })));

    const reader = createLocalFileSecretStore(filePath);
    for (let index = 0; index < 10; index += 1) {
      await expect(reader.get(`key-${index}`)).resolves.toEqual({ v: index });
    }
  });

  it("same-key concurrent writes converge to one value, file stays valid (last-write-wins, section 50)", async () => {
    const filePath = storeFilePath();
    const stores = Array.from({ length: 5 }, () => createLocalFileSecretStore(filePath));

    await Promise.all(stores.map((store, index) => store.put("shared-key", { v: index })));

    const reader = createLocalFileSecretStore(filePath);
    const result = (await reader.get("shared-key")) as { v: number } | undefined;
    expect(result).toBeDefined();
    expect([0, 1, 2, 3, 4]).toContain(result?.v);
    // The file is still valid, parseable JSON — reading again doesn't throw.
    await expect(reader.get("shared-key")).resolves.toEqual(result);
  });

  it("recovers from a stale lock file left behind by a dead process (section 51)", async () => {
    const filePath = storeFilePath();
    const lockPath = `${filePath}.lock`;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: 999_999, acquiredAt: new Date(0).toISOString() }));
    const oldTimestamp = new Date(Date.now() - 60_000);
    await utimes(lockPath, oldTimestamp, oldTimestamp);

    const store = createLocalFileSecretStore(filePath);
    await store.put("k", { v: "x" });

    await expect(store.get("k")).resolves.toEqual({ v: "x" });
  });

  it(
    "never steals a lock that is still fresh (section 52)",
    async () => {
      const filePath = storeFilePath();
      const lockPath = `${filePath}.lock`;
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));

      const store = createLocalFileSecretStore(filePath);
      await expect(store.put("k", { v: "x" })).rejects.toThrow(/Timed out waiting/);
    },
    10_000,
  );
});

describe("createLocalFileSecretStore — cross-process sharing", () => {
  const tsxCli = path.resolve(import.meta.dirname, "..", "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
  const fixture = path.resolve(
    import.meta.dirname,
    "test-support",
    "local-file-secret-store-cross-process-fixture.ts",
  );

  it(
    "a secret written by one process is readable by a separate process pointed at the same file (section 56)",
    async () => {
      const filePath = storeFilePath();

      await execFileAsync(process.execPath, [
        tsxCli,
        fixture,
        filePath,
        "put",
        "tenant-databases/cross-process",
        JSON.stringify({ username: "cross-process-user", password: "cross-process-pass" }),
      ]);

      const { stdout } = await execFileAsync(process.execPath, [
        tsxCli,
        fixture,
        filePath,
        "get",
        "tenant-databases/cross-process",
      ]);

      expect(JSON.parse(stdout)).toEqual({
        username: "cross-process-user",
        password: "cross-process-pass",
      });
    },
    20_000,
  );
});
