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
const { DictationSaid, EncounterSaidLink, speakerWords } = await import("./dictation-said")
const { withSaidHealth } = await import("./patient-health-fields")
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
    discardHealth: mutation(),
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
  // Las filas las arma el servidor (`healthRows`), con quién dijo cada dato.
  healthRows: [
    { key: "anticoagulants", group: "anticoagulants", label: "Anticoagulante", value: "apixabán", by: { declarante: "paciente" }, before: "warfarina", denied: false },
    { key: "conditions", group: "conditions", label: "Enfermedades", value: "dijo que no", by: { declarante: "paciente" }, before: null, denied: true },
  ],
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
    expect(openWide).toHaveBeenCalledWith(expect.objectContaining({ id: "antecedentes", review: true, said: { health: heard.payload } }))
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

  it("lee las filas que arma el servidor, sin volver a leer el texto de la tarjeta: el valor, lo de antes y quién lo dijo", () => {
    expect(heardHealth(heard)).toEqual({
      rows: [
        { key: "anticoagulants", group: "anticoagulants", label: "Anticoagulante", value: "apixabán", before: "warfarina", by: "el paciente", denied: false },
        { key: "conditions", group: "conditions", label: "Enfermedades", value: "dijo que no", before: null, by: "el paciente", denied: true },
      ],
      by: "el paciente",
    })
    // Un salto de línea en un nombre ya no rompe la lectura.
    const odd = heardHealth({ healthRows: [{ key: "medications", group: "medications", label: "Medicación", value: "losartán\n50 mg", by: { declarante: "no_se_sabe" }, before: null }] })
    expect(odd.rows.map((row) => row.value)).toEqual(["losartán\n50 mg"])
    expect(odd.by).toBeNull()
  })

  it("lo que dijo cada persona, con su nombre en su fila (A4)", () => {
    const both = suggestion({
      id: "salud-2",
      healthRows: [
        { key: "medications", group: "medications", label: "Medicación", value: "losartán · metformina (lo dijo su hija)", by: { declarante: "paciente" }, before: null, denied: false },
        { key: "dental.bruxismo", group: "dental", label: "Rechina o aprieta los dientes", value: "sí", by: { declarante: "acompanante", vinculo: "hija" }, before: null, denied: false },
      ],
    })
    renderNotice(sessionWith({ suggestions: [both] }))
    const grind = screen.getByRole("heading", { name: "Rechina o aprieta los dientes" }).closest("li") as HTMLElement
    expect(grind.textContent).toContain("lo dijo su hija")
    expect((screen.getByRole("heading", { name: "Medicación" }).closest("li") as HTMLElement).textContent).toContain("lo dijo Rosa")
  })

  it("un «No» no se guarda con «Lo revisé con…»: si es lo único que queda, no se ofrece; «No lo registro» lo deja de avisar (A2)", () => {
    const onlyNo = suggestion({
      id: "salud-3",
      healthRows: [{ key: "anticoagulants", group: "anticoagulants", label: "Anticoagulante", value: "dijo que no", by: { declarante: "paciente" }, before: null, denied: true }],
    })
    const session = sessionWith({ suggestions: [onlyNo] })
    renderNotice(session)
    const row = screen.getByRole("heading", { name: "Anticoagulante" }).closest("li") as HTMLElement
    expect(row.textContent).toContain("un «no»: anótalo en Antecedentes si va")
    expect(screen.queryByRole("button", { name: "Lo revisé con Rosa" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "No lo registro" }))
    expect(session.discardHealth.mutate).toHaveBeenCalledWith(onlyNo, expect.anything())
  })

  it("lo que dijo en una atención ya firmada sigue aquí con su fecha, con «Lo revisé con…» y «No lo registro» (A3)", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    route.mockResolvedValue({ data: { health } })
    render(
      <QueryClientProvider client={client}>
        <HealthReviewNotice
          patientId="p-1"
          patientName="Rosa Quispe"
          health={{
            ...health,
            allergyReviewDue: false,
            reviewStatus: { allergies: "none", conditions: "recorded", medications: "recorded" },
            said: [
              {
                suggestionId: "9a3c1c2e-5b7d-4a49-9c55-2a7a1f0e0c11",
                encounterId: "e-0",
                by: { kind: "patient", name: null, relation: null },
                at: "2026-11-20T15:00:00.000Z",
                open: false,
                rows: [{ key: "anticoagulants", group: "anticoagulants", label: "Anticoagulante", value: "apixabán", by: { declarante: "paciente" }, before: null, denied: false }],
              },
            ],
          }}
          dictation={sessionWith()}
        />
      </QueryClientProvider>,
    )
    const earlier = screen.getByRole("heading", { name: "Lo que dijo el 20 nov, sin revisar" }).closest("li") as HTMLElement
    expect(earlier.textContent).toContain("Anticoagulante: apixabán")
    fireEvent.click(within(earlier).getByRole("button", { name: "Lo revisé con Rosa" }))
    await waitFor(() =>
      expect(route).toHaveBeenCalledWith("/api/patients/p-1/health/said/9a3c1c2e-5b7d-4a49-9c55-2a7a1f0e0c11/confirm", expect.objectContaining({ method: "POST" })),
    )
    fireEvent.click(within(earlier).getByRole("button", { name: "No lo registro" }))
    await waitFor(() =>
      expect(route).toHaveBeenCalledWith("/api/patients/p-1/health/said/9a3c1c2e-5b7d-4a49-9c55-2a7a1f0e0c11/discard", expect.objectContaining({ method: "POST" })),
    )
  })
})

describe("lo de otro día que dijo después distinto (QA del 21 nov, H3)", () => {
  it("dice que hay algo más nuevo, con su fecha, y no ofrece registrarlo desde lo de antes", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <HealthReviewNotice
          patientId="p-1"
          patientName="Rosa Quispe"
          health={{
            ...health,
            allergyReviewDue: false,
            reviewStatus: { allergies: "none", conditions: "recorded", medications: "recorded" },
            said: [
              {
                suggestionId: "9a3c1c2e-5b7d-4a49-9c55-2a7a1f0e0c11",
                encounterId: "e-0",
                by: { kind: "patient", name: null, relation: null },
                at: "2026-11-20T15:00:00.000Z",
                open: false,
                rows: [
                  { key: "anticoagulants", group: "anticoagulants", label: "Anticoagulante", value: "apixabán", by: { declarante: "paciente" }, before: null, denied: false, newer: "2026-11-21T15:00:00.000Z" },
                ],
              },
            ],
          }}
          dictation={sessionWith()}
        />
      </QueryClientProvider>,
    )
    const earlier = screen.getByRole("heading", { name: "Lo que dijo el 20 nov, sin revisar" }).closest("li") as HTMLElement
    expect(earlier.textContent).toContain("después, el 21 nov, dijo algo más nuevo: vale eso")
    expect(within(earlier).queryByRole("button", { name: "Lo revisé con Rosa" })).toBeNull()
    expect(within(earlier).getByRole("button", { name: "No lo registro" })).toBeTruthy()
  })
})

describe("quién habló, sin claves internas (QA del 21 nov, C10)", () => {
  it("«Acompañante (no_se_sabe)» es «Acompañante»; un parentesco dicho sí se ve", () => {
    expect(speakerWords({ quien: "acompanante", vinculo: "no_se_sabe" }, "Dra. Ana")).toBe("Acompañante")
    expect(speakerWords({ quien: "acompanante", vinculo: "madre" }, "Dra. Ana")).toBe("Acompañante (madre)")
    expect(speakerWords({ quien: "dra" }, "Dra. Ana")).toBe("Dra. Ana")
  })

  // QA del 21 nov: el repaso anotaba a la madre de Mateo como «señora», como la llamaba la doctora.
  it("cómo se le habla («señora») no es un parentesco; sin uno dicho, es su representante registrado", () => {
    expect(speakerWords({ quien: "acompanante", vinculo: "Señora" }, "Dra. Ana")).toBe("Acompañante")
    const rows = [{ key: "conditions", group: "conditions", label: "Enfermedades", value: "asma", by: { declarante: "acompanante" as const, vinculo: "señora" }, before: null }]
    expect(heardHealth({ healthRows: rows }, "su madre (Marta Ríos)").by).toBe("su madre (Marta Ríos)")
    expect(heardHealth({ healthRows: rows }).by).not.toContain("señora")
    const mother = [{ ...rows[0]!, by: { declarante: "acompanante" as const, vinculo: "abuela" } }]
    expect(heardHealth({ healthRows: mother }, "su madre (Marta Ríos)").by).toBe("su abuela")
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

  it("firmada la atención, lo sigue avisando con el día en que lo dijo; de un dato vale lo último (A3)", () => {
    const alerts = saidHealthAlerts([
      {
        suggestionId: "salud-0",
        encounterId: "e-0",
        by: { kind: "patient", name: null, relation: null },
        at: "2026-11-18T15:00:00.000Z",
        open: false,
        rows: [{ key: "anticoagulants", label: "Anticoagulante", value: "warfarina" }],
      },
      {
        suggestionId: "salud-1",
        encounterId: "e-1",
        by: { kind: "patient", name: null, relation: null },
        at: "2026-11-20T15:00:00.000Z",
        open: false,
        rows: [{ key: "anticoagulants", label: "Anticoagulante", value: "apixabán" }],
      },
    ])
    expect(alerts.map((alert) => alert.label)).toEqual(["Anticoagulante: dijo apixabán el 20 nov, sin confirmar"])
  })

  it("lo que corrigió al decirlo y lo que dejó se dicen como son (QA del 21 nov, C2 y H3)", () => {
    const alerts = saidHealthAlerts([
      {
        suggestionId: "salud-1",
        encounterId: "e-1",
        by: { kind: "patient", name: null, relation: null },
        at: "2026-11-21T15:00:00.000Z",
        rows: [
          { key: "anticoagulants", label: "Anticoagulante", value: "apixabán", before: "warfarina" },
          { key: "boneMedicines", label: "Medicina para los huesos", value: "sí, no dijo cuál, ya no la toma" },
        ],
      },
    ])
    expect(alerts.map((alert) => [alert.label, alert.tone])).toEqual([
      ["Anticoagulante: dijo apixabán (antes dijo warfarina), sin confirmar", "warning"],
      ["Medicina para los huesos: dijo que dejó de tomarlo, sin confirmar", "secondary"],
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
    saidUsed: [],
    unsent: "",
    saidLoading: false,
    saidError: false,
    refreshSaid: vi.fn(),
    highlights: [],
    mode: "off",
    interim: "",
    base: "/api/patients/p-1/encounters/e-1/dictation",
    submitTyped: vi.fn(),
    retryUnused: vi.fn(),
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
    // Se relee la frase de su tramo: no se suma a lo que se dijo como si se hubiera dicho otra vez (C3).
    expect(session.retryUnused).toHaveBeenCalledWith("t-2", "algo de la tiroides no me acuerdo el nombre")
    expect(session.submitTyped).not.toHaveBeenCalled()
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

describe("«Corregir algo» deja puesto lo de la entrevista", () => {
  it("sus medicinas, sus enfermedades y lo de su entrevista, campo por campo, sin pisar lo que no se dijo", () => {
    const values = {
      bloodGroup: "",
      asaClass: "",
      reviewStatus: { conditions: "unknown" as const, medications: "unknown" as const },
      conditions: [],
      medications: [],
      familyHistory: [],
      interview: { antecedentesOdontologicos: { bruxismo: "no" }, antecedentesPersonales: { cirugias: "apendicitis" } },
      pregnancyWeeks: "",
    }
    const next = withSaidHealth(values, {
      health: { medications: { state: "recorded", items: [{ name: "metformina", frequency: "en el almuerzo" }] }, anticoagulants: { state: "recorded", detail: "apixabán" } },
      interview: { antecedentesOdontologicos: { ansiedadDental: "alta", problemaAnestesia: { anestesia: "si", quePaso: "desmayo" } } },
    })
    expect(next.medications.map((row) => [row.name, row.frequency, row.frequencyCode])).toEqual([
      ["metformina", "en el almuerzo", "otra"],
      ["apixabán", "", ""],
    ])
    expect(next.reviewStatus.medications).toBe("recorded")
    expect(next.interview).toEqual({
      antecedentesOdontologicos: { bruxismo: "no", ansiedadDental: "alta", problemaAnestesia: { anestesia: "si", quePaso: "desmayo" } },
      antecedentesPersonales: { cirugias: "apendicitis" },
    })
  })
})

describe("«Lo que se dijo» de una atención firmada", () => {
  it("se lee con lo resaltado del servidor, también lo confirmado; sin cambiar quién habló ni volver a intentar", async () => {
    route.mockImplementation(async (url: string) =>
      url === "/api/patients/p-1/encounters/e-9/dictation/said"
        ? {
            data: {
              segments: [
                segment({
                  transcript: "me duele con el frío. tomo apixabán. y algo de la tiroides",
                  turns: [{ quien: "paciente", texto: "me duele con el frío. tomo apixabán. y algo de la tiroides" }],
                  unused: [{ said: "y algo de la tiroides", why: "sin_lugar" }],
                }),
              ],
              used: [
                { kind: "nota", said: "me duele con el frío." },
                { kind: "salud", said: "tomo apixabán." },
              ],
            },
          }
        : { data: {} },
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <EncounterSaidLink patientId="p-1" encounterId="e-9" />
      </QueryClientProvider>,
    )
    fireEvent.click(await screen.findByRole("button", { name: "Lo que se dijo" }))
    const drawer = await screen.findByRole("dialog", { name: "Lo que se dijo" })
    expect(within(drawer).getByText("Paciente:")).toBeTruthy()
    expect(within(drawer).queryByRole("button", { name: /Cambiar quién habló/ })).toBeNull()
    expect(within(drawer).queryByRole("button", { name: /Intentar otra vez/ })).toBeNull()
    expect(within(drawer).getByRole("region", { name: "No lo usé (1)" })).toBeTruthy()
    const marks = [...within(drawer).getByRole("tabpanel").querySelectorAll("mark")].map((mark) => [mark.textContent, mark.className.includes("warning") ? "salud" : "consulta"])
    expect(marks).toEqual([
      ["me duele con el frío.", "consulta"],
      ["tomo apixabán.", "salud"],
    ])
  })

  it("si no se pudo cargar, lo dice en vez de esconderse", async () => {
    route.mockRejectedValue(new Error("sin red"))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <EncounterSaidLink patientId="p-1" encounterId="e-9" />
      </QueryClientProvider>,
    )
    expect((await screen.findByRole("alert")).textContent).toBe("No pude cargar lo que se dijo en esta atención.")
    expect(screen.getByRole("button", { name: "Intentar otra vez" })).toBeTruthy()
  })

  it("sin nada dicho no aparece", async () => {
    route.mockResolvedValue({ data: { segments: [], used: [] } })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <EncounterSaidLink patientId="p-1" encounterId="e-9" />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(route).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: "Lo que se dijo" })).toBeNull()
  })
})

describe("al firmar, lo que dijo de su salud (A3)", () => {
  it("aparece como lo que es, con un enlace al aviso; no como «Falta completarla» con un cajón vacío", async () => {
    const { DictationSignList } = await import("./dictation-sign-list")
    const onComplete = vi.fn()
    const onReviewHealth = vi.fn()
    const session = sessionWith({ suggestions: [heard], confirmMany: mutation(), confirmManyFailed: null })
    render(<DictationSignList session={session} busy={false} toggled={[]} onToggledChange={vi.fn()} onComplete={onComplete} onOpenForm={vi.fn()} onReviewHealth={onReviewHealth} />)
    const list = screen.getByRole("list", { name: /Lo que propone/ })
    expect(list.textContent).toContain("Lo que dijo de su salud, sin revisar")
    expect(list.textContent).toContain("Anticoagulante: apixabán")
    expect(list.textContent).toContain("Si firmas, sigue avisándose hasta que alguien lo revise.")
    expect(list.textContent).not.toContain("Falta completarla")
    expect(within(list).queryByRole("button", { name: "Completar" })).toBeNull()
    // No frena ni entra con la firma: no tiene casilla.
    expect(within(list).queryByRole("checkbox")).toBeNull()
    fireEvent.click(within(list).getByRole("button", { name: "Revisarlo ahora" }))
    expect(onReviewHealth).toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })
})

// QA del 22 nov (UX-6): tras elegir la prestación, cambiar quién habló o «Intentar otra vez», el foco
// caía en la página entera y quien usa el teclado volvía a recorrer desde arriba.
describe("el foco queda donde sigue", () => {
  it("elegida la prestación, va a su «Confirmar»", async () => {
    const { DictationBlockSuggestions } = await import("./dictation-suggestions")
    const choosing = suggestion({
      id: "p-1",
      kind: "plan",
      status: "por_revisar",
      summary: "Endodoncia · 46",
      payload: { service: "endodoncia", candidates: [{ id: "srv-1", name: "Endodoncia posterior vital", priceCents: 65000, currency: "PEN" }] },
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (item: Suggestion) => (
      <QueryClientProvider client={client}>
        <DictationBlockSuggestions session={sessionWith({ suggestions: [item] })} kind="plan" />
      </QueryClientProvider>
    )
    const { rerender } = render(view(choosing))
    const option = screen.getByRole("button", { name: /Endodoncia posterior vital/ })
    option.focus()
    fireEvent.click(option)
    // Guardada, la sugerencia ya no tiene que elegir: lo elegido desaparece.
    rerender(view({ ...choosing, status: "lista", payload: { service: "endodoncia", serviceId: "srv-1" } }))
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Confirmar: Endodoncia · 46"))
  })

  it("cambiado quién habló, vuelve a ese turno", async () => {
    renderSaid([
      segment({
        transcript: "buenos días rosa me duele la muela",
        turns: [
          { quien: "dra", texto: "buenos días rosa" },
          { quien: "no_se_sabe", texto: "me duele la muela" },
        ],
      }),
    ])
    fireEvent.click(screen.getByRole("button", { name: "Habló: No se sabe. Cambiar quién habló" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Paciente" }))
    await waitFor(() => expect(route).toHaveBeenCalledWith(expect.stringContaining("/turns/1"), expect.objectContaining({ method: "PATCH" })))
    await waitFor(() => expect(document.activeElement?.getAttribute("data-turn")).toBe("t-1:1"))
  })

  it("«Intentar otra vez» deja el foco en lo que pasó con la frase", async () => {
    const said = [segment({ segmentId: "t-2", transcript: "peso como ochenta kilos", unused: [{ said: "peso como ochenta kilos", why: "sin_lugar" }] })]
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const base = { said, saidUsed: [], unsent: "", saidLoading: false, saidError: false, refreshSaid: vi.fn(), highlights: [], mode: "off", interim: "", base: "/x", blocked: null, organizing: false }
    let retried: { phrase: string; where: string[] | null } | null = null
    const retryUnused = vi.fn(() => {
      retried = { phrase: "peso como ochenta kilos", where: null }
      rerender(view())
    })
    const view = () => (
      <QueryClientProvider client={client}>
        <DictationSaid session={sessionWith({ ...base, retryUnused, retried })} />
      </QueryClientProvider>
    )
    const { rerender } = render(view())
    fireEvent.click(screen.getByRole("button", { name: "Intentar otra vez: «peso como ochenta kilos»" }))
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("status"))
    // Leída otra vez y sin lugar: lo dice en el mismo sitio, que sigue con el foco.
    retried = { phrase: "peso como ochenta kilos", where: [] }
    rerender(view())
    expect(document.activeElement?.getAttribute("role")).toBe("status")
    expect(document.activeElement?.textContent).toContain("sigue sin lugar")
  })
})
