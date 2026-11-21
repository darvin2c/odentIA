// @vitest-environment jsdom

/**
 * Escribir en vez de dictar (QA del 21 nov 2026): escribiendo no había cómo terminar el dictado (el
 * botón solo salía con el micrófono) y una pausa escrita se perdía sin aviso si la barra se volvía a
 * dibujar al llegar las propuestas.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import type * as React from "react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { bareProduct, declareProduct } from "../../product/product-ui"

const route = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>())
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  apiFetch: route,
}))
vi.mock("../../lib/crm", async (original) => ({
  ...(await original<typeof import("../../lib/crm")>()),
  usePermission: () => true,
  useMyRole: () => "clinician",
}))

const { useDictationSession } = await import("./dictation-session")
const { DictationPanel } = await import("./dictation-panel")

const BASE = "/api/patients/p-1/encounters/e-1/dictation"
const segmentReply = { data: { suggestions: [], corrected: [], removed: [], sources: [], omitted: 0, unused: [], repeated: false, model: "doble" } }
const said = { segmentId: "t-1", transcript: "Me duele una muela.", saidAt: "2026-11-21T15:00:00.000Z", createdBy: "u-1", organized: true, unused: [], turns: null }

beforeAll(() => {
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
declareProduct(bareProduct("dental"))
beforeEach(() => {
  route.mockReset()
  route.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === BASE && init?.method !== "POST") return { data: { enabled: true, suggestions: [], removedByVoice: [], confirmed: 0 } }
    if (url === `${BASE}/said`) return { data: { segments: [said], used: [] } }
    if (url === `${BASE}/review`) return { data: { reviewed: true, suggestions: [], added: [], turnsSaved: [] } }
    if (url === BASE) return segmentReply
    return { data: [] }
  })
})
afterEach(cleanup)

function Bar({ shown = true }: { shown?: boolean }) {
  const session = useDictationSession({ patientId: "p-1", encounterId: "e-1", active: true, onApplied: () => {}, noteText: () => "" })
  const [typing, setTyping] = useState(true)
  return shown ? (
    <DictationPanel session={session} onStart={() => {}} onFinish={() => session.finish()} onShowTranscript={() => {}} typing={typing} onTypingChange={setTyping} />
  ) : null
}
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
const posts = () => route.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => url)

describe("escribiendo en vez de dictar", () => {
  it("«Terminar» manda lo que quedó en el cuadro y pide el repaso", async () => {
    render(
      <QueryClientProvider client={client()}>
        <Bar />
      </QueryClientProvider>,
    )
    const box = await screen.findByLabelText("Escribe lo dictado")
    fireEvent.change(box, { target: { value: "la veo la proxima semana para la otra resina" } })
    fireEvent.click(screen.getByRole("button", { name: "Terminar" }))
    await waitFor(() => expect(posts()).toEqual([BASE, `${BASE}/review`]))
    const body = JSON.parse(String(route.mock.calls.find(([url, init]) => url === BASE && init?.method === "POST")?.[1]?.body))
    expect(body.transcript).toBe("la veo la proxima semana para la otra resina")
  })

  it("lo escrito sin mandar sigue en el cuadro si la barra se vuelve a dibujar, y se dice", async () => {
    const wrapperClient = client()
    function Page() {
      const [shown, setShown] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setShown((value) => !value)}>
            mover
          </button>
          <Bar shown={shown} />
        </>
      )
    }
    // La barra vive dentro de la sesión: aquí se esconde y se vuelve a mostrar el cuadro sin perder la sesión.
    const Wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={wrapperClient}>{children}</QueryClientProvider>
    render(<Page />, { wrapper: Wrapper })
    const box = await screen.findByLabelText("Escribe lo dictado")
    fireEvent.change(box, { target: { value: "tiene asma usa salbutamol" } })
    fireEvent.click(screen.getByRole("button", { name: "mover" }))
    fireEvent.click(screen.getByRole("button", { name: "mover" }))
    expect(((await screen.findByLabelText("Escribe lo dictado")) as HTMLTextAreaElement).value).toBe("tiene asma usa salbutamol")
    expect(screen.getByText(/Esto aún no se mandó/)).toBeTruthy()
    expect(posts()).toEqual([])
  })
})
