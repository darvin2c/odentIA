import { examSystemsText } from "@odentia/services/medical"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { readDictation } from "../dictation.js"
import { demoSegment, MEDICAL_DICTATION_PROFILE } from "./dictation.js"

/** Clío médica en modo de demostración y la lectura de su respuesta (issue 229, entrega 10). No mide a ningún modelo. */
const SERVICES = ["Consulta de medicina general", "Nebulización", "Ecografía abdominal"]
const NOW = new Date("2026-10-24T15:00:00Z")

describe("Clío médica: modo de demostración", () => {
  it("ordena una consulta dictada en sus bloques", () => {
    const { drafts } = demoSegment(
      "Viene por fiebre y dolor de garganta hace tres días. Presión 118 con 76, temperatura 38,5, pulso 96, saturación 98. Amígdalas aumentadas con placas blanquecinas, pulmones limpios. Parece una amigdalitis. Le indico una nebulización. Control en una semana. Descanso de tres días.",
      SERVICES,
      NOW,
      [],
    )
    expect(drafts.map((draft) => draft.kind)).toEqual([
      "nota",
      "signos",
      "examen",
      "examen",
      "diagnostico",
      "plan",
      "control",
      "descanso",
    ])
    expect(drafts.find((draft) => draft.kind === "signos")?.payload).toEqual({
      presionSistolica: 118,
      presionDiastolica: 76,
      temperatura: 38.5,
      frecuenciaCardiaca: 96,
      saturacionOxigeno: 98,
    })
    expect(drafts.filter((draft) => draft.kind === "examen").map((draft) => draft.payload)).toEqual(
      [
        {
          system: "bocaGarganta",
          state: "con_hallazgos",
          finding: "Amígdalas aumentadas con placas blanquecinas",
        },
        { system: "toraxPulmones", state: "sin_alteraciones" },
      ],
    )
    expect(drafts.find((draft) => draft.kind === "diagnostico")?.payload).toEqual({
      diagnosisCode: "J03.9",
      diagnosisType: "provisional",
    })
    expect(drafts.find((draft) => draft.kind === "plan")?.payload).toEqual({
      service: "Nebulización",
    })
    expect(drafts.find((draft) => draft.kind === "control")?.payload["dueAt"]).toBe(
      "2026-10-31T15:00:00.000Z",
    )
    expect(drafts.find((draft) => draft.kind === "descanso")?.payload).toEqual({ days: 3 })
  })

  it("corrige la temperatura y quita lo pendiente cuando sigue dictando", () => {
    const pending = [
      { label: "Signos vitales: PA 118/76 mmHg · T 38.5 °C" },
      { label: "Receta: ibuprofeno 400 mg" },
    ]
    const read = demoSegment(
      "No, la temperatura es 38,4. Quita el ibuprofeno.",
      SERVICES,
      NOW,
      pending,
    )
    expect(read.drafts).toEqual([])
    expect(read.corrections).toEqual([
      { index: 0, changes: { temperatura: 38.4 }, sourceText: "No, la temperatura es 38,4." },
    ])
    expect(read.removals).toEqual([{ index: 1, sourceText: "Quita el ibuprofeno." }])
  })
})

describe("Clío médica: lo que lee el modelo", () => {
  it("sin nada dental ni de odentIA, como queda (se mide antes de abrir consultorios)", async () => {
    const prompt = MEDICAL_DICTATION_PROFILE.systemPrompt({
      services: ["Consulta de medicina general", "Nebulización"],
      diagnosisList: "CIE-10 (OMS)",
      catalog: examSystemsText(),
    })
    const schema = `${JSON.stringify(z.toJSONSchema(MEDICAL_DICTATION_PROFILE.extraction), null, 2)}\n`
    for (const text of [prompt, schema, MEDICAL_DICTATION_PROFILE.toolDescription]) {
      expect(text).not.toMatch(
        /\b(dental|dientes?|odont\w*|tomograf\w*|ortodon\w*|frenillos?|piezas?|caras?|FDI|toothNumber|surfaces|alternatives|teeth|exodoncia|endodoncia)\b/i,
      )
      expect(text).not.toContain("odentIA")
    }
    await expect(prompt).toMatchFileSnapshot("../__golden__/latidia/clio.txt")
    await expect(schema).toMatchFileSnapshot("../__golden__/latidia/clio-esquema.json")
  })
})

describe("Clío médica: lectura de la respuesta", () => {
  it("los signos y el descanso son una sola entrada; las listas, una por elemento", () => {
    const transcript = "Presión 120 con 80. Pulmones limpios. Descanso de dos días."
    const read = readDictation(
      {
        signos: { presionSistolica: 120, presionDiastolica: 80, dicho: "Presión 120 con 80." },
        examen: [
          { system: "toraxPulmones", state: "sin_alteraciones", dicho: "Pulmones limpios." },
        ],
        descanso: { days: 2, dicho: "Descanso de dos días." },
      },
      transcript,
      0,
      MEDICAL_DICTATION_PROFILE.parts,
    )
    expect(read?.drafts).toEqual([
      {
        kind: "signos",
        payload: { presionSistolica: 120, presionDiastolica: 80 },
        sourceText: "Presión 120 con 80.",
      },
      {
        kind: "examen",
        payload: { system: "toraxPulmones", state: "sin_alteraciones" },
        sourceText: "Pulmones limpios.",
      },
      { kind: "descanso", payload: { days: 2 }, sourceText: "Descanso de dos días." },
    ])
    expect(read?.omitted).toBe(0)
  })
})
