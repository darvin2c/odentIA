import { helpTopicsFor } from "@odentia/services"
import { describe, expect, it } from "vitest"
import { type HelpOption, helpOptions, type HelpSelection } from "./help.js"
import { type HelpBankItem, helpMetrics, helpOutcome, meetsHelpMinimum, tallyHelp, wilsonLower } from "./help-measure.js"

/** Cómo cuenta `eval:ayuda` lo que hizo la Ayuda con cada pregunta, sin proveedor. */
const OPTIONS = helpOptions(helpTopicsFor("dental"))
const faq = (q: string): HelpOption => {
  const found = OPTIONS.find((option) => option.kind === "faq" && option.faq.q === q)
  if (!found) throw new Error(`Sin la FAQ ${q}`)
  return found
}
const TAREAS = faq("¿Por qué no veo las tareas de los demás?")
const IMPUESTOS = faq("¿Dónde configuro los impuestos?")
const ENLACE = faq("¿Qué es «Su enlace»?")
const PORTAL = faq("¿Cómo le doy acceso al portal?")

const item = (labels: Partial<HelpBankItem>): HelpBankItem => ({ q: "¿…?", expected: [], producto: "odentia", ...labels })
const sure = (...shown: HelpOption[]): HelpSelection => ({ verdict: "seguro", shown, offered: [], top: 0.62 })
const doubt = (...offered: HelpOption[]): HelpSelection => ({ verdict: "duda", shown: [], offered, top: 0.4 })
const said = (verdict: "ninguna" | "datos"): HelpSelection => ({ verdict, shown: [], offered: [], top: 0.8 })

describe("lo que cuenta como acierto", () => {
  it("un seguro con dos respuestas está bien solo si las dos corresponden", () => {
    const tareas = item({ faqs: ["¿Por qué no veo las tareas de los demás?"] })
    expect(helpOutcome(tareas, sure(TAREAS))).toBe("seguro-bien")
    // El caso de la revisión: Tareas a 0,62 e Impuestos a 0,33.
    expect(helpOutcome(tareas, sure(TAREAS, IMPUESTOS))).toBe("segunda-mal")
    expect(helpOutcome(tareas, sure(IMPUESTOS, TAREAS))).toBe("seguro-mal")
    const doble = item({ faqs: ["¿Qué es «Su enlace»?", "¿Cómo le doy acceso al portal?"] })
    expect(helpOutcome(doble, sure(ENLACE, PORTAL))).toBe("seguro-bien")
  })

  it("la segunda equivocada cuenta como seguro y mal", () => {
    const tareas = item({ faqs: ["¿Por qué no veo las tareas de los demás?"] })
    const metrics = helpMetrics(tallyHelp([{ item: tareas, selection: sure(TAREAS, IMPUESTOS), fallback: false }]))
    expect(metrics).toMatchObject({ sure: 1, sureRight: 0, sureWrong: 1, shownRight: 0 })
  })

  it("una pregunta sin respuesta en la guía que recibe una es seguro y mal; si calla o duda, no responde", () => {
    const fuera = item({ es: "ninguna" })
    const cifra = item({ es: "datos" })
    expect(helpOutcome(fuera, sure(TAREAS))).toBe("seguro-mal")
    expect(helpOutcome(fuera, doubt(TAREAS))).toBe("duda-calla")
    expect(helpOutcome(fuera, said("ninguna"))).toBe("ninguna-bien")
    expect(helpOutcome(cifra, said("datos"))).toBe("datos-bien")
    expect(helpOutcome(cifra, said("ninguna"))).toBe("ninguna-mal")
    const metrics = helpMetrics(
      tallyHelp([
        { item: fuera, selection: sure(TAREAS), fallback: false },
        { item: fuera, selection: doubt(TAREAS), fallback: false },
        { item: cifra, selection: said("ninguna"), fallback: true },
        { item: cifra, selection: said("datos"), fallback: false },
      ]),
    )
    expect(metrics.quiet).toBe(3 / 4)
    expect(metrics.dataRight).toBe(1 / 2)
  })

  it("la duda resuelve si la correcta está entre las que ofrece", () => {
    const enlace = item({ faqs: ["¿Qué es «Su enlace»?"], temas: ["pacientes"] })
    expect(helpOutcome(enlace, doubt(PORTAL, ENLACE))).toBe("duda-con")
    expect(helpOutcome(enlace, doubt(PORTAL, TAREAS))).toBe("duda-sin")
    expect(helpOutcome(enlace, said("ninguna"))).toBe("ninguna-mal")
    const tally = tallyHelp([
      { item: enlace, selection: sure(ENLACE), fallback: false },
      { item: enlace, selection: doubt(PORTAL, ENLACE), fallback: false },
      { item: enlace, selection: doubt(TAREAS), fallback: false },
    ])
    expect(helpMetrics(tally).resolved).toBe(2 / 3)
  })
})

describe("los mínimos", () => {
  it("la cota de Wilson castiga lo poco", () => {
    expect(wilsonLower(0, 0)).toBeNull()
    expect(wilsonLower(10, 10)).toBeCloseTo(0.722, 3)
    expect(wilsonLower(95, 100)).toBeCloseTo(0.888, 3)
  })

  it("cumplir pide las tres medidas y la demora", () => {
    const right = item({ faqs: ["¿Qué es «Su enlace»?"] })
    const away = item({ es: "ninguna" })
    const tally = tallyHelp([
      ...Array.from({ length: 19 }, () => ({ item: right, selection: sure(ENLACE), fallback: false })),
      { item: right, selection: doubt(ENLACE), fallback: false },
      { item: away, selection: said("ninguna"), fallback: false },
    ])
    const metrics = helpMetrics(tally)
    expect(meetsHelpMinimum(metrics, 900)).toBe(true)
    expect(meetsHelpMinimum(metrics, null)).toBe(true)
    expect(meetsHelpMinimum(metrics, 2_500)).toBe(false)
    const wrong = helpMetrics(tallyHelp([...Array.from({ length: 19 }, () => ({ item: right, selection: sure(ENLACE), fallback: false })), { item: away, selection: sure(ENLACE), fallback: false }]))
    expect(meetsHelpMinimum(wrong, 900)).toBe(false)
  })
})
