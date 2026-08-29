import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import {
  InvalidObjectKeyError,
  ObjectStorageConfigurationError,
  ObjectStorageDeleteError,
  ObjectStorageObjectNotFoundError,
  ObjectStorageReadError,
  ObjectStorageUploadError,
} from "./object-storage.js";
import type { CloudflareR2RawConfig, S3CommandSender } from "./cloudflare-r2-object-storage.js";
import { buildCloudflareR2Endpoint, buildPublicObjectUrl, createCloudflareR2ObjectStorage } from "./cloudflare-r2-object-storage.js";

// Only `S3Client`'s constructor is faked — never a real network call, never real credentials
// (this task, section 27/33). `PutObjectCommand`/`DeleteObjectCommand` stay the real SDK
// classes, so `instanceof`/`.input` assertions below reflect real SDK behavior.
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(function FakeS3Client() {
      return { send: vi.fn().mockResolvedValue({}) };
    }),
  };
});

/**
 * Never anything resembling a real credential (this task, section 33) — plain placeholder
 * strings, exactly as fragile/meaningless as any other test fixture in this suite.
 */
function validRawConfig(overrides: Partial<CloudflareR2RawConfig> = {}): CloudflareR2RawConfig {
  return {
    accountId: "test-account",
    accessKeyId: "test-access-key-id",
    secretAccessKey: "test-secret-access-key",
    bucket: "test-bucket",
    publicUrl: "https://public-base.example",
    ...overrides,
  };
}

function fakeCommandSender(behavior: "succeed" | "throw" | "not-found" | "no-body" = "succeed") {
  const receivedCommands: (PutObjectCommand | DeleteObjectCommand | GetObjectCommand)[] = [];
  const sender: S3CommandSender = {
    async send(command) {
      receivedCommands.push(command);
      if (behavior === "throw") {
        throw new Error("simulated provider failure");
      }
      if (behavior === "not-found") {
        const error = new Error("The specified key does not exist.");
        error.name = "NoSuchKey";
        throw error;
      }
      if (command instanceof GetObjectCommand) {
        if (behavior === "no-body") {
          return {};
        }
        return {
          Body: { transformToByteArray: async () => new Uint8Array([0xff, 0xd8, 0xff]) },
          ContentType: "image/jpeg",
          ContentLength: 3,
        };
      }
      return {};
    },
  };
  return { sender, receivedCommands };
}

describe("buildCloudflareR2Endpoint", () => {
  it("builds the documented Cloudflare R2 endpoint from the account id", () => {
    expect(buildCloudflareR2Endpoint("abc123")).toBe("https://abc123.r2.cloudflarestorage.com");
  });
});

describe("buildPublicObjectUrl", () => {
  it("joins base and key with exactly one slash", () => {
    expect(buildPublicObjectUrl("https://public.example", "a/b.jpg")).toBe("https://public.example/a/b.jpg");
  });

  it("normalizes a trailing slash on the base", () => {
    expect(buildPublicObjectUrl("https://public.example/", "a/b.jpg")).toBe("https://public.example/a/b.jpg");
  });

  it("normalizes multiple trailing slashes on the base", () => {
    expect(buildPublicObjectUrl("https://public.example//", "a/b.jpg")).toBe("https://public.example/a/b.jpg");
  });

  it("never alters the key content beyond stripping a leading slash at the join point", () => {
    expect(buildPublicObjectUrl("https://public.example", "a//b.jpg")).toBe("https://public.example/a//b.jpg");
  });
});

describe("createCloudflareR2ObjectStorage — configuration", () => {
  it("throws ObjectStorageConfigurationError when config is entirely missing", () => {
    expect(() => createCloudflareR2ObjectStorage({})).toThrow(ObjectStorageConfigurationError);
  });

  it("throws naming exactly the missing fields when config is partial", () => {
    try {
      createCloudflareR2ObjectStorage({ accountId: "acc", bucket: "bucket" });
      expect.fail("expected ObjectStorageConfigurationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ObjectStorageConfigurationError);
      const message = (error as Error).message;
      expect(message).toContain("accessKeyId");
      expect(message).toContain("secretAccessKey");
      expect(message).toContain("publicUrl");
    }
  });

  it("throws when publicUrl is not a valid URL", () => {
    expect(() => createCloudflareR2ObjectStorage(validRawConfig({ publicUrl: "not-a-url" }))).toThrow(
      ObjectStorageConfigurationError,
    );
  });

  it("never echoes the actual invalid value into the error message", () => {
    const distinctiveBadValue = "clearly-not-a-url-marker-xyz";
    try {
      createCloudflareR2ObjectStorage(validRawConfig({ publicUrl: distinctiveBadValue }));
      expect.fail("expected ObjectStorageConfigurationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ObjectStorageConfigurationError);
      expect((error as Error).message).not.toContain(distinctiveBadValue);
      expect((error as Error).message).toContain("publicUrl");
    }
  });

  it("real S3Client construction: region 'auto', Cloudflare R2 endpoint, forcePathStyle false, when no client is injected", () => {
    createCloudflareR2ObjectStorage(validRawConfig({ accountId: "my-account" }));

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "auto",
        endpoint: "https://my-account.r2.cloudflarestorage.com",
        forcePathStyle: false,
        credentials: { accessKeyId: "test-access-key-id", secretAccessKey: "test-secret-access-key" },
      }),
    );
  });
});

describe("createCloudflareR2ObjectStorage — putObject", () => {
  it("sends a PutObjectCommand with bucket/key/body/contentType/contentLength and returns the public URL", async () => {
    const { sender, receivedCommands } = fakeCommandSender();
    const storage = createCloudflareR2ObjectStorage(validRawConfig(), { client: sender });

    const result = await storage.putObject({
      key: "integration-tests/example.txt",
      body: Buffer.from("hello-r2"),
      contentType: "text/plain",
      contentLength: 8,
    });

    expect(receivedCommands).toHaveLength(1);
    const command = receivedCommands[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command?.input).toMatchObject({
      Bucket: "test-bucket",
      Key: "integration-tests/example.txt",
      ContentType: "text/plain",
      ContentLength: 8,
    });
    expect(result).toEqual({
      key: "integration-tests/example.txt",
      publicUrl: "https://public-base.example/integration-tests/example.txt",
    });
  });

  it.each([
    ["empty key", ""],
    ["key starting with /", "/leading.txt"],
    ["key with a .. segment", "a/../b.txt"],
  ])("rejects an invalid key (%s) without calling the provider", async (_label, key) => {
    const { sender, receivedCommands } = fakeCommandSender();
    const storage = createCloudflareR2ObjectStorage(validRawConfig(), { client: sender });

    await expect(storage.putObject({ key, body: Buffer.from("x"), contentType: "text/plain" })).rejects.toBeInstanceOf(
      InvalidObjectKeyError,
    );
    expect(receivedCommands).toHaveLength(0);
  });

  it("maps a provider failure to ObjectStorageUploadError", async () => {
    const { sender } = fakeCommandSender("throw");
    const storage = createCloudflareR2ObjectStorage(validRawConfig(), { client: sender });

    await expect(
      storage.putObject({ key: "a.txt", body: Buffer.from("x"), contentType: "text/plain" }),
    ).rejects.toBeInstanceOf(ObjectStorageUploadError);
  });
});

describe("createCloudflareR2ObjectStorage — getObject", () => {
  it("sends a GetObjectCommand with bucket/key and returns a Buffer with contentType/contentLength", async () => {
    const { sender, receivedCommands } = fakeCommandSender();
    const storage = createCloudflareR2ObjectStorage(validRawConfig(), { client: sender });

    const result = await storage.getObject("tenants/t/properties/p/m.jpg");

    expect(receivedCommands).toHaveLength(1);
    const command = receivedCommands[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command?.input).toMatchObject({ Bucket: "test-bucket", Key: "tenants/t/properties/p/m.jpg" });
    expect(Buffer.isBuffer(result.body)).toBe(true);
    expect(result.body).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(result.contentType).toBe("image/jpeg");
    expect(result.contentLength).toBe(3);
  });

  it("rejects an invalid key without calling the provider", async () => {
    const { sender, receivedCommands } = fakeCommandSender();
    const storage = createCloudflareR2ObjectStorage(validRawConfig(), { client: sender });

    await expect(storage.getObject("/leading-slash.jpg")).rejects.toBeInstanceOf(InvalidObjectKeyError);
    expect(receivedCommands).toHaveLength(0);
  });

  it("maps a NoSuchKey provider error to ObjectStorageObjectNotFoundError", async () => {
    const { sender } = fakeCommandSender("not-found");
    const storage = createCloudflareR2ObjectStorage(validRawConfig(), { client: sender });

    await expect(storage.getObject("missing.jpg")).rejects.toBeInstanceOf(ObjectStorageObjectNotFoundError);
  });

  it("maps any other provider failure to ObjectStorageReadError (transient)", async () => {
    const { sender } = fakeCommandSender("throw");
    const storage = createCloudflareR2ObjectStorage(validRawConfig(), { client: sender });

    await expect(storage.getObject("a.jpg")).rejects.toBeInstanceOf(ObjectStorageReadError);
  });

  it("maps a response with no Body to ObjectStorageReadError instead of crashing", async () => {
    const { sender } = fakeCommandSender("no-body");
    const storage = createCloudflareR2ObjectStorage(validRawConfig(), { client: sender });

    await expect(storage.getObject("a.jpg")).rejects.toBeInstanceOf(ObjectStorageReadError);
  });

  it("never includes credentials or raw SDK error details in a mapped error's message", async () => {
    const { sender } = fakeCommandSender("throw");
    const storage = createCloudflareR2ObjectStorage(validRawConfig({ secretAccessKey: "distinctive-secret-marker" }), {
      client: sender,
    });

    try {
      await storage.getObject("a.jpg");
      expect.fail("expected ObjectStorageReadError");
    } catch (error) {
      expect((error as Error).message).not.toContain("distinctive-secret-marker");
    }
  });
});

describe("createCloudflareR2ObjectStorage — deleteObject", () => {
  it("sends a DeleteObjectCommand with bucket/key", async () => {
    const { sender, receivedCommands } = fakeCommandSender();
    const storage = createCloudflareR2ObjectStorage(validRawConfig(), { client: sender });

    await storage.deleteObject("integration-tests/example.txt");

    expect(receivedCommands).toHaveLength(1);
    const command = receivedCommands[0];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command?.input).toMatchObject({ Bucket: "test-bucket", Key: "integration-tests/example.txt" });
  });

  it("is idempotent — deleting a key that was never written still resolves (S3's own DeleteObject semantics)", async () => {
    const { sender } = fakeCommandSender();
    const storage = createCloudflareR2ObjectStorage(validRawConfig(), { client: sender });

    await expect(storage.deleteObject("never-existed.txt")).resolves.toBeUndefined();
  });

  it("maps a provider failure to ObjectStorageDeleteError", async () => {
    const { sender } = fakeCommandSender("throw");
    const storage = createCloudflareR2ObjectStorage(validRawConfig(), { client: sender });

    await expect(storage.deleteObject("a.txt")).rejects.toBeInstanceOf(ObjectStorageDeleteError);
  });

  it("rejects an invalid key without calling the provider", async () => {
    const { sender, receivedCommands } = fakeCommandSender();
    const storage = createCloudflareR2ObjectStorage(validRawConfig(), { client: sender });

    await expect(storage.deleteObject("/leading-slash.txt")).rejects.toBeInstanceOf(InvalidObjectKeyError);
    expect(receivedCommands).toHaveLength(0);
  });
});
