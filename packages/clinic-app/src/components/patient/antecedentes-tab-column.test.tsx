// @vitest-environment jsdom

import { DetailDrawer, type KeptInPage, SideDockProvider, SideDockSlot, useDraftBlocker } from "@odentia/ui-patterns"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, expect, it, vi } from "vitest"
import type { PatientHealth } from "../../lib/patients"
import { bareProduct, declareProduct } from "../../product/product-ui"

declareProduct(bareProduct("dental"))

const save = vi.hoisted(() => vi.fn())
vi.mock("../../lib/crm", () => ({
  useMemberName: () => () => "Dra. Ana",
  usePermission: () => true,
  useOrgMembers: () => [],
  useMyUserId: () => "u-ana",
}))
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  apiFetch: async () => ({ data: { patient: { id: "p1", displayName: "Rosa Quispe", sex: "F", birthDate: "1980-05-02" }, registration: null } }),
}))
vi.mock("../../lib/patients", async (original) => ({
  ...(await original<typeof import("../../lib/patients")>()),
  fetchPatientHealth: async () => ({ data: health }),
  fetchAnamnesisHistory: async () => ({ data: [] }),
  savePatientHealthApi: save,
  reviewDeclaredHealthApi: vi.fn(),
}))
// Las alergias tienen su propia tarjeta y sus datos: aquí no cuentan.
vi.mock("./allergies-card", () => ({ AllergiesCard: () => null }))

const { AntecedentesTab } = await import("./antecedentes-tab")

const health = {
  revision: 3,
  reviewStatus: { allergies: "none", conditions: "none", medications: "none" },
  allergies: [],
  conditions: [],
  medications: [],
  bloodGroup: null,
  reviewedAt: "2026-11-20T10:00:00.000Z",
  reviewedBy: "u-ana",
  latestAnamnesis: null,
  reviewPending: false,
  declared: [],
} as unknown as PatientHealth

/** Lo que Clío oyó en la consulta: «Corregir algo» abre Antecedentes con eso puesto. */
const said = { health: { conditions: { state: "recorded", items: [{ name: "Hipertensión" }] } } }

beforeAll(() => {
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
  // Ventana ancha: el panel de Antecedentes se abre en la columna del layout, que es la que avisa al navegar.
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
  save.mockReset()
  document.body.innerHTML = ""
})

/** El aviso de la app al salir por el menú, como `PageDraftGuard`. */
function Guard({ dirty, keptInPage }: { dirty: boolean; keptInPage?: KeptInPage | null }) {
  const blocker = useDraftBlocker({ disabled: !dirty, enableBeforeUnload: false, shouldBlockFn: () => dirty, keptInPage })
  return blocker.status === "blocked" ? <div role="alertdialog">¿Salir sin guardar?</div> : null
}

/** La atención con Antecedentes encima, abierta con «Corregir algo», y la ficha del paciente aparte. */
function app() {
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SideDockProvider draftGuard={Guard}>
          <Outlet />
          <SideDockSlot />
        </SideDockProvider>
      </QueryClientProvider>
    ),
  })
  const page = () => (
    <DetailDrawer open size="xl" title="Antecedentes de Rosa Quispe" onClose={() => {}} closeLabel="Volver a la atención">
      <AntecedentesTab patientId="p1" startEditing said={said} />
    </DetailDrawer>
  )
  const routes = [
    createRoute({ getParentRoute: () => root, path: "/atencion", component: page }),
    createRoute({ getParentRoute: () => root, path: "/paciente", component: () => <p>Ficha del paciente</p> }),
  ]
  return createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ["/atencion"] }) })
}

/** El cajón del formulario, con lo que oyó Clío ya puesto; se escribe algo más en él. */
async function writeInDrawer() {
  const name = (await screen.findByDisplayValue("Hipertensión")) as HTMLInputElement
  fireEvent.input(name, { target: { value: "Hipertensión arterial" } })
  await waitFor(() => expect(name.value).toBe("Hipertensión arterial"))
}

// QA local del 26 nov (3 veces): con «Corregir algo», guardar y salir por el enlace del paciente preguntaba
// «¿Salir sin guardar?» aunque ya estaba guardado. La columna contaba lo escrito en el cajón de encima y no
// veía que ese cajón se guardó.
it("en el panel de la atención, lo escrito en Antecedentes y guardado no pregunta al salir", async () => {
  save.mockResolvedValue({ data: health })
  const router = app()
  render(<RouterProvider router={router} />)
  await writeInDrawer()
  fireEvent.click(screen.getByRole("button", { name: "Guardar antecedentes" }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.queryByDisplayValue("Hipertensión arterial")).toBeNull())

  void router.navigate({ href: "/paciente" })
  await screen.findByText("Ficha del paciente")
  expect(screen.queryByText("¿Salir sin guardar?")).toBeNull()
})

it("lo escrito en Antecedentes sin guardar sí pregunta al salir", async () => {
  const router = app()
  render(<RouterProvider router={router} />)
  await writeInDrawer()

  void router.navigate({ href: "/paciente" })
  await screen.findByText("¿Salir sin guardar?")
  expect(router.state.location.pathname).toBe("/atencion")
  expect(save).not.toHaveBeenCalled()
})
