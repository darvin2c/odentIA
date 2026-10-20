/**
 * Entender una pregunta a Argos sobre Reportes (ADR 0070): lo que elige el
 * modelo se combina por área y cifra; el periodo, la sede y el canal se leen
 * con reglas. Sin base de datos ni proveedor: un decisor guionado.
 */
import { describe, expect, it } from "vitest"
import type { AdminAnswer, AdminDecider } from "./admin-request.js"
import { FIGURE_AREAS, groupsOf, REPORT_FIGURES, visibleFigures } from "./report-figures.js"
import {
  interpretReportQuestion,
  keywordReportDecider,
  readReportBranch,
  readReportChannel,
  readReportPeriod,
  reportQuestions,
} from "./report-questions.js"

const LIMA = "America/Lima"
/** Lunes 19 de octubre de 2026, 10:00 en Lima. */
const NOW = new Date("2026-10-19T15:00:00Z")
const CONTEXT = { timezone: LIMA, now: NOW, branches: [{ id: "b1", name: "Sede Centro" }, { id: "b2", name: "Sede Norte" }], billing: true }

/** Un decisor que responde lo que se le dice, con su distribución. */
function scripted(answers: Record<string, Record<string, number>>): AdminDecider {
  return {
    async decide(_state, questions) {
      return {
        answers: questions.map((question): AdminAnswer => {
          const probabilities = answers[question.id] ?? { ninguna: 1 }
          const [choice] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] ?? ["ninguna"]
          return { id: question.id, kind: "choice", choice, confidence: null, probabilities }
        }),
        model: "guion",
        usage: { inputTokens: 1800, outputTokens: 0 },
      }
    },
  }
}

describe("las preguntas al modelo", () => {
  it("cada cifra va una sola vez, en la lista de su área, y ninguna lista es larga", () => {
    const questions = reportQuestions()
    for (const area of FIGURE_AREAS) {
      const question = questions.find((item) => item.id === `cifra_${area}`)
      expect(question?.kind).toBe("choice")
      const options = question?.kind === "choice" ? question.options.map((option) => option.value) : []
      expect(options.at(-1)).toBe("ninguna")
      expect(options.length).toBeLessThanOrEqual(11)
    }
    const all = questions.flatMap((item) => (item.kind === "choice" && item.id.startsWith("cifra_") ? item.options.map((option) => option.value) : [])).filter((value) => value !== "ninguna")
    expect(new Set(all).size).toBe(all.length)
    expect(all.sort()).toEqual(REPORT_FIGURES.map((figure) => figure.key).sort())
  })

  it("lo pagado a odentIA no se le ofrece a quien no ve Facturación", () => {
    const keys = reportQuestions(visibleFigures(false)).flatMap((item) => (item.kind === "choice" ? item.options.map((option) => option.value) : []))
    expect(keys).not.toContain("agente_pagado")
  })

  it("una cifra de toda la clínica no se agrupa por sede", () => {
    for (const figure of REPORT_FIGURES.filter((item) => item.wholeClinic)) expect(groupsOf(figure)).not.toContain("sede")
  })
})

describe("lo que se lee con reglas", () => {
  it("el periodo: un mes sin año que aún no llega es del año pasado", () => {
    expect(readReportPeriod("¿y en agosto?", LIMA, NOW)).toBe("2026-08")
    expect(readReportPeriod("lo de diciembre", LIMA, NOW)).toBe("2025-12")
    expect(readReportPeriod("en setiembre del año pasado", LIMA, NOW)).toBe("2025-09")
    expect(readReportPeriod("este mes", LIMA, NOW)).toBe("este_mes")
    expect(readReportPeriod("en octubre", LIMA, NOW)).toBe("este_mes")
    expect(readReportPeriod("el mes pasado", LIMA, NOW)).toBe("mes_pasado")
    expect(readReportPeriod("los últimos 3 meses", LIMA, NOW)).toBe("ultimos_3_meses")
    expect(readReportPeriod("en lo que va del año", LIMA, NOW)).toBe("este_ano")
    expect(readReportPeriod("el año pasado", LIMA, NOW)).toBe("2025-01-01..2025-12-31")
    expect(readReportPeriod("la semana pasada", LIMA, NOW)).toBe("2026-10-12..2026-10-18")
    expect(readReportPeriod("la semana pasada", LIMA, new Date("2026-10-22T15:00:00Z"))).toBe("2026-10-12..2026-10-18")
    expect(readReportPeriod("los últimos 7 días", LIMA, NOW)).toBe("2026-10-12..2026-10-18")
    expect(readReportPeriod("¿cuánto cobramos en 2025?", LIMA, NOW)).toBe("2025-01-01..2025-12-31")
    expect(readReportPeriod("en 2026", LIMA, NOW)).toBe("este_ano")
    expect(readReportPeriod("¿cuántas citas hay?", LIMA, NOW)).toBeNull()
  })

  it("la sede por su nombre, y solo si nombra una", () => {
    expect(readReportBranch("cobrado en la sede norte", CONTEXT.branches)?.id).toBe("b2")
    expect(readReportBranch("lo de Centro", CONTEXT.branches)?.id).toBe("b1")
    expect(readReportBranch("compara centro y norte", CONTEXT.branches)).toBeNull()
    expect(readReportBranch("¿cuánto cobramos?", CONTEXT.branches)).toBeNull()
  })

  it("el canal por su nombre", () => {
    expect(readReportChannel("¿Cuántos llegaron por Instagram?")).toBe("instagram")
    expect(readReportChannel("por whatsapp")).toBe("whatsapp")
    expect(readReportChannel("por instagram y whatsapp")).toBeNull()
  })
})

describe("interpretar", () => {
  it("con una cifra clara responde, y la agrupación que dice el texto vale más que la del modelo", async () => {
    const { interpretation } = await interpretReportQuestion(
      "¿Qué profesional tiene más inasistencias?",
      scripted({ tema: { cifra: 0.97, clinico: 0.01, accion: 0.01, otro: 0.01 }, area: { agenda: 0.9, pacientes: 0.1 }, cifra_agenda: { no_vinieron: 0.92, canceladas: 0.05, ninguna: 0.03 }, agrupar: { total: 0.6, profesional: 0.4 } }),
      CONTEXT,
    )
    expect(interpretation).toMatchObject({ kind: "cifra", figure: "no_vinieron", group: "profesional", period: null, branch: null })
  })

  it("con el canal en el texto destaca ese canal", async () => {
    const { interpretation } = await interpretReportQuestion(
      "¿Cuántos pacientes nuevos llegaron por Instagram en agosto?",
      scripted({ tema: { cifra: 1 }, area: { pacientes: 1 }, cifra_pacientes: { nos_buscaron: 0.8, pacientes_nuevos: 0.15, ninguna: 0.05 }, agrupar: { total: 1 } }),
      CONTEXT,
    )
    expect(interpretation).toMatchObject({ kind: "cifra", figure: "nos_buscaron", group: "canal", focus: "instagram", period: "2026-08" })
  })

  it("una cifra que no se agrupa así pasa a la que sí: los pacientes nuevos por Instagram son los que nos buscaron por ahí", async () => {
    // Así responde el modelo de chat, sin distribución (medido con ChatGPT 6).
    const { interpretation } = await interpretReportQuestion(
      "¿Cuántos pacientes nuevos llegaron por Instagram?",
      scripted({ tema: { cifra: 1 }, area: { pacientes: 1 }, cifra_pacientes: { pacientes_nuevos: 1 }, agrupar: { total: 1 } }),
      CONTEXT,
    )
    expect(interpretation).toMatchObject({ kind: "cifra", figure: "nos_buscaron", group: "canal", focus: "instagram" })
  })

  it("lo que pide un filtro que no existe (la edad) dice «todavía no sé», aunque la cifra exista", async () => {
    const decider = scripted({ tema: { cifra: 1 }, area: { dinero: 1 }, cifra_dinero: { cobrado: 0.9, ninguna: 0.1 }, agrupar: { tratamiento: 1 } })
    const withFilter: AdminDecider = {
      async decide(state, questions) {
        const result = await decider.decide(state, questions)
        return { ...result, answers: result.answers.map((answer) => (answer.id === "fuera" ? { id: "fuera", kind: "yesno", probability: 0.93 } : answer)) }
      },
    }
    const { interpretation } = await interpretReportQuestion("¿Cuánto gané en blanqueamientos con mayores de 40?", withFilter, CONTEXT)
    expect(interpretation).toMatchObject({ kind: "no_sabe", closest: [{ figure: "cobrado" }] })
  })

  it("si duda entre dos, pregunta con las más probables", async () => {
    const { interpretation } = await interpretReportQuestion(
      "¿Cuánto me deben?",
      scripted({ tema: { cifra: 1 }, area: { dinero: 1 }, cifra_dinero: { te_deben: 0.45, deuda_vencida: 0.4, ninguna: 0.15 }, agrupar: { total: 1 } }),
      CONTEXT,
    )
    expect(interpretation.kind).toBe("pregunta")
    if (interpretation.kind === "pregunta") expect(interpretation.candidates.map((item) => item.figure)).toEqual(["te_deben", "deuda_vencida"])
  })

  it("lo que no está en la lista: «todavía no sé», con lo más cercano", async () => {
    const { interpretation } = await interpretReportQuestion(
      "¿Cuánto gané en blanqueamientos con mayores de 40?",
      scripted({ tema: { cifra: 1 }, area: { dinero: 1 }, cifra_dinero: { ninguna: 0.7, cobrado: 0.25, gastos: 0.05 }, agrupar: { tratamiento: 1 } }),
      CONTEXT,
    )
    expect(interpretation).toMatchObject({ kind: "no_sabe", closest: [{ figure: "cobrado" }, { figure: "gastos" }] })
  })

  it("lo clínico no le toca, y se reconoce sin llamar al modelo", async () => {
    let called = false
    const decider: AdminDecider = { async decide() { called = true; throw new Error("no debía llamarse") } }
    const result = await interpretReportQuestion("¿Cuántos pacientes tienen diabetes?", decider, CONTEXT)
    expect(result).toEqual({ interpretation: { kind: "clinico" }, model: null, usage: null })
    expect(called).toBe(false)
  })

  it("el doble por palabras recorre la pantalla sin proveedor", async () => {
    const decider = keywordReportDecider()
    expect((await interpretReportQuestion("¿Cuántos faltaron a su cita?", decider, CONTEXT)).interpretation).toMatchObject({ kind: "cifra", figure: "no_vinieron" })
    expect((await interpretReportQuestion("Compara lo cobrado entre las sedes", decider, CONTEXT)).interpretation).toMatchObject({ kind: "cifra", figure: "cobrado", group: "sede" })
    expect((await interpretReportQuestion("Escríbeles a los que no vinieron", decider, CONTEXT)).interpretation.kind).toBe("accion")
    expect((await interpretReportQuestion("hola", decider, CONTEXT)).interpretation.kind).toBe("otro")
  })
})
