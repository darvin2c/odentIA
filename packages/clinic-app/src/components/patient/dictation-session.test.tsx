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
    if (url === `${BASE}/review`) return { data: { reviewed: true, suggestions: [], added: ["n-1"], turnsSaved: ["s-1", "s-2"], turnsUnsplit: ["s-3"] } }
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
    // `unsplit`: los tramos que quedaron sin separar, para que la pantalla lo diga (QA del 22 nov, UX-1).
    await waitFor(() => expect(result.current.review).toEqual({ status: "done", reviewed: true, added: 1, turns: 2, unsplit: 1, where: [] }))
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

/*
 * Revisión del 21 nov 2026: lo que la pestaña pide de más al servidor. Un tramo ya leído sin turnos
 * pedía otro repaso para siempre (C2); «Intentar otra vez» mandaba la frase como algo dicho otra vez
 * (C3); y un tramo «en curso» en otro pedido no debe pagarse dos veces (C1).
 */
describe("lo que la pestaña no pide de más", () => {
  const saidReply = (segments: unknown[]) => ({ data: { segments, used: [] } })
  const said = (over: Record<string, unknown>) => ({ segmentId: "t-1", transcript: "Buenos días.", saidAt: "2026-11-20T15:00:00.000Z", createdBy: "u-1", organized: true, unused: [], turns: null, ...over })

  it("un tramo que el repaso ya leyó, aunque no dejó turnos, no pide otro repaso", async () => {
    route.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === BASE && init?.method !== "POST") return { data: { enabled: true, suggestions: [], removedByVoice: [], confirmed: 0 } }
      if (url === `${BASE}/said`) return saidReply([said({ reviewed: true }), said({ segmentId: "t-2", reviewed: false, turns: [{ quien: "dra", texto: "Hola." }] })])
      return segmentReply
    })
    const { result } = render()
    await waitFor(() => expect(result.current.said).toHaveLength(2))
    // El segundo tiene turnos de antes pero ningún repaso lo marcó leído: ese sí pide repaso.
    expect(result.current.unreviewed).toBe(true)
    route.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === BASE && init?.method !== "POST") return { data: { enabled: true, suggestions: [], removedByVoice: [], confirmed: 0 } }
      if (url === `${BASE}/said`) return saidReply([said({ reviewed: true }), said({ segmentId: "t-2", reviewed: true })])
      return segmentReply
    })
    await act(() => result.current.refreshSaid())
    await waitFor(() => expect(result.current.said.every((segment) => segment.reviewed)).toBe(true))
    expect(result.current.unreviewed).toBe(false)
  })

  it("«Intentar otra vez» relee la frase de su tramo sin sumarla a lo que se dijo", async () => {
    route.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === BASE && init?.method !== "POST") return { data: { enabled: true, suggestions: [], removedByVoice: [], confirmed: 0 } }
      if (url === `${BASE}/said`) return saidReply([said({ transcript: "y algo de la tiroides", unused: [{ said: "y algo de la tiroides", why: "sin_lugar" }] })])
      return segmentReply
    })
    const { result } = render()
    await waitFor(() => expect(result.current.said).toHaveLength(1))
    act(() => result.current.retryUnused("t-1", "y algo de la tiroides"))
    await waitFor(() => expect(posts()).toEqual([BASE]))
    const body = JSON.parse(String(route.mock.calls.find(([url, init]) => url === BASE && init?.method === "POST")?.[1]?.body))
    expect(body).toMatchObject({ transcript: "y algo de la tiroides", retryOf: "t-1" })
    // No es algo dicho otra vez: «Lo que se dijo» lo sigue mostrando una vez, y lo escrito no cambia.
    expect(result.current.said).toHaveLength(1)
    expect(result.current.transcript).toBe("")
    // Ya no manda el final de lo dicho: lo pone el servidor, de lo guardado.
    expect(body.context).toBeUndefined()
  })

  it("un tramo que otro pedido está ordenando se espera; no se cuenta como fallido", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let tries = 0
      route.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === BASE && init?.method !== "POST") return { data: { enabled: true, suggestions: [], removedByVoice: [], confirmed: 0 } }
        if (url === BASE) {
          tries += 1
          return tries === 1 ? { data: { ...segmentReply.data, repeated: true, inProgress: true } } : { data: { ...segmentReply.data, repeated: true } }
        }
        return segmentReply
      })
      const { result } = render()
      act(() => result.current.submitTyped("Me duele al masticar."))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3500)
      })
      await waitFor(() => expect(tries).toBe(2))
      expect(result.current.failed).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

/*
 * QA del 21 nov 2026: el cierre que se abría justo después del repaso decidía con las pendientes de
 * antes (firmaba sin la evolución que trajo el repaso), y escribiendo no había cómo terminar: la firma
 * quedaba apagada con «Termina el dictado».
 */
describe("antes de firmar", () => {
  const suggestion = { id: "n-1", kind: "nota", payload: { evolution: "Anestesia infiltrativa en la 36." }, sourceText: "", status: "lista", note: null, summary: "", voice: null, removal: null }
  const afterReview = () => {
    let reviewed = false
    route.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === BASE && init?.method !== "POST") return { data: { enabled: true, suggestions: reviewed ? [suggestion] : [], removedByVoice: [], confirmed: 0 } }
      if (url === `${BASE}/review`) {
        reviewed = true
        return { data: { reviewed: true, suggestions: [suggestion], added: [], turnsSaved: [] } }
      }
      return segmentReply
    })
  }

  it("el repaso devuelve las pendientes de ahora, con lo que dejó", async () => {
    afterReview()
    const { result } = render()
    await waitFor(() => expect(result.current.enabled).toBe(true))
    let pending: number | null = null
    await act(async () => {
      pending = await result.current.requestReview()
    })
    expect(pending).toBe(1)
  })

  it("«settle» manda lo escrito que quedaba, repasa y devuelve las pendientes, sin «Terminar dictado»", async () => {
    afterReview()
    const { result } = render()
    await waitFor(() => expect(result.current.enabled).toBe(true))
    act(() => result.current.submitTyped("Le pongo anestesia infiltrativa con lidocaína en la 36."))
    let pending: number | null = null
    await act(async () => {
      pending = await result.current.settle()
    })
    expect(posts()).toEqual([BASE, `${BASE}/review`])
    expect(pending).toBe(1)
    expect(result.current.busy).toBe(false)
  })
})
