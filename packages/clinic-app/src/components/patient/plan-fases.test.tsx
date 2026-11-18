// @vitest-environment jsdom

/**
 * El plan de la ficha con la sesión de hoy sin firmar (QA en pantalla del 17 nov, desarrollo): decía
 * «2 de 2 sesiones · Completar el tratamiento» justo encima de «Sesión 2 · en curso hoy». Terminarlo se
 * decide al firmar esa atención. Y «hoy» es el día de la clínica, no el del navegador.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { setOrgLocale } from "../../lib/locale"
import type { PlanItem, TreatmentJourneySummary } from "../../lib/patients"
import { bareProduct, declareProduct } from "../../product/product-ui"

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}))
vi.mock("../../lib/crm", async (original) => ({
  ...(await original<typeof import("../../lib/crm")>()),
  usePermission: () => true,
}))
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  apiFetch: async () => ({ data: [] }),
}))

const { PlanPhases, sameClinicDay } = await import("./plan-fases")

const endo = {
  id: "it-endo",
  planId: "plan-1",
  title: "Endodoncia",
  scope: "general",
  toothNumber: null,
  surfaces: [],
  status: "en_curso",
  decisionStatus: "aceptado",
  plannedSessions: 2,
  sessionsDone: 2,
  sessions: [
    { encounterId: "enc-0", at: "2026-11-10T15:00:00Z", signed: true, byName: "Dra. Ana", note: null },
    { encounterId: "enc-1", at: new Date().toISOString(), signed: false, byName: "Dra. Ana", note: null },
  ],
} as unknown as PlanItem

beforeEach(() => declareProduct(bareProduct("dental")))
afterEach(() => {
  cleanup()
  setOrgLocale(undefined, undefined)
})

it("con su sesión de hoy sin firmar, la fila no dice «Completar el tratamiento»: dice «en curso hoy»", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <PlanPhases
        patientId="p-1"
        items={[endo]}
        journeys={[{ item: endo, nextAction: "completar" } as unknown as TreatmentJourneySummary]}
        selectedId=""
        onSelect={() => undefined}
      />
    </QueryClientProvider>,
  )
  const row = (await screen.findByText("Endodoncia")).closest("li") as HTMLElement
  expect(row.textContent).toContain("Sesión 2 · en curso hoy")
  expect(row.textContent).not.toContain("Completar el tratamiento")
})

it("el día de una sesión se compara en la zona de la clínica, no en la del navegador", () => {
  // Las 10 p. m. del 17 nov en Lima ya son el 18 en UTC: es el mismo día de la clínica.
  setOrgLocale("es-PE", "America/Lima")
  expect(sameClinicDay("2026-11-18T03:00:00Z", "2026-11-17T15:00:00Z")).toBe(true)
  setOrgLocale("es-PE", "Asia/Tokyo")
  expect(sameClinicDay("2026-11-18T03:00:00Z", "2026-11-17T13:00:00Z")).toBe(false)
})
