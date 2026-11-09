import { describe, expect, it } from "vitest"
import {
  eyeExamLines,
  eyeExamSummary,
  normalizeAcuity,
  parseEyeExam,
  referralSigns,
  refractionText,
} from "./eye-exam.js"

describe("la agudeza visual, como se escribe en una óptica", () => {
  it("acepta Snellen, decimal y lo que se anota cuando no lee la cartilla", () => {
    expect(normalizeAcuity("20/20")).toBe("20/20")
    expect(normalizeAcuity(" 20 / 40 ")).toBe("20/40")
    expect(normalizeAcuity("6/6")).toBe("6/6")
    expect(normalizeAcuity("0.8")).toBe("0,8")
    expect(normalizeAcuity("1,0")).toBe("1,0")
    expect(normalizeAcuity("cd")).toBe("CD")
    expect(normalizeAcuity("NPL")).toBe("NPL")
  })

  it("rechaza lo que no es una notación de agudeza", () => {
    for (const text of ["20/0", "20/2000", "buena", "3", "2,5", "20-20"]) expect(normalizeAcuity(text), text).toBeNull()
  })
})

describe("el examen de la vista", () => {
  it("guarda lo anotado, limpio, y sin nada anotado no guarda nada", () => {
    expect(parseEyeExam(null)).toEqual({ ok: true, value: null })
    expect(parseEyeExam({ agudeza: { od: {}, oi: { scLejos: "" } }, refraccion: {} })).toEqual({ ok: true, value: null })
    const parsed = parseEyeExam({
      antecedentes: { usaLentes: "anteojos", nota: "  Diabetes en la familia  " },
      agudeza: { od: { scLejos: "20/80", ccLejos: "20/20" }, oi: { scLejos: "20/60", ccLejos: "20/20" } },
      refraccion: {
        od: { esfera: -1.25, cilindro: -0.5, eje: 180, adicion: 2 },
        oi: { esfera: -1, cilindro: 0, eje: null },
      },
      dp: { od: 31.5, oi: 32 },
      salud: { externo: { estado: "sin_alteraciones", nota: "se descarta" }, fondo: { estado: "no_realizado", nota: "Sin dilatar" }, presion: { od: 15, oi: 16 } },
    })
    expect(parsed).toEqual({
      ok: true,
      value: {
        antecedentes: { usaLentes: "anteojos", nota: "Diabetes en la familia" },
        agudeza: { od: { scLejos: "20/80", ccLejos: "20/20" }, oi: { scLejos: "20/60", ccLejos: "20/20" } },
        refraccion: { od: { esfera: -1.25, cilindro: -0.5, eje: 180, adicion: 2 }, oi: { esfera: -1 } },
        dp: { od: 31.5, oi: 32 },
        salud: { externo: { estado: "sin_alteraciones" }, fondo: { estado: "no_realizado", nota: "Sin dilatar" }, presion: { od: 15, oi: 16 } },
      },
    })
  })

  it("guarda quién acompaña a un menor, con su parentesco", () => {
    const parsed = parseEyeExam({ acompanante: { nombre: " Rosa Quispe ", parentesco: "madre" } })
    expect(parsed).toEqual({ ok: true, value: { acompanante: { nombre: "Rosa Quispe", parentesco: "madre" } } })
    if (parsed.ok) expect(eyeExamLines(parsed.value)).toEqual(["Acompaña: Rosa Quispe (madre)"])
    expect(parseEyeExam({ acompanante: { parentesco: "madre" } })).toMatchObject({ ok: false, path: "acompanante.nombre" })
  })

  it("dice qué dato está mal, con su ruta", () => {
    expect(parseEyeExam({ refraccion: { od: { esfera: -1.3 } } })).toMatchObject({ ok: false, path: "refraccion.od.esfera" })
    expect(parseEyeExam({ refraccion: { oi: { esfera: -1, cilindro: -0.75 } } })).toMatchObject({
      ok: false,
      path: "refraccion.oi.eje",
      error: "Eje OI: con cilindro hace falta el eje",
    })
    expect(parseEyeExam({ refraccion: { od: { esfera: 1, eje: 90 } } })).toMatchObject({ ok: false, path: "refraccion.od.eje" })
    expect(parseEyeExam({ refraccion: { od: { prisma: 2 } } })).toMatchObject({ ok: false, path: "refraccion.od.base" })
    expect(parseEyeExam({ agudeza: { od: { ccLejos: "muy bien" } } })).toMatchObject({ ok: false, path: "agudeza.od.ccLejos" })
    expect(parseEyeExam({ dp: { oi: 50 } })).toMatchObject({ ok: false, path: "dp.oi" })
    expect(parseEyeExam({ salud: { presion: { od: 15.5 } } })).toMatchObject({ ok: false, path: "salud.presion.od" })
    expect(parseEyeExam({ sistemas: {} })).toMatchObject({ ok: false })
  })
})

describe("el examen en la historia", () => {
  it("cada parte en su línea, con la notación de una receta", () => {
    const exam = parseEyeExam({
      agudeza: { od: { scLejos: "20/80", ccLejos: "20/20" } },
      refraccion: { od: { esfera: -1.25, cilindro: -0.5, eje: 180, adicion: 2 }, oi: { cilindro: -0.75, eje: 90, prisma: 1, base: "adentro" } },
      dp: { od: 31.5, oi: 32 },
      salud: { fondo: { estado: "con_hallazgos", nota: "Excavación amplia" }, presion: { od: 15 } },
    })
    if (!exam.ok) throw new Error(exam.error)
    expect(eyeExamLines(exam.value)).toEqual([
      "Agudeza visual OD: sin corrección, de lejos 20/80, con corrección, de lejos 20/20",
      "Refracción OD: −1,25 −0,50 × 180° · Add +2,00",
      "Refracción OI: Neutro −0,75 × 90° · 1 Δ base adentro (nasal)",
      "Distancia pupilar: OD 31,5 mm, OI 32 mm",
      "Fondo de ojo: con hallazgos. Excavación amplia",
      "Presión del ojo: OD 15 mmHg",
    ])
    expect(eyeExamSummary(exam.value)).toBe("Refracción de los dos ojos")
    expect(refractionText({ esfera: 0.5 })).toBe("+0,50")
  })
})

describe("lo que conviene que vea un oftalmólogo", () => {
  it("se informa la presión alta, el fondo o las pupilas con hallazgos y la vista que no mejora con lentes", () => {
    const exam = parseEyeExam({
      agudeza: { od: { ccLejos: "20/70" }, oi: { ccLejos: "CD" } },
      salud: { fondo: { estado: "con_hallazgos" }, pupilas: { estado: "con_hallazgos" }, presion: { od: 24, oi: 18 } },
    })
    if (!exam.ok) throw new Error(exam.error)
    expect(referralSigns(exam.value)).toEqual([
      "Presión del ojo alta en OD (24 mmHg)",
      "Fondo de ojo con hallazgos",
      "Pupilas con hallazgos",
      "OD no llega a 20/40 con corrección (20/70)",
      "OI solo cuenta dedos",
    ])
  })

  it("un examen sin nada que derivar no informa nada", () => {
    const exam = parseEyeExam({
      agudeza: { od: { ccLejos: "20/20" }, oi: { ccLejos: "20/25" } },
      salud: { fondo: { estado: "sin_alteraciones" }, presion: { od: 14, oi: 21 } },
    })
    if (!exam.ok) throw new Error(exam.error)
    expect(referralSigns(exam.value)).toEqual([])
  })
})
