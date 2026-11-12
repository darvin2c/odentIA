import { describe, expect, it } from "vitest"
import { isUnclosed, movedNote, noticeLine, noticeWarning, stepBeforeArrival, visitName } from "./agenda"

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

describe("lo que se dice del aviso a la persona", () => {
  it("va en camino, lo decidió la clínica, quedó una tarea o hay que avisarle a mano", () => {
    const sent = "El agente le avisa la nueva fecha."
    expect(noticeLine({ queued: true }, sent)).toBe(sent)
    expect(noticeLine(undefined, sent)).toBeNull()
    expect(noticeLine({ queued: false }, sent)).toBeNull()
    expect(noticeLine({ queued: false, why: "«Recordar la cita» está apagada" }, sent)).toBe("No se le avisa. «Recordar la cita» está apagada.")
    expect(noticeLine({ queued: true, why: "Los agentes están en pausa: queda una tarea para avisarle" }, sent)).toBe(
      "Los agentes están en pausa: queda una tarea para avisarle.",
    )
    // Lo que hay que avisarle a mano no va en la línea: va aparte y fijo.
    const byHand = { queued: false, why: "Su número no tiene WhatsApp y no tiene correo registrado", byHand: true }
    expect(noticeLine(byHand, sent)).toBeNull()
    expect(noticeWarning({ patientName: "Pedro Ramírez", notice: byHand })).toBe(
      "Pedro Ramírez no recibirá el aviso. Su número no tiene WhatsApp y no tiene correo registrado. Avísale tú.",
    )
    expect(noticeWarning({ patientName: "Pedro Ramírez", notice: { queued: false, why: "«Recordar la cita» está apagada" } })).toBeNull()
    expect(movedNote({ status: "confirmada", arrivedAt: null }, { status: "programada", arrivedAt: null, notice: byHand })).toBe(
      "Queda por confirmar: confirmó el otro día.",
    )
  })
})

describe("el aviso de mover una cita", () => {
  it("dice si quedó por confirmar, si volvió a quedar confirmada y si el agente avisa", () => {
    expect(movedNote({ status: "confirmada", arrivedAt: null }, { status: "programada", arrivedAt: null })).toBe("Queda por confirmar: confirmó el otro día.")
    expect(movedNote({ status: "programada", arrivedAt: null }, { status: "confirmada", arrivedAt: null })).toBe("Vuelve a quedar confirmada.")
    expect(movedNote({ status: "confirmada", arrivedAt: null }, { status: "confirmada", arrivedAt: null, notice: { queued: true } })).toBe("El agente le avisa la nueva fecha.")
    expect(movedNote({ status: "programada", arrivedAt: null }, { status: "programada", arrivedAt: null })).toBeUndefined()
  })

  it("con llegada dice que se quitó «Llegó» y, al deshacer, que volvió", () => {
    const at = "2026-11-11T15:00:00.000Z"
    expect(movedNote({ status: "confirmada", arrivedAt: at }, { status: "programada", arrivedAt: null })).toBe("Se quitó «Llegó» y queda por confirmar.")
    // La movió la propia persona: sigue confirmada.
    expect(movedNote({ status: "confirmada", arrivedAt: at }, { status: "confirmada", arrivedAt: null })).toBe("Se quitó «Llegó».")
    expect(movedNote({ status: "programada", arrivedAt: null }, { status: "confirmada", arrivedAt: at })).toBe("Vuelve a figurar que llegó.")
  })
})
