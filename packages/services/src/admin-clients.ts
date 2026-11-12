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
  type SaasClientOrigin,
  type SaasClientSummarySource,
  type SaasContactChannel,
  type SaasContactRole,
  type SaasLostReason,
  type SaasOpportunityDecision,
  type SaasTaskKind,
  saasClient,
  saasClientContact,
  saasClientFile,
  saasImportDraft,
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

/**
 * Los clientes del ARM de la administración (ADR 0183): la clínica es el eje,
 * desde el primer contacto (a mano, con la solicitud de la web o cuando abre
 * su cuenta) y para siempre. La solicitud y la cuenta son cosas que le pasan
 * al cliente, no el cliente.
 *
 * - La etapa se calcula al leer, nunca se guarda: `clientStage` (TS) y
 *   `clientStageSql` (SQL) son la misma regla; si cambia una, cambia la otra.
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

/**
 * Lo que se anota en `outcome` cuando una presentación agendada no se hizo
 * (`recordPresentation` de admin-sales): esa actividad no cuenta como
 * «Presentación hecha».
 */
export const PRESENTATION_NOT_DONE_OUTCOMES = ["no_se_conecto", "reprogramar"] as const

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

/* ---------- La etapa (TS y SQL gemelas) ---------- */

/**
 * Los hechos de los que sale la etapa. Lo de la venta (propuesta,
 * presentación) cuenta solo desde que se abrió la venta abierta: una
 * propuesta de una venta perdida no adelanta la nueva.
 */
export interface ClientStageFacts {
  /** Tiene cuenta (`organization_id`). */
  hasAccount: boolean
  /** Hay una venta sin decidir. */
  openOpportunity: boolean
  /** Una propuesta de esta venta enviada y vigente, o ya aceptada. */
  proposalOut: boolean
  /** Su solicitud está invitada (vigente o vencida: se ve dentro de «Propuesta»). */
  invited: boolean
  /** Una actividad de presentación de esta venta que sí se hizo. */
  presentationDone: boolean
  /** Una tarea de presentación abierta. */
  presentationScheduled: boolean
  /** La decisión de la última venta decidida. */
  lastDecision: SaasOpportunityDecision | null
}

/**
 * La etapa de un cliente. Con cuenta, «Entró». Con la venta abierta, lo más
 * avanzado que pasó: propuesta (o invitación), presentación hecha,
 * presentación agendada o contacto. Sin venta abierta, la decisión de la
 * última; sin ninguna, «Contacto».
 */
export function clientStage(facts: ClientStageFacts): ClientStage {
  if (facts.hasAccount) return "entro"
  if (facts.openOpportunity) {
    if (facts.proposalOut || facts.invited) return "propuesta"
    if (facts.presentationDone) return "presentacion_hecha"
    if (facts.presentationScheduled) return "presentacion_agendada"
    return "contacto"
  }
  return facts.lastDecision ?? "contacto"
}

/** Cada hecho de `ClientStageFacts` en SQL, sobre la fila de `saas_client` de la consulta. */
function stageFactsSql(now: Date) {
  const today = limaDate(now)
  const openSince = sql`(select o.created_at from ${saasOpportunity} o where o.client_id = ${saasClient.id} and o.decision is null limit 1)`
  const notDone = sql.raw(PRESENTATION_NOT_DONE_OUTCOMES.map((code) => `'${code}'`).join(","))
  return {
    hasAccount: sql<boolean>`(${saasClient.organizationId} is not null)`,
    openOpportunity: sql<boolean>`exists (select 1 from ${saasOpportunity} o where o.client_id = ${saasClient.id} and o.decision is null)`,
    proposalOut: sql<boolean>`exists (select 1 from ${saasProposal} p where p.client_id = ${saasClient.id}
      and p.created_at >= ${openSince}
      and (p.status = 'aceptada' or (p.status = 'enviada' and p.valid_until >= ${today}::date)))`,
    invited: sql<boolean>`exists (select 1 from ${saasWaitlistRequest} r where r.client_id = ${saasClient.id} and r.status = 'invitada')`,
    presentationDone: sql<boolean>`exists (select 1 from ${saasFollowUp} f where f.client_id = ${saasClient.id}
      and f.kind = 'presentacion' and f.happened_at >= ${openSince}
      and (f.outcome is null or f.outcome not in (${notDone})))`,
    presentationScheduled: sql<boolean>`exists (select 1 from ${saasTask} t where t.client_id = ${saasClient.id} and t.kind = 'presentacion' and t.status = 'abierta')`,
    lastDecision: sql<SaasOpportunityDecision | null>`(select o.decision from ${saasOpportunity} o
      where o.client_id = ${saasClient.id} and o.decision is not null
      order by o.decided_at desc, o.created_at desc limit 1)`,
  }
}

/** La misma regla de `clientStage`, en SQL: filtra y cuenta sin que el tope de filas la corte. */
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

export const CLIENT_VIEWS = [
  "por_vender",
  "con_cuenta",
  "no_por_ahora",
  "perdidos",
  "todos",
] as const
export type ClientView = (typeof CLIENT_VIEWS)[number]

export interface ClientListFilter {
  view?: ClientView
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

/** Otra ficha viva tiene una persona con el mismo correo: puede ser la misma clínica. */
const duplicateSql = sql<boolean>`exists (
  select 1 from ${saasClientContact} k
  join ${saasClientContact} k2 on k2.email = k.email and k2.client_id <> k.client_id
  join ${saasClient} c2 on c2.id = k2.client_id and c2.archived_at is null
  where k.client_id = ${saasClient.id} and k.email is not null)`

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

function viewSql(view: ClientView, stage: SQL<ClientStage>): SQL {
  const selling = sql.raw(SELLING_STAGES.map((s) => `'${s}'`).join(","))
  switch (view) {
    case "por_vender":
      return sql`(${saasClient.organizationId} is null and ${stage} in (${selling}))`
    case "con_cuenta":
      return sql`(${saasClient.organizationId} is not null)`
    case "no_por_ahora":
      return sql`(${stage} = 'no_por_ahora')`
    case "perdidos":
      return sql`(${stage} = 'perdido')`
    case "todos":
      return sql`true`
  }
}

const listFilterSchema = z.strictObject({
  view: z.enum(CLIENT_VIEWS, "Elige una vista").optional(),
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

/** El próximo paso de cada cliente: su tarea abierta más próxima. */
async function nextSteps(
  tx: Db,
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
    .where(and(inArray(saasTask.clientId, clientIds), eq(saasTask.status, "abierta")))
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
        overdue: row.dueOn < today || (row.dueAt !== null && row.dueAt.getTime() < now.getTime()),
      },
    ]),
  )
}

/**
 * La lista de clientes por vista (Por vender, Con cuenta, No por ahora,
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
          sql<number>`(count(*) filter (where ${viewSql(v, stage)}))::int`,
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
      lastContactAt: lastContactSql,
    })
    .from(saasClient)
    .leftJoin(user, eq(user.id, saasClient.ownerUserId))
    .where(and(base, viewSql(view, stage)))
    .orderBy(
      sql`(select min(t.due_on) from ${saasTask} t where t.client_id = ${saasClient.id} and t.status = 'abierta') asc nulls last`,
      desc(saasClient.createdAt),
      asc(saasClient.id),
    )
    .limit(limit)
    .offset(offset)

  const ids = rows.map((row) => row.id)
  const steps = await nextSteps(tx, ids, now)
  const signals = await clientSignals(tx, staff, ids, now)
  const items = rows.map((row): ClientListItem => {
    const nextStep = steps.get(row.id) ?? null
    const lastContactAt = toDate(row.lastContactAt)
    return {
      id: row.id,
      name: row.name,
      product: row.product as ClinicalProduct,
      stage: row.stage,
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
  options: { members?: boolean } = {},
): Promise<{ clientId: string; matchedBy: ClientEmailMatch } | null> {
  const address = email.trim().toLowerCase()
  if (!address) return null
  const levels: Array<{ matchedBy: ClientEmailMatch; query: SQL }> = [
    {
      matchedBy: "contacto",
      query: sql`select distinct c.id from ${saasClientContact} k
        join ${saasClient} c on c.id = k.client_id
        where k.email = ${address} and c.archived_at is null limit 2`,
    },
    {
      matchedBy: "solicitud",
      query: sql`select distinct c.id from ${saasWaitlistRequest} r
        join ${saasClient} c on c.id = r.client_id
        where lower(r.email) = ${address} and c.archived_at is null limit 2`,
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
  const reused = (await clientByEmail(tx, email))?.clientId
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
    const [row] = await tx
      .select({ org: saasClient.organizationId })
      .from(saasClient)
      .where(eq(saasClient.id, reused))
      .limit(1)
    // Vuelve una que dijo «no por ahora» o se perdió: otra venta; la anterior queda como historia.
    if (!row?.org) await openSaleIfNone(tx, reused, null)
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
 * fusionar). Una demo no es cliente: null.
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
  await tx
    .update(saasClient)
    .set({
      organizationId: input.organizationId,
      archivedAt: null,
      archivedBy: null,
      updatedAt: now,
    })
    .where(eq(saasClient.id, client.id))
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
}

export interface ClientDetail {
  id: string
  name: string
  product: ClinicalProduct
  stage: ClientStage
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
  summary: { text: string; sources: SaasClientSummarySource[]; at: Date | null } | null
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

/** La ficha del cliente: cabecera, datos, personas, tareas abiertas, últimas actividades y señales. */
export async function getClient(
  tx: Db,
  actor: AdminActor,
  id: string,
  now = new Date(),
): Promise<ClientDetail> {
  const staff = requireStaff(actor)
  const facts = stageFactsSql(now)
  if (!UUID.test(id)) throw notFound("Cliente")
  const [row] = await tx
    .select({
      client: saasClient,
      ownerName: user.name,
      hasAccount: facts.hasAccount,
      openOpportunity: facts.openOpportunity,
      proposalOut: facts.proposalOut,
      invited: facts.invited,
      presentationDone: facts.presentationDone,
      presentationScheduled: facts.presentationScheduled,
      lastDecision: facts.lastDecision,
      lastContactAt: lastContactSql,
    })
    .from(saasClient)
    .leftJoin(user, eq(user.id, saasClient.ownerUserId))
    .where(eq(saasClient.id, id))
    .limit(1)
  if (!row) throw notFound("Cliente")
  const client = row.client
  const stage = clientStage({
    hasAccount: Boolean(row.hasAccount),
    openOpportunity: Boolean(row.openOpportunity),
    proposalOut: Boolean(row.proposalOut),
    invited: Boolean(row.invited),
    presentationDone: Boolean(row.presentationDone),
    presentationScheduled: Boolean(row.presentationScheduled),
    lastDecision: row.lastDecision ?? null,
  })

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

  const steps = await nextSteps(tx, [id], now)
  const nextStep = steps.get(id) ?? null
  const lastContactAt = toDate(row.lastContactAt)
  const today = limaDate(now)

  const taskRows = await tx
    .select({ task: saasTask, assigneeName: user.name })
    .from(saasTask)
    .leftJoin(user, eq(user.id, saasTask.assigneeUserId))
    .where(and(eq(saasTask.clientId, id), eq(saasTask.status, "abierta")))
    .orderBy(asc(saasTask.dueOn), sql`${saasTask.dueAt} asc nulls last`, asc(saasTask.createdAt))
  const activityRows = await tx
    .select({ entry: saasFollowUp, authorName: user.name })
    .from(saasFollowUp)
    .leftJoin(user, eq(user.id, saasFollowUp.authorUserId))
    .where(
      and(
        eq(saasFollowUp.clientId, id),
        isAdmin(staff) ? undefined : eq(saasFollowUp.adminOnly, false),
      ),
    )
    .orderBy(desc(saasFollowUp.happenedAt), desc(saasFollowUp.createdAt))
    .limit(5)

  return {
    id: client.id,
    name: client.name,
    product: client.product as ClinicalProduct,
    stage,
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
      ? { text: client.summary, sources: client.summarySources ?? [], at: client.summaryAt }
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
      overdue: task.dueOn < today || (task.dueAt !== null && task.dueAt.getTime() < now.getTime()),
    })),
    recentActivities: activityRows.map(({ entry, authorName }) => ({
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
    })),
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

  // Las propuestas siguen numeradas después de las de la que se queda.
  const [top] = await tx
    .select({ max: sql<number>`coalesce(max(${saasProposal.version}), 0)::int` })
    .from(saasProposal)
    .where(eq(saasProposal.clientId, keepId))
  const offset = Number(top?.max ?? 0)
  count(
    "proposals",
    await tx
      .update(saasProposal)
      .set({ clientId: keepId, version: sql`${saasProposal.version} + ${offset}` })
      .where(eq(saasProposal.clientId, dropId))
      .returning({ id: saasProposal.id }),
  )
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
  count(
    "importDrafts",
    await tx
      .update(saasImportDraft)
      .set({ clientId: keepId })
      .where(eq(saasImportDraft.clientId, dropId))
      .returning({ id: saasImportDraft.id }),
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

export const TIMELINE_FILTERS = ["todo", "contactos", "venta", "cuenta", "soporte"] as const
export type TimelineFilter = (typeof TIMELINE_FILTERS)[number]
export type TimelineCategory = Exclude<TimelineFilter, "todo">

export interface TimelineEntry {
  /** Fuente e id: único en la línea de tiempo. */
  id: string
  at: Date
  who: { kind: "persona" | "kairos" | "sistema" | "clinica"; name: string }
  category: TimelineCategory
  title: string
  detail?: string
  adminOnly: boolean
  link?: {
    kind:
      | "solicitud"
      | "propuesta"
      | "envio"
      | "soporte"
      | "archivo"
      | "tarea"
      | "borrador"
      | "correo"
    id: string
  }
}

export interface ClientTimeline {
  items: TimelineEntry[]
  /** Para «Cargar más»: lo anterior a este instante. Null si no hay más. */
  nextBefore: Date | null
}

/**
 * Una frase por código de la auditoría de la administración (de la cuenta o
 * del cliente). Lo que no está aquí no se muestra: nunca el código. Lo de
 * pagos sale de `saas_payment` y lo de la solicitud y la bitácora de sus
 * tablas, para no contarlo dos veces.
 */
export const TIMELINE_AUDIT_PHRASES: Record<
  string,
  { title: string; category: TimelineCategory; adminOnly?: boolean }
> = {
  "org.assisted_create_invited": {
    title: "Se creó su cuenta con el alta asistida y se invitó a la propietaria",
    category: "cuenta",
  },
  "org.invitation_resend": { title: "Se reenvió una invitación a su equipo", category: "cuenta" },
  "org.invitation_cancel": { title: "Se anuló una invitación a su equipo", category: "cuenta" },
  "org.setup_import": {
    title: "Se cargó la configuración de la clínica",
    category: "cuenta",
    adminOnly: true,
  },
  "org.data_import": { title: "Se cargaron sus pacientes", category: "cuenta", adminOnly: true },
  "org.progress_report_sent": {
    title: "Se le envió el informe de la carga",
    category: "cuenta",
    adminOnly: true,
  },
  "org.progress_report_unknown": {
    title: "No se sabe si le llegó el informe de la carga",
    category: "cuenta",
    adminOnly: true,
  },
  "saas.activated": { title: "Se activó su plan", category: "cuenta" },
  "saas.paused": { title: "Se pausó su plan", category: "cuenta" },
  "saas.resumed": { title: "Se reanudó su plan", category: "cuenta" },
  "saas.charge_created": { title: "Se le generó un cobro", category: "cuenta", adminOnly: true },
  "saas.discount_expired": {
    title: "Terminó su precio especial",
    category: "cuenta",
    adminOnly: true,
  },
  "saas.guarantee_ended": {
    title: "Terminaron sus condiciones de Fundadora",
    category: "cuenta",
    adminOnly: true,
  },
  "recovery.case_open": {
    title: "Se abrió una recuperación de la propiedad de la cuenta",
    category: "cuenta",
  },
  "recovery.case_decide": {
    title: "Se decidió la recuperación de la propiedad de la cuenta",
    category: "cuenta",
  },
  "recovery.case_execute": {
    title: "Se completó la recuperación de la propiedad de la cuenta",
    category: "cuenta",
  },
  "client.updated": { title: "Se actualizaron sus datos", category: "venta" },
  "client.archived": { title: "Se archivó el cliente", category: "venta" },
  "client.merged": { title: "Se unió con otra ficha de la misma clínica", category: "venta" },
  "client.contact_added": { title: "Se agregó una persona", category: "contactos" },
  "client.contact_linked": { title: "Se ligó una persona a su usuario", category: "contactos" },
  "kairos.client_created": { title: "Kairós creó el cliente al ver su cuenta", category: "cuenta" },
  "kairos.client_linked": { title: "Kairós ligó su cuenta a esta ficha", category: "cuenta" },
  "arm.proposal_applied": {
    title: "Se pusieron en su plan las condiciones de la propuesta aceptada",
    category: "venta",
    adminOnly: true,
  },
  "arm.proposal_not_applied": {
    title:
      "Las condiciones de la propuesta aceptada no se pusieron solas: hay que ponerlas en Plan y pagos",
    category: "venta",
    adminOnly: true,
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
}

const SALE_TASKS: readonly string[] = ["presentacion", "propuesta"]
const ACCOUNT_TASKS: readonly string[] = ["alta", "cobro"]
const taskCategory = (kind: string): TimelineCategory =>
  SALE_TASKS.includes(kind) ? "venta" : ACCOUNT_TASKS.includes(kind) ? "cuenta" : "contactos"

const FILE_TITLES: Record<string, string> = {
  carta: "Carta de bienvenida",
  propuesta: "Propuesta",
  presentacion: "Presentación",
  plan_carga: "Plan de la carga",
  informe: "Informe de la carga",
  archivo_clinica: "Archivo de la clínica",
  correo: "Adjunto de un correo",
  otro: "Documento",
}

const DRAFT_TITLES: Record<string, string> = {
  plan_configuracion: "el plan de configuración",
  plan_pacientes: "el plan de pacientes",
  informe: "el informe",
}

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
  filter: z.enum(TIMELINE_FILTERS, "Elige qué ver").optional(),
  before: z.date().optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

/**
 * El historial del cliente, en palabras, armado al leer desde sus fuentes
 * (nada se copia dos veces): la solicitud (recibida, confirmación, invitada,
 * venció, entró, descartada), la bitácora, las tareas hechas, las decisiones
 * de venta, las propuestas, los envíos sin confirmar (los que salieron ya
 * dejaron su actividad), la auditoría de la cuenta y del cliente (una frase
 * por código), los pagos, los casos de soporte, lo que dejó la skill, los
 * correos que llegaron (sin la actividad que los registró) y los archivos.
 * Soporte no ve lo «solo administración» ni importes ni casos de cobro.
 */
export async function clientTimeline(
  tx: Db,
  actor: AdminActor,
  clientId: string,
  raw: { filter?: TimelineFilter; before?: Date; limit?: number } = {},
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
  const wants = (category: TimelineCategory) => filter === "todo" || filter === category
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
  const push = (entry: Pending) => {
    if (before && entry.at >= before) return
    if (!wants(entry.category)) return
    if (entry.adminOnly && !admin) return
    if ("userId" in entry.who && entry.who.userId) people.add(entry.who.userId)
    pending.push(entry)
  }
  const byUser = (
    userId: string | null,
    fallback: TimelineEntry["who"] = { kind: "sistema", name: "Sistema" },
  ) => ({
    userId,
    fallback,
  })

  // El cliente, cuando lo agregó una persona.
  if (client.createdBy) {
    push({
      id: `cliente:${client.id}`,
      at: client.createdAt,
      who: byUser(client.createdBy),
      category: "venta",
      title: "Se agregó como cliente",
      detail: [
        CLIENT_ORIGIN_WORDS[client.origin as SaasClientOrigin] ?? client.origin,
        client.originDetail,
      ]
        .filter(Boolean)
        .join(" · "),
      adminOnly: false,
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
      push({
        id: `solicitud:${r.id}:recibida`,
        at: r.createdAt,
        who: r.source === "web" ? person : { kind: "sistema", name: "Sistema" },
        category: "venta",
        title:
          r.source === "web"
            ? "Pidió entrar desde la web"
            : "Se preparó su solicitud para invitarla",
        detail: r.source === "web" ? `${r.clinicName} · ${r.city}` : undefined,
        adminOnly: false,
        link,
      })
      if (r.confirmationSentAt) {
        push({
          id: `solicitud:${r.id}:confirmacion`,
          at: r.confirmationSentAt,
          who: { kind: "sistema", name: "Sistema" },
          category: "venta",
          title: "Le llegó la confirmación de su solicitud",
          adminOnly: false,
          link,
        })
      }
      if (r.invitedAt) {
        push({
          id: `solicitud:${r.id}:invitada`,
          at: r.invitedAt,
          who: byUser(r.decidedBy),
          category: "venta",
          title: "La invitamos a entrar",
          detail: r.inviteExpiresAt
            ? `La invitación vale hasta el ${day(r.inviteExpiresAt)}`
            : undefined,
          adminOnly: false,
          link,
        })
      }
      if (r.status === "invitada" && r.inviteExpiresAt && r.inviteExpiresAt <= now) {
        push({
          id: `solicitud:${r.id}:vencio`,
          at: r.inviteExpiresAt,
          who: { kind: "sistema", name: "Sistema" },
          category: "venta",
          title: "Venció su invitación sin que entrara",
          adminOnly: false,
          link,
        })
      }
      if (r.enteredAt) {
        push({
          id: `solicitud:${r.id}:entro`,
          at: r.enteredAt,
          who: person,
          category: "venta",
          title: "Abrió su cuenta con la invitación",
          adminOnly: false,
          link,
        })
      }
      if (r.status === "descartada" && r.decidedAt) {
        push({
          id: `solicitud:${r.id}:descartada`,
          at: r.decidedAt,
          who: byUser(r.decidedBy),
          category: "venta",
          title: "Se descartó su solicitud",
          detail: clip(r.discardReason),
          adminOnly: false,
          link,
        })
      }
    }
  }

  // La bitácora (las actividades).
  if (wants("contactos") || wants("venta")) {
    const rows = await tx
      .select()
      .from(saasFollowUp)
      .where(
        and(
          eq(saasFollowUp.clientId, clientId),
          admin ? undefined : eq(saasFollowUp.adminOnly, false),
          beforeOf(saasFollowUp.happenedAt),
        ),
      )
      .orderBy(desc(saasFollowUp.happenedAt))
      .limit(one)
    for (const f of rows) {
      const kind = f.kind as SaasActivityKind
      const titles = ACTIVITY_TITLES[kind] ?? ACTIVITY_TITLES.nota
      const title =
        f.direction === "entro"
          ? titles.entro
          : f.direction === "salio"
            ? titles.salio
            : titles.nota
      push({
        id: `actividad:${f.id}`,
        at: f.happenedAt,
        who: f.byKairos
          ? { kind: "kairos", name: "Kairós" }
          : byUser(f.authorUserId, {
              kind: "persona",
              name: "Nota anterior, sin autor registrado",
            }),
        category: kind === "presentacion" || kind === "propuesta" ? "venta" : "contactos",
        title,
        detail:
          [clip(f.body), f.outcome ? `Quedó en: ${clip(f.outcome, 200)}` : null]
            .filter(Boolean)
            .join(" · ") || undefined,
        adminOnly: f.adminOnly,
      })
    }
  }

  // Tareas hechas.
  {
    const rows = await tx
      .select()
      .from(saasTask)
      .where(
        and(
          eq(saasTask.clientId, clientId),
          eq(saasTask.status, "hecha"),
          isNotNull(saasTask.doneAt),
          beforeOf(saasTask.doneAt),
        ),
      )
      .orderBy(desc(saasTask.doneAt))
      .limit(one)
    for (const t of rows) {
      if (!t.doneAt) continue
      push({
        id: `tarea:${t.id}`,
        at: t.doneAt,
        who: byUser(t.doneBy),
        category: taskCategory(t.kind),
        title: `Hecho: ${t.title}`,
        detail: clip(t.doneNote),
        adminOnly: false,
        link: { kind: "tarea", id: t.id },
      })
    }
  }

  // Decisiones de venta y ventas nuevas.
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
          title: "Se abrió otra venta",
          adminOnly: false,
        })
      }
      if (!o.decidedAt || !o.decision || o.decision === "entro") return
      const reason = o.reason ? LOST_REASON_WORDS[o.reason as SaasLostReason] : null
      push({
        id: `venta:${o.id}:decision`,
        at: o.decidedAt,
        who: byUser(o.decidedBy),
        category: "venta",
        title:
          o.decision === "no_por_ahora" && o.returnOn
            ? `No por ahora: volver el ${civilDay(o.returnOn)}`
            : o.decision === "no_por_ahora"
              ? "No por ahora"
              : "Se perdió la venta",
        detail: [reason, clip(o.reasonDetail)].filter(Boolean).join(" · ") || undefined,
        adminOnly: false,
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
      push({
        id: `propuesta:${p.id}:creada`,
        at: p.createdAt,
        who: byUser(p.createdBy),
        category: "venta",
        title: `Se preparó la propuesta ${p.version}`,
        detail: terms,
        adminOnly: false,
        link,
      })
      if (p.sentAt) {
        push({
          id: `propuesta:${p.id}:enviada`,
          at: p.sentAt,
          who: byUser(p.createdBy),
          category: "venta",
          title: `Se envió la propuesta ${p.version}`,
          detail: `Vale hasta el ${civilDay(p.validUntil)}`,
          adminOnly: false,
          link,
        })
      }
      if (p.decidedAt && (p.status === "aceptada" || p.status === "no_aceptada")) {
        push({
          id: `propuesta:${p.id}:decidida`,
          at: p.decidedAt,
          who: byUser(p.decidedBy),
          category: "venta",
          title:
            p.status === "aceptada"
              ? `Aceptó la propuesta ${p.version}`
              : `No aceptó la propuesta ${p.version}`,
          detail: clip(p.acceptedNote),
          adminOnly: false,
          link,
        })
      }
    }
  }

  // Envíos que todavía no dejaron su actividad: por confirmar, inciertos o que no salieron.
  if (wants("contactos")) {
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
      const channel = o.channel === "whatsapp" ? "WhatsApp" : "correo"
      const title =
        o.status === "pendiente"
          ? `Mensaje por ${channel}: falta decir si salió`
          : o.status === "incierto"
            ? `No se sabe si salió el ${channel === "correo" ? "correo" : "WhatsApp"}`
            : `No salió el mensaje por ${channel}`
      push({
        id: `envio:${o.id}`,
        at: o.resolvedAt ?? o.createdAt,
        who: byUser(o.resolvedBy ?? o.createdBy),
        category: "contactos",
        title,
        detail: clip(o.subject ?? o.body, 140),
        adminOnly: false,
        link: { kind: "envio", id: o.id },
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
          ? { kind: "kairos", name: "Kairós" }
          : a.actorRole === "system" || !a.actorUserId
            ? { kind: "sistema", name: "Sistema" }
            : byUser(a.actorUserId),
        category: phrase.category,
        title: phrase.title,
        adminOnly: phrase.adminOnly === true,
      })
    }
  }

  if (orgId && wants("cuenta")) {
    // Pagos: confirmados, rechazados (con su motivo), revertidos y devueltos; importes solo para Administración.
    const rows = await tx
      .select()
      .from(saasPayment)
      .where(and(eq(saasPayment.organizationId, orgId), beforeOf(saasPayment.createdAt)))
      .orderBy(desc(saasPayment.createdAt))
      .limit(many)
    for (const p of rows) {
      const amount = admin ? moneyText(p.currency, p.amountCents) : undefined
      push({
        id: `pago:${p.id}:recibido`,
        at: p.createdAt,
        who: { kind: "clinica", name: client.name },
        category: "cuenta",
        title: "Mandó un comprobante de pago",
        detail: amount,
        adminOnly: false,
      })
      if (p.confirmedAt)
        push({
          id: `pago:${p.id}:confirmado`,
          at: p.confirmedAt,
          who: byUser(p.confirmedBy),
          category: "cuenta",
          title: "Se confirmó su pago",
          detail: amount,
          adminOnly: false,
        })
      if (p.rejectedAt)
        push({
          id: `pago:${p.id}:rechazado`,
          at: p.rejectedAt,
          who: byUser(p.rejectedBy),
          category: "cuenta",
          title: "Se rechazó su comprobante",
          detail: clip(p.rejectReason),
          adminOnly: false,
        })
      if (p.reversedAt) {
        push({
          id: `pago:${p.id}:revertido`,
          at: p.reversedAt,
          who: byUser(p.reversedBy),
          category: "cuenta",
          title: p.status === "devuelto" ? "Se le devolvió un pago" : "Se revirtió un pago",
          detail: [amount, clip(p.reverseReason)].filter(Boolean).join(" · ") || undefined,
          adminOnly: false,
        })
      }
    }
  }

  if (orgId && wants("soporte")) {
    // Casos de soporte: abiertos y resueltos (Soporte no ve los de cobro). La pregunta queda en el caso.
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
      push({
        id: `soporte:${s.id}:abierto`,
        at: s.createdAt,
        who: { kind: "clinica", name: client.name },
        category: "soporte",
        title: s.kind === "cobro" ? "Abrió un caso de cobro" : "Abrió un caso de soporte",
        adminOnly: s.kind === "cobro",
        link,
      })
      if (s.resolvedAt && s.status === "resuelto") {
        push({
          id: `soporte:${s.id}:resuelto`,
          at: s.resolvedAt,
          who: { kind: "sistema", name: "Soporte" },
          category: "soporte",
          title: "Se resolvió su caso",
          adminOnly: s.kind === "cobro",
          link,
        })
      }
    }
  }

  if (admin && wants("cuenta")) {
    // Lo que dejó la skill de la carga (solo Administración).
    const rows = await tx
      .select()
      .from(saasImportDraft)
      .where(and(eq(saasImportDraft.clientId, clientId), beforeOf(saasImportDraft.createdAt)))
      .orderBy(desc(saasImportDraft.createdAt))
      .limit(many)
    for (const d of rows) {
      const what = DRAFT_TITLES[d.kind] ?? "un borrador"
      const link = { kind: "borrador" as const, id: d.id }
      push({
        id: `borrador:${d.id}:lista`,
        at: d.createdAt,
        who: byUser(d.uploadedBy),
        category: "cuenta",
        title: `La skill dejó ${what} ${d.number}`,
        adminOnly: true,
        link,
      })
      if (d.approvedAt)
        push({
          id: `borrador:${d.id}:aprobada`,
          at: d.approvedAt,
          who: byUser(d.approvedBy),
          category: "cuenta",
          title: `Se aprobó ${what} ${d.number}`,
          adminOnly: true,
          link,
        })
      if (d.status === "devuelta")
        push({
          id: `borrador:${d.id}:devuelta`,
          at: d.updatedAt,
          who: { kind: "persona", name: "Administración" },
          category: "cuenta",
          title: `Se devolvió ${what} ${d.number}`,
          detail: clip(d.returnedNote),
          adminOnly: true,
          link,
        })
    }
  }

  if (wants("contactos")) {
    // Correos que llegaron y no dejaron su actividad (la actividad de un correo que entró lleva su misma hora).
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
        category: "contactos",
        title: `Nos escribió a ${e.mailbox}@`,
        detail:
          [clip(e.subject, 140), files ? `${files} ${files === 1 ? "adjunto" : "adjuntos"}` : null]
            .filter(Boolean)
            .join(" · ") || undefined,
        adminOnly: false,
        link: { kind: "correo", id: e.id },
      })
    }
  }

  {
    // Documentos (los adjuntos de un correo ya los cuenta el correo).
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
      const category: TimelineCategory =
        f.kind === "propuesta" || f.kind === "presentacion" ? "venta" : "cuenta"
      const who: Pending["who"] =
        f.source === "kairos"
          ? { kind: "kairos", name: "Kairós" }
          : f.source === "skill"
            ? byUser(f.createdBy, { kind: "sistema", name: "Skill de la carga" })
            : byUser(f.createdBy)
      const link = { kind: "archivo" as const, id: f.id }
      push({
        id: `archivo:${f.id}:subido`,
        at: f.createdAt,
        who,
        category,
        title: `${FILE_TITLES[f.kind] ?? "Documento"}: ${f.filename}`,
        adminOnly: f.adminOnly,
        link,
      })
      if (f.deletedAt)
        push({
          id: `archivo:${f.id}:borrado`,
          at: f.deletedAt,
          who: { kind: "sistema", name: "Sistema" },
          category,
          title: `Se borró ${f.filename}`,
          adminOnly: f.adminOnly,
        })
    }
  }

  const names = await userNames(tx, people)
  for (const entry of pending) {
    const who: TimelineEntry["who"] =
      "userId" in entry.who
        ? entry.who.userId
          ? { kind: "persona", name: names.get(entry.who.userId) ?? "Alguien del equipo" }
          : entry.who.fallback
        : entry.who
    entries.push({ ...entry, who })
  }
  entries.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? -1 : 1))
  // La página no corta entre dos entradas del mismo instante: «Cargar más» pide lo anterior a él.
  let end = Math.min(limit, entries.length)
  const cut = entries[end - 1]
  while (cut && end < entries.length && entries[end]?.at.getTime() === cut.at.getTime()) end += 1
  const items = entries.slice(0, end)
  const last = items[items.length - 1]
  return { items, nextBefore: entries.length > end && last ? last.at : null }
}
