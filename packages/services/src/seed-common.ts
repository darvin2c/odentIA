/**
 * Lo común de las semillas de demostración (ADR 0079): lo que cualquier
 * producto usa para armar su demo (odentIA, `dental/seed-demo.ts`). Solo para
 * la semilla manual: las pruebas arman sus propias fixtures.
 */
import type { Db } from "@odentia/db"
import { channelConnection, contactIdentity, conversation, message } from "@odentia/db/schema/crm"
import { and, eq, sql } from "drizzle-orm"
import { deflateSync } from "node:zlib"

// Storage real (MinIO local / R2 prod): los documentos demo se suben de verdad,
// nunca con rutas S3 inventadas. Requiere las mismas variables que la API.
export function storageEnvFromProcess(): {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  avatarsBucket: string
  publicBaseUrl: string
  attachmentsBucket: string
} {
  const missing = ["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_ATTACHMENTS_BUCKET"].filter(
    (k) => !process.env[k],
  )
  if (missing.length) throw new Error(`Storage demo sin configurar (faltan ${missing.join(", ")})`)
  const endpoint = process.env.S3_ENDPOINT!
  return {
    endpoint,
    region: process.env.S3_REGION ?? "auto",
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
    avatarsBucket: process.env.S3_BUCKET ?? "avatars",
    publicBaseUrl: process.env.S3_PUBLIC_URL ?? endpoint,
    attachmentsBucket: process.env.S3_ATTACHMENTS_BUCKET!,
  }
}

// Nota de voz demo: WAV PCM mono 8 kHz de un beep corto. Se sintetiza (no hay
// encoder de audio disponible) y Chrome lo reproduce sin códec adicional.
export function demoVoiceNoteWav(): Buffer {
  const rate = 8000
  const samples = Math.round(rate * 0.6)
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const envelope = 1 - i / samples
    pcm.writeInt16LE(Math.round(12000 * envelope * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

// Radiografía demo visible (96×64, RGBA) para el adjunto de la bandeja: con un
// PNG 1×1 no se distingue una imagen cargada de una rota al verificar el render.
export function demoXRayPng(): Buffer {
  const width = 96
  const height = 64
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < width; x++) {
      const i = rowStart + 1 + x * 4
      const dx = (x - width / 2) / (width / 2)
      const dy = (y - height / 2) / (height / 2)
      const r = Math.hypot(dx, dy)
      // Anillo claro (diente) sobre fondo oscuro + marca diagonal (lesión).
      const ring = r > 0.45 && r < 0.85
      const mark = Math.abs((y - height / 2) * 1.4 - (x - width / 2)) < 3
      const value = mark ? 235 : ring ? 205 : 45
      raw[i] = value
      raw[i + 1] = Math.min(255, value + (mark ? 10 : 25))
      raw[i + 2] = Math.min(255, value + (mark ? 20 : 40))
      raw[i + 3] = 255
    }
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length, 0)
    const payload = Buffer.concat([Buffer.from(type, "ascii"), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(payload), 0)
    return Buffer.concat([length, payload, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bits por canal
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}
function crc32(input: Buffer): number {
  let crc = 0xffffffff
  for (const byte of input) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

export const hoursAgo = (h: number): Date => new Date(Date.now() - h * 3_600_000)
export const daysAgo = (d: number): Date => new Date(Date.now() - d * 86_400_000)

export type SeedConversationArgs = Parameters<typeof seedConversationIn>[1]
export async function seedConversationIn(db: Db, args: {
  orgId: string
  contactId: string
  connectionId: string
  thread: string
  status?: string
  agentStatus?: string
  assignedUserId?: string | null
  unreadCount?: number
  lastInboundAt?: Date | null
  lastOutboundAt?: Date | null
  lastMessageAt?: Date | null
  /** Cerrada: con su motivo y quién (nulo = el agente), como la deja `closeConversationWith`. */
  closed?: { reason: "resuelta" | "sin_respuesta" | "equipo" | "manual"; at: Date; byUserId: string | null }
}): Promise<{ id: string }> {
  const [connection] = await db
    .select({ channel: channelConnection.channel })
    .from(channelConnection)
    .where(eq(channelConnection.id, args.connectionId))
  const identities = await db
    .select({ id: contactIdentity.id, externalUserId: contactIdentity.externalUserId })
    .from(contactIdentity)
    .where(
      and(
        eq(contactIdentity.organizationId, args.orgId),
        eq(contactIdentity.contactId, args.contactId),
        eq(contactIdentity.channel, connection!.channel),
      ),
    )
  const identity = identities.length === 1 ? identities[0] : undefined
  const [row] = await db
    .insert(conversation)
    .values({
      organizationId: args.orgId,
      contactId: args.contactId,
      contactIdentityId: identity?.id ?? null,
      channelConnectionId: args.connectionId,
      externalThreadId:
        connection?.channel === "whatsapp" && identity ? identity.externalUserId : args.thread,
      status: args.closed ? "closed" : (args.status ?? "open"),
      closedAt: args.closed?.at ?? null,
      closeReason: args.closed?.reason ?? null,
      closedByUserId: args.closed?.byUserId ?? null,
      assignedUserId: args.assignedUserId ?? null,
      agentStatus: args.agentStatus ?? "on",
      unreadCount: args.unreadCount ?? 0,
      lastInboundAt: args.lastInboundAt ?? null,
      lastOutboundAt: args.lastOutboundAt ?? null,
      lastMessageAt: args.lastMessageAt ?? null,
    })
    .returning({ id: conversation.id })
  if (!row) throw new Error(`No se pudo crear la conversación ${args.thread}`)
  return row
}

export type SeedMessageArgs = Parameters<typeof seedMessageIn>[1]
export async function seedMessageIn(db: Db, args: {
  orgId: string
  conversationId: string
  direction: string
  senderKind: string
  senderUserId?: string | null
  body?: string | null
  contentType?: string
  attachments?: unknown[]
  externalId: string
  status: string
  createdAt: Date
  /** Fase 7 de la Bandeja: reenviado, la reacción de la persona y una ubicación. */
  forwarded?: boolean
  contactReaction?: string | null
  location?: { latitude: number; longitude: number; name?: string; address?: string } | null
  /** Fase 3 de la Bandeja: la pregunta que cita, la respuesta por entregar y «Ver respuesta». */
  replyToMessageId?: string | null
  held?: boolean
  templateName?: string | null
  replyButtons?: { id: string; title: string }[] | null
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(message)
    .values({
      organizationId: args.orgId,
      conversationId: args.conversationId,
      direction: args.direction,
      senderKind: args.senderKind,
      senderUserId: args.senderUserId ?? null,
      contentType: args.contentType ?? "text",
      body: args.body ?? null,
      attachments: args.attachments ?? [],
      externalId: args.externalId,
      status: args.status,
      forwarded: args.forwarded ?? false,
      contactReaction: args.contactReaction ?? null,
      contactReactionAt: args.contactReaction ? args.createdAt : null,
      location: args.location ?? null,
      replyToMessageId: args.replyToMessageId ?? null,
      held: args.held ?? false,
      templateName: args.templateName ?? null,
      templateLanguage: args.templateName ? "es" : null,
      replyButtons: args.replyButtons ?? null,
      createdAt: args.createdAt,
    })
    .returning({ id: message.id })
  if (!row) throw new Error(`No se pudo crear el mensaje ${args.externalId}`)
  return row
}

export async function countWhereIn(db: Db, table: string, orgId: string): Promise<number> {
  const rows = (await db.execute(
    sql.raw(`select count(*)::int as n from "${table}" where "organization_id" = '${orgId}'`),
  )) as unknown as Array<{ n: number }>
  return rows[0]?.n ?? 0
}
