import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import {
  BLOCK_REASONS,
  type BlockReason,
  type ContactScreen,
  contact,
  conversation,
  message,
  type SpamReason,
} from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm"
import { invalidField, notFound, ServiceError } from "./errors.js"

/**
 * Spam y bloqueados (issue 77, ADR 0054). Spam es sobre lo que alguien mandó:
 * lo decide el código (el mismo texto muchas veces), el modelo de decisión o
 * una persona del equipo, y sale solo si después escribe algo real. Bloquear
 * es sobre la persona: lo decide solo alguien del equipo, con motivo, y nunca
 * sale solo. Ninguno de los dos se cobra ni sale en las pestañas de la Bandeja.
 * Este archivo es el único que cambia `contact.screen`.
 */

export { BLOCK_REASONS, SPAM_REASONS } from "@odentia/db/schema/crm"

/** La persona de una conversación: Spam y Bloquear actúan sobre ella, no sobre el hilo. */
export async function contactOfConversation(tx: Db, orgId: string, conversationId: string): Promise<string> {
  const [row] = await tx
    .select({ contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, conversationId)))
    .limit(1)
  if (!row) throw notFound("Conversación")
  return row.contactId
}

/** El mismo texto, tantas veces en `SPAM_REPEAT_MINUTES`, es un envío automático (decisión 10). */
export const SPAM_REPEAT_COUNT = 5
export const SPAM_REPEAT_MINUTES = 60
/** Textos distintos de alguien en Spam que se vuelven a revisar por día (decisión 9). */
export const SPAM_RECHECKS_PER_DAY = 5
/** La lista de Spam muestra lo de los últimos días. */
export const SPAM_LIST_DAYS = 30
/** Lo que sigue en Spam se borra a los días (decisión 16): texto y adjuntos. */
export const SPAM_KEEP_DAYS = 90
/** Días que la conversación dice que alguien salió solo de Spam (decisión 9b). */
export const SPAM_LEFT_NOTICE_DAYS = 7
/** Lo que escribe quien bloquea: obligatorio y acotado. */
export const BLOCK_NOTE_MAX = 500

/** Motivo de la corrida que no responde a quien está en Spam: lo lee el libro. */
export const SPAM_RUN_REASON = "spam"
/** La corrida volvió a mirar a alguien en Spam y sigue siéndolo. */
export const SPAM_STILL_RUN_REASON = "spam-sigue"
/** En Spam y sin modelo de decisión que diga si lo nuevo es spam: se queda (decisión 9a). */
export const SPAM_UNDECIDED_RUN_REASON = "spam-sin-decision"
/** La corrida no atiende a una persona bloqueada. */
export const BLOCKED_RUN_REASON = "bloqueado"

/** Texto comparable: sin mayúsculas, espacios de más ni bordes. */
export function normalizedBodySql(m: string): ReturnType<typeof sql> {
  return sql`lower(regexp_replace(btrim(coalesce(${sql.raw(m)}.body, '')), '\\s+', ' ', 'g'))`
}

export interface ContactScreenFacts {
  screen: ContactScreen | null
  reason: string | null
  at: Date | null
  byUserId: string | null
  note: string | null
  notSpam: boolean
  isPatient: boolean
  /** Alguien del equipo le escribió alguna vez. */
  teamWrote: boolean
}

/** Lo que dice si una persona puede ir sola a Spam o bloquearse. */
export async function contactScreenFacts(tx: Db, orgId: string, contactId: string): Promise<ContactScreenFacts> {
  const [row] = await tx.execute<{
    screen: ContactScreen | null
    reason: string | null
    at: Date | null
    by_user_id: string | null
    note: string | null
    not_spam: boolean
    is_patient: boolean
    team_wrote: boolean
  }>(sql`
    select c.screen, c.screen_reason as reason, c.screened_at as at, c.screened_by_user_id as by_user_id,
      c.screen_note as note, c.not_spam_at is not null as not_spam,
      exists (select 1 from patient p where p.organization_id = c.organization_id and p.person_id = c.id) as is_patient,
      exists (select 1 from message m join conversation cv on cv.organization_id = m.organization_id and cv.id = m.conversation_id
        where cv.organization_id = c.organization_id and cv.contact_id = c.id
          and m.direction = 'out' and m.sender_kind = 'user') as team_wrote
    from contact c where c.organization_id = ${orgId} and c.id = ${contactId}`)
  if (!row) throw notFound("Persona")
  return {
    screen: row.screen,
    reason: row.reason,
    at: row.at ? new Date(row.at) : null,
    byUserId: row.by_user_id,
    note: row.note,
    notSpam: row.not_spam,
    isPatient: row.is_patient,
    teamWrote: row.team_wrote,
  }
}

/**
 * Nunca va sola a Spam (tablero 3): quien es paciente, a quien el equipo ya
 * le escribió, quien alguien sacó de Spam con «No es spam» o quien ya está
 * en Spam o bloqueada.
 */
export function autoSpamAllowed(facts: ContactScreenFacts): boolean {
  return facts.screen === null && !facts.notSpam && !facts.isPatient && !facts.teamWrote
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  action: string,
  contactId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action, entity: "contact", entityId: contactId, metadata })
}

/**
 * Manda a una persona a Spam. Sin `userId` es automático (repetición o modelo
 * de decisión) y solo si `autoSpamAllowed`; con `userId` es «Es spam» de una
 * persona del equipo, que nunca vale para un paciente. Devuelve si cambió.
 */
export async function markSpam(
  tx: Db,
  orgId: string,
  input: { contactId: string; reason: SpamReason; userId: string | null; messageId?: string | null },
): Promise<boolean> {
  await tx.execute(sql`select 1 from contact where organization_id = ${orgId} and id = ${input.contactId} for update`)
  const facts = await contactScreenFacts(tx, orgId, input.contactId)
  if (input.userId === null) {
    if (!autoSpamAllowed(facts)) return false
  } else {
    if (facts.isPatient) {
      throw new ServiceError("PATIENT_NOT_SPAM", 409, "Una persona con ficha de paciente no va a Spam")
    }
    if (facts.screen === "blocked") throw new ServiceError("CONTACT_BLOCKED", 409, "La persona está bloqueada")
    if (facts.screen === "spam") return false
  }
  const reason: SpamReason = input.userId === null ? input.reason : "equipo"
  await tx
    .update(contact)
    .set({
      screen: "spam",
      screenedAt: new Date(),
      screenedByUserId: input.userId,
      screenReason: reason,
      screenNote: null,
      updatedAt: new Date(),
    })
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, input.contactId)))
  await audit(tx, orgId, input.userId, "contact.spam_marked", input.contactId, {
    reason,
    // Sin persona del equipo lo decidió el agente (la frase de la actividad lo lee de aquí).
    ...(input.userId === null ? { origin: "agent" } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
  })
  return true
}

/** Lo último que escribió una persona, para que el agente le responda al sacarla de Spam o desbloquearla. */
export interface LastInbound {
  conversationId: string
  messageId: string
  at: Date
}

async function lastInboundOf(tx: Db, orgId: string, contactId: string): Promise<LastInbound | null> {
  const [row] = await tx
    .select({ conversationId: message.conversationId, messageId: message.id, at: message.createdAt })
    .from(message)
    .innerJoin(conversation, and(eq(conversation.organizationId, message.organizationId), eq(conversation.id, message.conversationId)))
    .where(and(eq(message.organizationId, orgId), eq(conversation.contactId, contactId), eq(message.direction, "in")))
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(1)
  return row ?? null
}

/**
 * «No es spam» (tablero 5): la persona vuelve a la Bandeja y queda protegida
 * para siempre de ir sola a Spam. Devuelve lo último que escribió, para que
 * quien llama encole la respuesta del agente; nulo si no estaba en Spam.
 */
export async function markNotSpam(
  tx: Db,
  orgId: string,
  input: { contactId: string; userId: string },
): Promise<LastInbound | null> {
  await tx.execute(sql`select 1 from contact where organization_id = ${orgId} and id = ${input.contactId} for update`)
  const facts = await contactScreenFacts(tx, orgId, input.contactId)
  if (facts.screen !== "spam") return null
  const now = new Date()
  await tx
    .update(contact)
    .set({
      screen: null,
      screenedAt: null,
      screenedByUserId: null,
      screenReason: null,
      screenNote: null,
      notSpamAt: now,
      notSpamByUserId: input.userId,
      updatedAt: now,
    })
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, input.contactId)))
  await audit(tx, orgId, input.userId, "contact.not_spam", input.contactId, {
    previousReason: facts.reason,
    previousByUserId: facts.byUserId,
  })
  return lastInboundOf(tx, orgId, input.contactId)
}

/**
 * Salió sola de Spam (decisiones 9a y 9b): escribió algo que no es spam,
 * aunque la haya marcado una persona del equipo. Queda dicho en la
 * conversación por `SPAM_LEFT_NOTICE_DAYS`, con quién la había marcado.
 */
export async function leaveSpam(
  tx: Db,
  orgId: string,
  input: { contactId: string; messageId: string },
): Promise<boolean> {
  await tx.execute(sql`select 1 from contact where organization_id = ${orgId} and id = ${input.contactId} for update`)
  const facts = await contactScreenFacts(tx, orgId, input.contactId)
  if (facts.screen !== "spam") return false
  await tx
    .update(contact)
    .set({ screen: null, screenedAt: null, screenedByUserId: null, screenReason: null, screenNote: null, updatedAt: new Date() })
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, input.contactId)))
  await audit(tx, orgId, null, "contact.spam_left", input.contactId, {
    origin: "agent",
    messageId: input.messageId,
    markedByUserId: facts.byUserId,
    markedAt: facts.at?.toISOString() ?? null,
    reason: facts.reason,
  })
  return true
}

/**
 * Antes de que una persona pase a ser paciente (decisión 14): un paciente no
 * está en Spam ni bloqueado. Si estaba en Spam, sale (queda en la auditoría);
 * si está bloqueada, no se registra hasta que alguien la desbloquee.
 */
export async function screenBeforePatient(tx: Db, orgId: string, contactId: string, userId: string | null): Promise<void> {
  await tx.execute(sql`select 1 from contact where organization_id = ${orgId} and id = ${contactId} for update`)
  const facts = await contactScreenFacts(tx, orgId, contactId)
  if (facts.screen === "blocked") {
    throw new ServiceError("CONTACT_BLOCKED", 409, "Esta persona está bloqueada: desbloquéala antes de registrarla como paciente")
  }
  if (facts.screen !== "spam") return
  await tx
    .update(contact)
    .set({ screen: null, screenedAt: null, screenedByUserId: null, screenReason: null, screenNote: null, updatedAt: new Date() })
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, contactId)))
  await audit(tx, orgId, userId, "contact.spam_left_patient", contactId, {
    markedByUserId: facts.byUserId,
    markedAt: facts.at?.toISOString() ?? null,
    reason: facts.reason,
  })
}

/**
 * Bloquear a una persona (tablero 5b): solo alguien del equipo, con motivo y
 * lo que pasó escrito. Un paciente no se bloquea: se archiva (decisión 14).
 * El bloqueo en WhatsApp lo hace el worker (`pendingProviderBlocks`).
 */
export async function blockContact(
  tx: Db,
  orgId: string,
  input: { contactId: string; userId: string; reason: string; note: string },
): Promise<void> {
  if (!(BLOCK_REASONS as readonly string[]).includes(input.reason)) {
    throw invalidField("reason", "Elige el motivo del bloqueo.")
  }
  const note = input.note.trim()
  if (!note) throw invalidField("note", "Escribe qué pasó.")
  if (note.length > BLOCK_NOTE_MAX) throw invalidField("note", `Escribe como mucho ${BLOCK_NOTE_MAX} caracteres.`)
  await tx.execute(sql`select 1 from contact where organization_id = ${orgId} and id = ${input.contactId} for update`)
  const facts = await contactScreenFacts(tx, orgId, input.contactId)
  if (facts.isPatient) {
    throw new ServiceError("PATIENT_NOT_BLOCKABLE", 409, "A un paciente no se lo bloquea: se archiva desde su página")
  }
  if (facts.screen === "blocked") return
  await tx
    .update(contact)
    .set({
      screen: "blocked",
      screenedAt: new Date(),
      screenedByUserId: input.userId,
      screenReason: input.reason as BlockReason,
      screenNote: note,
      updatedAt: new Date(),
    })
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, input.contactId)))
  // La auditoría guarda el motivo, no lo que se escribió.
  await audit(tx, orgId, input.userId, "contact.blocked", input.contactId, {
    reason: input.reason,
    ...(facts.screen === "spam" ? { wasSpam: true } : {}),
  })
}

/**
 * Desbloquear (tablero 5b): la persona puede volver a escribir y el agente la
 * atiende como a cualquiera. El desbloqueo en WhatsApp lo hace el worker.
 */
export async function unblockContact(tx: Db, orgId: string, input: { contactId: string; userId: string }): Promise<void> {
  await tx.execute(sql`select 1 from contact where organization_id = ${orgId} and id = ${input.contactId} for update`)
  const facts = await contactScreenFacts(tx, orgId, input.contactId)
  if (facts.screen !== "blocked") return
  await tx
    .update(contact)
    .set({ screen: null, screenedAt: null, screenedByUserId: null, screenReason: null, screenNote: null, updatedAt: new Date() })
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, input.contactId)))
  await audit(tx, orgId, input.userId, "contact.unblocked", input.contactId, {
    previousReason: facts.reason,
    blockedByUserId: facts.byUserId,
    blockedAt: facts.at?.toISOString() ?? null,
  })
}

/** Lo que una pantalla muestra del estado de una persona: el aviso de la conversación y de su página. */
export interface ContactScreenView {
  screen: ContactScreen | null
  reason: string | null
  at: string | null
  /** Nombre de quien lo decidió; nulo = el agente. */
  byName: string | null
  /** Lo que pasó, si se bloqueó. */
  note: string | null
  isPatient: boolean
  /** Salió sola de Spam hace poco (decisión 9b). */
  leftSpam: { at: string; messageId: string; markedByName: string | null; markedAt: string | null } | null
}

export async function getContactScreenView(tx: Db, orgId: string, contactId: string): Promise<ContactScreenView> {
  const facts = await contactScreenFacts(tx, orgId, contactId)
  const names = new Map<string, string>()
  const left = facts.screen === null
    ? (
        await tx
          .select({ createdAt: auditEvent.createdAt, metadata: auditEvent.metadata })
          .from(auditEvent)
          .where(
            and(
              eq(auditEvent.organizationId, orgId),
              eq(auditEvent.entity, "contact"),
              eq(auditEvent.entityId, contactId),
              inArray(auditEvent.action, ["contact.spam_left", "contact.spam_marked", "contact.not_spam"]),
              sql`${auditEvent.createdAt} > now() - make_interval(days => ${SPAM_LEFT_NOTICE_DAYS})`,
            ),
          )
          .orderBy(desc(auditEvent.createdAt))
          .limit(1)
      )[0]
    : undefined
  // Solo si lo último que pasó fue salir sola: marcarla otra vez o sacarla a mano lo retira.
  const leftMeta = left && (left.metadata as { messageId?: unknown } | null)?.messageId
    ? (left.metadata as { messageId: string; markedByUserId?: string | null; markedAt?: string | null })
    : null
  const userIds = [facts.byUserId, leftMeta?.markedByUserId ?? null].filter((id): id is string => Boolean(id))
  if (userIds.length > 0) {
    const rows = await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds))
    for (const r of rows) names.set(r.id, r.name)
  }
  return {
    screen: facts.screen,
    reason: facts.reason,
    at: facts.at?.toISOString() ?? null,
    byName: facts.byUserId ? (names.get(facts.byUserId) ?? null) : null,
    note: facts.screen === "blocked" ? facts.note : null,
    isPatient: facts.isPatient,
    leftSpam: left && leftMeta
      ? {
          at: left.createdAt.toISOString(),
          messageId: leftMeta.messageId,
          markedByName: leftMeta.markedByUserId ? (names.get(leftMeta.markedByUserId) ?? null) : null,
          markedAt: leftMeta.markedAt ?? null,
        }
      : null,
  }
}

/** Veces que hoy (en la zona de la clínica) se volvió a mirar a alguien en Spam. */
export async function spamRechecksToday(tx: Db, orgId: string, contactId: string): Promise<number> {
  const [row] = await tx.execute<{ count: number }>(sql`
    select count(*)::int as count from agent_run_ledger l
    join conversation cv on cv.organization_id = l.organization_id and cv.id = l.conversation_id
    where l.organization_id = ${orgId} and cv.contact_id = ${contactId} and l.error = ${SPAM_STILL_RUN_REASON}
      and (l.started_at at time zone coalesce((select timezone from org_profile where organization_id = ${orgId}), 'UTC'))::date
        = (now() at time zone coalesce((select timezone from org_profile where organization_id = ${orgId}), 'UTC'))::date`)
  return row?.count ?? 0
}

/**
 * Lo que se borra de alguien en Spam (decisión 16): solo lo que la persona
 * mandó desde que entró a Spam (con la hora de repeticiones que la llevó) y
 * tiene más de `SPAM_KEEP_DAYS`. Lo anterior a Spam, lo que escribió la
 * clínica y lo de un paciente nunca se borran.
 */
const spamToRedactSql = sql`${message.direction} = 'in'
  and ${contact.screenedAt} is not null
  and ${message.createdAt} >= ${contact.screenedAt} - make_interval(mins => ${SPAM_REPEAT_MINUTES})
  and ${message.createdAt} < now() - make_interval(days => ${SPAM_KEEP_DAYS})
  and not exists (select 1 from patient p where p.organization_id = ${contact.organizationId} and p.person_id = ${contact.id})`

/**
 * Borra el texto y los adjuntos de lo que sigue en Spam pasados
 * `SPAM_KEEP_DAYS` (decisión 16; qué entra, `spamToRedactSql`). Lo de un
 * bloqueado no se borra: puede servir de prueba. Devuelve las claves de los
 * adjuntos para que quien llama los quite del almacenamiento después de confirmar.
 */
export async function redactOldSpam(tx: Db, orgId: string, limit = 500): Promise<{ redacted: number; objectKeys: string[] }> {
  const rows = await tx
    .select({ id: message.id, attachments: message.attachments })
    .from(message)
    .innerJoin(conversation, and(eq(conversation.organizationId, message.organizationId), eq(conversation.id, message.conversationId)))
    .innerJoin(contact, and(eq(contact.organizationId, conversation.organizationId), eq(contact.id, conversation.contactId)))
    .where(
      and(
        eq(message.organizationId, orgId),
        eq(contact.screen, "spam"),
        isNull(message.redactedAt),
        spamToRedactSql,
      ),
    )
    .limit(limit)
  if (rows.length === 0) return { redacted: 0, objectKeys: [] }
  const objectKeys: string[] = []
  for (const row of rows) {
    if (!Array.isArray(row.attachments)) continue
    for (const att of row.attachments) {
      const key = att && typeof att === "object" && "objectKey" in att ? (att as { objectKey: unknown }).objectKey : null
      if (typeof key === "string") objectKeys.push(key)
    }
  }
  await tx
    .update(message)
    .set({ body: null, attachments: [], redactedAt: new Date() })
    .where(and(eq(message.organizationId, orgId), inArray(message.id, rows.map((r) => r.id))))
  return { redacted: rows.length, objectKeys }
}

/** Organizaciones con algo de Spam por borrar: el worker las recorre con el dueño de la base. */
export async function orgsWithOldSpam(ownerDb: Db): Promise<string[]> {
  const rows = await ownerDb.execute<{ organization_id: string }>(sql`
    select distinct c.organization_id from contact c
    where c.screen = 'spam' and exists (
      select 1 from conversation cv join message m on m.organization_id = cv.organization_id and m.conversation_id = cv.id
      where cv.organization_id = c.organization_id and cv.contact_id = c.id and m.redacted_at is null
        and m.direction = 'in' and c.screened_at is not null
        and m.created_at >= c.screened_at - make_interval(mins => ${SPAM_REPEAT_MINUTES})
        and m.created_at < now() - make_interval(days => ${SPAM_KEEP_DAYS})
        and not exists (select 1 from patient p where p.organization_id = c.organization_id and p.person_id = c.id))`)
  return rows.map((r) => r.organization_id)
}

/** Un número de WhatsApp que hay que bloquear o desbloquear en el proveedor. */
export interface ProviderBlockWork {
  organizationId: string
  identityId: string
  externalUserId: string
  connectionId: string
  block: boolean
}

/**
 * Lo que el proveedor aún no sabe (decisión 13): bloqueados cuyo WhatsApp no
 * está bloqueado ahí y escribieron en las últimas 24 horas (la condición de
 * Meta), y desbloqueados que siguen bloqueados ahí. Se lee con el dueño de la
 * base porque recorre todas las clínicas.
 */
export async function pendingProviderBlocks(ownerDb: Db, limit = 50): Promise<ProviderBlockWork[]> {
  const rows = await ownerDb.execute<{
    organization_id: string
    identity_id: string
    external_user_id: string
    connection_id: string
    block: boolean
  }>(sql`
    select ci.organization_id, ci.id as identity_id, ci.external_user_id, cc.id as connection_id,
      (c.screen = 'blocked') as block
    from contact_identity ci
    join contact c on c.organization_id = ci.organization_id and c.id = ci.contact_id
    join lateral (
      select cv.channel_connection_id, max(m.created_at) as last_in from conversation cv
      join message m on m.organization_id = cv.organization_id and m.conversation_id = cv.id and m.direction = 'in'
      where cv.organization_id = ci.organization_id and cv.contact_identity_id = ci.id
      group by cv.channel_connection_id order by max(m.created_at) desc limit 1
    ) last on true
    join channel_connection cc on cc.organization_id = ci.organization_id and cc.id = last.channel_connection_id
      and cc.status = 'active' and cc.channel = 'whatsapp'
    where ci.channel = 'whatsapp'
      and ((c.screen = 'blocked' and ci.provider_blocked_at is null and last.last_in > now() - interval '24 hours')
        or (coalesce(c.screen, '') <> 'blocked' and ci.provider_blocked_at is not null))
    limit ${limit}`)
  return rows.map((r) => ({
    organizationId: r.organization_id,
    identityId: r.identity_id,
    externalUserId: r.external_user_id,
    connectionId: r.connection_id,
    block: r.block,
  }))
}

/** Anota lo que el proveedor confirmó: bloqueado ahí desde ahora, o ya no. */
export async function recordProviderBlock(tx: Db, orgId: string, identityId: string, blocked: boolean): Promise<void> {
  await tx.execute(sql`update contact_identity set provider_blocked_at = ${blocked ? sql`now()` : sql`null`}
    where organization_id = ${orgId} and id = ${identityId}`)
}

/** ¿Se le puede escribir? A un bloqueado, nadie (equipo, agente ni automatizaciones). */
export async function assertContactWritable(tx: Db, orgId: string, contactId: string): Promise<void> {
  const [row] = await tx
    .select({ screen: contact.screen })
    .from(contact)
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, contactId), isNotNull(contact.screen)))
    .limit(1)
  if (row?.screen === "blocked") {
    throw new ServiceError("CONTACT_BLOCKED", 409, "No puedes escribirle mientras esté bloqueado")
  }
}
