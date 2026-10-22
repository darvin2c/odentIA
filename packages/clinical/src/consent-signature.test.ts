import { describe, expect, it } from "vitest"
import { consentSignatureNote } from "./consent.js"
import { clinicalProfileFor } from "./country-profiles.js"

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
