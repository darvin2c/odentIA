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
    /** Lo escribió Kairós solo: va con su nombre. */
    byKairos: z.boolean().default(false),
    /** Solo WhatsApp: cuándo llegó al teléfono y cuándo lo leyó (lo informa Meta). */
    deliveredAt: z.string().nullable().default(null),
    readAt: z.string().nullable().default(null),
    /** En qué se basó Kairós para responder («los precios de la web», «la guía de la Ayuda: …»). */
    basis: z.array(z.string()).default([]),
    /** El archivo que salió en este mensaje (en un chat, cada archivo es su propio mensaje). */
    files: z
      .array(
        z.object({
          id: z.string(),
          filename: z.string(),
          contentType: z.string().default(""),
          size: z.number().default(0),
        }),
      )
      .default([]),
  }),
])
export type ChatEntry = z.infer<typeof entrySchema>

/** Lo que el canal acepta, como lo dice el servidor (el editor lo cuenta antes de enviar). */
export const channelRulesSchema = z.object({
  channel: z.string(),
  maxChars: z.number().nullable(),
  maxBytes: z.number().nullable(),
  maxFiles: z.number().int().nonnegative(),
  maxTotalBytes: z.number().nullable(),
  files: z.array(z.object({ kind: z.string(), types: z.array(z.string()), maxBytes: z.number() })),
  formatting: z.enum(["markdown", "whatsapp", "texto"]),
})

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
    .object({
      id: z.string(),
      name: z.string(),
      product: z.string(),
      hasAccount: z.boolean(),
      phase: z.string().nullable().default(null),
    })
    .nullable(),
  contact: z.object({ id: z.string(), name: z.string(), phone: z.string().nullable() }).nullable(),
  notClinicAt: z.string().nullable(),
  /** «Lo atiendo yo» o Kairós la pasó al equipo: mientras tenga fecha, Kairós no responde solo. */
  kairosPausedAt: z.string().nullable().default(null),
  /** Kairós responde solo aquí ahora. */
  handledByKairos: z.boolean().default(false),
  /** Kairós podría atenderla si no estuviera pausada (está prendido y no es de una clínica con su app). */
  kairosAvailable: z.boolean().default(false),
  kairosPausedBy: z.object({ userId: z.string(), name: z.string() }).nullable().default(null),
  kairosHandover: z.object({ at: z.string(), why: z.string().nullable() }).nullable().default(null),
  lastInboundAt: z.string().nullable(),
  canReplyFreely: z.boolean(),
  freeUntil: z.string().nullable(),
  replySignature: z.string(),
  suggestion: suggestionSchema.nullable().default(null),
  entries: z.array(entrySchema),
  files: z.array(fileSchema).default([]),
  /** Lo que acepta el canal: largo del texto y archivos. */
  rules: channelRulesSchema.nullable().default(null),
  /** En la Bandeja: su estado, quién la atiende y si se marcó «No necesita respuesta». */
  state: z.string().nullable().default(null),
  stateWhy: z.string().nullable().default(null),
  attendedBy: z.object({ id: z.string(), name: z.string() }).nullable().default(null),
  settledAt: z.string().nullable().default(null),
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

/** El enlace de siempre: abre WhatsApp en otra pestaña con ese número. */
export const waMeHref = (phone: string) => `https://wa.me/${phone.replace(/^\+/, "")}`

/**
 * Ese celular ya escribió y falta decir de quién es (409 `CHAT_UNASSIGNED`): la
 * conversación que hay que decidir. El celular solo no la liga.
 */
export function unassignedChatOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.shape.code !== "CHAT_UNASSIGNED") return null
  const chatId = error.shape.fields?.chatId
  return typeof chatId === "string" && chatId ? chatId : null
}

/**
 * Qué hacer si «Escribir por WhatsApp» no abre la conversación: Administración
 * dice de quién es la que ya escribió («¿De quién es?»); Soporte, si no la ve
 * (404) o no puede abrirla (409), sigue por wa.me como antes, con el aviso si
 * es eso. Lo demás es un error que se dice.
 */
export type OpenChatOutcome =
  | { kind: "decidir"; chatId: string }
  | { kind: "wa.me"; message: string | null }
  | { kind: "error" }

export function openChatOutcome(error: unknown, isAdmin: boolean): OpenChatOutcome {
  const chatId = unassignedChatOf(error)
  if (isAdmin) return chatId ? { kind: "decidir", chatId } : { kind: "error" }
  if (error instanceof ApiError && (error.status === 404 || error.status === 409))
    return { kind: "wa.me", message: chatId ? (error.shape.message ?? null) : null }
  return { kind: "error" }
}

export const assignChatTo = (
  chatId: string,
  body: { clientId: string; contactId?: string | null },
) => api(`/api/admin/chats/${enc(chatId)}/assign`, { method: "POST", body: JSON.stringify(body) })

/** «Lo atiendo yo»: Kairós deja de responder solo en esta conversación. */
export const pauseKairos = (chatId: string) =>
  api(`/api/admin/chats/${enc(chatId)}/kairos-pause`, { method: "POST", body: "{}" })

/** «Devolver a Kairós»: vuelve a responder solo lo que siga sin respuesta y lo que llegue. */
export const resumeKairos = (chatId: string) =>
  api(`/api/admin/chats/${enc(chatId)}/kairos-pause`, { method: "DELETE" })

/**
 * Quién atiende la conversación, en palabras: Kairós, una persona («Lo atiendes
 * tú», «Lo atiende Ana») o el equipo porque Kairós se la pasó (con su motivo).
 * Nulo si Kairós no tiene nada que ver (apagado o clínica con su app) y nadie la pausó.
 */
export type KairosChatState =
  | { kind: "kairos" }
  | { kind: "persona"; words: string; canReturn: boolean }
  | { kind: "paso"; why: string | null; canReturn: boolean }

export function kairosChatState(
  chat: Pick<
    ChatDetail,
    "handledByKairos" | "kairosAvailable" | "kairosPausedAt" | "kairosPausedBy" | "kairosHandover"
  >,
  myUserId: string,
): KairosChatState | null {
  if (chat.handledByKairos) return { kind: "kairos" }
  if (!chat.kairosPausedAt) return null
  if (chat.kairosHandover)
    return { kind: "paso", why: chat.kairosHandover.why, canReturn: chat.kairosAvailable }
  // Pausada por una persona: solo se dice si Kairós la atendería (si no, no hay nada que devolver).
  if (!chat.kairosAvailable) return null
  const by = chat.kairosPausedBy
  const words =
    by?.userId === myUserId
      ? "Lo atiendes tú: Kairós no responde solo aquí."
      : `Lo atiende ${by?.name.trim().split(/\s+/)[0] || "alguien del equipo"}: Kairós no responde solo aquí.`
  return { kind: "persona", words, canReturn: true }
}

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

const sentSchema = z.object({
  outreachId: z.string(),
  status: z.string(),
  /** El texto y cada archivo salen como mensajes aparte, cada uno con su estado. */
  parts: z
    .array(
      z.object({
        outreachId: z.string(),
        kind: z.enum(["texto", "archivo"]),
        filename: z.string().nullable(),
        status: z.string(),
      }),
    )
    .default([]),
})

/** Responder con texto libre (dentro de las 24 h), con archivos de Documentos si hay cliente. */
export async function sendChatReply(
  chatId: string,
  body: { body?: string; adminOnly?: boolean; proposalId?: string; fileIds?: string[] },
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
/**
 * Cuánto puede estar pendiente un envío mientras sale (la ruta lo anota apenas
 * Meta responde): el mismo plazo con que el servidor deja resolverlo a mano.
 */
export const CHAT_SEND_SETTLE_MS = 10 * 60_000

/**
 * Pide «¿Salió?»: lo incierto, o lo pendiente de hace 10 minutos o más (la API
 * se cortó entre reservarlo y enviarlo). Antes, se está enviando.
 */
export const isUnsettled = (entry: ChatEntry, now: Date) =>
  entry.kind === "salio" &&
  (entry.status === "incierto" ||
    (entry.status === "pendiente" && now.getTime() - Date.parse(entry.at) >= CHAT_SEND_SETTLE_MS))

/**
 * Cómo le fue a un mensaje nuestro: «Leído» o «Entregado» si WhatsApp lo dijo, y si no su estado
 * («Salió», «No salió», «No se sabe si salió»).
 */
export function sentStatusWords(entry: Extract<ChatEntry, { kind: "salio" }>): string {
  if (entry.status === "enviado" && entry.readAt) return "Leído"
  if (entry.status === "enviado" && entry.deliveredAt) return "Entregado"
  return CHAT_SEND_STATUS_WORDS[entry.status] ?? entry.status
}

/** «Ana Ruiz · 17:42 · Leído» de un mensaje nuestro. */
export function sentLineWords(entry: Extract<ChatEntry, { kind: "salio" }>): string {
  const who = entry.byKairos ? "Kairós" : entry.createdBy?.name?.trim() || "El equipo"
  return `${who} · ${supportTime(entry.sentAt ?? entry.at)} · ${sentStatusWords(entry)}`
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
