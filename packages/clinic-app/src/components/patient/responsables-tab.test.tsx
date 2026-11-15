import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { PatientContactLink, PatientFull } from "../../lib/patients"
import { ResponsablesTab } from "./responsables-tab"

vi.mock("../../lib/crm", () => ({ usePermission: () => true }))

const mother: PatientContactLink = {
  contactId: "rosa",
  displayName: "Rosa Lozano Díaz",
  phone: "+51987654321",
  email: null,
  isActive: true,
  relationship: "guardian",
  relationshipDetail: "Madre",
  kinship: "MTH",
  isPreferred: true,
  isEmergency: false,
}

function tab(contacts: PatientContactLink[]): string {
  const client = new QueryClient()
  client.setQueryData(["responsibilities", "p1"], { data: [] })
  client.setQueryData(["patient", "p1"], { data: { contacts, isMinor: true } as unknown as PatientFull })
  client.setQueryData(["patient-documents", "p1"], { data: [] })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ResponsablesTab patientId="p1" />
    </QueryClientProvider>,
  )
}

// QA de formularios del 15 nov (K15, novato 4): con la mamá vinculada como quien habla por él, la
// misma sección decía «Sin responsables». Quién decide no cambia: solo se dice lo que hay.
describe("Responsables, con quien habla por el paciente vinculado", () => {
  it("no dice «Sin responsables»: nombra a la mamá y ofrece asignarle la responsabilidad", () => {
    const html = tab([mother])
    expect(html).not.toContain("Sin responsables")
    expect(html).toContain("Rosa Lozano Díaz")
    expect(html).toContain("Madre")
    expect(html).toContain("Aún sin responsabilidad asignada")
    expect(html).toContain("Asignarle una responsabilidad")
  })

  it("sin nadie vinculado que hable por él, sigue «Sin responsables»", () => {
    expect(tab([])).toContain("Sin responsables")
    expect(tab([{ ...mother, relationship: "family" }])).toContain("Sin responsables")
    expect(tab([{ ...mother, isActive: false }])).toContain("Sin responsables")
  })
})
