import { describe, expect, it } from "vitest"
import { clinicalProfileFor } from "./index.js"

describe("lista de servicios de cada país (ADR 0069)", () => {
  it("Perú pide la CPMS a toda clínica; un país sin perfil no tiene lista", () => {
    expect(clinicalProfileFor("PE").services).toMatchObject({ system: "CPMS", label: "CPMS", codeName: "código CPMS", required: true, norm: "RM 550-2023-MINSA" })
    expect(clinicalProfileFor("UY").services).toBeNull()
    expect(clinicalProfileFor(null).services).toBeNull()
  })

  it("Colombia y México piden su lista a toda clínica; Chile la tiene de referencia", () => {
    expect(clinicalProfileFor("CO").services).toMatchObject({ system: "CUPS", required: true })
    expect(clinicalProfileFor("MX").services).toMatchObject({ system: "CIE9MC-MX", label: "CIE-9-MC", required: true })
    expect(clinicalProfileFor("CL").services).toMatchObject({ system: "FONASA", required: false })
    expect(clinicalProfileFor("CR").services).toMatchObject({ system: "COLEGIO-CR", required: false })
    expect(clinicalProfileFor("SV").services).toMatchObject({ system: "CIE9MC-SV", required: false })
  })
})
