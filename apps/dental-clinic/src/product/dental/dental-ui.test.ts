import { canAccess } from "@odentia/auth/permissions"
import { beforeAll, describe, expect, it } from "vitest"
import { areaNav, navSectionOf, subsectionNav, visibleSections } from "@odentia/clinic-app/lib/patient-areas"
import { declareProduct } from "@odentia/clinic-app/product/product-ui"
import { dentalUi } from "./index"

const as = (role: string) => (permission: string) => canAccess(role, permission)

beforeAll(() => declareProduct(dentalUi))

describe("odentIA en la página de la persona (ADR 0035 y 0079)", () => {
  it("Clínica en cuatro secciones: Antecedentes, Odontograma, Historia y Documentos", () => {
    expect(areaNav("clinica", as("clinician")).map((entry) => entry.label)).toEqual([
      "Antecedentes",
      "Odontograma",
      "Historia",
      "Documentos",
    ])
    // Periodontograma va debajo de Odontograma (issue 49): no suma una pestaña.
    expect(subsectionNav("periodontograma", as("clinician")).map((entry) => entry.label)).toEqual([
      "Odontograma",
      "Periodontograma",
    ])
    expect(navSectionOf("periodontograma")).toBe("odontograma")
    expect(visibleSections(as("clinician"))).toHaveLength(12)
    expect(visibleSections(as("owner"))).toHaveLength(17)
    // Recepción no lee la clínica: no ve el odontograma.
    expect(visibleSections(as("reception")).map((section) => section.id)).not.toContain(
      "odontograma",
    )
  })

  it("el «dónde» es la pieza en FDI, permanente o temporal, con sus caras", () => {
    const site = dentalUi.site
    expect(site?.isPlace(16)).toBe(true)
    expect(site?.isPlace(85)).toBe(true)
    expect(site?.isPlace(19)).toBe(false)
    expect(site?.placeGroups.map((group) => group.label)).toEqual(["Permanentes", "Temporales"])
    expect(site?.placeName(16)).toBe("Pieza 16")
    expect(site?.partsOf(16).length).toBeGreaterThan(0)
    // Un número que no es pieza no tiene caras, en vez de fallar.
    expect(site?.partsOf(99)).toEqual([])
  })
})
