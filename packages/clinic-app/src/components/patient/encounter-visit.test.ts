import { beforeAll, describe, expect, it } from "vitest"
import { setOrgLocale } from "../../lib/locale"
import { visitToldHeading } from "../../lib/visit-answer-words"
import { visitAppointmentWords, visitBookedWords, visitWaitWords } from "./encounter-visit"

describe("«Hoy viene a…» con la espera entre sesiones (QA del 10 nov, B6)", () => {
  it("la sesión 1 de hoy avisa con los días que pide su servicio, sin trabar", () => {
    expect(visitWaitWords({ wait: { days: 7, sinceDays: 0, from: "2026-11-16" } })).toBe(
      "La sesión anterior fue hoy: la medicación suele dejarse una semana.",
    )
    expect(visitWaitWords({ wait: { days: 10, sinceDays: 1, from: "2026-11-18" } })).toBe(
      "La sesión anterior fue ayer: la medicación suele dejarse 10 días.",
    )
    expect(visitWaitWords({ wait: { days: 14, sinceDays: 3, from: "2026-11-20" } })).toBe(
      "La sesión anterior fue hace 3 días: la medicación suele dejarse 2 semanas.",
    )
  })

  it("sin espera pendiente no dice nada", () => {
    expect(visitWaitWords({ wait: null })).toBeNull()
    expect(visitWaitWords({})).toBeNull()
  })
})

// Mesa de formularios del 13 nov (UX-4): «…sáb 14 nov, 3:00 p. m..», con dos puntos al final.
describe("«Hoy vino sin cita. Ya tiene una reservada»", () => {
  /** Los espacios de la hora son especiales: se comparan como espacios. */
  const plain = (text: string) => text.replace(/\s/g, " ")
  const at = "2026-11-14T20:00:00.000Z"

  it("la hora ya termina en punto: la frase no lleva otro", () => {
    expect(plain(visitBookedWords({ startsAt: at, serviceName: null }, "es-PE", "America/Lima"))).toBe(
      "Hoy vino sin cita. Ya tiene una reservada: sáb 14 nov, 3:00 p. m.",
    )
  })

  it("con el servicio, o con un formato de 24 horas, cierra con su punto", () => {
    expect(plain(visitBookedWords({ startsAt: at, serviceName: "Limpieza dental" }, "es-PE", "America/Lima"))).toBe(
      "Hoy vino sin cita. Ya tiene una reservada: sáb 14 nov, 3:00 p. m. · Limpieza dental.",
    )
    expect(plain(visitBookedWords({ startsAt: at, serviceName: null }, "es-ES", "Europe/Madrid"))).toBe(
      "Hoy vino sin cita. Ya tiene una reservada: sáb 14 nov, 21:00.",
    )
  })
})

// QA final de formularios (15 nov, H2 y U2): lo que contó para su cita del lunes, si vino antes.
describe("lo que contó para otra cita", () => {
  beforeAll(() => void setOrgLocale("es-PE", "America/Lima", "PE"))
  const told = {
    by: { kind: "patient" as const, name: null, relation: null },
    submittedAt: "2026-11-15T03:50:00.000Z",
    submittedVia: "enlace" as const,
    appointmentStartsAt: "2026-11-16T16:00:00.000Z",
  }

  it("dice para qué cita lo contó, con su fecha", () => {
    expect(visitToldHeading({ ...told, otherAppointment: true }, "Rosa")).toBe("Para su cita del lun 16 nov, Rosa contó (14 nov, desde su enlace)")
    expect(visitToldHeading({ ...told, otherAppointment: true }, null)).toBe("Para su cita del lun 16 nov contó (14 nov, desde su enlace)")
    expect(
      visitToldHeading({ ...told, by: { kind: "representative", name: "Carla Ruiz", relation: "madre" }, otherAppointment: true }, "Mateo"),
    ).toBe("Para su cita del lun 16 nov, su madre, Carla, contó (14 nov, desde su enlace)")
  })

  it("lo de la cita de hoy se dice como siempre", () => {
    expect(visitToldHeading(told, "Rosa")).toBe("Lo que contó Rosa antes de venir (14 nov, desde su enlace)")
    expect(visitToldHeading({ ...told, otherAppointment: false }, null)).toBe("Lo que contó antes de venir (14 nov, desde su enlace)")
  })
})

// Acta, criterio 3 y B6: la sesión 2 adelantada en la cita de otra doctora decía solo su motivo.
describe("«Su cita» con su hora y su profesional", () => {
  const plain = (text: string) => text.replace(/\s/g, " ")
  const at = "2026-11-14T15:30:00.000Z"

  it("dice la hora y con quién", () => {
    expect(
      plain(visitAppointmentWords({ startsAt: at, professionalName: "Dra. Vela" }, "es-PE", "America/Lima")),
    ).toBe("10:30 a. m. · Dra. Vela")
  })

  it("de otro día, también el día; sin profesional, solo la hora", () => {
    expect(
      plain(visitAppointmentWords({ startsAt: at, professionalName: "Dra. Vela" }, "es-PE", "America/Lima", true)),
    ).toBe("sáb 14 nov, 10:30 a. m. · Dra. Vela")
    expect(plain(visitAppointmentWords({ startsAt: at, professionalName: null }, "es-PE", "America/Lima"))).toBe(
      "10:30 a. m.",
    )
  })
})
