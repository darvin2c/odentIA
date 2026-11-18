import { describe, expect, it } from "vitest"
import { SUGGESTED_CONSENT_TEMPLATES } from "./consent.js"
import {
  type ConsentRiskHealth,
  consentPersonalRisks,
  parsePersonalRisks,
} from "./consent-risks.js"

const profileOf = (key: string) =>
  SUGGESTED_CONSENT_TEMPLATES.find((row) => row.key === key)?.riskProfile ?? {}
const today = "2026-11-18"
const none: ConsentRiskHealth = { medications: [], conditions: [], allergies: [] }
const risks = (key: string, health: Partial<ConsentRiskHealth>) =>
  consentPersonalRisks({ profile: profileOf(key), health: { ...none, ...health }, today })

// Caso C1 de las reglas clínicas del 18 nov: Teresa, 68 años, apixabán y «alendronato 70 mg semanal»
// escrito a mano, alergia a las penicilinas; exodoncia de la 48.
const teresa: Partial<ConsentRiskHealth> = {
  medications: [
    { name: "Apixabán 5 mg", genericName: "apixabán", atcCode: "B01AF02" },
    { name: "alendronato 70 mg semanal", atcCode: "M05BA04" },
  ],
  allergies: [
    { substance: "Penicilinas", substanceSystem: "atc", substanceCode: "J01C", isActive: true },
  ],
}

describe("los riesgos propios del consentimiento salen de su ficha y del procedimiento", () => {
  it("Teresa, exodoncia: el sangrado por el apixabán y la osteonecrosis por el alendronato; la penicilina no", () => {
    expect(risks("exodoncia", teresa)).toEqual([
      "Toma un anticoagulante (apixabán): puede sangrar más tiempo después de la extracción.",
      "Toma una medicina para los huesos (alendronato): hay un riesgo poco frecuente de que el hueso de la zona no cicatrice (osteonecrosis).",
    ])
  })

  it("en el implante suma que se pierda; en la endodoncia no hay frase (SDCEP y AAOMS)", () => {
    expect(risks("implante", teresa)).toEqual([
      "Toma un anticoagulante (apixabán): puede sangrar más tiempo después de la cirugía del implante.",
      "Toma una medicina para los huesos (alendronato): hay un riesgo poco frecuente de que el hueso de la zona no cicatrice (osteonecrosis) o de que el implante se pierda.",
    ])
    expect(risks("endodoncia", teresa)).toEqual([])
  })

  it("la warfarina pide el INR; el antiagregante, no dejarlo; lo que ya dejó de tomar no sangra, la medicina para los huesos sí cuenta", () => {
    expect(
      risks("exodoncia", {
        medications: [
          { name: "Warfarina 5 mg", atcCode: "B01AA03" },
          { name: "Plavix", atcCode: "B01AC04" },
          { name: "Eliquis", atcCode: "B01AF02", endDate: "2025-01-01" },
          { name: "Prolia", atcCode: "M05BX04", endDate: "2025-01-01" },
        ],
      }),
    ).toEqual([
      "Toma un anticoagulante (warfarina): puede sangrar más tiempo después de la extracción. Se revisará su INR del día.",
      "Toma un antiagregante (Plavix): puede sangrar un poco más después de la extracción; no debe dejarlo sin indicación de su médico.",
      "Tomó una medicina para los huesos (Prolia): hay un riesgo poco frecuente de que el hueso de la zona no cicatrice (osteonecrosis).",
    ])
  })

  it("la que dijo sin nombrarla va sin paréntesis", () => {
    expect(
      risks("exodoncia", {
        medications: [{ name: "Anticoagulante (no dijo cuál)", atcCode: "B01A" }],
      }),
    ).toEqual(["Toma un anticoagulante: puede sangrar más tiempo después de la extracción."])
  })

  it("la diabetes con código, en lo que abre una herida; escrita sin código, no", () => {
    const diabetes = {
      conditions: [{ status: "activa", diagnosisSystem: "ICD-10-PE", diagnosisCode: "E11.9" }],
    }
    expect(risks("periodoncia", diabetes)).toEqual([
      "Tiene diabetes: la herida puede tardar más en cerrar y tiene más riesgo de infectarse, sobre todo si el azúcar no está controlado.",
    ])
    expect(risks("endodoncia", diabetes)).toEqual([])
    expect(risks("exodoncia", { conditions: [{ status: "activa" }] })).toEqual([])
  })

  it("la alergia a un anestésico local en lo que se anestesia, y el látex en todo", () => {
    const allergies = [
      { substance: "Lidocaína", substanceSystem: "atc", substanceCode: "N01BB02", isActive: true },
      { substance: "Látex", substanceSystem: "odentia", substanceCode: "latex", isActive: true },
    ]
    expect(risks("endodoncia", { allergies })).toEqual([
      "Tiene alergia a lidocaína: se usará un anestésico de otro grupo; aun así puede haber una reacción.",
      "Tiene alergia al látex: se le atenderá con material sin látex.",
    ])
    expect(risks("blanqueamiento", { allergies })).toEqual([
      "Tiene alergia al látex: se le atenderá con material sin látex.",
    ])
    // La quitada o descartada no cuenta.
    expect(
      risks("endodoncia", { allergies: allergies.map((row) => ({ ...row, isActive: false })) }),
    ).toEqual([])
  })

  it("sin nada registrado no propone nada: la hoja queda como siempre", () => {
    expect(risks("exodoncia", {})).toEqual([])
  })
})

describe("lo escrito en el campo, una frase por línea", () => {
  it("quita líneas vacías, viñetas y espacios; vacío es null", () => {
    expect(parsePersonalRisks("  • Toma apixabán.\n\n- Usa prótesis  \n")).toEqual([
      "Toma apixabán.",
      "Usa prótesis",
    ])
    expect(parsePersonalRisks("   \n ")).toBeNull()
    expect(parsePersonalRisks(null)).toBeNull()
  })

  it("se pasa del tope: lo dice", () => {
    expect(() =>
      parsePersonalRisks(Array.from({ length: 11 }, (_, i) => `Riesgo ${i}`).join("\n")),
    ).toThrow("como mucho 10")
    expect(() => parsePersonalRisks("x".repeat(501))).toThrow("500 caracteres")
  })
})

// Verificación del 18 nov (7): «después de el tratamiento de las encías» llegaba al PDF firmado.
it("«después del tratamiento», con su contracción; «de la extracción», sin ella", () => {
  const anticoagulated = { medications: [{ name: "Warfarina", atcCode: "B01AA03" }] }
  expect(risks("periodoncia", anticoagulated)[0]).toContain("después del tratamiento de las encías.")
  expect(risks("exodoncia", anticoagulated)[0]).toContain("después de la extracción.")
  // Sin nombre propio en la plantilla, «después del procedimiento».
  expect(
    consentPersonalRisks({ profile: { wound: true }, health: { ...none, ...anticoagulated }, today })[0],
  ).toContain("después del procedimiento.")
  expect(risks("periodoncia", anticoagulated).join(" ")).not.toMatch(/\bde el\b|\ba el\b/)
})
