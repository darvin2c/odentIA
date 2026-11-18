import { describe, expect, it } from "vitest"
import type { PlanItem } from "../../lib/patients"
import { procedureSchema, sessionChoices } from "./encounter-procedures"

const item = (over: Partial<PlanItem> & Pick<PlanItem, "id" | "title">): PlanItem =>
  ({
    planId: "plan",
    budgetId: null,
    decision: "aceptado",
    decisionStatus: "aceptado",
    decidedAt: null,
    decidedByContactId: null,
    decidedByName: null,
    decisionNote: null,
    supersedesItemId: null,
    statusReason: null,
    startedAt: null,
    completedAt: null,
    serviceId: "servicio",
    toothNumber: 46,
    scope: "tooth",
    surfaces: [],
    quadrant: null,
    arch: null,
    detail: null,
    diagnosisCode: null,
    priceCents: 45000,
    currency: "PEN",
    status: "pendiente",
    sourceEncounterId: "hoy",
    createdAt: "2026-11-09T16:00:00.000Z",
    ...over,
  }) as PlanItem

/**
 * En qué orden se ofrece lo del plan al registrar (segundo repaso del 9 nov). Nada viene puesto
 * solo: lo del plan se registra desde su fila y «Registrar algo fuera del plan» abre en el
 * catálogo (revisión del 17 nov).
 */
describe("el orden de lo del plan al registrar", () => {
  const corona = item({
    id: "corona",
    title: "Corona metal-cerámica",
    waitsFor: { id: "endo", title: "Endodoncia" },
  })
  const endo = item({ id: "endo", title: "Endodoncia" })

  it("la corona que va después de la endodoncia va al final", () => {
    expect(
      sessionChoices([corona, endo], { encounterId: "hoy", brought: new Set() }).map(
        (choice) => choice.id,
      ),
    ).toEqual(["endo", "corona"])
  })

  it("primero lo que trajo su cita, después lo indicado hoy y después lo de otros días", () => {
    const resina = item({ id: "resina", title: "Resina", toothNumber: 36, sourceEncounterId: "antes" })
    const exo = item({ id: "exo", title: "Exodoncia", toothNumber: 18, sourceEncounterId: "antes" })
    expect(
      sessionChoices([exo, endo, resina], { encounterId: "hoy", brought: new Set(["resina"]) }).map(
        (choice) => choice.id,
      ),
    ).toEqual(["resina", "endo", "exo"])
  })
})

describe("procedureSchema (revisión del 16 nov, R10)", () => {
  const empty = {
    freeMode: false,
    description: "",
    service: null,
    planItemId: "",
    site: { toothNumber: null, surfaces: [] },
    quadrant: "",
    arch: "",
    quantity: "1",
    diagnosisCode: "",
    diagnosisSystem: null,
  }

  it("con tratamientos por elegir y nada elegido, pide «Elige qué hiciste» en el tratamiento, no en el catálogo oculto", () => {
    const result = procedureSchema({}, () => true).safeParse(empty)
    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.error.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
        ["planItemId", "Elige qué hiciste"],
      ])
  })

  it("elegido «Otro servicio del catálogo» (o sin tratamientos), pide el servicio como siempre", () => {
    const result = procedureSchema({}, () => false).safeParse(empty)
    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.error.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
        ["service", "Elige el tratamiento"],
      ])
  })
})
