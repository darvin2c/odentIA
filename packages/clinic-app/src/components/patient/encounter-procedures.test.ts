import { describe, expect, it } from "vitest"
import type { PlanItem } from "../../lib/patients"
import { sessionChoices } from "./encounter-procedures"

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
 * Segundo repaso de la atención (9 nov): con la endodoncia de la 46 recién
 * indicada y aceptada junto con la corona, «Registrar lo de hoy» arrancaba en
 * «Seleccionar otro servicio del catálogo».
 */
describe("lo que trae puesto «Registrar lo de hoy»", () => {
  const corona = item({
    id: "corona",
    title: "Corona metal-cerámica",
    waitsFor: { id: "endo", title: "Endodoncia" },
  })
  const endo = item({ id: "endo", title: "Endodoncia" })
  const none = new Set<string | null>()

  it("viene puesta la endodoncia indicada hoy, no la corona que va después de ella", () => {
    const { ordered, preset } = sessionChoices([corona, endo], {
      encounterId: "hoy",
      brought: new Set(),
      doneToday: none,
    })
    expect(preset?.id).toBe("endo")
    // La corona va al final de la lista.
    expect(ordered.map((choice) => choice.id)).toEqual(["endo", "corona"])
  })

  it("con una sola opción, elegida sola, aunque se haya indicado otro día", () => {
    const old = item({ id: "resina", title: "Resina", sourceEncounterId: "antes" })
    expect(
      sessionChoices([old], { encounterId: "hoy", brought: new Set(), doneToday: none }).preset?.id,
    ).toBe("resina")
  })

  it("lo que trajo su cita va primero; con dos de la misma tanda no se adivina", () => {
    const resina = item({
      id: "resina",
      title: "Resina",
      toothNumber: 36,
      sourceEncounterId: "antes",
    })
    expect(
      sessionChoices([endo, resina], {
        encounterId: "hoy",
        brought: new Set(["resina"]),
        doneToday: none,
      }).preset?.id,
    ).toBe("resina")
    const exo = item({ id: "exo", title: "Exodoncia", toothNumber: 18 })
    expect(
      sessionChoices([endo, exo], { encounterId: "hoy", brought: new Set(), doneToday: none })
        .preset,
    ).toBeNull()
  })

  it("lo que ya tiene su sesión de hoy no vuelve a venir puesto; lo indicado hoy sin aceptar, sí (se acepta al hacerlo)", () => {
    expect(
      sessionChoices([endo, corona], {
        encounterId: "hoy",
        brought: new Set(),
        doneToday: new Set(["endo"]),
      }).preset,
    ).toBeNull()
    const pending = item({
      id: "endo",
      title: "Endodoncia",
      decision: "pendiente",
      decisionStatus: "pendiente",
    })
    expect(
      sessionChoices([pending], { encounterId: "hoy", brought: new Set(), doneToday: none }).preset
        ?.id,
    ).toBe("endo")
    // Lo indicado otro día y sin aceptar no viene puesto.
    const oldPending = item({
      id: "x",
      title: "Profilaxis",
      decision: "pendiente",
      sourceEncounterId: "antes",
    })
    expect(
      sessionChoices([oldPending], { encounterId: "hoy", brought: new Set(), doneToday: none })
        .preset,
    ).toBeNull()
  })
})
