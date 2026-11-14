// @vitest-environment jsdom

/**
 * «Agregar una corrección» a lo que envió el paciente lleva «Motivo (opcional)»
 * (decisión del 14 nov): la norma de historia clínica pide el motivo, pero vacío no
 * traba la corrección.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { FormResponse } from "../../lib/clinical-forms"
import { setOrgLocale } from "../../lib/locale"

const add = vi.hoisted(() => vi.fn())
const addenda = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }))
vi.mock("../../lib/crm", () => ({ useMemberName: () => () => "Dra. Ana Torres", useOrgMembers: () => [] }))
vi.mock("../../lib/clinical-forms", async (original) => ({
  ...(await original<typeof import("../../lib/clinical-forms")>()),
  addFormAddendum: add,
  fetchFormAddenda: async () => ({ data: addenda.list }),
}))

const { DeclaredResponse, correctionLostWords } = await import("./declared-response")

beforeAll(() => {
  setOrgLocale("es-PE", "America/Lima")
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
})

afterEach(() => {
  cleanup()
  add.mockReset()
  addenda.list = []
})

const sent: FormResponse = {
  id: "r1",
  organizationId: "org",
  templateId: "t1",
  templateVersion: 1,
  templateTitle: "Cuestionario de salud",
  templateSnapshot: {
    sections: [
      { id: "antes", title: "Antes de tu cita", fields: [{ id: "motivo", label: "¿Por qué vienes?", type: "texto_largo" }] },
    ],
  },
  patientId: "p1",
  encounterId: null,
  professionalUserId: null,
  status: "borrador",
  answers: { motivo: "Me duele la muela de la derecha" },
  finalizedAt: null,
  source: "portal",
  submittedAt: "2026-11-13T19:27:00.000Z",
  submittedVia: "enlace",
  finalizedBy: null,
  respondent: { kind: "patient", name: "Marta Ríos", relation: null },
  editedByTeamAt: null,
  discardedAt: null,
  discardReason: null,
  createdAt: "2026-11-13T19:20:00.000Z",
  updatedAt: "2026-11-13T19:27:00.000Z",
}

function show() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DeclaredResponse response={sent} canWrite sex="F" />
    </QueryClientProvider>,
  )
}

describe("la corrección de lo que envió el paciente, con su motivo", () => {
  it("pide la corrección y ofrece el motivo como opcional; se guarda con los dos", async () => {
    add.mockResolvedValue({ data: { id: "a1" } })
    show()
    fireEvent.click(screen.getByRole("button", { name: "Agregar una corrección" }))
    fireEvent.change(screen.getByLabelText("Tu corrección"), { target: { value: "Es la izquierda, la 36." } })
    const reason = screen.getByLabelText("Motivo (opcional)")
    expect(reason.getAttribute("aria-required")).not.toBe("true")
    fireEvent.change(reason, { target: { value: " Lo confirmó en consulta " } })
    fireEvent.click(screen.getByRole("button", { name: "Guardar corrección" }))
    await waitFor(() => expect(add).toHaveBeenCalledWith("r1", "Es la izquierda, la 36.", "Lo confirmó en consulta"))
  })

  it("sin motivo también se guarda: no traba", async () => {
    add.mockResolvedValue({ data: { id: "a1" } })
    show()
    fireEvent.click(screen.getByRole("button", { name: "Agregar una corrección" }))
    fireEvent.change(screen.getByLabelText("Tu corrección"), { target: { value: "Toma aspirina." } })
    fireEvent.click(screen.getByRole("button", { name: "Guardar corrección" }))
    await waitFor(() => expect(add).toHaveBeenCalledWith("r1", "Toma aspirina.", ""))
  })

  it("la corrección guardada dice su motivo, si lo tiene", async () => {
    addenda.list = [
      { id: "a1", responseId: "r1", text: "Es la izquierda.", reason: "Lo confirmó en consulta", createdBy: "u1", createdAt: "2026-11-14T14:35:00.000Z" },
      { id: "a2", responseId: "r1", text: "Toma aspirina.", reason: null, createdBy: "u1", createdAt: "2026-11-14T14:36:00.000Z" },
    ]
    show()
    expect(await screen.findByText("Motivo: Lo confirmó en consulta")).toBeTruthy()
    expect(screen.getAllByText(/^Motivo:/)).toHaveLength(1)
  })

  it("al salir sin guardar nombra lo que se pierde: la corrección, el motivo o los dos (verificador, 14 nov)", () => {
    expect(correctionLostWords("Es la 36", "")).toBe("Se pierde la corrección que escribiste y no guardaste.")
    expect(correctionLostWords("  ", "Lo confirmó")).toBe("Se pierde el motivo que escribiste y no guardaste.")
    expect(correctionLostWords("Es la 36", "Lo confirmó")).toBe(
      "Se pierden la corrección y el motivo que escribiste y no guardaste.",
    )
    expect(correctionLostWords(" ", " ")).toBeNull()
  })
})
