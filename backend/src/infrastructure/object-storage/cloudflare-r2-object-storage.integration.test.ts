import { randomUUID } from "node:crypto";

import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { env } from "../../config/env.js";
import { createCloudflareR2ObjectStorage } from "./cloudflare-r2-object-storage.js";

/**
 * Real Cloudflare R2, never mocked — genuinely opt-in (this task, sections 28/56): only runs
 * when `RUN_R2_INTEGRATION_TESTS=true` is set *and* every `R2_*` env var is actually
 * configured. Skipped by default — including in CI, which has neither — never a failure just
 * because the gate isn't satisfied. Reads through `env` (`src/config/env.ts`), the same
 * validated config surface every other real-infrastructure test in this repo uses; never reads
 * a raw credential value into a local `const` (this task, section 33), and never logs/prints
 * any of it — only the ephemeral, non-secret object key.
 */
const r2ConfigComplete =
  env.R2_ACCOUNT_ID !== undefined &&
  env.R2_ACCESS_KEY_ID !== undefined &&
  env.R2_SECRET_ACCESS_KEY !== undefined &&
  env.R2_BUCKET !== undefined &&
  env.R2_PUBLIC_URL !== undefined;

const shouldRun = process.env.RUN_R2_INTEGRATION_TESTS === "true" && r2ConfigComplete;

describe.runIf(shouldRun)("createCloudflareR2ObjectStorage — real Cloudflare R2", () => {
  it("putObject / public URL / HeadObject / deleteObject round-trip against a real bucket", async () => {
    // Non-null assertions are safe here only because `shouldRun`/`r2ConfigComplete` above
    // already confirmed every field is defined before this suite is even allowed to run.
    const storage = createCloudflareR2ObjectStorage({
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET,
      publicUrl: env.R2_PUBLIC_URL,
    });

    // Never `properties/...` yet (this task, section 29) — an ephemeral, isolated key that
    // can never collide with real application data.
    const key = `integration-tests/${randomUUID()}.txt`;
    let uploaded = false;

    try {
      const result = await storage.putObject({
        key,
        body: Buffer.from("hello-r2"),
        contentType: "text/plain",
      });
      uploaded = true;

      expect(result.key).toBe(key);
      expect(result.publicUrl).toBe(`${env.R2_PUBLIC_URL!.replace(/\/+$/, "")}/${key}`);

      // HeadObjectCommand exists only here, never added to the ObjectStorage port itself
      // (this task, section 30) — a second, throwaway client purely for this assertion.
      const headClient = new S3Client({
        region: "auto",
        endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! },
        forcePathStyle: false,
      });
      await expect(
        headClient.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: key })),
      ).resolves.toBeDefined();
    } finally {
      // Always attempted, even if an assertion above threw — never leaves an object behind
      // in the real bucket (this task, section 31).
      if (uploaded) {
        await storage.deleteObject(key);
      }
    }
  });
});
