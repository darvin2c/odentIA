import { ALL_PERMISSIONS, canAccess } from "@odentia/auth/permissions"
import { BASE_PRODUCT, type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { member, organization } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import { pushSubscription, workspaceNotification } from "@odentia/db/schema/workspace"
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm"
import type { PgUpdateSetSource } from "drizzle-orm/pg-core"
import { validation } from "./errors.js"
import { isOpportune } from "./opportune-hours.js"
import { clinicOpenSchedule } from "./topic-urgency.js"
import { listWorkspaceWaitingPeople, type WorkspaceAccess, workspaceAccessFor } from "./workspace.js"

/**
 * Avisos en el equipo (push web, ADR 0176). No son una tercera bandeja: dicen
 * que algo cambió en lo que ya existe y la app cuenta qué.
 *
 * - «Te espera»: aparece una persona nueva en lo que cuenta Inicio para quien
 *   mira (`listWorkspaceWaitingPeople`, la misma regla). Solo con la clínica
 *   abierta; lo de la noche llega al abrir.
 * - El servicio cortado (WhatsApp o Sofi): los avisos de la campana con estos
 *   asuntos, a cualquier hora, a quien los recibe en la campana.
 *
 * El texto nunca lleva el nombre de una persona ni lo que escribió: se ve con
 * el teléfono bloqueado. El nombre se ve al abrir, con sesión.
 */
export const PUSH_SERVICE_SUBJECTS = [
  "clave-meta",
  "firma-meta",
  "vence-clave-meta",
  "meta-desconecto",
  "clave-propia",
  "modelo-del-agente",
] as const

/** Entre dos avisos de «Te espera» al mismo equipo: el siguiente reemplaza al anterior. */
export const PUSH_WAITING_GAP_MS = 3 * 60_000

/** Lo que el navegador entrega al suscribirse (`PushSubscription.toJSON()`). */
export interface PushKeys {
  endpoint: string
  p256dh: string
  auth: string
}

/** Lo que muestra el equipo. `tag` hace que el siguiente del mismo tipo reemplace al anterior. */
export interface PushMessage {
  title: string
  body: string
  tag: "te-espera" | "servicio" | "listo"
  href: string
  icon: string
}

export interface PushDelivery extends PushKeys {
  subscriptionId: string
  orgId: string
  message: PushMessage
  /** Cuánto lo guarda el servicio de push si el equipo está apagado: un «te esperan» viejo confunde. */
  ttlSeconds: number
  urgency: "high" | "normal"
}

const KEY_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/

function checkKeys(keys: PushKeys): PushKeys {
  let url: URL
  try {
    url = new URL(keys.endpoint)
  } catch {
    throw validation("La dirección del equipo no es válida")
  }
  if (url.protocol !== "https:" || keys.endpoint.length > 1000) throw validation("La dirección del equipo no es válida")
  if (!KEY_PATTERN.test(keys.p256dh) || keys.p256dh.length > 200 || !KEY_PATTERN.test(keys.auth) || keys.auth.length > 100)
    throw validation("Las claves del equipo no son válidas")
  return keys
}

/**
 * Este equipo recibe los avisos de quien lo activa. Si el equipo ya estaba
 * suscrito con otra persona (la compu del mostrador), pasa a quien lo activó
 * ahora. Lo que ya espera no se vuelve a avisar: se avisa lo que llegue después,
 * y antes sale «Listo» para que se vea que funciona.
 */
export async function savePushSubscription(tx: Db, orgId: string, userId: string, access: WorkspaceAccess, keys: PushKeys) {
  const { endpoint, p256dh, auth } = checkKeys(keys)
  const seen = await listWorkspaceWaitingPeople(tx, orgId, userId, access)
  await tx.insert(pushSubscription)
    .values({ organizationId: orgId, userId, endpoint, p256dh, auth, waitingSeen: seen })
    .onConflictDoUpdate({
      target: [pushSubscription.organizationId, pushSubscription.endpoint],
      set: { userId, p256dh, auth, welcomedAt: null, waitingSeen: seen, waitingPushedAt: null, noticesSince: sql`now()`, createdAt: sql`now()` },
    })
  return { active: true }
}

/** Si este equipo recibe hoy los avisos de quien mira (otra persona pudo activarlo después). */
export async function getPushSubscription(tx: Db, orgId: string, userId: string, endpoint: string) {
  const [row] = await tx.select({ id: pushSubscription.id }).from(pushSubscription)
    .where(and(eq(pushSubscription.organizationId, orgId), eq(pushSubscription.userId, userId), eq(pushSubscription.endpoint, endpoint)))
    .limit(1)
  return { active: Boolean(row) }
}

/** Apagar los avisos en este equipo (también al cerrar sesión). Solo los de quien lo pide. */
export async function deletePushSubscription(tx: Db, orgId: string, userId: string, endpoint: string) {
  await tx.delete(pushSubscription)
    .where(and(eq(pushSubscription.organizationId, orgId), eq(pushSubscription.userId, userId), eq(pushSubscription.endpoint, endpoint)))
  return { active: false }
}

/** El servicio de push dijo que el equipo ya no existe (404/410): no se le vuelve a enviar. */
export async function forgetPushSubscription(tx: Db, orgId: string, subscriptionId: string) {
  await tx.delete(pushSubscription).where(and(eq(pushSubscription.organizationId, orgId), eq(pushSubscription.id, subscriptionId)))
}

/** Las clínicas con algún equipo suscrito (con el dueño de la base: cruza clínicas). */
export async function pushSubscribedOrgs(ownerDb: Db): Promise<string[]> {
  const rows = await ownerDb.selectDistinct({ orgId: pushSubscription.organizationId }).from(pushSubscription)
  return rows.map((row) => row.orgId)
}

export function waitingPushBody(people: number): string {
  return people === 1 ? "Te espera 1 persona" : `Te esperan ${people} personas`
}

/** El ícono del producto (`public/pwa/` de clinic-app): el de la clínica sería su logo, que no tiene forma ni tamaño fijos. */
const PRODUCT_ICONS: Record<ClinicalProduct, string> = {
  dental: "/pwa/odentia-192.png",
  medical: "/pwa/latidia-192.png",
  optical: "/pwa/vistia-192.png",
}

/**
 * Lo que toca enviar ahora en una clínica. Anota lo avisado en la misma
 * transacción, antes de enviar: si el envío falla o queda en duda, no se repite
 * (un aviso perdido se ve igual en Inicio; uno repetido aturde). Las filas se
 * toman con `skip locked`, así dos workers no avisan dos veces lo mismo.
 */
export async function collectOrgPushes(tx: Db, orgId: string, now: Date = new Date()): Promise<PushDelivery[]> {
  const rows = await tx.execute<{
    id: string
    userId: string
    endpoint: string
    p256dh: string
    auth: string
    welcomedAt: string | null
    waitingSeen: string[]
    waitingPushedAt: string | null
    noticesSince: string
  }>(sql`select id, user_id as "userId", endpoint, p256dh, auth, welcomed_at::text as "welcomedAt",
      waiting_seen as "waitingSeen", waiting_pushed_at::text as "waitingPushedAt", notices_since::text as "noticesSince"
    from push_subscription where organization_id = ${orgId} order by created_at for update skip locked`)
  if (rows.length === 0) return []
  const [clinic] = await tx.select({ name: organization.name, product: orgProfile.product }).from(organization)
    .leftJoin(orgProfile, eq(orgProfile.organizationId, organization.id)).where(eq(organization.id, orgId)).limit(1)
  const roles = new Map((await tx.select({ userId: member.userId, role: member.role }).from(member)
    .where(and(eq(member.organizationId, orgId), inArray(member.userId, [...new Set(rows.map((row) => row.userId))]))))
    .map((row) => [row.userId, row.role]))
  // Sin horario cargado cuentan las horas de reloj, como en la urgencia de los temas.
  const schedule = await clinicOpenSchedule(tx, orgId, now)
  const open = !schedule || isOpportune(now, schedule)
  const product = clinic?.product
  const base = { title: clinic?.name ?? "Tu clínica", icon: PRODUCT_ICONS[isClinicalProduct(product) ? product : BASE_PRODUCT] }
  const deliveries: PushDelivery[] = []

  for (const row of rows) {
    const role = roles.get(row.userId)
    // Ya no es de la clínica: no recibe nada y su equipo se olvida.
    if (!role) {
      await forgetPushSubscription(tx, orgId, row.id)
      continue
    }
    const keys = { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }
    const send = (message: Omit<PushMessage, "title" | "icon">, ttlSeconds: number, urgency: PushDelivery["urgency"]) =>
      deliveries.push({ ...keys, subscriptionId: row.id, orgId, message: { ...base, ...message }, ttlSeconds, urgency })
    const update: PgUpdateSetSource<typeof pushSubscription> = {}

    if (!row.welcomedAt) {
      send({ tag: "listo", body: "Listo: los avisos llegarán a este equipo.", href: "/home" }, 3600, "normal")
      update.welcomedAt = now
    }

    // El servicio cortado: lo que la campana le avisa, con el permiso que tiene hoy.
    const permissions = ALL_PERMISSIONS.filter((permission) => canAccess(role, permission))
    // La hora va como texto de la base: en JavaScript se perderían los microsegundos y el último aviso saldría otra vez.
    const notices = await tx.select({ title: workspaceNotification.title, href: workspaceNotification.href, createdAt: sql<string>`${workspaceNotification.createdAt}::text` })
      .from(workspaceNotification)
      .where(and(
        eq(workspaceNotification.organizationId, orgId),
        eq(workspaceNotification.userId, row.userId),
        sql`${workspaceNotification.createdAt} > ${row.noticesSince}::timestamptz`,
        isNull(workspaceNotification.readAt),
        isNull(workspaceNotification.resolvedAt),
        inArray(workspaceNotification.permission, permissions),
        or(...PUSH_SERVICE_SUBJECTS.map((kind) => or(eq(workspaceNotification.subject, kind), sql`${workspaceNotification.subject} like ${`${kind}:%`}`))),
      ))
      .orderBy(asc(workspaceNotification.createdAt))
    const latest = notices.at(-1)
    if (latest) {
      send({ tag: "servicio", body: latest.title, href: latest.href }, 6 * 3600, "high")
      update.noticesSince = sql`${latest.createdAt}::timestamptz`
    }

    // «Te espera»: alguien que no estaba. Quien se fue y vuelve cuenta como nuevo.
    const people = await listWorkspaceWaitingPeople(tx, orgId, row.userId, workspaceAccessFor(role))
    const seen = new Set(row.waitingSeen)
    const fresh = people.some((person) => !seen.has(person))
    const rested = !row.waitingPushedAt || now.getTime() - Date.parse(row.waitingPushedAt) >= PUSH_WAITING_GAP_MS
    if (fresh && open && rested) {
      send({ tag: "te-espera", body: waitingPushBody(people.length), href: "/home" }, 30 * 60, "high")
      update.waitingSeen = people
      update.waitingPushedAt = now
    } else {
      // Lo nuevo sin avisar queda fuera de lo visto: sale al abrir la clínica o al pasar la pausa.
      const kept = row.waitingSeen.filter((person) => people.includes(person))
      if (kept.length !== row.waitingSeen.length) update.waitingSeen = kept
    }

    if (Object.keys(update).length > 0)
      await tx.update(pushSubscription).set(update).where(and(eq(pushSubscription.organizationId, orgId), eq(pushSubscription.id, row.id)))
  }
  return deliveries
}
