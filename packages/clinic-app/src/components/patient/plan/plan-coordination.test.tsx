import { describe, expect, it } from "vitest"
import type { SchedulableControl } from "../../../lib/clinical-journey"
import { controlsToReserve } from "./plan-coordination"

const control = (over: Partial<SchedulableControl>): SchedulableControl => ({
  id: "c",
  patientId: "p",
  title: "Control de mantenimiento",
  dueAt: "2027-05-06T14:00:00.000Z",
  status: "pendiente",
  appointment: null,
  legacyScheduledAt: null,
  branchId: null,
  windowFrom: "2027-03-22T14:00:00.000Z",
  ...over,
})

// QA del 6 nov (A2): el cajón de una cita atendida decía siempre «Sus controles
// quedaron hechos», aunque el control de 6 meses indicado ese día seguía pendiente.
describe("lo que falta reservar en el cajón de una cita atendida", () => {
  it("un control indicado hoy, pendiente y sin cita, falta reservarlo", () => {
    expect(controlsToReserve([control({ id: "nuevo" })]).map((row) => row.id)).toEqual(["nuevo"])
  })

  it("con cita en pie, realizado o cancelado, no falta reservar nada", () => {
    const appointment = { id: "a", startsAt: "2027-05-06T14:00:00.000Z", endsAt: "2027-05-06T14:30:00.000Z" }
    const rows = [
      control({ id: "con-cita", status: "programado", appointment: { ...appointment, status: "confirmada" } }),
      control({ id: "hecho", status: "realizado" }),
      control({ id: "cancelado", status: "cancelado" }),
    ]
    expect(controlsToReserve(rows)).toEqual([])
  })

  it("si su cita se canceló, el control vuelve a faltar reservarlo", () => {
    const appointment = { id: "a", startsAt: "2027-05-06T14:00:00.000Z", endsAt: "2027-05-06T14:30:00.000Z" }
    const rows = [control({ id: "sin-cita", appointment: { ...appointment, status: "cancelada" } })]
    expect(controlsToReserve(rows).map((row) => row.id)).toEqual(["sin-cita"])
  })
})
