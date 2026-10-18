import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  closeAfterHoursIssue,
  closeWithoutResolvingWords,
  closureBand,
  closureWords,
  conversationWords,
  messageTimeWords,
  resolveWords,
  whenWords,
} from "./conversation-state"
import type { ConversationAttention } from "./crm"
import { setOrgLocale } from "./locale"

const NOW = new Date("2026-10-15T15:00:00.000Z")
const open = (patch: Partial<ConversationAttention>) => ({
  status: "open",
  closure: null,
  attention: {
    agentAttending: false,
    pendingContact: 0,
    handoffPriority: null,
    awaitingPatientSince: null,
    nudgedAt: null,
    outOfHours: false,
    assignedName: null,
    ...patch,
  } satisfies ConversationAttention,
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  setOrgLocale("es-ES", "America/Lima")
})
afterEach(() => {
  vi.useRealTimers()
  setOrgLocale(undefined, undefined)
})

describe("en qué está una conversación abierta", () => {
  it("un tema dice de quién es: de nadie con su urgencia, tuyo u de otra persona (ADR 0049)", () => {
    const topic = {
      id: "t1", reason: "Descuento", priority: "media" as const, urgent: false, assigneeUserId: null, assigneeName: null,
      createdBy: "agent" as const, createdAt: NOW.toISOString(), dueAt: null, taskId: null,
      source: { id: "m1", body: "¿Me hacen descuento?", createdAt: NOW.toISOString() }, askedMessageIds: [], askedAgainAt: null,
    }
    expect(conversationWords(open({ topics: [{ ...topic, urgent: true }] }))).toEqual({ text: "Te lo pasó el agente · Ahora", tone: "urgent" })
    expect(conversationWords(open({ topics: [topic] }))).toEqual({ text: "Te lo pasó el agente · Hoy", tone: "team" })
    expect(conversationWords({ ...open({ topics: [{ ...topic, assigneeUserId: "yo", assigneeName: "Ana" }] }), myUserId: "yo" })?.text).toBe("Lo tienes tú")
    expect(conversationWords(open({ topics: [{ ...topic, assigneeUserId: "luis", assigneeName: "Luis", askedAgainAt: NOW.toISOString() }] }))?.text)
      .toBe("Lo tiene Luis · volvió a preguntar")
    // Sin temas en una respuesta antigua, la urgencia del caso.
    expect(conversationWords(open({ handoffPriority: "alta" }))).toEqual({ text: "Te lo pasó el agente · Ahora", tone: "urgent" })
  })

  it("sin responder y sin el agente pide a una persona; con el agente, lo atiende él", () => {
    expect(conversationWords(open({ unanswered: true }))).toEqual({ text: "Por responder · el agente no la atiende", tone: "team" })
    expect(conversationWords(open({ unanswered: true, agentAttending: true }))).toEqual({ text: "La atiende el agente", tone: "agent" })
    expect(conversationWords(open({ unanswered: true, agentAttending: true, outOfHours: true }))?.text).toBe("La atiende el agente · responde al abrir")
    expect(conversationWords(open({ agentAttending: true, teamLive: true }))?.text).toBe("Conversa alguien del equipo · el agente espera")
  })

  it("lo que espera al paciente dice si hay una cita propuesta o cuándo se le recordó", () => {
    expect(conversationWords(open({ pendingContact: 1, agentAttending: true }))).toEqual({
      text: "Espera al paciente · cita propuesta",
      tone: "patient",
    })
    expect(
      conversationWords(open({ agentAttending: true, awaitingPatientSince: "2026-10-15T10:00:00.000Z", nudgedAt: "2026-10-15T12:00:00.000Z" }))?.text,
    ).toBe("Espera al paciente · se le recordó hace 3 h")
    expect(conversationWords(open({ agentAttending: true, awaitingPatientSince: "2026-10-15T14:00:00.000Z" }))?.text).toBe("Espera al paciente")
  })

  it("sin atención del servidor una abierta no dice nada", () => {
    expect(conversationWords({ status: "open" })).toBeNull()
    expect(conversationWords(open({}))).toBeNull()
  })
})

describe("cómo se cerró", () => {
  it("cada motivo en palabras, con quién la cerró si fue una persona", () => {
    expect(closureWords({ reason: "resuelta", at: NOW.toISOString(), byName: null })).toBe("Cerrada por el agente · resuelta")
    expect(closureWords({ reason: "sin_respuesta", at: NOW.toISOString(), byName: null })).toBe(
      "Cerrada por el agente · sin respuesta del paciente",
    )
    expect(closureWords({ reason: "equipo", at: NOW.toISOString(), byName: "Rosa Díaz" })).toBe("Resuelta por Rosa Díaz")
    expect(closureWords({ reason: "manual", at: NOW.toISOString(), byName: "Luis" })).toBe("Cerrada por Luis")
    expect(conversationWords({ status: "closed", closure: { reason: "manual", at: NOW.toISOString(), byName: "Luis" } })).toEqual({
      text: "Cerrada por Luis",
      tone: "closed",
    })
    // Cerrada sin el detalle del servidor: no se inventa el motivo.
    expect(conversationWords({ status: "closed", closure: null })?.text).toBe("Cerrada")
  })

  it("la franja del hilo dice cuándo, en la hora de la clínica", () => {
    // 15 de octubre 10:00 en Lima es hoy; el 14 a las 18:42 de Lima, ayer.
    expect(closureBand({ reason: "resuelta", at: "2026-10-15T15:00:00.000Z", byName: null }, NOW)).toBe(
      "Cerrada por el agente · resuelta · hoy 10:00",
    )
    expect(closureBand({ reason: "sin_respuesta", at: "2026-10-14T23:42:00.000Z", byName: null }, NOW)).toBe(
      "Cerrada por el agente · sin respuesta del paciente · ayer 18:42",
    )
  })

  it("la hora de un mensaje dice el día cuando no es de hoy, y el año si es de otro", () => {
    expect(messageTimeWords("2026-10-15T15:00:00.000Z", NOW)).toBe("10:00")
    expect(messageTimeWords("2026-10-14T23:42:00.000Z", NOW)).toBe("ayer 18:42")
    // 12 de octubre 16:00 en Lima: antes de ayer, con su día.
    expect(messageTimeWords("2026-10-12T21:00:00.000Z", NOW)).toBe("12/10 16:00")
    expect(whenWords("2025-03-12T23:42:00.000Z", NOW)).toBe("12/3/2025 18:42")
  })
})

describe("confirmaciones de cierre", () => {
  it("«Resolver» dice si se despide y qué más se cierra", () => {
    expect(resolveWords("Ana Ruiz", { farewell: true, farewellText: "¡Gracias!", handoffs: 1, pendingContact: 1 })).toEqual({
      description:
        "Se cerrará la conversación con Ana Ruiz, se le enviará la despedida de la clínica y el agente volverá a atenderla si escribe de nuevo.",
      also: ["También se dará por resuelto el caso que te pasó el agente.", "Vencerá la cita propuesta que esperaba su sí."],
    })
    expect(resolveWords("Ana Ruiz", { farewell: false, farewellText: null, handoffs: 0, pendingContact: 0 })).toEqual({
      description:
        "Se cerrará la conversación con Ana Ruiz, pero no se le puede escribir: pasaron más de 23 horas desde su último mensaje. Se cerrará sin enviarle nada.",
      also: [],
    })
  })

  it("«Cerrar sin resolver» no promete despedida", () => {
    expect(closeWithoutResolvingWords("Ana Ruiz")).toContain("sin enviarle nada")
  })

  it("las horas para cerrar por silencio van de 6 a 23", () => {
    expect(closeAfterHoursIssue("6")).toBeNull()
    expect(closeAfterHoursIssue("23")).toBeNull()
    expect(closeAfterHoursIssue("5")).not.toBeNull()
    expect(closeAfterHoursIssue("24")).not.toBeNull()
    expect(closeAfterHoursIssue("12.5")).not.toBeNull()
    expect(closeAfterHoursIssue("")).not.toBeNull()
  })
})
