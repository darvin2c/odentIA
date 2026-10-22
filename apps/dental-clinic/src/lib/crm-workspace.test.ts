import { describe, expect, it } from "vitest"
import { type CrmNextAppointment, messagePermissionsSaid, nextAppointmentSaid } from "./crm-workspace"

describe("«Contexto» dice lo que la persona aceptó y su próxima cita", () => {
  it("los permisos de mensajes, con palabras", () => {
    // Lo de su atención es parte del servicio: solo se dice si se dio de baja (ADR 0030).
    expect(messagePermissionsSaid({ recordatorio: true, seguimiento: null, novedades: true })).toBe("Acepta novedades y promociones")
    expect(messagePermissionsSaid({ recordatorio: null, seguimiento: null, novedades: false })).toBe("No quiere novedades ni promociones")
    expect(messagePermissionsSaid({ recordatorio: false, seguimiento: null, novedades: null })).toBe(
      "Novedades y promociones: aún no se le preguntó · pidió no recibir recordatorios",
    )
    expect(messagePermissionsSaid({ recordatorio: null, seguimiento: null, novedades: null })).toBe("Novedades y promociones: aún no se le preguntó")
    expect(messagePermissionsSaid({ recordatorio: false, seguimiento: false, novedades: false, avisos: false })).toBe("No quiere ningún mensaje de la clínica")
  })

  it("la próxima cita va con la hora de la sede y nombra al paciente si no es la propia persona", () => {
    const next: CrmNextAppointment = {
      id: "a",
      patientId: "p",
      patientName: "Rosa Quispe",
      // 15:30 en UTC son las 10:30 en Lima.
      startsAt: "2026-10-22T15:30:00.000Z",
      status: "programada",
      branchName: "Centro",
      timeZone: "America/Lima",
      professionalName: "Dra. Ruiz",
      serviceName: "Evaluación",
    }
    const own = nextAppointmentSaid(next, "es-PE", "Rosa Quispe")
    expect(own).toMatch(/10:30/)
    expect(own).toMatch(/· Evaluación · Dra\. Ruiz$/)
    expect(own.startsWith("Rosa")).toBe(false)
    expect(nextAppointmentSaid({ ...next, serviceName: null }, "es-PE", "Martín Salas")).toMatch(/^Rosa Quispe: .+ · Cita · Dra\. Ruiz$/)
  })
})
