import { describe, expect, it } from "vitest"
import {
  type DemoAppointment,
  moveAppointment,
  projectAppointment,
  roomOf,
} from "./resource-demo.js"

const appointment: DemoAppointment = {
  id: "same-appointment",
  title: "Persona",
  professionalId: "ana",
  chairId: "chair-1",
  start: "2026-09-24T14:00:00Z",
  end: "2026-09-24T15:00:00Z",
  status: "confirmada",
}

describe("asignaciones independientes de la agrupación", () => {
  it("mover profesional conserva el sillón; mover sillón conserva el profesional y deriva la sala", () => {
    const professionalMove = moveAppointment(
      appointment,
      { columnId: "luis", start: appointment.start, end: appointment.end },
      "professionals",
    )
    expect(projectAppointment(professionalMove, "chairs").columnId).toBe("chair-1")
    expect(projectAppointment(professionalMove, "professionals").columnId).toBe("luis")
    const chairMove = moveAppointment(
      professionalMove,
      { columnId: "chair-4", start: "2026-09-25T14:00:00Z", end: "2026-09-25T15:00:00Z" },
      "chairs",
    )
    expect(projectAppointment(chairMove, "professionals").columnId).toBe("luis")
    expect(roomOf(chairMove)).toBe("room-b")
    expect(chairMove.id).toBe(appointment.id)
    expect(chairMove.start).toBe("2026-09-25T14:00:00Z")
    expect(chairMove.status).toBe("confirmada")
  })
})
