import { describe, expect, it } from "vitest"
import type { AgendaAvailability } from "../../lib/agenda"
import { seedNoteOf } from "./when"

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
