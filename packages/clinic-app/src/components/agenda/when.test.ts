import { describe, expect, it } from "vitest"
import type { AgendaAvailability } from "../../lib/agenda"
import { emptyDaySaid, offDutyOn, seedNoteOf } from "./when"

/**
 * «Reservar la sesión 2» con quien atendió (QA del 8 nov): si la agenda no lo
 * ofrece como a los demás, se dice por qué en vez de poner «Cualquiera» callado.
 */
const ana = { id: "ana", label: "Dra. Ana Torres", nextFree: null }
const oscar = { id: "oscar", label: "Dr. Óscar Rodríguez", nextFree: null }
const lanes = (items: Array<{ id: string; label: string }>) => items.map((item) => ({ ...item, tone: undefined }))

describe("lo que se dice de quien se pidió al abrir", () => {
  it("nada si la agenda lo ofrece como a los demás", () => {
    const availability: Pick<AgendaAvailability, "professionals" | "attending"> = { professionals: [ana, oscar], attending: null }
    expect(seedNoteOf(availability, lanes([ana, oscar]), "ana", "Dra. Ana Torres")).toBeNull()
  })

  it("sin horario en la sede: lo dice, y se le reserva fuera de su horario", () => {
    const availability: Pick<AgendaAvailability, "professionals" | "attending"> = {
      professionals: [oscar],
      attending: { specialtyName: "Endodoncia", professionalUserIds: ["oscar"] },
    }
    expect(seedNoteOf(availability, lanes([oscar, ana]), "ana", "Dra. Ana Torres")).toEqual({
      kind: "noSchedule",
      label: "Dra. Ana Torres",
      specialty: { name: "Endodoncia", attending: lanes([oscar]) },
    })
    // Sin especialidad que restrinja, solo el horario.
    expect(seedNoteOf({ professionals: [oscar], attending: null }, lanes([oscar, ana]), "ana", "Dra. Ana Torres")).toEqual({
      kind: "noSchedule",
      label: "Dra. Ana Torres",
      specialty: null,
    })
  })

  it("de otra especialidad: lo dice con quienes la atienden", () => {
    const availability: Pick<AgendaAvailability, "professionals" | "attending"> = {
      professionals: [{ ...ana, outsideService: true }, oscar],
      attending: { specialtyName: "Endodoncia", professionalUserIds: ["oscar"] },
    }
    const note = seedNoteOf(availability, lanes([ana, oscar]), "ana", "Dra. Ana Torres")
    expect(note).toEqual({ kind: "otherSpecialty", label: "Dra. Ana Torres", specialty: { name: "Endodoncia", attending: lanes([oscar]) } })
  })

  it("nada mientras la disponibilidad no llega o si no se pidió a nadie", () => {
    expect(seedNoteOf(undefined, [], "ana", "Dra. Ana Torres")).toBeNull()
    expect(seedNoteOf({ professionals: [oscar], attending: null }, lanes([oscar]), null, null)).toBeNull()
  })
})

/**
 * Un día sin hora elegida ni libre (QA del 9 nov): con un profesional que no
 * atiende ese día salían dos textos que se contradecían («toca una hora…» y
 * «No queda nada libre…»). Ahora, uno solo.
 */
describe("lo que se dice de un día sin nada libre", () => {
  const tz = "America/Lima"
  const day = "2026-11-09"
  // Lunes 9, de 09:00 a 13:00 en Lima.
  const anaMonday = {
    columnId: "ana",
    start: "2026-11-09T14:00:00.000Z",
    end: "2026-11-09T18:00:00.000Z",
  }

  it("quien no tiene horario ese día: lo dice, con la salida, y no «No queda nada libre»", () => {
    const offDuty = offDutyOn(lanes([oscar]), [anaMonday], day, tz)
    expect(offDuty).toBe("Dr. Óscar Rodríguez")
    expect(emptyDaySaid({ moving: false, offDuty })).toBe(
      "Dr. Óscar Rodríguez no atiende este día en esta sede. Toca una hora para reservar igual, o elige a otro profesional.",
    )
  })

  it("quien atiende ese día y lo tiene todo ocupado: «No queda nada libre»", () => {
    const offDuty = offDutyOn(lanes([ana]), [anaMonday], day, tz)
    expect(offDuty).toBeNull()
    expect(emptyDaySaid({ moving: false, offDuty })).toBe(
      "No queda nada libre este día. Prueba otro día u otro profesional.",
    )
    // Otro día, Ana tampoco atiende.
    expect(offDutyOn(lanes([ana]), [anaMonday], "2026-11-10", tz)).toBe("Dra. Ana Torres")
  })

  it("con «Cualquiera» no se nombra a nadie; al mover, lo de siempre", () => {
    expect(offDutyOn(lanes([ana, oscar]), [anaMonday], day, tz)).toBeNull()
    expect(emptyDaySaid({ moving: true, offDuty: "Dra. Ana Torres" })).toBe(
      "Ese día no queda un hueco donde quepa la cita. Prueba otro día.",
    )
  })
})
