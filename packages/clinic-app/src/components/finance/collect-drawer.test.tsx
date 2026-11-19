// @vitest-environment jsdom

/**
 * Abrir «Cobrar» y cerrarlo sin cambiar nada no pregunta «¿Salir sin guardar?» ni arma el aviso
 * del navegador (QA en local del 19 nov): lo que el cajón pone solo al abrir (lo pendiente marcado,
 * la moneda, el importe) no es un cambio de quien cobra, y tocar algo y dejarlo igual tampoco.
 */
import * as React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import { SideDockProvider, SideDockSlot } from "@odentia/ui-patterns"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { PageDraftGuard } from "../../lib/page-draft-guard"
import { setOrgLocale } from "../../lib/locale"
import { bareProduct, declareProduct } from "../../product/product-ui"

vi.mock("../../lib/crm", () => ({ usePermission: () => true, useMemberName: () => () => "Caja" }))
vi.mock("../../lib/active-branch", () => ({
  useActiveBranch: () => ({
    branches: [{ id: "b1", name: "Sede Centro" }],
    branchId: "b1",
    effectiveId: "b1",
    choose: () => undefined,
  }),
}))

const pending = {
  chargeId: "c1",
  description: "Resina",
  currency: "PEN",
  totalCents: 18000,
  paidCents: 0,
  saldoCents: 18000,
  since: "2026-11-18T15:00:00.000Z",
  budgetItemId: null,
  planItemId: null,
  encounterProcedureId: null,
  serviceId: null,
  branchId: "b1",
  promotionId: null,
  promotionName: null,
}

const answers: Record<string, unknown> = {
  "/api/patients/p1/account": {
    data: {
      patientId: "p1",
      patient: { displayName: "Rosa Quispe", docType: null, docNumber: null, sex: "F" },
      planCurrency: null,
      byCurrency: [{ currency: "PEN", saldo: 18000, aFavor: 0 }],
      pendiente: [pending],
      cobros: [],
      historico: [],
      conCargo: [],
    },
  },
  "/api/patients/p1/responsibilities": { data: [] },
  "/api/patients/p1/accepted-totals": {
    data: [
      {
        budgetId: "pr1",
        budgetNumber: 1,
        decidedAt: "2026-11-18T15:00:00.000Z",
        currency: "PEN",
        agreedCents: 90000,
        paidCents: 0,
        remainingCents: 90000,
        owingCents: 0,
        discountCents: 0,
        returnedCents: 0,
        lines: [
          {
            budgetItemId: "li1",
            planItemId: "t1",
            title: "Corona",
            siteCode: null,
            billingMode: "treatment",
            agreedCents: 90000,
            toChargeCents: 90000,
          },
        ],
      },
    ],
  },
}

vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  apiFetch: async (path: string) => {
    const route = path.split("?")[0] ?? path
    if (route in answers) return answers[route]
    if (route.includes("payment-methods")) return { data: [{ id: "m1", name: "Efectivo", typeCode: "10" }] }
    if (route === "/api/org-profile") return { data: { currency: "PEN", timezone: "America/Lima" } }
    return { data: [] }
  },
}))

const { CollectDrawer } = await import("./collect-drawer")

declareProduct(bareProduct("dental"))

beforeAll(() => {
  setOrgLocale("es-PE", "America/Lima")
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

afterEach(cleanup)

/** Finanzas en una ventana ancha: el cajón se abre en la columna del layout, con su aviso. */
function show(presetAdvanceFor?: string) {
  function Page() {
    const [open, setOpen] = React.useState(true)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Abrir cobro
        </button>
        <CollectDrawer
          patientId="p1"
          patientName="Rosa Quispe"
          branchId="b1"
          currency="PEN"
          locale="es-PE"
          presetAdvanceFor={presetAdvanceFor}
          open={open}
          onClose={() => setOpen(false)}
          onCollected={() => undefined}
        />
      </>
    )
  }
  const root = createRootRoute({
    component: () => (
      <SideDockProvider draftGuard={PageDraftGuard}>
        <Outlet />
        <SideDockSlot />
      </SideDockProvider>
    ),
  })
  const page = createRoute({ getParentRoute: () => root, path: "/finance", component: Page })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/finance"] }),
  })
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

/** Si la página pediría «¿Salir de la página?» al recargar o cerrar la pestaña. */
function asksBeforeUnload(): boolean {
  const event = new Event("beforeunload", { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

describe("el cajón de cobro sin nada escrito", () => {
  it("no arma el aviso del navegador ni pregunta al cerrarse", async () => {
    show()
    // Ya puso lo pendiente y su importe.
    await waitFor(() => expect(screen.getByLabelText("Importe")).toHaveProperty("value", "180.00"))
    expect(asksBeforeUnload()).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
    expect(screen.queryByText("¿Salir sin guardar?")).toBeNull()
    await waitFor(() => expect(screen.queryByLabelText("Importe")).toBeNull())
    expect(asksBeforeUnload()).toBe(false)
  })

  it("marcar y desmarcar lo mismo no es un cambio: cerrar no pregunta ni arma el aviso del navegador", async () => {
    show()
    await waitFor(() => expect(screen.getByLabelText("Importe")).toHaveProperty("value", "180.00"))
    const resin = screen.getAllByRole("checkbox")[0] as HTMLElement
    fireEvent.click(resin)
    fireEvent.click(resin)
    await waitFor(() => expect(screen.getByLabelText("Importe")).toHaveProperty("value", "180.00"))
    expect(asksBeforeUnload()).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
    expect(screen.queryByText("¿Salir sin guardar?")).toBeNull()
    await waitFor(() => expect(screen.queryByLabelText("Importe")).toBeNull())
  })

  it("abierto desde «Cobrar un adelanto» de un tratamiento, cerrarlo tampoco pregunta", async () => {
    show("li1")
    await screen.findByText(/Queda pagado en Corona/)
    expect(asksBeforeUnload()).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
    expect(screen.queryByText("¿Salir sin guardar?")).toBeNull()
    await waitFor(() => expect(screen.queryByLabelText("Importe")).toBeNull())
  })

  it("lo que sí cambió se sigue cuidando", async () => {
    show()
    await waitFor(() => expect(screen.getByLabelText("Importe")).toHaveProperty("value", "180.00"))
    fireEvent.change(screen.getByLabelText("Importe"), { target: { value: "100.00" } })
    await waitFor(() => expect(asksBeforeUnload()).toBe(true))
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
    await screen.findByText("¿Salir sin guardar?")
  })
})
