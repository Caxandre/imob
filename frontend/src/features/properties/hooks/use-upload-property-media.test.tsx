import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { uploadPropertyMedia } from "../api/upload-property-media";
import { useUploadPropertyMedia } from "./use-upload-property-media";

vi.mock("../api/upload-property-media", () => ({
  uploadPropertyMedia: vi.fn(),
}));

const mockedUploadPropertyMedia = vi.mocked(uploadPropertyMedia);

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROPERTY_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function jpeg(name: string, sizeBytes = 1000): File {
  return new File([new Uint8Array(sizeBytes)], name, { type: "image/jpeg" });
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  mockedUploadPropertyMedia.mockReset();
});

describe("useUploadPropertyMedia", () => {
  it("tracks a file through pending -> uploading -> success", async () => {
    let resolveUpload: (() => void) | undefined;
    mockedUploadPropertyMedia.mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = () => resolve({} as never);
      }),
    );

    const { result } = renderHook(() => useUploadPropertyMedia(TENANT_ID, PROPERTY_ID), {
      wrapper,
    });

    await act(async () => {
      void result.current.uploadFiles([jpeg("a.jpg")]);
    });

    await waitFor(() => expect(result.current.items[0]?.status).toBe("uploading"));
    expect(result.current.isUploading).toBe(true);

    await act(async () => {
      resolveUpload?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.items[0]?.status).toBe("success"));
    expect(result.current.isUploading).toBe(false);
  });

  it("rejects an invalid file client-side without calling the API", async () => {
    const invalidFile = new File(["x"], "a.gif", { type: "image/gif" });

    const { result } = renderHook(() => useUploadPropertyMedia(TENANT_ID, PROPERTY_ID), {
      wrapper,
    });

    await act(async () => {
      await result.current.uploadFiles([invalidFile]);
    });

    expect(result.current.items[0]?.status).toBe("error");
    expect(result.current.items[0]?.errorMessage).toMatch(/JPEG|PNG|WebP/);
    expect(mockedUploadPropertyMedia).not.toHaveBeenCalled();
  });

  it("rejects an oversized file client-side without calling the API", async () => {
    const oversized = jpeg("a.jpg", 11 * 1024 * 1024);

    const { result } = renderHook(() => useUploadPropertyMedia(TENANT_ID, PROPERTY_ID), {
      wrapper,
    });

    await act(async () => {
      await result.current.uploadFiles([oversized]);
    });

    expect(result.current.items[0]?.status).toBe("error");
    expect(result.current.items[0]?.errorMessage).toMatch(/10 ?MB/);
    expect(mockedUploadPropertyMedia).not.toHaveBeenCalled();
  });

  it("reports each file's outcome independently — a batch is never all-or-nothing", async () => {
    mockedUploadPropertyMedia.mockImplementation((_tenantId, _propertyId, file) => {
      if (file.name === "fails.jpg") {
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve({} as never);
    });

    const { result } = renderHook(() => useUploadPropertyMedia(TENANT_ID, PROPERTY_ID), {
      wrapper,
    });

    await act(async () => {
      await result.current.uploadFiles([jpeg("ok-1.jpg"), jpeg("fails.jpg"), jpeg("ok-2.jpg")]);
    });

    const byName = Object.fromEntries(
      result.current.items.map((item) => [item.file.name, item.status]),
    );
    expect(byName["ok-1.jpg"]).toBe("success");
    expect(byName["fails.jpg"]).toBe("error");
    expect(byName["ok-2.jpg"]).toBe("success");
  });

  it("never runs more than 3 uploads concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    mockedUploadPropertyMedia.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return {} as never;
    });

    const { result } = renderHook(() => useUploadPropertyMedia(TENANT_ID, PROPERTY_ID), {
      wrapper,
    });
    const files = Array.from({ length: 6 }, (_, index) => jpeg(`f${String(index)}.jpg`));

    await act(async () => {
      await result.current.uploadFiles(files);
    });

    expect(maxActive).toBeLessThanOrEqual(3);
    expect(mockedUploadPropertyMedia).toHaveBeenCalledTimes(6);
  });

  it("allows retrying a single failed file", async () => {
    mockedUploadPropertyMedia.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useUploadPropertyMedia(TENANT_ID, PROPERTY_ID), {
      wrapper,
    });

    await act(async () => {
      await result.current.uploadFiles([jpeg("a.jpg")]);
    });
    expect(result.current.items[0]?.status).toBe("error");

    mockedUploadPropertyMedia.mockResolvedValueOnce({} as never);
    await act(async () => {
      const id = result.current.items[0]!.id;
      await Promise.resolve(result.current.retryItem(id));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(result.current.items[0]?.status).toBe("success"));
  });

  it("dismisses an item from the list", async () => {
    mockedUploadPropertyMedia.mockResolvedValue({} as never);

    const { result } = renderHook(() => useUploadPropertyMedia(TENANT_ID, PROPERTY_ID), {
      wrapper,
    });

    await act(async () => {
      await result.current.uploadFiles([jpeg("a.jpg")]);
    });
    const id = result.current.items[0]!.id;

    act(() => {
      result.current.dismissItem(id);
    });

    expect(result.current.items).toHaveLength(0);
  });
});
