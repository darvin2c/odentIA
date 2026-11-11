import { describe, expect, it } from "vitest"
import { isUnclosed, stepBeforeArrival, visitName } from "./agenda"

/** La cita pasada (mesa de Inicio y Agenda del 10 nov): un nombre y el paso según sea hoy u otro día. */
describe("la cita que pasó sin cerrarse", () => {
  const now = "2026-11-10T20:00:00.000Z"
  const ended = { startsAt: "2026-11-10T15:00:00.000Z", endsAt: "2026-11-10T15:30:00.000Z" }
  const soon = { startsAt: "2026-11-10T20:30:00.000Z", endsAt: "2026-11-10T21:00:00.000Z" }

  it("se llama «Sin cerrar» en toda la aplicación", () => {
    expect(visitName("sin_cerrar")).toBe("Sin cerrar")
    expect(isUnclosed({ visit: "sin_cerrar", endsAt: ended.endsAt }, now)).toBe(true)
    // La que terminó mientras la pantalla seguía abierta también.
    expect(isUnclosed({ visit: "confirmada", endsAt: ended.endsAt }, now)).toBe(true)
    expect(isUnclosed({ visit: "confirmada", endsAt: soon.endsAt }, now)).toBe(false)
  })

  it("hoy pide «Llegó» primero (llegó tarde) y otro día pregunta si vino", () => {
    expect(stepBeforeArrival({ visit: "sin_cerrar", ...ended }, now, true)).toBe("tarde")
    expect(stepBeforeArrival({ visit: "sin_cerrar", ...ended }, now, false)).toBe("cerrar")
    expect(stepBeforeArrival({ visit: "confirmada", ...soon }, now, true)).toBe("llego")
    expect(stepBeforeArrival({ visit: "llego", ...ended }, now, true)).toBeNull()
  })
})
