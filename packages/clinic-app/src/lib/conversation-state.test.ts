import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  channelsWords,
  closeAfterHoursIssue,
  closeWithoutResolvingWords,
  closureBand,
  closureWords,
  conversationWords,
  dayWords,
  listTimeWords,
  messageTimeWords,
  replyWindowWords,
  resolveWords,
  whenWords,
} from "./conversation-state"
import type { ConversationAttention } from "./crm"
import { setOrgLocale } from "./locale"

const NOW = new Date("2026-10-15T15:00:00.000Z")
const open = (patch: Partial<ConversationAttention>) => ({
  status: "open",
  receptionName: "Sofi",
  closure: null,
  attention: {
    agentAttending: false,
    pendingContact: 0,
    handoffPriority: null,
    awaitingPatientSince: null,
    nudgedAt: null,
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
  it("un tema dice de quién es: de nadie con su urgencia, tuyo u de otra persona (ADR 0050)", () => {
    const topic = {
      id: "t1", reason: "Descuento", priority: "media" as const, urgent: false, assigneeUserId: null, assigneeName: null,
      createdBy: "agent" as const, createdAt: NOW.toISOString(), dueAt: null, taskId: null,
      source: { id: "m1", body: "¿Me hacen descuento?", createdAt: NOW.toISOString() }, askedMessageIds: [], askedAgainAt: null,
    }
    expect(conversationWords(open({ topics: [{ ...topic, urgent: true }] }))).toEqual({ text: "Te lo pasó Sofi · Ahora", tone: "urgent" })
    expect(conversationWords(open({ topics: [topic] }))).toEqual({ text: "Te lo pasó Sofi · Hoy", tone: "team" })
    expect(conversationWords({ ...open({ topics: [{ ...topic, assigneeUserId: "yo", assigneeName: "Ana" }] }), myUserId: "yo" })?.text).toBe("Lo tienes tú")
    expect(conversationWords(open({ topics: [{ ...topic, assigneeUserId: "luis", assigneeName: "Luis", askedAgainAt: NOW.toISOString() }] }))?.text)
      .toBe("Lo tiene Luis · volvió a preguntar")
    // Sin temas en una respuesta antigua, la urgencia del caso.
    expect(conversationWords(open({ handoffPriority: "alta" }))).toEqual({ text: "Te lo pasó Sofi · Ahora", tone: "urgent" })
  })

  it("sin responder y sin el agente pide a una persona; con el agente, lo atiende él", () => {
    expect(conversationWords(open({ unanswered: true }))).toEqual({ text: "Por responder · Sofi no la atiende", tone: "team" })
    expect(conversationWords(open({ unanswered: true, agentAttending: true }))).toEqual({ text: "La atiende Sofi", tone: "agent" })
    expect(conversationWords(open({ agentAttending: true, teamLive: true }))?.text).toBe("Conversa alguien del equipo · Sofi espera")
  })

  it("lo que no salió pide a una persona: no dice que la atiende el agente ni que espera al paciente", () => {
    const failed = { text: "No se pudo enviar", tone: "team" }
    expect(conversationWords(open({ sendFailed: true, agentAttending: true }))).toEqual(failed)
    expect(conversationWords(open({ sendFailed: true, agentAttending: true, pendingContact: 1 }))).toEqual(failed)
    // Un tema va antes: es lo que alguien tiene que contestar.
    expect(conversationWords(open({ sendFailed: true, handoffPriority: "alta" }))).toEqual({ text: "Te lo pasó Sofi · Ahora", tone: "urgent" })
    // Cerrada no pide nada.
    expect(conversationWords({ ...open({ sendFailed: true }), status: "closed" })).toEqual({ text: "Cerrada", tone: "closed" })
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
    expect(conversationWords({ status: "open", receptionName: "Sofi" })).toBeNull()
    expect(conversationWords(open({}))).toBeNull()
  })
})

describe("cómo se cerró", () => {
  it("cada motivo en palabras, con quién la cerró si fue una persona", () => {
    expect(closureWords({ reason: "resuelta", at: NOW.toISOString(), byName: null }, "Sofi")).toBe("Cerrada por Sofi · resuelta")
    expect(closureWords({ reason: "sin_respuesta", at: NOW.toISOString(), byName: null }, "Sofi")).toBe(
      "Cerrada por Sofi · sin respuesta del paciente",
    )
    expect(closureWords({ reason: "equipo", at: NOW.toISOString(), byName: "Rosa Díaz" }, "Sofi")).toBe("Resuelta por Rosa Díaz")
    expect(closureWords({ reason: "manual", at: NOW.toISOString(), byName: "Luis" }, "Sofi")).toBe("Cerrada por Luis")
    expect(conversationWords({ status: "closed", receptionName: "Sofi", closure: { reason: "manual", at: NOW.toISOString(), byName: "Luis" } })).toEqual({
      text: "Cerrada por Luis",
      tone: "closed",
    })
    // Cerrada sin el detalle del servidor: no se inventa el motivo.
    expect(conversationWords({ status: "closed", receptionName: "Sofi", closure: null })?.text).toBe("Cerrada")
  })

  it("la franja del hilo dice cuándo, en la hora de la clínica", () => {
    // 15 de octubre 10:00 en Lima es hoy; el 14 a las 18:42 de Lima, ayer.
    expect(closureBand({ reason: "resuelta", at: "2026-10-15T15:00:00.000Z", byName: null }, "Sofi", NOW)).toBe(
      "Cerrada por Sofi · resuelta · hoy 10:00",
    )
    expect(closureBand({ reason: "sin_respuesta", at: "2026-10-14T23:42:00.000Z", byName: null }, "Sofi", NOW)).toBe(
      "Cerrada por Sofi · sin respuesta del paciente · ayer 18:42",
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
    expect(resolveWords("Ana Ruiz", { farewell: true, farewellText: "¡Gracias!", handoffs: 1, pendingContact: 1 }, "Sofi")).toEqual({
      description:
        "Se cerrará la conversación con Ana Ruiz, se le enviará la despedida de la clínica y Sofi volverá a atenderla si escribe de nuevo.",
      also: ["También se dará por resuelto el caso que te pasó Sofi.", "Vencerá la cita propuesta que esperaba su sí."],
    })
    expect(resolveWords("Ana Ruiz", { farewell: false, farewellText: null, handoffs: 0, pendingContact: 0 }, "Sofi")).toEqual({
      description:
        "Se cerrará la conversación con Ana Ruiz sin enviarle nada: ya no se le puede escribir, porque su último mensaje fue hace casi 24 horas o más.",
      also: [],
    })
  })

  it("«Cerrar sin resolver» no promete despedida", () => {
    expect(closeWithoutResolvingWords("Ana Ruiz", "Sofi")).toContain("sin enviarle nada")
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

describe("la hora de una fila y el día de un mensaje (pulido de la Bandeja)", () => {
  // NOW es el jueves 15 de octubre de 2026 a las 10:00 en Lima.
  it("la fila dice la hora si fue hoy, «ayer», el día de la semana o el día y el mes; nunca queda vacía con fecha", () => {
    expect(listTimeWords("2026-10-15T14:42:00.000Z", NOW)).toBe("09:42")
    expect(listTimeWords("2026-10-14T20:00:00.000Z", NOW)).toBe("ayer")
    expect(listTimeWords("2026-10-12T20:00:00.000Z", NOW)).toBe("lun")
    expect(listTimeWords("2026-08-08T20:00:00.000Z", NOW)).toBe("8 ago")
    expect(listTimeWords("2025-08-08T20:00:00.000Z", NOW)).toBe("8 ago 2025")
    expect(listTimeWords(null, NOW)).toBe("")
  })

  it("el separador del hilo dice «Hoy», «Ayer» o el día con su nombre, en la zona de la clínica", () => {
    expect(dayWords("2026-10-15T14:00:00.000Z", NOW)).toBe("Hoy")
    // 00:30 UTC del 15 es todavía el 14 en Lima.
    expect(dayWords("2026-10-15T00:30:00.000Z", NOW)).toBe("Ayer")
    expect(dayWords("2026-10-13T15:00:00.000Z", NOW)).toBe("Martes, 13 de octubre")
  })
})

describe("una fila por persona (fase 4 del pulido)", () => {
  it("sus canales se dicen una vez cada uno, como en una frase", () => {
    expect(channelsWords(["whatsapp"])).toBe("WhatsApp")
    expect(channelsWords(["whatsapp", "telegram"])).toBe("WhatsApp y Telegram")
    expect(channelsWords(["whatsapp", "telegram", "email", "email"])).toBe("WhatsApp, Telegram y Correo")
  })

  it("«Responder por» dice si el canal está abierto", () => {
    expect(replyWindowWords("open")).toBe("abierto")
    expect(replyWindowWords(null)).toBe("abierto")
    expect(replyWindowWords("closed")).toBe("pasaron 24 horas")
  })
})
