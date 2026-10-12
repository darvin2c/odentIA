import { describe, expect, it } from "vitest"
import {
  OPERATIONS,
  type OperationField,
  type OperationId,
  operationAgentFields,
  operationAgentSchema,
  operationBodySchema,
  READ_TOOLS,
  TOOL_OPERATION,
  TOOLS_WITHOUT_OPERATION,
} from "./operation-fields.js"

/** Una sola declaración de campos por operación: de ella salen la ruta y la herramienta del agente. */
const IDS = Object.keys(OPERATIONS) as OperationId[]
const fieldsOf = (id: OperationId) => Object.entries(OPERATIONS[id].fields) as Array<[string, OperationField]>
const UUID = "0b6f5f0e-6a55-4c0e-9d5c-3a2b1c0d9e8f"

describe("declaración de campos", () => {
  it("cada campo dice qué es y quién lo llena cuando actúa el agente", () => {
    for (const id of IDS) {
      expect(OPERATIONS[id].label.trim().length, id).toBeGreaterThan(3)
      for (const [name, field] of fieldsOf(id)) {
        expect(field.label.trim().length, `${id}.${name}`).toBeGreaterThan(1)
        // Sin descripción el modelo no sabría cuándo usar el campo.
        expect(field.description.trim().length, `${id}.${name}`).toBeGreaterThan(12)
        expect(["fills", "requires", "context", "person"], `${id}.${name}`).toContain(field.agent)
      }
    }
  })

  it("lo que solo existe para el agente o viaja en la dirección no entra en el cuerpo de la ruta", () => {
    const moved = operationBodySchema("cita.mover").safeParse({
      expectedVersion: 1,
      startsAt: "2026-10-12T15:00:00-05:00",
      appointmentId: UUID,
      reason: "No debe llegar",
    })
    expect(moved.success).toBe(true)
    expect(moved.data).toEqual({ expectedVersion: 1, startsAt: "2026-10-12T15:00:00-05:00" })
  })

  it("el agente solo recibe los campos que llena; el contexto y lo reservado a personas no", () => {
    expect(operationAgentFields("tarea.crear").map((field) => field.name)).toEqual(["title", "dueAt"])
    const names = operationAgentFields("oportunidad.crear").map((field) => field.name)
    expect(names).toContain("interestText")
    // El contacto lo pone el sistema desde la conversación; el responsable, una persona.
    expect(names).not.toContain("contactId")
    expect(names).not.toContain("assignedUserId")
    for (const id of IDS) {
      const shape = operationAgentSchema(id).shape as Record<string, unknown>
      expect(Object.keys(shape).sort(), id).toEqual(operationAgentFields(id).map((field) => field.name).sort())
    }
  })
})

describe("mismas validaciones para la pantalla y para el agente", () => {
  it("un inicio sin zona se rechaza en los dos", () => {
    const base = { patientId: UUID, dentistUserId: "u-1", chairId: UUID }
    for (const schema of [operationBodySchema("cita.reservar"), operationAgentSchema("cita.reservar")]) {
      expect(schema.safeParse({ ...base, startsAt: "2026-10-12T15:00:00-05:00" }).success).toBe(true)
      expect(schema.safeParse({ ...base, startsAt: "mañana a las 3" }).success).toBe(false)
      expect(schema.safeParse({ ...base, startsAt: "2026-10-12T15:00:00-05:00", durationMin: 481 }).success).toBe(false)
    }
  })

  it("los límites de texto y las opciones coinciden", () => {
    for (const schema of [operationBodySchema("oportunidad.cerrar"), operationAgentSchema("oportunidad.cerrar")]) {
      expect(schema.safeParse({ outcome: "won", reason: "Aceptó el presupuesto" }).success).toBe(true)
      expect(schema.safeParse({ outcome: "ganada", reason: "x" }).success).toBe(false)
      expect(schema.safeParse({ outcome: "lost", reason: "" }).success).toBe(false)
      expect(schema.safeParse({ outcome: "lost", reason: "x".repeat(501) }).success).toBe(false)
    }
  })

  it("la pantalla puede vaciar un campo; la ruta rellena el valor por defecto", () => {
    const created = operationBodySchema("oportunidad.crear").safeParse({ contactId: UUID, title: "Ortodoncia", interestText: null })
    expect(created.success).toBe(true)
    const handoff = operationBodySchema("derivacion.crear").parse({ conversationId: UUID, reason: "Queja", summary: "Esperó una hora." })
    expect(handoff.priority).toBe("media")
  })
})

describe("de dónde salen los campos de cada herramienta", () => {
  it("cada herramienta está en una sola lista y toda operación nombrada existe", () => {
    const lists = [Object.keys(TOOL_OPERATION), Object.keys(TOOLS_WITHOUT_OPERATION), [...READ_TOOLS]]
    const all = lists.flat()
    expect(new Set(all).size).toBe(all.length)
    for (const operation of Object.values(TOOL_OPERATION)) expect(IDS).toContain(operation)
    // Toda excepción lleva su motivo.
    for (const [tool, why] of Object.entries(TOOLS_WITHOUT_OPERATION)) expect(why.trim().length, tool).toBeGreaterThan(20)
  })
})
