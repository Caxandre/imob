import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listPropertyMedia } from "../api/list-property-media";
import type { PropertyMediaListResponse } from "../schemas/property-media.schema";
import { propertiesQueryKeys } from "./use-properties";
import { usePropertyMedia } from "./use-property-media";

vi.mock("../api/list-property-media", () => ({
  listPropertyMedia: vi.fn(),
}));

const mockedListPropertyMedia = vi.mocked(listPropertyMedia);

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROPERTY_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function mediaItem(overrides: Partial<PropertyMediaListResponse["data"][number]> = {}) {
  return {
    id: "m1",
    property_id: PROPERTY_ID,
    public_url: "https://example.com/original.jpg",
    mime_type: "image/jpeg",
    size_bytes: 1000,
    original_filename: "foto.jpg",
    position: 0,
    is_cover: true,
    processing_status: "READY" as const,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    variants: { thumbnail: null, card: null, detail: null },
    ...overrides,
  };
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { wrapper, queryClient };
}

beforeEach(() => {
  mockedListPropertyMedia.mockReset();
});

describe("usePropertyMedia polling", () => {
  it("polls repeatedly while a media item is PROCESSING", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedListPropertyMedia.mockResolvedValue({
      data: [mediaItem({ processing_status: "PROCESSING" })],
    });

    const { wrapper } = createWrapper();
    renderHook(() => usePropertyMedia(TENANT_ID, PROPERTY_ID), { wrapper });

    await vi.waitFor(() => expect(mockedListPropertyMedia).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(3000);
    expect(mockedListPropertyMedia).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3000);
    expect(mockedListPropertyMedia).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it("stops polling once no media is PROCESSING", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedListPropertyMedia.mockResolvedValue({
      data: [mediaItem({ processing_status: "READY" })],
    });

    const { wrapper } = createWrapper();
    renderHook(() => usePropertyMedia(TENANT_ID, PROPERTY_ID), { wrapper });

    await vi.waitFor(() => expect(mockedListPropertyMedia).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockedListPropertyMedia).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("invalidates the properties catalog cache exactly once when processing settles", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedListPropertyMedia.mockResolvedValueOnce({
      data: [mediaItem({ processing_status: "PROCESSING" })],
    });
    mockedListPropertyMedia.mockResolvedValueOnce({
      data: [mediaItem({ processing_status: "READY" })],
    });
    mockedListPropertyMedia.mockResolvedValue({
      data: [mediaItem({ processing_status: "READY" })],
    });

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderHook(() => usePropertyMedia(TENANT_ID, PROPERTY_ID), { wrapper });

    await vi.waitFor(() => expect(mockedListPropertyMedia).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(mockedListPropertyMedia).toHaveBeenCalledTimes(2));

    await vi.waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: propertiesQueryKeys.all(TENANT_ID) }),
    );
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    // Further polling never resumes (nothing is PROCESSING anymore) and never invalidates again.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockedListPropertyMedia).toHaveBeenCalledTimes(2);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("never invalidates the catalog cache when nothing was ever PROCESSING", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedListPropertyMedia.mockResolvedValue({
      data: [mediaItem({ processing_status: "READY" })],
    });

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderHook(() => usePropertyMedia(TENANT_ID, PROPERTY_ID), { wrapper });

    await vi.waitFor(() => expect(mockedListPropertyMedia).toHaveBeenCalledTimes(1));

    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: propertiesQueryKeys.all(TENANT_ID),
    });

    vi.useRealTimers();
  });
});
