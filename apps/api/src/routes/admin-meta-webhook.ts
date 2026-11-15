import {
  type ChannelAdapter,
  instagramAdapter,
  messengerAdapter,
  metaGraphVersion,
  type NormalizedInbound,
  splitWhatsAppWebhook,
  verifyMetaChallenge,
  verifyMetaSignature,
  whatsappCloudApiAdapter,
} from "@odentia/channels"
import type { Db } from "@odentia/db"
import { type SaasChatChannel, saasChat, saasInboundMessage } from "@odentia/db/schema/admin-arm"
import {
  type AdminChannels,
  applyChatStatus,
  CHAT_MEDIA_MAX,
  type ChatMetaStatus,
  inboundAttachmentKey,
  ingestInboundChat,
  type Storage,
} from "@odentia/services"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { errorBody } from "../lib/error.js"
import { allowedInboundAttachment } from "./inbound-email.js"

/**
 * La dirección de avisos de la app de Meta de la administración
 * (`/api/webhooks/meta/admin`, ADR 0188): lo que le escriben a Sallca por
 * WhatsApp, Messenger o Instagram entra al ARM como el correo. Es otra app que
 * la de las clínicas: un aviso firmado con `META_APP_SECRET` no vale aquí (401),
 * y nada de lo que llega aquí toca una clínica.
 *
 * Por `object`: `whatsapp_business_account` (solo lo del número de Sallca),
 * `page` (solo su página) e `instagram` (solo su cuenta); lo de otro número o
 * cuenta se ignora con 200. Cada mensaje entra una sola vez por su id de Meta;
 * sus archivos se bajan y se suben antes de la transacción, solo los tipos
 * permitidos por sus bytes, y se borran si el mensaje era repetido o falló. Un
 * mensaje que falla no frena a los demás ni cambia la respuesta: Meta reintenta
 * lo que no recibe un 200, y un reintento ya registrado no entra dos veces.
 *
 * Estados (solo WhatsApp): por el `wamid` o por `biz_opaque_callback_data`, que
 * lleva el id del envío; resuelven un envío pendiente o incierto.
 *
 * Sin probar contra Meta: la app de la administración todavía no existe.
 */
export interface AdminMetaWebhookDeps {
  /** Las tablas del ARM viven en `admin`, sin GRANT a la app. */
  ownerDb: Db
  storage: Pick<Storage, "putAttachmentAt" | "deleteAttachment">
  /** Sin canales configurados la dirección no existe (404). */
  channels?: AdminChannels | undefined
  /** Solo las pruebas lo cambian: bajar archivos y leer el nombre de quien escribe. */
  fetch?: typeof fetch
  now?: () => Date
}

/** Un aviso de Meta no pesa más que esto (los archivos no vienen dentro). */
const WEBHOOK_BODY_MAX = 2 * 1024 * 1024
/** Un archivo de más de esto no se guarda (WhatsApp deja hasta 100 MB). */
export const ADMIN_CHAT_MEDIA_BYTES_MAX = 25 * 1024 * 1024
const PROFILE_TIMEOUT_MS = 5_000

type AttachmentKind = { contentType: string; ext: string }

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  return bytes.byteLength >= at + prefix.length && prefix.every((byte, i) => bytes[at + i] === byte)
}

/**
 * Lo que se guarda de un mensaje: lo mismo que del correo y, además, los audios
 * (D7: se guardan como archivo, sin transcribir), todo por sus bytes.
 */
export function allowedChatAttachment(
  bytes: Uint8Array,
  filename: string,
  declared: string,
): AttachmentKind | null {
  const kind = allowedInboundAttachment(bytes, filename, declared)
  if (kind) return kind
  // OGG (las notas de voz de WhatsApp, Opus).
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return { contentType: "audio/ogg", ext: "ogg" }
  // MP3: con etiqueta ID3 o empezando por un cuadro.
  if (
    startsWith(bytes, [0x49, 0x44, 0x33]) ||
    (bytes.byteLength > 1 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
  )
    return { contentType: "audio/mpeg", ext: "mp3" }
  // AMR (audios de teléfonos viejos).
  if (startsWith(bytes, [0x23, 0x21, 0x41, 0x4d, 0x52]))
    return { contentType: "audio/amr", ext: "amr" }
  // M4A / AAC en MP4: `ftyp` en el byte 4 y una marca de audio.
  if (
    startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4) &&
    declared.trim().toLowerCase().startsWith("audio/")
  )
    return { contentType: "audio/mp4", ext: "m4a" }
  return null
}

/** Un mensaje ya listo para entrar: de quién, qué dijo y lo que hay que bajar. */
interface PendingMessage {
  channel: SaasChatChannel
  address: string
  waId: string | null
  displayName: string | null
  externalId: string
  body: string | null
  receivedAt: Date
  media: { externalId: string; mimeType: string; filename: string | null } | null
}

interface WaStatusRow {
  id: string
  status: ChatMetaStatus
  callbackData: string | null
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/**
 * Los nombres de archivo de los documentos y los estados de lo que envió el
 * número, leídos del aviso crudo: lo normalizado no trae ni el nombre del
 * documento, ni el estado `sent`, ni `biz_opaque_callback_data`.
 */
function readWhatsAppRaw(rawBody: string, phoneNumberId: string) {
  const filenames = new Map<string, string>()
  const statuses: WaStatusRow[] = []
  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return { filenames, statuses }
  }
  const entries = (body as { entry?: unknown }).entry
  if (!Array.isArray(entries)) return { filenames, statuses }
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes
    if (!Array.isArray(changes)) continue
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value
      if (!value || typeof value !== "object") continue
      const metadata = value["metadata"] as { phone_number_id?: unknown } | undefined
      if (text(metadata?.phone_number_id) !== phoneNumberId) continue
      for (const message of Array.isArray(value["messages"]) ? value["messages"] : []) {
        const id = text((message as { id?: unknown }).id)
        const filename = text((message as { document?: { filename?: unknown } }).document?.filename)
        if (id && filename) filenames.set(id, filename)
      }
      for (const raw of Array.isArray(value["statuses"]) ? value["statuses"] : []) {
        const row = raw as { id?: unknown; status?: unknown; biz_opaque_callback_data?: unknown }
        const id = text(row.id)
        const status = text(row.status)
        if (!id || !status || !["sent", "delivered", "read", "failed"].includes(status)) continue
        statuses.push({
          id,
          status: status as ChatMetaStatus,
          callbackData: text(row.biz_opaque_callback_data),
        })
      }
    }
  }
  return { filenames, statuses }
}

/** Cuándo lo envió según Meta; si no se entiende, ahora. */
function sentAt(message: NormalizedInbound, now: Date): Date {
  const at = new Date(message.sentAt)
  return Number.isNaN(at.getTime()) ? now : at
}

/** El número E.164 de quien escribe por WhatsApp (`wa:51…`); nulo si ocultó su número. */
function whatsappAddress(senderExternalId: string): string | null {
  const digits = senderExternalId.startsWith("wa:") ? senderExternalId.slice(3) : senderExternalId
  return /^[1-9][0-9]{6,14}$/.test(digits) ? `+${digits}` : null
}

/** Lo que dice un mensaje normalizado: su texto o su archivo. Ubicaciones y reacciones no entran. */
function contentOf(message: NormalizedInbound): Pick<PendingMessage, "body" | "media"> | null {
  const content = message.content
  if (content.type === "text") return { body: content.text, media: null }
  if (content.type === "media")
    return {
      body: content.caption ?? null,
      media: { externalId: content.mediaExternalId, mimeType: content.mimeType, filename: null },
    }
  return null
}

export function createAdminMetaWebhookRoute(deps: AdminMetaWebhookDeps) {
  const app = new Hono()
  const clock = deps.now ?? (() => new Date())
  const fetchImpl = deps.fetch ?? fetch

  app.get("/", (c) => {
    const channels = deps.channels
    if (!channels) return c.json(errorBody(c, "NOT_FOUND", "Recurso no encontrado"), 404)
    const challenge = verifyMetaChallenge(
      {
        mode: c.req.query("hub.mode") ?? null,
        token: c.req.query("hub.verify_token") ?? null,
        challenge: c.req.query("hub.challenge") ?? null,
      },
      channels.verifyToken,
    )
    if (challenge === null) return c.json(errorBody(c, "FORBIDDEN", "Verificación inválida"), 403)
    return c.text(challenge, 200)
  })

  /** Quién escribe por Messenger o Instagram, si Meta lo dice; nulo si no (nunca frena el mensaje). */
  async function profileName(
    channel: "messenger" | "instagram",
    userId: string,
    token: string,
  ): Promise<string | null> {
    try {
      const fields = channel === "instagram" ? "name,username" : "name"
      const response = await fetchImpl(
        `https://graph.facebook.com/${metaGraphVersion()}/${encodeURIComponent(userId)}?fields=${fields}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
        },
      )
      if (!response.ok) return null
      const json = (await response.json().catch(() => null)) as {
        name?: unknown
        username?: unknown
      } | null
      const username = text(json?.username)
      return username ? `@${username}` : text(json?.name)
    } catch {
      return null
    }
  }

  /** Baja, revisa y sube el archivo; nulo si no se pudo o no es de los que se guardan. */
  async function storeMedia(
    adapter: ChannelAdapter,
    config: Record<string, unknown>,
    message: PendingMessage,
  ): Promise<{ objectKey: string; mimeType: string; filename: string; size: number } | null> {
    const media = message.media
    if (!media) return null
    if (!deps.storage.putAttachmentAt) {
      console.warn(
        `[admin-meta] sin almacenamiento: no se guardó el archivo de ${message.externalId}`,
      )
      return null
    }
    let fetched: { bytes: Uint8Array; mimeType: string; filename: string }
    try {
      if (!adapter.fetchMedia) return null
      fetched = await adapter.fetchMedia(config, media.externalId, { fetch: fetchImpl })
    } catch (error) {
      console.warn(`[admin-meta] no se pudo bajar el archivo de ${message.externalId}`, error)
      return null
    }
    if (fetched.bytes.byteLength > ADMIN_CHAT_MEDIA_BYTES_MAX) {
      console.warn(`[admin-meta] archivo de ${message.externalId} descartado: pasa de 25 MB`)
      return null
    }
    const name = media.filename ?? fetched.filename
    const kind = allowedChatAttachment(fetched.bytes, name, fetched.mimeType || media.mimeType)
    if (!kind) {
      console.warn(`[admin-meta] archivo de ${message.externalId} descartado: tipo no permitido`)
      return null
    }
    const objectKey = inboundAttachmentKey(kind.ext)
    await deps.storage.putAttachmentAt(objectKey, fetched.bytes, kind.contentType)
    // El nombre que puso la persona (documentos de WhatsApp), el de la dirección del archivo
    // (Messenger, Instagram) o «whatsapp-2026-11-14», siempre con la extensión real.
    const base = name.replace(/\.[A-Za-z0-9]{1,8}$/, "").slice(0, 120)
    const generic = !base || base === "adjunto" || base === media.externalId
    const filename =
      media.filename ??
      `${generic ? `${message.channel}-${message.receivedAt.toISOString().slice(0, 10)}` : base}.${kind.ext}`
    return { objectKey, mimeType: kind.contentType, filename, size: fetched.bytes.byteLength }
  }

  /** Un mensaje: si ya llegó no se baja nada; si no, archivos primero y después la transacción. */
  async function ingestOne(
    adapter: ChannelAdapter,
    config: Record<string, unknown>,
    message: PendingMessage,
    now: Date,
  ): Promise<void> {
    const [known] = await deps.ownerDb
      .select({ id: saasInboundMessage.id })
      .from(saasInboundMessage)
      .where(eq(saasInboundMessage.externalId, message.externalId))
      .limit(1)
    if (known) return
    const uploaded: { objectKey: string; mimeType: string; filename: string; size: number }[] = []
    const removeUploaded = async () => {
      for (const file of uploaded)
        await deps.storage.deleteAttachment(file.objectKey).catch(() => {})
    }
    try {
      const stored = await storeMedia(adapter, config, message)
      if (stored) uploaded.push(stored)
      let displayName = message.displayName
      if (!displayName && (message.channel === "messenger" || message.channel === "instagram")) {
        // Solo la primera vez: después la conversación ya tiene su nombre.
        const [chat] = await deps.ownerDb
          .select({ displayName: saasChat.displayName })
          .from(saasChat)
          .where(and(eq(saasChat.channel, message.channel), eq(saasChat.address, message.address)))
          .limit(1)
        if (!chat?.displayName) {
          const token =
            typeof config["pageAccessToken"] === "string" ? config["pageAccessToken"] : ""
          displayName = await profileName(message.channel, message.address, token)
        }
      }
      const result = await deps.ownerDb.transaction((tx) =>
        ingestInboundChat(
          tx as Db,
          {
            channel: message.channel,
            address: message.address,
            waId: message.waId,
            displayName,
            externalId: message.externalId,
            body: message.body,
            media: uploaded.slice(0, CHAT_MEDIA_MAX),
            receivedAt: message.receivedAt,
          },
          now,
        ),
      )
      // Otra entrega del mismo mensaje ganó la carrera: lo subido aquí sobra.
      if (result.duplicate) await removeUploaded()
    } catch (error) {
      await removeUploaded()
      throw error
    }
  }

  app.post(
    "/",
    bodyLimit({
      maxSize: WEBHOOK_BODY_MAX,
      onError: (c) => c.json(errorBody(c, "BODY_TOO_LARGE", "El aviso pesa demasiado"), 413),
    }),
    async (c) => {
      const channels = deps.channels
      if (!channels) return c.json(errorBody(c, "NOT_FOUND", "Recurso no encontrado"), 404)
      const rawBody = await c.req.text().catch(() => "")
      if (!verifyMetaSignature(c.req.header(), rawBody, channels.appSecret))
        return c.json(errorBody(c, "UNAUTHORIZED", "Firma inválida"), 401)
      let parsed: { object?: unknown; entry?: unknown }
      try {
        parsed = JSON.parse(rawBody) as { object?: unknown; entry?: unknown }
      } catch {
        return c.json({ ok: true }, 200)
      }
      const now = clock()
      const object = typeof parsed?.object === "string" ? parsed.object : ""
      const pending: {
        adapter: ChannelAdapter
        config: Record<string, unknown>
        message: PendingMessage
      }[] = []
      let statuses: WaStatusRow[] = []

      if (object === "whatsapp_business_account" && channels.whatsapp) {
        const wa = channels.whatsapp
        // `wabaId` solo lo usan las plantillas de la cuenta: enviar y bajar archivos no.
        const config = {
          phoneNumberId: wa.phoneNumberId,
          wabaId: wa.phoneNumberId,
          accessToken: wa.accessToken,
        }
        const raw = readWhatsAppRaw(rawBody, wa.phoneNumberId)
        statuses = raw.statuses
        for (const delivery of splitWhatsAppWebhook(rawBody)) {
          if (delivery.kind !== "number" || delivery.phoneNumberId !== wa.phoneNumberId) continue
          for (const message of delivery.messages) {
            // Lo que escribió el equipo desde el celular o el historial no es de la persona.
            if (message.fromBusinessApp || message.history) continue
            const content = contentOf(message)
            if (!content) continue
            const address = whatsappAddress(message.senderExternalId)
            if (!address) {
              console.warn(
                `[admin-meta] mensaje ${message.externalMessageId} sin número (lo ocultó): no entra`,
              )
              continue
            }
            pending.push({
              adapter: whatsappCloudApiAdapter,
              config,
              message: {
                channel: "whatsapp",
                address,
                waId: message.senderUserId ?? address.slice(1),
                displayName: message.senderDisplayName ?? null,
                externalId: message.externalMessageId,
                ...content,
                media: content.media
                  ? {
                      ...content.media,
                      filename: raw.filenames.get(message.externalMessageId) ?? null,
                    }
                  : null,
                receivedAt: sentAt(message, now),
              },
            })
          }
        }
      } else if (
        (object === "page" && channels.messenger) ||
        (object === "instagram" && channels.instagram)
      ) {
        const channel: "messenger" | "instagram" = object === "page" ? "messenger" : "instagram"
        const account =
          channel === "messenger"
            ? {
                own: channels.messenger?.pageId ?? "",
                token: channels.messenger?.accessToken ?? "",
              }
            : {
                own: channels.instagram?.accountId ?? "",
                token: channels.instagram?.accessToken ?? "",
              }
        const { own, token } = account
        const adapter = channel === "messenger" ? messengerAdapter : instagramAdapter
        const config =
          channel === "messenger"
            ? { pageId: own, pageAccessToken: token, appSecret: channels.appSecret }
            : {
                instagramId: own,
                accessToken: token,
                pageAccessToken: token,
                appSecret: channels.appSecret,
              }
        const entries = Array.isArray(parsed.entry) ? parsed.entry : []
        // Solo lo de la página o la cuenta de Sallca; el adaptador descarta los ecos.
        const mine = entries.filter((entry) => text((entry as { id?: unknown })?.id) === own)
        const result = adapter.parseWebhook({
          headers: {},
          rawBody: JSON.stringify({ object, entry: mine }),
          config,
        })
        for (const message of result.messages) {
          // Un botón (postback) no es un mensaje de la persona.
          if (message.externalMessageId.includes(":")) continue
          const prefix = channel === "messenger" ? "msgr:" : "ig:"
          const address = message.senderExternalId.startsWith(prefix)
            ? message.senderExternalId.slice(prefix.length)
            : message.senderExternalId
          // Lo que la propia página o cuenta escribió no es de alguien que nos escribe.
          if (!address || address === own) continue
          const content = contentOf(message)
          if (!content) continue
          pending.push({
            adapter,
            config,
            message: {
              channel,
              address,
              waId: null,
              displayName: null,
              externalId: message.externalMessageId,
              ...content,
              receivedAt: sentAt(message, now),
            },
          })
        }
      }

      for (const { adapter, config, message } of pending) {
        try {
          await ingestOne(adapter, config, message, now)
        } catch (error) {
          console.error(
            `[admin-meta] no entró el mensaje ${message.externalId} de ${message.channel}`,
            error,
          )
        }
      }
      for (const status of statuses) {
        try {
          await deps.ownerDb.transaction((tx) =>
            applyChatStatus(
              tx as Db,
              { externalId: status.id, outreachId: status.callbackData, status: status.status },
              now,
            ),
          )
        } catch (error) {
          console.error(
            `[admin-meta] no se aplicó el estado ${status.status} de ${status.id}`,
            error,
          )
        }
      }
      return c.json({ ok: true }, 200)
    },
  )

  return app
}
