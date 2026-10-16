import { canAccess } from "@odentia/auth/permissions"
import { describe, expect, it } from "vitest"
import {
  areaNav,
  clinicalSummaryFor,
  defaultSection,
  documentFilterFromSearch,
  resolveSection,
  sectionFromSearch,
  suggestedDentition,
  visibleAreas,
  visibleSections,
} from "./patient-areas"

const as = (role: string) => (permission: string) => canAccess(role, permission)

describe("pestañas de la página de la persona por rol (tablero 2, «Qué ve cada rol»)", () => {
  const ids = (role: string, isPatient = true) =>
    visibleAreas(as(role), isPatient).map((area) => area.id)

  it("recepción: resumen, conversaciones, citas, plan y datos; ni clínica ni cobros", () => {
    expect(ids("reception")).toEqual(["resumen", "conversaciones", "citas", "plan", "datos"])
    expect(defaultSection(as("reception"))).toBe("resumen")
    // Coordina el tratamiento en el mismo Plan, sin leer la clínica (ADR 0034).
    expect(areaNav("citas", as("reception")).map((entry) => entry.label)).toEqual(["Sus citas"])
    expect(resolveSection("plan", as("reception"))).toBe("plan")
  })

  it("odontología: conversaciones sin el CRM, clínica y plan; sin cobros", () => {
    expect(ids("dentist")).toEqual([
      "resumen",
      "conversaciones",
      "citas",
      "clinica",
      "plan",
      "datos",
    ])
    // Un solo Plan: ni la coordinación, ni Tratamientos, ni Controles aparte (ADR 0034).
    const sections = visibleSections(as("dentist")).map((section) => section.id)
    for (const retired of ["coordinacion", "recorrido", "controles"])
      expect(sections).not.toContain(retired)
    // Ni canales ni portal: son del CRM y de quien edita la filiación.
    expect(areaNav("datos", as("dentist")).map((entry) => entry.label)).toEqual([
      "Datos personales",
      "Personas vinculadas",
      "Responsables",
    ])
  })

  it("caja: resumen, plan (solo presupuestos), cobros y datos; entra por los cobros", () => {
    expect(ids("cashier")).toEqual(["resumen", "plan", "cobros", "datos"])
    expect(defaultSection(as("cashier"))).toBe("cuenta")
  })

  it("propietario: todas las pestañas", () => {
    expect(ids("owner")).toEqual([
      "resumen",
      "conversaciones",
      "citas",
      "clinica",
      "plan",
      "cobros",
      "datos",
    ])
  })

  it("quien aún no es paciente no tiene clínica, plan ni cobros: aparecen al registrarla", () => {
    expect(ids("owner", false)).toEqual(["resumen", "conversaciones", "citas", "datos"])
    expect(ids("cashier", false)).toEqual(["resumen", "datos"])
    // Caja sin ficha no tiene cobros: entra por el resumen.
    expect(defaultSection(as("cashier"), false)).toBe("resumen")
    expect(resolveSection("odontograma", as("owner"), false)).toBe("resumen")
  })

  it("quien solo es responsable de otros no tiene citas propias", () => {
    expect(visibleAreas(as("reception"), "responsable").map((area) => area.id)).toEqual([
      "resumen",
      "conversaciones",
      "datos",
    ])
  })

  it("una sección sin permiso cae en la entrada del rol; sin acceso no hay sección", () => {
    expect(resolveSection("odontograma", as("reception"))).toBe("resumen")
    expect(resolveSection("cuenta", as("dentist"))).toBe("resumen")
    expect(resolveSection("plan", as("admin"))).toBe("plan")
    expect(resolveSection(undefined, as("member"))).toBeNull()
  })

  it("los enlaces guardados de la ficha anterior abren la sección que hace ese trabajo", () => {
    expect(sectionFromSearch("actividad")).toBe("resumen")
    expect(sectionFromSearch("seguimiento")).toBe("conversaciones")
    expect(sectionFromSearch("odontograma")).toBe("odontograma")
    expect(sectionFromSearch("no-existe")).toBeUndefined()
    // Tratamientos, Controles y la coordinación de recepción viven ahora en el Plan.
    expect(sectionFromSearch("recorrido")).toBe("plan")
    expect(sectionFromSearch("controles")).toBe("plan")
    expect(sectionFromSearch("coordinacion")).toBe("plan")
  })

  it("Clínica en cuatro secciones; el odontólogo ve 11 y el propietario 15 (ADR 0035)", () => {
    expect(areaNav("clinica", as("dentist")).map((entry) => entry.label)).toEqual([
      "Antecedentes",
      "Odontograma",
      "Historia",
      "Documentos",
    ])
    expect(visibleSections(as("dentist"))).toHaveLength(11)
    expect(visibleSections(as("owner"))).toHaveLength(15)
    // Recepción y caja no cambian.
    expect(visibleSections(as("reception")).map((section) => section.id)).not.toContain("antecedentes")
    expect(visibleSections(as("cashier")).map((section) => section.area)).not.toContain("clinica")
  })

  it("quien lee la clínica entra por el Resumen clínico; recepción por su Resumen y caja por Cobros", () => {
    for (const role of ["dentist", "owner", "admin"]) {
      expect(defaultSection(as(role))).toBe("resumen")
      expect(clinicalSummaryFor(as(role))).toBe(true)
    }
    expect(clinicalSummaryFor(as("reception"))).toBe(false)
    expect(clinicalSummaryFor(as("cashier"))).toBe(false)
    expect(defaultSection(as("cashier"))).toBe("cuenta")
    // Quien aún no es paciente no tiene historia: su Resumen no es clínico.
    expect(clinicalSummaryFor(as("dentist"), false)).toBe(false)
  })

  it("las secciones retiradas de Clínica abren la que hace ese trabajo", () => {
    expect(sectionFromSearch("clinico")).toBe("resumen")
    expect(sectionFromSearch("atenciones")).toBe("historia")
    for (const kind of ["imagenes", "recetas", "ordenes", "formularios", "consentimientos"]) {
      expect(sectionFromSearch(kind)).toBe("documentos")
      // El tipo de papel pasa a ser el filtro de Documentos.
      expect(documentFilterFromSearch(kind, undefined)).toBe(kind)
    }
    expect(documentFilterFromSearch("documentos", "requieren")).toBe("requieren")
    expect(documentFilterFromSearch("documentos", "otro")).toBeUndefined()
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
