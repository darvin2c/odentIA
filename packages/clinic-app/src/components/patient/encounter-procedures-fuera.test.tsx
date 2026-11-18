// @vitest-environment jsdom

/**
 * «Hecho hoy fuera del plan» y «Registrar algo fuera del plan» (revisión del 17 nov de la atención
 * agrupada). El botón venía con un tratamiento del plan puesto: quien quería anotar un acto libre
 * registraba la sesión del tratamiento sin mirar el selector. Y lo de un tratamiento que el Plan
 * ya no muestra (el servicio directo anulado queda cancelado) no se veía en ninguna parte.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import type { EncounterDetail, PlanItem, ProcedureItem } from "../../lib/patients"
import { bareProduct, declareProduct } from "../../product/product-ui"

const state = vi.hoisted(() => ({ items: [] as unknown[], calls: [] as string[], conflict: false }))
vi.mock("../../lib/crm", async (original) => ({
  ...(await original<typeof import("../../lib/crm")>()),
  usePermission: () => true,
}))
vi.mock("../../lib/org", async (original) => ({
  ...(await original<typeof import("../../lib/org")>()),
  useOrgProfile: () => ({ data: { locale: "es-PE" } }),
}))
vi.mock("../../lib/api", async (original) => {
  const api = await original<typeof import("../../lib/api")>()
  return {
    ...api,
    apiFetch: async (url: string, init?: { method?: string }) => {
      state.calls.push(`${init?.method ?? "GET"} ${url}`)
      if (init?.method === "POST" && url.endsWith("/procedures") && state.conflict)
        throw new api.ApiError(409, {
          code: "SESSION_REGISTERED",
          message: "Ya registraste este tratamiento en la atención de hoy",
        })
      return answer(url)
    },
  }
})
const answer = (url: string) => {
  if (url === "/api/patients/p-1/plans")
    return { data: [{ plan: { id: "plan-1" }, isOpen: true, active: true, status: "En curso" }] }
  if (url === "/api/patients/p-1/plan") return { data: state.items }
  return { data: [] }
}

const { EncounterProcedures } = await import("./encounter-procedures")

declareProduct(bareProduct("dental"))
beforeAll(() => {
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
  Element.prototype.scrollIntoView ??= () => {}
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver
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
beforeEach(() => {
  state.items = []
  state.calls = []
  state.conflict = false
})
afterEach(cleanup)

const endodoncia = {
  id: "i-endo",
  planId: "plan-1",
  title: "Endodoncia",
  scope: "general",
  toothNumber: null,
  surfaces: [],
  quadrant: null,
  arch: null,
  status: "programado",
  decision: "aceptado",
  decisionStatus: "aceptado",
  priceCents: 65000,
  currency: "PEN",
  sourceEncounterId: "enc-1",
  createdAt: "2026-11-17T15:00:00.000Z",
} as unknown as PlanItem

function show(
  procedures: ProcedureItem[] = [],
  plannedItems: PlanItem[] = [],
  more: {
    visit?: EncounterDetail["visit"]
    prefill?: string
    onChanged?: () => Promise<void>
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const detail = {
    encounter: { id: "enc-1", status: "borrador" },
    procedures,
    plannedItems,
    indicatedItems: [],
    diagnoses: [],
    visit: more.visit ?? null,
  } as unknown as EncounterDetail
  return render(
    <QueryClientProvider client={client}>
      <EncounterProcedures
        patientId="p-1"
        detail={detail}
        beforeWrite={async () => {}}
        onChanged={more.onChanged ?? (async () => {})}
        onPendingChange={() => undefined}
        prefillPlanItemId={more.prefill ?? null}
      />
    </QueryClientProvider>,
  )
}

it("«Registrar algo fuera del plan» abre en el catálogo, sin el tratamiento del plan puesto", async () => {
  // Con un solo tratamiento por hacer hoy, antes venía elegido.
  state.items = [endodoncia]
  show([], [endodoncia])
  const open = await screen.findByRole("button", { name: "Registrar algo fuera del plan" })
  // Que el plan ya esté leído: con él, antes se elegía la endodoncia.
  await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false))
  await new Promise((resolve) => setTimeout(resolve, 50))
  fireEvent.click(open)
  const choice = await screen.findByRole("combobox", { name: "Tratamiento del presupuesto" })
  await waitFor(() => expect(choice.textContent).toContain("Otro servicio del catálogo"))
  expect(choice.textContent).not.toContain("Endodoncia")
  expect(
    screen.queryByText("Viene puesto lo que sigue hoy; si hiciste otra cosa, cámbialo."),
  ).toBeNull()
})

it("lo de un tratamiento que el Plan ya no muestra queda en «Hecho hoy fuera del plan»; lo de su fila, no", async () => {
  const direct = {
    ...endodoncia,
    id: "i-directo",
    title: "Exodoncia simple",
    status: "cancelado",
  } as PlanItem
  const done = {
    ...endodoncia,
    id: "i-hecho",
    title: "Profilaxis",
    status: "realizado",
  } as PlanItem
  state.items = [direct, done]
  const base = {
    encounterId: "enc-1",
    serviceId: "servicio",
    toothNumber: null,
    scope: "general",
    surfaces: [],
    quadrant: null,
    arch: null,
    diagnosisCode: null,
    priceCents: 8000,
    currency: "PEN",
    createdAt: "2026-11-17T15:00:00.000Z",
  }
  show([
    {
      ...base,
      id: "pr-directo",
      description: "Exodoncia simple",
      planItemId: "i-directo",
      voidedAt: "2026-11-17T15:10:00.000Z",
      voidReason: "pieza equivocada",
    },
    { ...base, id: "pr-hecho", description: "Profilaxis", planItemId: "i-hecho", voidedAt: null },
  ] as ProcedureItem[])
  const section = await screen.findByRole("region", { name: "Hecho hoy fuera del plan" })
  await waitFor(() => expect(section.textContent).toContain("Exodoncia simple"))
  expect(section.textContent).toContain("Anulado: pieza equivocada.")
  // La profilaxis realizada hoy está en su fila del Plan, con su «Anular…».
  expect(section.textContent).not.toContain("Profilaxis")
})

// QA en pantalla del 17 nov (clínica H3, UX D5): el cajón decía «Endodoncia · pieza 36 · Pendiente» de lo
// marcado «Hoy»; y la segunda pestaña, tras el 409, seguía en «por hacer» hasta recargar.
const endoHoy = {
  ...endodoncia,
  status: "en_curso",
} as PlanItem
const visitHoy = {
  treatments: [
    {
      planItemId: "i-endo",
      title: "Endodoncia",
      toothNumber: null,
      n: 2,
      m: 2,
      started: true,
      linked: true,
      registered: false,
      broughtByAppointment: false,
      after: null,
      wait: null,
    },
  ],
  controls: [],
} as unknown as EncounterDetail["visit"]

it("«Registrar» de lo marcado «Hoy» dice su sesión, «Sesión 2 de 2», y no «Pendiente» ni «En curso»", async () => {
  state.items = [endoHoy]
  show([], [endoHoy], { visit: visitHoy, prefill: "i-endo" })
  const choice = await screen.findByRole("combobox", { name: "Tratamiento del presupuesto" })
  await waitFor(() => expect(choice.textContent).toContain("Endodoncia · general · Sesión 2 de 2"))
  expect(choice.textContent).not.toMatch(/Pendiente|En curso/)
})

it("si otra pestaña ya lo registró (409), esta vuelve a leer la atención y su plan, y dice el error", async () => {
  state.items = [endoHoy]
  state.conflict = true
  const onChanged = vi.fn(async () => {})
  show([], [endoHoy], { visit: visitHoy, prefill: "i-endo", onChanged })
  await screen.findByRole("combobox", { name: "Tratamiento del presupuesto" })
  const before = state.calls.filter((call) => call === "GET /api/patients/p-1/plan").length
  fireEvent.click(await screen.findByRole("button", { name: "Registrar procedimiento" }))
  await waitFor(() => expect(onChanged).toHaveBeenCalled())
  await waitFor(() =>
    expect(state.calls.filter((call) => call === "GET /api/patients/p-1/plan").length).toBeGreaterThan(before),
  )
  expect(await screen.findByText(/Ya registraste este tratamiento/)).toBeTruthy()
})
