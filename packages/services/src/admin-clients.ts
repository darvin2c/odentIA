import { ORG_ROLES, type OrgRole, roleLabel } from "@odentia/auth/permissions"
import { CLINICAL_PRODUCTS, type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  kairosAiUsage,
  kairosItem,
  SAAS_CLIENT_ORIGINS,
  SAAS_CLIENT_PROFESSIONALS,
  SAAS_CLIENT_TOOLS,
  SAAS_CONTACT_CHANNELS,
  SAAS_CONTACT_ROLES,
  type SaasActivityKind,
  type SaasChatChannel,
  type SaasClientOrigin,
  type SaasClientSummarySource,
  type SaasContactChannel,
  type SaasContactRole,
  type SaasLostReason,
  type SaasOpportunityDecision,
  type SaasOutreachChannel,
  type SaasTaskKind,
  saasChat,
  saasClient,
  saasClientContact,
  saasClientFile,
  saasClientMilestone,
  saasInboundEmail,
  saasOpportunity,
  saasOutreach,
  saasProposal,
  saasTask,
} from "@odentia/db/schema/admin-arm"
import { adminAudit, adminStaff } from "@odentia/db/schema/admin-core"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { supportCase } from "@odentia/db/schema/admin-support"
import { member, organization, user } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import {
  saasFollowUp,
  saasPayment,
  saasSeller,
  saasSubscription,
  saasWaitlistRequest,
} from "@odentia/db/schema/saas-billing"
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { z } from "zod"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import {
  type KairosSignal,
  type KairosSignalCode,
  kairosCoolingRows,
  kairosRiskRows,
} from "./admin-kairos.js"
import { computeOnboarding, type OnboardingOptions } from "./admin-onboarding.js"
import { listClinicLoads } from "./clinic-progress-report.js"
import {
  invalidField,
  issueFields,
  isUniqueViolation,
  notFound,
  ServiceError,
  validation,
} from "./errors.js"
import { limaDate } from "./peru-business-days.js"
import { moneyText } from "./saas-emails.js"
import { type WaitlistStage, waitlistStage } from "./saas-founders.js"
import { listSaasPlanChanges } from "./saas-terms.js"

/**
 * Los clientes del ARM de la administración (ADR 0185): la clínica es el eje,
 * desde el primer contacto (a mano, con la solicitud de la web o cuando abre
 * su cuenta) y para siempre. La solicitud y la cuenta son cosas que le pasan
 * al cliente, no el cliente.
 *
 * - La etapa se calcula al leer, nunca se guarda: `clientStageSql` es la
 *   única regla, en SQL, para la lista, la ficha y el Embudo.
 * - Un parecido nunca se fusiona solo: `createClient` avisa con 409
 *   `CLIENT_MAYBE_DUPLICATE` y una persona de Administración fusiona
 *   (`mergeClients`).
 * - Una persona se liga a un usuario solo por correo exacto y con el sí de
 *   Administración (`linkContactToUser`), nunca por teléfono.
 * - Soporte ve clientes, contactos, tareas e historial, sin importes ni lo
 *   «solo administración»; asignar responsable, fusionar y archivar son de
 *   Administración. El servidor lo exige aunque la pantalla lo oculte.
 *
 * Todo recibe `tx: Db` con la conexión propietaria, después del guard del
 * personal; la transacción la abre la ruta.
 */

/* ---------- Palabras ---------- */

export const CLIENT_STAGES = [
  "contacto",
  "presentacion_agendada",
  "presentacion_hecha",
  "propuesta",
  "entro",
  "no_por_ahora",
  "perdido",
] as const
export type ClientStage = (typeof CLIENT_STAGES)[number]

/** Las etapas de la venta, antes de decidir: lo que está «por vender». */
const SELLING_STAGES = [
  "contacto",
  "presentacion_agendada",
  "presentacion_hecha",
  "propuesta",
] as const

export const CLIENT_STAGE_WORDS: Record<ClientStage, string> = {
  contacto: "Contacto",
  presentacion_agendada: "Presentación agendada",
  presentacion_hecha: "Presentación hecha",
  propuesta: "Propuesta",
  entro: "Entró",
  no_por_ahora: "No por ahora",
  perdido: "Perdido",
}

export const CLIENT_ORIGIN_WORDS: Record<SaasClientOrigin, string> = {
  web: "Web",
  referido: "Referido",
  evento: "Evento",
  whatsapp: "WhatsApp directo",
  redes: "Redes o anuncio",
  busqueda: "Salimos a buscarla",
  otro: "Otro",
}

export const LOST_REASON_WORDS: Record<SaasLostReason, string> = {
  precio: "Precio",
  sigue_con_lo_que_usa: "Sigue con lo que usa",
  no_es_el_momento: "No es el momento",
  no_respondio: "No respondió",
  le_falta_una_funcion: "Le falta una función",
  no_es_una_clinica: "No es una clínica",
  otro: "Otro",
}

/* ---------- Guardas ---------- */

function forbidden(message: string): ServiceError {
  return new ServiceError("FORBIDDEN", 403, message)
}

/** Personal verificado por el guard; el sistema y Kairós no pasan por aquí. */
function requireStaff(actor: AdminActor | null): AdminActor {
  if (!actor) throw forbidden("Se requiere personal de la administración")
  return actor
}

function requireAdmin(actor: AdminActor | null): AdminActor {
  const staff = requireStaff(actor)
  if (staff.role !== "admin") throw forbidden("Solo Administración puede hacer esto")
  return staff
}

const isAdmin = (actor: AdminActor) => actor.role === "admin"

/**
 * ¿Puede este actor poner una tarea de este tipo? Las de cobro son solo de la
 * administración: para Soporte no existen, como los casos de cobro (ADR 0181).
 * Solo para crear; para ver una que ya existe, `seesTask`.
 */
export const seesTaskKind = (actor: AdminActor, kind: string): boolean =>
  kind !== "cobro" || actor.role === "admin"

/** ¿Es una tarea que Soporte no ve? Las marcadas solo de Administración y las de cobro. */
export const taskHiddenFromSupport = (task: {
  kind: string
  adminOnly?: boolean | null
}): boolean => Boolean(task.adminOnly) || task.kind === "cobro"

/** ¿Ve este actor esta tarea? Administración, todas; Soporte, las que no le son ajenas. */
export const seesTask = (
  actor: AdminActor,
  task: { kind: string; adminOnly?: boolean | null },
): boolean => actor.role === "admin" || !taskHiddenFromSupport(task)

const TASK_ALIAS = /^[a-z_][a-z0-9_]*$/

/**
 * La condición SQL de `taskHiddenFromSupport`. Sin alias, con las columnas de
 * `saasTask`; con alias (`t`), para SQL crudo.
 */
export function taskHiddenFromSupportSql(alias?: string): SQL {
  if (alias === undefined) return sql`(${saasTask.adminOnly} or ${saasTask.kind} = 'cobro')`
  if (!TASK_ALIAS.test(alias)) throw new Error(`Alias inválido: ${alias}`)
  return sql.raw(`(${alias}.admin_only or ${alias}.kind = 'cobro')`)
}

/** Las tareas que ve el actor, en SQL: sin nada para la administración. */
export const visibleTaskSql = (actor: AdminActor, alias?: string): SQL | undefined =>
  actor.role === "admin" ? undefined : sql`not ${taskHiddenFromSupportSql(alias)}`

/* ---------- Tareas ---------- */

/**
 * ¿Vencida? Abierta y de un día anterior, o de hoy con una hora que ya pasó.
 * La única regla: lista, ficha, Hoy, las tareas y «Por venir» de la Venta.
 */
export function taskOverdue(
  task: { status?: string; dueOn: string; dueAt: Date | null },
  now: Date,
): boolean {
  if (task.status !== undefined && task.status !== "abierta") return false
  return task.dueOn < limaDate(now) || (task.dueAt !== null && task.dueAt.getTime() < now.getTime())
}

/* ---------- Propuestas: reemplazada, vigente y de la venta abierta ---------- */

/**
 * La versión más nueva del mismo cliente que salió después de esta: la que la
 * reemplaza, o null. `p` es el alias de `saas_proposal` en la consulta. La
 * única regla de «reemplazada»: la usan la ficha (`replacedBy`), aceptar y
 * reenviar y, con `proposalReplacedSql`, la etapa, el Embudo, la previsión y
 * Kairós. Gemela de `proposalDisplayStatus` (`admin-sales.ts`): si cambia una,
 * cambia la otra.
 */
export function proposalReplacedBySql(alias = "p"): SQL<number | null> {
  const p = sql.raw(alias)
  return sql<number | null>`(select max(newer.version) from admin.saas_proposal newer
    where newer.client_id = ${p}.client_id and newer.version > ${p}.version and newer.sent_at is not null)`
}

/** «Reemplazada»: le salió después una versión más nueva. Se calcula al leer, como «vencida». */
export function proposalReplacedSql(alias = "p"): SQL<boolean> {
  return sql<boolean>`(${proposalReplacedBySql(alias)} is not null)`
}

/** Vigente: enviada, su último día llega a hoy y no la reemplazó otra. */
export function proposalLiveSql(today: string, alias = "p"): SQL<boolean> {
  const p = sql.raw(alias)
  return sql<boolean>`(${p}.status = 'enviada' and ${p}.valid_until >= ${today}::date
    and not ${proposalReplacedSql(alias)})`
}

/**
 * De la venta abierta: el cliente tiene una venta sin decidir y la propuesta
 * se armó desde que se abrió. La de una venta perdida, en «no por ahora» o ya
 * entrada no cuenta: ni en la etapa, ni en el Embudo, ni en la previsión, ni
 * para Kairós, ni en el alta.
 */
export function proposalOfOpenSaleSql(alias = "p"): SQL<boolean> {
  const p = sql.raw(alias)
  return sql<boolean>`exists (select 1 from admin.saas_opportunity sale
    where sale.client_id = ${p}.client_id and sale.decision is null and ${p}.created_at >= sale.created_at)`
}

/**
 * ¿Es solo de Administración un envío? Lleva una propuesta, sale de algo de
 * Kairós que solo ve Administración, responde un correo que no llegó a
 * soporte@ (lo comercial: puede hablar de precios) o está marcado
 * `admin_only`: lo marcó así quien respondió, o salió en una conversación de
 * WhatsApp, Instagram o Messenger que no era de una clínica con su app. Eso se
 * fija al reservar el envío (y sube si la conversación pasa a un cliente sin
 * app), no al leer: lo de la venta no aparece después para Soporte.
 * `o` es el alias de `saas_outreach`.
 */
export function outreachAdminOnlySql(alias = "o"): SQL<boolean> {
  const o = sql.raw(alias)
  return sql<boolean>`(${o}.proposal_id is not null or ${o}.admin_only or exists (select 1 from admin.kairos_item ki
    where ki.id = ${o}.kairos_item_id and ki.admin_only) or exists (select 1 from admin.saas_inbound_email ie
    where ie.id = ${o}.in_reply_to_email_id and ie.mailbox <> 'soporte'))`
}

/**
 * «soporte», «hola» o, en la dirección de una persona, su parte local real
 * («ana.torres», sin `+etiqueta`): el «a quién escribió» de los textos.
 */
export function inboundMailboxWords(email: { mailbox: string; toAddress: string }): string {
  if (email.mailbox !== "persona") return email.mailbox
  return email.toAddress.split("@")[0]?.split("+")[0]?.trim().toLowerCase() || "persona"
}

/* ---------- La etapa ---------- */

/**
 * Los hechos de los que sale la etapa, en SQL sobre la fila de `saas_client`
 * de la consulta. Lo de la venta (propuesta, presentación) cuenta solo desde
 * que se abrió la venta abierta: una propuesta de una venta perdida no
 * adelanta la nueva.
 */
function stageFactsSql(now: Date) {
  const today = limaDate(now)
  const openSince = sql`(select o.created_at from ${saasOpportunity} o where o.client_id = ${saasClient.id} and o.decision is null limit 1)`
  return {
    /** Tiene cuenta (`organization_id`). */
    hasAccount: sql<boolean>`(${saasClient.organizationId} is not null)`,
    /** Hay una venta sin decidir. */
    openOpportunity: sql<boolean>`exists (select 1 from ${saasOpportunity} o where o.client_id = ${saasClient.id} and o.decision is null)`,
    /** Una propuesta de esta venta enviada y vigente, o ya aceptada. */
    proposalOut: sql<boolean>`exists (select 1 from ${saasProposal} p where p.client_id = ${saasClient.id}
      and ${proposalOfOpenSaleSql()} and (p.status = 'aceptada' or ${proposalLiveSql(today)}))`,
    /** Su solicitud está invitada (vigente o vencida: se ve dentro de «Propuesta»). */
    invited: sql<boolean>`exists (select 1 from ${saasWaitlistRequest} r where r.client_id = ${saasClient.id} and r.status = 'invitada')`,
    /**
     * Una presentación de esta venta. La que no se hizo («no se conectó»,
     * «reprogramar») queda como nota (`recordPresentation`), no como presentación.
     */
    presentationDone: sql<boolean>`exists (select 1 from ${saasFollowUp} f where f.client_id = ${saasClient.id}
      and f.kind = 'presentacion' and f.happened_at >= ${openSince})`,
    /** Una tarea de presentación abierta. */
    presentationScheduled: sql<boolean>`exists (select 1 from ${saasTask} t where t.client_id = ${saasClient.id} and t.kind = 'presentacion' and t.status = 'abierta')`,
    /** La decisión de la última venta decidida. */
    lastDecision: sql<SaasOpportunityDecision | null>`(select o.decision from ${saasOpportunity} o
      where o.client_id = ${saasClient.id} and o.decision is not null
      order by o.decided_at desc, o.created_at desc limit 1)`,
  }
}

/**
 * La etapa de un cliente, en SQL: la única regla (lista, ficha, Embudo y
 * Kairós), que filtra y cuenta sin que el tope de filas la corte. Con cuenta,
 * «Entró». Con la venta abierta, lo más avanzado que pasó: propuesta (o
 * invitación), presentación hecha, presentación agendada o contacto. Sin venta
 * abierta, la decisión de la última; sin ninguna, «Contacto».
 */
export function clientStageSql(now: Date): SQL<ClientStage> {
  const f = stageFactsSql(now)
  return sql<ClientStage>`(case
    when ${f.hasAccount} then 'entro'
    when ${f.openOpportunity} then (case
      when ${f.proposalOut} or ${f.invited} then 'propuesta'
      when ${f.presentationDone} then 'presentacion_hecha'
      when ${f.presentationScheduled} then 'presentacion_agendada'
      else 'contacto' end)
    else coalesce(${f.lastDecision}, 'contacto') end)`
}

/* ---------- La fase (ADR 0196) ---------- */

/**
 * La fase del cliente, lo que la lista, la ficha, la Bandeja y Kairós dicen de dónde está: por
 * vender (sin cuenta y sin decidir que no), en alta (con cuenta, hasta su primer pago confirmado) y
 * activo (con un pago confirmado o devuelto, que se pagó). Sin cuenta y con la venta decidida, su
 * decisión: «No por ahora» o «Perdido». Como la etapa, se calcula y nunca se guarda.
 */
export const CLIENT_PHASES = ["por_vender", "en_alta", "activo", "no_por_ahora", "perdido"] as const
export type ClientPhase = (typeof CLIENT_PHASES)[number]

export const CLIENT_PHASE_WORDS: Record<ClientPhase, string> = {
  por_vender: "Por vender",
  en_alta: "En alta",
  activo: "Activo",
  no_por_ahora: "No por ahora",
  perdido: "Perdido",
}

/**
 * Su cuenta tiene un pago que cuenta: confirmado o devuelto. Es la regla del paso «Primer pago
 * confirmado» del alta (`computeOnboarding`): con solo pagos revertidos, ese paso se pierde y la
 * clínica vuelve a «En alta».
 */
export function clientPaidSql(): SQL<boolean> {
  return sql<boolean>`exists (select 1 from ${saasPayment} pp where pp.organization_id = ${saasClient.organizationId}
    and pp.confirmed_at is not null and pp.status in ('confirmado', 'devuelto'))`
}

/** La fase en SQL, sobre la fila de `saas_client` de la consulta: la única regla. */
export function clientPhaseSql(now: Date): SQL<ClientPhase> {
  return sql<ClientPhase>`(case
    when ${saasClient.organizationId} is not null then (case when ${clientPaidSql()} then 'activo' else 'en_alta' end)
    else (case ${clientStageSql(now)} when 'no_por_ahora' then 'no_por_ahora' when 'perdido' then 'perdido'
      else 'por_vender' end) end)`
}

/** La misma regla para lo que ya se leyó: la etapa, si tiene cuenta y si pagó. */
export function clientPhaseOf(input: {
  stage: ClientStage
  hasAccount: boolean
  paid: boolean
}): ClientPhase {
  if (input.hasAccount) return input.paid ? "activo" : "en_alta"
  if (input.stage === "no_por_ahora" || input.stage === "perdido") return input.stage
  return "por_vender"
}

/* ---------- Tipos públicos ---------- */

export type ClientRow = typeof saasClient.$inferSelect

export interface ClientPerson {
  userId: string
  name: string
}

export interface ClientNextStep {
  taskId: string
  kind: SaasTaskKind
  title: string
  /** Día de Lima. */
  dueOn: string
  dueAt: Date | null
  overdue: boolean
}

/** Las señales de Kairós (`KAIROS_SIGNAL_CODES`) más «puede estar repetida». */
export type ClientSignalCode = KairosSignalCode | "duplicado"

/** Una señal que levanta Kairós al leer, con su «por qué» en palabras. */
export interface ClientSignal {
  code: ClientSignalCode
  words: string
}

/**
 * Las vistas de la lista, por fase (ADR 0196): por vender, en alta, activos, no por ahora,
 * perdidos y todos. «Con cuenta» se partió en «En alta» y «Activos»: el nombre de antes llega en
 * enlaces guardados y abre «En alta» (`CLIENT_VIEW_INPUTS`).
 */
export const CLIENT_VIEWS = [
  "por_vender",
  "en_alta",
  "activos",
  "no_por_ahora",
  "perdidos",
  "todos",
] as const
export type ClientView = (typeof CLIENT_VIEWS)[number]
/** Lo que se acepta al pedir la lista: las vistas y el nombre de antes, «con_cuenta». */
export const CLIENT_VIEW_INPUTS = [...CLIENT_VIEWS, "con_cuenta"] as const
export type ClientViewInput = (typeof CLIENT_VIEW_INPUTS)[number]

export interface ClientListFilter {
  view?: ClientViewInput
  product?: ClinicalProduct
  /** Un usuario, «mio» (quien consulta) o «sin» (sin responsable). */
  owner?: string
  origin?: SaasClientOrigin
  stage?: ClientStage
  /** Clínica, persona, correo o teléfono. */
  q?: string
  limit?: number
  offset?: number
}

export interface ClientListItem {
  id: string
  name: string
  product: ClinicalProduct
  stage: ClientStage
  /** La fase (`clientPhaseOf`): con cuenta, «En alta» o «Activo»; sin ella, la de la venta. */
  phase: ClientPhase
  nextStep: ClientNextStep | null
  owner: ClientPerson | null
  origin: SaasClientOrigin
  lastContactAt: Date | null
  organizationId: string | null
  signals: ClientSignal[]
  createdAt: Date
}

export interface ClientList {
  items: ClientListItem[]
  total: number
  counts: Record<ClientView, number>
}

/* ---------- Ayudas ---------- */

const E164 = /^\+[1-9][0-9]{6,14}$/

/** El celular como se escribe (+51 987 654 321) a E.164; nunca completa el prefijo del país. */
export function normalizeClientPhone(raw: string): string | null {
  const compact = raw.replace(/[\s().-]/g, "")
  return E164.test(compact) ? compact : null
}

const phoneSchema = z
  .string()
  .trim()
  .min(1, "Escribe el celular")
  .transform((value, ctx) => {
    const phone = normalizeClientPhone(value)
    if (!phone) {
      ctx.addIssue({
        code: "custom",
        message: "Escribe el celular con el código del país, como +51 987 654 321",
      })
      return z.NEVER
    }
    return phone
  })

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .email("Escribe un correo válido, como nombre@clinica.com")
      .max(254, "Usa como máximo 254 caracteres"),
  )

const textField = (max: number, what: string) =>
  z.string().trim().min(1, `Escribe ${what}`).max(max, `Usa como máximo ${max} caracteres`)

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Usa como máximo ${max} caracteres`)
    .transform((value) => (value === "" ? null : value))

const rolesSchema = z
  .array(z.enum(SAAS_CONTACT_ROLES, "Elige quién decide, quién la usa o quién paga"))
  .max(SAAS_CONTACT_ROLES.length)
  .transform((roles) => [...new Set(roles)])

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

function parse<T extends z.ZodType>(schema: T, raw: unknown, fallback: string): z.output<T> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw validation(parsed.error.issues[0]?.message ?? fallback, issueFields(parsed.error.issues))
  }
  return parsed.data
}

async function userNames(
  tx: Db,
  ids: Iterable<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))]
  if (!unique.length) return new Map()
  const rows = await tx
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(inArray(user.id, unique))
  return new Map(rows.map((row) => [row.id, row.name]))
}

/** El responsable tiene que ser del personal activo. */
async function assertActiveStaff(tx: Db, userId: string, field: string): Promise<void> {
  const [row] = await tx
    .select({ userId: adminStaff.userId })
    .from(adminStaff)
    .where(and(eq(adminStaff.userId, userId), eq(adminStaff.active, true)))
    .limit(1)
  if (!row) throw invalidField(field, "Elige a alguien del equipo de Sallca")
}

async function loadClient(tx: Db, id: string, lock = false): Promise<ClientRow> {
  if (!UUID.test(id)) throw notFound("Cliente")
  const query = tx.select().from(saasClient).where(eq(saasClient.id, id)).limit(1)
  const [row] = lock ? await query.for("update") : await query
  if (!row) throw notFound("Cliente")
  return row
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** ¿Es una demo para presentar? Las demos nunca son clientes. */
async function isDemoOrganization(tx: Db, organizationId: string): Promise<boolean> {
  const [row] = await tx.execute<{ demo: boolean }>(sql`select (
      exists (select 1 from ${saasDemo} d where d.organization_id = ${organizationId})
      or exists (select 1 from ${saasSubscription} s where s.organization_id = ${organizationId} and s.is_demo)
    ) as demo`)
  return Boolean(row?.demo)
}

/** Abre una venta si el cliente no tiene una abierta (una por cliente: la base lo asegura). */
async function openSaleIfNone(tx: Db, clientId: string, createdBy: string | null): Promise<void> {
  await tx.execute(sql`insert into ${saasOpportunity} (client_id, created_by)
    values (${clientId}, ${createdBy})
    on conflict (client_id) where decision is null do nothing`)
}

/**
 * El cliente entró: su venta abierta se cierra como «entró». Sin venta abierta
 * y sin otra que ya diga «entró», queda una decidida (el historial la cuenta).
 * Devuelve la venta que dice «entró». La única regla de «entró»: la usan el
 * alta, la invitación, la pasada de Kairós y `markOpportunityEntered`.
 */
export async function closeClientSaleAsEntered(
  tx: Db,
  clientId: string,
  actor: AdminActor | null,
  now = new Date(),
): Promise<string> {
  const closed = await tx
    .update(saasOpportunity)
    .set({
      decision: "entro",
      decidedAt: now,
      decidedBy: actor?.userId ?? null,
      returnOn: null,
      updatedAt: now,
    })
    .where(and(eq(saasOpportunity.clientId, clientId), isNull(saasOpportunity.decision)))
    .returning({ id: saasOpportunity.id })
  if (closed[0]) return closed[0].id
  const [entered] = await tx
    .select({ id: saasOpportunity.id })
    .from(saasOpportunity)
    .where(and(eq(saasOpportunity.clientId, clientId), eq(saasOpportunity.decision, "entro")))
    .limit(1)
  if (entered) return entered.id
  const [created] = await tx
    .insert(saasOpportunity)
    .values({
      clientId,
      decision: "entro",
      decidedAt: now,
      decidedBy: actor?.userId ?? null,
      createdBy: actor?.userId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: saasOpportunity.id })
  if (!created) throw new ServiceError("INTERNAL", 500, "No se pudo cerrar la venta")
  return created.id
}

/* ---------- Lista ---------- */

/**
 * Los pares de fichas que pueden ser la misma clínica y que una persona puede
 * fusionar (`mergeClients`): las dos vivas, del mismo producto, que no tengan
 * cuenta las dos y con una persona con el mismo correo (`a_id`, `b_id`,
 * `email`; cada par sale en los dos sentidos). La única regla de «puede estar
 * repetida» en la lista y de la propuesta `duplicado` de Kairós: nunca se
 * propone una fusión que `mergeClients` rechazaría.
 */
export const clientDuplicatePairsSql: SQL = sql`select k.client_id as a_id, k2.client_id as b_id, k.email
  from ${saasClientContact} k
  join ${saasClientContact} k2 on k2.email = k.email and k2.client_id <> k.client_id
  join ${saasClient} c1 on c1.id = k.client_id
  join ${saasClient} c2 on c2.id = k2.client_id
  where k.email is not null
    and c1.archived_at is null and c2.archived_at is null
    and c1.product = c2.product
    and (c1.organization_id is null or c2.organization_id is null)`

/** Otra ficha viva tiene una persona con el mismo correo y se puede fusionar con esta. */
const duplicateSql = sql<boolean>`exists (
  select 1 from (${clientDuplicatePairsSql}) p where p.a_id = ${saasClient.id})`

const lastContactSql =
  sql`(select max(f.happened_at) from ${saasFollowUp} f where f.client_id = ${saasClient.id} and not f.from_note)`.mapWith(
    saasFollowUp.happenedAt,
  )

function searchSql(q: string): SQL {
  const digits = q.replace(/\D/g, "")
  const byPhone =
    digits.length >= 4 ? sql`or position(${digits} in search_digits(k.phone)) > 0` : sql``
  return sql`(position(search_fold(${q}) in search_fold(${saasClient.name})) > 0
    or exists (select 1 from ${saasClientContact} k where k.client_id = ${saasClient.id} and (
      position(search_fold(${q}) in search_fold(k.name)) > 0
      or position(lower(${q}) in coalesce(k.email, '')) > 0
      ${byPhone})))`
}

/**
 * Cada vista en SQL, con la misma regla de la fase (`clientPhaseSql`): por vender es sin cuenta y
 * en una etapa de la venta; en alta, con cuenta y sin un pago que cuente (`clientPaidSql`);
 * activos, con cuenta y con él. `stage` y `paid` se calculan una vez por fila.
 */
function viewSql(view: ClientView, stage: SQL<ClientStage>, paid: SQL<boolean>): SQL {
  const selling = sql.raw(SELLING_STAGES.map((s) => `'${s}'`).join(","))
  switch (view) {
    case "por_vender":
      return sql`(${saasClient.organizationId} is null and ${stage} in (${selling}))`
    case "en_alta":
      return sql`(${saasClient.organizationId} is not null and not ${paid})`
    case "activos":
      return sql`(${saasClient.organizationId} is not null and ${paid})`
    case "no_por_ahora":
      return sql`(${stage} = 'no_por_ahora')`
    case "perdidos":
      return sql`(${stage} = 'perdido')`
    case "todos":
      return sql`true`
  }
}

/** La vista pedida, con el nombre de antes («con_cuenta») como «En alta». */
const viewSchema = z
  .enum(CLIENT_VIEW_INPUTS, "Elige una vista")
  .transform((view): ClientView => (view === "con_cuenta" ? "en_alta" : view))

const listFilterSchema = z.strictObject({
  view: viewSchema.optional(),
  product: z.enum(CLINICAL_PRODUCTS, "Elige un producto").optional(),
  owner: z.string().trim().min(1).max(120).optional(),
  origin: z.enum(SAAS_CLIENT_ORIGINS, "Elige cómo llegó").optional(),
  stage: z.enum(CLIENT_STAGES, "Elige una etapa").optional(),
  q: z.string().trim().max(120, "Busca con 120 caracteres como mucho").optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
})

const DUPLICATE_SIGNAL: ClientSignal = {
  code: "duplicado",
  words: "Puede estar repetida: otra ficha tiene el mismo correo",
}

const asClientSignal = (signal: KairosSignal): ClientSignal => ({
  code: signal.code,
  words: signal.words,
})

/**
 * Las señales de venta de unos clientes: las de Kairós (se enfría, sin
 * próximo paso, invitación vencida, propuesta sin respuesta; la regla vive en
 * `kairosCoolingRows`) y «puede estar repetida». La misma regla en la lista,
 * la ficha, el embudo, Hoy y la pasada de Kairós. Soporte no recibe las de
 * dinero.
 */
export async function clientSignals(
  tx: Db,
  actor: AdminActor,
  clientIds: readonly string[],
  now = new Date(),
): Promise<Map<string, ClientSignal[]>> {
  const staff = requireStaff(actor)
  const out = new Map<string, ClientSignal[]>()
  const ids = [...new Set(clientIds)]
  if (ids.length === 0) return out
  for (const row of await kairosCoolingRows(tx, staff, now, { clientIds: ids }))
    out.set(row.clientId, row.signals.map(asClientSignal))
  const repeated = await tx
    .select({ id: saasClient.id })
    .from(saasClient)
    .where(and(inArray(saasClient.id, ids), duplicateSql))
  for (const { id } of repeated) out.set(id, [...(out.get(id) ?? []), DUPLICATE_SIGNAL])
  return out
}

/** El próximo paso de cada cliente: su tarea abierta más próxima que el actor ve (lista, ficha y Embudo). */
export async function nextSteps(
  tx: Db,
  actor: AdminActor,
  clientIds: string[],
  now: Date,
): Promise<Map<string, ClientNextStep>> {
  if (!clientIds.length) return new Map()
  const today = limaDate(now)
  const rows = await tx
    .selectDistinctOn([saasTask.clientId], {
      clientId: saasTask.clientId,
      id: saasTask.id,
      kind: saasTask.kind,
      title: saasTask.title,
      dueOn: saasTask.dueOn,
      dueAt: saasTask.dueAt,
    })
    .from(saasTask)
    .where(
      and(
        inArray(saasTask.clientId, clientIds),
        eq(saasTask.status, "abierta"),
        visibleTaskSql(actor),
      ),
    )
    .orderBy(
      saasTask.clientId,
      asc(saasTask.dueOn),
      sql`${saasTask.dueAt} asc nulls last`,
      asc(saasTask.createdAt),
    )
  return new Map(
    rows.map((row) => [
      row.clientId,
      {
        taskId: row.id,
        kind: row.kind as SaasTaskKind,
        title: row.title,
        dueOn: row.dueOn,
        dueAt: row.dueAt,
        overdue: taskOverdue(row, now),
      },
    ]),
  )
}

/**
 * La lista de clientes por vista (Por vender, En alta, Activos, No por ahora,
 * Perdidos, Todos), con sus filtros. Los conteos de cada vista llevan los
 * mismos filtros. Las archivadas no salen.
 */
export async function listClients(
  tx: Db,
  actor: AdminActor,
  raw: ClientListFilter = {},
  now = new Date(),
): Promise<ClientList> {
  const staff = requireStaff(actor)
  const filter = parse(listFilterSchema, raw, "Revisa los filtros")
  const view = filter.view ?? "por_vender"
  const limit = filter.limit ?? 50
  const offset = filter.offset ?? 0
  const stage = clientStageSql(now)
  const paid = clientPaidSql()

  const conditions: SQL[] = [isNull(saasClient.archivedAt)]
  if (filter.product) conditions.push(eq(saasClient.product, filter.product))
  if (filter.origin) conditions.push(eq(saasClient.origin, filter.origin))
  if (filter.owner === "mio") conditions.push(eq(saasClient.ownerUserId, staff.userId))
  else if (filter.owner === "sin") conditions.push(isNull(saasClient.ownerUserId))
  else if (filter.owner) conditions.push(eq(saasClient.ownerUserId, filter.owner))
  if (filter.stage) conditions.push(sql`${stage} = ${filter.stage}`)
  if (filter.q) conditions.push(searchSql(filter.q))
  const base = and(...conditions)

  const countRow = await tx
    .select(
      Object.fromEntries(
        CLIENT_VIEWS.map((v) => [
          v,
          sql<number>`(count(*) filter (where ${viewSql(v, stage, paid)}))::int`,
        ]),
      ) as Record<ClientView, SQL<number>>,
    )
    .from(saasClient)
    .where(base)
  const counts = Object.fromEntries(
    CLIENT_VIEWS.map((v) => [v, Number(countRow[0]?.[v] ?? 0)]),
  ) as Record<ClientView, number>

  const rows = await tx
    .select({
      id: saasClient.id,
      name: saasClient.name,
      product: saasClient.product,
      origin: saasClient.origin,
      organizationId: saasClient.organizationId,
      createdAt: saasClient.createdAt,
      ownerUserId: saasClient.ownerUserId,
      ownerName: user.name,
      stage,
      paid,
      lastContactAt: lastContactSql,
    })
    .from(saasClient)
    .leftJoin(user, eq(user.id, saasClient.ownerUserId))
    .where(and(base, viewSql(view, stage, paid)))
    .orderBy(
      // Soporte no ordena por una tarea que no ve.
      sql`(select min(t.due_on) from ${saasTask} t where t.client_id = ${saasClient.id} and t.status = 'abierta'
        and (not ${taskHiddenFromSupportSql("t")} or ${isAdmin(staff)})) asc nulls last`,
      desc(saasClient.createdAt),
      asc(saasClient.id),
    )
    .limit(limit)
    .offset(offset)

  const ids = rows.map((row) => row.id)
  const steps = await nextSteps(tx, staff, ids, now)
  const signals = await clientSignals(tx, staff, ids, now)
  const items = rows.map((row): ClientListItem => {
    const nextStep = steps.get(row.id) ?? null
    const lastContactAt = toDate(row.lastContactAt)
    return {
      id: row.id,
      name: row.name,
      product: row.product as ClinicalProduct,
      stage: row.stage,
      phase: clientPhaseOf({
        stage: row.stage,
        hasAccount: row.organizationId !== null,
        paid: Boolean(row.paid),
      }),
      nextStep,
      owner: row.ownerUserId ? { userId: row.ownerUserId, name: row.ownerName ?? "" } : null,
      origin: row.origin as SaasClientOrigin,
      lastContactAt,
      organizationId: row.organizationId,
      signals: signals.get(row.id) ?? [],
      createdAt: row.createdAt,
    }
  })
  return { items, total: counts[view], counts }
}

/* ---------- Crear (con duplicados) ---------- */

export const clientCreateSchema = z.strictObject({
  name: textField(160, "el nombre de la clínica"),
  product: z.enum(CLINICAL_PRODUCTS, "Elige el producto"),
  contact: z.strictObject({
    name: textField(160, "el nombre de la persona"),
    phone: phoneSchema.optional(),
    email: emailSchema.optional(),
  }),
  origin: z.enum(SAAS_CLIENT_ORIGINS, "Elige cómo llegó"),
  originDetail: optionalText(300).optional(),
  referredByClientId: z.uuid("Elige quién la refirió").optional(),
  ownerUserId: z.string().trim().min(1).max(120).optional(),
  city: optionalText(120).optional(),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Elige el país")
    .optional(),
  /** La persona ya vio los parecidos y dijo «Es otra». */
  confirmNew: z.boolean().optional(),
})
export type ClientCreateInput = z.input<typeof clientCreateSchema>

/** Por qué puede ser la misma clínica. El teléfono es solo una pista: no frena. */
export type DuplicateReason = "correo" | "solicitud" | "nombre" | "telefono"

export interface DuplicateHint {
  clientId: string | null
  requestId: string | null
  name: string
  why: DuplicateReason
  words: string
  hasAccount: boolean
}

/**
 * 409 `CLIENT_MAYBE_DUPLICATE`: la pantalla pregunta «¿es la misma?» con
 * `duplicates` (Abrir esa / Es otra, que reenvía con `confirmNew`). La ruta
 * los suma al cuerpo del error.
 */
export class ClientDuplicateError extends ServiceError {
  constructor(
    message: string,
    fields: Record<string, string>,
    public duplicates: DuplicateHint[],
  ) {
    super("CLIENT_MAYBE_DUPLICATE", 409, message, fields)
  }
}

/** Pasado este parecido (trigramas, sin tildes), dos nombres pueden ser la misma clínica. */
const NAME_SIMILARITY = 0.6

/**
 * Lo que puede ser la misma clínica: una persona con ese correo, una
 * solicitud con ese correo, un nombre parecido del mismo producto y, solo
 * como pista, una persona con ese teléfono. Nunca une nada: solo avisa.
 */
export async function findClientDuplicates(
  tx: Db,
  input: { name: string; product: ClinicalProduct; email?: string | null; phone?: string | null },
  exceptClientId?: string,
): Promise<DuplicateHint[]> {
  const hints: DuplicateHint[] = []
  const seen = new Set<string>()
  const add = (hint: DuplicateHint) => {
    const key = hint.clientId ?? `r:${hint.requestId}`
    if (seen.has(key) || (exceptClientId && hint.clientId === exceptClientId)) return
    seen.add(key)
    hints.push(hint)
  }
  const alive = isNull(saasClient.archivedAt)
  if (input.email) {
    const byEmail = await tx
      .selectDistinct({ id: saasClient.id, name: saasClient.name, org: saasClient.organizationId })
      .from(saasClientContact)
      .innerJoin(saasClient, eq(saasClient.id, saasClientContact.clientId))
      .where(and(eq(saasClientContact.email, input.email), alive))
      .limit(5)
    for (const row of byEmail) {
      add({
        clientId: row.id,
        requestId: null,
        name: row.name,
        why: "correo",
        words: `${row.name} tiene una persona con ese correo`,
        hasAccount: row.org !== null,
      })
    }
    const requests = await tx
      .select({
        id: saasWaitlistRequest.id,
        clinicName: saasWaitlistRequest.clinicName,
        clientId: saasWaitlistRequest.clientId,
        org: saasWaitlistRequest.organizationId,
        archived: saasClient.archivedAt,
      })
      .from(saasWaitlistRequest)
      .leftJoin(saasClient, eq(saasClient.id, saasWaitlistRequest.clientId))
      .where(eq(saasWaitlistRequest.email, input.email))
      .orderBy(desc(saasWaitlistRequest.createdAt))
      .limit(5)
    for (const row of requests) {
      if (row.archived) continue
      add({
        clientId: row.clientId,
        requestId: row.id,
        name: row.clinicName,
        why: "solicitud",
        words: `Hay una solicitud de ${row.clinicName} con ese correo`,
        hasAccount: row.org !== null,
      })
    }
  }
  const byName = await tx
    .select({ id: saasClient.id, name: saasClient.name, org: saasClient.organizationId })
    .from(saasClient)
    .where(
      and(
        alive,
        eq(saasClient.product, input.product),
        sql`(search_fold(${saasClient.name}) = search_fold(${input.name})
          or similarity(search_fold(${saasClient.name}), search_fold(${input.name})) >= ${NAME_SIMILARITY})`,
      ),
    )
    .orderBy(sql`similarity(search_fold(${saasClient.name}), search_fold(${input.name})) desc`)
    .limit(5)
  for (const row of byName) {
    add({
      clientId: row.id,
      requestId: null,
      name: row.name,
      why: "nombre",
      words: `Ya hay una clínica llamada ${row.name}`,
      hasAccount: row.org !== null,
    })
  }
  if (input.phone) {
    const byPhone = await tx
      .selectDistinct({ id: saasClient.id, name: saasClient.name, org: saasClient.organizationId })
      .from(saasClientContact)
      .innerJoin(saasClient, eq(saasClient.id, saasClientContact.clientId))
      .where(and(eq(saasClientContact.phone, input.phone), alive))
      .limit(5)
    for (const row of byPhone) {
      add({
        clientId: row.id,
        requestId: null,
        name: row.name,
        why: "telefono",
        words: `${row.name} tiene una persona con ese celular (solo es una pista)`,
        hasAccount: row.org !== null,
      })
    }
  }
  return hints
}

export interface ClientCreated {
  id: string
  /** Lo que se parecía y la persona decidió que era otra (o las pistas por teléfono). */
  duplicates: DuplicateHint[]
}

/**
 * «Nuevo cliente»: la clínica, su persona, cómo llegó y su responsable (por
 * defecto, quien la crea; otro responsable solo lo pone Administración). Con
 * un parecido por correo, solicitud o nombre, y sin `confirmNew`, responde
 * 409 `CLIENT_MAYBE_DUPLICATE`; nunca fusiona sola. Abre su venta.
 */
export async function createClient(
  tx: Db,
  actor: AdminActor,
  raw: ClientCreateInput,
): Promise<ClientCreated> {
  const staff = requireStaff(actor)
  const input = parse(clientCreateSchema, raw, "Revisa los datos del cliente")
  if (!input.contact.phone && !input.contact.email) {
    const message = "Escribe el celular o el correo de la persona"
    throw validation(message, { "contact.phone": message, "contact.email": message })
  }
  const ownerUserId = input.ownerUserId ?? staff.userId
  if (ownerUserId !== staff.userId) {
    if (!isAdmin(staff))
      throw new ServiceError("FORBIDDEN", 403, "Solo Administración asigna el responsable", {
        ownerUserId: "Solo Administración asigna el responsable",
      })
    await assertActiveStaff(tx, ownerUserId, "ownerUserId")
  }
  if (input.referredByClientId) {
    const [ref] = await tx
      .select({ id: saasClient.id })
      .from(saasClient)
      .where(eq(saasClient.id, input.referredByClientId))
      .limit(1)
    if (!ref) throw invalidField("referredByClientId", "Ese cliente ya no existe")
  }
  const email = input.contact.email ?? null
  const phone = input.contact.phone ?? null
  // Dos personas creando la misma clínica a la vez: la segunda ve el parecido.
  if (email)
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`saas-client:${email}`}, 0))`,
    )
  const duplicates = await findClientDuplicates(tx, {
    name: input.name,
    product: input.product,
    email,
    phone,
  })
  const blocking = duplicates.filter((hint) => hint.why !== "telefono")
  if (blocking.length && input.confirmNew !== true) {
    const fields: Record<string, string> = {}
    for (const hint of blocking) {
      if (hint.why === "nombre") fields.name ??= hint.words
      else fields["contact.email"] ??= hint.words
    }
    throw new ClientDuplicateError(
      `${blocking[0]?.words ?? "Puede ser una clínica que ya está"}. ¿Es la misma?`,
      fields,
      duplicates,
    )
  }
  const now = new Date()
  const [client] = await tx
    .insert(saasClient)
    .values({
      name: input.name,
      product: input.product,
      countryCode: input.countryCode ?? "PE",
      city: input.city ?? null,
      origin: input.origin,
      originDetail: input.originDetail ?? null,
      referredByClientId: input.referredByClientId ?? null,
      ownerUserId,
      createdBy: staff.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: saasClient.id })
  if (!client) throw new ServiceError("INTERNAL", 500, "No se pudo guardar el cliente")
  await tx.insert(saasClientContact).values({
    clientId: client.id,
    name: input.contact.name,
    phone,
    email,
    roles: [],
    rolesConfirmed: false,
    isPrimary: true,
    createdAt: now,
    updatedAt: now,
  })
  await openSaleIfNone(tx, client.id, staff.userId)
  await writeAdminAudit(tx, staff, {
    action: "client.created",
    entityId: client.id,
    metadata: {
      origin: input.origin,
      product: input.product,
      confirmedNew: input.confirmNew === true,
      similar: duplicates.length,
    },
  })
  return { id: client.id, duplicates }
}

/* ---------- Enganches: la solicitud y la cuenta ---------- */

/** Lo que trae una solicitud de la web: con ello nace o se completa su cliente. */
export interface WaitlistClientInput {
  email: string
  firstName: string
  lastName: string
  phone: string
  clinicName: string
  countryCode: string
  city: string
  professionals: string
  currentTool: string
  product: ClinicalProduct
}

/** Dónde se encontró el cliente de un correo. */
export type ClientEmailMatch = "contacto" | "solicitud" | "miembro"

/**
 * El cliente de un correo, por coincidencia exacta (nunca por teléfono ni por
 * parecido): primero una persona de contacto, después una solicitud y, si se
 * pide, un miembro de su cuenta. En el primer lugar que tiene a alguien, uno
 * solo; si son varios, no elige (null) y lo decide una persona. Las fichas
 * archivadas no cuentan. La única regla para ligar un correo a un cliente: la
 * usan la solicitud de la web y el correo entrante.
 */
export async function clientByEmail(
  tx: Db,
  email: string,
  options: { members?: boolean; withoutAccount?: boolean } = {},
): Promise<{ clientId: string; matchedBy: ClientEmailMatch } | null> {
  const address = email.trim().toLowerCase()
  if (!address) return null
  const noAccount = options.withoutAccount ? sql`and c.organization_id is null` : sql``
  const levels: Array<{ matchedBy: ClientEmailMatch; query: SQL }> = [
    {
      matchedBy: "contacto",
      query: sql`select distinct c.id from ${saasClientContact} k
        join ${saasClient} c on c.id = k.client_id
        where k.email = ${address} and c.archived_at is null ${noAccount} limit 2`,
    },
    {
      matchedBy: "solicitud",
      query: sql`select distinct c.id from ${saasWaitlistRequest} r
        join ${saasClient} c on c.id = r.client_id
        where lower(r.email) = ${address} and c.archived_at is null ${noAccount} limit 2`,
    },
  ]
  if (options.members)
    levels.push({
      matchedBy: "miembro",
      query: sql`select distinct c.id from ${member} m
        join ${user} u on u.id = m.user_id
        join ${saasClient} c on c.organization_id = m.organization_id
        where lower(u.email) = ${address} and c.archived_at is null limit 2`,
    })
  for (const level of levels) {
    const found = [...(await tx.execute<{ id: string }>(level.query))]
    if (found.length > 1) return null
    if (found[0]) return { clientId: found[0].id, matchedBy: level.matchedBy }
  }
  return null
}

/**
 * El cliente de una solicitud de la web, en la misma transacción que la
 * guarda: el que ya tiene una persona (o una solicitud) con ese correo, si
 * es uno solo; si no, uno nuevo que llegó por la web. Su persona queda como
 * contacto con los papeles por confirmar, y su venta abierta. Lo que el
 * cliente no tenía (ciudad, profesionales, herramienta) se completa; lo que
 * tenía no se pisa.
 */
export async function clientForWaitlistRequest(
  tx: Db,
  input: WaitlistClientInput,
  now = new Date(),
): Promise<string> {
  const email = input.email.trim().toLowerCase()
  const phone = normalizeClientPhone(input.phone)
  const name = `${input.firstName.trim()} ${input.lastName.trim()}`.trim().slice(0, 160)
  // Solo un cliente sin cuenta: quien ya es de una clínica con cuenta y pide otra es otro
  // cliente (Kairós propone fusionarlos si es la misma; `ruleDuplicates`).
  const reused = (await clientByEmail(tx, email, { withoutAccount: true }))?.clientId
  if (reused) {
    await tx
      .update(saasClient)
      .set({
        city: sql`coalesce(${saasClient.city}, ${input.city.trim().slice(0, 120) || null})`,
        professionals: sql`coalesce(${saasClient.professionals}, ${input.professionals})`,
        currentTool: sql`coalesce(${saasClient.currentTool}, ${input.currentTool})`,
        updatedAt: now,
      })
      .where(eq(saasClient.id, reused))
    const [known] = await tx
      .select({ id: saasClientContact.id })
      .from(saasClientContact)
      .where(and(eq(saasClientContact.clientId, reused), eq(saasClientContact.email, email)))
      .limit(1)
    if (!known) {
      const [primary] = await tx
        .select({ id: saasClientContact.id })
        .from(saasClientContact)
        .where(and(eq(saasClientContact.clientId, reused), eq(saasClientContact.isPrimary, true)))
        .limit(1)
      await tx.insert(saasClientContact).values({
        clientId: reused,
        name,
        phone,
        email,
        roles: [],
        rolesConfirmed: false,
        isPrimary: !primary,
        createdAt: now,
        updatedAt: now,
      })
    }
    // Vuelve una que dijo «no por ahora» o se perdió: otra venta; la anterior queda como historia.
    await openSaleIfNone(tx, reused, null)
    return reused
  }
  const professionals = (SAAS_CLIENT_PROFESSIONALS as readonly string[]).includes(
    input.professionals,
  )
    ? input.professionals
    : null
  const currentTool = (SAAS_CLIENT_TOOLS as readonly string[]).includes(input.currentTool)
    ? input.currentTool
    : null
  const [client] = await tx
    .insert(saasClient)
    .values({
      name: input.clinicName.trim().slice(0, 160),
      product: input.product,
      countryCode: input.countryCode.trim().toUpperCase(),
      city: input.city.trim().slice(0, 120) || null,
      professionals,
      currentTool,
      origin: "web",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: saasClient.id })
  if (!client)
    throw new ServiceError("INTERNAL", 500, "No se pudo guardar el cliente de la solicitud")
  await tx.insert(saasClientContact).values({
    clientId: client.id,
    name,
    phone,
    email,
    roles: [],
    rolesConfirmed: false,
    isPrimary: true,
    createdAt: now,
    updatedAt: now,
  })
  await openSaleIfNone(tx, client.id, null)
  return client.id
}

/**
 * El cliente de una cuenta: el que ya la tiene o uno nuevo con su nombre, su
 * producto y su país (para la clínica que abrió su cuenta sola y para la
 * regla «cuenta sin cliente» de Kairós). Una demo nunca es cliente: null.
 * Su venta queda como «entró».
 */
export async function clientForOrganization(
  tx: Db,
  actor: AdminActor | null,
  organizationId: string,
  options: { origin?: SaasClientOrigin; ownerUserId?: string | null; now?: Date } = {},
): Promise<string | null> {
  const now = options.now ?? new Date()
  const [existing] = await tx
    .select({ id: saasClient.id })
    .from(saasClient)
    .where(eq(saasClient.organizationId, organizationId))
    .limit(1)
  if (existing) return existing.id
  if (await isDemoOrganization(tx, organizationId)) return null
  const [org] = await tx
    .select({
      name: organization.name,
      slug: organization.slug,
      product: orgProfile.product,
      country: orgProfile.countryCode,
    })
    .from(organization)
    .leftJoin(orgProfile, eq(orgProfile.organizationId, organization.id))
    .where(eq(organization.id, organizationId))
    .limit(1)
  if (!org) throw notFound("Organización")
  const product: ClinicalProduct =
    org.product && isClinicalProduct(org.product) ? org.product : "dental"
  const [client] = await tx
    .insert(saasClient)
    .values({
      name: (org.name?.trim() || org.slug).slice(0, 160),
      product,
      countryCode: org.country ?? "PE",
      origin: options.origin ?? "otro",
      organizationId,
      ownerUserId: options.ownerUserId ?? null,
      createdBy: actor?.userId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: saasClient.id })
  if (!client) throw new ServiceError("INTERNAL", 500, "No se pudo guardar el cliente de la cuenta")
  await closeClientSaleAsEntered(tx, client.id, actor, now)
  return client.id
}

/**
 * La cuenta nació (con la invitación o con el alta asistida): se liga a su
 * cliente y su venta se cierra como «entró», en la misma transacción. Sin
 * cliente, nace uno con los datos de la cuenta. Si la cuenta ya tenía otro
 * cliente, se queda con ese (no se mueven cuentas entre fichas: eso es
 * fusionar). Un cliente sin responsable queda con quien le dio el alta (el
 * alta asistida; la invitación no tiene persona). Una demo no es cliente: null.
 */
export async function linkClientToOrganization(
  tx: Db,
  actor: AdminActor | null,
  input: {
    clientId?: string | null
    organizationId: string
    origin?: SaasClientOrigin
    now?: Date
  },
): Promise<string | null> {
  const now = input.now ?? new Date()
  if (await isDemoOrganization(tx, input.organizationId)) return null
  const [owner] = await tx
    .select({ id: saasClient.id })
    .from(saasClient)
    .where(eq(saasClient.organizationId, input.organizationId))
    .limit(1)
  if (owner) {
    await closeClientSaleAsEntered(tx, owner.id, actor, now)
    return owner.id
  }
  if (!input.clientId) {
    return clientForOrganization(tx, actor, input.organizationId, {
      origin: input.origin,
      ownerUserId: actor?.userId ?? null,
      now,
    })
  }
  const client = await loadClient(tx, input.clientId, true)
  if (client.organizationId && client.organizationId !== input.organizationId) {
    const message = "Ese cliente ya tiene otra cuenta"
    throw new ServiceError("CLIENT_HAS_ACCOUNT", 409, message, { clientId: message })
  }
  // Sin responsable, lo lleva quien le dio el alta: su alta no queda sin nadie que la siga.
  const ownerUserId = client.ownerUserId ?? actor?.userId ?? null
  await tx
    .update(saasClient)
    .set({
      organizationId: input.organizationId,
      ownerUserId,
      archivedAt: null,
      archivedBy: null,
      updatedAt: now,
    })
    .where(eq(saasClient.id, client.id))
  // Poner el responsable queda dicho como cuando lo cambia una persona (`client.updated`).
  if (ownerUserId !== client.ownerUserId)
    await writeAdminAudit(tx, actor, {
      action: "client.updated",
      organizationId: input.organizationId,
      entityId: client.id,
      metadata: {
        fields: ["ownerUserId"],
        ownerUserId,
        why: "Quien le dio el alta lleva al cliente que no tenía responsable",
      },
    })
  await closeClientSaleAsEntered(tx, client.id, actor, now)
  return client.id
}

/**
 * Antes de un alta asistida con `clientId`: el cliente existe, no tiene
 * cuenta y es del producto que se elige. Devuelve su producto.
 */
export async function clientReadyForAccount(
  tx: Db,
  clientId: string,
  product?: ClinicalProduct,
): Promise<ClinicalProduct> {
  if (!UUID.test(clientId)) throw invalidField("clientId", "Ese cliente no existe")
  const [client] = await tx
    .select()
    .from(saasClient)
    .where(eq(saasClient.id, clientId))
    .limit(1)
    .for("update")
  if (!client) throw invalidField("clientId", "Ese cliente no existe")
  if (client.organizationId) {
    const message = "Ese cliente ya tiene cuenta"
    throw new ServiceError("CLIENT_HAS_ACCOUNT", 409, message, { clientId: message })
  }
  const own = isClinicalProduct(client.product) ? client.product : "dental"
  if (product && product !== own)
    throw invalidField("product", "El producto de la cuenta es el del cliente")
  return own
}

/* ---------- Ficha ---------- */

export interface ClientContactRow {
  /** Null en un miembro de la cuenta que todavía no es contacto (fila de solo lectura). */
  id: string | null
  source: "contacto" | "miembro"
  name: string
  title: string | null
  roles: SaasContactRole[]
  rolesConfirmed: boolean
  phone: string | null
  email: string | null
  preferredChannel: SaasContactChannel | null
  isPrimary: boolean
  /** El usuario ligado (o el miembro), con su rol en la clínica dicho por el servidor. */
  user: {
    userId: string
    name: string
    email: string
    role: string | null
    roleLabel: string | null
  } | null
  readOnly: boolean
}

export interface ClientTaskRow {
  id: string
  kind: SaasTaskKind
  title: string
  dueOn: string
  dueAt: Date | null
  assignee: ClientPerson | null
  contactId: string | null
  demoId: string | null
  byKairos: boolean
  overdue: boolean
}

export interface ClientActivityRow {
  id: string
  kind: SaasActivityKind
  direction: "salio" | "entro" | null
  body: string
  outcome: string | null
  happenedAt: Date
  author: ClientPerson | null
  byKairos: boolean
  contactId: string | null
  adminOnly: boolean
  /**
   * Quien lo escribió, si llegó de fuera: del correo, su nombre o su dirección; del chat, su
   * persona, el nombre que dio el canal o su dirección. Nulo en lo que anotó el equipo.
   */
  from: string | null
  /** El correo que abre: el que llegó o el que respondimos. Solo Administración lo recibe. */
  emailId: string | null
  /** La conversación de WhatsApp, Instagram o Messenger. Solo Administración la recibe. */
  chatId: string | null
}

/** Una frase de «Lo que hay que saber», con su fuente y cómo se dice esa fuente. */
export interface ClientSummarySentence extends SaasClientSummarySource {
  /** «Lo anotado», «Nos escribió por WhatsApp», «Propuesta»…; nulo, una fuente que no se conoce. */
  label: string | null
}

export interface ClientDetail {
  id: string
  name: string
  product: ClinicalProduct
  stage: ClientStage
  /** La fase (ADR 0196): por vender, en alta, activo, no por ahora o perdido. */
  phase: ClientPhase
  /**
   * En alta: cuántos pasos van, de cuántos, y los nombres de los que faltan, en su orden (la misma
   * cuenta de Alta, `computeOnboarding`). Nulo en las demás fases: la pestaña Alta lee lo suyo.
   */
  alta: { done: number; total: number; missing: string[] } | null
  /** Activo: el día de su primer pago que cuenta (confirmado o devuelto); nulo en las demás fases. */
  activeSince: Date | null
  /** Los casos de soporte de su cuenta que no están resueltos (Soporte no cuenta los de cobro). */
  openSupportCases: number
  countryCode: string
  city: string | null
  professionals: string | null
  currentTool: string | null
  origin: SaasClientOrigin
  originDetail: string | null
  referredBy: { id: string; name: string } | null
  owner: ClientPerson | null
  organization: { id: string; slug: string; name: string; planStatus: string | null } | null
  nextStep: ClientNextStep | null
  opportunity: {
    id: string
    seller: { id: string; name: string } | null
    expectedOn: string | null
    createdAt: Date
  } | null
  waitlistRequest: {
    id: string
    status: string
    stage: WaitlistStage
    source: string
    email: string
    createdAt: Date
    invitedAt: Date | null
    inviteExpiresAt: Date | null
    enteredAt: Date | null
  } | null
  summary: { text: string; sources: ClientSummarySentence[]; at: Date | null } | null
  contacts: ClientContactRow[]
  openTasks: ClientTaskRow[]
  recentActivities: ClientActivityRow[]
  signals: ClientSignal[]
  /** Solo con cuenta. */
  riskSignals: ClientSignal[]
  lastContactAt: Date | null
  archivedAt: Date | null
  createdAt: Date
}

/* ---------- Lo que una actividad tiene de conversación ---------- */

/** La fila de afuera de la bitácora, con su nombre completo: drizzle no califica las columnas de una sola tabla. */
const FOLLOW_UP = sql.raw(`"admin"."saas_follow_up"`)

/** Del correo que llegó con esta actividad (el mismo cliente y la misma hora), `column`; si no, null. */
function activityInboundSql(column: SQL): SQL {
  return sql`case when ${FOLLOW_UP}.kind = 'correo' and ${FOLLOW_UP}.direction = 'entro' then
    (select ${column} from ${saasInboundEmail} e where e.client_id = ${FOLLOW_UP}.client_id
      and e.received_at = ${FOLLOW_UP}.happened_at order by e.id limit 1) end`
}

/**
 * Del envío que dejó esta actividad al salir (`outreachWentOut`: el mismo cliente, su canal y la
 * hora en que salió), `column`; si no, null.
 */
function activitySentSql(column: SQL): SQL {
  return sql`case when ${FOLLOW_UP}.direction = 'salio' then
    (select ${column} from ${saasOutreach} o where o.client_id = ${FOLLOW_UP}.client_id
      and o.status = 'enviado' and o.channel = ${FOLLOW_UP}.kind and o.sent_at = ${FOLLOW_UP}.happened_at
      order by o.id limit 1) end`
}

/** Quien escribió por WhatsApp, Instagram o Messenger: su persona, el nombre que dio el canal o su dirección. */
const activityChatFromSql = sql<
  string | null
>`case when ${FOLLOW_UP}.chat_id is not null and ${FOLLOW_UP}.direction = 'entro' then
  (select coalesce(nullif(trim(p.name), ''), nullif(trim(ch.display_name), ''), ch.address)
    from ${saasChat} ch left join ${saasClientContact} p on p.id = coalesce(${FOLLOW_UP}.contact_id, ch.contact_id)
    where ch.id = ${FOLLOW_UP}.chat_id) end`

/**
 * ¿Es parte de una conversación? Lo que entró o salió por un chat, el correo que llegó y lo que
 * salió de un envío. Desde la Bandeja (ADR 0196) es de Administración: Soporte no lo ve, ni en
 * la ficha ni en el historial; lo que anota el equipo a mano sigue a la vista.
 */
const activityIsConversationSql = sql<boolean>`(${FOLLOW_UP}.chat_id is not null
  or ${activityInboundSql(sql`1`)} is not null or ${activitySentSql(sql`1`)} is not null)`

/** Cómo se dice la fuente de una frase de «Lo que hay que saber», por su tipo (`tipo:id`). */
const SUMMARY_SOURCE_WORDS: Record<string, string> = {
  solicitud: "Solicitud",
  contacto: "Persona",
  tarea: "Tarea",
  propuesta: "Propuesta",
  cliente: "Ficha",
  venta: "Venta",
}

const CHAT_KIND_WORDS: Partial<Record<SaasActivityKind, string>> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
}

/** Cómo se dice una actividad como fuente: lo que es y si entró o salió. */
export function activitySourceWords(activity: { kind: string; direction: string | null }): string {
  const chat = CHAT_KIND_WORDS[activity.kind as SaasActivityKind]
  if (activity.kind === "correo" || chat) {
    const by = chat ? ` por ${chat}` : ""
    if (activity.direction === "entro") return `Nos escribió${by}`
    if (activity.direction === "salio") return `Le escribimos${by}`
    return chat ?? "Correo"
  }
  switch (activity.kind) {
    case "llamada":
      return "Llamada"
    case "reunion":
      return "Reunión"
    case "presentacion":
      return "Presentación"
    case "propuesta":
      return "Propuesta"
    default:
      return "Lo anotado"
  }
}

/** Las frases de Kairós con cómo se dice cada fuente; las actividades, por lo que fueron. */
async function summarySentences(
  tx: Db,
  clientId: string,
  sources: SaasClientSummarySource[],
): Promise<ClientSummarySentence[]> {
  const activityIds = [
    ...new Set(
      sources
        .map((sentence) => sentence.source.match(/^actividad:(.+)$/)?.[1] ?? "")
        .filter((activityId) => UUID.test(activityId)),
    ),
  ]
  const activities = activityIds.length
    ? await tx
        .select({ id: saasFollowUp.id, kind: saasFollowUp.kind, direction: saasFollowUp.direction })
        .from(saasFollowUp)
        .where(and(eq(saasFollowUp.clientId, clientId), inArray(saasFollowUp.id, activityIds)))
    : []
  const byId = new Map(activities.map((activity) => [activity.id, activity]))
  return sources.map((sentence) => {
    const [kind, ref] = [sentence.source.split(":")[0] ?? "", sentence.source.split(":")[1] ?? ""]
    if (kind === "actividad") {
      const activity = byId.get(ref)
      // Una actividad que ya no está (se fusionó o se movió) se dice como lo anotado.
      return { ...sentence, label: activity ? activitySourceWords(activity) : "Lo anotado" }
    }
    return { ...sentence, label: SUMMARY_SOURCE_WORDS[kind] ?? null }
  })
}

/** Cuántos casos de soporte de esa cuenta siguen sin resolver; Soporte no cuenta los de cobro. */
async function openSupportCasesOf(tx: Db, staff: AdminActor, orgId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(supportCase)
    .where(
      and(
        eq(supportCase.organizationId, orgId),
        ne(supportCase.status, "resuelto"),
        isAdmin(staff) ? undefined : ne(supportCase.kind, "cobro"),
      ),
    )
  return Number(row?.n ?? 0)
}

/** Desde cuándo está activa: su primer pago que cuenta (`clientPaidSql`: confirmado o devuelto). */
async function activeSinceOf(tx: Db, orgId: string): Promise<Date | null> {
  const [row] = await tx
    .select({
      at: sql<Date | null>`min(${saasPayment.confirmedAt})`.mapWith(saasPayment.confirmedAt),
    })
    .from(saasPayment)
    .where(
      and(
        eq(saasPayment.organizationId, orgId),
        isNotNull(saasPayment.confirmedAt),
        inArray(saasPayment.status, ["confirmado", "devuelto"]),
      ),
    )
  return toDate(row?.at)
}

/**
 * La ficha del cliente: cabecera, fase, datos, personas, tareas abiertas, últimas actividades y
 * señales. En alta trae sus pasos con la misma cuenta de Alta (`computeOnboarding`); `options`
 * es lo de la ruta del alta («Conectar con Facebook» configurado).
 */
export async function getClient(
  tx: Db,
  actor: AdminActor,
  id: string,
  now = new Date(),
  options: OnboardingOptions = { metaSignupAvailable: false },
): Promise<ClientDetail> {
  const staff = requireStaff(actor)
  if (!UUID.test(id)) throw notFound("Cliente")
  const [row] = await tx
    .select({
      client: saasClient,
      ownerName: user.name,
      stage: clientStageSql(now),
      paidAccount: clientPaidSql(),
      lastContactAt: lastContactSql,
    })
    .from(saasClient)
    .leftJoin(user, eq(user.id, saasClient.ownerUserId))
    .where(eq(saasClient.id, id))
    .limit(1)
  if (!row) throw notFound("Cliente")
  const client = row.client
  const stage = row.stage

  const [referred] = client.referredByClientId
    ? await tx
        .select({ id: saasClient.id, name: saasClient.name })
        .from(saasClient)
        .where(eq(saasClient.id, client.referredByClientId))
        .limit(1)
    : []
  const [org] = client.organizationId
    ? await tx
        .select({
          id: organization.id,
          slug: organization.slug,
          name: organization.name,
          planStatus: saasSubscription.status,
        })
        .from(organization)
        .leftJoin(saasSubscription, eq(saasSubscription.organizationId, organization.id))
        .where(eq(organization.id, client.organizationId))
        .limit(1)
    : []
  const [opportunity] = await tx
    .select({
      id: saasOpportunity.id,
      sellerId: saasOpportunity.sellerId,
      sellerName: saasSeller.displayName,
      expectedOn: saasOpportunity.expectedOn,
      createdAt: saasOpportunity.createdAt,
    })
    .from(saasOpportunity)
    .leftJoin(saasSeller, eq(saasSeller.id, saasOpportunity.sellerId))
    .where(and(eq(saasOpportunity.clientId, id), isNull(saasOpportunity.decision)))
    .limit(1)
  const [request] = await tx
    .select()
    .from(saasWaitlistRequest)
    .where(eq(saasWaitlistRequest.clientId, id))
    .orderBy(desc(saasWaitlistRequest.createdAt))
    .limit(1)
  const paid = request?.organizationId
    ? (
        await tx
          .select({ id: saasPayment.id })
          .from(saasPayment)
          .where(
            and(
              eq(saasPayment.organizationId, request.organizationId),
              eq(saasPayment.status, "confirmado"),
            ),
          )
          .limit(1)
      ).length > 0
    : false

  const steps = await nextSteps(tx, staff, [id], now)
  const nextStep = steps.get(id) ?? null
  const lastContactAt = toDate(row.lastContactAt)
  const today = limaDate(now)

  const taskRows = await tx
    .select({ task: saasTask, assigneeName: user.name })
    .from(saasTask)
    .leftJoin(user, eq(user.id, saasTask.assigneeUserId))
    .where(and(eq(saasTask.clientId, id), eq(saasTask.status, "abierta"), visibleTaskSql(staff)))
    .orderBy(asc(saasTask.dueOn), sql`${saasTask.dueAt} asc nulls last`, asc(saasTask.createdAt))
  // Lo último que pasó, con quien lo escribió si llegó de fuera (nunca «Sistema» por lo que
  // escribió una persona). Soporte no recibe lo de las conversaciones (ADR 0196).
  const activityRows = await tx
    .select({
      entry: saasFollowUp,
      authorName: user.name,
      inboundFrom: sql<
        string | null
      >`${activityInboundSql(sql`coalesce(nullif(trim(e.from_name), ''), e.from_address)`)}`,
      chatFrom: activityChatFromSql,
      inboundId: sql<string | null>`${activityInboundSql(sql`e.id::text`)}`,
      repliedId: sql<string | null>`${activitySentSql(sql`o.in_reply_to_email_id::text`)}`,
    })
    .from(saasFollowUp)
    .leftJoin(user, eq(user.id, saasFollowUp.authorUserId))
    .where(
      and(
        eq(saasFollowUp.clientId, id),
        isAdmin(staff)
          ? undefined
          : and(eq(saasFollowUp.adminOnly, false), sql`not ${activityIsConversationSql}`),
      ),
    )
    .orderBy(desc(saasFollowUp.happenedAt), desc(saasFollowUp.createdAt))
    .limit(5)

  const phase = clientPhaseOf({
    stage,
    hasAccount: client.organizationId !== null,
    paid: Boolean(row.paidAccount),
  })
  // En alta, la misma cuenta de la pestaña Alta; en las demás fases no se calcula (la página no
  // la usa y una clínica activa tiene mucho que leer).
  const onboarding =
    phase === "en_alta" && client.organizationId
      ? await computeOnboarding(
          tx,
          { id: client.id, organizationId: client.organizationId },
          now,
          options,
        )
      : null

  return {
    id: client.id,
    name: client.name,
    product: client.product as ClinicalProduct,
    stage,
    phase,
    alta: onboarding
      ? {
          done: onboarding.done,
          total: onboarding.total,
          missing: onboarding.steps.filter((step) => step.state === "falta").map((s) => s.label),
        }
      : null,
    activeSince:
      phase === "activo" && client.organizationId
        ? await activeSinceOf(tx, client.organizationId)
        : null,
    openSupportCases: client.organizationId
      ? await openSupportCasesOf(tx, staff, client.organizationId)
      : 0,
    countryCode: client.countryCode,
    city: client.city,
    professionals: client.professionals,
    currentTool: client.currentTool,
    origin: client.origin as SaasClientOrigin,
    originDetail: client.originDetail,
    referredBy: referred ?? null,
    owner: client.ownerUserId ? { userId: client.ownerUserId, name: row.ownerName ?? "" } : null,
    organization: org
      ? { id: org.id, slug: org.slug, name: org.name, planStatus: org.planStatus ?? null }
      : null,
    nextStep,
    opportunity: opportunity
      ? {
          id: opportunity.id,
          seller: opportunity.sellerId
            ? { id: opportunity.sellerId, name: opportunity.sellerName ?? "" }
            : null,
          expectedOn: opportunity.expectedOn,
          createdAt: opportunity.createdAt,
        }
      : null,
    waitlistRequest: request
      ? {
          id: request.id,
          status: request.status,
          stage: waitlistStage(request, paid, now),
          source: request.source,
          email: request.email,
          createdAt: request.createdAt,
          invitedAt: request.invitedAt,
          inviteExpiresAt: request.inviteExpiresAt,
          enteredAt: request.enteredAt,
        }
      : null,
    summary: client.summary
      ? {
          text: client.summary,
          sources: await summarySentences(tx, client.id, client.summarySources ?? []),
          at: client.summaryAt,
        }
      : null,
    contacts: await listClientContacts(tx, staff, id),
    openTasks: taskRows.map(({ task, assigneeName }) => ({
      id: task.id,
      kind: task.kind as SaasTaskKind,
      title: task.title,
      dueOn: task.dueOn,
      dueAt: task.dueAt,
      assignee: task.assigneeUserId
        ? { userId: task.assigneeUserId, name: assigneeName ?? "" }
        : null,
      contactId: task.contactId,
      demoId: task.demoId,
      byKairos: task.byKairos,
      overdue: taskOverdue(task, now),
    })),
    recentActivities: activityRows.map(
      ({ entry, authorName, inboundFrom, chatFrom, inboundId, repliedId }) => ({
        id: entry.id,
        kind: entry.kind as SaasActivityKind,
        direction: (entry.direction as "salio" | "entro" | null) ?? null,
        body: entry.body,
        outcome: entry.outcome,
        happenedAt: entry.happenedAt,
        author: entry.authorUserId ? { userId: entry.authorUserId, name: authorName ?? "" } : null,
        byKairos: entry.byKairos,
        contactId: entry.contactId,
        adminOnly: entry.adminOnly,
        from: inboundFrom ?? chatFrom ?? null,
        emailId: inboundId ?? repliedId ?? null,
        chatId: entry.chatId,
      }),
    ),
    signals: (await clientSignals(tx, staff, [id], now)).get(id) ?? [],
    riskSignals: client.organizationId
      ? await clientRiskSignals(tx, staff, client.organizationId, now)
      : [],
    lastContactAt,
    archivedAt: client.archivedAt,
    createdAt: client.createdAt,
  }
}

/**
 * Las señales de riesgo de una cuenta, cada una con su «por qué». La regla
 * vive en `kairosRiskRows` (la misma de Hoy y de la pasada de Kairós):
 * comprobante rechazado sin pago confirmado después (solo Administración),
 * nadie entra en 7 días, los mensajes de 30 días caen más de 30 %, un caso
 * espera a la clínica más de 3 días (Soporte no ve los de cobro).
 */
export async function clientRiskSignals(
  tx: Db,
  actor: AdminActor,
  organizationId: string,
  now = new Date(),
): Promise<ClientSignal[]> {
  const staff = requireStaff(actor)
  const rows = await kairosRiskRows(tx, staff, now, { organizationId })
  return rows.flatMap((row) => row.signals.map(asClientSignal))
}

/* ---------- Cambiar, archivar, fusionar ---------- */

export const clientPatchSchema = z.strictObject({
  name: textField(160, "el nombre de la clínica").optional(),
  /** Solo sin cuenta: el producto de una cuenta no cambia. */
  product: z.enum(CLINICAL_PRODUCTS, "Elige el producto").optional(),
  city: optionalText(120).nullable().optional(),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Elige el país")
    .optional(),
  professionals: z.enum(SAAS_CLIENT_PROFESSIONALS, "Elige cuántos atienden").nullable().optional(),
  currentTool: z.enum(SAAS_CLIENT_TOOLS, "Elige qué usan hoy").nullable().optional(),
  origin: z.enum(SAAS_CLIENT_ORIGINS, "Elige cómo llegó").optional(),
  originDetail: optionalText(300).nullable().optional(),
  referredByClientId: z.uuid("Elige quién la refirió").nullable().optional(),
  /** Solo Administración. */
  ownerUserId: z.string().trim().min(1).max(120).nullable().optional(),
})
export type ClientPatch = z.input<typeof clientPatchSchema>

/**
 * Cambia los datos del cliente. El responsable lo cambia solo
 * Administración; el producto, solo mientras no tiene cuenta. La auditoría
 * dice qué campos cambiaron, nunca sus valores.
 */
export async function updateClient(
  tx: Db,
  actor: AdminActor,
  id: string,
  raw: ClientPatch,
): Promise<ClientRow> {
  const staff = requireStaff(actor)
  const patch = parse(clientPatchSchema, raw, "Revisa los datos del cliente")
  const client = await loadClient(tx, id, true)
  if (patch.ownerUserId !== undefined) {
    if (!isAdmin(staff)) {
      throw new ServiceError("FORBIDDEN", 403, "Solo Administración asigna el responsable", {
        ownerUserId: "Solo Administración asigna el responsable",
      })
    }
    if (patch.ownerUserId) await assertActiveStaff(tx, patch.ownerUserId, "ownerUserId")
  }
  if (patch.product && patch.product !== client.product && client.organizationId) {
    throw invalidField("product", "El producto de una clínica con cuenta no cambia")
  }
  if (patch.referredByClientId) {
    if (patch.referredByClientId === id)
      throw invalidField("referredByClientId", "Una clínica no se refiere a sí misma")
    const [ref] = await tx
      .select({ id: saasClient.id })
      .from(saasClient)
      .where(eq(saasClient.id, patch.referredByClientId))
      .limit(1)
    if (!ref) throw invalidField("referredByClientId", "Ese cliente ya no existe")
  }
  const changes = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<typeof saasClient.$inferInsert>
  const changed = Object.keys(changes).filter(
    (key) => (client as Record<string, unknown>)[key] !== (changes as Record<string, unknown>)[key],
  )
  if (!changed.length) return client
  const [updated] = await tx
    .update(saasClient)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(saasClient.id, id))
    .returning()
  if (!updated) throw notFound("Cliente")
  await writeAdminAudit(tx, staff, {
    action: "client.updated",
    organizationId: client.organizationId,
    entityId: id,
    metadata: { fields: changed },
  })
  return updated
}

/** Archiva el cliente (solo Administración): sale de las listas, no se borra. */
export async function archiveClient(
  tx: Db,
  actor: AdminActor,
  id: string,
): Promise<{ id: string; archivedAt: Date }> {
  const staff = requireAdmin(actor)
  const client = await loadClient(tx, id, true)
  if (client.archivedAt) return { id, archivedAt: client.archivedAt }
  const now = new Date()
  await tx
    .update(saasClient)
    .set({ archivedAt: now, archivedBy: staff.userId, updatedAt: now })
    .where(eq(saasClient.id, id))
  await writeAdminAudit(tx, staff, {
    action: "client.archived",
    organizationId: client.organizationId,
    entityId: id,
  })
  return { id, archivedAt: now }
}

export interface ClientMerged {
  id: string
  moved: Record<string, number>
}

/**
 * Une dos fichas de la misma clínica (solo Administración; Kairós solo lo
 * propone): todo lo de `dropId` pasa a `keepId` (personas, actividades,
 * tareas, ventas, propuestas, envíos, archivos, solicitudes, correos, lo de
 * Kairós) y `dropId` se borra. Si las dos tienen cuenta no se fusionan. Lo
 * que la que se queda no tenía (ciudad, profesionales, responsable…) se
 * completa con lo de la otra.
 */
export async function mergeClients(
  tx: Db,
  actor: AdminActor,
  keepId: string,
  dropId: string,
): Promise<ClientMerged> {
  const staff = requireAdmin(actor)
  if (keepId === dropId) throw invalidField("dropId", "Elige otro cliente para fusionar")
  if (!UUID.test(keepId)) throw notFound("Cliente")
  if (!UUID.test(dropId)) throw invalidField("dropId", "Ese cliente no existe")
  const locked = await tx
    .select()
    .from(saasClient)
    .where(inArray(saasClient.id, [keepId, dropId]))
    .orderBy(asc(saasClient.id))
    .for("update")
  const keep = locked.find((row) => row.id === keepId)
  const drop = locked.find((row) => row.id === dropId)
  if (!keep) throw notFound("Cliente")
  if (!drop) throw invalidField("dropId", "Ese cliente no existe")
  if (keep.organizationId && drop.organizationId) {
    const message = "Las dos tienen cuenta: no se fusionan"
    throw new ServiceError("CLIENT_MERGE_TWO_ACCOUNTS", 409, message, { dropId: message })
  }
  if (keep.product !== drop.product) {
    throw invalidField(
      "dropId",
      "Son de productos distintos: corrige el producto antes de fusionar",
    )
  }
  const now = new Date()
  const moved: Record<string, number> = {}
  const count = (key: string, rows: unknown[]) => {
    if (rows.length) moved[key] = rows.length
  }

  // La cuenta pasa a la que se queda (una cuenta, un cliente).
  if (drop.organizationId) {
    await tx.update(saasClient).set({ organizationId: null }).where(eq(saasClient.id, dropId))
    await tx
      .update(saasClient)
      .set({ organizationId: drop.organizationId })
      .where(eq(saasClient.id, keepId))
  }

  // Personas: un principal por cliente y una persona por usuario.
  const [keepPrimary] = await tx
    .select({ id: saasClientContact.id })
    .from(saasClientContact)
    .where(and(eq(saasClientContact.clientId, keepId), eq(saasClientContact.isPrimary, true)))
    .limit(1)
  if (keepPrimary) {
    await tx
      .update(saasClientContact)
      .set({ isPrimary: false })
      .where(eq(saasClientContact.clientId, dropId))
  }
  await tx.execute(sql`update ${saasClientContact} k set user_id = null
    where k.client_id = ${dropId} and k.user_id is not null
      and exists (select 1 from ${saasClientContact} x where x.client_id = ${keepId} and x.user_id = k.user_id)`)
  count(
    "contacts",
    await tx
      .update(saasClientContact)
      .set({ clientId: keepId, updatedAt: now })
      .where(eq(saasClientContact.clientId, dropId))
      .returning({ id: saasClientContact.id }),
  )

  // La bitácora solo deja cambiar su cliente a otro (nunca a nulo).
  count(
    "activities",
    await tx
      .update(saasFollowUp)
      .set({ clientId: keepId })
      .where(eq(saasFollowUp.clientId, dropId))
      .returning({ id: saasFollowUp.id }),
  )
  count(
    "tasks",
    await tx
      .update(saasTask)
      .set({ clientId: keepId, updatedAt: now })
      .where(eq(saasTask.clientId, dropId))
      .returning({ id: saasTask.id }),
  )

  // Una venta abierta por cliente: si las dos tienen, queda la de la que se queda con lo que le faltaba.
  const opens = await tx
    .select()
    .from(saasOpportunity)
    .where(
      and(inArray(saasOpportunity.clientId, [keepId, dropId]), isNull(saasOpportunity.decision)),
    )
  const keepOpen = opens.find((o) => o.clientId === keepId)
  const dropOpen = opens.find((o) => o.clientId === dropId)
  if (keepOpen && dropOpen) {
    await tx
      .update(saasOpportunity)
      .set({
        sellerId: keepOpen.sellerId ?? dropOpen.sellerId,
        expectedOn: keepOpen.expectedOn ?? dropOpen.expectedOn,
        createdAt:
          keepOpen.createdAt < dropOpen.createdAt ? keepOpen.createdAt : dropOpen.createdAt,
        updatedAt: now,
      })
      .where(eq(saasOpportunity.id, keepOpen.id))
    await tx
      .update(saasProposal)
      .set({ opportunityId: keepOpen.id })
      .where(eq(saasProposal.opportunityId, dropOpen.id))
    await tx.delete(saasOpportunity).where(eq(saasOpportunity.id, dropOpen.id))
  }
  count(
    "opportunities",
    await tx
      .update(saasOpportunity)
      .set({ clientId: keepId, updatedAt: now })
      .where(eq(saasOpportunity.clientId, dropId))
      .returning({ id: saasOpportunity.id }),
  )

  // Las propuestas de las dos quedan numeradas por fecha (la que salió antes, versión menor):
  // «reemplazada» compara versiones, así que la vigente de la que se queda no pasa a reemplazada
  // por una más vieja de la otra. Primero fuera del rango, para no chocar con el índice único.
  await tx
    .update(saasProposal)
    .set({ version: sql`${saasProposal.version} + 1000000` })
    .where(eq(saasProposal.clientId, keepId))
  count(
    "proposals",
    await tx
      .update(saasProposal)
      .set({ clientId: keepId, version: sql`${saasProposal.version} + 2000000` })
      .where(eq(saasProposal.clientId, dropId))
      .returning({ id: saasProposal.id }),
  )
  await tx.execute(sql`update ${saasProposal} p set version = ordered.n
    from (select id, row_number() over (order by coalesce(sent_at, created_at), created_at, id)::int as n
      from ${saasProposal} where client_id = ${keepId}) ordered
    where p.id = ordered.id`)
  count(
    "outreach",
    await tx
      .update(saasOutreach)
      .set({ clientId: keepId })
      .where(eq(saasOutreach.clientId, dropId))
      .returning({ id: saasOutreach.id }),
  )
  count(
    "files",
    await tx
      .update(saasClientFile)
      .set({ clientId: keepId })
      .where(eq(saasClientFile.clientId, dropId))
      .returning({ id: saasClientFile.id }),
  )
  // Las conversaciones de WhatsApp siguen a su cliente (sus contactos ya pasaron).
  count(
    "chats",
    await tx
      .update(saasChat)
      .set({ clientId: keepId, updatedAt: now })
      .where(eq(saasChat.clientId, dropId))
      .returning({ id: saasChat.id }),
  )
  count(
    "inboundEmails",
    await tx
      .update(saasInboundEmail)
      .set({ clientId: keepId })
      .where(eq(saasInboundEmail.clientId, dropId))
      .returning({ id: saasInboundEmail.id }),
  )
  count(
    "kairosItems",
    await tx
      .update(kairosItem)
      .set({ clientId: keepId })
      .where(eq(kairosItem.clientId, dropId))
      .returning({ id: kairosItem.id }),
  )
  await tx.update(kairosAiUsage).set({ clientId: keepId }).where(eq(kairosAiUsage.clientId, dropId))
  count(
    "requests",
    await tx
      .update(saasWaitlistRequest)
      .set({ clientId: keepId })
      .where(eq(saasWaitlistRequest.clientId, dropId))
      .returning({ id: saasWaitlistRequest.id }),
  )
  await tx
    .update(saasClient)
    .set({ referredByClientId: keepId })
    .where(and(eq(saasClient.referredByClientId, dropId), ne(saasClient.id, keepId)))

  await tx
    .update(saasClient)
    .set({
      city: keep.city ?? drop.city,
      professionals: keep.professionals ?? drop.professionals,
      currentTool: keep.currentTool ?? drop.currentTool,
      originDetail: keep.originDetail ?? drop.originDetail,
      ownerUserId: keep.ownerUserId ?? drop.ownerUserId,
      referredByClientId:
        keep.referredByClientId && keep.referredByClientId !== dropId
          ? keep.referredByClientId
          : drop.referredByClientId && drop.referredByClientId !== keepId
            ? drop.referredByClientId
            : null,
      createdAt: keep.createdAt < drop.createdAt ? keep.createdAt : drop.createdAt,
      updatedAt: now,
    })
    .where(eq(saasClient.id, keepId))
  // Los pasos del alta guardados son de la cuenta: pasan con ella al que se queda (el absorbido
  // los pierde por la cascada). Solo uno de los dos tiene cuenta, así que el que se queda no
  // tiene hitos propios; si tuviera, gana el suyo (ON CONFLICT DO NOTHING).
  if (drop.organizationId) {
    const copied = await tx.execute(sql`insert into ${saasClientMilestone}
        (client_id, step, reached_at, source, lost_at, lost_reason, na_reason, na_by, na_at, created_at, updated_at)
      select ${keepId}, step, reached_at, source, lost_at, lost_reason, na_reason, na_by, na_at, created_at, ${now.toISOString()}::timestamptz
      from ${saasClientMilestone} where client_id = ${dropId}
      on conflict do nothing
      returning step`)
    count("milestones", copied as unknown as unknown[])
  }
  await tx.delete(saasClient).where(eq(saasClient.id, dropId))
  await writeAdminAudit(tx, staff, {
    action: "client.merged",
    organizationId: keep.organizationId ?? drop.organizationId,
    entityId: keepId,
    metadata: { dropId, moved },
  })
  return { id: keepId, moved }
}

/* ---------- Personas ---------- */

export const contactInputSchema = z.strictObject({
  name: textField(160, "el nombre de la persona"),
  title: optionalText(120).nullable().optional(),
  roles: rolesSchema.optional(),
  phone: phoneSchema.nullable().optional(),
  email: emailSchema.nullable().optional(),
  preferredChannel: z
    .enum(SAAS_CONTACT_CHANNELS, "Elige cómo prefiere que le escriban")
    .nullable()
    .optional(),
  isPrimary: z.boolean().optional(),
})
export type ContactInput = z.input<typeof contactInputSchema>

export const contactPatchSchema = contactInputSchema.partial().omit({ isPrimary: true })
export type ContactPatch = z.input<typeof contactPatchSchema>

export type ClientContact = typeof saasClientContact.$inferSelect

async function loadContact(tx: Db, contactId: string): Promise<ClientContact> {
  if (!UUID.test(contactId)) throw notFound("Contacto")
  const [row] = await tx
    .select()
    .from(saasClientContact)
    .where(eq(saasClientContact.id, contactId))
    .limit(1)
    .for("update")
  if (!row) throw notFound("Contacto")
  return row
}

/** Agrega una persona al cliente. La primera es la principal. */
export async function addClientContact(
  tx: Db,
  actor: AdminActor,
  clientId: string,
  raw: ContactInput,
): Promise<ClientContact> {
  const staff = requireStaff(actor)
  const input = parse(contactInputSchema, raw, "Revisa los datos de la persona")
  const client = await loadClient(tx, clientId, true)
  const [primary] = await tx
    .select({ id: saasClientContact.id })
    .from(saasClientContact)
    .where(and(eq(saasClientContact.clientId, clientId), eq(saasClientContact.isPrimary, true)))
    .limit(1)
  const isPrimary = input.isPrimary === true || !primary
  const now = new Date()
  if (isPrimary && primary) {
    await tx
      .update(saasClientContact)
      .set({ isPrimary: false, updatedAt: now })
      .where(eq(saasClientContact.id, primary.id))
  }
  const [row] = await tx
    .insert(saasClientContact)
    .values({
      clientId,
      name: input.name,
      title: input.title ?? null,
      roles: input.roles ?? [],
      rolesConfirmed: true,
      phone: input.phone ?? null,
      email: input.email ?? null,
      preferredChannel: input.preferredChannel ?? null,
      isPrimary,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new ServiceError("INTERNAL", 500, "No se pudo guardar la persona")
  await writeAdminAudit(tx, staff, {
    action: "client.contact_added",
    organizationId: client.organizationId,
    entityId: clientId,
    metadata: { contactId: row.id },
  })
  return row
}

/**
 * Cambia los datos de una persona. Decir sus papeles los confirma. El correo
 * de una persona ligada a su usuario es el de su cuenta: no se cambia aquí.
 */
export async function updateClientContact(
  tx: Db,
  actor: AdminActor,
  contactId: string,
  raw: ContactPatch,
): Promise<ClientContact> {
  const staff = requireStaff(actor)
  const patch = parse(contactPatchSchema, raw, "Revisa los datos de la persona")
  const contact = await loadContact(tx, contactId)
  if (patch.email !== undefined && contact.userId && patch.email !== contact.email) {
    throw invalidField("email", "Está ligada a su usuario: su correo es el de su cuenta")
  }
  const changes = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<typeof saasClientContact.$inferInsert>
  if (patch.roles !== undefined) changes.rolesConfirmed = true
  if (!Object.keys(changes).length) return contact
  const [row] = await tx
    .update(saasClientContact)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(saasClientContact.id, contactId))
    .returning()
  if (!row) throw notFound("Contacto")
  await writeAdminAudit(tx, staff, {
    action: "client.contact_updated",
    entityId: contact.clientId,
    metadata: { contactId, fields: Object.keys(changes) },
  })
  return row
}

/** La persona principal del cliente (una por cliente). */
export async function setPrimaryClientContact(
  tx: Db,
  actor: AdminActor,
  contactId: string,
): Promise<ClientContact> {
  const staff = requireStaff(actor)
  const contact = await loadContact(tx, contactId)
  if (contact.isPrimary) return contact
  const now = new Date()
  await tx
    .update(saasClientContact)
    .set({ isPrimary: false, updatedAt: now })
    .where(
      and(eq(saasClientContact.clientId, contact.clientId), eq(saasClientContact.isPrimary, true)),
    )
  const [row] = await tx
    .update(saasClientContact)
    .set({ isPrimary: true, updatedAt: now })
    .where(eq(saasClientContact.id, contactId))
    .returning()
  if (!row) throw notFound("Contacto")
  await writeAdminAudit(tx, staff, {
    action: "client.contact_primary",
    entityId: contact.clientId,
    metadata: { contactId },
  })
  return row
}

/**
 * Liga una persona a su usuario (solo Administración): solo si su correo es
 * exactamente el del usuario y el usuario es miembro de la cuenta del
 * cliente. Nunca por teléfono ni por un nombre parecido.
 */
export async function linkContactToUser(
  tx: Db,
  actor: AdminActor,
  contactId: string,
  userId: string,
): Promise<ClientContact> {
  const staff = requireAdmin(actor)
  const contact = await loadContact(tx, contactId)
  const client = await loadClient(tx, contact.clientId)
  if (!client.organizationId)
    throw invalidField("userId", "El cliente todavía no tiene cuenta: no hay a quién ligarla")
  const [target] = await tx
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  if (!target) throw invalidField("userId", "Ese usuario no existe")
  if (!contact.email || contact.email !== target.email.trim().toLowerCase()) {
    throw invalidField(
      "userId",
      "Solo se liga si el correo de la persona es exactamente el de su usuario",
    )
  }
  const [membership] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, client.organizationId), eq(member.userId, userId)))
    .limit(1)
  if (!membership) throw invalidField("userId", "Ese usuario no es parte del equipo de la clínica")
  if (contact.userId === userId) return contact
  const [row] = await tx
    .update(saasClientContact)
    .set({ userId, updatedAt: new Date() })
    .where(eq(saasClientContact.id, contactId))
    .returning()
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error
      const message = "Ese usuario ya está ligado a otra persona de este cliente"
      throw new ServiceError("CONFLICT", 409, message, { userId: message })
    })
  if (!row) throw notFound("Contacto")
  await writeAdminAudit(tx, staff, {
    action: "client.contact_linked",
    organizationId: client.organizationId,
    entityId: client.id,
    metadata: { contactId, userId },
  })
  return row
}

function isOrgRole(role: string): role is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(role)
}

/**
 * Las personas del cliente y, si tiene cuenta, los miembros de su equipo que
 * todavía no son una persona ligada, como filas de solo lectura (se leen, no
 * se copian). La principal primero.
 */
export async function listClientContacts(
  tx: Db,
  actor: AdminActor,
  clientId: string,
): Promise<ClientContactRow[]> {
  requireStaff(actor)
  const client = await loadClient(tx, clientId)
  const product: ClinicalProduct = isClinicalProduct(client.product) ? client.product : "dental"
  const contacts = await tx
    .select({ contact: saasClientContact, userName: user.name, userEmail: user.email })
    .from(saasClientContact)
    .leftJoin(user, eq(user.id, saasClientContact.userId))
    .where(eq(saasClientContact.clientId, clientId))
    .orderBy(
      desc(saasClientContact.isPrimary),
      asc(saasClientContact.createdAt),
      asc(saasClientContact.id),
    )
  const members = client.organizationId
    ? await tx
        .select({ userId: user.id, name: user.name, email: user.email, role: member.role })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(eq(member.organizationId, client.organizationId))
        .orderBy(asc(member.createdAt))
    : []
  const roleOf = new Map(members.map((m) => [m.userId, m.role]))
  const label = (role: string | undefined) =>
    role && isOrgRole(role) ? roleLabel(role, product) : null
  const rows: ClientContactRow[] = contacts.map(({ contact, userName, userEmail }) => ({
    id: contact.id,
    source: "contacto",
    name: contact.name,
    title: contact.title,
    roles: contact.roles as SaasContactRole[],
    rolesConfirmed: contact.rolesConfirmed,
    phone: contact.phone,
    email: contact.email,
    preferredChannel: (contact.preferredChannel as SaasContactChannel | null) ?? null,
    isPrimary: contact.isPrimary,
    user:
      contact.userId && userEmail
        ? {
            userId: contact.userId,
            name: userName ?? "",
            email: userEmail,
            role: roleOf.get(contact.userId) ?? null,
            roleLabel: label(roleOf.get(contact.userId)),
          }
        : null,
    readOnly: false,
  }))
  const linked = new Set(contacts.map(({ contact }) => contact.userId).filter(Boolean))
  for (const m of members) {
    if (linked.has(m.userId)) continue
    rows.push({
      id: null,
      source: "miembro",
      name: m.name,
      title: null,
      roles: [],
      rolesConfirmed: false,
      phone: null,
      email: m.email,
      preferredChannel: null,
      isPrimary: false,
      user: {
        userId: m.userId,
        name: m.name,
        email: m.email,
        role: m.role,
        roleLabel: label(m.role),
      },
      readOnly: true,
    })
  }
  return rows
}

/* ---------- Historial ---------- */

/**
 * Los filtros del historial (ADR 0196): por lo que pasó, no por la tabla de donde sale.
 * «Plan y pagos» es de Administración en la pantalla, como su pestaña; a Soporte el servidor le
 * da igual solo lo que puede ver.
 */
export const TIMELINE_FILTERS = [
  "todo",
  "conversaciones",
  "venta",
  "alta",
  "plan",
  "soporte",
] as const
export type TimelineFilter = (typeof TIMELINE_FILTERS)[number]
export type TimelineCategory = Exclude<TimelineFilter, "todo">
/**
 * Lo que se acepta al pedirlo: los filtros y los nombres de antes, que llegan en enlaces
 * guardados. «contactos» es Conversaciones y «cuenta» (Cuenta y pagos) es Alta más Plan y pagos.
 */
export const TIMELINE_FILTER_INPUTS = [...TIMELINE_FILTERS, "contactos", "cuenta"] as const
export type TimelineFilterInput = (typeof TIMELINE_FILTER_INPUTS)[number]

/** Lo que dice el ícono de cada fila: el canal o lo que es. */
export type TimelineIcon =
  | "llamada"
  | "whatsapp"
  | "instagram"
  | "messenger"
  | "correo"
  | "reunion"
  | "nota"
  | "presentacion"
  | "propuesta"
  | "solicitud"
  | "venta"
  | "tarea"
  | "archivo"
  | "persona"
  | "alta"
  | "informe"
  | "carga"
  | "pago"
  | "plan"
  | "soporte"
  | "kairos"

/** La pestaña de la ficha a la que lleva una fila sin un cajón propio. */
export type TimelineTab =
  | "resumen"
  | "venta"
  | "alta"
  | "pagos"
  | "soporte"
  | "contactos"
  | "documentos"

/** Lo que abre cada fila: toda fila abre algo. */
export type TimelineLink =
  | {
      kind:
        | "solicitud"
        | "propuesta"
        | "envio"
        | "soporte"
        | "archivo"
        | "tarea"
        | "correo"
        | "chat"
        | "actividad"
      id: string
    }
  | { kind: "pestana"; id: TimelineTab }
  | { kind: "informe"; id: string; orgId: string; number: number }
  | { kind: "carga"; id: string; orgId: string; loadId: string }

export interface TimelineEntry {
  /** Fuente e id: único en la línea de tiempo. */
  id: string
  at: Date
  who: { kind: "persona" | "kairos" | "sistema" | "clinica"; name: string }
  category: TimelineCategory
  icon: TimelineIcon
  title: string
  detail?: string
  adminOnly: boolean
  link: TimelineLink
  /** Una actividad: su texto entero y en qué quedó, para leerla en su cajón. */
  body?: string
  outcome?: string
  /** Un envío que no es de una conversación: por dónde, a quién, qué decía y cómo quedó. */
  envio?: {
    channel: SaasOutreachChannel
    to: string
    subject: string | null
    body: string
    status: string
  }
}

export interface ClientTimeline {
  items: TimelineEntry[]
  /** Para «Cargar más»: lo anterior a este instante. Null si no hay más. */
  nextBefore: Date | null
}

/** El número de un informe de la carga en la auditoría (`informe-<n>`), o null. */
const reportNumberOf = (entityId: string | null): number | null => {
  const number = Number(entityId?.match(/^informe-(\d+)$/)?.[1])
  return Number.isInteger(number) && number > 0 ? number : null
}
const reportNumberWords = (entityId: string | null) => {
  const number = reportNumberOf(entityId)
  return number ? ` N.º ${number}` : ""
}

type AuditRow = {
  entityId: string | null
  organizationId: string | null
  metadata: Record<string, unknown> | null
}

const tab = (id: TimelineTab): TimelineLink => ({ kind: "pestana", id })

/** Un informe abre su cajón (quién, cuándo, a quién y su PDF); sin número ni cuenta, el Alta. */
const reportLink = (audit: AuditRow): TimelineLink => {
  const number = reportNumberOf(audit.entityId)
  return number && audit.organizationId
    ? { kind: "informe", id: String(number), orgId: audit.organizationId, number }
    : tab("alta")
}

/**
 * Una frase por código de la auditoría de la administración (de la cuenta o del cliente), con
 * su categoría, su ícono y lo que abre. Lo que no está aquí no se muestra: nunca el código. Los
 * cambios del plan salen de `listSaasPlanChanges` (de las dos auditorías), lo de pagos de
 * `saas_payment` y lo de la solicitud y la bitácora de sus tablas, para no contarlo dos veces.
 * Las cargas de la skill (`org.setup_import` y `org.data_import`, una fila por tanda) salen
 * agrupadas de `listClinicLoads`, con sus cifras; `org.progress_report_sending` es el paso de en
 * medio de cada envío y no se dice: lo dice cómo terminó (y Alta, si quedó a medias).
 */
export const TIMELINE_AUDIT_PHRASES: Record<
  string,
  {
    title: string
    category: TimelineCategory
    icon: TimelineIcon
    adminOnly?: boolean
    /** La frase con lo de esa fila (el número del informe), si lo hay. */
    titleOf?: (audit: AuditRow) => string
    link: (audit: AuditRow) => TimelineLink
  }
> = {
  "org.assisted_create_invited": {
    title: "Se creó su cuenta con el alta asistida y se invitó a la propietaria",
    category: "alta",
    icon: "alta",
    link: () => tab("alta"),
  },
  "org.invitation_resend": {
    title: "Se reenvió una invitación a su equipo",
    category: "alta",
    icon: "alta",
    link: () => tab("alta"),
  },
  "org.invitation_cancel": {
    title: "Se anuló una invitación a su equipo",
    category: "alta",
    icon: "alta",
    link: () => tab("alta"),
  },
  "org.progress_report_sent": {
    title: "Salió el informe de la carga",
    category: "alta",
    icon: "informe",
    adminOnly: true,
    titleOf: ({ entityId, metadata }) =>
      metadata?.registered === true
        ? `Se registró el informe${reportNumberWords(entityId)}, que salió por correo aparte`
        : `Salió el informe${reportNumberWords(entityId)}${metadata?.resent === true ? ", reenviado" : ""}`,
    link: reportLink,
  },
  "org.progress_report_unknown": {
    title: "No se sabe si salió el informe de la carga",
    category: "alta",
    icon: "informe",
    adminOnly: true,
    titleOf: ({ entityId }) => `No se sabe si salió el informe${reportNumberWords(entityId)}`,
    link: reportLink,
  },
  "saas.charge_created": {
    title: "Se le generó un cobro",
    category: "plan",
    icon: "pago",
    adminOnly: true,
    link: () => tab("pagos"),
  },
  "recovery.case_open": {
    title: "Se abrió una recuperación de la propiedad de la cuenta",
    category: "soporte",
    icon: "soporte",
    link: () => tab("soporte"),
  },
  "recovery.case_decide": {
    title: "Se decidió la recuperación de la propiedad de la cuenta",
    category: "soporte",
    icon: "soporte",
    link: () => tab("soporte"),
  },
  "recovery.case_execute": {
    title: "Se completó la recuperación de la propiedad de la cuenta",
    category: "soporte",
    icon: "soporte",
    link: () => tab("soporte"),
  },
  "client.updated": {
    title: "Se actualizaron sus datos",
    category: "venta",
    icon: "venta",
    link: () => tab("resumen"),
  },
  "client.archived": {
    title: "Se archivó el cliente",
    category: "venta",
    icon: "venta",
    link: () => tab("resumen"),
  },
  "client.merged": {
    title: "Se unió con otra ficha de la misma clínica",
    category: "venta",
    icon: "venta",
    link: () => tab("resumen"),
  },
  "client.contact_added": {
    title: "Se agregó una persona",
    category: "conversaciones",
    icon: "persona",
    link: () => tab("contactos"),
  },
  "client.contact_linked": {
    title: "Se ligó una persona a su usuario",
    category: "conversaciones",
    icon: "persona",
    link: () => tab("contactos"),
  },
  "kairos.client_created": {
    title: "Kairós creó el cliente al ver su cuenta",
    category: "alta",
    icon: "kairos",
    link: () => tab("alta"),
  },
  "kairos.client_linked": {
    title: "Kairós ligó su cuenta a esta ficha",
    category: "alta",
    icon: "kairos",
    link: () => tab("alta"),
  },
  "arm.proposal_applied": {
    title: "Se pusieron en su plan las condiciones de la propuesta aceptada",
    category: "venta",
    icon: "propuesta",
    adminOnly: true,
    link: () => tab("pagos"),
  },
  "arm.proposal_not_applied": {
    title:
      "Las condiciones de la propuesta aceptada no se pusieron solas: hay que ponerlas en Plan y pagos",
    category: "venta",
    icon: "propuesta",
    adminOnly: true,
    link: () => tab("pagos"),
  },
}

const ACTIVITY_TITLES: Record<SaasActivityKind, { salio: string; entro: string; nota: string }> = {
  llamada: { salio: "La llamamos", entro: "Nos llamó", nota: "Llamada" },
  whatsapp: {
    salio: "Le escribimos por WhatsApp",
    entro: "Nos escribió por WhatsApp",
    nota: "WhatsApp",
  },
  correo: { salio: "Le escribimos un correo", entro: "Nos escribió un correo", nota: "Correo" },
  reunion: { salio: "Reunión", entro: "Reunión", nota: "Reunión" },
  presentacion: { salio: "Presentación", entro: "Presentación", nota: "Presentación" },
  propuesta: {
    salio: "Le enviamos una propuesta",
    entro: "Respondió la propuesta",
    nota: "Propuesta",
  },
  nota: { salio: "Nota", entro: "Nota", nota: "Nota" },
  instagram: {
    salio: "Le escribimos por Instagram",
    entro: "Nos escribió por Instagram",
    nota: "Instagram",
  },
  messenger: {
    salio: "Le escribimos por Messenger",
    entro: "Nos escribió por Messenger",
    nota: "Messenger",
  },
}

const OUTREACH_CHANNEL_WORDS: Record<SaasOutreachChannel, string> = {
  correo: "correo",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
}

/** La categoría de una tarea por su tipo: la venta, el alta, el cobro o la conversación. */
const taskCategory = (kind: string): TimelineCategory =>
  kind === "presentacion" || kind === "propuesta"
    ? "venta"
    : kind === "alta"
      ? "alta"
      : kind === "cobro"
        ? "plan"
        : "conversaciones"

const FILE_TITLES: Record<string, string> = {
  carta: "Carta de bienvenida",
  propuesta: "Propuesta",
  presentacion: "Presentación",
  archivo_clinica: "Archivo de la clínica",
  correo: "Adjunto de un correo",
  otro: "Documento",
}

/** Lo que llegó en una conversación, por su canal. */
const CHAT_FILE_TITLES: Record<SaasChatChannel, string> = {
  whatsapp: "Llegó por WhatsApp",
  instagram: "Llegó por Instagram",
  messenger: "Llegó por Messenger",
}

/** El título de un documento en el historial: lo que llegó en una conversación dice por dónde. */
function fileTitle(file: { kind: string; source: string | null }): string {
  const chat = CHAT_FILE_TITLES[file.source as SaasChatChannel]
  if (chat && file.kind === "correo") return chat
  return FILE_TITLES[file.kind] ?? "Documento"
}

/**
 * La categoría de un documento: lo que llegó en una conversación, Conversaciones; la carta y lo
 * de la carga, Alta; lo demás (propuestas, presentaciones y otros), Venta.
 */
function fileCategory(file: { kind: string; source: string | null }): TimelineCategory {
  if (file.kind === "correo") return "conversaciones"
  if (file.kind === "carta" || file.kind === "archivo_clinica") return "alta"
  return "venta"
}

/** Una tarea que Kairós cerró sola dentro de este tiempo después de un hecho se dice en él. */
const KAIROS_FOLD_MS = 15 * 60_000
const KAIROS_CLOSED = "Kairós la cerró"

const day = (date: Date) =>
  new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date)
const civilDay = (iso: string) => day(new Date(`${iso}T12:00:00Z`))
const clip = (text: string | null | undefined, max = 280) => {
  if (!text) return undefined
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

const timelineSchema = z.strictObject({
  filter: z
    .enum(TIMELINE_FILTER_INPUTS, "Elige qué ver")
    .transform((value) => (value === "contactos" ? "conversaciones" : value))
    .optional(),
  before: z.date().optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

/**
 * La tarea que Kairós cerró sola poco después de un hecho de su misma categoría no es una fila
 * aparte: el hecho la dice («Salió el informe N.º 3 · cerró la tarea «Enviar el informe»»).
 * Solo dentro de la misma página: si el hecho quedó en la siguiente, la tarea sigue en su fila.
 */
function foldKairosClosings(page: TimelineEntry[], closed: Map<string, string>): TimelineEntry[] {
  if (!closed.size) return page
  const out = page.map((entry) => ({ ...entry }))
  const folded = new Set<string>()
  for (const task of out) {
    const title = closed.get(task.id)
    if (!title) continue
    let best: TimelineEntry | null = null
    for (const fact of out) {
      if (fact === task || fact.link.kind === "tarea" || fact.category !== task.category) continue
      const gap = task.at.getTime() - fact.at.getTime()
      if (gap < 0 || gap > KAIROS_FOLD_MS) continue
      if (!best || fact.at.getTime() > best.at.getTime()) best = fact
    }
    if (!best) continue
    best.title = `${best.title} · cerró la tarea «${title}»`
    folded.add(task.id)
  }
  return out.filter((entry) => !folded.has(entry.id))
}

/**
 * El historial del cliente, en palabras, armado al leer desde sus fuentes
 * (nada se copia dos veces): la solicitud (recibida, confirmación, invitada,
 * venció, entró, descartada), la bitácora, las tareas hechas, las decisiones
 * de venta, las propuestas, los envíos sin confirmar (los que salieron ya
 * dejaron su actividad), la auditoría de la cuenta y del cliente (una frase
 * por código), los cambios del plan, los pagos, los casos de soporte, los
 * correos que llegaron (sin la actividad que los registró) y los archivos.
 * Cada fila dice su categoría (Conversaciones, Venta, Alta, Plan y pagos o
 * Soporte) y lo que abre. Soporte no ve lo «solo administración», importes,
 * casos de cobro ni lo de las conversaciones (ADR 0196).
 */
export async function clientTimeline(
  tx: Db,
  actor: AdminActor,
  clientId: string,
  raw: { filter?: TimelineFilterInput; before?: Date; limit?: number } = {},
  now = new Date(),
): Promise<ClientTimeline> {
  const staff = requireStaff(actor)
  const options = parse(timelineSchema, raw, "Revisa el historial que pides")
  const filter = options.filter ?? "todo"
  const limit = options.limit ?? 30
  const before = options.before ?? null
  const admin = isAdmin(staff)
  const client = await loadClient(tx, clientId)
  const orgId = client.organizationId
  const wants = (category: TimelineCategory) =>
    filter === "todo" ||
    filter === category ||
    (filter === "cuenta" && (category === "alta" || category === "plan"))
  const beforeOf = (column: AnyPgColumn) => (before ? lt(column, before) : undefined)
  // Una fila más que la página por fuente dice si hay más; las que dan varias entradas, más filas.
  const one = limit + 1
  const many = (limit + 1) * 3
  const entries: TimelineEntry[] = []
  const people = new Set<string>()
  type Pending = Omit<TimelineEntry, "who"> & {
    who: TimelineEntry["who"] | { userId: string | null; fallback: TimelineEntry["who"] }
  }
  const pending: Pending[] = []
  /** Las tareas que cerró Kairós: su fila y su título, para decirlas en el hecho que las cerró. */
  const closedByKairos = new Map<string, string>()
  /** Los envíos que salieron sin conversación: su cajón dice qué decían. */
  const sentOutreach = new Set<string>()
  const push = (entry: Pending) => {
    if (before && entry.at >= before) return false
    if (!wants(entry.category)) return false
    if (entry.adminOnly && !admin) return false
    if ("userId" in entry.who && entry.who.userId) people.add(entry.who.userId)
    pending.push(entry)
    return true
  }
  const byUser = (
    userId: string | null,
    fallback: TimelineEntry["who"] = { kind: "sistema", name: "Sistema" },
  ) => ({
    userId,
    fallback,
  })
  const kairos = { kind: "kairos", name: "Kairós" } as const

  // El cliente, cuando lo agregó una persona.
  if (client.createdBy) {
    push({
      id: `cliente:${client.id}`,
      at: client.createdAt,
      who: byUser(client.createdBy),
      category: "venta",
      icon: "venta",
      title: "Se agregó como cliente",
      detail: [
        CLIENT_ORIGIN_WORDS[client.origin as SaasClientOrigin] ?? client.origin,
        client.originDetail,
      ]
        .filter(Boolean)
        .join(" · "),
      adminOnly: false,
      link: tab("resumen"),
    })
  }

  // La solicitud de la web (o la que creó el equipo para invitarla).
  if (wants("venta")) {
    const requests = await tx
      .select()
      .from(saasWaitlistRequest)
      .where(eq(saasWaitlistRequest.clientId, clientId))
    for (const r of requests) {
      const person = {
        kind: "clinica" as const,
        name: `${r.firstName} ${r.lastName}`.trim() || r.clinicName,
      }
      const link = { kind: "solicitud" as const, id: r.id }
      const base = {
        category: "venta" as const,
        icon: "solicitud" as const,
        adminOnly: false,
        link,
      }
      push({
        ...base,
        id: `solicitud:${r.id}:recibida`,
        at: r.createdAt,
        who: r.source === "web" ? person : { kind: "sistema", name: "Sistema" },
        title:
          r.source === "web"
            ? "Pidió entrar desde la web"
            : "Se preparó su solicitud para invitarla",
        detail: r.source === "web" ? `${r.clinicName} · ${r.city}` : undefined,
      })
      if (r.confirmationSentAt) {
        push({
          ...base,
          id: `solicitud:${r.id}:confirmacion`,
          at: r.confirmationSentAt,
          who: { kind: "sistema", name: "Sistema" },
          title: "Le llegó la confirmación de su solicitud",
        })
      }
      if (r.invitedAt) {
        push({
          ...base,
          id: `solicitud:${r.id}:invitada`,
          at: r.invitedAt,
          who: byUser(r.decidedBy),
          title: "La invitamos a entrar",
          detail: r.inviteExpiresAt
            ? `La invitación vale hasta el ${day(r.inviteExpiresAt)}`
            : undefined,
        })
      }
      if (r.status === "invitada" && r.inviteExpiresAt && r.inviteExpiresAt <= now) {
        push({
          ...base,
          id: `solicitud:${r.id}:vencio`,
          at: r.inviteExpiresAt,
          who: { kind: "sistema", name: "Sistema" },
          title: "Venció su invitación sin que entrara",
        })
      }
      if (r.enteredAt) {
        push({
          ...base,
          id: `solicitud:${r.id}:entro`,
          at: r.enteredAt,
          who: person,
          title: "Abrió su cuenta con la invitación",
        })
      }
      if (r.status === "descartada" && r.decidedAt) {
        push({
          ...base,
          id: `solicitud:${r.id}:descartada`,
          at: r.decidedAt,
          who: byUser(r.decidedBy),
          title: "Se descartó su solicitud",
          detail: clip(r.discardReason),
        })
      }
    }
  }

  // La bitácora (las actividades). La de un correo que entró se abre en ese correo (misma hora y
  // cliente), la de una respuesta que salió, en el correo que respondió, y la de un chat, en su
  // conversación. Lo que es de una conversación es solo de Administración (ADR 0196); lo que
  // anota el equipo se abre en su cajón, con el texto entero.
  if (wants("conversaciones") || wants("venta")) {
    const rows = await tx
      .select({
        f: saasFollowUp,
        inboundId: sql<string | null>`${activityInboundSql(sql`e.id::text`)}`,
        // Quién lo escribió: su nombre o, sin nombre, su correo.
        inboundFrom: sql<
          string | null
        >`${activityInboundSql(sql`coalesce(nullif(trim(e.from_name), ''), e.from_address)`)}`,
        repliedId: sql<string | null>`${activitySentSql(sql`o.in_reply_to_email_id::text`)}`,
        sentId: sql<string | null>`${activitySentSql(sql`o.id::text`)}`,
        chatFrom: activityChatFromSql,
      })
      .from(saasFollowUp)
      .where(
        and(
          eq(saasFollowUp.clientId, clientId),
          // A Soporte no le llega lo de las conversaciones: se filtra aquí, no después, para que
          // la página no se llene de filas que no ve y «Ver más» siga encontrando lo anterior.
          admin
            ? undefined
            : and(eq(saasFollowUp.adminOnly, false), sql`not ${activityIsConversationSql}`),
          beforeOf(saasFollowUp.happenedAt),
        ),
      )
      .orderBy(desc(saasFollowUp.happenedAt))
      .limit(one)
    for (const { f, inboundId, inboundFrom, repliedId, sentId, chatFrom } of rows) {
      const kind = (f.kind in ACTIVITY_TITLES ? f.kind : "nota") as SaasActivityKind
      const titles = ACTIVITY_TITLES[kind]
      const title = repliedId
        ? "Le respondimos su correo"
        : f.direction === "entro"
          ? titles.entro
          : f.direction === "salio"
            ? titles.salio
            : titles.nota
      const emailId = inboundId ?? repliedId
      const link: TimelineLink = emailId
        ? { kind: "correo", id: emailId }
        : f.chatId
          ? // Lo que entró o salió por WhatsApp, Instagram o Messenger abre su conversación.
            { kind: "chat", id: f.chatId }
          : sentId
            ? { kind: "envio", id: sentId }
            : { kind: "actividad", id: f.id }
      const shown = push({
        id: `actividad:${f.id}`,
        at: f.happenedAt,
        // El correo que entró lo escribió quien lo mandó, aunque lo haya anotado Kairós.
        who:
          (inboundFrom ?? chatFrom)
            ? { kind: "clinica", name: inboundFrom ?? chatFrom ?? "" }
            : f.byKairos
              ? kairos
              : byUser(f.authorUserId, {
                  kind: "persona",
                  name: "Nota anterior, sin autor registrado",
                }),
        category: kind === "presentacion" || kind === "propuesta" ? "venta" : "conversaciones",
        icon: kind,
        title,
        detail:
          [clip(f.body), f.outcome ? `Quedó en: ${clip(f.outcome, 200)}` : null]
            .filter(Boolean)
            .join(" · ") || undefined,
        adminOnly: f.adminOnly || link.kind !== "actividad",
        link,
        ...(link.kind === "actividad"
          ? { body: f.body, ...(f.outcome ? { outcome: f.outcome } : {}) }
          : {}),
      })
      if (shown && link.kind === "envio") sentOutreach.add(link.id)
    }
  }

  // Tareas hechas. La que cerró Kairós sola lo dice (no «Sistema»), y si fue poco después de un
  // hecho de su misma categoría, la dice ese hecho (`foldKairosClosings`).
  {
    const rows = await tx
      .select()
      .from(saasTask)
      .where(
        and(
          eq(saasTask.clientId, clientId),
          eq(saasTask.status, "hecha"),
          isNotNull(saasTask.doneAt),
          visibleTaskSql(staff),
          beforeOf(saasTask.doneAt),
        ),
      )
      .orderBy(desc(saasTask.doneAt))
      .limit(one)
    for (const t of rows) {
      if (!t.doneAt) continue
      const closedByIt = !t.doneBy && Boolean(t.doneNote?.startsWith(KAIROS_CLOSED))
      const id = `tarea:${t.id}`
      const shown = push({
        id,
        at: t.doneAt,
        who: byUser(t.doneBy, closedByIt ? kairos : undefined),
        category: taskCategory(t.kind),
        icon: "tarea",
        title: `Hecho: ${t.title}`,
        detail: clip(t.doneNote),
        // Una tarea de cobro o marcada solo de Administración: Soporte no la ve (ADR 0181).
        adminOnly: taskHiddenFromSupport(t),
        link: { kind: "tarea", id: t.id },
      })
      if (shown && closedByIt) closedByKairos.set(id, t.title)
    }
  }

  // Decisiones de venta y ventas nuevas: se leen en la Venta.
  if (wants("venta")) {
    const rows = await tx
      .select()
      .from(saasOpportunity)
      .where(eq(saasOpportunity.clientId, clientId))
      .orderBy(asc(saasOpportunity.createdAt))
    rows.forEach((o, index) => {
      if (index > 0) {
        push({
          id: `venta:${o.id}:abierta`,
          at: o.createdAt,
          who: byUser(o.createdBy),
          category: "venta",
          icon: "venta",
          title: "Se abrió otra venta",
          adminOnly: false,
          link: tab("venta"),
        })
      }
      if (!o.decidedAt || !o.decision || o.decision === "entro") return
      const reason = o.reason ? LOST_REASON_WORDS[o.reason as SaasLostReason] : null
      push({
        id: `venta:${o.id}:decision`,
        at: o.decidedAt,
        who: byUser(o.decidedBy),
        category: "venta",
        icon: "venta",
        title:
          o.decision === "no_por_ahora" && o.returnOn
            ? `No por ahora: volver el ${civilDay(o.returnOn)}`
            : o.decision === "no_por_ahora"
              ? "No por ahora"
              : "Se perdió la venta",
        detail: [reason, clip(o.reasonDetail)].filter(Boolean).join(" · ") || undefined,
        adminOnly: false,
        link: tab("venta"),
      })
    })
  }

  // Propuestas: lo que pasó, sin importes para Soporte.
  if (wants("venta")) {
    const rows = await tx.select().from(saasProposal).where(eq(saasProposal.clientId, clientId))
    for (const p of rows) {
      const link = { kind: "propuesta" as const, id: p.id }
      const terms = admin
        ? [
            moneyText(p.currency, p.listPriceCents),
            p.discountBps
              ? `${p.discountBps / 100} % de descuento${p.discountMonths ? ` por ${p.discountMonths} meses` : ""}`
              : null,
            p.trialDays ? `${p.trialDays} días de prueba` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : undefined
      const base = {
        category: "venta" as const,
        icon: "propuesta" as const,
        adminOnly: false,
        link,
      }
      push({
        ...base,
        id: `propuesta:${p.id}:creada`,
        at: p.createdAt,
        who: byUser(p.createdBy),
        title: `Se preparó la propuesta ${p.version}`,
        detail: terms,
      })
      if (p.sentAt) {
        push({
          ...base,
          id: `propuesta:${p.id}:enviada`,
          at: p.sentAt,
          who: byUser(p.createdBy),
          title: `Se envió la propuesta ${p.version}`,
          detail: `Vale hasta el ${civilDay(p.validUntil)}`,
        })
      }
      if (p.decidedAt && (p.status === "aceptada" || p.status === "no_aceptada")) {
        push({
          ...base,
          id: `propuesta:${p.id}:decidida`,
          at: p.decidedAt,
          who: byUser(p.decidedBy),
          title:
            p.status === "aceptada"
              ? `Aceptó la propuesta ${p.version}`
              : `No aceptó la propuesta ${p.version}`,
          detail: clip(p.acceptedNote),
        })
      }
    }
  }

  // Envíos que todavía no dejaron su actividad: por confirmar, inciertos o que no salieron. Son
  // de una conversación: solo Administración (ADR 0196). El de un chat abre su conversación; el
  // otro, su cajón con lo que decía.
  if (wants("conversaciones") && admin) {
    const rows = await tx
      .select()
      .from(saasOutreach)
      .where(
        and(
          eq(saasOutreach.clientId, clientId),
          inArray(saasOutreach.status, ["pendiente", "incierto", "no_salio"]),
          beforeOf(saasOutreach.createdAt),
        ),
      )
      .orderBy(desc(saasOutreach.createdAt))
      .limit(one)
    for (const o of rows) {
      const channelKey = (
        o.channel in OUTREACH_CHANNEL_WORDS ? o.channel : "correo"
      ) as SaasOutreachChannel
      const channel = OUTREACH_CHANNEL_WORDS[channelKey]
      const title =
        o.status === "pendiente"
          ? `Mensaje por ${channel}: falta decir si salió`
          : o.status === "incierto"
            ? `No se sabe si salió el ${channel === "correo" ? "correo" : `mensaje por ${channel}`}`
            : `No salió el mensaje por ${channel}`
      push({
        id: `envio:${o.id}`,
        at: o.resolvedAt ?? o.createdAt,
        who: byUser(o.resolvedBy ?? o.createdBy),
        category: "conversaciones",
        icon: channelKey,
        title,
        detail: clip(o.subject ?? o.body, 140),
        adminOnly: true,
        link: o.chatId ? { kind: "chat", id: o.chatId } : { kind: "envio", id: o.id },
        ...(o.chatId
          ? {}
          : {
              envio: {
                channel: channelKey,
                to: o.toAddress,
                subject: o.subject,
                body: o.body,
                status: o.status,
              },
            }),
      })
    }
  }

  // Auditoría de la cuenta y del cliente: una frase por código conocido.
  {
    const known = Object.keys(TIMELINE_AUDIT_PHRASES)
    const subject = orgId
      ? or(eq(adminAudit.organizationId, orgId), eq(adminAudit.entityId, clientId))
      : eq(adminAudit.entityId, clientId)
    const rows = await tx
      .select()
      .from(adminAudit)
      .where(and(subject, inArray(adminAudit.action, known), beforeOf(adminAudit.createdAt)))
      .orderBy(desc(adminAudit.createdAt))
      .limit(one)
    for (const a of rows) {
      const phrase = TIMELINE_AUDIT_PHRASES[a.action]
      if (!phrase) continue
      push({
        id: `auditoria:${a.id}`,
        at: a.createdAt,
        who: a.action.startsWith("kairos.")
          ? kairos
          : a.actorRole === "system" || !a.actorUserId
            ? { kind: "sistema", name: "Sistema" }
            : byUser(a.actorUserId),
        category: phrase.category,
        icon: phrase.icon,
        title: phrase.titleOf ? phrase.titleOf(a) : phrase.title,
        adminOnly: phrase.adminOnly === true,
        link: phrase.link(a),
      })
    }
  }

  // Los cambios del plan, de las dos auditorías (`listSaasPlanChanges`): se leen en Plan y pagos.
  if (orgId && wants("plan")) {
    // Quién mira decide el detalle: Soporte lee lo suyo (sin planes, importes ni motivos).
    const changes = await listSaasPlanChanges(tx, staff, orgId, { before, limit: many })
    for (const change of changes) {
      push({
        id: `plan:${change.id}`,
        at: change.at,
        who: change.by
          ? { kind: "persona", name: change.by.name }
          : { kind: "sistema", name: "Sistema" },
        category: "plan",
        icon: "plan",
        title: change.words,
        adminOnly: !change.support,
        link: tab("pagos"),
      })
    }
  }

  if (orgId && admin && wants("alta")) {
    // Lo que cargó la skill en el servidor (ADR 0183): el mismo registro de Alta, con sus cifras.
    const loads = await listClinicLoads(tx, orgId)
    for (const load of loads) {
      push({
        id: `carga:${load.id}`,
        at: new Date(load.at),
        who: load.by ? { kind: "persona", name: load.by } : { kind: "sistema", name: "Sistema" },
        category: "alta",
        icon: "carga",
        title: `${load.kind === "configuracion" ? "Se cargó la configuración" : "Se cargaron los pacientes"}: ${load.summary}`,
        adminOnly: true,
        link: { kind: "carga", id: load.id, orgId, loadId: load.id },
      })
    }
  }

  if (orgId && wants("plan")) {
    // Pagos: confirmados, rechazados (con su motivo), revertidos y devueltos; importes solo para
    // Administración. Se leen en Plan y pagos.
    const rows = await tx
      .select()
      .from(saasPayment)
      .where(and(eq(saasPayment.organizationId, orgId), beforeOf(saasPayment.createdAt)))
      .orderBy(desc(saasPayment.createdAt))
      .limit(many)
    for (const p of rows) {
      const amount = admin ? moneyText(p.currency, p.amountCents) : undefined
      const base = {
        category: "plan" as const,
        icon: "pago" as const,
        adminOnly: false,
        link: tab("pagos"),
      }
      push({
        ...base,
        id: `pago:${p.id}:recibido`,
        at: p.createdAt,
        who: { kind: "clinica", name: client.name },
        title: "Mandó un comprobante de pago",
        detail: amount,
      })
      if (p.confirmedAt)
        push({
          ...base,
          id: `pago:${p.id}:confirmado`,
          at: p.confirmedAt,
          who: byUser(p.confirmedBy),
          title: "Se confirmó su pago",
          detail: amount,
        })
      if (p.rejectedAt)
        push({
          ...base,
          id: `pago:${p.id}:rechazado`,
          at: p.rejectedAt,
          who: byUser(p.rejectedBy),
          title: "Se rechazó su comprobante",
          detail: clip(p.rejectReason),
        })
      if (p.reversedAt) {
        push({
          ...base,
          id: `pago:${p.id}:revertido`,
          at: p.reversedAt,
          who: byUser(p.reversedBy),
          title: p.status === "devuelto" ? "Se le devolvió un pago" : "Se revirtió un pago",
          detail: [amount, clip(p.reverseReason)].filter(Boolean).join(" · ") || undefined,
        })
      }
    }
  }

  if (orgId && wants("soporte")) {
    // Casos de soporte: abiertos y resueltos (Soporte no ve los de cobro). La pregunta queda en el
    // caso, que se abre en la cola.
    const rows = await tx
      .select({
        id: supportCase.id,
        kind: supportCase.kind,
        createdAt: supportCase.createdAt,
        resolvedAt: supportCase.resolvedAt,
        status: supportCase.status,
      })
      .from(supportCase)
      .where(
        and(
          eq(supportCase.organizationId, orgId),
          admin ? undefined : ne(supportCase.kind, "cobro"),
          beforeOf(supportCase.createdAt),
        ),
      )
      .orderBy(desc(supportCase.createdAt))
      .limit(many)
    for (const s of rows) {
      const link = { kind: "soporte" as const, id: s.id }
      const base = { category: "soporte" as const, icon: "soporte" as const, link }
      push({
        ...base,
        id: `soporte:${s.id}:abierto`,
        at: s.createdAt,
        who: { kind: "clinica", name: client.name },
        title: s.kind === "cobro" ? "Abrió un caso de cobro" : "Abrió un caso de soporte",
        adminOnly: s.kind === "cobro",
      })
      if (s.resolvedAt && s.status === "resuelto") {
        push({
          ...base,
          id: `soporte:${s.id}:resuelto`,
          at: s.resolvedAt,
          who: { kind: "sistema", name: "Soporte" },
          title: "Se resolvió su caso",
          adminOnly: s.kind === "cobro",
        })
      }
    }
  }

  if (wants("conversaciones") && admin) {
    // Correos que llegaron y no dejaron su actividad (la actividad de un correo que entró lleva su
    // misma hora). Son de una conversación: solo Administración (ADR 0196).
    const rows = await tx
      .select()
      .from(saasInboundEmail)
      .where(
        and(
          eq(saasInboundEmail.clientId, clientId),
          beforeOf(saasInboundEmail.receivedAt),
          sql`not exists (select 1 from ${saasFollowUp} f where f.client_id = ${clientId} and f.kind = 'correo'
            and f.direction = 'entro' and f.happened_at = ${saasInboundEmail.receivedAt})`,
        ),
      )
      .orderBy(desc(saasInboundEmail.receivedAt))
      .limit(one)
    for (const e of rows) {
      const files = e.attachments.length
      push({
        id: `correo:${e.id}`,
        at: e.receivedAt,
        who: { kind: "clinica", name: e.fromName?.trim() || e.fromAddress },
        category: "conversaciones",
        icon: "correo",
        title: `Nos escribió a ${inboundMailboxWords(e)}@`,
        detail:
          [clip(e.subject, 140), files ? `${files} ${files === 1 ? "adjunto" : "adjuntos"}` : null]
            .filter(Boolean)
            .join(" · ") || undefined,
        adminOnly: true,
        link: { kind: "correo" as const, id: e.id },
      })
    }
  }

  {
    // Documentos (los adjuntos de un correo ya los cuenta el correo). Cada uno se abre en el
    // visor; uno borrado lo dice ahí.
    const rows = await tx
      .select()
      .from(saasClientFile)
      .where(
        and(
          eq(saasClientFile.clientId, clientId),
          or(isNull(saasClientFile.source), ne(saasClientFile.source, "correo")),
          admin ? undefined : eq(saasClientFile.adminOnly, false),
          beforeOf(saasClientFile.createdAt),
        ),
      )
      .orderBy(desc(saasClientFile.createdAt))
      .limit(many)
    for (const f of rows) {
      const category = fileCategory(f)
      const who: Pending["who"] = f.source === "kairos" ? kairos : byUser(f.createdBy)
      const link = { kind: "archivo" as const, id: f.id }
      push({
        id: `archivo:${f.id}:subido`,
        at: f.createdAt,
        who,
        category,
        icon: "archivo",
        title: `${fileTitle(f)}: ${f.filename}`,
        adminOnly: f.adminOnly,
        link,
      })
      if (f.deletedAt)
        push({
          id: `archivo:${f.id}:borrado`,
          at: f.deletedAt,
          who: { kind: "sistema", name: "Sistema" },
          category,
          icon: "archivo",
          title: `Se borró ${f.filename}`,
          adminOnly: f.adminOnly,
          link,
        })
    }
  }

  // Lo que decía cada envío que salió sin conversación (su cajón lo muestra).
  const outreach = sentOutreach.size
    ? await tx
        .select()
        .from(saasOutreach)
        .where(inArray(saasOutreach.id, [...sentOutreach]))
    : []
  const sent = new Map(outreach.map((row) => [row.id, row]))

  const names = await userNames(tx, people)
  for (const entry of pending) {
    const who: TimelineEntry["who"] =
      "userId" in entry.who
        ? entry.who.userId
          ? { kind: "persona", name: names.get(entry.who.userId) ?? "Alguien del equipo" }
          : entry.who.fallback
        : entry.who
    const row = entry.link.kind === "envio" && !entry.envio ? sent.get(entry.link.id) : undefined
    entries.push({
      ...entry,
      who,
      ...(row
        ? {
            envio: {
              channel: (row.channel in OUTREACH_CHANNEL_WORDS
                ? row.channel
                : "correo") as SaasOutreachChannel,
              to: row.toAddress,
              subject: row.subject,
              body: row.body,
              status: row.status,
            },
          }
        : {}),
    })
  }
  entries.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? -1 : 1))
  // La página no corta entre dos entradas del mismo instante: «Cargar más» pide lo anterior a él.
  let end = Math.min(limit, entries.length)
  const cut = entries[end - 1]
  while (cut && end < entries.length && entries[end]?.at.getTime() === cut.at.getTime()) end += 1
  const page = entries.slice(0, end)
  const last = page[page.length - 1]
  return {
    items: foldKairosClosings(page, closedByKairos),
    nextBefore: entries.length > end && last ? last.at : null,
  }
}
