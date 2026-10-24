import { describe, expect, it } from "vitest"
import {
  examCounts,
  examLines,
  examSummary,
  markRestNormal,
  parseSystemsExam,
  readSystemsExam,
} from "./examination.js"

describe("examen por sistemas (issue 229, decisión 5)", () => {
  it("guarda lo marcado y recorta el hallazgo; sin nada marcado, nada", () => {
    expect(
      parseSystemsExam({
        sistemas: {
          piel: { estado: "sin_alteraciones" },
          cabezaCuello: { estado: "con_hallazgos", hallazgo: "  Adenopatías submandibulares  " },
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        sistemas: {
          piel: { estado: "sin_alteraciones" },
          cabezaCuello: { estado: "con_hallazgos", hallazgo: "Adenopatías submandibulares" },
        },
      },
    })
    expect(parseSystemsExam({ sistemas: {} })).toEqual({ ok: true, value: null })
    expect(parseSystemsExam(null)).toEqual({ ok: true, value: null })
  })

  it("sin alteraciones no lleva texto; un hallazgo puede escribirse después", () => {
    expect(
      parseSystemsExam({ sistemas: { piel: { estado: "sin_alteraciones", hallazgo: "algo" } } }),
    ).toEqual({ ok: true, value: { sistemas: { piel: { estado: "sin_alteraciones" } } } })
    expect(parseSystemsExam({ sistemas: { abdomen: { estado: "con_hallazgos" } } })).toEqual({
      ok: true,
      value: { sistemas: { abdomen: { estado: "con_hallazgos" } } },
    })
  })

  it("rechaza lo que no es del examen médico, como el examen de la boca", () => {
    expect(parseSystemsExam({ extraoral: { atm: "normal" } })).toMatchObject({ ok: false })
    expect(
      parseSystemsExam({ sistemas: { encias: { estado: "sin_alteraciones" } } }),
    ).toMatchObject({
      ok: false,
    })
    expect(parseSystemsExam({ sistemas: { piel: { estado: "normal" } } })).toMatchObject({
      ok: false,
    })
    expect(
      parseSystemsExam({
        sistemas: { piel: { estado: "con_hallazgos", hallazgo: "x".repeat(1001) } },
      }),
    ).toMatchObject({ ok: false })
    // Lo guardado que no se entiende se lee como no examinado, sin fallar.
    expect(readSystemsExam({ extraoral: {} })).toBeNull()
  })

  it("lo no marcado queda «No examinado»; el botón marca solo el resto", () => {
    const exam = {
      sistemas: {
        estadoGeneral: { estado: "sin_alteraciones" as const },
        bocaGarganta: { estado: "con_hallazgos" as const, hallazgo: "Amígdalas con placas" },
      },
    }
    expect(examCounts(exam)).toEqual({ examined: 2, findings: 1, notExamined: 8 })
    expect(examSummary(exam)).toBe("1 sistema con hallazgos")
    expect(examLines(exam)).toEqual([
      "Boca y garganta: Amígdalas con placas",
      "Sin alteraciones: Estado general",
      "No examinado: Piel, Cabeza y cuello, Tórax y pulmones, Corazón, Abdomen, Genital y urinario, Extremidades, Neurológico",
    ])
    const rest = markRestNormal(exam)
    expect(rest.sistemas.bocaGarganta).toEqual(exam.sistemas.bocaGarganta)
    expect(examCounts(rest)).toEqual({ examined: 10, findings: 1, notExamined: 0 })
    expect(examSummary(markRestNormal(null))).toBe("10 sistemas sin alteraciones")
    expect(examLines(null)).toEqual([])
  })
})
