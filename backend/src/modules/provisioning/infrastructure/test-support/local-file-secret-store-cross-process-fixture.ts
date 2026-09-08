import { createLocalFileSecretStore } from "../local-file-secret-store.js";

/**
 * Test-support only — a minimal standalone script run via `child_process` from
 * `local-file-secret-store.test.ts` (Prompt 039, section 56) to prove secret sharing across
 * genuinely separate OS processes, not just separate in-process store instances. Never imported
 * by application code.
 *
 * Usage: `tsx local-file-secret-store-cross-process-fixture.ts <filePath> put <reference> <valueJson>`
 *     or `tsx local-file-secret-store-cross-process-fixture.ts <filePath> get <reference>`
 */
const [, , filePath, mode, secretReference, valueJson] = process.argv;

if (!filePath || !mode || !secretReference) {
  throw new Error("usage: <filePath> <put|get> <secretReference> [valueJson]");
}

const store = createLocalFileSecretStore(filePath);

if (mode === "put") {
  if (!valueJson) {
    throw new Error("put requires a valueJson argument");
  }
  await store.put(secretReference, JSON.parse(valueJson));
  process.stdout.write("ok");
} else if (mode === "get") {
  const value = await store.get(secretReference);
  process.stdout.write(JSON.stringify(value ?? null));
} else {
  throw new Error(`unknown mode: ${mode}`);
}
