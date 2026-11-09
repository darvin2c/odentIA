import { canAccess } from "@odentia/auth/permissions"
import { beforeAll, describe, expect, it } from "vitest"
import { bareProduct, declareProduct, type ProductUi } from "../product/product-ui"
import {
  areaNav,
  clinicalSummaryFor,
  defaultSection,
  documentFilterFromSearch,
  navSectionOf,
  resolveSection,
  sectionFromSearch,
  subsectionNav,
  visibleAreas,
  visibleSections,
} from "./patient-areas"

const as = (role: string) => (permission: string) => canAccess(role, permission)

/**
 * Un producto de prueba con una sección en Clínica y otra debajo, como
 * Odontograma y Periodontograma en odentIA (`product/dental/dental-ui.test.ts`).
 */
const PRODUCT: ProductUi = {
  ...bareProduct("medical"),
  record: {
    sections: [
      { id: "estudio", label: "Estudio", render: () => null },
      { id: "detalle", label: "Detalle", parent: "estudio", render: () => null },
    ],
  },
}
beforeAll(() => declareProduct(PRODUCT))

describe("pestañas de la página de la persona por rol (tablero 2, «Qué ve cada rol»)", () => {
  const ids = (role: string, isPatient = true) =>
    visibleAreas(as(role), isPatient).map((area) => area.id)

  it("recepción: resumen, citas, plan y datos; ni clínica ni cobros", () => {
    expect(ids("reception")).toEqual(["resumen", "citas", "plan", "datos"])
    expect(defaultSection(as("reception"))).toBe("resumen")
    // Coordina el tratamiento en el mismo Plan, sin leer la clínica (ADR 0034).
    expect(areaNav("citas", as("reception")).map((entry) => entry.label)).toEqual(["Sus citas"])
    expect(resolveSection("plan", as("reception"))).toBe("plan")
  })

  it("los pedidos sobre sus datos los ven Recepción y Administración, junto a quién consultó su historia (ADR 0080)", () => {
    const datos = (role: string) => areaNav("datos", as(role)).map((entry) => entry.value)
    expect(datos("reception")).toContain("pedidos")
    expect(datos("owner")).toContain("pedidos")
    expect(datos("clinician")).not.toContain("pedidos")
    expect(datos("cashier")).not.toContain("pedidos")
    // Solo con ficha: quien aún no es paciente no tiene historia que pedir.
    expect(areaNav("datos", as("owner"), false).map((entry) => entry.value)).not.toContain("pedidos")
    // Datos en cuatro (QA de la ficha del 8 nov): antes eran siete.
    expect(areaNav("datos", as("owner")).map((entry) => entry.label)).toEqual([
      "Datos personales",
      "Familia y responsables",
      "Enlace y portal",
      "Privacidad y pedidos",
    ])
  })

  it("odontología: clínica y plan; sin cobros", () => {
    expect(ids("clinician")).toEqual([
      "resumen",
      "citas",
      "clinica",
      "plan",
      "datos",
    ])
    // Un solo Plan: ni la coordinación, ni Tratamientos, ni Controles aparte (ADR 0034).
    const sections = visibleSections(as("clinician")).map((section) => section.id)
    for (const retired of ["coordinacion", "recorrido", "controles"])
      expect(sections).not.toContain(retired)
    // Ni canales ni portal: son del CRM y de quien edita la filiación.
    expect(areaNav("datos", as("clinician")).map((entry) => entry.label)).toEqual([
      "Datos personales",
      "Familia y responsables",
    ])
  })

  it("caja: resumen, plan (solo presupuestos), cobros y datos; entra por los cobros", () => {
    expect(ids("cashier")).toEqual(["resumen", "plan", "cobros", "datos"])
    expect(defaultSection(as("cashier"))).toBe("cuenta")
  })

  it("propietario: todas las pestañas", () => {
    expect(ids("owner")).toEqual([
      "resumen",
      "citas",
      "clinica",
      "plan",
      "cobros",
      "datos",
    ])
  })

  it("quien aún no es paciente no tiene clínica, plan ni cobros: aparecen al registrarla", () => {
    expect(ids("owner", false)).toEqual(["resumen", "citas", "datos"])
    expect(ids("cashier", false)).toEqual(["resumen", "datos"])
    // Caja sin ficha no tiene cobros: entra por el resumen.
    expect(defaultSection(as("cashier"), false)).toBe("resumen")
    expect(resolveSection("estudio", as("owner"), false)).toBe("resumen")
  })

  it("quien solo es responsable de otros no tiene citas propias", () => {
    expect(visibleAreas(as("reception"), "responsable").map((area) => area.id)).toEqual([
      "resumen",
      "datos",
    ])
  })

  it("una sección sin permiso cae en la entrada del rol; sin acceso no hay sección", () => {
    expect(resolveSection("estudio", as("reception"))).toBe("resumen")
    expect(resolveSection("cuenta", as("clinician"))).toBe("resumen")
    expect(resolveSection("plan", as("admin"))).toBe("plan")
    expect(resolveSection(undefined, as("member"))).toBeNull()
  })

  it("los enlaces guardados de la ficha anterior abren la sección que hace ese trabajo", () => {
    expect(sectionFromSearch("actividad")).toBe("resumen")
    // Conversaciones ya no es una pestaña: sus conversaciones están en el Resumen.
    expect(sectionFromSearch("seguimiento")).toBe("resumen")
    expect(sectionFromSearch("conversaciones")).toBe("resumen")
    // Datos en cuatro: cada sección vieja abre la que la contiene.
    expect(sectionFromSearch("canales")).toBe("filiacion")
    expect(sectionFromSearch("responsables")).toBe("contactos")
    expect(sectionFromSearch("accesos")).toBe("pedidos")
    expect(sectionFromSearch("estudio")).toBe("estudio")
    expect(sectionFromSearch("no-existe")).toBeUndefined()
    // Tratamientos, Controles y la coordinación de recepción viven ahora en el Plan.
    expect(sectionFromSearch("recorrido")).toBe("plan")
    expect(sectionFromSearch("controles")).toBe("plan")
    expect(sectionFromSearch("coordinacion")).toBe("plan")
  })

  it("Clínica con lo del producto después de Antecedentes; el que atiende ve 10 y el propietario 13 (ADR 0035 y 0080; Datos en cuatro)", () => {
    expect(areaNav("clinica", as("clinician")).map((entry) => entry.label)).toEqual([
      "Antecedentes",
      "Estudio",
      "Historia",
      "Documentos",
    ])
    // Lo que va debajo de otra sección no suma una pestaña: se elige dentro de ella.
    expect(subsectionNav("detalle", as("clinician")).map((entry) => entry.label)).toEqual(["Estudio", "Detalle"])
    expect(subsectionNav("estudio", as("clinician"))).toHaveLength(2)
    expect(subsectionNav("historia", as("clinician"))).toEqual([])
    expect(navSectionOf("detalle")).toBe("estudio")
    expect(visibleSections(as("clinician"))).toHaveLength(10)
    expect(visibleSections(as("owner"))).toHaveLength(13)
    // Recepción y caja no cambian.
    expect(visibleSections(as("reception")).map((section) => section.id)).not.toContain("antecedentes")
    expect(visibleSections(as("cashier")).map((section) => section.area)).not.toContain("clinica")
  })

  it("quien lee la clínica entra por el Resumen clínico; recepción por su Resumen y caja por Cobros", () => {
    for (const role of ["clinician", "owner", "admin"]) {
      expect(defaultSection(as(role))).toBe("resumen")
      expect(clinicalSummaryFor(as(role))).toBe(true)
    }
    expect(clinicalSummaryFor(as("reception"))).toBe(false)
    expect(clinicalSummaryFor(as("cashier"))).toBe(false)
    expect(defaultSection(as("cashier"))).toBe("cuenta")
    // Quien aún no es paciente no tiene historia: su Resumen no es clínico.
    expect(clinicalSummaryFor(as("clinician"), false)).toBe(false)
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

// QA del 6 nov (B8): `?tab=datos` abría el Resumen.
describe("el nombre de un área en el enlace", () => {
  it("abre su primera sección", () => {
    expect(sectionFromSearch("datos")).toBe("filiacion")
    expect(sectionFromSearch("cobros")).toBe("cuenta")
    expect(sectionFromSearch("clinica")).toBe("antecedentes")
  })
})
