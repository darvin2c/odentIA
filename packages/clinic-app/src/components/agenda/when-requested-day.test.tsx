// @vitest-environment jsdom

/**
 * «Reservar la sesión 2» con quien atendió y no tiene horario en la sede (e2e
 * `reservar-sesion-desde-cierre.spec.ts`, CI del 18 nov): la reserva se queda en el día pedido y
 * dice que no atiende, sin saltar semanas buscando hueco. Saltaba ocho semanas y dejaba esas
 * semanas leídas sin su horario: con horario después, la semana mirada seguía sin él y no salía
 * «La cita queda con…, aunque no figura en Endodoncia». Con el día lleno o de ausencia, sí busca.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import type * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgendaAvailability } from "../../lib/agenda"

const route = vi.hoisted(() => vi.fn<(url: string) => Promise<unknown>>())
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  apiFetch: route,
}))

const { useWhen } = await import("./when")

const OWNER = "u-owner"
const TZ = "America/Lima"
/** Miércoles de la semana siguiente: lo que pide la sesión 2. */
const REQUESTED = "2026-11-25"

/** Disponibilidad de la semana: la dueña, con o sin horario, y en el día pedido sin nada libre. */
function availability(withHours: boolean): AgendaAvailability {
  const hours = (day: string) => ({
    professionalUserId: OWNER,
    startsAt: `${day}T14:00:00.000Z`,
    endsAt: `${day}T22:00:00.000Z`,
  })
  const days = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"]
  return {
    branchId: "b-1",
    timeZone: TZ,
    professionals: withHours ? [{ id: OWNER, label: "Dra. Ana", nextFree: null }] : [],
    defaultDurationMin: 30,
    open: withHours ? days.map(hours) : [],
    // Lleno el día pedido; libre el jueves.
    free: withHours ? [hours("2026-11-26")] : [],
    blocks: [],
    attending: null,
  }
}

function render(withHours: boolean) {
  route.mockImplementation(async () => ({ data: availability(withHours) }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(
    () =>
      useWhen({
        branchId: "b-1",
        timeZone: TZ,
        today: "2026-11-18",
        now: "2026-11-18T15:00:00.000Z",
        toneOf: () => "primary" as never,
        duration: 30,
        date: REQUESTED,
        professionalUserId: OWNER,
        professionalLabel: "Dra. Ana",
        serviceId: "s-endo",
        keepProfessional: true,
      }),
    { wrapper },
  )
}

describe("el día pedido de la sesión siguiente", () => {
  beforeEach(() => route.mockReset())
  afterEach(cleanup)

  it("sin horario en la sede, se queda en el día pedido y no lee otras semanas", async () => {
    const { result } = render(false)
    await waitFor(() => expect(result.current.ready).toBe(true))
    // Da tiempo a que un salto de semana, si lo hubiera, pidiera la siguiente.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current.date).toBe(REQUESTED)
    expect(result.current.offDuty).toBe("Dra. Ana")
    expect(route).toHaveBeenCalledTimes(1)
  })

  it("con el día pedido lleno, va al primer día con hueco de esa semana", async () => {
    const { result } = render(true)
    await waitFor(() => expect(result.current.date).toBe("2026-11-26"))
    expect(result.current.shown?.columnId).toBe(OWNER)
  })
})
