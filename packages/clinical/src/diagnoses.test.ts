import { describe, expect, it } from "vitest"
import { clinicalProfileFor } from "./country-profiles.js"
import {
  diagnosisCodeLabel,
  findingDiagnosisCode,
  findingDiagnosisCodes,
  hisDiagnosisType,
  isDiagnosisCodeFormat,
  isSelectableDiagnosisSystem,
  normalizeDiagnosisCode,
  normalizeSearchText,
} from "./diagnoses.js"
import { hl7DocumentTypeCode, maritalStatusToHl7 } from "./identity.js"
import { validateDemographics } from "./patient-registration.js"

describe("listas de diagnósticos", () => {
  it("cada país recomienda su lista: la del MINSA en Perú, CIE-10 en general, CIE-11 en Colombia; Perú avisa por el HIS", () => {
    expect(clinicalProfileFor("PE").diagnosis.recommended).toBe("ICD-10-PE")
    expect(clinicalProfileFor("CL").diagnosis.recommended).toBe("ICD-10")
    expect(clinicalProfileFor(null).diagnosis.recommended).toBe("ICD-10")
    expect(clinicalProfileFor("CO").diagnosis.recommended).toBe("ICD-11")
    expect(clinicalProfileFor("PE").diagnosis.notices["ICD-11"]).toBe(
      "En Perú, el registro oficial (HIS) pide la CIE-10 del MINSA. Con la CIE-11, esa hoja no se podrá llenar.",
    )
    expect(clinicalProfileFor("PE").diagnosis.notices["ICD-10"]).toMatch(/CIE-10 del MINSA/)
  })

  it("la CIE-10 del MINSA: sus códigos de seis caracteres y lo mismo que propone el odontograma en la de la OMS", () => {
    expect(normalizeDiagnosisCode("ICD-10-PE", "Z30051")).toBe("Z30.051")
    expect(normalizeDiagnosisCode("ICD-10-PE", "Z33X21")).toBe("Z33.X21")
    expect(normalizeDiagnosisCode("ICD-10-PE", "K021")).toBe("K02.1")
    expect(isDiagnosisCodeFormat("ICD-10-PE", "Z30.051")).toBe(true)
    // La de la OMS no tiene sexto carácter: queda como vino y no tiene su forma.
    expect(normalizeDiagnosisCode("ICD-10", "Z30051")).toBe("Z30051")
    expect(isDiagnosisCodeFormat("ICD-10", "Z30.051")).toBe(false)
    expect(isSelectableDiagnosisSystem("ICD-10-PE")).toBe(true)
    expect(findingDiagnosisCode("ICD-10-PE", "caries", "dentin")).toBe("K02.1")
    expect(findingDiagnosisCodes("ICD-10-PE")).toEqual(findingDiagnosisCodes("ICD-10"))
  })

  it("el hallazgo del odontograma propone su código en cada lista, sin convertir de una a otra", () => {
    expect(findingDiagnosisCode("ICD-10", "caries", "dentin")).toBe("K02.1")
    expect(findingDiagnosisCode("ICD-10", "caries", null)).toBe("K02.9")
    expect(findingDiagnosisCode("ICD-10", "fracture")).toBe("S02.5")
    expect(findingDiagnosisCode("ICD-11", "caries", "dentin")).toBe("DA08.0")
    expect(findingDiagnosisCode("ICD-11", "root_remnant")).toBe("DA0A.3")
    expect(findingDiagnosisCode("ICD-11", "missing_tooth", "caries_extraction")).toBe("DA0A.1")
    expect(findingDiagnosisCode("ICD-11", "missing_tooth", "orthodontic")).toBeNull()
    expect(findingDiagnosisCode("ICD-10", "crown")).toBeNull()
  })

  it("normaliza códigos y texto de búsqueda; el HIS de Perú dice R cuando ya estaba diagnosticado", () => {
    expect(normalizeDiagnosisCode("ICD-10", " k021† ")).toBe("K02.1")
    expect(normalizeDiagnosisCode("ICD-11", "na0d.01")).toBe("NA0D.01")
    expect(normalizeSearchText("ERUPCIÓN Dentária")).toBe("erupcion dentaria")
    expect(diagnosisCodeLabel("ICD-11", "DA08.0")).toBe("CIE-11 · DA08.0")
    expect(hisDiagnosisType("provisional", true)).toBe("P")
    expect(hisDiagnosisType("confirmed", false)).toBe("D")
    expect(hisDiagnosisType("confirmed", true)).toBe("R")
  })
})

describe("demografía con códigos internacionales", () => {
  it("«Conviviente» se guarda como palabra de Perú y sale como HL7 T solo al exportar", () => {
    expect(maritalStatusToHl7("PE:conviviente")).toEqual({
      system: "http://terminology.hl7.org/CodeSystem/v3-MaritalStatus",
      code: "T",
      display: "Domestic partner",
      text: "Conviviente",
    })
    expect(maritalStatusToHl7("M")).toMatchObject({ code: "M", text: "Casado(a)" })
    expect(maritalStatusToHl7("casado")).toBeNull()
  })

  it("el estado civil que se ofrece depende del país, y lo guardado no se vuelve a juzgar", () => {
    expect(
      validateDemographics({ displayName: "Rosa", maritalStatus: "T" }, undefined, "PE")
        .maritalStatus,
    ).toBe("Elige el estado civil de la lista")
    expect(
      validateDemographics(
        { displayName: "Rosa", maritalStatus: "PE:conviviente" },
        undefined,
        "PE",
      ).maritalStatus,
    ).toBeUndefined()
    expect(
      validateDemographics({ displayName: "Rosa", maritalStatus: "T" }, undefined, "CO")
        .maritalStatus,
    ).toBeUndefined()
    expect(
      validateDemographics(
        { displayName: "Rosa", maritalStatus: "PE:conviviente" },
        undefined,
        "CO",
        { maritalStatus: "PE:conviviente" },
      ).maritalStatus,
    ).toBeUndefined()
    expect(
      validateDemographics({ displayName: "Rosa", educationLevel: "9" }, undefined, "PE")
        .educationLevel,
    ).toBeDefined()
  })

  it("cada tipo de documento tiene su código HL7 v2-0203", () => {
    expect(hl7DocumentTypeCode("DNI", "PE")).toBe("NNPER")
    expect(hl7DocumentTypeCode("NACIONAL", "CO")).toBe("NNCOL")
    expect(hl7DocumentTypeCode("NACIONAL", null)).toBe("NI")
    expect(hl7DocumentTypeCode("PASAPORTE", "VE")).toBe("PPN")
    expect(hl7DocumentTypeCode("CE", "PE")).toBe("PRC")
    expect(hl7DocumentTypeCode("CNV", "PE")).toBe("BCT")
    expect(hl7DocumentTypeCode("OTRO", "PE")).toBeNull()
  })
})
