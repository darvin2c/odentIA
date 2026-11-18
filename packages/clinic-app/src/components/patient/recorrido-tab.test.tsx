// @vitest-environment jsdom

/**
 * «Hacer hoy» en el recorrido (mesa del 17 nov, tablero 2). Con la atención abierta, «Iniciar
 * sesión» creaba otra y el servidor respondía 409 DRAFT_OPEN: ahora lo marca en la abierta. Ya
 * traído, es «Registrar»; la abierta de otro profesional se dice, sin un botón que falle. Al lado
 * de la atención, nada navega fuera de ella.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import type { PlanItem } from "../../lib/patients"
import { bareProduct, declareProduct } from "../../product/product-ui"

const calls = vi.hoisted(() => [] as string[])
const navigate = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({
  professional: "u-1",
  nextAction: "iniciar",
  waitsFor: null as { id: string; title: string } | null,
  openToday: true,
  openedAt: "2026-11-15T15:00:00.000Z",
  planned: [] as string[],
  sessions: [] as Array<{
    encounterId: string
    at: string
    signed: boolean
    byName: string | null
    note: string | null
  }>,
}))

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useRouter: () => ({
    buildLocation: ({
      to,
      params,
      search,
    }: {
      to: string
      params: Record<string, string>
      search?: Record<string, unknown>
    }) => {
      const path = Object.entries(params).reduce(
        (out, [key, value]) => out.replace(`$${key}`, value),
        to,
      )
      const query = search
        ? `?${new URLSearchParams(Object.entries(search).map(([k, v]) => [k, String(v)])).toString()}`
        : ""
      return { href: `${path}${query}` }
    },
  }),
}))
vi.mock("../../lib/crm", async (original) => ({
  ...(await original<typeof import("../../lib/crm")>()),
  usePermission: () => true,
  useMyUserId: () => "u-1",
  useMemberName: () => (userId: string) => (userId === "u-2" ? "Dra. Ana Torres" : "Tú"),
}))
vi.mock("../../lib/org", async (original) => ({
  ...(await original<typeof import("../../lib/org")>()),
  useOrgProfile: () => ({ data: { locale: "es-PE" } }),
}))
vi.mock("../../lib/active-branch", () => ({
  useActiveBranch: () => ({ branches: [], branchId: undefined }),
}))
vi.mock("./clinical-panels", () => ({ ControlesPanel: () => null, RecetasPanel: () => null }))
vi.mock("./collect-flow", () => ({ CollectButton: () => null }))

const item = {
  id: "it-1",
  planId: "plan-1",
  title: "Endodoncia",
  scope: "tooth",
  toothNumber: 46,
  surfaces: [],
  status: "programado",
  decisionStatus: "aceptado",
  plannedSessions: 2,
  sessionsDone: 0,
} as unknown as PlanItem

vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  apiFetch: async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${url}`)
    if (url.endsWith("/plan"))
      return { data: [{ ...item, sessions: state.sessions, waitsFor: state.waitsFor }] }
    if (url.endsWith("/summary"))
      return {
        data: {
          openEncounterId: "enc-1",
          openEncounter: {
            id: "enc-1",
            professionalUserId: state.professional,
            today: state.openToday,
            startedAt: state.openedAt,
          },
          treatmentJourneys: [{ item, nextAction: state.nextAction }],
        },
      }
    if (url.endsWith("/journey"))
      return {
        data: {
          item,
          plan: { id: "plan-1" },
          originEncounter: null,
          originFinding: null,
          replacedBy: [],
          supersedes: null,
          budgetHistory: [],
          procedures: [],
          followUps: [],
          prescriptions: [],
          documents: [],
          finance: null,
          nextAction: state.nextAction,
        },
      }
    if (url.endsWith("/encounters/enc-1"))
      return { data: { plannedItems: state.planned.map((id) => ({ ...item, id })) } }
    return { data: { reasonSet: false, diagnosisAdded: false } }
  },
}))

const { RecorridoClinicoTab } = await import("./recorrido-tab")

declareProduct({ ...bareProduct("dental"), site: { partsOf: () => [] } as never })
beforeAll(() => {
  // Los cajones del recorrido (revisar, suspender) miden la ventana aunque estén cerrados.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
})
beforeEach(() => {
  calls.length = 0
  navigate.mockReset()
  state.professional = "u-1"
  state.nextAction = "iniciar"
  state.waitsFor = null
  state.openToday = true
  state.planned = []
  state.sessions = []
})
afterEach(cleanup)

function show(inAttention?: Parameters<typeof RecorridoClinicoTab>[0]["inAttention"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RecorridoClinicoTab
        patientId="p-1"
        patientName="Teresa"
        initialItemId="it-1"
        showPhases={false}
        onChangeItem={() => undefined}
        onTabChange={() => undefined}
        inAttention={inAttention}
      />
    </QueryClientProvider>,
  )
}

it("con la atención abierta propia, «Hacer hoy» lo marca en ella y la abre: no crea otra", async () => {
  show()
  const button = await screen.findByRole("button", { name: "Hacer hoy" })
  expect(screen.getByText("Por empezar")).toBeTruthy()
  expect(
    screen.queryByRole("button", { name: /Iniciar sesión|Continuar en la atención abierta/ }),
  ).toBeNull()
  await waitFor(() => expect(calls).toContain("GET /api/patients/p-1/encounters/enc-1"))
  fireEvent.click(button)
  await waitFor(() =>
    expect(calls).toContain("POST /api/patients/p-1/encounters/enc-1/visit/treatments"),
  )
  expect(calls).not.toContain("POST /api/patients/p-1/encounters")
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      to: "/patients/$patientId/encounters/$encounterId",
      params: { patientId: "p-1", encounterId: "enc-1" },
    }),
  )
})

it("ya traído a la atención, el botón es «Registrar» y desde la ficha va a ella", async () => {
  state.planned = ["it-1"]
  show()
  fireEvent.click(await screen.findByRole("button", { name: "Registrar" }))
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual([])
  expect(navigate).toHaveBeenCalledWith({
    to: "/patients/$patientId/encounters/$encounterId",
    params: { patientId: "p-1", encounterId: "enc-1" },
  })
})

it("la atención abierta de otro profesional se dice, sin «Hacer hoy»", async () => {
  state.professional = "u-2"
  show()
  expect(await screen.findByText(/La atención abierta es de Dra\. Ana Torres/)).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Hacer hoy" })).toBeNull()
  expect(screen.getByRole("button", { name: "Abrir su atención" })).toBeTruthy()
})

it("al lado de la atención, «Registrar» y el odontograma se quedan en ella, y lo demás se abre en otra pestaña", async () => {
  state.planned = ["it-1"]
  const onRegister = vi.fn()
  const onOdontogram = vi.fn()
  const open = vi.spyOn(window, "open").mockImplementation(() => null)
  show({ encounterId: "enc-1", onRegister, onOdontogram })
  fireEvent.click(await screen.findByRole("button", { name: "Registrar" }))
  expect(onRegister).toHaveBeenCalledWith("it-1")
  fireEvent.click(screen.getByRole("button", { name: "Ver odontograma" }))
  expect(onOdontogram).toHaveBeenCalledWith(46)
  fireEvent.click(screen.getByRole("button", { name: "Ir al presupuesto" }))
  expect(open).toHaveBeenCalledWith(
    "/patients/p-1?tab=plan&itemId=it-1&planId=plan-1",
    "_blank",
    "noopener",
  )
  expect(navigate).not.toHaveBeenCalled()
  open.mockRestore()
})

// Revisión del 17 nov: el motivo escrito y aún sin guardar chocaba con el «Continúa: …» del servidor.
it("al lado de la atención, «Hacer hoy» guarda antes el borrador, avisa que escribe y no navega", async () => {
  const beforeWrite = vi.fn(async () => {
    calls.push("guardar el borrador")
  })
  const onPendingChange = vi.fn()
  const onChanged = vi.fn(async () => {})
  show({
    encounterId: "enc-1",
    onRegister: vi.fn(),
    onOdontogram: vi.fn(),
    beforeWrite,
    onPendingChange,
    onChanged,
  })
  fireEvent.click(await screen.findByRole("button", { name: "Hacer hoy" }))
  const bring = "POST /api/patients/p-1/encounters/enc-1/visit/treatments"
  await waitFor(() => expect(calls).toContain(bring))
  expect(calls.indexOf("guardar el borrador")).toBeGreaterThan(-1)
  expect(calls.indexOf("guardar el borrador")).toBeLessThan(calls.indexOf(bring))
  await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(false))
  expect(onPendingChange).toHaveBeenCalledWith(true)
  expect(onChanged).toHaveBeenCalled()
  expect(navigate).not.toHaveBeenCalled()
})

it("«4. Sesiones»: la firmada con ✓, el día, quién y su nota; la de un borrador, «en curso hoy», sin nota", async () => {
  state.sessions = [
    {
      encounterId: "enc-0",
      at: "2026-11-10T15:00:00Z",
      signed: true,
      byName: "Dra. Ana Torres",
      note: "Apertura y medicación",
    },
    {
      encounterId: "enc-1",
      at: new Date().toISOString(),
      signed: false,
      byName: "Dra. Ana Torres",
      note: null,
    },
  ]
  show()
  expect(await screen.findByText("4. Sesiones")).toBeTruthy()
  const list = screen.getByRole("list", { name: "Sesiones de Endodoncia" })
  expect(list.textContent).toMatch(
    /Firmada:Sesión 1 · \d{2}\/\d{2}\/2026 · Dra\. Ana Torres · «Apertura y medicación»/,
  )
  expect(list.textContent).toMatch(/Sesión 2 · en curso hoy/)
  expect(list.textContent).not.toMatch(/Firmada:Sesión 2/)
  expect(screen.getAllByRole("button", { name: /Abrir la atención de la sesión/ })).toHaveLength(2)
})

// QA en pantalla del 17 nov (clínica H1): al lado de la atención ofrecía «Hacer hoy» en la corona con la
// endodoncia de la misma pieza en la sesión 1 de 2, y el servidor la traía.
it("lo que va después de otro tratamiento de la pieza no ofrece «Hacer hoy»: dice tras qué va, como su fila", async () => {
  state.waitsFor = { id: "it-endo", title: "Endodoncia posterior vital" }
  show({ encounterId: "enc-1", onRegister: vi.fn(), onOdontogram: vi.fn() })
  expect(await screen.findByText("Va después de endodoncia posterior vital")).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Hacer hoy" })).toBeNull()
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual([])
})

// QA en pantalla del 17 nov (clínica H2): con la sesión 1 de 2 registrada, «Completar tratamiento» lo daba
// por terminado con un clic, sin «¿Terminaste?».
it("dentro de la atención, lo registrado hoy no se completa aquí: lo decide «¿Terminaste?» al firmar", async () => {
  state.nextAction = "completar"
  show({ encounterId: "enc-1", onRegister: vi.fn(), onOdontogram: vi.fn() })
  expect(await screen.findByText(/lo dices al firmar, en «¿Terminaste\?»/)).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Completar tratamiento" })).toBeNull()
})

// QA en pantalla del 17 nov (desarrollo 2): «Hacer hoy» desde la ficha marcaba el tratamiento en un
// borrador de otro día, y la sesión quedaba con ese día.
it("con su atención abierta de otro día, desde la ficha no hay «Hacer hoy»: dice de qué día es y la abre", async () => {
  state.openToday = false
  show()
  expect(await screen.findByText(/^Tiene una atención abierta del .*15.*: ciérrala o anúlala/)).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Hacer hoy" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Abrir esa atención" }))
  expect(navigate).toHaveBeenCalledWith({
    to: "/patients/$patientId/encounters/$encounterId",
    params: { patientId: "p-1", encounterId: "enc-1" },
  })
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual([])
})
