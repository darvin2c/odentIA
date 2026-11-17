/**
 * «Mejorar con Kairós» (ADR 0196): lo que lee Kairós para corregir y aclarar lo
 * que escribió una persona de Administración antes de enviarlo desde la
 * Bandeja. Kairós solo propone: la persona ve lo que cambiaría y elige; nada
 * sale de aquí ni se guarda.
 *
 * Al modelo viaja el texto de la persona y, si responde una conversación, lo
 * último de ella: como mucho seis mensajes de ese chat o de ese hilo de correo,
 * cada uno por el filtro de los correos (`kairosAllowedEmailText`: sin lo
 * citado y sin lo que parece de un paciente), con el nombre de la clínica y su
 * producto. Nada de la bitácora, notas, tareas ni cobros. Se lee con la
 * conexión propietaria (las tablas del ARM viven en `admin`) dentro de la
 * transacción de la ruta; el modelo corre fuera de ella.
 */
import { type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  saasChat,
  saasClient,
  saasInboundEmail,
  saasInboundMessage,
  saasOutreach,
} from "@odentia/db/schema/admin-arm"
import { and, desc, eq, ne, sql } from "drizzle-orm"
import type { AdminActor } from "./admin-core.js"
import { emailThreadKeySql, outreachThreadKeySql } from "./admin-email-thread.js"
import type { KairosDrafter } from "./admin-kairos.js"
import { kairosAllowedEmailText, kairosAllowedFact } from "./admin-kairos-drafts.js"
import { notFound, ServiceError } from "./errors.js"

/** Por dónde sale lo que se mejora: el mismo texto se adapta a cada canal al enviarlo. */
export const KAIROS_IMPROVE_CHANNELS = ["correo", "whatsapp", "instagram", "messenger"] as const
export type KairosImproveChannel = (typeof KAIROS_IMPROVE_CHANNELS)[number]

/** Lo más largo que se mejora: lo que cabe en un envío. */
export const KAIROS_IMPROVE_TEXT_MAX = 5000
/** Cuántos mensajes de la conversación lee Kairós como mucho. */
export const KAIROS_IMPROVE_CONTEXT_MAX = 6
/** Lo que se lee de cada mensaje: basta para entender a qué responde. */
const LINE_MAX = 600

/** Un mensaje de la conversación, ya filtrado: «ellos» escribieron, «nosotros» respondimos. */
export interface KairosImproveLine {
  who: "ellos" | "nosotros"
  text: string
}

export interface KairosImproveContext {
  /** Lo último de la conversación, lo más viejo primero; ya pasó el filtro. */
  conversation: KairosImproveLine[]
  /** La clínica a la que se le escribe, si la conversación ya es de un cliente. */
  clientName?: string
  product?: ClinicalProduct
}

/** Lo que recibe el escritor de Kairós (`improveText` de `@odentia/agent`). */
export interface KairosImproveAsk {
  text: string
  channel: KairosImproveChannel
  context?: KairosImproveContext
}

/**
 * Lo que propone Kairós, o por qué no: `inventaba` (traía un número, una hora,
 * un importe, un día o un enlace que no estaban, aun después de pedirle que no),
 * `igual` (ya estaba bien escrito) o `vacio` (no hay texto que mejorar o no
 * devolvió nada).
 */
export type KairosImproveResult =
  | { ok: true; text: string }
  | { ok: false; why: "inventaba" | "igual" | "vacio" }

/**
 * Lo que necesita la ruta del escritor de Kairós: la forma, no el paquete, para
 * que los servicios no dependan del agente. `signal` corta la llamada al modelo.
 */
export interface KairosImproveWriter {
  /** «plantilla» si mejora sin modelo (no configurado o `LLM_MODEL=fake`); sin el campo, el modelo. */
  readonly drafter?: KairosDrafter
  improveText(
    input: KairosImproveAsk,
    options?: { signal?: AbortSignal },
  ): Promise<KairosImproveResult>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Un mensaje tal como se guardó, antes del filtro. */
export interface KairosImproveRow {
  who: "ellos" | "nosotros"
  at: Date
  /** El texto, o null si solo trajo archivos o ya se borró. */
  body: string | null
  /** Cuántos archivos trajo (un chat). */
  files?: number
  /** El asunto de un correo. */
  subject?: string | null
}

/** La firma con que sale una respuesta nuestra («— Ana · odentIA»): no es parte de lo que se dijo. */
function withoutSignature(body: string): string {
  return body.replace(/\n+—\s[^\n]*$/u, "").trim()
}

/** «Re: …», «RV: …», «Fwd: …»: el mismo asunto del hilo. */
function bareSubject(subject: string): string {
  return subject.replace(/^(?:\s*(?:re|rv|fw|fwd|reenviado)\s*:\s*)+/iu, "").trim()
}

/**
 * Lo que lee Kairós de una conversación: los últimos `KAIROS_IMPROVE_CONTEXT_MAX`
 * mensajes, lo más viejo primero, cada uno por el filtro de los correos y corto
 * a 600 caracteres. Lo que no deja nada (solo lo citado, o solo frases de un
 * paciente) no se lee; un archivo se dice sin su nombre. El asunto del hilo va
 * una vez, en el primero que lo trae. Sin cifras propias: lo que agrega este
 * texto no da por buena una cifra de «Mejorar».
 */
export function kairosImproveLines(rows: readonly KairosImproveRow[]): KairosImproveLine[] {
  const recent = [...rows]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(-KAIROS_IMPROVE_CONTEXT_MAX)
  const lines: KairosImproveLine[] = []
  let subjectSaid = false
  for (const row of recent) {
    const raw = row.who === "nosotros" && row.body ? withoutSignature(row.body) : row.body
    const said = kairosAllowedEmailText(raw, { adminOnly: true }).lines.join(" ")
    const subject =
      !subjectSaid && row.subject
        ? kairosAllowedFact(bareSubject(row.subject), { adminOnly: true })
        : null
    const files = row.files ?? 0
    const parts = [
      subject ? `Asunto: ${subject}.` : null,
      said || null,
      files > 0 ? (files === 1 ? "(mandó un archivo)" : "(mandó archivos)") : null,
    ].filter((part): part is string => part !== null)
    if (parts.length === 0) continue
    if (subject) subjectSaid = true
    const text = parts.join(" ")
    lines.push({
      who: row.who,
      text: text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 1)}…` : text,
    })
  }
  return lines
}

async function clientOf(
  tx: Db,
  clientId: string | null,
): Promise<{ name: string; product: string } | null> {
  if (!clientId) return null
  const [client] = await tx
    .select({ name: saasClient.name, product: saasClient.product })
    .from(saasClient)
    .where(eq(saasClient.id, clientId))
    .limit(1)
  return client ?? null
}

function contextOf(
  rows: KairosImproveRow[],
  client: { name: string; product: string } | null,
  product: string | null,
): KairosImproveContext {
  const named = client ? kairosAllowedFact(client.name, { adminOnly: true }) : null
  const of = client?.product ?? product
  return {
    conversation: kairosImproveLines(rows),
    ...(named ? { clientName: named } : {}),
    ...(of && isClinicalProduct(of) ? { product: of } : {}),
  }
}

async function chatRows(tx: Db, chatId: string): Promise<KairosImproveRow[]> {
  const messages = await tx
    .select({
      body: saasInboundMessage.body,
      media: saasInboundMessage.media,
      at: saasInboundMessage.receivedAt,
    })
    .from(saasInboundMessage)
    .where(eq(saasInboundMessage.chatId, chatId))
    .orderBy(desc(saasInboundMessage.receivedAt), desc(saasInboundMessage.id))
    .limit(KAIROS_IMPROVE_CONTEXT_MAX)
  // Lo que no salió no se le dijo; lo que está saliendo, sí.
  const replies = await tx
    .select({ body: saasOutreach.body, at: saasOutreach.createdAt })
    .from(saasOutreach)
    .where(and(eq(saasOutreach.chatId, chatId), ne(saasOutreach.status, "no_salio")))
    .orderBy(desc(saasOutreach.createdAt), desc(saasOutreach.id))
    .limit(KAIROS_IMPROVE_CONTEXT_MAX)
  return [
    ...messages.map(
      (message): KairosImproveRow => ({
        who: "ellos",
        at: message.at,
        body: message.body,
        files: message.media.length,
      }),
    ),
    ...replies.map(
      (reply): KairosImproveRow => ({ who: "nosotros", at: reply.at, body: reply.body }),
    ),
  ]
}

async function emailRows(
  tx: Db,
  email: typeof saasInboundEmail.$inferSelect,
): Promise<KairosImproveRow[]> {
  // El mismo hilo que muestra la Bandeja (`emailThreadKeySql`): un correo de alguien que no está
  // en el hilo, aunque traiga su Message-ID, es su propia conversación y no trae lo de los demás.
  const root = await tx.execute<{ root: string | null }>(
    sql`select ${emailThreadKeySql("e")} as root from admin.saas_inbound_email e where e.id = ${email.id}::uuid`,
  )
  const thread = root[0]?.root ?? email.messageId
  const inThread = sql`(e.id = ${email.id}::uuid or ${emailThreadKeySql("e")} = ${thread})`
  const inbound = await tx.execute<{
    subject: string | null
    text_body: string | null
    received_at: Date | string
  }>(sql`select e.subject, e.text_body, e.received_at from admin.saas_inbound_email e
    where ${inThread}
    order by e.received_at desc, e.id desc limit ${KAIROS_IMPROVE_CONTEXT_MAX}`)
  // Lo nuestro del mismo hilo, con la regla de la Bandeja (`outreachThreadKeySql`).
  const outbound = await tx.execute<{
    subject: string | null
    body: string
    created_at: Date | string
  }>(sql`select o.subject, o.body, o.created_at from admin.saas_outreach o
    where o.channel = 'correo' and o.status <> 'no_salio'
      and ${outreachThreadKeySql("o")} = ${thread}
    order by o.created_at desc, o.id desc limit ${KAIROS_IMPROVE_CONTEXT_MAX}`)
  return [
    ...[...inbound].map(
      (row): KairosImproveRow => ({
        who: "ellos",
        at: new Date(row.received_at),
        body: row.text_body,
        subject: row.subject,
      }),
    ),
    ...[...outbound].map(
      (row): KairosImproveRow => ({
        who: "nosotros",
        at: new Date(row.created_at),
        body: row.body,
        subject: row.subject,
      }),
    ),
  ]
}

/**
 * Lo que lee Kairós para mejorar una respuesta: la conversación de ese chat
 * (`chatId`) o el hilo de ese correo (`emailId`, cualquiera del hilo), con el
 * nombre de la clínica y su producto. Sin ninguno de los dos, nada: mejora el
 * texto solo. Solo Administración, como la Bandeja.
 */
export async function kairosImproveContext(
  tx: Db,
  actor: AdminActor,
  source: { chatId?: string | null; emailId?: string | null },
): Promise<KairosImproveContext> {
  if (actor.role !== "admin")
    throw new ServiceError("FORBIDDEN", 403, "«Mejorar con Kairós» es de Administración")
  if (source.chatId && source.emailId)
    throw new ServiceError("VALIDATION", 400, "Elige la conversación o el correo, no los dos", {
      emailId: "Elige la conversación o el correo, no los dos",
    })
  if (source.chatId) {
    if (!UUID.test(source.chatId)) throw notFound("Conversación")
    const [chat] = await tx
      .select({ id: saasChat.id, clientId: saasChat.clientId })
      .from(saasChat)
      .where(eq(saasChat.id, source.chatId))
      .limit(1)
    if (!chat) throw notFound("Conversación")
    return contextOf(await chatRows(tx, chat.id), await clientOf(tx, chat.clientId), null)
  }
  if (source.emailId) {
    if (!UUID.test(source.emailId)) throw notFound("Correo")
    const [email] = await tx
      .select()
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.id, source.emailId))
      .limit(1)
    if (!email) throw notFound("Correo")
    return contextOf(await emailRows(tx, email), await clientOf(tx, email.clientId), email.product)
  }
  return { conversation: [] }
}
