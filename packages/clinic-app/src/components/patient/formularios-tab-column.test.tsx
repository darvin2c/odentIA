// @vitest-environment jsdom

import { DetailDrawer, type KeptInPage, SideDockProvider, SideDockSlot, useDraftBlocker } from "@odentia/ui-patterns"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, expect, it, vi } from "vitest"
import type { FormResponse } from "../../lib/clinical-forms"
import { bareProduct, declareProduct } from "../../product/product-ui"

declareProduct(bareProduct("dental"))

const update = vi.hoisted(() => vi.fn())
vi.mock("../../lib/crm", () => ({ useMemberName: () => () => "Dra. Ana", useOrgMembers: () => [] }))
vi.mock("../../lib/clinical-forms", async (original) => ({
  ...(await original<typeof import("../../lib/clinical-forms")>()),
  updateFormResponse: update,
}))

const { ResponseDetail } = await import("./formularios-tab")

beforeAll(() => {
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
  // Ventana ancha: el formulario se abre en la columna del layout, que es la que avisa al navegar.
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

afterEach(() => {
  cleanup()
  update.mockReset()
  document.body.innerHTML = ""
})

/** El aviso de la app al salir por el menú, como `PageDraftGuard`. */
function Guard({ dirty, keptInPage }: { dirty: boolean; keptInPage?: KeptInPage | null }) {
  const blocker = useDraftBlocker({ disabled: !dirty, enableBeforeUnload: false, shouldBlockFn: () => dirty, keptInPage })
  return blocker.status === "blocked" ? <div role="alertdialog">¿Salir sin guardar?</div> : null
}

const response: FormResponse = {
  id: "r1",
  organizationId: "o1",
  templateId: "t1",
  templateVersion: 1,
  templateSnapshot: {
    sections: [{ id: "s1", title: "Dolor", fields: [{ id: "intensidad", label: "Intensidad del dolor (0–10)", type: "numero", min: 0, max: 10 }] }],
  },
  patientId: "p1",
  encounterId: null,
  professionalUserId: null,
  status: "borrador",
  answers: { intensidad: 8 },
  finalizedAt: null,
  templateTitle: "Evaluación de endodoncia",
  source: "staff",
  submittedAt: null,
  discardedAt: null,
  discardReason: null,
  createdAt: "2026-11-14T10:00:00Z",
  updatedAt: "2026-11-14T10:00:00Z",
}

// Comprobado en pantalla (14 nov): en el panel lateral, escribir un «7» que vale y salir enseguida por el
// menú preguntaba «¿Salir sin guardar?», aunque lo pendiente se guarda al cerrarse.
it("en el panel lateral, un cambio que vale y salir enseguida por el menú no pregunta, y se guarda", async () => {
  update.mockImplementation(async (_id: string, body: { answers: Record<string, unknown> }) => ({ data: { ...response, answers: body.answers, rejected: {} } }))
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={new QueryClient()}>
        <SideDockProvider draftGuard={Guard}>
          <Outlet />
          <SideDockSlot />
        </SideDockProvider>
      </QueryClientProvider>
    ),
  })
  const page = () => (
    <DetailDrawer open title="Evaluación de endodoncia" onClose={() => {}}>
      <ResponseDetail response={response} canWrite onChanged={async () => {}} />
    </DetailDrawer>
  )
  const routes = [
    createRoute({ getParentRoute: () => root, path: "/atencion", component: page }),
    createRoute({ getParentRoute: () => root, path: "/agenda", component: () => <p>Agenda</p> }),
  ]
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ["/atencion"] }) })
  render(<RouterProvider router={router} />)
  const intensity = await screen.findByLabelText(/Intensidad del dolor/)
  fireEvent.input(intensity, { target: { value: "7" } })
  void router.navigate({ href: "/agenda" })
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(screen.queryByText("¿Salir sin guardar?")).toBeNull()
  await screen.findByText("Agenda")
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1))
  expect(update.mock.calls[0]?.[1].answers.intensidad).toBe(7)
})
