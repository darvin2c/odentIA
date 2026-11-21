// @vitest-environment jsdom

/**
 * El repaso al terminar (mesa del 20 nov 2026, «Clío en una consulta conversada», P4): «Terminar
 * dictado» pide la lectura de toda la conversación cuando ya se ordenó lo último que se dijo, una
 * sola vez, y deja su estado para el panel. El servidor decide si hay tramos nuevos.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import type * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const route = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>())
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  apiFetch: route,
}))

const { useDictationSession } = await import("./dictation-session")

const BASE = "/api/patients/p-1/encounters/e-1/dictation"

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const segmentReply = { data: { suggestions: [], corrected: [], removed: [], sources: [], omitted: 0, unused: [], repeated: false, model: "doble" } }

beforeEach(() => {
  route.mockReset()
  route.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === BASE && init?.method !== "POST") return { data: { enabled: true, suggestions: [], removedByVoice: [], confirmed: 0 } }
    if (url === `${BASE}/review`) return { data: { reviewed: true, suggestions: [], added: ["n-1"], turnsSaved: ["s-1", "s-2"] } }
    return segmentReply
  })
})
afterEach(cleanup)

const render = () =>
  renderHook(() => useDictationSession({ patientId: "p-1", encounterId: "e-1", active: true, onApplied: () => {}, noteText: () => "" }), { wrapper })
const posts = () => route.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => url)

describe("«Terminar dictado» pide el repaso", () => {
  it("después de ordenar el último tramo, una vez, y deja cómo fue", async () => {
    const { result } = render()
    act(() => result.current.submitTyped("Me duele una muela cuando tomo algo frío."))
    act(() => result.current.finish())
    await waitFor(() => expect(result.current.review).toEqual({ status: "done", reviewed: true, added: 1, turns: 2 }))
    expect(posts()).toEqual([BASE, `${BASE}/review`])
  })

  it("sin terminar no hay repaso; si falla, lo dice y se puede pedir otra vez", async () => {
    const { result } = render()
    act(() => result.current.submitTyped("Hace dos semanas."))
    await waitFor(() => expect(posts()).toEqual([BASE]))
    expect(result.current.review).toEqual({ status: "idle" })
    route.mockImplementationOnce(async () => {
      throw new Error("sin red")
    })
    await act(() => result.current.requestReview())
    expect(result.current.review).toEqual({ status: "failed", message: "No pude repasar la conversación. Lo que ya ordené sigue igual." })
    await act(() => result.current.requestReview())
    expect(result.current.review).toMatchObject({ status: "done" })
  })
})
