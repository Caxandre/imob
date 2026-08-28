import { describe, expect, it } from "vitest";

import { InvalidObjectKeyError } from "../object-storage.js";
import { createInMemoryObjectStorage } from "./in-memory-object-storage.js";

describe("createInMemoryObjectStorage", () => {
  it("stores an object and returns a public URL derived from the key", async () => {
    const storage = createInMemoryObjectStorage();

    const result = await storage.putObject({ key: "a/b.txt", body: Buffer.from("hello"), contentType: "text/plain" });

    expect(result).toEqual({ key: "a/b.txt", publicUrl: "https://in-memory-object-storage.test/a/b.txt" });
    expect(storage.has("a/b.txt")).toBe(true);
    expect(storage.get("a/b.txt")).toEqual({ body: Buffer.from("hello"), contentType: "text/plain" });
  });

  it("deletes a stored object", async () => {
    const storage = createInMemoryObjectStorage();
    await storage.putObject({ key: "a.txt", body: Buffer.from("x"), contentType: "text/plain" });

    await storage.deleteObject("a.txt");

    expect(storage.has("a.txt")).toBe(false);
  });

  it("is idempotent — deleting a key that was never stored does not throw", async () => {
    const storage = createInMemoryObjectStorage();

    await expect(storage.deleteObject("never-existed.txt")).resolves.toBeUndefined();
  });

  it("rejects an invalid key on put/delete, same as the real adapter", async () => {
    const storage = createInMemoryObjectStorage();

    await expect(storage.putObject({ key: "", body: Buffer.from("x"), contentType: "text/plain" })).rejects.toBeInstanceOf(
      InvalidObjectKeyError,
    );
    await expect(storage.deleteObject("/leading.txt")).rejects.toBeInstanceOf(InvalidObjectKeyError);
  });
});
