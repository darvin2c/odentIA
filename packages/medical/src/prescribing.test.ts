import { allergyWarnings, prescribingAlerts } from "@odentia/clinical"
import { describe, expect, it } from "vitest"
import { readMedicalHistory } from "./history.js"
import { GENERAL_MEDICATIONS, MEDICAL_MEDICATION_CATALOG } from "./medications.js"
import { checkPrescription } from "./prescribing.js"

const TODAY = "2026-10-24"
const context = (answers: Record<string, unknown>, birthDate = "1990-05-02") => ({
  history: readMedicalHistory(answers, TODAY),
  birthDate,
  today: TODAY,
  medications: GENERAL_MEDICATIONS,
})

describe("la receta de latidIA (issue 229, decisión 12)", () => {
  it("los controlados no salen en la receta común", () => {
    const check = checkPrescription(
      context({}),
      [{ genericName: "Clonazepam" }, { genericName: "tramadol" }],
      null,
    )
    expect(check.errors).toEqual([
      "Clonazepam es una benzodiazepina, un medicamento controlado: no va en la receta común, usa la receta oficial.",
      "Tramadol es un opioide, un medicamento controlado: no va en la receta común, usa la receta oficial.",
    ])
    expect(checkPrescription(context({}), [{ genericName: "paracetamol" }], null)).toEqual({
      errors: [],
      warnings: [],
      weightRequired: false,
    })
  })

  // El embarazo, la lactancia y lo contraindicado se mudaron a toda receta (`prescribingAlerts` de
  // @odentia/clinical, QA final de formularios): sus pruebas viven en `prescribing-alerts.test.ts`,
  // con los medicamentos de latidIA.
  it("con embarazo, la regla de latidIA no repite el aviso: lo da toda receta", () => {
    const pregnant = context({
      embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-10-10", semanas: 10 } },
    })
    expect(checkPrescription(pregnant, [{ genericName: "enalapril" }], null)).toEqual({ errors: [], warnings: [], weightRequired: false })
    expect(
      prescribingAlerts({ interview: pregnant.history, today: TODAY, taking: [] }, [{ genericName: "enalapril" }], GENERAL_MEDICATIONS).warnings,
    ).toEqual(["Enalapril: está embarazada (12 semanas) y las fichas técnicas desaconsejan los IECA en el embarazo (ATC C09AA02)."])
  })

  // Sin su peso avisa y deja emitir: lo decide quien receta (26 nov).
  it("a un menor de 12 años se le pide su peso: sin él avisa y no frena", () => {
    const child = context({}, "2021-02-10")
    expect(checkPrescription(child, [{ genericName: "amoxicilina" }], null)).toEqual({
      weightRequired: true,
      errors: [],
      warnings: ["Aviso: tiene 5 años y la receta va sin su peso. Con su peso se revisa la dosis."],
    })
    expect(checkPrescription(child, [{ genericName: "amoxicilina" }], 18.5)).toMatchObject({ errors: [], warnings: [] })
    expect(checkPrescription(context({}, "2014-10-24"), [], null).weightRequired).toBe(false)
  })

  it("las alergias reconocen los medicamentos y los grupos de medicina general", () => {
    // Alérgica a las quinolonas (grupo J01MA): el ciprofloxacino avisa.
    expect(
      allergyWarnings(
        "ciprofloxacino",
        [{ substance: "Fluoroquinolonas", substanceSystem: "atc", substanceCode: "J01MA" }],
        MEDICAL_MEDICATION_CATALOG,
      ),
    ).toEqual([
      "Ciprofloxacino: alergia a fluoroquinolonas. Es del mismo grupo, fluoroquinolonas (ATC J01MA02).",
    ])
    // Sin grupo de alergia, solo avisa la misma sustancia.
    expect(
      allergyWarnings(
        "losartán",
        [{ substance: "Enalapril", substanceSystem: "atc", substanceCode: "C09AA02" }],
        MEDICAL_MEDICATION_CATALOG,
      ),
    ).toEqual([])
    expect(
      allergyWarnings(
        "enalapril",
        [{ substance: "Enalapril", substanceSystem: "atc", substanceCode: "C09AA02" }],
        MEDICAL_MEDICATION_CATALOG,
      ),
    ).toEqual(["Enalapril: alergia a enalapril, el mismo medicamento (ATC C09AA02)."])
  })
})
