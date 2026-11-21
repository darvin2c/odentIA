// @vitest-environment jsdom

/**
 * Clío en una consulta conversada (mesa del 20 nov 2026, P5): lo que oyó de su salud se revisa en el
 * aviso «Pregúntale a…», cada dato en la fila de su tema; un «No» se confirma en su fila; «Lo que se
 * dijo» viene del servidor (sigue igual al recargar) con sus dos vistas y «No lo usé».
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type * as React from "react"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setOrgLocale } from "../../lib/locale"
import type { PatientHealth } from "../../lib/patients"
import { bareProduct, declareProduct } from "../../product/product-ui"

const route = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>())
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  apiFetch: route,
}))
vi.mock("../../lib/crm", async (original) => ({
  ...(await original<typeof import("../../lib/crm")>()),
  usePermission: () => true,
  useMemberName: () => () => "Ana Torres Ruiz",
  useMyRole: () => "clinician",
}))
const openWide = vi.hoisted(() => vi.fn())
vi.mock("./wide-section", () => ({ useOpenWide: () => openWide }))

const { HealthReviewNotice, heardHealth } = await import("./health-review-notice")
const { DictationSaid } = await import("./dictation-said")
const { saidHealthAlerts } = await import("./patient-header")
const { confirmable } = await import("./dictation-session")
type Session = import("./dictation-session").DictationSession
type Suggestion = import("./dictation-session").DictationSuggestion
type Segment = import("./dictation-session").DictationSaidSegment

beforeAll(() => {
  setOrgLocale("es-PE", "America/Lima")
  // jsdom no trae `matchMedia`: el cajón de la alergia pregunta el ancho.
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
afterAll(() => setOrgLocale(undefined, undefined))
declareProduct(bareProduct("dental"))

beforeEach(() => {
  route.mockReset()
  route.mockResolvedValue({ data: {} })
  openWide.mockReset()
})
afterEach(cleanup)

const mutation = () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, variables: undefined, reset: vi.fn() })

function sessionWith(over: Partial<Record<keyof Session, unknown>> = {}): Session {
  return {
    enabled: true,
    suggestions: [],
    removedByVoice: [],
    undoRequests: [],
    dictating: false,
    act: mutation(),
    save: mutation(),
    confirmReady: mutation(),
    confirmHealth: mutation(),
    settleHealthGroups: mutation(),
    noteAddsTo: () => "",
    openEdit: vi.fn(),
    ...over,
  } as unknown as Session
}

const suggestion = (over: Partial<Suggestion>): Suggestion => ({
  id: "s-1",
  kind: "salud",
  payload: {},
  sourceText: "",
  status: "lista",
  note: null,
  summary: "",
  voice: null,
  removal: null,
  ...over,
})

/** C2 de la mesa: «Tomo warfarina… perdón, apixabán», y «no, no tengo ninguna enfermedad». */
const heard = suggestion({
  id: "salud-1",
  payload: { declarante: "paciente", anticoagulants: { state: "recorded", detail: "apixabán" }, conditions: { state: "none", items: [] } },
  sourceText: "tomo warfarina perdón apixabán",
  summary: "Anticoagulante: apixabán (antes dijo «warfarina»)\nEnfermedades: dijo que no\nLo dijo: el paciente",
})

const health: PatientHealth = {
  revision: 3,
  reviewStatus: { allergies: "unknown", conditions: "unknown", medications: "unknown" },
  allergies: [],
  conditions: [],
  medications: [],
  bloodGroup: null,
  reviewedAt: null,
  reviewedBy: null,
  allergyReviewDue: true,
  latestAnamnesis: null,
}

function renderNotice(session: Session) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <HealthReviewNotice patientId="p-1" patientName="Rosa Quispe" health={health} dictation={session} />
    </QueryClientProvider>,
  )
}

describe("«Pregúntale a…» con lo que Clío oyó de su salud", () => {
  it("cada dato en la fila de su tema, con quién lo dijo, «antes dijo» y «dijo, sin confirmar»; «Lo revisé con Rosa» lo confirma", () => {
    const session = sessionWith({ suggestions: [heard] })
    renderNotice(session)
    const notice = screen.getByRole("region", { name: "Revisa con Rosa lo que dijo de su salud" })
    // El anticoagulante no tiene fila de «no se preguntó»: sale con su nombre, lo de antes y sin confirmar.
    const anticoagulant = within(notice).getByRole("heading", { name: "Anticoagulante" }).closest("li") as HTMLElement
    expect(anticoagulant.textContent).toContain("Apixabán")
    expect(anticoagulant.textContent).toContain("lo dijo Rosa · antes dijo «warfarina»")
    expect(anticoagulant.textContent).toContain("dijo, sin confirmar")
    // La medicación que nadie preguntó sigue preguntándose: no se inventa un «No».
    expect((within(notice).getByRole("heading", { name: "Medicación" }).closest("li") as HTMLElement).textContent).toContain("Aún no se le preguntó")
    fireEvent.click(within(notice).getByRole("button", { name: "Lo revisé con Rosa" }))
    expect(session.confirmHealth.mutate).toHaveBeenCalledWith(heard, expect.anything())
    // Lo de su salud nunca entra con «Confirmar las N de la consulta».
    expect(confirmable(heard)).toBe(false)
  })

  it("un «No» dicho se confirma en su fila, con el botón de siempre, y deja de proponerse", async () => {
    const session = sessionWith({ suggestions: [heard] })
    route.mockResolvedValue({ data: health })
    renderNotice(session)
    const conditions = screen.getByRole("heading", { name: "Enfermedades" }).closest("li") as HTMLElement
    expect(conditions.textContent).toContain("Dijo que no")
    fireEvent.click(within(conditions).getByRole("button", { name: "Niega enfermedades" }))
    await waitFor(() => expect(route).toHaveBeenCalledWith("/api/patients/p-1/health/denied", expect.objectContaining({ method: "POST" })))
    await waitFor(() => expect(session.settleHealthGroups.mutate).toHaveBeenCalledWith({ item: heard, groups: ["conditions"] }))
    expect(session.confirmHealth.mutate).not.toHaveBeenCalled()
  })

  it("«Corregir algo» abre sus antecedentes con lo de Clío puesto", () => {
    const session = sessionWith({ suggestions: [heard] })
    renderNotice(session)
    fireEvent.click(screen.getByRole("button", { name: "Corregir algo" }))
    expect(openWide).toHaveBeenCalledWith(expect.objectContaining({ id: "antecedentes", review: true, said: heard.payload }))
  })

  it("la alergia dictada y su «No tiene alergias» se ven dentro del aviso, en la fila «Alergias», no sueltas", () => {
    const none = suggestion({ id: "a-1", kind: "alergia", payload: { none: true }, sourceText: "no tengo alergias", summary: "No tiene alergias" })
    renderNotice(sessionWith({ suggestions: [none] }))
    const notice = screen.getByRole("region", { name: "Revisa con Rosa lo que dijo de su salud" })
    const allergies = within(notice).getByRole("heading", { name: "Alergias" }).closest("li") as HTMLElement
    expect(within(allergies).getByRole("list", { name: /Sugerencias de .*: Alergias/ }).textContent).toContain("No tiene alergias")
    // Su «No» se confirma en su fila, de a uno.
    expect(within(allergies).getByRole("button", { name: "Confirmar: No tiene alergias" })).toBeTruthy()
    expect(confirmable(none)).toBe(false)
  })

  it("lee la tarjeta del servidor tal cual: el valor, lo de antes y quién lo dijo", () => {
    expect(heardHealth(heard)).toEqual({
      rows: [
        { group: "anticoagulants", label: "Anticoagulante", value: "apixabán", before: "warfarina" },
        { group: "conditions", label: "Enfermedades", value: "dijo que no", before: null },
      ],
      by: "el paciente",
    })
    expect(heardHealth({ summary: "Alergias: no sabe\nNo se sabe quién lo dijo" }).by).toBeNull()
  })
})

describe("la franja avisa lo dicho sin confirmar", () => {
  it("«Anticoagulante: dijo apixabán, sin confirmar»; su «No» y su «No sé» sin alarma; lo de su boca no va", () => {
    const alerts = saidHealthAlerts([
      {
        suggestionId: "salud-1",
        encounterId: "e-1",
        by: { kind: "patient", name: null, relation: null },
        at: "2026-11-20T15:00:00.000Z",
        rows: [
          { key: "anticoagulants", label: "Anticoagulante", value: "apixabán" },
          { key: "allergies", label: "Alergias", value: "no sabe" },
          { key: "dental.ansiedadDental", label: "Miedo al dentista", value: "alta" },
        ],
      },
    ])
    expect(alerts.map((alert) => [alert.label, alert.tone])).toEqual([
      ["Anticoagulante: dijo apixabán, sin confirmar", "warning"],
      ["Alergias: no sabe, sin confirmar", "secondary"],
    ])
  })
})

const segment = (over: Partial<Segment>): Segment => ({
  segmentId: "t-1",
  transcript: "",
  saidAt: "2026-11-20T15:38:00.000Z",
  createdBy: "u-ana",
  organized: true,
  unused: [],
  turns: null,
  ...over,
})

function renderSaid(segments: Segment[], over: Partial<Record<keyof Session, unknown>> = {}) {
  const session = sessionWith({
    said: segments,
    unsent: "",
    saidLoading: false,
    saidError: false,
    refreshSaid: vi.fn(),
    highlights: [],
    mode: "off",
    interim: "",
    base: "/api/patients/p-1/encounters/e-1/dictation",
    submitTyped: vi.fn(),
    blocked: null,
    organizing: false,
    ...over,
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <DictationSaid session={session} />
    </QueryClientProvider>,
  )
  return session
}

describe("«Lo que se dijo», del servidor", () => {
  const before = [
    segment({ segmentId: "t-1", transcript: "buenos días rosa qué te trae me duele la muela con el frío" }),
    segment({
      segmentId: "t-2",
      saidAt: "2026-11-20T15:41:00.000Z",
      transcript: "y algo de la tiroides no me acuerdo el nombre",
      unused: [{ said: "algo de la tiroides no me acuerdo el nombre", why: "sin_lugar" }],
    }),
  ]

  it("tras recargar trae cada pausa con su hora y «No lo usé» con su motivo; «Conversación» espera al repaso", () => {
    const session = renderSaid(before)
    expect(screen.getByRole("tablist", { name: "Cómo ver lo que se dijo" })).toBeTruthy()
    const talk = screen.getByRole("tab", { name: "Conversación" })
    expect(talk.getAttribute("aria-disabled") === "true" || talk.hasAttribute("disabled")).toBe(true)
    expect(screen.getByText("«Conversación» se arma al terminar de dictar.")).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Tal cual se oyó" }).getAttribute("aria-selected")).toBe("true")
    const panel = screen.getByRole("tabpanel")
    expect(panel.textContent).toContain("Pausa 1 · 10:38")
    expect(panel.textContent).toContain("Pausa 2 · 10:41")
    const unused = screen.getByRole("region", { name: "No lo usé (1)" })
    expect(unused.textContent).toContain("«algo de la tiroides no me acuerdo el nombre»")
    expect(unused.textContent).toContain("no supe dónde va")
    fireEvent.click(within(unused).getByRole("button", { name: "Intentar otra vez: «algo de la tiroides no me acuerdo el nombre»" }))
    expect(session.submitTyped).toHaveBeenCalledWith("algo de la tiroides no me acuerdo el nombre")
    // Parece de su salud: se lleva a sus antecedentes.
    fireEvent.click(within(unused).getByRole("button", { name: "Llevar a su salud: «algo de la tiroides no me acuerdo el nombre»" }))
    expect(openWide).toHaveBeenCalledWith({ id: "antecedentes", review: true })
  })

  it("lo que una pausa siguiente sí usó ya no se lista", () => {
    renderSaid([...before, segment({ segmentId: "t-3", saidAt: "2026-11-20T15:45:00.000Z", transcript: "dije algo de la tiroides no me acuerdo el nombre, levotiroxina" })])
    expect(screen.queryByRole("region", { name: /No lo usé/ })).toBeNull()
  })

  it("tras el repaso, «Conversación» muestra quién habló; tocar el nombre lo cambia", async () => {
    const session = renderSaid([
      segment({
        transcript: "buenos días rosa qué te trae me duele la muela con el frío",
        turns: [
          { quien: "dra", texto: "buenos días rosa qué te trae" },
          { quien: "no_se_sabe", texto: "me duele la muela con el frío" },
        ],
      }),
    ])
    expect(screen.getByRole("tab", { name: "Conversación" }).getAttribute("aria-selected")).toBe("true")
    expect(screen.queryByText("«Conversación» se arma al terminar de dictar.")).toBeNull()
    expect(screen.getByRole("button", { name: "Habló: Ana Torres. Cambiar quién habló" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Habló: No se sabe. Cambiar quién habló" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Paciente" }))
    await waitFor(() =>
      expect(route).toHaveBeenCalledWith("/api/patients/p-1/encounters/e-1/dictation/said/t-1/turns/1", { method: "PATCH", body: JSON.stringify({ quien: "paciente" }) }),
    )
    await waitFor(() => expect(session.refreshSaid).toHaveBeenCalled())
  })

  it("resalta lo que está en una propuesta: la consulta en azul, su salud en ámbar; la charla no", () => {
    renderSaid([segment({ transcript: "buenos días rosa. me duele con el frío. tomo apixabán." })], {
      suggestions: [
        suggestion({ id: "n-1", kind: "nota", sourceText: "me duele con el frío." }),
        suggestion({ id: "s-1", kind: "salud", sourceText: "tomo apixabán." }),
      ],
    })
    const marks = [...screen.getByRole("tabpanel").querySelectorAll("mark")].map((mark) => [mark.textContent, mark.className.includes("warning") ? "salud" : "consulta"])
    expect(marks).toEqual([
      ["me duele con el frío.", "consulta"],
      ["tomo apixabán.", "salud"],
    ])
  })
})
