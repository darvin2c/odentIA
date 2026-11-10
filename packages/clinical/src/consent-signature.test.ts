import { describe, expect, it } from "vitest"
import { BUDGET_SIGNATURE_NOTE, CONSENT_SIGNATURE_NOTES, noteNamesSignatureKind, signatureKindWords } from "./consent.js"
import { clinicalProfileFor } from "./country-profiles.js"
import { typedIdentityDocument } from "./identity.js"

describe("lo que dice la hoja sobre su firma (entrega 11)", () => {
  it("al firmar, en positivo: sin advertencias ni la ley, y nunca «digital» ni «certificada»", () => {
    for (const note of [...Object.values(CONSENT_SIGNATURE_NOTES), BUDGET_SIGNATURE_NOTE]) {
      expect(note).not.toMatch(/digital|certificad|Ley|no constituye|evidencia/i)
      expect(note).toMatch(/fecha y la hora/)
    }
    // Quien firma puede ser el representante: la historia no es «su» historia.
    expect(CONSENT_SIGNATURE_NOTES.clinica).not.toMatch(/su historia/)
    // Por enlace queda pendiente hasta que el profesional lo confirma: el texto lo dice.
    expect(CONSENT_SIGNATURE_NOTES.enlace).toMatch(/cuando el profesional la confirme/)
  })

  it("el nivel de la firma, para el PDF: en Perú nombra su ley; sin perfil propio no nombra ninguna", () => {
    expect(signatureKindWords(clinicalProfileFor("PE").signatureLaw)).toBe("Firma electrónica simple (Ley 27269)")
    for (const country of ["CO", "AR", null]) {
      expect(signatureKindWords(clinicalProfileFor(country).signatureLaw)).toBe("Firma electrónica simple")
    }
  })

  it("la nota que se guardaba antes ya nombra el nivel: el presupuesto no lo repite", () => {
    expect(
      noteNamesSignatureKind(
        "Firma electrónica simple: firmas manuscritas capturadas como evidencia; no constituyen firma digital certificada (Ley 27269).",
      ),
    ).toBe(true)
    expect(noteNamesSignatureKind(BUDGET_SIGNATURE_NOTE)).toBe(false)
    expect(noteNamesSignatureKind(null)).toBe(false)
  })
})

describe("el documento escrito al firmar como representante", () => {
  it("se lee como tipo y número para guardarlo en su ficha; un tipo desconocido no se adivina", () => {
    expect(typedIdentityDocument("DNI 45678912", "PE")).toEqual({
      docType: "DNI",
      docNumber: "45678912",
    })
    expect(typedIdentityDocument("d.n.i.: 45 678 912", "PE")).toEqual({
      docType: "DNI",
      docNumber: "45678912",
    })
    expect(typedIdentityDocument("45678912", "PE")).toEqual({
      docType: "DNI",
      docNumber: "45678912",
    })
    expect(typedIdentityDocument("Carné de extranjería 001234567", "PE")).toEqual({
      docType: "CE",
      docNumber: "001234567",
    })
    expect(typedIdentityDocument("Pasaporte ab1234567", "PE")).toEqual({
      docType: "PASAPORTE",
      docNumber: "AB1234567",
    })
    expect(typedIdentityDocument("Licencia 123", "PE")).toBeNull()
    expect(typedIdentityDocument("1234567", "PE")).toBeNull()
    // Fuera de Perú no hay DNI que suponer.
    expect(typedIdentityDocument("45678912", "CO")).toBeNull()
    expect(typedIdentityDocument("  ", "PE")).toBeNull()
  })
})
