import { describe, expect, it } from "vitest"
import { type AgendaAppointment, isUnclosed, visitWord } from "./agenda"
import { isUpcoming, nextAppointment } from "./patient-appointments"

const at = (over: Partial<AgendaAppointment>): AgendaAppointment =>
  ({
    id: "a",
    status: "programada",
    visit: "por_confirmar",
    startsAt: "2026-11-07T16:00:00.000Z",
    endsAt: "2026-11-07T16:30:00.000Z",
    arrivedAt: null,
    encounter: null,
    ...over,
  }) as AgendaAppointment

const now = Date.parse("2026-11-07T17:26:00.000Z")

// QA del 6 nov (U6): a quien estaba en la sala de espera, la ficha le decía «Próxima cita: Ninguna».
describe("la próxima cita de la ficha", () => {
  it("es la de hoy si la persona ya llegó o está en atención, aunque haya pasado su hora", () => {
    const waiting = at({ id: "hoy", status: "confirmada", visit: "llego", arrivedAt: "2026-11-07T17:26:00.000Z" })
    expect(isUpcoming(waiting, now)).toBe(true)
    expect(isUpcoming(at({ visit: "en_atencion" }), now)).toBe(true)
    expect(nextAppointment([at({ id: "luego", startsAt: "2026-12-01T15:00:00.000Z", endsAt: "2026-12-01T15:30:00.000Z" }), waiting], now)?.id).toBe("hoy")
  })
  it("una que pasó sin llegada, atendida o cancelada no es la próxima", () => {
    expect(isUpcoming(at({}), now)).toBe(false)
    expect(isUpcoming(at({ status: "atendida", visit: "atendida" }), now)).toBe(false)
    expect(isUpcoming(at({ status: "cancelada", visit: "cancelada", endsAt: "2026-12-01T15:30:00.000Z" }), now)).toBe(false)
  })
})

// QA del 6 nov (U9): las citas que ya pasaron seguían «Por confirmar» en la ficha.
describe("una cita que ya pasó sin cerrarse", () => {
  const iso = new Date(now).toISOString()
  it("dice «Sin cerrar», como la Agenda la pone en «Ya pasaron · sin cerrar»", () => {
    expect(isUnclosed(at({}), iso)).toBe(true)
    expect(visitWord(at({}), iso)).toBe("Sin cerrar")
    expect(visitWord(at({ status: "confirmada", visit: "confirmada" }), iso)).toBe("Sin cerrar")
  })
  it("la que aún no pasa, llegó, se atendió o no vino dice su momento", () => {
    expect(visitWord(at({ endsAt: "2026-11-07T18:00:00.000Z" }), iso)).toBe("Por confirmar")
    expect(visitWord(at({ visit: "llego" }), iso)).toBe("Llegó")
    expect(visitWord(at({ status: "atendida", visit: "atendida" }), iso)).toBe("Atendida")
    expect(visitWord(at({ status: "no_asistio", visit: "no_vino" }), iso)).toBe("No vino")
  })
})
