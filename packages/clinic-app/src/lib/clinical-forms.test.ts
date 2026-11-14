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
import {
  canFillFormInAttention,
  finalizedWords,
  formStateWords,
  startFormResponse,
  unfinishedAfterSigning,
  voidedAttentionFormWords,
} from "./clinical-forms"

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

it("en la atención ya firmada, el formulario a medias se abre para terminarlo", () => {
  // En curso y la lleva quien mira: se llena.
  expect(canFillFormInAttention(true, false, "borrador")).toBe(true)
  // En curso, pero no se puede trabajar en ella (la lleva otra persona): no.
  expect(canFillFormInAttention(true, true, "borrador")).toBe(false)
  // Firmada: la atención ya no se trabaja, pero su formulario a medias se termina igual.
  expect(canFillFormInAttention(true, true, "finalizada")).toBe(true)
  // Sin permiso de escribir en la historia, nunca.
  expect(canFillFormInAttention(false, true, "finalizada")).toBe(false)
})

it("la atención firmada dice qué formularios le quedaron a medias", () => {
  const forms = [
    { id: "a", status: "borrador" as const, source: "staff" as const },
    { id: "b", status: "finalizado" as const, source: "staff" as const },
    { id: "c", status: "descartado" as const, source: "staff" as const },
  ]
  expect(unfinishedAfterSigning(forms, "finalizada").map((form) => form.id)).toEqual(["a"])
  // Mientras sigue en curso no es un pendiente aparte: se está llenando.
  expect(unfinishedAfterSigning(forms, "borrador")).toEqual([])
})

it("lo finalizado se dice con fecha y hora, y si fue después de firmar su atención", () => {
  const at = (iso: string) => `[${iso.slice(11, 16)}]`
  expect(finalizedWords({ finalizedAt: null, encounterFinalizedAt: null }, at)).toBeNull()
  expect(finalizedWords({ finalizedAt: "2026-11-14T02:51:00.000Z", encounterFinalizedAt: null }, at)).toBe("finalizado [02:51]")
  // La atención se firmó a las 02:48 y el formulario se terminó a las 02:51.
  expect(
    finalizedWords({ finalizedAt: "2026-11-14T02:51:00.000Z", encounterFinalizedAt: "2026-11-14T02:48:00.000Z" }, at),
  ).toBe("finalizado [02:51] · después de firmar la atención")
  // Terminado antes de firmar: no se dice.
  expect(
    finalizedWords({ finalizedAt: "2026-11-14T02:40:00.000Z", encounterFinalizedAt: "2026-11-14T02:48:00.000Z" }, at),
  ).toBe("finalizado [02:40]")
  // Con quién lo finalizó, se nombra.
  expect(
    finalizedWords({ finalizedAt: "2026-11-14T02:51:00.000Z", encounterFinalizedAt: "2026-11-14T02:48:00.000Z" }, at, "Ana Ríos"),
  ).toBe("lo finalizó Ana Ríos el [02:51] · después de firmar la atención")
})

it("el estado de un formulario en la lista dice si quedó a medias al firmar o si es de una atención anulada", () => {
  const row = { status: "borrador" as const, submittedAt: null, encounterStatus: null }
  expect(formStateWords(row)).toBe("Sin finalizar")
  expect(formStateWords({ ...row, encounterStatus: "finalizada" })).toBe("Quedó a medias al firmar la atención: falta terminarlo")
  expect(formStateWords({ ...row, submittedAt: "2026-11-13T10:00:00.000Z" })).toBe("Lo declaró la persona · por revisar")
  expect(formStateWords({ ...row, status: "finalizado" })).toBe("Finalizado")
  expect(formStateWords({ ...row, status: "finalizado", encounterStatus: "anulada" })).toBe("Finalizado · de una atención anulada")
})

it("la atención anulada dice qué pasó con cada formulario que tenía", () => {
  const at = (iso: string) => `[${iso.slice(11, 16)}]`
  const base = { title: "Evaluación de endodoncia", finalizedAt: null, discardReason: null, discardedWithAttention: false }
  // El que quedó sin terminar: la anulación lo descartó, con su mismo motivo.
  expect(
    voidedAttentionFormWords(
      { ...base, state: "descartado", discardedWithAttention: true, discardReason: "Atención anulada: Se abrió por error" },
      at,
    ),
  ).toBe("Formulario: Evaluación de endodoncia · quedó sin terminar y se descartó al anular la atención, con ese motivo")
  // El que se descartó antes, a mano: con el motivo que se dio entonces.
  expect(voidedAttentionFormWords({ ...base, state: "descartado", discardReason: "No era este formulario" }, at)).toBe(
    "Formulario: Evaluación de endodoncia · descartado antes de anular · Motivo: No era este formulario",
  )
  // El finalizado se conserva, y se dice de dónde es.
  expect(voidedAttentionFormWords({ ...base, state: "finalizado", finalizedAt: "2026-11-14T04:03:00.000Z" }, at)).toBe(
    "Formulario: Evaluación de endodoncia · finalizado [04:03] · se conserva, marcado como de una atención anulada",
  )
})
