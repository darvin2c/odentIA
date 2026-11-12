import { describe, expect, it } from "vitest"
import { approvedDraftOf, draftSummaryWords, type ImportDraft } from "./import-drafts"

const draft = (patch: Partial<ImportDraft>): ImportDraft => ({
  id: "d1",
  clientId: "c1",
  organizationId: "o1",
  kind: "plan_configuracion",
  number: 1,
  status: "aprobada",
  summary: null,
  pdfFileId: null,
  viaSkill: true,
  uploadedBy: { userId: "u1", name: "Ada Ríos" },
  approvedBy: { userId: "u1", name: "Ada Ríos" },
  approvedAt: "2026-11-11T15:00:00.000Z",
  returnedNote: null,
  payloadDeletedAt: null,
  createdAt: "2026-11-11T14:00:00.000Z",
  updatedAt: "2026-11-11T15:00:00.000Z",
  ...patch,
})

describe("approvedDraftOf", () => {
  it("las tarjetas solo toman lo aprobado de su tipo cuyo archivo sigue guardado", () => {
    const drafts = [
      draft({ id: "lista", status: "lista", number: 3 }),
      draft({ id: "borrado", number: 2, payloadDeletedAt: "2026-12-11T00:00:00.000Z" }),
      draft({ id: "pacientes", kind: "plan_pacientes" }),
      draft({ id: "bueno", number: 1 }),
    ]
    expect(approvedDraftOf(drafts, "plan_configuracion")?.id).toBe("bueno")
    expect(approvedDraftOf(drafts, "informe")).toBeNull()
    expect(approvedDraftOf(undefined, "plan_pacientes")).toBeNull()
  })

  it("sin el campo del borrado (API de antes) el aprobado sigue valiendo", () => {
    const { payloadDeletedAt: _, ...old } = draft({})
    expect(approvedDraftOf([old as ImportDraft], "plan_configuracion")?.id).toBe("d1")
  })
})

describe("draftSummaryWords", () => {
  it("dice las cifras conocidas en palabras y deja fuera lo desconocido y los ceros", () => {
    expect(
      draftSummaryWords({ servicios: 38, sedes: 1, proveedores: 0, raro: 4, mediosDePago: 3 }),
    ).toBe("38 servicios · 1 sede · 3 medios de pago")
    expect(draftSummaryWords(null)).toBe("")
  })
})
