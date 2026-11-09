import { afterEach, describe, expect, it } from "vitest"
import { clinicDateTimeValue, formatDate, instantFromClinicValue, encounterControls, type FollowUp, followUpAppointmentLabel } from "./clinical-journey"
import { setOrgLocale } from "./locale"

afterEach(() => {
  setOrgLocale(undefined, undefined)
})

describe("fechas clínicas en la zona de la clínica, no en la del navegador", () => {
  it("un campo de fecha y hora se lee y se escribe con el reloj de la clínica", () => {
    // Una clínica en Tokio (UTC+9): sea cual sea la zona de quien corre la prueba.
    setOrgLocale("es-PE", "Asia/Tokyo")
    expect(clinicDateTimeValue("2026-10-22T01:30:00.000Z")).toBe("2026-10-22T10:30")
    expect(instantFromClinicValue("2026-10-22T10:30")).toBe("2026-10-22T01:30:00.000Z")
    // Pasada la medianoche de la clínica es otro día, aunque en UTC aún no lo sea.
    expect(clinicDateTimeValue("2026-10-22T16:00:00.000Z")).toBe("2026-10-23T01:00")
    expect(instantFromClinicValue("2026-10-22T25:00")).toBeNull()
    expect(instantFromClinicValue("")).toBeNull()
  })

  it("una fecha sin hora no se mueve de día", () => {
    setOrgLocale("es-PE", "America/Lima")
    expect(formatDate("2026-10-22")).toBe("22/10/2026")
    // Un instante se dice en el día de la clínica: las 02:00 UTC aún son el día anterior en Lima.
    expect(formatDate("2026-10-22T02:00:00.000Z")).toBe("21/10/2026")
  })
})

// QA del 8 nov: lo que dice el Plan de la cita de cada control.
describe("la cita de un control en el Plan", () => {
  const control = { appointment: null, legacyScheduledAt: null, status: "pendiente" as const, servedBy: null }
  it("M6: con una cita por venir que le sirve, dice esa cita, como «Qué sigue» y el Resumen", () => {
    setOrgLocale("es-PE", "America/Lima")
    expect(followUpAppointmentLabel(control)).toBe("Sin cita reservada")
    expect(followUpAppointmentLabel({ ...control, servedBy: { id: "a", startsAt: "2026-11-09T15:00:00.000Z" } })).toMatch(
      /^Sin cita propia · se puede hacer en su cita del 09\/11\/2026/,
    )
  })
  it("B5: un control realizado o cancelado sin cita no dice «Sin cita reservada»", () => {
    expect(followUpAppointmentLabel({ ...control, status: "realizado" })).toBeNull()
    expect(followUpAppointmentLabel({ ...control, status: "cancelado" })).toBeNull()
  })
})

// QA del 6 nov (M13): dentro de la atención decía «Sin controles» a quien tenía dos abiertos.
describe("los controles dentro de una atención", () => {
  const row = (id: string, over: Partial<FollowUp>) =>
    ({ id, status: "pendiente", originEncounterId: "otra", completedEncounterId: null, ...over }) as FollowUp
  it("separa los suyos de los que la persona ya tiene abiertos de otras atenciones", () => {
    const rows = [
      row("hoy", { originEncounterId: "esta" }),
      row("endodoncia", { status: "programado" }),
      row("profilaxis", {}),
      row("hecho", { status: "realizado" }),
    ]
    const { own, others } = encounterControls(rows, "esta")
    expect(own.map((item) => item.id)).toEqual(["hoy"])
    expect(others.map((item) => item.id)).toEqual(["endodoncia", "profilaxis"])
  })
  it("fuera de una atención, todos son de la lista", () => {
    expect(encounterControls([row("a", {})], undefined)).toEqual({ own: [row("a", {})], others: [] })
  })
})
