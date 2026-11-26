import { describe, expect, it } from "vitest"
import type { SupportAccess } from "./api"
import { atTime, endedMessage, hourOf, stripMessage, supportLine } from "./soporte"

/** Una hora de hoy (o de otro día) en la zona de quien corre la prueba. */
function at(hours: number, minutes: number, dayOffset = 0): Date {
  const date = new Date()
  date.setDate(date.getDate() + dayOffset)
  date.setHours(hours, minutes, 0, 0)
  return date
}
const now = at(10, 50)
const iso = (date: Date) => date.toISOString()

describe("las palabras de soporte mirando una tienda (ADR 0219)", () => {
  it("las horas, siempre «3:10 p. m.», y la una en singular", () => {
    expect(hourOf(at(15, 10))).toBe("3:10 p. m.")
    expect(atTime(at(11, 12), now)).toBe("las 11:12 a. m.")
    expect(atTime(at(13, 5), now)).toBe("la 1:05 p. m.")
    expect(atTime(at(9, 30, 1), now)).toMatch(/^el \d{1,2} [a-z]{3} a las 9:30 a\. m\.$/)
  })

  it("la franja dice qué tienda, hasta cuándo y que no cambia nada", () => {
    expect(stripMessage("Calzados Rosa", iso(at(11, 12)), now)).toBe(
      "Solo mirar · Estás viendo Calzados Rosa como soporte de gestorIA, hasta las 11:12 a. m. No puedes cambiar nada.",
    )
  })

  it("«El acceso terminó» dice el motivo, nunca «te quitaron del equipo»", () => {
    const ended = (reason: "tiempo" | "quitado" | "salio" | "rechazado" | "sin_respuesta") =>
      endedMessage({ state: "terminado", reason, at: iso(at(10, 50)), byName: "Luis Mamani" }, now)
    expect(ended("tiempo")).toBe("A las 10:50 a. m.: se terminó el tiempo.")
    expect(ended("quitado")).toBe("A las 10:50 a. m.: Luis Mamani terminó tu acceso.")
    expect(ended("salio")).toBe("A las 10:50 a. m.: saliste.")
    expect(ended("rechazado")).toBe("A las 10:50 a. m.: la tienda dijo que no.")
    expect(ended("sin_respuesta")).toBe("A las 10:50 a. m.: la tienda no respondió a tiempo.")
    expect(
      endedMessage({ state: "terminado", reason: "quitado", at: iso(now), byName: null }, now),
    ).toBe("A las 10:50 a. m.: alguien de la tienda terminó tu acceso.")
  })

  it("en Equipo, quién miró, desde cuándo, quién lo aceptó y cómo terminó", () => {
    const base: SupportAccess = {
      id: "a1",
      staffName: "Ana Torres",
      minutes: 30,
      reason: "revisar las fotos",
      status: "vigente",
      requestedAt: iso(at(10, 30)),
      answeredAt: iso(at(10, 40)),
      answeredBy: "lucia",
      answeredByName: "Lucía Quispe",
      expiresAt: iso(at(11, 10)),
      usedAt: iso(at(10, 42)),
      ending: null,
    }
    expect(supportLine(base, "rosa", now)).toEqual({
      title: "Ana Torres está mirando tu tienda desde las 10:42 a. m., hasta las 11:10 a. m.",
      detail: "Para: revisar las fotos. Lo aceptó Lucía Quispe.",
    })
    expect(supportLine({ ...base, usedAt: null }, "lucia", now)).toEqual({
      title: "Ana Torres puede mirar tu tienda hasta las 11:10 a. m. · todavía no entró",
      detail: "Para: revisar las fotos. Lo aceptaste tú.",
    })
    const ended = (ending: SupportAccess["ending"], usedAt: string | null = base.usedAt) =>
      supportLine({ ...base, status: "terminado", usedAt, ending }, "rosa", now).title
    expect(
      ended({ reason: "quitado", at: iso(at(10, 50)), by: "luis", byName: "Luis Mamani" }),
    ).toMatch(
      /^Ana Torres miró tu tienda el \d{1,2} [a-z]{3} a las 10:42 a\. m\. · Luis Mamani terminó el acceso a las 10:50 a\. m\.$/,
    )
    expect(ended({ reason: "quitado", at: iso(at(10, 50)), by: "rosa", byName: "Rosa" })).toMatch(
      /· terminaste el acceso a las 10:50 a\. m\.$/,
    )
    expect(ended({ reason: "tiempo", at: iso(at(11, 10)), by: null, byName: null })).toMatch(
      /· se terminó el tiempo a las 11:10 a\. m\.$/,
    )
    expect(ended({ reason: "salio", at: iso(at(10, 55)), by: null, byName: null })).toMatch(
      /· salió a las 10:55 a\. m\.$/,
    )
    expect(ended({ reason: "tiempo", at: iso(at(11, 10)), by: null, byName: null }, null)).toMatch(
      /^Ana Torres podía mirar tu tienda hasta el .+ a las 11:10 a\. m\. · no entró$/,
    )
    expect(
      supportLine(
        {
          ...base,
          status: "rechazado",
          usedAt: null,
          ending: { reason: "rechazado", at: iso(now), by: "rosa", byName: "Rosa" },
        },
        "rosa",
        now,
      ),
    ).toEqual({
      title: expect.stringMatching(/^Ana Torres pidió mirar tu tienda el .+ · dijiste que no$/),
      detail: "Para: revisar las fotos.",
    })
    // Ventas solo ve quién mira y hasta cuándo.
    expect(
      supportLine(
        {
          id: "a1",
          staffName: "Ana Torres",
          status: "vigente",
          expiresAt: iso(at(11, 10)),
          usedAt: iso(at(10, 42)),
        },
        "mayra",
        now,
      ),
    ).toEqual({
      title: "Ana Torres está mirando tu tienda desde las 10:42 a. m., hasta las 11:10 a. m.",
      detail: null,
    })
  })
})
