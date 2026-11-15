import { afterEach, describe, expect, it, vi } from "vitest"
import { setOrgLocale } from "./locale"
import { ageFrom, splitPlans, type TreatmentPlanWithStatus } from "./patients"

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

// QA de formularios del 15 nov (K13): la edad subía un día antes en Lima, porque
// la fecha de nacimiento se leía como medianoche UTC. Se cuenta con el día de la clínica.
describe("la edad, con el día de la clínica", () => {
  afterEach(() => {
    vi.useRealTimers()
    setOrgLocale(undefined)
  })
  const at = (iso: string) => {
    setOrgLocale("es-PE", "America/Lima")
    vi.useFakeTimers()
    vi.setSystemTime(new Date(iso))
  }
  it("la víspera del cumpleaños, a las 20:00 de Lima (ya es el día siguiente en UTC), aún no los cumple", () => {
    at("2026-11-15T01:00:00Z")
    expect(ageFrom("2014-11-15")).toBe("11")
  })
  it("la víspera del cumpleaños por la mañana, tampoco", () => {
    at("2026-11-14T15:00:00Z")
    expect(ageFrom("2014-11-15")).toBe("11")
  })
  it("el día del cumpleaños, a las 20:00 de Lima, ya los cumplió", () => {
    at("2026-11-16T01:00:00Z")
    expect(ageFrom("2014-11-15")).toBe("12")
  })
  it("sin una fecha real, no supone edad", () => {
    at("2026-11-15T01:00:00Z")
    expect(ageFrom(null)).toBe("")
    expect(ageFrom("no-es-fecha")).toBe("")
    expect(ageFrom("2030-01-01")).toBe("")
  })
})
