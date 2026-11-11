import { type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { supportCase, supportNotice } from "@odentia/db/schema/admin-support"
import { member, organization, user } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm"
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
 * está en la clínica, no se le escribe. Cuando soporte pidió el acceso de
 * diagnóstico y espera a la clínica, «necesita algo» también va a la
 * propietaria y a cada administrador: son quienes lo autorizan (ADR 0180).
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
 * Hasta cuándo respondemos un caso que nadie respondió todavía: días hábiles
 * desde que se abrió. Es un objetivo interno del equipo, no se promete a la
 * clínica («Responder hasta el…» en la cola y en Inicio).
 */
export const SUPPORT_ANSWER_BUSINESS_DAYS = 2

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
      clientSeenAt: supportCase.clientSeenAt,
      accessRequestedAt: supportCase.accessRequestedAt,
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
        // Quien preguntó no lo vio, o se pidió el acceso: eso también lo ven quienes lo autorizan.
        sql`(${supportCase.clientSeenAt} is null or ${supportCase.clientSeenAt} < ${supportCase.lastPublicMessageAt}
          or (${supportCase.status} = 'esperando_clinica' and ${supportCase.accessRequestedAt} is not null))`,
      ),
    )
    .orderBy(asc(supportCase.lastPublicMessageAt))
    .limit(200)
  for (const kase of due) {
    if (!kase.lastPublicMessageAt || !kase.openedBy) continue
    const answer = kase.lastPublicMessageAt.getTime()
    const unseen = kase.clientSeenAt === null || kase.clientSeenAt.getTime() < answer
    const recipients = unseen ? [kase.openedBy] : []
    if (kase.status === "esperando_clinica" && kase.accessRequestedAt && kase.organizationId) {
      const granters = await ownerDb
        .select({ userId: member.userId })
        .from(member)
        .where(and(eq(member.organizationId, kase.organizationId), inArray(member.role, ["owner", "admin"])))
      for (const granter of granters) if (granter.userId !== kase.openedBy) recipients.push(granter.userId)
    }
    for (const recipient of recipients) {
      // Quien ya no está en la clínica no recibe nada.
      if (kase.organizationId) {
        const [still] = await ownerDb
          .select({ id: member.id })
          .from(member)
          .where(and(eq(member.userId, recipient), eq(member.organizationId, kase.organizationId)))
          .limit(1)
        if (!still) continue
      }
      // Uno por caso y persona cada hora: cuenta todo aviso que salió o pudo salir.
      const [recent] = await ownerDb
        .select({ id: supportNotice.id })
        .from(supportNotice)
        .where(
          and(
            eq(supportNotice.caseId, kase.id),
            eq(supportNotice.recipientUserId, recipient),
            ne(supportNotice.emailState, "omitido"),
            gt(supportNotice.createdAt, recently),
          ),
        )
        .limit(1)
      if (recent) continue
      await ownerDb
        .insert(supportNotice)
        .values({
          caseId: kase.id,
          organizationId: kase.organizationId,
          kind: kase.status === "esperando_clinica" ? "necesita_algo" : "respuesta",
          recipientUserId: recipient,
          // Quien preguntó conserva la clave de siempre (la de los avisos que ya
          // salieron); los demás la llevan con su id: una por persona.
          dedupeKey:
            recipient === kase.openedBy ? `persona:${kase.id}:${answer}` : `persona:${kase.id}:${answer}:${recipient}`,
          // La hora de la vuelta: el «uno por hora» se mide con el mismo reloj.
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: supportNotice.dedupeKey })
    }
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
  /** El producto de la clínica: su dirección va en su dominio. */
  clinicProduct: ClinicalProduct | null
  caseKind: "pregunta" | "problema" | "acceso" | "cobro"
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
      clinicProduct: orgProfile.product,
      openerName: user.name,
    })
    .from(supportCase)
    .leftJoin(organization, eq(organization.id, supportCase.organizationId))
    .leftJoin(orgProfile, eq(orgProfile.organizationId, supportCase.organizationId))
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
    if (notice.recipientUserId !== kase.openedBy) {
      // A quien autoriza el acceso: solo mientras se le sigue esperando.
      if (kase.status !== "esperando_clinica" || kase.accessRequestedAt === null) return omit("ya no espera el acceso")
    } else {
      const last = kase.lastPublicMessageAt?.getTime() ?? null
      const seen = kase.clientSeenAt?.getTime() ?? null
      if (last === null || (seen !== null && seen >= last)) return omit("ya vio la respuesta")
    }
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
  const caseKind = kase.kind === "problema" || kase.kind === "acceso" || kase.kind === "cobro" ? kase.kind : "pregunta"
  return {
    id: notice.id,
    kind: notice.kind as SupportNoticeKind,
    caseId: kase.id,
    to,
    organizationId: kase.organizationId,
    // El automático no es de una clínica: su título la nombra («Modelo sin responder · Clínica Smile»).
    clinicName: row.clinicName ?? (kase.openedBy === null ? kase.question.split(" · ").slice(1).join(" · ") || null : null),
    clinicSlug: row.clinicSlug,
    clinicProduct: isClinicalProduct(row.clinicProduct) ? row.clinicProduct : null,
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
