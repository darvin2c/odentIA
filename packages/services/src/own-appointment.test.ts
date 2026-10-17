/**
 * La persona actúa sobre su cita con una sola regla (fase 4, tablero 2b): la
 * del enlace, la misma para el portal. Antes el portal pedía fecha futura y
 * 120 días, el enlace no miraba nada y confirmar lo ya confirmado daba error
 * en uno y no en otro.
 */
import { expect, it } from "vitest"
import { assertOwnAppointmentChangeable, assertOwnNewTime, OWN_APPOINTMENT_HORIZON_DAYS, ownAppointmentChangeable } from "./own-appointment.js"

const NOW = new Date("2026-10-16T15:00:00Z")
const DAY = 86_400_000

it("solo se toca una cita en pie que no empezó", () => {
  const later = new Date(NOW.getTime() + DAY)
  expect(ownAppointmentChangeable({ status: "programada", startsAt: later }, NOW)).toBe(true)
  expect(ownAppointmentChangeable({ status: "confirmada", startsAt: later }, NOW)).toBe(true)
  expect(ownAppointmentChangeable({ status: "cancelada", startsAt: later }, NOW)).toBe(false)
  expect(ownAppointmentChangeable({ status: "programada", startsAt: new Date(NOW.getTime() - 60_000) }, NOW)).toBe(false)
  expect(() => assertOwnAppointmentChangeable({ status: "atendida", startsAt: later }, NOW)).toThrow(
    expect.objectContaining({ code: "BOOKING_NOT_CHANGEABLE", status: 409 }),
  )
})

it("la hora nueva es futura y dentro del horizonte, venga del enlace o del portal", () => {
  expect(() => assertOwnNewTime(new Date(NOW.getTime() - DAY).toISOString(), NOW)).toThrow("Elige una fecha futura")
  expect(() => assertOwnNewTime(new Date(NOW.getTime() + (OWN_APPOINTMENT_HORIZON_DAYS + 1) * DAY).toISOString(), NOW)).toThrow(
    /próximos 120 días/,
  )
  expect(() => assertOwnNewTime("mañana", NOW)).toThrow("Fecha ISO inválida")
  const ok = new Date(NOW.getTime() + 7 * DAY)
  expect(assertOwnNewTime(ok.toISOString(), NOW).getTime()).toBe(ok.getTime())
})
