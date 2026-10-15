import { describe, expect, it } from "vitest"
import { agendaSummary, attendedPercent, daysAgo, longDay, patientsSummary, waitingText, type HomeTextContext } from "./home"
import type { WaitingRow } from "./workspace"

const context: HomeTextContext = { today: "2026-10-12", timezone: "America/Lima", locale: "es-PE", allTasks: false }
const task = (patch: Partial<Extract<WaitingRow, { kind: "task" }>>): WaitingRow => ({
  kind: "task", id: "t1", title: "Llamar a Mateo Huamán por su presupuesto", dueAt: null, due: "none",
  href: "/tasks?task=t1", mine: true, assigneeName: "Rosa", more: 0, ...patch,
})

describe("textos de «Te espera»", () => {
  it("una tarea dice de quién es, cuándo vence y cuántas quedan", () => {
    expect(waitingText(task({ due: "overdue", dueAt: "2026-10-11T15:00:00.000Z" }), context)).toEqual({
      title: "Llamar a Mateo Huamán por su presupuesto", detail: "Tarea tuya · venció ayer", action: "Abrir",
    })
    // Quien dirige ve de quién es y que el resto es del equipo; con resto, la fila lleva a Tareas.
    expect(waitingText(task({ due: "today", dueAt: "2026-10-12T22:00:00.000Z", mine: false, assigneeName: "Dra. Ana Torres", more: 7 }), { ...context, allTasks: true })).toEqual({
      title: "Llamar a Mateo Huamán por su presupuesto", detail: "Tarea · para hoy · Dra. Ana Torres · y 7 tareas más del equipo", action: "Ver tareas",
    })
    expect(waitingText(task({ mine: false, assigneeName: null }), context).detail).toBe("Tarea · sin fecha · Sin responsable")
  })

  it("el día se cuenta en la zona de la clínica, no en la del navegador", () => {
    // 03:00 UTC del 12 es todavía el 11 en Lima.
    expect(daysAgo("2026-10-12T03:00:00.000Z", context)).toBe("ayer")
    expect(daysAgo("2026-10-12T15:00:00.000Z", context)).toBe("hoy")
    expect(daysAgo("2026-10-03T15:00:00.000Z", context)).toBe("hace 9 días")
  })

  it("los resúmenes concuerdan en número", () => {
    expect(waitingText({ kind: "conversations", waiting: 1, oldestAt: null }, context).title).toBe("1 persona espera respuesta")
    expect(waitingText({ kind: "conversations", waiting: 5, oldestAt: null }, context).title).toBe("5 personas esperan respuesta")
    expect(waitingText({ kind: "budgets", total: 4, oldestPresentedAt: "2026-10-03T15:00:00.000Z", items: [] }, context)).toEqual({
      title: "4 presupuestos esperan respuesta", detail: "El más antiguo se presentó hace 9 días", action: "Ver cuáles",
    })
    expect(waitingText({ kind: "more", of: "cases", count: 1 }, context).title).toBe("1 caso más que pasó el agente")
  })
})

describe("resumen de hoy", () => {
  it("escribe el resumen de la agenda y calla lo que está en cero", () => {
    expect(agendaSummary({ total: 24, attended: 6, upcoming: 18, unconfirmed: 2 })).toBe("24 citas · 6 atendidas · 18 por venir, 2 sin confirmar")
    expect(agendaSummary({ total: 1, attended: 1, upcoming: 0, unconfirmed: 0 })).toBe("1 cita · 1 atendida · 0 por venir")
    expect(patientsSummary({ total: 8, attended: 2, upcoming: 6, unconfirmed: 1 })).toBe("8 pacientes · 2 atendidos · 6 por venir")
    expect(attendedPercent({ total: 24, attended: 6, upcoming: 18, unconfirmed: 2 })).toBe(25)
    expect(attendedPercent({ total: 0, attended: 0, upcoming: 0, unconfirmed: 0 })).toBe(0)
  })

  it("escribe el día con mayúscula inicial y sin coma", () => {
    expect(longDay("2026-10-12", "es-PE")).toBe("Lunes 12 de octubre")
  })
})
