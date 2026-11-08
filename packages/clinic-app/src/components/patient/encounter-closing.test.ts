import { afterEach, describe, expect, it } from "vitest"
import type { ClosingControls } from "../../lib/encounters"
import { setOrgLocale } from "../../lib/locale"
import { type ClosingValues, closingControlsBody, continuingAfterSign, needsNextControlDay } from "./encounter-closing"

const values = (over: Partial<ClosingValues> = {}): ClosingValues => ({
  endTime: "",
  consentSkipReason: "",
  professionalTitle: "",
  registrationBody: "",
  registrationNumber: "",
  nextControl: "",
  nextControlDate: "",
  fulfill: {},
  ...over,
})
const controls: ClosingControls = {
  due: [],
  byAppointment: [],
  next: null,
  recallMonths: 6,
  shortcuts: { week: "2026-11-15", month: "2026-12-08", recall: "2027-05-08" },
}
const endo = { planItemId: "endo", title: "Endodoncia", n: 1, m: 2 }
const resin = { planItemId: "resina", title: "Resina", n: 1, m: 1 }

afterEach(() => setOrgLocale(undefined, undefined))

describe("«¿Cuándo vuelve?» mientras un tratamiento sigue en curso (QA del 8 nov)", () => {
  it("lo que sigue en curso es lo que no llega a sus previstas y lo de «Falta otra sesión», con la sesión a la que vuelve", () => {
    const sessions = { finishing: [resin], continuing: [endo] }
    expect(continuingAfterSign(sessions, {})).toEqual([{ planItemId: "endo", label: "Endodoncia", n: 2, m: 2 }])
    // «Falta otra sesión» en la resina de una: vuelve a la 2 de 2.
    expect(continuingAfterSign(sessions, { resina: "otra" }).map((visit) => [visit.planItemId, visit.n, visit.m])).toEqual([
      ["endo", 2, 2],
      ["resina", 2, 2],
    ])
    expect(continuingAfterSign({ finishing: [resin], continuing: [] }, { resina: "terminar" })).toEqual([])
  })

  it("si sigue en curso no manda un control, aunque se haya elegido un atajo antes de cambiar la respuesta", () => {
    const chosen = values({ nextControl: "week" })
    expect(closingControlsBody(chosen, controls, null)).toEqual({ followUpIds: [], nextControl: { dueAt: "2026-11-15" } })
    expect(closingControlsBody(chosen, controls, null, true)).toEqual({ followUpIds: [] })
    // «Otra fecha» sin día no frena la firma si no se pregunta.
    expect(needsNextControlDay(values({ nextControl: "date" }), controls, null)).toBe(true)
    expect(needsNextControlDay(values({ nextControl: "date" }), controls, null, true)).toBe(false)
    // «Indicar también un control»: se pregunta y se manda como siempre.
    expect(closingControlsBody(values({ nextControl: "week", askControl: true }), controls, null, true)).toEqual({
      followUpIds: [],
      nextControl: { dueAt: "2026-11-15" },
    })
  })
})
