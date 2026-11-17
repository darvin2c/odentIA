// @vitest-environment jsdom

/**
 * «¿Qué respondió?» con el presupuesto que cambia por debajo (QA del 16 nov, Q1). Paola tenía dos
 * opciones para la 36 (endodoncia o exodoncia); con el panel ya abierto entra al borrador la resina
 * de la 37, que va en las dos. Antes la resina salía sin botones, «Acepta» decía S/ 650 y al guardar
 * el servidor respondía 400: la línea viajaba sin respuesta.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, expect, it, vi } from "vitest"
import type { BudgetLine, BudgetOption, BudgetWithTotals } from "../../../lib/budgets"
import { bareProduct, declareProduct } from "../../../product/product-ui"

const decide = vi.hoisted(() => vi.fn())
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}))
vi.mock("../../../lib/agent-names", () => ({ useReceptionName: () => "Sofi" }))
vi.mock("../../../lib/crm", async (original) => ({
  ...(await original<typeof import("../../../lib/crm")>()),
  usePermission: () => true,
}))
vi.mock("../../../lib/clinical-journey", async (original) => ({
  ...(await original<typeof import("../../../lib/clinical-journey")>()),
  fetchResponsibilities: async () => ({ data: [] }),
}))
vi.mock("../../../lib/api", async (original) => ({
  ...(await original<typeof import("../../../lib/api")>()),
  apiFetch: async (url: string) =>
    url.endsWith("/plan")
      ? { data: [] }
      : {
          data: {
            patient: { givenNames: "Paola", displayName: "Paola Prueba", docNumber: null, patientNumber: 1021 },
            contacts: [{ relationship: "self", isActive: true, contactId: "c-paola", displayName: "Paola Prueba" }],
            isMinor: false,
          },
        },
}))
vi.mock("../../../lib/budgets", async (original) => ({
  ...(await original<typeof import("../../../lib/budgets")>()),
  decideBudgetApi: decide,
}))

const { ApiError } = await import("../../../lib/api")
const { BUDGET_CHANGED_NOTICE, BudgetResponse } = await import("./budget-response")

declareProduct(bareProduct("dental"))

beforeAll(() => {
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
afterEach(() => {
  cleanup()
  decide.mockReset()
})

const line = (id: string, optionId: string, planItemId: string, title: string, cents: number, tooth: number): BudgetLine =>
  ({
    id,
    planId: "plan",
    budgetId: "b-1",
    optionId,
    planItemId,
    serviceId: `s-${planItemId}`,
    title,
    scope: "tooth",
    toothNumber: tooth,
    surfaces: [],
    quadrant: null,
    arch: null,
    priceCents: cents,
    tariffPriceCents: cents,
    priceReason: null,
    promotionId: null,
    promotionName: null,
    promotionMode: null,
    billingMode: "treatment",
    sessionsPlanned: null,
    lineTotalCents: cents,
    tariffLineTotalCents: cents,
    lineDiscountCents: null,
    currency: "PEN",
    decision: "pendiente",
    itemStatus: "pendiente",
  }) as BudgetLine

const option = (id: string, position: number, total: number): BudgetOption => ({
  id,
  position,
  label: position === 1 ? "Opción A" : "Opción B",
  name: null,
  isRecommended: position === 1,
  decision: "pendiente",
  lineCount: 1,
  totalCents: total,
  acceptedCents: 0,
  tariffTotalCents: total,
  discountCents: null,
})

function budgetOf(withResin: boolean): BudgetWithTotals {
  const items = [
    line("l-endo", "A", "endo", "Endodoncia posterior vital", 65000, 36),
    line("l-exo", "B", "exo", "Exodoncia simple", 15000, 36),
    ...(withResin
      ? [line("l-res-a", "A", "resina", "Resina compuesta", 18000, 37), line("l-res-b", "B", "resina", "Resina compuesta", 18000, 37)]
      : []),
  ]
  return {
    id: "b-1",
    planId: "plan",
    budgetNumber: 12,
    title: "Presupuesto",
    currency: "PEN",
    status: "borrador",
    notes: null,
    acceptedByName: null,
    decisionNote: null,
    decidedAt: null,
    createdAt: "2026-11-16T15:00:00.000Z",
    items,
    options: [option("A", 1, withResin ? 83000 : 65000), option("B", 2, withResin ? 33000 : 15000)],
    totalCents: withResin ? 83000 : 65000,
    acceptedCents: 0,
    tariffTotalCents: null,
    discountCents: null,
    awaitsAnswer: true,
    stateText: "Por enviar",
  }
}

const money = Object.assign((cents: number | null) => (cents == null ? "—" : `S/ ${(cents / 100).toFixed(2)}`), {
  plain: (cents: number | null) => (cents == null ? "—" : (cents / 100).toFixed(2)),
})

function panel(client: QueryClient, budget: BudgetWithTotals) {
  return (
    <QueryClientProvider client={client}>
      <BudgetResponse
        patientId="p-paola"
        budget={budget}
        money={money}
        formatDay={(iso) => iso.slice(0, 10)}
        direct
        inPerson
        onClose={() => {}}
      />
    </QueryClientProvider>
  )
}

const save = () => fireEvent.click(screen.getByRole("button", { name: "Guardar la respuesta" }))
const ready = () => waitFor(() => expect(screen.getByText("Paola Prueba")).toBeTruthy())

it("lo común que entra con el panel abierto se responde y se suma: la opción A con la resina son S/ 830", async () => {
  decide.mockResolvedValue({ data: {} })
  const client = new QueryClient()
  const { rerender } = render(panel(client, budgetOf(false)))
  await ready()
  // La resina de la 37 entra al borrador con el panel ya abierto.
  rerender(panel(client, budgetOf(true)))
  // Tiene sus botones, como cualquier tratamiento que espera respuesta.
  await waitFor(() => expect(screen.getByRole("group", { name: "Respuesta para Resina compuesta" })).toBeTruthy())
  fireEvent.click(screen.getByRole("radio", { name: /^Opción A/ }))
  // «Acepta» suma lo común: 650 de la opción y 180 de la resina.
  await waitFor(() => expect(screen.getByText("S/ 830.00")).toBeTruthy())
  save()
  await waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
  const body = decide.mock.calls[0]![2] as { optionId: string; decisions: Array<{ planItemId: string; decision: string }> }
  expect(body.optionId).toBe("A")
  expect([...body.decisions].sort((a, b) => a.planItemId.localeCompare(b.planItemId))).toEqual([
    { planItemId: "endo", decision: "aceptado" },
    { planItemId: "resina", decision: "aceptado" },
  ])
})

it("si entra después de elegir la opción, lo dice y pide su respuesta: no viaja sin ella", async () => {
  decide.mockResolvedValue({ data: {} })
  const client = new QueryClient()
  const { rerender } = render(panel(client, budgetOf(false)))
  await ready()
  fireEvent.click(screen.getByRole("radio", { name: /^Opción A/ }))
  rerender(panel(client, budgetOf(true)))
  await waitFor(() => expect(screen.getByText(BUDGET_CHANGED_NOTICE)).toBeTruthy())
  expect(screen.getByText("Falta marcar la respuesta de 1 tratamiento.")).toBeTruthy()
  save()
  // Sin marcar la resina no sale ningún envío a medias.
  await waitFor(() => expect(screen.getByText("Marca la respuesta de este tratamiento.")).toBeTruthy())
  expect(decide).not.toHaveBeenCalled()
  const resin = screen.getByRole("group", { name: "Respuesta para Resina compuesta" })
  fireEvent.click(resin.querySelector("button")!)
  save()
  await waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
  const body = decide.mock.calls[0]![2] as { decisions: Array<{ planItemId: string; decision: string }> }
  expect(body.decisions).toHaveLength(2)
  expect(body.decisions.every((entry) => entry.decision === "aceptado")).toBe(true)
})

it("si el servidor dice que lo enviado ya no coincide, vuelve a leer el presupuesto y lo dice sin el texto del servidor", async () => {
  decide.mockRejectedValue(
    new ApiError(400, {
      code: "VALIDATION",
      message: "Debe decidir cada línea exactamente una vez",
      fields: { decisions: "Debe decidir cada línea exactamente una vez" },
    } as never),
  )
  const client = new QueryClient()
  const invalidate = vi.spyOn(client, "invalidateQueries")
  render(panel(client, budgetOf(false)))
  await ready()
  fireEvent.click(screen.getByRole("radio", { name: /^Opción A/ }))
  save()
  await waitFor(() => expect(screen.getByText(BUDGET_CHANGED_NOTICE)).toBeTruthy())
  expect(screen.queryByText("Debe decidir cada línea exactamente una vez")).toBeNull()
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["budget", "p-paola"] })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["budgets", "p-paola"] })
})
