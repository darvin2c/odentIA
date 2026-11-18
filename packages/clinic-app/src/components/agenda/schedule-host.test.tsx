// @vitest-environment jsdom

/**
 * «Reservar la sesión 2» abre en la sede de la atención anterior (mesa del 17 nov, hallazgo 3 de la
 * clínica): se abría en la sede que se miraba en la Agenda, donde la Dra. Ana no atiende. Sin una
 * sede pedida, sigue la de la Agenda.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const route = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>())
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  apiFetch: route,
}))
vi.mock("../../lib/active-branch", () => ({ useActiveBranch: () => ({ branchId: "sede-agenda" }) }))
vi.mock("../../lib/crm", () => ({ usePermission: () => true }))
// El cajón de verdad pide media agenda: aquí solo importa en qué sede se abre.
vi.mock("./booking-drawer", () => ({
  BookingDrawer: ({ branchId }: { branchId: string }) => <p>Reserva en {branchId}</p>,
}))

const { BookingHere } = await import("./schedule-host")

beforeAll(() => {
  // El cajón de espera mira el ancho de la pantalla.
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
  route.mockReset()
  route.mockImplementation(async (url) => {
    const asked = new URL(url, "https://x.test").searchParams.get("branchId")
    if (url.startsWith("/api/agenda/resources"))
      return {
        data: {
          branchId: asked,
          timeZone: "America/Lima",
          defaultDurationMin: 30,
          professionals: [],
        },
      }
    throw new Error(`sin ruta: ${url}`)
  })
})

afterEach(cleanup)

function book(seed: Parameters<typeof BookingHere>[0]["seed"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <BookingHere seed={seed} onClose={() => {}} onSaved={() => {}} />
    </QueryClientProvider>,
  )
}

describe("en qué sede se abre «Nueva cita»", () => {
  it("la sesión siguiente, en la sede que pide quien la abre", async () => {
    book({
      patient: { id: "p-1", name: "Rodrigo" },
      planItemIds: ["item-endo"],
      branchId: "sede-miraflores",
    })
    expect(await screen.findByText("Reserva en sede-miraflores")).toBeTruthy()
    expect(route).toHaveBeenCalledWith("/api/agenda/resources?branchId=sede-miraflores")
  })

  it("sin sede pedida, la que se mira en la Agenda", async () => {
    book({ patient: { id: "p-1", name: "Rodrigo" } })
    expect(await screen.findByText("Reserva en sede-agenda")).toBeTruthy()
  })
})
