import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/http/api-error";

import { mapPublicLeadCaptureError } from "./map-public-lead-capture-error";

describe("mapPublicLeadCaptureError", () => {
  it("maps 400 to a contextual validation message", () => {
    expect(mapPublicLeadCaptureError(new ApiError(400, "Bad Request"))).toBe(
      "Verifique os dados informados.",
    );
  });

  it("maps 404 to an unavailable-property message", () => {
    expect(mapPublicLeadCaptureError(new ApiError(404, "Not Found"))).toBe(
      "Este imóvel não está disponível para receber novos contatos.",
    );
  });

  it("maps 429 to a rate-limit message", () => {
    expect(mapPublicLeadCaptureError(new ApiError(429, "Too Many Requests"))).toBe(
      "Muitas tentativas em pouco tempo. Aguarde um momento e tente novamente.",
    );
  });

  it("maps 503 to a safe unavailable message with no infra details", () => {
    expect(mapPublicLeadCaptureError(new ApiError(503, "Service Unavailable"))).toBe(
      "Não foi possível enviar seu interesse agora. Tente novamente mais tarde.",
    );
  });

  it("maps 409 (tenant not ready) to the same safe unavailable message as 503", () => {
    expect(mapPublicLeadCaptureError(new ApiError(409, "Conflict"))).toBe(
      "Não foi possível enviar seu interesse agora. Tente novamente mais tarde.",
    );
  });

  it("maps an unmapped status / non-ApiError to a generic message", () => {
    expect(mapPublicLeadCaptureError(new ApiError(500, "Internal Server Error"))).toBe(
      "Não foi possível enviar seu interesse.",
    );
    expect(mapPublicLeadCaptureError(new Error("network failure"))).toBe(
      "Não foi possível enviar seu interesse.",
    );
  });
});
