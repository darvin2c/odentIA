/**
 * Las conversaciones de la administración por WhatsApp, Instagram y Messenger
 * (`/api/admin/chats`): su esquema, sus lecturas y sus envíos, y las palabras
 * con que se dicen. Soporte solo recibe lo de una clínica con su app (lo demás
 * es 404 en el servidor), sin archivos ni lo marcado «Solo administración».
 */
import { useQuery } from "@tanstack/react-query"
import { z } from "zod"
import { ApiError, api } from "../../lib/api"
import { supportDay, supportDayTime, supportTime } from "../../lib/support-words"
import { deleteOnWords } from "./client-files-tab"

const enc = encodeURIComponent

export const CHAT_CHANNELS = ["whatsapp", "instagram", "messenger"] as const
export type ChatChannel = (typeof CHAT_CHANNELS)[number]

/** Un canal que no se conoce se lee como WhatsApp: el texto no rompe la pantalla. */
export const chatChannelOf = (value: unknown): ChatChannel =>
  (CHAT_CHANNELS as readonly unknown[]).includes(value) ? (value as ChatChannel) : "whatsapp"

export const CHAT_CHANNEL_WORDS: Record<ChatChannel, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
}

const suggestionSchema = z.object({
  contactId: z.string(),
  contactName: z.string(),
  clientId: z.string(),
  clientName: z.string(),
})
export type ChatSuggestion = z.infer<typeof suggestionSchema>

const entrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("entro"),
    id: z.string(),
    at: z.string(),
    body: z.string().nullable(),
    media: z
      .array(
        z.object({
          filename: z.string(),
          mimeType: z.string(),
          size: z.number(),
          fileId: z.string().nullable(),
        }),
      )
      .default([]),
    mediaCount: z.number().int().nonnegative().default(0),
  }),
  z.object({
    kind: z.literal("salio"),
    id: z.string(),
    at: z.string(),
    body: z.string(),
    status: z.string(),
    template: z.string().nullable(),
    adminOnly: z.boolean(),
    createdBy: z.object({ userId: z.string(), name: z.string() }).nullable(),
    sentAt: z.string().nullable(),
  }),
])
export type ChatEntry = z.infer<typeof entrySchema>

const fileSchema = z.object({
  fileId: z.string(),
  messageId: z.string().nullable(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  kind: z.enum(["correo", "archivo_clinica"]),
  deleteAfter: z.string().nullable(),
  deleted: z.boolean(),
  cargaDeleteAfter: z.string().nullable().default(null),
  cargaDueNow: z.boolean().default(false),
})
export type ChatFile = z.infer<typeof fileSchema>

export const chatDetailSchema = z.object({
  id: z.string(),
  channel: z.string().transform(chatChannelOf),
  address: z.string(),
  displayName: z.string().nullable(),
  client: z
    .object({ id: z.string(), name: z.string(), product: z.string(), hasAccount: z.boolean() })
    .nullable(),
  contact: z.object({ id: z.string(), name: z.string(), phone: z.string().nullable() }).nullable(),
  notClinicAt: z.string().nullable(),
  lastInboundAt: z.string().nullable(),
  canReplyFreely: z.boolean(),
  freeUntil: z.string().nullable(),
  replySignature: z.string(),
  suggestion: suggestionSchema.nullable().default(null),
  entries: z.array(entrySchema),
  files: z.array(fileSchema).default([]),
})
export type ChatDetail = z.infer<typeof chatDetailSchema>

export const chatKey = (chatId: string) => ["admin", "chat", chatId] as const
export const chatsConfigKey = ["admin", "chats", "config"] as const

export function useChat(chatId: string, enabled = true) {
  return useQuery({
    queryKey: chatKey(chatId),
    enabled,
    queryFn: async () =>
      chatDetailSchema.parse(await api<unknown>(`/api/admin/chats/${enc(chatId)}`)),
  })
}

const configSchema = z.object({
  whatsapp: z.boolean(),
  instagram: z.boolean(),
  messenger: z.boolean(),
})

/**
 * Qué canales tiene configurados la administración. Mientras el WhatsApp de
 * Sallca no esté, «Escribir por WhatsApp» sigue abriendo wa.me como antes; si
 * no se puede leer, también (nada se rompe).
 */
export function useChatsConfig() {
  return useQuery({
    queryKey: chatsConfigKey,
    staleTime: 5 * 60_000,
    queryFn: async () => configSchema.parse(await api<unknown>("/api/admin/chats/config")),
  })
}

/** La conversación de WhatsApp con esa persona del cliente, creada si no existe. */
export async function openChatWith(clientId: string, contactId: string): Promise<ChatDetail> {
  return chatDetailSchema.parse(
    await api<unknown>("/api/admin/chats/open", {
      method: "POST",
      body: JSON.stringify({ clientId, contactId, channel: "whatsapp" }),
    }),
  )
}

export const assignChatTo = (
  chatId: string,
  body: { clientId: string; contactId?: string | null },
) => api(`/api/admin/chats/${enc(chatId)}/assign`, { method: "POST", body: JSON.stringify(body) })

export const markNotClinic = (chatId: string) =>
  api(`/api/admin/chats/${enc(chatId)}/not-clinic`, { method: "POST", body: "{}" })

export const undoNotClinic = (chatId: string) =>
  api(`/api/admin/chats/${enc(chatId)}/not-clinic`, { method: "DELETE" })

/**
 * El envío no salió (502 `SEND_REJECTED`) o no se sabe si salió (502
 * `SEND_UNKNOWN`): en los dos queda el envío con su estado y nunca se reintenta.
 */
export class ChatSendError extends Error {
  constructor(
    public outcome: "rechazado" | "incierto",
    public outreachId: string | null,
    message: string,
  ) {
    super(message)
  }
}

function sendErrorOf(error: unknown): unknown {
  if (
    error instanceof ApiError &&
    (error.shape.code === "SEND_UNKNOWN" || error.shape.code === "SEND_REJECTED")
  ) {
    const outreachId =
      typeof error.details.outreachId === "string" ? error.details.outreachId : null
    return new ChatSendError(
      error.shape.code === "SEND_UNKNOWN" ? "incierto" : "rechazado",
      outreachId,
      error.shape.message ?? "No se sabe si el mensaje salió",
    )
  }
  return error
}

const sentSchema = z.object({ outreachId: z.string(), status: z.string() })

/** Responder con texto libre (dentro de las 24 h). */
export async function sendChatReply(
  chatId: string,
  body: { body: string; adminOnly?: boolean; proposalId?: string },
): Promise<z.infer<typeof sentSchema>> {
  try {
    return sentSchema.parse(
      await api<unknown>(`/api/admin/chats/${enc(chatId)}/reply`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    )
  } catch (error) {
    throw sendErrorOf(error)
  }
}

/** Fuera de las 24 h, en WhatsApp: la plantilla aprobada para retomar. */
export async function sendChatRetomar(chatId: string): Promise<z.infer<typeof sentSchema>> {
  try {
    return sentSchema.parse(
      await api<unknown>(`/api/admin/chats/${enc(chatId)}/retomar`, { method: "POST", body: "{}" }),
    )
  } catch (error) {
    throw sendErrorOf(error)
  }
}

/* ---------- Palabras ---------- */

const LIMA = "America/Lima"
const dayKeyFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: LIMA,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})
const dayKey = (date: Date) => dayKeyFormat.format(date)
const dayOffset = (iso: string, now: Date): number => {
  const day = Date.parse(`${dayKey(new Date(iso))}T00:00:00Z`)
  const today = Date.parse(`${dayKey(now)}T00:00:00Z`)
  return Math.round((day - today) / 86_400_000)
}

/** «hoy 09:05», «ayer 19:30», «mañana 10:12» o «mié 11 nov, 10:12» (en Lima). */
export function momentWords(iso: string, now: Date = new Date()): string {
  const offset = dayOffset(iso, now)
  if (offset === 0) return `hoy ${supportTime(iso)}`
  if (offset === -1) return `ayer ${supportTime(iso)}`
  if (offset === 1) return `mañana ${supportTime(iso)}`
  return supportDayTime(iso)
}

/** El título de un día en la conversación: «Hoy», «Ayer» o «mié 11 nov». */
export function dayHeading(iso: string, now: Date = new Date()): string {
  const offset = dayOffset(iso, now)
  if (offset === 0) return "Hoy"
  if (offset === -1) return "Ayer"
  return supportDay(iso)
}

/** Las entradas agrupadas por día de Lima, en el orden en que llegan. */
export function entriesByDay(
  entries: readonly ChatEntry[],
  now: Date = new Date(),
): Array<{ key: string; heading: string; entries: ChatEntry[] }> {
  const days: Array<{ key: string; heading: string; entries: ChatEntry[] }> = []
  for (const entry of entries) {
    const key = dayKey(new Date(entry.at))
    const last = days[days.length - 1]
    if (last && last.key === key) last.entries.push(entry)
    else days.push({ key, heading: dayHeading(entry.at, now), entries: [entry] })
  }
  return days
}

/** «+51 987 100 001» (solo agrupa el Perú; otros números, tal cual). */
export function phoneWords(address: string): string {
  const peru = /^\+51(9\d{2})(\d{3})(\d{3})$/.exec(address)
  return peru ? `+51 ${peru[1]} ${peru[2]} ${peru[3]}` : address
}

/** Quién escribe: la persona del cliente, el nombre que dio Meta o su celular. */
export function chatPartyWords(
  chat: Pick<ChatDetail, "channel" | "address" | "displayName" | "contact">,
) {
  if (chat.contact) return chat.contact.name
  if (chat.displayName) return chat.displayName
  return chat.channel === "whatsapp" ? phoneWords(chat.address) : "una cuenta sin nombre"
}

/** «WhatsApp con Luis Paredes», «Instagram con @dra.melissa», «Messenger con Ana». */
export function chatTitle(
  chat: Pick<ChatDetail, "channel" | "address" | "displayName" | "contact">,
) {
  return `${CHAT_CHANNEL_WORDS[chat.channel]} con ${chatPartyWords(chat)}`
}

/** Debajo del título: el número y a dónde escribe, o la cuenta. */
export function chatSubtitle(
  chat: Pick<ChatDetail, "channel" | "address" | "displayName" | "client">,
) {
  const where = chat.client ? ` · ${chat.client.name}` : " · sin cliente todavía"
  if (chat.channel === "whatsapp")
    return `${phoneWords(chat.address)} · al número de Sallca${where}`
  const account = chat.displayName ?? "una cuenta"
  return `${account} · a la página de Sallca${where}`
}

/** Lo que dice el aviso de las 24 h (o por qué ya no se puede con texto libre). */
export function freeWindowWords(
  chat: Pick<ChatDetail, "channel" | "canReplyFreely" | "freeUntil" | "lastInboundAt">,
  now: Date = new Date(),
): string {
  const channel = CHAT_CHANNEL_WORDS[chat.channel]
  if (chat.canReplyFreely && chat.freeUntil)
    return chat.channel === "whatsapp"
      ? `Puedes responder con texto libre hasta ${momentWords(chat.freeUntil, now)} (24 h desde su último mensaje). Después, solo con una plantilla aprobada, o por correo.`
      : `Puedes responder hasta ${momentWords(chat.freeUntil, now)} (24 h desde su último mensaje). Después, ${channel} ya no deja escribirle: solo por correo o por WhatsApp.`
  if (!chat.lastInboundAt)
    return chat.channel === "whatsapp"
      ? "Todavía no escribió a este número: WhatsApp solo deja empezar con la plantilla aprobada."
      : `Todavía no escribió por ${channel}: escríbele un correo o por WhatsApp.`
  return chat.channel === "whatsapp"
    ? `Pasaron 24 horas desde su último mensaje (${momentWords(chat.lastInboundAt, now)}): WhatsApp solo deja retomar con la plantilla aprobada, o escríbele un correo.`
    : `Pasaron 24 horas desde su último mensaje (${momentWords(chat.lastInboundAt, now)}): ${channel} ya no deja responderle. Escríbele un correo o por WhatsApp.`
}

/** Lo que dice la ayuda de «Enviar»: por dónde sale y con qué firma. */
export function replyHelpWords(chat: Pick<ChatDetail, "channel" | "replySignature">): string {
  const signature = chat.replySignature.replace(/^—\s*/, "")
  const from =
    chat.channel === "whatsapp"
      ? "Sale desde el número de Sallca"
      : "Sale desde la página de Sallca"
  return `${from}, firmado «${signature}». Si no se sabe si salió, queda «No se sabe si salió» y no se reintenta.`
}

export const CHAT_SEND_STATUS_WORDS: Record<string, string> = {
  pendiente: "Enviando…",
  enviado: "Salió",
  incierto: "No se sabe si salió",
  no_salio: "No salió",
}

/** Lo que espera que una persona diga si salió (nunca se reenvía solo). */
export const isUnsettled = (entry: ChatEntry) =>
  entry.kind === "salio" && (entry.status === "pendiente" || entry.status === "incierto")

/** «Ana Ruiz · 17:42 · Salió» de un mensaje nuestro. */
export function sentLineWords(entry: Extract<ChatEntry, { kind: "salio" }>): string {
  const who = entry.createdBy?.name?.trim() || "El equipo"
  return `${who} · ${supportTime(entry.sentAt ?? entry.at)} · ${CHAT_SEND_STATUS_WORDS[entry.status] ?? entry.status}`
}

/** El tipo de un archivo en palabras cortas («XLSX», «PDF», «Audio»…). */
export function chatFileTypeWords(contentType: string, filename: string): string {
  const type = contentType.toLowerCase()
  if (type === "application/pdf") return "PDF"
  if (type.startsWith("image/")) return "Imagen"
  if (type.startsWith("audio/")) return "Audio"
  if (type.startsWith("video/")) return "Video"
  if (type === "text/csv") return "CSV"
  const ext = /\.([a-z0-9]{2,5})$/i.exec(filename)?.[1]
  if (type.includes("spreadsheetml") || type.includes("excel"))
    return ext ? ext.toUpperCase() : "Excel"
  if (type.includes("wordprocessingml") || type.includes("msword"))
    return ext ? ext.toUpperCase() : "Word"
  return ext ? ext.toUpperCase() : "Archivo"
}

/**
 * Un archivo de la conversación: guardado en Documentos (se puede marcar como
 * la carga), ya marcado como la carga (con el día que da el servidor) o borrado.
 */
export function chatFileState(file: ChatFile): { words: string; canMark: boolean } {
  if (file.deleted) return { words: "Se borró", canMark: false }
  if (file.kind === "archivo_clinica")
    return {
      words: file.deleteAfter
        ? `Es la carga de datos · ${deleteOnWords(file.deleteAfter)}`
        : "Es la carga de datos",
      canMark: false,
    }
  return { words: "Guardado en Documentos · solo Administración", canMark: true }
}
