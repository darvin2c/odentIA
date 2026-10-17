import type { Db } from "@odentia/db"
import { supportCase, supportNotice } from "@odentia/db/schema/admin-support"
import { member, organization, user } from "@odentia/db/schema/auth"
import { and, asc, eq, gt, isNotNull, isNull, lte, ne, sql } from "drizzle-orm"
import { helpTopicForScreen, helpTopicLabel } from "./help-guide.js"

/* ---------- Avisos por correo de los casos de soporte ---------- */

/**
 * El caso es la fuente; el correo solo avisa. Dos correos y nada más:
 * - a soporte (`SUPPORT_INBOX_EMAIL`), cuando se abre un caso y cuando la
 *   clínica responde;
 * - a quien preguntó, cuando soporte le respondió (o le pidió algo) y no lo
 *   vio en 15 minutos, como mucho uno por caso cada hora.
 * Ninguno lleva el texto de la clínica ni el de soporte: tipo, clínica,
 * pantalla, quién y un enlace. «Resuelto» no avisa. Si quien preguntó ya no
 * está en la clínica, no se le escribe.
 *
 * Igual que los correos del cobro, el aviso se guarda y se reclama antes de
 * SMTP; si la entrega queda incierta no se reintenta.
 */

export type SupportNoticeKind = "caso_nuevo" | "clinica_respondio" | "respuesta" | "necesita_algo"

/** Cuánto se espera a que la persona vea la respuesta antes de escribirle. */
export const SUPPORT_REPLY_NOTICE_DELAY_MS = 15 * 60_000
/** Como mucho un correo por caso a quien preguntó en este lapso. */
export const SUPPORT_REPLY_NOTICE_GAP_MS = 60 * 60_000
/** Respuestas más viejas no se avisan (p. ej. al desplegar por primera vez). */
const SUPPORT_REPLY_NOTICE_LOOKBACK_MS = 7 * 86_400_000

/**
 * Deja el aviso a soporte de algo que hizo la clínica. Corre en la misma
 * transacción que abre el caso o guarda la respuesta. Varias respuestas
 * seguidas, con un aviso aún sin salir, no dejan otro: soporte se entera igual.
 */
export async function enqueueSupportInboxNotice(
  tx: Db,
  input: {
    caseId: string
    organizationId: string | null
    kind: "caso_nuevo" | "clinica_respondio"
    /** Identifica el hecho: el caso, o el mensaje de la clínica. */
    sourceId: string
  },
): Promise<void> {
  if (input.kind === "clinica_respondio") {
    const [waiting] = await tx
      .select({ id: supportNotice.id })
      .from(supportNotice)
      .where(
        and(
          eq(supportNotice.caseId, input.caseId),
          isNull(supportNotice.recipientUserId),
          eq(supportNotice.emailState, "pendiente"),
        ),
      )
      .limit(1)
    if (waiting) return
  }
  await tx
    .insert(supportNotice)
    .values({
      caseId: input.caseId,
      organizationId: input.organizationId,
      kind: input.kind,
      recipientUserId: null,
      dedupeKey: `${input.kind}:${input.sourceId}`,
    })
    .onConflictDoNothing({ target: supportNotice.dedupeKey })
}

/** Un aviso pendiente: `inbox` si va al buzón de soporte. */
export interface PendingSupportNotice {
  id: string
  inbox: boolean
}

/**
 * Deja los avisos a quien preguntó que ya vencieron y devuelve todos los
 * pendientes (también los que quedaron de una vuelta anterior). Corre con
 * owner: mira casos de todas las clínicas.
 */
export async function tickSupportNotices(ownerDb: Db, now = new Date()): Promise<PendingSupportNotice[]> {
  const dueBefore = new Date(now.getTime() - SUPPORT_REPLY_NOTICE_DELAY_MS)
  const since = new Date(now.getTime() - SUPPORT_REPLY_NOTICE_LOOKBACK_MS)
  const recently = new Date(now.getTime() - SUPPORT_REPLY_NOTICE_GAP_MS)
  const due = await ownerDb
    .select({
      id: supportCase.id,
      organizationId: supportCase.organizationId,
      openedBy: supportCase.openedBy,
      status: supportCase.status,
      lastPublicMessageAt: supportCase.lastPublicMessageAt,
    })
    .from(supportCase)
    .where(
      and(
        ne(supportCase.status, "resuelto"),
        // Sin autor no hay a quién avisar: el caso automático «Modelo sin
        // responder» no tiene destinatario y su aviso detendría toda la vuelta.
        isNotNull(supportCase.openedBy),
        lte(supportCase.lastPublicMessageAt, dueBefore),
        gt(supportCase.lastPublicMessageAt, since),
        sql`(${supportCase.clientSeenAt} is null or ${supportCase.clientSeenAt} < ${supportCase.lastPublicMessageAt})`,
        // Uno por caso cada hora: cuenta todo aviso a la persona que salió o pudo salir.
        sql`not exists (select 1 from ${supportNotice} n where n.case_id = ${supportCase.id}
          and n.recipient_user_id is not null and n.email_state <> 'omitido' and n.created_at > ${recently.toISOString()}::timestamptz)`,
        // Quien ya no está en la clínica no recibe nada.
        sql`(${supportCase.organizationId} is null or exists (select 1 from ${member} m
          where m.user_id = ${supportCase.openedBy} and m.organization_id = ${supportCase.organizationId}))`,
      ),
    )
    .orderBy(asc(supportCase.lastPublicMessageAt))
    .limit(200)
  for (const kase of due) {
    if (!kase.lastPublicMessageAt) continue
    await ownerDb
      .insert(supportNotice)
      .values({
        caseId: kase.id,
        organizationId: kase.organizationId,
        kind: kase.status === "esperando_clinica" ? "necesita_algo" : "respuesta",
        recipientUserId: kase.openedBy,
        dedupeKey: `persona:${kase.id}:${kase.lastPublicMessageAt.getTime()}`,
        // La hora de la vuelta: el «uno por hora» se mide con el mismo reloj.
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: supportNotice.dedupeKey })
  }
  const pending = await ownerDb
    .select({ id: supportNotice.id, recipient: supportNotice.recipientUserId })
    .from(supportNotice)
    .where(eq(supportNotice.emailState, "pendiente"))
    .orderBy(asc(supportNotice.createdAt))
    .limit(200)
  return pending.map((row) => ({ id: row.id, inbox: row.recipient === null }))
}

/** Lo que el worker necesita para escribir el correo; nunca el texto del caso. */
export interface ClaimedSupportNotice {
  id: string
  kind: SupportNoticeKind
  caseId: string
  /** Nulo: va al buzón de soporte. */
  to: string | null
  organizationId: string | null
  clinicName: string | null
  clinicSlug: string | null
  caseKind: "pregunta" | "problema" | "acceso"
  /** «Automatizaciones › Recordar la cita», o la ruta si la guía no la conoce. */
  screen: string
  /** El nombre corto de la pantalla: «Pregunta · Automatizaciones». */
  topic: string
  who: string
  role: string
}

/**
 * Reclamo durable ANTES del SMTP: pendiente → reclamado en una sola
 * actualización. Solo quien reclama envía. Un aviso a la persona se vuelve a
 * mirar al reclamar: si ya lo vio, se resolvió o dejó la clínica, queda
 * «omitido» y no sale.
 */
export async function claimSupportNotice(ownerDb: Db, id: string): Promise<ClaimedSupportNotice | null> {
  const [notice] = await ownerDb
    .update(supportNotice)
    .set({ emailState: "reclamado", updatedAt: new Date() })
    .where(and(eq(supportNotice.id, id), eq(supportNotice.emailState, "pendiente")))
    .returning()
  if (!notice) return null
  const [row] = await ownerDb
    .select({
      kase: supportCase,
      clinicName: organization.name,
      clinicSlug: organization.slug,
      openerName: user.name,
    })
    .from(supportCase)
    .leftJoin(organization, eq(organization.id, supportCase.organizationId))
    // Sin autor: el caso automático de odentIA («Modelo sin responder»).
    .leftJoin(user, eq(user.id, supportCase.openedBy))
    .where(eq(supportCase.id, notice.caseId))
    .limit(1)
  const omit = async (reason: string) => {
    await ownerDb
      .update(supportNotice)
      .set({ emailState: "omitido", error: reason, updatedAt: new Date() })
      .where(eq(supportNotice.id, notice.id))
    return null
  }
  if (!row) return omit("el caso ya no existe")
  const { kase } = row
  let to: string | null = null
  if (notice.recipientUserId) {
    if (kase.status === "resuelto") return omit("el caso se resolvió")
    const last = kase.lastPublicMessageAt?.getTime() ?? null
    const seen = kase.clientSeenAt?.getTime() ?? null
    if (last === null || (seen !== null && seen >= last)) return omit("ya vio la respuesta")
    if (kase.organizationId) {
      const [still] = await ownerDb
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.userId, notice.recipientUserId), eq(member.organizationId, kase.organizationId)))
        .limit(1)
      if (!still) return omit("ya no está en la clínica")
    }
    const [person] = await ownerDb
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, notice.recipientUserId))
      .limit(1)
    if (!person?.email) return omit("sin correo")
    to = person.email
  }
  const topic = helpTopicForScreen(kase.screen)
  const caseKind = kase.kind === "problema" || kase.kind === "acceso" ? kase.kind : "pregunta"
  return {
    id: notice.id,
    kind: notice.kind as SupportNoticeKind,
    caseId: kase.id,
    to,
    organizationId: kase.organizationId,
    // El automático no es de una clínica: su título la nombra («Modelo sin responder · Clínica Smile»).
    clinicName: row.clinicName ?? (kase.openedBy === null ? kase.question.split(" · ").slice(1).join(" · ") || null : null),
    clinicSlug: row.clinicSlug,
    caseKind,
    screen: topic ? helpTopicLabel(topic) : kase.screen,
    topic: topic?.title ?? kase.screen,
    who: row.openerName ?? "odentIA",
    role: kase.role,
  }
}

/** Cierra el reclamo: enviado, o incierto con su motivo (incierto no vuelve a pendiente). */
export async function completeSupportNotice(
  ownerDb: Db,
  id: string,
  ok: boolean,
  error?: string,
  now = new Date(),
): Promise<void> {
  await ownerDb
    .update(supportNotice)
    .set(
      ok
        ? { emailState: "enviado", emailedAt: now, updatedAt: now }
        : { emailState: "incierto", error: (error ?? "fallo de envío").slice(0, 500), updatedAt: now },
    )
    .where(and(eq(supportNotice.id, id), eq(supportNotice.emailState, "reclamado")))
}
