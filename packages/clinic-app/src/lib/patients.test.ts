import { describe, expect, it } from "vitest"
import { splitPlans, type TreatmentPlanWithStatus } from "./patients"

const plan = (id: string, over: Partial<TreatmentPlanWithStatus>): TreatmentPlanWithStatus => ({
  plan: { id, patientId: "p", title: "Plan de tratamiento", originEncounterId: null, isLegacy: false, createdAt: "2026-11-06T15:00:00.000Z" },
  status: "En curso",
  totalItems: 1,
  pendingItems: 1,
  isOpen: false,
  active: false,
  ...over,
})

// QA del 6 nov (M12): lo aceptado y programado de un segundo plan abierto caía en «Planes anteriores».
describe("planes vigentes y anteriores", () => {
  it("anterior es solo el que ya no tiene nada por hacer", () => {
    const { current, previous } = splitPlans([
      plan("terminado", { status: "Completado", pendingItems: 0 }),
      plan("abierto", { active: true }),
      plan("recibe", { isOpen: true, active: true }),
    ])
    expect(current.map((row) => row.plan.id)).toEqual(["abierto", "recibe"])
    expect(previous.map((row) => row.plan.id)).toEqual(["terminado"])
  })
  it("sin ninguno abierto, el último sigue a la vista y los vacíos no son anteriores", () => {
    const { current, previous } = splitPlans([plan("vacio", { totalItems: 0 }), plan("ultimo", {})])
    expect(current.map((row) => row.plan.id)).toEqual(["ultimo"])
    expect(previous).toEqual([])
  })
})
