// @vitest-environment jsdom

import { DetailPanel, type KeptInPage, MasterDetail, SideDockProvider, SideDockSlot, useDraftBlocker } from "@odentia/ui-patterns"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeAll, expect, it, vi } from "vitest"
import type { PatientHealth } from "../../lib/patients"
import { bareProduct, declareProduct } from "../../product/product-ui"

declareProduct(bareProduct("dental"))

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
  savePatientHealthApi: vi.fn(),
  reviewDeclaredHealthApi: vi.fn(),
}))
vi.mock("./allergies-card", () => ({ AllergiesCard: () => null }))

const { useBeforeOpenWide, useOpenWide, WideSectionProvider } = await import("./wide-section")

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

const said = { health: { conditions: { state: "recorded", items: [{ name: "Hipertensión" }] } } }

beforeAll(() => {
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
  // Ventana ancha (1440 px): lo que se abre al lado va en la columna del layout.
  window.matchMedia = ((query: string) => ({
    matches: !query.includes("prefers-reduced-motion"),
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
  document.body.innerHTML = ""
})

function Guard({ dirty, keptInPage }: { dirty: boolean; keptInPage?: KeptInPage | null }) {
  const blocker = useDraftBlocker({ disabled: !dirty, enableBeforeUnload: false, shouldBlockFn: () => dirty, keptInPage })
  return blocker.status === "blocked" ? <div role="alertdialog">¿Salir sin guardar?</div> : null
}

/** La atención: «Antecedentes y última atención» al lado (solo lectura) y el aviso con «Corregir algo». */
function Encounter({ beside }: { beside: boolean }) {
  const [open, setOpen] = useState(beside)
  // Lo de solo lectura que la atención pone al lado cede su lugar a lo que se abre encima.
  useBeforeOpenWide(() => setOpen(false))
  const openWide = useOpenWide()
  return (
    <MasterDetail
      panelSize="xl"
      panel={
        open ? (
          <DetailPanel title="Antecedentes y última atención" onClose={() => setOpen(false)}>
            <p>Solo lectura</p>
          </DetailPanel>
        ) : null
      }
    >
      <button type="button" onClick={() => openWide?.({ id: "antecedentes", review: true, said })}>
        Corregir algo
      </button>
    </MasterDetail>
  )
}

function app(beside: boolean, cached = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })
  // La atención y la cabecera de la ficha ya cargaron su salud: el formulario la encuentra en caché.
  if (cached) client.setQueryData(["patient-health", "p1"], { data: health })
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <SideDockProvider draftGuard={Guard}>
          <Outlet />
          <SideDockSlot />
        </SideDockProvider>
      </QueryClientProvider>
    ),
  })
  const page = () => (
    <WideSectionProvider patientId="p1" name="Rosa Quispe" closeLabel="Volver a la atención">
      <Encounter beside={beside} />
    </WideSectionProvider>
  )
  const routes = [createRoute({ getParentRoute: () => root, path: "/atencion", component: page })]
  return createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ["/atencion"] }) })
}

/** El formulario de Antecedentes quedó en la columna del layout, no en un cajón encima de todo. */
async function formInColumn() {
  const save = await screen.findByRole("button", { name: "Guardar antecedentes" })
  await screen.findByDisplayValue("Hipertensión")
  expect(save.closest("aside")).not.toBeNull()
  expect(save.closest("[role='dialog']")).toBeNull()
}

// QA del 26 nov (desarrollo, C5): a 1440 px «Corregir algo» abría un cajón modal encima de todo, no la columna.
it("a 1440 px, «Corregir algo» abre el formulario de Antecedentes en la columna", async () => {
  render(<RouterProvider router={app(false)} />)
  fireEvent.click(await screen.findByRole("button", { name: "Corregir algo" }))
  await formInColumn()
})

// QA del 26 nov (clínica, O1): con «Antecedentes y última atención» abierta al lado, «Corregir algo» no hacía nada visible.
it("con «Antecedentes y última atención» al lado, «Corregir algo» la reemplaza por el formulario", async () => {
  render(<RouterProvider router={app(true)} />)
  await screen.findByText("Solo lectura")
  fireEvent.click(screen.getByRole("button", { name: "Corregir algo" }))
  await formInColumn()
  await waitFor(() => expect(screen.queryByText("Solo lectura")).toBeNull())
})

// QA del 26 nov (desarrollo, H1): con la salud ya en caché (siempre en la atención y en la ficha), el efecto que abre
// y el que cierra corrían en el mismo render: el formulario se desmontaba antes de verse.
it("con la salud ya cargada, «Corregir algo» abre el formulario y no se cierra solo", async () => {
  render(<RouterProvider router={app(false, true)} />)
  fireEvent.click(await screen.findByRole("button", { name: "Corregir algo" }))
  await formInColumn()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(screen.getByRole("button", { name: "Guardar antecedentes" })).toBeTruthy()
})
