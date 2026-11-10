import { describe, expect, it } from "vitest"
import { consentSignatureNote } from "./consent.js"
import { clinicalProfileFor } from "./country-profiles.js"
import { typedIdentityDocument } from "./identity.js"

describe("nota de la firma del consentimiento (#47)", () => {
  it("en Perú nombra su ley de firmas; sin perfil propio no nombra ninguna", () => {
    expect(consentSignatureNote(clinicalProfileFor("PE").signatureLaw)).toMatch(/\(Ley 27269\)\.$/)
    for (const country of ["CO", "AR", null]) {
      const note = consentSignatureNote(clinicalProfileFor(country).signatureLaw)
      expect(note).toMatch(/^Firma electrónica simple/)
      expect(note).not.toMatch(/Ley/)
    }
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
