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
    expect(render({ ...declared, reviewPending: false, declared: [] })).toBe("")
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

  // QA del 14 nov: H2 y H4b de clínica, U3 de diseño.
  const saidBy = (patch: Record<string, unknown>) => ({
    by: { kind: "patient", name: null, relation: null },
    at: "2026-11-13T19:27:00.000Z",
    allergies: [],
    conditions: [],
    medications: [],
    pregnancy: false,
    saidNo: { allergies: false, conditions: false, medications: false },
    ...patch,
  })
  const count = (page: string, word: string) => page.split(word).length - 1

  it("Rosa: el látex que dijo después de una revisión anterior se marca, aunque la salud ya estuviera revisada", () => {
    const rosa = {
      ...health,
      reviewedAt: "2026-03-01T15:00:00.000Z",
      allergiesReviewedAt: "2026-03-01T15:00:00.000Z",
      allergyReviewDue: true,
      reviewPending: false,
      reviewStatus: { allergies: "recorded", conditions: "recorded", medications: "recorded" },
      allergies: [
        { id: "a1", substance: "Penicilinas", severity: "severa", isActive: true, source: "equipo" },
        { id: "a2", substance: "Látex", reaction: "Ronchas con los guantes", severity: "desconocida", isActive: true, source: "paciente" },
      ],
      declared: [saidBy({ allergies: ["a2"] })],
    } as unknown as PatientHealth
    const page = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <HealthReviewNotice patientId="p1" patientName="Rosa Quispe" health={rosa} sex="F" />
      </QueryClientProvider>,
    )
    expect(page).toContain("Revisa con Rosa lo que dijo de su salud")
    expect(page).toContain("Lo dijo ella el 13 nov, sin revisar")
    expect(page).toContain("Látex · Ronchas con los guantes")
    // Una sola caja, un solo título, y el látex una sola vez.
    expect(count(page, "<h2")).toBe(1)
    expect(count(page, "Látex")).toBe(1)
    // Lo que dijo no se da por visto con «Sin cambios»: se revisa a sabiendas, con lo que ya tenía a la vista.
    expect(page).not.toContain("Sin cambios")
    expect(page).not.toContain("alergias nuevas")
    expect(page).toContain("Alergias revisadas")
    expect(page).toContain("Ya tenía anotadas: Penicilinas")
  })

  it("Inés: la alergia que dijo sale una sola vez, en la caja de lo que dijo", () => {
    const ines = {
      ...health,
      reviewPending: true,
      reviewStatus: { allergies: "recorded", conditions: "none", medications: "recorded" },
      allergies: [{ id: "a1", substance: "Látex", reaction: null, severity: "desconocida", isActive: true, source: "paciente" }],
      medications: [{ id: "m1", name: "Ácido fólico", endDate: null }],
      declared: [saidBy({ allergies: ["a1"], medications: ["m1"], saidNo: { allergies: false, conditions: true, medications: false } })],
    } as unknown as PatientHealth
    const page = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <HealthReviewNotice patientId="p1" patientName="Inés Salas" health={ines} sex="F" />
      </QueryClientProvider>,
    )
    expect(page).toContain("Revisa con Inés lo que dijo de su salud")
    expect(count(page, "<h2")).toBe(1)
    expect(count(page, "Látex")).toBe(1)
    expect(page).not.toContain("Sin cambios")
    expect(page).not.toContain("Nadie las revisó todavía")
  })

  it("Mateo: el «No» de su madre no es una pregunta ya hecha; ni «alergias nuevas» ni «Sin cambios»", () => {
    const mateo = {
      ...health,
      reviewPending: true,
      reviewStatus: { allergies: "none", conditions: "none", medications: "none" },
      declared: [
        saidBy({
          by: { kind: "representative", name: "Carla Ríos", relation: "madre" },
          saidNo: { allergies: true, conditions: true, medications: true },
        }),
      ],
    } as unknown as PatientHealth
    const page = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <HealthReviewNotice patientId="p1" patientName="Mateo Ríos" health={mateo} sex="M" askTo="su madre (Carla Ríos)" />
      </QueryClientProvider>,
    )
    expect(page).not.toContain("nuevas")
    expect(page).not.toContain("Sin cambios")
    expect(page).toContain("No tiene alergias")
    expect(page).toContain("su madre dijo que no")
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
})
