import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { PatientHealth } from "../../lib/patients"
import { HealthReviewNotice } from "./health-review-notice"

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
})
