// @vitest-environment jsdom

/**
 * La cita sin objeto que se libera o se usa deja la lista vacía y el componente sale sin nada
 * (QA del 16 nov, C38): antes, la salida iba antes de un hook y React rompía el diálogo después
 * de firmar con «Rendered fewer hooks than expected».
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, expect, it } from "vitest"
import { setOrgLocale } from "../../lib/locale"
import { FinalizedFreedAppointments, type FreedAppointment } from "./freed-appointments"

beforeAll(() => setOrgLocale("es-PE", "America/Lima"))
afterEach(cleanup)

const appointment: FreedAppointment = {
  id: "cita-1",
  version: 1,
  startsAt: "2026-11-24T15:00:00.000Z",
  professionalName: "Dra. Ana Torres",
  wasFor: "la sesión 2 de la endodoncia",
}

it("al quedar sin citas sobrantes no rompe el orden de los hooks", () => {
  const client = new QueryClient()
  const view = (appointments: FreedAppointment[]) => (
    <QueryClientProvider client={client}>
      <FinalizedFreedAppointments
        appointments={appointments}
        next={null}
        canBook
        onChanged={() => {}}
      />
    </QueryClientProvider>
  )
  const { rerender, container } = render(view([appointment]))
  expect(screen.getByText(/era para la sesión 2 de la endodoncia/)).toBeTruthy()
  // La última cita se liberó: la lista llega vacía y no hay nada que mostrar.
  expect(() => rerender(view([]))).not.toThrow()
  expect(container.textContent).toBe("")
})
