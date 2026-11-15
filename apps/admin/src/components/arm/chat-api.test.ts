import { describe, expect, it } from "vitest"
import { ApiError } from "../../lib/api"
import {
  type ChatEntry,
  chatDetailSchema,
  chatFileState,
  chatFileTypeWords,
  chatSubtitle,
  chatTitle,
  entriesByDay,
  freeWindowWords,
  isUnsettled,
  momentWords,
  openChatOutcome,
  phoneWords,
  replyHelpWords,
  sentLineWords,
  unassignedChatOf,
} from "./chat-api"
import { newClientFromChat } from "./chat-owner-drawer"
import { chatItemMeta, chatSubjectOf, type KairosItem } from "./kairos-items"
import { writesThroughChat } from "./whatsapp-write"

// 14 nov 2026, 12:00 en Lima (UTC-5).
const now = new Date("2026-11-14T17:00:00.000Z")

/** Una conversación como la devuelve `GET /api/admin/chats/:id`. */
const raw = {
  id: "c1",
  channel: "whatsapp",
  address: "+51987100001",
  displayName: "Luis",
  client: { id: "k1", name: "Clínica Dental Sonrisa", product: "dental", hasAccount: true },
  contact: { id: "p1", name: "Luis Paredes", phone: "+51987100001" },
  notClinicAt: null,
  lastInboundAt: "2026-11-14T15:12:00.000Z",
  canReplyFreely: true,
  freeUntil: "2026-11-15T15:12:00.000Z",
  replySignature: "— Ana · odentIA",
  suggestion: null,
  entries: [
    {
      kind: "entro",
      id: "m1",
      at: "2026-11-13T22:30:00.000Z",
      body: "Hola",
      media: [],
      mediaCount: 0,
    },
    {
      kind: "salio",
      id: "o1",
      at: "2026-11-13T22:42:00.000Z",
      body: "Hola Luis",
      status: "enviado",
      template: null,
      adminOnly: false,
      createdBy: { userId: "u1", name: "Ana Ruiz" },
      sentAt: "2026-11-13T22:42:00.000Z",
    },
    {
      kind: "entro",
      id: "m2",
      at: "2026-11-14T15:12:00.000Z",
      body: null,
      media: [{ filename: "exportacion.xlsx", mimeType: "x", size: 10, fileId: "f1" }],
      mediaCount: 1,
    },
  ],
  files: [],
}

describe("la conversación", () => {
  it("lee lo que manda el servidor y no se rompe con un canal nuevo", () => {
    const chat = chatDetailSchema.parse(raw)
    expect(chat.channel).toBe("whatsapp")
    expect(chatDetailSchema.parse({ ...raw, channel: "telegram" }).channel).toBe("whatsapp")
  })

  it("se titula por el canal y por quien escribe", () => {
    const chat = chatDetailSchema.parse(raw)
    expect(chatTitle(chat)).toBe("WhatsApp con Luis Paredes")
    expect(chatSubtitle(chat)).toBe(
      "+51 987 100 001 · al número de Sallca · Clínica Dental Sonrisa",
    )
    expect(
      chatTitle({
        channel: "instagram",
        address: "igsid",
        displayName: "@dra.melissa",
        contact: null,
      }),
    ).toBe("Instagram con @dra.melissa")
    expect(
      chatTitle({ channel: "whatsapp", address: "+51954220318", displayName: null, contact: null }),
    ).toBe("WhatsApp con +51 954 220 318")
  })

  it("agrupa los mensajes por día de Lima", () => {
    const chat = chatDetailSchema.parse(raw)
    const days = entriesByDay(chat.entries, now)
    expect(days.map((day) => [day.heading, day.entries.length])).toEqual([
      ["Ayer", 2],
      ["Hoy", 1],
    ])
  })

  it("dice las horas con hoy, ayer y mañana", () => {
    expect(momentWords("2026-11-14T14:05:00.000Z", now)).toBe("hoy 09:05")
    expect(momentWords("2026-11-14T00:30:00.000Z", now)).toBe("ayer 19:30")
    expect(momentWords("2026-11-15T15:12:00.000Z", now)).toBe("mañana 10:12")
    expect(phoneWords("+447700900123")).toBe("+447700900123")
  })

  it("explica las 24 h y qué queda después, por canal", () => {
    const chat = chatDetailSchema.parse(raw)
    expect(freeWindowWords(chat, now)).toBe(
      "Puedes responder con texto libre hasta mañana 10:12 (24 h desde su último mensaje). Después, solo con una plantilla aprobada, o por correo.",
    )
    const closed = { ...chat, canReplyFreely: false }
    expect(freeWindowWords(closed, now)).toContain("plantilla aprobada")
    expect(freeWindowWords({ ...closed, channel: "instagram" as const }, now)).toContain(
      "Instagram ya no deja responderle",
    )
    expect(freeWindowWords({ ...closed, lastInboundAt: null }, now)).toContain(
      "Todavía no escribió",
    )
    expect(replyHelpWords(chat)).toBe(
      "Sale desde el número de Sallca, firmado «Ana · odentIA». Si no se sabe si salió, queda «No se sabe si salió» y no se reintenta.",
    )
  })

  it("dice quién envió, a qué hora y si salió; lo incierto pide «¿Salió?»", () => {
    const chat = chatDetailSchema.parse(raw)
    const sent = chat.entries[1] as Extract<ChatEntry, { kind: "salio" }>
    expect(sentLineWords(sent)).toBe("Ana Ruiz · 17:42 · Salió")
    expect(isUnsettled(sent, now)).toBe(false)
    expect(isUnsettled({ ...sent, status: "incierto" }, now)).toBe(true)
    expect(isUnsettled({ ...sent, status: "no_salio" }, now)).toBe(false)
  })

  it("«¿Salió?» en uno pendiente solo después de 10 minutos: antes, se está enviando", () => {
    const chat = chatDetailSchema.parse(raw)
    const sent = chat.entries[1] as Extract<ChatEntry, { kind: "salio" }>
    const pending = { ...sent, status: "pendiente", sentAt: null } as const
    expect(isUnsettled(pending, new Date(Date.parse(pending.at) + 60_000))).toBe(false)
    expect(isUnsettled(pending, new Date(Date.parse(pending.at) + 10 * 60_000))).toBe(true)
  })

  it("dice el estado de cada archivo y solo deja marcar la carga una vez", () => {
    const file = {
      fileId: "f1",
      messageId: "m2",
      filename: "exportacion-pacientes.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 10,
      kind: "correo" as const,
      deleteAfter: null,
      deleted: false,
      cargaDeleteAfter: "2026-12-14",
      cargaDueNow: false,
    }
    expect(chatFileTypeWords(file.contentType, file.filename)).toBe("XLSX")
    expect(chatFileTypeWords("audio/ogg", "nota.ogg")).toBe("Audio")
    expect(chatFileState(file)).toEqual({
      words: "Guardado en Documentos · solo Administración",
      canMark: true,
    })
    const carga = chatFileState({ ...file, kind: "archivo_clinica", deleteAfter: "2026-12-14" })
    expect(carga.canMark).toBe(false)
    expect(carga.words).toMatch(/^Es la carga de datos · se borra el /)
    expect(chatFileState({ ...file, deleted: true }).canMark).toBe(false)
  })
})

const item = (kind: string, payload: Record<string, unknown>): KairosItem => ({
  id: "i1",
  clientId: null,
  clientName: null,
  product: null,
  kind,
  title: "WhatsApp sin cliente: +51 954 220 318",
  reason: "",
  status: "espera",
  payload,
  ready: true,
  drafter: null,
  draftNote: null,
  adminOnly: true,
  expiresAt: "2026-11-16T14:05:00.000Z",
  createdAt: "2026-11-14T14:05:00.000Z",
  decidedAt: null,
  decidedByName: null,
  result: null,
  error: null,
})

describe("la tarjeta de Hoy", () => {
  it("dice cuándo escribió y, sin cliente, de quién es o hasta cuándo se responde", () => {
    expect(
      chatItemMeta(
        item("chat_sin_cliente", { channel: "whatsapp", receivedAt: "2026-11-14T14:05:00.000Z" }),
        now,
      ),
    ).toEqual(["Hoy 09:05", "Solo administración"])
    expect(
      chatItemMeta(
        item("chat_sin_cliente", { channel: "instagram", receivedAt: "2026-11-14T00:30:00.000Z" }),
        now,
      ),
    ).toEqual(["Ayer 19:30", "Responde hasta hoy 19:30"])
    expect(
      chatItemMeta(
        item("responder_chat", { channel: "whatsapp", receivedAt: "2026-11-14T15:12:00.000Z" }),
        now,
      ),
    ).toEqual(["WhatsApp", "hoy 10:12"])
  })

  it("solo sugiere el contacto si el servidor lo trae entero", () => {
    const base = {
      chatId: "c1",
      channel: "whatsapp",
      address: "+51954220318",
      displayName: null,
      lastBody: "Hola",
      receivedAt: "2026-11-14T14:05:00.000Z",
    }
    const suggestion = {
      contactId: "p1",
      contactName: "Rosa Quispe",
      clientId: "k1",
      clientName: "Odontología Quispe",
    }
    expect(chatSubjectOf(item("chat_sin_cliente", { ...base, suggestion }))?.suggestion).toEqual(
      suggestion,
    )
    expect(
      chatSubjectOf(item("chat_sin_cliente", { ...base, suggestion: { contactId: "p1" } }))
        ?.suggestion,
    ).toBeNull()
    expect(chatSubjectOf(item("chat_sin_cliente", { ...base, chatId: null }))).toBeNull()
  })

  it("«Es una clínica nueva» trae el celular en WhatsApp y la cuenta en Instagram", () => {
    const subject = chatSubjectOf(
      item("chat_sin_cliente", { chatId: "c1", channel: "whatsapp", address: "+51954220318" }),
    )
    expect(subject && newClientFromChat(subject)).toMatchObject({
      phone: "+51954220318",
      origin: "whatsapp",
    })
    const ig = chatSubjectOf(
      item("chat_sin_cliente", {
        chatId: "c2",
        channel: "instagram",
        address: "igsid",
        displayName: "@dra.melissa.ortodoncia",
      }),
    )
    const values = ig ? newClientFromChat(ig) : {}
    expect(values).toMatchObject({
      contactName: "dra.melissa.ortodoncia",
      origin: "redes",
      originDetail: "Nos escribió por Instagram (@dra.melissa.ortodoncia)",
    })
    expect(values).not.toHaveProperty("phone")
  })
})

describe("«Escribir por WhatsApp»", () => {
  const apiError = (status: number, code: string, fields?: Record<string, string>) =>
    new ApiError(
      status,
      { code, message: "Ese celular ya nos escribió", ...(fields ? { fields } : {}) },
      {
        code,
        ...(fields ? { fields } : {}),
      },
    )

  it("si ese celular ya escribió sin decir de quién es, Administración lo dice ahí; Soporte sigue por wa.me", () => {
    const unassigned = apiError(409, "CHAT_UNASSIGNED", { chatId: "c9" })
    expect(unassignedChatOf(unassigned)).toBe("c9")
    expect(openChatOutcome(unassigned, true)).toEqual({ kind: "decidir", chatId: "c9" })
    expect(openChatOutcome(unassigned, false)).toEqual({
      kind: "wa.me",
      message: "Ese celular ya nos escribió",
    })
    // Soporte con una clínica que no ve (404) u otro 409: wa.me como antes, sin aviso.
    expect(openChatOutcome(apiError(404, "NOT_FOUND"), false)).toEqual({
      kind: "wa.me",
      message: null,
    })
    expect(openChatOutcome(apiError(409, "CHAT_OTHER_CLIENT"), false)).toEqual({
      kind: "wa.me",
      message: null,
    })
    // Administración con otro error: se dice el error.
    expect(openChatOutcome(apiError(409, "CHAT_OTHER_CLIENT"), true)).toEqual({ kind: "error" })
    expect(openChatOutcome(new Error("red"), false)).toEqual({ kind: "error" })
  })

  it("sale desde la administración solo con el número de Sallca y una persona del cliente", () => {
    expect(writesThroughChat(true, "p1")).toBe(true)
    expect(writesThroughChat(false, "p1")).toBe(false)
    expect(writesThroughChat(undefined, "p1")).toBe(false)
    expect(writesThroughChat(true, null)).toBe(false)
  })
})
