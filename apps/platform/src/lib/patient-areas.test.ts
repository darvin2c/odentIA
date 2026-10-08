import { canAccess } from "@odentia/auth/permissions"
import { describe, expect, it } from "vitest"
import {
  areaNav,
  defaultSection,
  resolveSection,
  suggestedDentition,
  visibleAreas,
  visibleSections,
} from "./patient-areas"

const as = (role: string) => (permission: string) => canAccess(role, permission)

describe("áreas de la ficha por rol", () => {
  it("recepción coordina sin clínica ni caja y entra por el resumen", () => {
    const can = as("reception")
    expect(visibleAreas(can).map((area) => area.id)).toEqual(["resumen", "relacion", "datos"])
    expect(defaultSection(can)).toBe("resumen")
    expect(visibleSections(can).some((section) => section.area === "clinica")).toBe(false)
    // Coordina el tratamiento sin leer la clínica; el clínico usa su plan completo.
    expect(areaNav("relacion", can).map((entry) => entry.label)).toEqual([
      "Actividad",
      "Citas",
      "Tratamiento",
      "Seguimiento",
      "Interlocutores",
    ])
    // Odontología ve la actividad y las citas, pero no el seguimiento comercial.
    expect(areaNav("relacion", as("dentist")).map((entry) => entry.label)).toEqual([
      "Actividad",
      "Citas",
      "Interlocutores",
    ])
    expect(visibleSections(as("dentist")).map((section) => section.id)).not.toContain(
      "coordinacion",
    )
    expect(visibleSections(as("admin")).map((section) => section.id)).not.toContain("coordinacion")
  })

  it("odontología entra por el odontograma y no ve la cuenta ni el portal", () => {
    const can = as("dentist")
    expect(defaultSection(can)).toBe("odontograma")
    expect(visibleAreas(can).map((area) => area.id)).toEqual([
      "resumen",
      "clinica",
      "relacion",
      "datos",
    ])
    expect(visibleAreas(can).find((area) => area.id === "clinica")?.target).toBe("odontograma")
    expect(visibleSections(can).map((section) => section.id)).not.toContain("portal")
  })

  it("caja entra por la cuenta", () => {
    const can = as("cashier")
    expect(defaultSection(can)).toBe("cuenta")
    expect(visibleAreas(can).map((area) => area.id)).toEqual(["resumen", "cuenta", "datos"])
  })

  it("una sección sin permiso cae en la entrada del rol; sin acceso no hay sección", () => {
    expect(resolveSection("odontograma", as("reception"))).toBe("resumen")
    expect(resolveSection("cuenta", as("dentist"))).toBe("odontograma")
    expect(resolveSection("plan", as("admin"))).toBe("plan")
    expect(resolveSection(undefined, as("member"))).toBeNull()
  })

  it("los documentos se agrupan en una sola entrada de Clínica", () => {
    const entries = areaNav("clinica", as("dentist"))
    expect(entries.map((entry) => entry.label)).toEqual([
      "Odontograma y plan",
      "Tratamientos",
      "Planes y presupuestos",
      "Controles",
      "Historia",
      "Antecedentes",
      "Documentos",
    ])
    const documents = entries.at(-1)
    expect(documents?.target).toBe("documentos")
    expect(documents?.members.map((section) => section.id)).toEqual([
      "documentos",
      "imagenes",
      "recetas",
      "ordenes",
      "formularios",
      "consentimientos",
    ])
  })
})

describe("dentición sugerida por edad", () => {
  const today = new Date("2026-10-07T12:00:00Z")
  it("temporal hasta 5, mixta de 6 a 12 y permanente desde 13", () => {
    expect(suggestedDentition("2022-01-01", today)).toBe("primary")
    expect(suggestedDentition("2018-03-01", today)).toBe("mixed")
    expect(suggestedDentition("2014-01-01", today)).toBe("mixed")
    expect(suggestedDentition("2013-01-01", today)).toBe("adult")
    expect(suggestedDentition("1972-05-20", today)).toBe("adult")
  })
  it("no supone edad sin una fecha válida", () => {
    expect(suggestedDentition(null, today)).toBeNull()
    expect(suggestedDentition("no-es-fecha", today)).toBeNull()
    expect(suggestedDentition("2030-01-01", today)).toBeNull()
  })
})
