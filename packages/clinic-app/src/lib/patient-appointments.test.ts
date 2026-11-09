import { describe, expect, it } from "vitest"
import { type AgendaAppointment, isUnclosed } from "./agenda"
import { setOrgLocale } from "./locale"
import {
  appointmentLine,
  appointmentVisitWord,
  appointmentWhat,
  isUpcoming,
  nextAppointment,
} from "./patient-appointments"

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
const LIMA = "America/Lima"

// QA del 6 nov (U6): a quien estaba en la sala de espera, la ficha le decía «Próxima cita: Ninguna».
describe("la próxima cita de la ficha", () => {
  it("es la de hoy si la persona ya llegó o está en atención, aunque haya pasado su hora", () => {
    const waiting = at({ id: "hoy", status: "confirmada", visit: "llego", arrivedAt: "2026-11-07T17:26:00.000Z" })
    expect(isUpcoming(waiting, now, LIMA)).toBe(true)
    expect(isUpcoming(at({ visit: "en_atencion" }), now, LIMA)).toBe(true)
    expect(nextAppointment([at({ id: "luego", startsAt: "2026-12-01T15:00:00.000Z", endsAt: "2026-12-01T15:30:00.000Z" }), waiting], now, LIMA)?.id).toBe("hoy")
  })
  it("una que pasó sin llegada, atendida o cancelada no es la próxima", () => {
    expect(isUpcoming(at({}), now, LIMA)).toBe(false)
    expect(isUpcoming(at({ status: "atendida", visit: "atendida" }), now, LIMA)).toBe(false)
    expect(isUpcoming(at({ status: "cancelada", visit: "cancelada", endsAt: "2026-12-01T15:30:00.000Z" }), now, LIMA)).toBe(false)
  })
})

// QA del 6 nov (U9): las citas que ya pasaron seguían «Por confirmar» en la ficha.
describe("una cita que ya pasó sin cerrarse", () => {
  const iso = new Date(now).toISOString()
  it("dice «Sin cerrar», como la Agenda la pone en «Ya pasaron · sin cerrar»", () => {
    expect(isUnclosed(at({}), iso)).toBe(true)
    expect(appointmentVisitWord(at({}), now, LIMA)).toBe("Sin cerrar")
    expect(appointmentVisitWord(at({ status: "confirmada", visit: "confirmada" }), now, LIMA)).toBe("Sin cerrar")
  })
  it("la que aún no pasa, llegó, se atendió o no vino dice su momento", () => {
    expect(appointmentVisitWord(at({ endsAt: "2026-11-07T18:00:00.000Z" }), now, LIMA)).toBe("Por confirmar")
    expect(appointmentVisitWord(at({ visit: "llego" }), now, LIMA)).toBe("Llegó")
    expect(appointmentVisitWord(at({ status: "atendida", visit: "atendida" }), now, LIMA)).toBe("Atendida")
    expect(appointmentVisitWord(at({ status: "no_asistio", visit: "no_vino" }), now, LIMA)).toBe("No vino")
  })
})

describe("lo que dice la ficha de la cita de quien ya llegó", () => {
  it("su hora y su momento con el reloj de la Agenda", () => {
    setOrgLocale("es-PE", "America/Lima")
    const waiting = at({
      status: "confirmada",
      visit: "llego",
      arrivedAt: "2026-11-07T17:26:00.000Z",
      serviceName: "Limpieza dental",
      professionalName: "Dra. Ana Torres",
    })
    expect(appointmentLine(waiting, new Date("2026-11-07T17:36:00.000Z"))).toBe(
      "Hoy 11:00 · Llegó 12:26 · espera 10 min · Limpieza dental · Dra. Ana Torres",
    )
    setOrgLocale(undefined, undefined)
  })
})

// Revisión del 7 nov (punto 1): un «Llegó» o una atención en borrador de otro día no es
// estar en la clínica: decía «Hoy 10:00 · En atención» y tapaba la reserva del mes siguiente.
describe("una llegada o una atención de otro día", () => {
  const lastWeek = { startsAt: "2026-10-31T15:00:00.000Z", endsAt: "2026-10-31T15:30:00.000Z" }
  it("no es la próxima cita: la próxima es la reservada", () => {
    const stale = at({ id: "vieja", status: "confirmada", visit: "en_atencion", ...lastWeek })
    const booked = at({ id: "reservada", startsAt: "2026-12-01T15:00:00.000Z", endsAt: "2026-12-01T15:30:00.000Z" })
    expect(isUpcoming(stale, now, LIMA)).toBe(false)
    expect(nextAppointment([stale, booked], now, LIMA)?.id).toBe("reservada")
  })
  it("es una cita pasada sin cerrar", () => {
    expect(appointmentVisitWord(at({ status: "confirmada", visit: "llego", arrivedAt: "2026-10-31T15:05:00.000Z", ...lastWeek }), now, LIMA)).toBe("Sin cerrar")
    expect(appointmentVisitWord(at({ status: "confirmada", visit: "en_atencion", ...lastWeek }), now, LIMA)).toBe("Sin cerrar")
  })
  it("la de hoy en Lima cuenta aunque en UTC ya sea mañana", () => {
    // 23:30 del 7 en Lima son las 04:30 UTC del 8.
    const late = Date.parse("2026-11-08T04:30:00.000Z")
    const tonight = at({ status: "confirmada", visit: "llego", startsAt: "2026-11-08T03:00:00.000Z", endsAt: "2026-11-08T03:30:00.000Z" })
    expect(isUpcoming(tonight, late, LIMA)).toBe(true)
  })
})

describe("a qué viene la cita (repaso del 9 nov: «Sumar a su cita» no se veía en la cabecera)", () => {
  it("dice su servicio y lo que se le sumó, sin repetir el servicio", () => {
    const base = { serviceName: "Endodoncia posterior vital", reason: null }
    expect(appointmentWhat({ ...base, sessions: [] })).toBe("Endodoncia posterior vital")
    expect(
      appointmentWhat({
        ...base,
        sessions: [
          { planItemId: "a", title: "Endodoncia posterior vital", n: 2, m: 2 },
          { planItemId: "b", title: "Corona metal-cerámica", n: 1, m: 2 },
        ],
      }),
    ).toBe("Endodoncia posterior vital y Corona metal-cerámica")
    expect(
      appointmentWhat({
        ...base,
        sessions: [
          { planItemId: "b", title: "Corona", n: 1, m: 1 },
          { planItemId: "c", title: "Resina", n: 1, m: 1 },
        ],
      }),
    ).toBe("Endodoncia posterior vital y 2 más")
    expect(appointmentWhat({ serviceName: null, reason: null, sessions: [] })).toBeNull()
  })
})
