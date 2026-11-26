import { describe, expect, it } from "vitest"
import {
  mergeDictatedSystem,
  examCounts,
  examLines,
  examSummary,
  markRestNormal,
  parseSystemsExam,
  readSystemsExam,
  withExamState,
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

  it("lo normal guarda lo que se dijo («Lasègue negativo»); un hallazgo puede escribirse después", () => {
    expect(
      parseSystemsExam({ sistemas: { neurologico: { estado: "sin_alteraciones", hallazgo: " Lasègue negativo " } } }),
    ).toEqual({ ok: true, value: { sistemas: { neurologico: { estado: "sin_alteraciones", hallazgo: "Lasègue negativo" } } } })
    expect(parseSystemsExam({ sistemas: { piel: { estado: "sin_alteraciones", hallazgo: "  " } } })).toEqual({
      ok: true,
      value: { sistemas: { piel: { estado: "sin_alteraciones" } } },
    })
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

  it("lo normal con sus palabras sale en la historia con ellas", () => {
    const exam = {
      sistemas: {
        piel: { estado: "sin_alteraciones" as const },
        neurologico: { estado: "sin_alteraciones" as const, hallazgo: "Lasègue negativo" },
      },
    }
    expect(examLines(exam)).toEqual([
      "Neurológico, sin alteraciones: Lasègue negativo",
      "Sin alteraciones: Piel",
      "No examinado: Estado general, Cabeza y cuello, Boca y garganta, Tórax y pulmones, Corazón, Abdomen, Genital y urinario, Extremidades",
    ])
  })
})

describe("el estado cambiado a mano (revisión de código del 26 nov)", () => {
  it("de «con hallazgos» a «sin alteraciones» se borra el hallazgo: no queda «sin alteraciones: edema»", () => {
    expect(withExamState({ estado: "con_hallazgos", hallazgo: "edema en MMII" }, "sin_alteraciones")).toEqual({ estado: "sin_alteraciones" })
  })
  it("lo normal dicho con sus palabras se conserva, y al pasar a «con hallazgos» también", () => {
    expect(withExamState({ estado: "sin_alteraciones", hallazgo: "Lasègue negativo" }, "sin_alteraciones")).toEqual({
      estado: "sin_alteraciones",
      hallazgo: "Lasègue negativo",
    })
    expect(withExamState({ estado: "sin_alteraciones", hallazgo: "Lasègue negativo" }, "con_hallazgos")).toEqual({
      estado: "con_hallazgos",
      hallazgo: "Lasègue negativo",
    })
    expect(withExamState({ estado: "con_hallazgos", hallazgo: "edema" }, "con_hallazgos")).toEqual({ estado: "con_hallazgos", hallazgo: "edema" })
    expect(withExamState(undefined, "sin_alteraciones")).toEqual({ estado: "sin_alteraciones" })
  })
})

describe("lo dictado de un sistema se suma a lo escrito (ADR 0012)", () => {
  const written = { sistemas: { abdomen: { estado: "con_hallazgos" as const, hallazgo: "Dolor en FID" } } }

  it("un hallazgo dictado se agrega al que ya estaba escrito", () => {
    expect(mergeDictatedSystem(written, "abdomen", { estado: "con_hallazgos", hallazgo: "Blando, doloroso en epigastrio" }).sistemas.abdomen).toEqual({
      estado: "con_hallazgos",
      hallazgo: "Dolor en FID; Blando, doloroso en epigastrio",
    })
  })

  it("«sin alteraciones» dictado no borra un hallazgo escrito, y lo repetido no se duplica", () => {
    expect(mergeDictatedSystem(written, "abdomen", { estado: "sin_alteraciones" }).sistemas.abdomen).toEqual(written.sistemas.abdomen)
    expect(mergeDictatedSystem(written, "abdomen", { estado: "con_hallazgos", hallazgo: "dolor en fid" }).sistemas.abdomen).toEqual(written.sistemas.abdomen)
  })

  it("lo que solo se parece no se descarta: «edema» no es «Sin edema»", () => {
    const negated = { sistemas: { extremidades: { estado: "con_hallazgos" as const, hallazgo: "Sin edema" } } }
    expect(mergeDictatedSystem(negated, "extremidades", { estado: "con_hallazgos", hallazgo: "Edema" }).sistemas.extremidades).toEqual({
      estado: "con_hallazgos",
      hallazgo: "Sin edema; Edema",
    })
  })

  it("«con hallazgos» marcado y aún sin texto no pasa a «sin alteraciones» por lo dictado", () => {
    const marked = { sistemas: { abdomen: { estado: "con_hallazgos" as const } } }
    expect(mergeDictatedSystem(marked, "abdomen", { estado: "sin_alteraciones" }).sistemas.abdomen).toEqual({ estado: "con_hallazgos" })
  })

  it("lo normal dictado entra con sus palabras, y lo normal dicho otra vez se suma sin repetirse", () => {
    const said = mergeDictatedSystem(null, "neurologico", { estado: "sin_alteraciones", hallazgo: "Lasègue negativo" })
    expect(said.sistemas.neurologico).toEqual({ estado: "sin_alteraciones", hallazgo: "Lasègue negativo" })
    expect(mergeDictatedSystem(said, "neurologico", { estado: "sin_alteraciones", hallazgo: "lasègue negativo" }).sistemas.neurologico).toEqual(said.sistemas.neurologico)
    expect(mergeDictatedSystem(said, "neurologico", { estado: "sin_alteraciones", hallazgo: "Fuerza conservada" }).sistemas.neurologico).toEqual({
      estado: "sin_alteraciones",
      hallazgo: "Lasègue negativo; Fuerza conservada",
    })
    // Un hallazgo dictado después lo cambia a «con hallazgos», sin perder lo que ya decía.
    expect(mergeDictatedSystem(said, "neurologico", { estado: "con_hallazgos", hallazgo: "Hipoestesia en L5 derecha" }).sistemas.neurologico).toEqual({
      estado: "con_hallazgos",
      hallazgo: "Lasègue negativo; Hipoestesia en L5 derecha",
    })
  })

  it("en un sistema vacío entra lo dictado, y los demás sistemas quedan como estaban", () => {
    const merged = mergeDictatedSystem(written, "piel", { estado: "sin_alteraciones" })
    expect(merged.sistemas).toEqual({ ...written.sistemas, piel: { estado: "sin_alteraciones" } })
  })
})
