import { beforeAll, describe, expect, it } from "vitest"
import { setOrgLocale } from "../../lib/locale"
import { visitToldHeading } from "../../lib/visit-answer-words"
import { visitBookedWords, visitTreatmentsShown, visitWaitWords } from "./encounter-visit"

// QA del 16 nov, Q17: tras «Hacerla hoy» de lo indicado en esta atención, la tarjeta «Hoy viene a…»
// volvía con ese tratamiento, que ya está en «Realizado hoy» y en el Plan.
describe("«Hoy viene a…» solo lleva lo de antes", () => {
  const treatments = [
    { planItemId: "endodoncia-hoy", linked: true },
    { planItemId: "corona-de-antes", linked: false },
    { planItemId: "limpieza-de-antes", linked: true },
  ]

  it("lo indicado en esta atención no se repite, tampoco después de «Hacerla hoy»", () => {
    expect(visitTreatmentsShown(treatments, new Set(["endodoncia-hoy"])).map((item) => item.planItemId)).toEqual([
      "corona-de-antes",
      "limpieza-de-antes",
    ])
  })

  it("si todo lo suyo es de esta atención, no queda nada que mostrar", () => {
    expect(visitTreatmentsShown([treatments[0]!], new Set(["endodoncia-hoy"]))).toEqual([])
  })
})

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
