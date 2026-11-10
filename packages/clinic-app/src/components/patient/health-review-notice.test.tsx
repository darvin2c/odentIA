import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { PatientHealth } from "../../lib/patients"
import { askWhom, HealthReviewNotice } from "./health-review-notice"

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
  it("lo que declaró en línea y nadie revisó se pide revisar en sus antecedentes (lo decide el servidor)", () => {
    const answered = { ...health, allergyReviewDue: false, reviewStatus: { allergies: "none", conditions: "recorded", medications: "recorded" } } as PatientHealth
    const declared = {
      ...answered,
      reviewPending: true,
      conditions: [{ id: "c1", name: "Hipertensión", status: "activa", notes: "Lo declaró en su registro en línea el 09/11/2026." }],
      medications: [{ id: "m1", name: "Losartán", notes: "Lo declaró en su registro en línea el 09/11/2026." }],
    } as unknown as PatientHealth
    const page = render(declared)
    expect(page).toContain("Revisa con Lucía lo que declaró de su salud")
    expect(page).toContain("Hipertensión y Losartán.")
    expect(render({ ...declared, reviewPending: false })).toBe("")
  })
})

// QA del 10 nov (B11): en un niño decía «Pregúntale a QA por sus alergias», y la ficha ya decía quién habla por él.
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
