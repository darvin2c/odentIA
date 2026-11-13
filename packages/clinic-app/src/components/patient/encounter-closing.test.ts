import { afterEach, describe, expect, it } from "vitest"
import type { ClosingControls } from "../../lib/encounters"
import { setOrgLocale } from "../../lib/locale"
import {
  type ClosingValues,
  closingControlsBody,
  continuingAfterSign,
  controlBesideAccepted,
  needsNextControlDay,
  openFormsWords,
} from "./encounter-closing"

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

describe("el control que se pide junto a la corona ya ofrecida (QA del 9 nov)", () => {
  const crown = { planItemId: "corona", title: "Corona metal-cerámica", n: 0, m: 2 }
  const lastEndo = { planItemId: "endo", title: "Endodoncia", n: 2, m: 2 }

  it("terminada la endodoncia, vuelve para la corona y el control lleva el nombre de lo que termina", () => {
    const visits = continuingAfterSign(
      { finishing: [lastEndo], continuing: [], accepted: [crown] },
      {},
    )
    expect(visits).toEqual([
      {
        planItemId: "corona",
        label: "Corona metal-cerámica",
        n: 1,
        m: 2,
        accepted: true,
        after: "Endodoncia",
      },
    ])
    // Sin plazo no dice «No indicaste cuándo vuelve»: la corona ya está.
    expect(controlBesideAccepted(visits, "")).toEqual({
      title: "Control de endodoncia",
      line: "Sin plazo, el control no queda anotado: solo «Corona metal-cerámica».",
    })
    const withDay = controlBesideAccepted(visits, "2026-12-09")
    expect(withDay?.title).toBe("Control de endodoncia")
    expect(withDay?.line).toMatch(
      /^Control hacia el 9 dic(?: 2026)? · recepción lo verá para reservarlo$/,
    )
  })

  it("sin nada ofrecido queda el texto de siempre; con la sesión que sigue, tampoco dice «No indicaste cuándo vuelve»", () => {
    expect(controlBesideAccepted([], "")).toBeNull()
    const going = continuingAfterSign({ finishing: [], continuing: [endo] }, {})
    expect(controlBesideAccepted(going, "")?.line).toMatch(/^Sin plazo, el control no queda anotado: solo «.+».$/)
  })
})

describe("un formulario a medias al cerrar", () => {
  it("lo avisa con su nombre y dice que se puede firmar igual y dónde se termina", () => {
    expect(openFormsWords([])).toBeNull()
    const one = openFormsWords([{ title: "Evaluación de endodoncia" }])
    expect(one?.title).toBe("Queda un formulario a medias")
    expect(one?.detail).toBe(
      "«Evaluación de endodoncia». Puedes firmar igual: se termina después, desde Documentos de la ficha, y lleva su propia fecha.",
    )
    const two = openFormsWords([{ title: "Evaluación de endodoncia" }, { title: "Ficha periodontal" }])
    expect(two?.title).toBe("Quedan 2 formularios a medias")
    expect(two?.detail).toContain("«Evaluación de endodoncia» y «Ficha periodontal». Puedes firmar igual")
  })
})
