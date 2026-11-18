// @vitest-environment jsdom

/**
 * Las filas del Plan de la atención (revisión del 17 nov de la atención agrupada): lo registrado
 * hoy sigue en su fila aunque ya quedó realizado, y lo anulado también, tachado y con su motivo;
 * las fases van en orden y una sola vez; el precio solo si hacerlo hoy cobra algo; «Va también»
 * se cierra aunque el servidor no pueda guardarlo; «Confirmar» lo firmado por enlace; y una
 * atención de otro día dice «Ese día».
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EncounterVisit, PlanItem, ProcedureItem } from "../../lib/patients"
import { bareProduct, declareProduct } from "../../product/product-ui"

const state = vi.hoisted(() => ({
  items: [] as unknown[],
  placeFails: false,
  calls: [] as string[],
}))
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
    state.calls.push(`${init?.method ?? "GET"} ${url}`)
    if (url === "/api/patients/p-1/plans")
      return { data: [{ plan: { id: "plan-1" }, isOpen: true, active: true, status: "En curso" }] }
    if (url === "/api/patients/p-1/plan") return { data: state.items }
    if (url.endsWith("/budgets/paths") && state.placeFails)
      throw new Error("Este tratamiento no entra al presupuesto en borrador")
    return { data: null }
  },
}))

const { EncounterPlanPanel } = await import("./encounter-plan-panel")

const item = (over: Partial<PlanItem> & Pick<PlanItem, "id" | "title">): PlanItem =>
  ({
    planId: "plan-1",
    budgetId: null,
    decision: "aceptado",
    decisionStatus: "aceptado",
    decidedAt: null,
    decidedByContactId: null,
    decidedByName: null,
    decisionNote: null,
    supersedesItemId: null,
    statusReason: null,
    startedAt: null,
    completedAt: null,
    serviceId: "servicio",
    toothNumber: null,
    scope: "general",
    surfaces: [],
    quadrant: null,
    arch: null,
    detail: null,
    diagnosisCode: null,
    priceCents: 12000,
    currency: "PEN",
    status: "programado",
    sourceEncounterId: "antes",
    createdAt: "2026-11-09T16:00:00.000Z",
    ...over,
  }) as PlanItem

const procedure = (over: Partial<ProcedureItem> & Pick<ProcedureItem, "id">): ProcedureItem =>
  ({
    encounterId: "enc-1",
    serviceId: "servicio",
    toothNumber: null,
    scope: "general",
    surfaces: [],
    quadrant: null,
    arch: null,
    description: "Profilaxis",
    diagnosisCode: null,
    planItemId: null,
    priceCents: 12000,
    currency: "PEN",
    createdAt: "2026-11-17T15:00:00.000Z",
    voidedAt: null,
    voidReason: null,
    ...over,
  }) as ProcedureItem

function show(
  props: Partial<{
    indicatedItems: PlanItem[]
    procedures: ProcedureItem[]
    broughtIds: Set<string>
    visit: EncounterVisit
    chargedIds: Set<string>
    past: boolean
  }> = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <EncounterPlanPanel
        patientId="p-1"
        encounterId="enc-1"
        indicatedItems={props.indicatedItems ?? []}
        attentionItems={[]}
        patientName="Rosa Pérez"
        removableIds={new Set()}
        broughtIds={props.broughtIds}
        showControls={false}
        visit={props.visit ?? null}
        procedures={props.procedures ?? []}
        chargedIds={props.chargedIds}
        past={props.past}
        onRegister={() => undefined}
        onVoid={() => undefined}
        onConsentFirst={() => undefined}
        beforeWrite={async () => {}}
        onChanged={async () => {}}
        onPendingChange={() => undefined}
      />
    </QueryClientProvider>,
  )
}

const rowOf = async (title: string) => (await screen.findByText(title)).closest("li") as HTMLElement

beforeEach(() => {
  declareProduct(bareProduct("dental"))
  state.items = []
  state.placeFails = false
  state.calls.length = 0
})
afterEach(cleanup)

describe("lo registrado hoy en su fila", () => {
  it("lo que quedó realizado al registrarlo (el servicio de una sesión) sigue a la vista, «hecha hoy» y con «Anular…»", async () => {
    const profilaxis = item({
      id: "i-profi",
      title: "Profilaxis",
      status: "realizado",
      sourceEncounterId: "enc-1",
    })
    state.items = [profilaxis]
    show({
      indicatedItems: [profilaxis],
      broughtIds: new Set(["i-profi"]),
      procedures: [procedure({ id: "pr-1", planItemId: "i-profi" })],
    })
    const row = await rowOf("Profilaxis")
    expect(within(row).getByText("hecha hoy")).toBeTruthy()
    expect(within(row).getByRole("button", { name: "Anular…" })).toBeTruthy()
    // «Hecha hoy» ya lo dice: no «Realizado» antes de firmar.
    expect(within(row).queryByText("Realizado")).toBeNull()
  })

  it("lo anulado sigue en su fila, tachado y con su motivo", async () => {
    const resina = item({ id: "i-resina", title: "Resina", status: "pendiente" })
    state.items = [resina]
    show({
      broughtIds: new Set(["i-resina"]),
      procedures: [
        procedure({
          id: "pr-1",
          planItemId: "i-resina",
          description: "Resina",
          voidedAt: "2026-11-17T15:10:00.000Z",
          voidReason: "pieza equivocada",
        }),
      ],
    })
    const row = await rowOf("Resina")
    expect(row.textContent).toContain(
      "Anulado: pieza equivocada. No cuenta como sesión ni genera cargo.",
    )
    expect(within(row).getByText("Registrado: Resina").className).toContain("line-through")
  })

  it("en una atención de otro día dice «Ese día» y «hecha ese día»", async () => {
    const resina = item({ id: "i-resina", title: "Resina", status: "en_curso" })
    state.items = [resina]
    show({
      past: true,
      broughtIds: new Set(["i-resina"]),
      procedures: [procedure({ id: "pr-1", planItemId: "i-resina", description: "Resina" })],
    })
    const row = await rowOf("Resina")
    expect(within(row).getByText("Ese día")).toBeTruthy()
    expect(within(row).getByText("hecha ese día")).toBeTruthy()
    expect(within(row).queryByText("Hoy")).toBeNull()
  })

  it("lo que firmó en su enlace se confirma, no se prepara", async () => {
    const exo = item({ id: "i-exo", title: "Exodoncia simple", consent: "por_confirmar" })
    state.items = [exo]
    show({ broughtIds: new Set(["i-exo"]) })
    const row = await rowOf("Exodoncia simple")
    expect(within(row).getByRole("button", { name: "Confirmar" })).toBeTruthy()
    expect(within(row).queryByRole("button", { name: "Preparar" })).toBeNull()
  })
})

describe("las fases y el precio de cada fila", () => {
  it("van por fase, en el orden del producto, con la fase por defecto y sin repetir encabezados", async () => {
    declareProduct({
      ...bareProduct("dental"),
      plan: {
        ...bareProduct("dental").plan,
        phases: [
          { key: "basica", label: "Básica", hint: "" },
          { key: "rehabilitadora", label: "Rehabilitadora", hint: "" },
        ],
        defaultPhase: "basica",
      },
    })
    const corona = item({
      id: "i-corona",
      title: "Corona",
      phase: "rehabilitadora",
      sourceEncounterId: "enc-1",
      decision: "pendiente",
      decisionStatus: "pendiente",
      status: "pendiente",
    })
    state.items = [
      item({ id: "i-profi", title: "Profilaxis" }),
      item({ id: "i-resina", title: "Resina", phase: "rehabilitadora" }),
      corona,
    ]
    show({ indicatedItems: [corona] })
    await screen.findByText("Corona")
    const list = screen.getAllByRole("listitem").map((row) => row.textContent ?? "")
    const at = (text: string) => list.findIndex((row) => row.startsWith(text))
    expect(list.filter((row) => row === "Fase básica")).toHaveLength(1)
    expect(list.filter((row) => row === "Fase rehabilitadora")).toHaveLength(1)
    expect(at("Fase básica")).toBeLessThan(at("Profilaxis"))
    expect(at("Profilaxis")).toBeLessThan(at("Fase rehabilitadora"))
    expect(at("Fase rehabilitadora")).toBeLessThan(at("Corona"))
    expect(at("Fase rehabilitadora")).toBeLessThan(at("Resina"))
  })

  it("el precio sale solo si hacerlo hoy cobra algo: la sesión 2 de un cobro único ya cargado no lo dice", async () => {
    state.items = [
      item({ id: "i-endo", title: "Endodoncia", status: "en_curso", priceCents: 65000 }),
      item({ id: "i-resina", title: "Resina", priceCents: 12000 }),
    ]
    show({ chargedIds: new Set(["i-endo"]) })
    expect((await rowOf("Endodoncia")).textContent).not.toMatch(/650\.00/)
    expect((await rowOf("Resina")).textContent).toMatch(/120\.00/)
  })
})

describe("«Va también»", () => {
  it("si el servidor no puede guardarlo, la pregunta se cierra igual y se dice el error", async () => {
    state.placeFails = true
    const today = (id: string, title: string, createdAt: string) =>
      item({
        id,
        title,
        toothNumber: 46,
        scope: "tooth",
        sourceEncounterId: "enc-1",
        decision: "pendiente",
        decisionStatus: "pendiente",
        status: "pendiente",
        createdAt,
      })
    const endo = today("i-endo", "Endodoncia", "2026-11-17T15:00:00.000Z")
    const perno = today("i-perno", "Perno", "2026-11-17T15:05:00.000Z")
    state.items = [endo, perno]
    show({ indicatedItems: [endo, perno] })
    fireEvent.click(await screen.findByRole("button", { name: "Va también" }))
    await waitFor(() => expect(state.calls).toContain("POST /api/patients/p-1/budgets/paths"))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Va también" })).toBeNull())
    expect(await screen.findByRole("alert")).toBeTruthy()
  })
})
