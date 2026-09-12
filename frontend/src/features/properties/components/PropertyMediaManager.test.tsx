import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { deletePropertyMedia } from "../api/delete-property-media";
import { listPropertyMedia } from "../api/list-property-media";
import { reorderPropertyMedia } from "../api/reorder-property-media";
import { setPropertyMediaCover } from "../api/set-property-media-cover";
import { uploadPropertyMedia } from "../api/upload-property-media";
import type { PropertyMedia } from "../schemas/property-media.schema";
import { PropertyMediaManager } from "./PropertyMediaManager";

vi.mock("../api/list-property-media", () => ({ listPropertyMedia: vi.fn() }));
vi.mock("../api/upload-property-media", () => ({ uploadPropertyMedia: vi.fn() }));
vi.mock("../api/reorder-property-media", () => ({ reorderPropertyMedia: vi.fn() }));
vi.mock("../api/set-property-media-cover", () => ({ setPropertyMediaCover: vi.fn() }));
vi.mock("../api/delete-property-media", () => ({ deletePropertyMedia: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockedListPropertyMedia = vi.mocked(listPropertyMedia);
const mockedUploadPropertyMedia = vi.mocked(uploadPropertyMedia);
const mockedReorderPropertyMedia = vi.mocked(reorderPropertyMedia);
const mockedSetPropertyMediaCover = vi.mocked(setPropertyMediaCover);
const mockedDeletePropertyMedia = vi.mocked(deletePropertyMedia);

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROPERTY_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function media(overrides: Partial<PropertyMedia> = {}): PropertyMedia {
  return {
    id: "m1",
    property_id: PROPERTY_ID,
    public_url: "https://example.com/original.jpg",
    mime_type: "image/jpeg",
    size_bytes: 1000,
    original_filename: "foto.jpg",
    position: 0,
    is_cover: false,
    processing_status: "READY",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    variants: { thumbnail: null, card: null, detail: null },
    ...overrides,
  };
}

function renderManager(propertyStatus: "DRAFT" | "ACTIVE" | "INACTIVE" = "ACTIVE") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PropertyMediaManager
        tenantId={TENANT_ID}
        propertyId={PROPERTY_ID}
        propertyStatus={propertyStatus}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedListPropertyMedia.mockReset();
  mockedUploadPropertyMedia.mockReset();
  mockedReorderPropertyMedia.mockReset();
  mockedSetPropertyMediaCover.mockReset();
  mockedDeletePropertyMedia.mockReset();
});

describe("PropertyMediaManager", () => {
  it("shows a skeleton before the media resolves", () => {
    mockedListPropertyMedia.mockReturnValue(new Promise(() => {}));

    renderManager();

    expect(screen.queryByText("Nenhuma foto cadastrada.")).not.toBeInTheDocument();
  });

  it("shows an error state with retry when media fails to load", async () => {
    mockedListPropertyMedia.mockRejectedValue(new Error("boom"));

    renderManager();

    expect(await screen.findByText("Não foi possível carregar as fotos.")).toBeInTheDocument();

    mockedListPropertyMedia.mockResolvedValue({ data: [media()] });
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(await screen.findByRole("img")).toBeInTheDocument();
    expect(screen.queryByText("Não foi possível carregar as fotos.")).not.toBeInTheDocument();
  });

  it("shows an empty state with the upload area when there is no media", async () => {
    mockedListPropertyMedia.mockResolvedValue({ data: [] });

    renderManager();

    expect(await screen.findByText("Nenhuma foto cadastrada.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adicionar fotos" })).toBeInTheDocument();
  });

  it("renders the media grid with cover/processing/failed badges", async () => {
    mockedListPropertyMedia.mockResolvedValue({
      data: [
        media({ id: "a", position: 0, is_cover: true, processing_status: "READY" }),
        media({ id: "b", position: 1, processing_status: "PROCESSING" }),
        media({ id: "c", position: 2, processing_status: "FAILED" }),
      ],
    });

    renderManager();

    expect(await screen.findByText("Capa")).toBeInTheDocument();
    expect(screen.getByText("Processando")).toBeInTheDocument();
    expect(screen.getByText("Falha no processamento")).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(3);
  });

  it("disables 'Definir como capa' for the item that is already the cover", async () => {
    mockedListPropertyMedia.mockResolvedValue({
      data: [media({ id: "a", position: 0, is_cover: true })],
    });

    renderManager();

    expect(await screen.findByRole("button", { name: "Definir foto 1 como capa" })).toBeDisabled();
  });

  it("sets a new cover via mutation and invalidates on success", async () => {
    mockedListPropertyMedia.mockResolvedValue({
      data: [
        media({ id: "a", position: 0, is_cover: true }),
        media({ id: "b", position: 1, is_cover: false }),
      ],
    });
    mockedSetPropertyMediaCover.mockResolvedValue(media({ id: "b", position: 1, is_cover: true }));

    renderManager();
    await screen.findByRole("button", { name: "Definir foto 2 como capa" });

    fireEvent.click(screen.getByRole("button", { name: "Definir foto 2 como capa" }));

    await waitFor(() => {
      expect(mockedSetPropertyMediaCover).toHaveBeenCalledWith(TENANT_ID, PROPERTY_ID, "b");
    });
  });

  it("shows a safe error message when setting the cover fails", async () => {
    mockedListPropertyMedia.mockResolvedValue({
      data: [media({ id: "a", position: 0 }), media({ id: "b", position: 1 })],
    });
    mockedSetPropertyMediaCover.mockRejectedValue(new Error("boom"));

    renderManager();
    await screen.findByRole("button", { name: "Definir foto 1 como capa" });
    fireEvent.click(screen.getByRole("button", { name: "Definir foto 1 como capa" }));

    expect(await screen.findByText("Não foi possível definir a capa.")).toBeInTheDocument();
  });

  it("disables move-left on the first photo and move-right on the last", async () => {
    mockedListPropertyMedia.mockResolvedValue({
      data: [media({ id: "a", position: 0 }), media({ id: "b", position: 1 })],
    });

    renderManager();

    expect(
      await screen.findByRole("button", { name: "Mover foto 1 para a esquerda" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mover foto 1 para a direita" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Mover foto 2 para a esquerda" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Mover foto 2 para a direita" })).toBeDisabled();
  });

  it("sends the full reordered media_ids set when moving a photo right", async () => {
    mockedListPropertyMedia.mockResolvedValue({
      data: [
        media({ id: "a", position: 0 }),
        media({ id: "b", position: 1 }),
        media({ id: "c", position: 2 }),
      ],
    });
    mockedReorderPropertyMedia.mockResolvedValue({ data: [] });

    renderManager();
    await screen.findByRole("button", { name: "Mover foto 1 para a direita" });

    fireEvent.click(screen.getByRole("button", { name: "Mover foto 1 para a direita" }));

    await waitFor(() => {
      expect(mockedReorderPropertyMedia).toHaveBeenCalledWith(TENANT_ID, PROPERTY_ID, [
        "b",
        "a",
        "c",
      ]);
    });
  });

  it("shows a safe error message when reorder fails", async () => {
    mockedListPropertyMedia.mockResolvedValue({
      data: [media({ id: "a", position: 0 }), media({ id: "b", position: 1 })],
    });
    mockedReorderPropertyMedia.mockRejectedValue(new Error("boom"));

    renderManager();
    await screen.findByRole("button", { name: "Mover foto 1 para a direita" });
    fireEvent.click(screen.getByRole("button", { name: "Mover foto 1 para a direita" }));

    expect(await screen.findByText("Não foi possível reordenar as fotos.")).toBeInTheDocument();
  });

  it("asks for confirmation before deleting, and does nothing on cancel", async () => {
    mockedListPropertyMedia.mockResolvedValue({ data: [media({ id: "a", position: 0 })] });

    renderManager();
    await screen.findByRole("button", { name: "Excluir foto 1" });
    fireEvent.click(screen.getByRole("button", { name: "Excluir foto 1" }));

    expect(await screen.findByText("Excluir esta foto?")).toBeInTheDocument();
    expect(screen.getByText("Essa ação remove a foto da galeria.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByText("Excluir esta foto?")).not.toBeInTheDocument());
    expect(mockedDeletePropertyMedia).not.toHaveBeenCalled();
  });

  it("deletes the photo after confirmation and refetches the gallery", async () => {
    mockedListPropertyMedia.mockResolvedValueOnce({ data: [media({ id: "a", position: 0 })] });
    mockedListPropertyMedia.mockResolvedValue({ data: [] });
    mockedDeletePropertyMedia.mockResolvedValue(undefined);

    renderManager();
    await screen.findByRole("button", { name: "Excluir foto 1" });
    fireEvent.click(screen.getByRole("button", { name: "Excluir foto 1" }));
    await screen.findByText("Excluir esta foto?");

    fireEvent.click(screen.getByRole("button", { name: "Excluir" }));

    await waitFor(() => {
      expect(mockedDeletePropertyMedia).toHaveBeenCalledWith(TENANT_ID, PROPERTY_ID, "a");
    });
    expect(await screen.findByText("Nenhuma foto cadastrada.")).toBeInTheDocument();
  });

  it("reflects the backend's promoted cover after deleting the previous cover", async () => {
    mockedListPropertyMedia.mockResolvedValueOnce({
      data: [
        media({ id: "a", position: 0, is_cover: true }),
        media({ id: "b", position: 1, is_cover: false }),
      ],
    });
    mockedListPropertyMedia.mockResolvedValue({
      data: [media({ id: "b", position: 0, is_cover: true })],
    });
    mockedDeletePropertyMedia.mockResolvedValue(undefined);

    renderManager();
    await screen.findByRole("button", { name: "Excluir foto 1" });
    fireEvent.click(screen.getByRole("button", { name: "Excluir foto 1" }));
    await screen.findByText("Excluir esta foto?");
    fireEvent.click(screen.getByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(1));
    expect(await screen.findByText("Capa")).toBeInTheDocument();
  });

  it("shows a safe error message when delete fails", async () => {
    mockedListPropertyMedia.mockResolvedValue({ data: [media({ id: "a", position: 0 })] });
    mockedDeletePropertyMedia.mockRejectedValue(new Error("boom"));

    renderManager();
    await screen.findByRole("button", { name: "Excluir foto 1" });
    fireEvent.click(screen.getByRole("button", { name: "Excluir foto 1" }));
    await screen.findByText("Excluir esta foto?");
    fireEvent.click(screen.getByRole("button", { name: "Excluir" }));

    expect(await screen.findByText("Não foi possível excluir a foto.")).toBeInTheDocument();
  });

  it("uploads a selected file and shows it move from Enviando to Enviado", async () => {
    mockedListPropertyMedia.mockResolvedValue({ data: [] });
    let resolveUpload: (() => void) | undefined;
    mockedUploadPropertyMedia.mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = () => resolve(media());
      }),
    );

    renderManager();
    await screen.findByText("Nenhuma foto cadastrada.");

    const file = new File([new Uint8Array(1000)], "foto.jpg", { type: "image/jpeg" });
    const input = screen.getByLabelText("Adicionar fotos", { selector: "input" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("Enviando")).toBeInTheDocument();

    resolveUpload?.();
    expect(await screen.findByText("Enviado")).toBeInTheDocument();
  });

  it("rejects an invalid file client-side without calling the API", async () => {
    mockedListPropertyMedia.mockResolvedValue({ data: [] });

    renderManager();
    await screen.findByText("Nenhuma foto cadastrada.");

    const file = new File(["x"], "foto.gif", { type: "image/gif" });
    const input = screen.getByLabelText("Adicionar fotos", { selector: "input" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(/Formato não suportado/)).toBeInTheDocument();
    expect(mockedUploadPropertyMedia).not.toHaveBeenCalled();
  });

  it("hides the upload area and shows a message for an archived (INACTIVE) property", async () => {
    mockedListPropertyMedia.mockResolvedValue({ data: [media({ id: "a", position: 0 })] });

    renderManager("INACTIVE");

    expect(
      await screen.findByText("Envio de fotos desabilitado — o imóvel está arquivado."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adicionar fotos" })).not.toBeInTheDocument();
    // The existing gallery still renders (section 49).
    expect(await screen.findByRole("img")).toBeInTheDocument();
  });

  it("never calls the media endpoint for anything other than the property/tenant it was given", async () => {
    mockedListPropertyMedia.mockResolvedValue({ data: [] });

    renderManager();
    await screen.findByText("Nenhuma foto cadastrada.");

    expect(mockedListPropertyMedia).toHaveBeenCalledWith(TENANT_ID, PROPERTY_ID);
  });
});
