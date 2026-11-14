import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { PatientHealth } from "../../lib/patients"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { askWhom, HealthReviewNotice } from "./health-review-notice"

declareProduct(bareProduct("dental"))

vi.mock("../../lib/crm", () => ({ usePermission: () => true, useMemberName: () => () => "Dra. Ana" }))

const health: PatientHealth = {
  revision: 0,
  reviewStatus: { allergies: "unknown", conditions: "unknown", medications: "unknown" },
  allergies: [],
  conditions: [],
  medications: [],
  bloodGroup: null,
  reviewedAt: null,
  reviewedBy: null,
  allergyReviewDue: true,
  latestAnamnesis: null,
}

function render(value: PatientHealth): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <HealthReviewNotice patientId="p1" patientName="Lucía Ríos" health={value} />
    </QueryClientProvider>,
  )
}

// QA del 8 nov (A2): con anestesia, la atención solo pedía las alergias.
describe("«Pregúntale» en la atención", () => {
  it("pide alergias, enfermedades y medicación, cada una con su respuesta a un toque", () => {
    const page = render(health)
    expect(page).toContain("Pregúntale a Lucía por sus alergias, sus enfermedades y su medicación")
    expect(page).toContain("No tiene alergias")
    expect(page).toContain("Niega enfermedades")
    expect(page).toContain("No toma medicación")
    // La ASA es un juicio del profesional: no se elige en el aviso.
    expect(page).not.toContain("ASA")
  })
  it("lo ya respondido no se vuelve a pedir; con todo respondido no aparece", () => {
    const asked = render({ ...health, reviewStatus: { ...health.reviewStatus, conditions: "none" } })
    expect(asked).not.toContain("Niega enfermedades")
    expect(asked).toContain("No toma medicación")
    const allergiesOnly = render({
      ...health,
      reviewStatus: { allergies: "unknown", conditions: "none", medications: "none" },
    })
    expect(allergiesOnly).toContain("Pregúntale a Lucía si tiene alergias")
    expect(
      render({ ...health, allergyReviewDue: false, reviewStatus: { allergies: "none", conditions: "none", medications: "none" } }),
    ).toBe("")
  })
  it("lo que dijo y nadie revisó se pide revisar por tema, con sus palabras (lo decide el servidor)", () => {
    const answered = { ...health, allergyReviewDue: false, reviewStatus: { allergies: "recorded", conditions: "none", medications: "recorded" } } as PatientHealth
    const declared = {
      ...answered,
      reviewPending: true,
      allergies: [{ id: "a1", substance: "Látex", reaction: null, isActive: true, severity: "desconocida", source: "paciente" }],
      conditions: [],
      medications: [{ id: "m1", name: "Sulfato ferroso", endDate: null }, { id: "m2", name: "Ácido fólico", endDate: null }],
      pregnancy: { state: "vigente", saidOn: "2026-11-13", weeksSaid: 30, weeksToday: 32 },
      declared: [
        {
          by: { kind: "patient", name: null, relation: null },
          at: "2026-11-13T19:27:00.000Z",
          allergies: ["a1"],
          conditions: [],
          medications: ["m1", "m2"],
          pregnancy: true,
          saidNo: { allergies: false, conditions: true, medications: false },
        },
      ],
    } as unknown as PatientHealth
    const page = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <HealthReviewNotice patientId="p1" patientName="Lucero Vega" health={declared} sex="F" />
      </QueryClientProvider>,
    )
    expect(page).toContain("Revisa con Lucero lo que dijo de su salud")
    expect(page).toContain("Lo dijo ella el 13 nov, sin revisar")
    // El embarazo, con la semana de hoy y lo que dijo ese día.
    expect(page).toContain("32 semanas hoy (dijo 30 el 13 nov)")
    expect(page).toContain("Látex · no dijo qué le pasó")
    expect(page).toContain("Sulfato ferroso, Ácido fólico")
    // Su «No» es de ella: no se lee «niega».
    expect(page).toContain("dijo que no")
    expect(page).not.toContain("Niega")
    expect(render({ ...declared, reviewPending: false })).toBe("")
    // Dos declaraciones sin revisar, cada una con quien la dijo y su día: su madre el 1 nov, ella el 13.
    const two = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <HealthReviewNotice
          patientId="p1"
          patientName="Lucero Vega"
          sex="F"
          health={
            {
              ...declared,
              pregnancy: null,
              declared: [
                {
                  by: { kind: "representative", name: "Carla Vega", relation: "madre" },
                  at: "2026-11-01T15:00:00.000Z",
                  allergies: ["a1"],
                  conditions: [],
                  medications: [],
                  pregnancy: false,
                  saidNo: { allergies: false, conditions: false, medications: false },
                },
                {
                  by: { kind: "patient", name: null, relation: null },
                  at: "2026-11-13T19:27:00.000Z",
                  allergies: [],
                  conditions: [],
                  medications: ["m1", "m2"],
                  pregnancy: false,
                  saidNo: { allergies: false, conditions: false, medications: false },
                },
              ],
            } as unknown as PatientHealth
          }
        />
      </QueryClientProvider>,
    )
    expect(two).toContain("Lo dijo su madre, Carla, el 1 nov, sin revisar")
    expect(two).toContain("Lo dijo ella el 13 nov, sin revisar")
    expect(two.indexOf("Látex")).toBeLessThan(two.indexOf("Lo dijo ella el 13 nov"))
    expect(two.indexOf("Sulfato ferroso")).toBeGreaterThan(two.indexOf("Lo dijo ella el 13 nov"))
  })
  it("un embarazo que ya pasó su término no alarma: pide confirmarlo, sin frenar", () => {
    const past = {
      ...health,
      allergyReviewDue: false,
      reviewStatus: { allergies: "none", conditions: "none", medications: "none" },
      reviewedAt: "2026-11-14T15:00:00.000Z",
      reviewPending: false,
      pregnancy: { state: "por_confirmar", saidOn: "2026-01-10", weeksSaid: 30, weeksToday: null },
      declared: [],
    } as unknown as PatientHealth
    const page = render(past)
    expect(page).toContain("Pregúntale a Lucía si sigue embarazada")
    expect(page).toContain("Embarazo por confirmar")
    expect(page).toContain("Lo dijo el 10 ene, con 30 semanas")
  })
})

describe("«Pregúntale» con representante", () => {
  const guardian = {
    contactId: "c1",
    displayName: "Luis Ríos",
    phone: null,
    email: null,
    isActive: true,
    relationship: "guardian" as const,
    relationshipDetail: "Padre",
    kinship: "FTH",
    isPreferred: true,
    isEmergency: false,
  }
  it("se le pregunta a su representante, con su parentesco y su nombre", () => {
    expect(askWhom([guardian])).toBe("su padre (Luis Ríos)")
    expect(askWhom([{ ...guardian, kinship: null, relationshipDetail: "Tutora" }])).toBe(
      "su tutora (Luis Ríos)",
    )
    expect(askWhom([{ ...guardian, kinship: null, relationshipDetail: null }])).toBe(
      "su representante (Luis Ríos)",
    )
    const page = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <HealthReviewNotice
          patientId="p1"
          patientName="Mateo Ríos"
          health={health}
          askTo={askWhom([guardian])}
        />
      </QueryClientProvider>,
    )
    expect(page).toContain(
      "Pregúntale a su padre (Luis Ríos) por sus alergias, sus enfermedades y su medicación",
    )
  })
  it("un familiar que no es su representante, o uno que ya no está vigente, no cambia a quién se pregunta", () => {
    expect(askWhom([{ ...guardian, relationship: "family" }])).toBeNull()
    expect(askWhom([{ ...guardian, isActive: false }])).toBeNull()
  })

  it("C3 · la odontóloga lee sin clics lo que dijo la mamá de Thiago, con la marca de quien lo dijo", () => {
    const thiago = {
      ...health,
      allergyReviewDue: false,
      reviewPending: true,
      reviewStatus: { allergies: "none", conditions: "recorded", medications: "recorded" },
      conditions: [{ id: "c1", name: "Asma", status: "activa" }],
      medications: [{ id: "m1", name: "salbutamol inhalador cuando tiene crisis", atcCode: null, endDate: null }],
      declared: [
        {
          by: { kind: "representative", name: "Carla Ramos", relation: "madre" },
          at: "2026-11-13T19:27:00.000Z",
          allergies: [],
          conditions: ["c1"],
          medications: ["m1"],
          pregnancy: false,
          interview: [
            { label: "De pequeño", value: "ya no toma biberón · se chupa el dedo" },
            { label: "Dulces o jugos entre comidas", value: "4 o más veces al día" },
            { label: "Dientes", value: "pasta con flúor · se cepilla sin ayuda" },
          ],
          saidNo: { allergies: true, conditions: false, medications: false },
        },
      ],
    } as unknown as PatientHealth
    const carla = { ...guardian, displayName: "Carla Ramos", relationshipDetail: "Madre", kinship: "MTH" }
    const page = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <HealthReviewNotice patientId="p1" patientName="Thiago Quispe" health={thiago} sex="M" askTo={askWhom([carla])} />
      </QueryClientProvider>,
    ).replace(/<[^>]+>/g, "|")
    expect(page).toContain("Revisa con su madre (Carla Ramos) lo que dijo de la salud de Thiago")
    expect(page).toContain("Lo dijo su madre, Carla, el 13 nov, sin revisar")
    expect(page).toMatch(/Enfermedades\|+[^|]*Asma/)
    expect(page).toMatch(/Alergias\|+Su madre dijo que no/i)
    expect(page).toMatch(/De pequeño\|+[^|]*ya no toma biberón · se chupa el dedo/)
    expect(page).toMatch(/Dulces o jugos entre comidas\|+[^|]*4 o más veces al día/)
    expect(page).toMatch(/Dientes\|+[^|]*se cepilla sin ayuda/)
  })

  it("Marta: el anticoagulante y la medicina para los huesos van cada uno en su fila", () => {
    const marta = {
      ...health,
      allergyReviewDue: false,
      reviewPending: true,
      reviewStatus: { allergies: "none", conditions: "none", medications: "recorded" },
      medications: [
        { id: "m1", name: "warfarina 5 mg", atcCode: "B01A", endDate: null },
        { id: "m2", name: "alendronato", atcCode: "M05B", endDate: null },
        { id: "m3", name: "Losartán", atcCode: null, endDate: null },
      ],
      declared: [
        {
          by: { kind: "patient", name: null, relation: null },
          at: "2026-11-13T19:27:00.000Z",
          allergies: [],
          conditions: [],
          medications: ["m1", "m2", "m3"],
          pregnancy: false,
          saidNo: { allergies: false, conditions: false, medications: false },
        },
      ],
    } as unknown as PatientHealth
    const page = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <HealthReviewNotice patientId="p1" patientName="Marta Ríos" health={marta} sex="F" />
      </QueryClientProvider>,
    ).replace(/<[^>]+>/g, "|")
    expect(page).toMatch(/Anticoagulante\|+[^|]*warfarina 5 mg/)
    expect(page).toMatch(/Medicinas para los huesos\|+[^|]*alendronato/)
    expect(page).toMatch(/Medicinas\|+[^|]*Losartán/)
  })
})
