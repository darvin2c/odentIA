import { afterEach, describe, expect, it } from "vitest"
import type { ClosingControls } from "../../lib/encounters"
import { setOrgLocale } from "../../lib/locale"
import {
  type ClosingValues,
  closingControlsBody,
  continuingAfterSign,
  controlBesideAccepted,
  finishingAtSign,
  needsNextControlDay,
  resolvingOnSign,
  sessionAnswersBody,
  signFormsOf,
  signFormWords,
} from "./encounter-closing"

const values = (over: Partial<ClosingValues> = {}): ClosingValues => ({
  endTime: "",
  consentSkipReason: "",
  registrationSkipReason: "",
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

describe("la ficha se cierra con la firma (revisión final del 15 nov, propuesta 4)", () => {
  const schema = {
    sections: [
      {
        id: "s",
        title: "Examen",
        fields: [
          { id: "pieza", label: "Pieza", type: "pieza" as const, required: true },
          { id: "dolor", label: "Dolor", type: "opcion_unica" as const, options: ["Provocado", "Espontáneo"] },
        ],
      },
    ],
  }
  const forms = [
    { id: "endo", answers: { pieza: 46 }, templateSnapshot: schema },
    { id: "vacia", answers: {}, templateSnapshot: { sections: [] } },
    { id: "sin-pieza", answers: { dolor: "Provocado" }, templateSnapshot: schema },
  ]
  const open = [
    { id: "endo", title: "Evaluación de endodoncia" },
    { id: "vacia", title: "Ficha de ortodoncia" },
    { id: "sin-pieza", title: "Evaluación de endodoncia" },
  ]
  const clio = [{ kind: "ficha" as const, payload: { responseId: "endo", fieldId: "dolor", value: "Espontáneo" } }]

  it("un bloque por ficha: con respuestas viene marcada; sin respuestas, o sin una obligatoria, queda a medias", () => {
    const signForms = signFormsOf(open, forms, clio)
    expect(signForms.map(signFormWords)).toEqual(["2 respuestas, 1 de Clío", "Sin respuestas", "1 respuesta · falta «Pieza»: queda a medias"])
    expect(finishingAtSign(signForms, [])).toEqual(["endo"])
    // Desmarcarla la deja a medias; marcar la vacía la finaliza; la que no tiene su obligatoria, nunca.
    expect(finishingAtSign(signForms, ["endo", "vacia", "sin-pieza"])).toEqual(["vacia"])
  })
})

describe("«¿Terminaste?» también en lo que aún no llega a sus previstas (mesa del 17 nov)", () => {
  it("sin respuesta sigue en curso; «Sí, terminar» lo deja realizado al firmar y lo pide la firma", () => {
    const sessions = { finishing: [resin], continuing: [endo] }
    expect(sessionAnswersBody({}, sessions)).toEqual({})
    expect(sessionAnswersBody({ endo: "terminar", resina: "otra" }, sessions)).toEqual({
      addSessionPlanItemIds: ["resina"],
      completePlanItemIds: ["endo"],
    })
    // «Sigue en curso» no se manda: es lo que pasa sin decir nada. «Sí, terminar» en lo que
    // llega a sus previstas tampoco: el servidor lo termina solo.
    expect(sessionAnswersBody({ endo: "otra", resina: "terminar" }, sessions)).toEqual({})
    // Lo que el cierre no preguntó no se manda.
    expect(sessionAnswersBody({ otro: "terminar" }, sessions)).toEqual({})
  })

  it("terminada antes, la endodoncia ya no vuelve y lo que resuelve pasa a resuelto", () => {
    const sessions = { finishing: [], continuing: [endo] }
    expect(continuingAfterSign(sessions, { endo: "terminar" })).toEqual([])
    const pulpitis = {
      diagnosisIds: ["dx"],
      planItemIds: ["endo"],
      label: "Pulpitis",
      site: "pieza 46",
    }
    expect(resolvingOnSign([pulpitis], sessions, {})).toEqual([])
    expect(resolvingOnSign([pulpitis], sessions, { endo: "terminar" })).toEqual([pulpitis])
  })
})
