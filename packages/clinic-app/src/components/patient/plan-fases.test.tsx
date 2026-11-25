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

const { PlanPhases, planPhasesNote, sameClinicDay } = await import("./plan-fases")

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

// QA del 18 nov: la nota decía que la fase sale solo del tipo de servicio; ahora la pulpitis la lleva a «Urgencia».
it("la nota del plan dice que el diagnóstico de urgencia propone «Urgencia», y nada de fases con una sola", () => {
  const base = bareProduct("dental")
  declareProduct({
    ...base,
    plan: {
      ...base.plan,
      phases: [
        { key: "urgencia", label: "Urgencia", hint: "Dolor, infección, trauma" },
        { key: "basica", label: "Básica", hint: "" },
      ],
    },
  })
  expect(planPhasesNote()).toBe(
    "La fase la propone el tipo de servicio; si su diagnóstico es de dolor, infección aguda o trauma, «Urgencia». Se puede cambiar con «Planificar…». Cada procedimiento registrado en una atención suma una sesión.",
  )
  declareProduct(base)
  expect(planPhasesNote()).toBe("Cada procedimiento registrado en una atención suma una sesión.")
})

it("la exodoncia avisa lo que toma en el Plan: por hacer y como opción por decidir entre conservar o extraer", async () => {
  const risks = ["Toma apixabán 5 mg: riesgo de sangrado."]
  const base = { planId: "plan-1", scope: "tooth", surfaces: [], status: "pendiente", plannedSessions: 1, sessionsDone: 0, sessions: [] }
  const path = (positions: number[]) => ({ budgetId: "b-1", positions, name: null, pathCount: 2, chosen: false })
  const exo38 = { ...base, id: "it-38", title: "Exodoncia simple", toothNumber: 38, decisionStatus: "aceptado", extractionRisks: risks } as unknown as PlanItem
  const endo46 = { ...base, id: "it-endo", title: "Endodoncia", toothNumber: 46, decisionStatus: "pendiente", path: path([1]) } as unknown as PlanItem
  const exo46 = { ...base, id: "it-46", title: "Exodoncia simple", toothNumber: 46, decisionStatus: "pendiente", path: path([2]), extractionRisks: risks } as unknown as PlanItem
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <PlanPhases patientId="p-1" items={[exo38, endo46, exo46]} journeys={[]} selectedId="" onSelect={() => undefined} />
    </QueryClientProvider>,
  )
  const warnings = await screen.findAllByRole("list", { name: "Antes de la exodoncia" })
  expect(warnings).toHaveLength(2)
  const pending = (await screen.findByText(/por decidir entre dos opciones/)).closest("section") as HTMLElement
  expect(pending.textContent).toContain("Toma apixabán 5 mg: riesgo de sangrado.")
  // Solo bajo el camino que extrae: la endodoncia no lo dice.
  const conserve = [...pending.querySelectorAll("li")].find((li) => li.textContent?.startsWith("Endodoncia")) as HTMLElement
  expect(conserve.textContent).not.toContain("riesgo de sangrado")
})
