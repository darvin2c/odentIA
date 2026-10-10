import { describe, expect, it } from "vitest"
import { findScheduleConflicts } from "./conflicts.js"
import type { ScheduleStatus } from "./types.js"

interface DemoAppointment {
  id: string
  title: string
  professionalId: string
  chairId: string
  start: string
  end: string
  status: ScheduleStatus
}

const base: DemoAppointment = {
  id: "a",
  title: "Persona",
  professionalId: "ana",
  chairId: "one",
  start: "2026-09-24T14:00:00Z",
  end: "2026-09-24T15:00:00Z",
  status: "confirmada",
}
const appointment = (id: string, patch: Partial<DemoAppointment> = {}): DemoAppointment => ({
  ...base,
  id,
  ...patch,
})

describe("solapamientos de recursos ocupables", () => {
  it("detecta conflictos independientes de profesional y sillón aunque el otro recurso cambie", () => {
    const conflicts = findScheduleConflicts([
      base,
      appointment("b", { chairId: "two" }),
      appointment("c", { professionalId: "luis" }),
    ])
    expect(conflicts.get("a")).toEqual({ professional: true, chair: true })
    expect(conflicts.get("b")).toEqual({ professional: true, chair: false })
    expect(conflicts.get("c")).toEqual({ professional: false, chair: true })
    expect(
      findScheduleConflicts([base, appointment("d", { professionalId: "luis", chairId: "two" })])
        .size,
    ).toBe(0)
  })
  it("no marca intervalos contiguos ni citas canceladas o ausentes", () => {
    const conflicts = findScheduleConflicts([
      base,
      appointment("next", { start: base.end, end: "2026-09-24T16:00:00Z" }),
      appointment("cancelled", { status: "cancelada" }),
      appointment("absent", { status: "no_asistio" }),
    ])
    expect(conflicts.size).toBe(0)
  })
  it("detecta intervalos contenidos y equivalentes en otras zonas sin depender del orden", () => {
    const nested = appointment("nested", {
      start: "2026-09-24T09:15:00-05:00",
      end: "2026-09-24T09:30:00-05:00",
    })
    expect([...findScheduleConflicts([nested, base]).keys()].sort()).toEqual(["a", "nested"])
  })
  it("desaparece al mover, recortar o cancelar la cita que provocaba el choque", () => {
    const second = appointment("b")
    expect(findScheduleConflicts([base, second]).size).toBe(2)
    expect(
      findScheduleConflicts([base, { ...second, start: base.end, end: "2026-09-24T16:00:00Z" }])
        .size,
    ).toBe(0)
    expect(findScheduleConflicts([base, { ...second, status: "cancelada" }]).size).toBe(0)
  })
})
