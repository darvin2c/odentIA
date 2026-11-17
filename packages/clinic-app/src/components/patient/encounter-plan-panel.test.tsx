// @vitest-environment jsdom

/**
 * La línea del presupuesto de la atención (QA del 16 nov, Q3). Tras «Armarlo ahora» seguía a la
 * vista «Presupuesto · Endodoncia… · entra al firmar» hasta recargar: se volvía a leer el plan,
 * pero no el detalle de la atención, de donde sale lo indicado hoy con su presupuesto.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ASSEMBLED_QUERY_KEYS, INDICATED_QUERY_KEYS } from "../../lib/budgets"
import type { PlanItem } from "../../lib/patients"
import { bareProduct, declareProduct } from "../../product/product-ui"

const calls = vi.hoisted(() => [] as string[])
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}))
vi.mock("../../lib/crm", async (original) => ({
  ...(await original<typeof import("../../lib/crm")>()),
  usePermission: () => true,
}))
vi.mock("../../lib/org", async (original) => ({
  ...(await original<typeof import("../../lib/org")>()),
  useOrgProfile: () => ({ data: { locale: "es-PE" } }),
}))
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  apiFetch: async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${url}`)
    return url.endsWith("/budget") ? { data: { id: "b-1" } } : { data: null }
  },
}))

const { EncounterBudgetSend } = await import("./encounter-plan-panel")

declareProduct(bareProduct("dental"))
afterEach(() => {
  cleanup()
  calls.length = 0
})

const endodoncia = {
  id: "i-endo",
  title: "Endodoncia posterior vital",
  scope: "tooth",
  toothNumber: 36,
  surfaces: [],
  quadrant: null,
  arch: null,
  priceCents: 65000,
  currency: "PEN",
  budgetId: null,
  status: "pendiente",
  decisionStatus: "pendiente",
} as unknown as PlanItem

it("«Armarlo ahora» vuelve a leer el detalle de la atención: la línea «entra al firmar» no se queda", async () => {
  const client = new QueryClient()
  const invalidate = vi.spyOn(client, "invalidateQueries")
  render(
    <QueryClientProvider client={client}>
      <EncounterBudgetSend
        patientId="p-1"
        encounterId="e-1"
        patientName="Paola"
        beforeWrite={async () => {}}
        unquoted={[endodoncia]}
      />
    </QueryClientProvider>,
  )
  expect(screen.getByText(/Endodoncia posterior vital · Pieza 36 · S\/\s?650\.00 · entra al firmar/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Armarlo ahora" }))
  await waitFor(() => expect(calls).toContain("POST /api/patients/p-1/encounters/e-1/budget"))
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["encounter", "p-1"] }))
  // Y lo de siempre: el presupuesto, el plan y «Qué sigue».
  for (const key of ["budget", "budgets", "plan-items", "plan-next", "next-steps"])
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [key, "p-1"] })
})

// Q4: lo indicado entra solo al borrador; la tarjeta de cada opción lee el detalle del presupuesto.
it("al indicar o armar se vuelve a pedir el detalle del presupuesto, que lee la tarjeta de cada opción", () => {
  expect(INDICATED_QUERY_KEYS).toEqual(expect.arrayContaining(["budget", "budgets", "plan-next", "plan-items"]))
  expect(ASSEMBLED_QUERY_KEYS).toEqual(expect.arrayContaining(["budget", "budgets", "encounter"]))
})
