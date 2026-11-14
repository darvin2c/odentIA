import { beforeEach, expect, it, vi } from "vitest"

// Solo la red es de mentira: `ApiError` es la de verdad, con su código.
vi.mock("./api", async () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      public shape: { code?: string; message?: string },
    ) {
      super(shape.message ?? `Error ${status}`)
    }
  }
  return { ApiError, apiFetch: vi.fn(), apiFetchBytes: vi.fn() }
})

import { ApiError, apiFetch } from "./api"
import { startFormResponse } from "./clinical-forms"

const fetchMock = vi.mocked(apiFetch)
const sent = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { encounterId: string | null })
const body = { templateId: "t-1", patientId: "p-1", encounterId: "e-1", answers: {} }

beforeEach(() => fetchMock.mockReset())

it("«Empezar» con la atención ya firmada o anulada en otra pestaña empieza el formulario igual, sin unirlo a ella", async () => {
  fetchMock
    .mockRejectedValueOnce(new ApiError(409, { code: "ENCOUNTER_CLOSED", message: "La atención ya está firmada" }))
    .mockResolvedValueOnce({ data: { id: "r-1", encounterId: null } })
  const result = await startFormResponse(body)
  expect(result).toMatchObject({ data: { id: "r-1" }, detached: true })
  // El segundo intento va sin la atención: no hace falta recargar para poder seguir.
  expect(sent().map((call) => call.encounterId)).toEqual(["e-1", null])
})

it("con la atención en curso se une a ella, y cualquier otro rechazo se dice tal cual", async () => {
  fetchMock.mockResolvedValueOnce({ data: { id: "r-2", encounterId: "e-1" } })
  expect(await startFormResponse(body)).toMatchObject({ data: { id: "r-2" }, detached: false })
  fetchMock.mockRejectedValueOnce(new ApiError(400, { code: "VALIDATION", message: "Solo una plantilla publicada admite capturas" }))
  await expect(startFormResponse(body)).rejects.toThrow("Solo una plantilla publicada")
  // Sin atención no hay a qué volver: el rechazo no se reintenta.
  fetchMock.mockRejectedValueOnce(new ApiError(409, { code: "ENCOUNTER_CLOSED" }))
  await expect(startFormResponse({ ...body, encounterId: null })).rejects.toBeInstanceOf(ApiError)
  expect(fetchMock).toHaveBeenCalledTimes(3)
})
