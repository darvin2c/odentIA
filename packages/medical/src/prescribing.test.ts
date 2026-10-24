import { allergyWarnings } from "@odentia/clinical"
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
      reminders: [],
      weightRequired: false,
    })
  })

  it("con embarazo lo recuerda y lo contraindicado va con motivo, como una alergia", () => {
    const pregnant = context({
      embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-10-10", semanas: 10 } },
    })
    const check = checkPrescription(
      pregnant,
      [{ genericName: "enalapril" }, { genericName: "paracetamol" }],
      null,
    )
    expect(check.reminders).toEqual([
      "Está embarazada, 12 semanas (registrado el 10/10/2026): revisa que cada medicamento sea seguro en el embarazo.",
    ])
    expect(check.warnings).toEqual([
      "Enalapril: está embarazada (12 semanas) y los IECA están contraindicados en el embarazo (ATC C09AA02).",
    ])
    // Un embarazo que por sus semanas ya terminó no se da por vigente: se pide actualizarlo.
    const old = context({
      embarazoLactancia: { embarazo: { estado: "si", fecha: "2025-09-01", semanas: 20 } },
    })
    const stale = checkPrescription(old, [{ genericName: "enalapril" }], null)
    expect(stale.warnings).toEqual([])
    expect(stale.reminders[0]).toMatch(/ya habría terminado/)
  })

  it("la lactancia se recuerda con su fecha", () => {
    const check = checkPrescription(
      context({ embarazoLactancia: { lactancia: { estado: "si", fecha: "2026-09-01" } } }),
      [{ genericName: "ibuprofeno" }],
      null,
    )
    expect(check.reminders).toEqual([
      "Da de lactar (registrado el 01/09/2026): revisa que cada medicamento sea compatible con la lactancia.",
    ])
  })

  it("a un menor de 12 años se le receta con su peso", () => {
    const child = context({}, "2021-02-10")
    expect(checkPrescription(child, [{ genericName: "amoxicilina" }], null)).toMatchObject({
      weightRequired: true,
      errors: ["Tiene 5 años: escribe su peso para recetarle."],
    })
    expect(checkPrescription(child, [{ genericName: "amoxicilina" }], 18.5).errors).toEqual([])
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
