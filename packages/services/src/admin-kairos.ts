import { createHash } from "node:crypto"
import { type ClinicalProduct, isClinicalProduct, productWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  KAIROS_AI_PURPOSES,
  type KairosAiPurpose,
  type KairosItemKind,
  type KairosItemStatus,
  kairosAiUsage,
  kairosItem,
  SAAS_CLIENT_PROFESSIONALS,
  SAAS_CLIENT_TOOLS,
  SAAS_OUTREACH_CHANNELS,
  type SaasOutreachChannel,
  type SaasTaskKind,
  saasClient,
  saasOutreach,
  saasTask,
} from "@odentia/db/schema/admin-arm"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { and, asc, desc, eq, inArray, lte, ne, type SQL, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import {
  clientDuplicatePairsSql,
  linkClientToOrganization,
  proposalReplacedSql,
} from "./admin-clients.js"
import { type AdminActor, isAdminRole, writeAdminAudit } from "./admin-core.js"
import { type OwnerPendingRow, ownersPendingRows } from "./admin-organizations.js"
import { type SupportHomeRow, supportHomeRows } from "./admin-support.js"
import {
  type ClinicLoadRecord,
  listClinicLoads,
  listProgressReports,
  PROGRESS_REPORT_ACTIONS,
  type ProgressReportRecord,
} from "./clinic-progress-report.js"
import { invalidField, notFound, ServiceError } from "./errors.js"
import { limaDate } from "./peru-business-days.js"
import { businessDaysWords, currentSaasTerms } from "./saas-commercial-terms.js"
import {
  type ExpiringTermRow,
  listExpiringTerms,
  type WaitlistHomeRow,
  waitlistHomeRows,
} from "./saas-founders.js"

/**
 * Kairós, el agente de la administración de Sallca (el ARM): registra, sigue,
 * recuerda, prepara y avisa; la persona decide. Aquí vive lo que no necesita
 * modelo: las reglas de cada pasada (`kairosRulesPass`), lo que espera un sí
 * (`kairos_item`: listar, aprobar o descartar), «Lo que hizo» y Hoy. El modelo
 * (redactar, resumir, ordenar lo anotado) vive en `packages/agent`.
 *
 * Kairós nunca envía ni decide solo: sus reglas solo ponen tareas, marcan
 * señales y dejan ítems en espera, y todo queda en `admin_audit` con actor
 * nulo y una acción `kairos.*`. Aprobar ejecuta la misma operación que la
 * pantalla; las que viven en otros módulos del ARM las pasa la ruta como
 * `KairosExecutors`. Lo que espera un sí congela el estado del cliente al
 * prepararse (`expected_state`) y vence a las 48 h: si algo cambió, queda
 * vencido y la pasada siguiente lo vuelve a preparar.
 */

const DAY = 86_400_000
const HOUR = 3_600_000
/** Lo que espera un sí vence a las 48 h. */
export const KAIROS_ITEM_HOURS = 48
/** Sin contacto en estos días, con la venta abierta, el cliente se enfría. */
export const KAIROS_COOLING_DAYS = 7
/** La propuesta enviada se recuerda cuando le faltan estos días de vigencia. */
const PROPOSAL_SOON_DAYS = 3
/** La propuesta enviada sin respuesta en estos días enfría al cliente. */
const PROPOSAL_WAIT_DAYS = 7
/** Días que se esperan los archivos de la carga después de la carta de bienvenida. */
const LETTER_WAIT_DAYS = 7
/** Una invitación del equipo de la clínica sin aceptar en estos días se recuerda. */
const TEAM_INVITE_DAYS = 3
/** Sin sesiones de nadie de la clínica en estos días: en riesgo. */
const NO_SESSION_DAYS = 7
/** Los mensajes de los últimos 30 días contra los 30 anteriores. */
const MESSAGES_WINDOW_DAYS = 30
/** Caer más de esta parte es riesgo… */
const MESSAGES_DROP = 0.3
/** …si antes había al menos estos mensajes (con menos, la caída no dice nada). */
const MESSAGES_MIN_BEFORE = 20
/** Un caso que espera a la clínica más de estos días es riesgo. */
const CASE_WAITING_DAYS = 3
/** Un comprobante rechazado en estos días, sin un pago confirmado después, es riesgo. */
const PAYMENT_REJECTED_DAYS = 30
/** Cuántos ítems en espera muestra Hoy (el resto, con su total, en la pantalla de Kairós). */
const READY_ON_TODAY = 5
/**
 * Con quién lee Kairós las filas de prospectos de Inicio (`waitlistHomeRows`):
 * la misma regla, sin quitar nada. Solo lee; nunca escribe como este actor.
 */
const KAIROS_READER: AdminActor = { userId: "kairos", role: "admin" }

/** Lo que solo aprueba Administración (precios, ligar personas, fusionar). */
const ADMIN_KINDS: ReadonlySet<KairosItemKind> = new Set<KairosItemKind>([
  "propuesta",
  "vinculo",
  "duplicado",
])
/** Lo que el modelo redacta antes de estar listo. */
const DRAFT_KINDS = ["mensaje", "guion"] as const satisfies readonly KairosItemKind[]
type DraftKind = (typeof DRAFT_KINDS)[number]

const ITEM_KIND_WORDS: Record<KairosItemKind, string> = {
  mensaje: "un mensaje",
  propuesta: "una propuesta",
  guion: "el guion de una presentación",
  dato: "un dato",
  vinculo: "un vínculo",
  duplicado: "un posible duplicado",
  demo: "una demo",
  presentacion_hecha: "la pregunta de una presentación",
  correo_sin_cliente: "un correo sin cliente",
}

const STATUS_WORDS: Record<KairosItemStatus, string> = {
  espera: "en espera",
  ejecutada: "hecho",
  fallida: "fallido",
  incierta: "por confirmar",
  descartada: "descartado",
  vencida: "vencido",
}

/* ---------- Fechas ---------- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** El día civil `day` más `days` días. */
function plusDays(day: string, days: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10)
}

/** «13 de noviembre». */
function dayText(day: string): string {
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
  }).format(new Date(`${day}T00:00:00Z`))
}

/** «10:05», en Lima. */
function timeText(at: Date): string {
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at)
}

/** Un instante leído con SQL a mano, en ISO 8601 (UTC). */
const iso = (expr: SQL) =>
  sql`to_char((${expr}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
const toDate = (value: string | null | undefined): Date | null => (value ? new Date(value) : null)

/** SQL a mano: las filas tal cual. */
async function rows<T extends Record<string, unknown>>(tx: Db, query: SQL): Promise<T[]> {
  return [...(await tx.execute<T>(query))] as T[]
}

function requireStaff(actor: AdminActor): void {
  if (!actor || !isAdminRole(actor.role))
    throw new ServiceError("FORBIDDEN", 403, "Solo el equipo de Sallca")
}

const productOf = (value: string | null | undefined): ClinicalProduct =>
  value && isClinicalProduct(value) ? value : "dental"
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null

/* ---------- Señales: se enfría y en riesgo ---------- */

export const KAIROS_SIGNAL_CODES = [
  "sin_proximo_paso",
  "se_enfria",
  "invitacion_vencida",
  "propuesta_sin_respuesta",
  "comprobante_rechazado",
  "sin_sesiones",
  "mensajes_caen",
  "caso_esperando",
] as const
export type KairosSignalCode = (typeof KAIROS_SIGNAL_CODES)[number]

/** Una señal de Kairós con su hecho en palabras. `adminOnly`: Soporte no la ve (dinero, propuestas). */
export interface KairosSignal {
  code: KairosSignalCode
  words: string
  adminOnly: boolean
  /** El hecho que la produce (una clave estable: un pago, un caso, un día). */
  fact: string
}

export interface KairosClientRef {
  clientId: string
  name: string
  product: ClinicalProduct
  owner: { userId: string; name: string } | null
}

/** Un cliente que se enfría: la venta abierta y algo que dice que se está perdiendo. */
export interface KairosCoolingRow extends KairosClientRef {
  opportunityId: string
  lastContactAt: Date | null
  signals: KairosSignal[]
  /** Por qué sale: sus señales, en una línea. */
  why: string
}

/** Un cliente con cuenta en riesgo: cada señal con su hecho. */
export interface KairosRiskRow extends KairosClientRef {
  organizationId: string
  signals: KairosSignal[]
  why: string
}

const ownerOf = (id: string | null, name: string | null) =>
  id ? { userId: id, name: name ?? "Sin nombre" } : null
const visibleSignals = (signals: KairosSignal[], actor: AdminActor) =>
  actor.role === "admin" ? signals : signals.filter((signal) => !signal.adminOnly)

/** Para leer las señales de unos clientes (la lista, la ficha, el embudo) con la misma regla. */
export interface KairosSignalScope {
  clientIds?: readonly string[]
  organizationId?: string
}

/** El filtro de `KairosSignalScope` sobre `c` (saas_client); null si no queda nadie que leer. */
function scopeSql(scope: KairosSignalScope | undefined): SQL | null {
  const parts: SQL[] = []
  if (scope?.clientIds) {
    const ids = scope.clientIds.filter((id) => UUID.test(id))
    if (ids.length === 0) return null
    parts.push(
      sql`and c.id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    )
  }
  if (scope?.organizationId) parts.push(sql`and c.organization_id = ${scope.organizationId}`)
  return sql.join(parts, sql` `)
}

/**
 * Los clientes con la venta abierta que se enfrían: sin contacto en 7 días,
 * la invitación vencida sin que nadie la llame, la propuesta enviada sin
 * respuesta o sin próximo paso. La regla de «Se enfrían» en Hoy y de la pasada
 * de Kairós: una sola. Soporte no recibe la de la propuesta.
 */
export async function kairosCoolingRows(
  tx: Db,
  actor: AdminActor,
  now = new Date(),
  scope?: KairosSignalScope,
): Promise<KairosCoolingRow[]> {
  const only = scopeSql(scope)
  if (!only) return []
  const nowSql = sql`${now.toISOString()}::timestamptz`
  const proposalSince = sql`${new Date(now.getTime() - PROPOSAL_WAIT_DAYS * DAY).toISOString()}::timestamptz`
  const today = limaDate(now)
  const found = await rows<{
    id: string
    name: string
    product: string
    owner_id: string | null
    owner_name: string | null
    opportunity_id: string
    created_at: string
    last_at: string | null
    has_task: boolean
    invite_expired_at: string | null
    proposal_sent_at: string | null
  }>(
    tx,
    sql`select c.id, c.name, c.product, c.owner_user_id as owner_id, u.name as owner_name, o.id as opportunity_id,
      ${iso(sql`c.created_at`)} as created_at,
      ${iso(sql`(select max(f.happened_at) from saas_follow_up f where f.client_id = c.id and not f.from_note)`)} as last_at,
      exists (select 1 from saas_task t where t.client_id = c.id and t.status = 'abierta') as has_task,
      ${iso(sql`(select max(r.invite_expires_at) from saas_waitlist_request r
        where r.client_id = c.id and r.status = 'invitada' and r.invite_expires_at <= ${nowSql}
          and not exists (select 1 from saas_follow_up f where f.client_id = c.id and f.kind = 'llamada' and f.happened_at >= r.invite_expires_at))`)} as invite_expired_at,
      ${iso(sql`(select max(p.sent_at) from saas_proposal p
        where p.client_id = c.id and p.status = 'enviada' and p.sent_at <= ${proposalSince} and p.valid_until >= ${today}::date
          and not ${proposalReplacedSql()})`)} as proposal_sent_at
    from saas_client c
    join saas_opportunity o on o.client_id = c.id and o.decision is null
    left join "user" u on u.id = c.owner_user_id
    where c.archived_at is null ${only}`,
  )
  const out: KairosCoolingRow[] = []
  for (const row of found) {
    const lastAt = toDate(row.last_at)
    const signals: KairosSignal[] = []
    if (
      (lastAt ?? new Date(row.created_at)).getTime() <
      now.getTime() - KAIROS_COOLING_DAYS * DAY
    ) {
      const from = lastAt ?? new Date(row.created_at)
      const days = Math.floor((now.getTime() - from.getTime()) / DAY)
      signals.push({
        code: "se_enfria",
        words: lastAt
          ? `${days} días sin contacto`
          : `Nadie la contactó desde que llegó, hace ${days} días`,
        adminOnly: false,
        fact: `${row.opportunity_id}:${lastAt ? limaDate(lastAt) : "nunca"}`,
      })
    }
    if (row.invite_expired_at) {
      const at = new Date(row.invite_expired_at)
      signals.push({
        code: "invitacion_vencida",
        words: `La invitación venció el ${dayText(limaDate(at))} y nadie la llamó`,
        adminOnly: false,
        fact: limaDate(at),
      })
    }
    if (row.proposal_sent_at) {
      signals.push({
        code: "propuesta_sin_respuesta",
        words: `La propuesta salió el ${dayText(limaDate(new Date(row.proposal_sent_at)))} y no hay respuesta`,
        adminOnly: true,
        fact: limaDate(new Date(row.proposal_sent_at)),
      })
    }
    if (!row.has_task)
      signals.push({
        code: "sin_proximo_paso",
        words: "No tiene próximo paso",
        adminOnly: false,
        fact: row.opportunity_id,
      })
    const shown = visibleSignals(signals, actor)
    if (shown.length === 0) continue
    out.push({
      clientId: row.id,
      name: row.name,
      product: productOf(row.product),
      owner: ownerOf(row.owner_id, row.owner_name),
      opportunityId: row.opportunity_id,
      lastContactAt: lastAt,
      signals: shown,
      why: shown.map((signal) => signal.words).join(" · "),
    })
  }
  return out.sort(
    (a, b) =>
      b.signals.length - a.signals.length ||
      (a.lastContactAt?.getTime() ?? 0) - (b.lastContactAt?.getTime() ?? 0),
  )
}

/**
 * Los clientes con cuenta en riesgo: comprobante rechazado (sin un pago
 * confirmado después), nadie entra en 7 días, los mensajes de 30 días caen
 * más de 30 % o un caso espera a la clínica más de 3 días. La regla de «En
 * riesgo» en Hoy y de la pasada: una sola. Soporte no recibe la del
 * comprobante ni la de un caso de cobro.
 */
export async function kairosRiskRows(
  tx: Db,
  actor: AdminActor,
  now = new Date(),
  scope?: KairosSignalScope,
): Promise<KairosRiskRow[]> {
  const only = scopeSql(scope)
  if (!only) return []
  const ago = (days: number) =>
    sql`${new Date(now.getTime() - days * DAY).toISOString()}::timestamptz`
  const found = await rows<{
    id: string
    name: string
    product: string
    organization_id: string
    owner_id: string | null
    owner_name: string | null
    org_created_at: string | null
    last_session_at: string | null
    messages_now: number
    messages_before: number
    payment_id: string | null
    payment_rejected_at: string | null
    case_id: string | null
    case_kind: string | null
    case_since: string | null
  }>(
    tx,
    sql`select c.id, c.name, c.product, c.organization_id, c.owner_user_id as owner_id, u.name as owner_name,
      ${iso(sql`org.created_at`)} as org_created_at,
      ${iso(sql`(select max(s.updated_at) from "session" s join member m on m.user_id = s.user_id where m.organization_id = c.organization_id)`)} as last_session_at,
      (select count(*)::int from message m where m.organization_id = c.organization_id and m.created_at > ${ago(MESSAGES_WINDOW_DAYS)}) as messages_now,
      (select count(*)::int from message m where m.organization_id = c.organization_id
        and m.created_at > ${ago(2 * MESSAGES_WINDOW_DAYS)} and m.created_at <= ${ago(MESSAGES_WINDOW_DAYS)}) as messages_before,
      pay.id as payment_id, ${iso(sql`pay.rejected_at`)} as payment_rejected_at,
      sc.id as case_id, sc.kind as case_kind, ${iso(sql`sc.since`)} as case_since
    from saas_client c
    join organization org on org.id = c.organization_id
    left join "user" u on u.id = c.owner_user_id
    left join lateral (
      select p.id, p.rejected_at from saas_payment p
      where p.organization_id = c.organization_id and p.status = 'rechazado' and p.rejected_at >= ${ago(PAYMENT_REJECTED_DAYS)}
        and not exists (select 1 from saas_payment q where q.organization_id = p.organization_id and q.status = 'confirmado' and q.confirmed_at > p.rejected_at)
      order by p.rejected_at desc limit 1
    ) pay on true
    left join lateral (
      select s.id, s.kind, coalesce(s.last_public_message_at, s.updated_at) as since from support_case s
      where s.organization_id = c.organization_id and s.status = 'esperando_clinica'
        and coalesce(s.last_public_message_at, s.updated_at) < ${ago(CASE_WAITING_DAYS)}
      order by (s.kind = 'cobro'), coalesce(s.last_public_message_at, s.updated_at) asc limit 1
    ) sc on true
    where c.archived_at is null ${only}`,
  )
  const out: KairosRiskRow[] = []
  for (const row of found) {
    const signals: KairosSignal[] = []
    if (row.payment_id && row.payment_rejected_at) {
      signals.push({
        code: "comprobante_rechazado",
        words: `Se rechazó su comprobante el ${dayText(limaDate(new Date(row.payment_rejected_at)))}`,
        adminOnly: true,
        fact: row.payment_id,
      })
    }
    const lastSession = toDate(row.last_session_at)
    const orgCreated = toDate(row.org_created_at)
    const quietSince = now.getTime() - NO_SESSION_DAYS * DAY
    if (
      (orgCreated?.getTime() ?? 0) < quietSince &&
      (!lastSession || lastSession.getTime() < quietSince)
    ) {
      signals.push({
        code: "sin_sesiones",
        words: lastSession
          ? `Nadie de la clínica entra desde el ${dayText(limaDate(lastSession))}`
          : "Nadie de la clínica entró todavía",
        adminOnly: false,
        fact: lastSession ? limaDate(lastSession) : "nunca",
      })
    }
    if (
      row.messages_before >= MESSAGES_MIN_BEFORE &&
      row.messages_now < row.messages_before * (1 - MESSAGES_DROP)
    ) {
      const drop = Math.round((1 - row.messages_now / row.messages_before) * 100)
      signals.push({
        code: "mensajes_caen",
        words: `Sus mensajes bajaron ${drop} % en 30 días`,
        adminOnly: false,
        fact: limaDate(now).slice(0, 7),
      })
    }
    if (row.case_id && row.case_since) {
      const since = limaDate(new Date(row.case_since))
      signals.push({
        code: "caso_esperando",
        words: `Un caso de soporte espera a la clínica desde el ${dayText(since)}`,
        // Soporte nunca ve los casos de cobro (`visibleKindsFor`).
        adminOnly: row.case_kind === "cobro",
        fact: `${row.case_id}:${since}`,
      })
    }
    const shown = visibleSignals(signals, actor)
    if (shown.length === 0) continue
    out.push({
      clientId: row.id,
      name: row.name,
      product: productOf(row.product),
      organizationId: row.organization_id,
      owner: ownerOf(row.owner_id, row.owner_name),
      signals: shown,
      why: shown.map((signal) => signal.words).join(" · "),
    })
  }
  return out.sort(
    (a, b) => b.signals.length - a.signals.length || a.name.localeCompare(b.name, "es"),
  )
}

/* ---------- El estado congelado ---------- */

/**
 * Lo que tiene que seguir igual para que lo preparado valga: lo lee igual al
 * prepararlo y al aprobarlo (una sola función, así no se desfasan). Un
 * mensaje vale mientras no haya un contacto posterior; lo demás, mientras su
 * solicitud, propuesta, tarea, correo, oportunidad, invitaciones o
 * datos sigan como estaban.
 */
async function captureState(
  tx: Db,
  kind: KairosItemKind,
  clientId: string | null,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const state: Record<string, unknown> = {}
  if (clientId && kind === "mensaje") {
    const [row] = await rows<{ at: string | null }>(
      tx,
      sql`select ${iso(sql`max(happened_at)`)} as at from saas_follow_up where client_id = ${clientId}::uuid and not from_note`,
    )
    state.lastActivityAt = row?.at ?? null
  }
  const requestId = str(payload.requestId)
  if (requestId) {
    const [row] = await rows<{ status: string; expires: string | null }>(
      tx,
      sql`select status, ${iso(sql`invite_expires_at`)} as expires from saas_waitlist_request where id = ${requestId}::uuid`,
    )
    state.request = row ? { status: row.status, inviteExpiresAt: row.expires } : null
  }
  const proposalId = str(payload.proposalId)
  if (proposalId) {
    const [row] = await rows<{ status: string }>(
      tx,
      sql`select status from saas_proposal where id = ${proposalId}::uuid`,
    )
    state.proposal = row?.status ?? null
  }
  const taskId = str(payload.taskId)
  if (taskId) {
    const [row] = await rows<{ status: string; due_on: string; due_at: string | null }>(
      tx,
      sql`select status, due_on::text as due_on, ${iso(sql`due_at`)} as due_at from saas_task where id = ${taskId}::uuid`,
    )
    state.task = row ? { status: row.status, dueOn: row.due_on, dueAt: row.due_at } : null
  }
  const emailId = str(payload.emailId)
  if (emailId) {
    const [row] = await rows<{ client_id: string | null }>(
      tx,
      sql`select client_id from saas_inbound_email where id = ${emailId}::uuid`,
    )
    state.email = row ? { clientId: row.client_id } : null
  }
  const opportunityId = str(payload.opportunityId)
  if (opportunityId) {
    const [row] = await rows<{ decision: string | null; return_on: string | null }>(
      tx,
      sql`select decision, return_on::text as return_on from saas_opportunity where id = ${opportunityId}::uuid`,
    )
    state.opportunity = row ? { decision: row.decision, returnOn: row.return_on } : null
  }
  const invitationIds = Array.isArray(payload.invitationIds)
    ? payload.invitationIds.filter((id): id is string => typeof id === "string")
    : []
  if (invitationIds.length > 0) {
    const [row] = await rows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from invitation where status = 'pending' and id in (${sql.join(
        invitationIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
    state.invitationsPending = row?.n ?? 0
  }
  const keepId = str(payload.keepId)
  const dropId = str(payload.dropId)
  if (keepId && dropId) {
    const found = await rows<{ id: string; archived: boolean }>(
      tx,
      sql`select id, archived_at is not null as archived from saas_client where id in (${keepId}::uuid, ${dropId}::uuid) order by id`,
    )
    state.clients = found.map((row) => `${row.id}:${row.archived}`)
  }
  if (kind === "dato" && clientId && payload.fields && typeof payload.fields === "object") {
    const [row] = await rows<{
      city: string | null
      professionals: string | null
      current_tool: string | null
    }>(
      tx,
      sql`select city, professionals, current_tool from saas_client where id = ${clientId}::uuid`,
    )
    state.data = row ?? null
  }
  const contactId = str(payload.contactId)
  if (kind === "vinculo" && contactId) {
    const [row] = await rows<{ user_id: string | null }>(
      tx,
      sql`select user_id from saas_client_contact where id = ${contactId}::uuid`,
    )
    state.contactUser = row ? row.user_id : "sin_contacto"
  }
  return state
}

/** JSON con las claves ordenadas: `jsonb` guarda las claves en otro orden. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

/* ---------- Lo que espera un sí ---------- */

/**
 * Vence lo que esperó 48 h. Su clave queda libre (`vencida:<id>:…`): si
 * todavía hace falta, la pasada siguiente lo vuelve a preparar. Perezoso:
 * corre antes de listar, de decidir y en cada pasada.
 */
export async function expireKairosItems(tx: Db, now = new Date()): Promise<number> {
  const done = await tx
    .update(kairosItem)
    .set({
      status: "vencida",
      idempotencyKey: sql`'vencida:' || ${kairosItem.id}::text || ':' || ${kairosItem.idempotencyKey}`,
      updatedAt: now,
    })
    .where(and(eq(kairosItem.status, "espera"), lte(kairosItem.expiresAt, now)))
    .returning({ id: kairosItem.id })
  return done.length
}

async function markStale(tx: Db, id: string, now: Date, error: string): Promise<void> {
  await tx
    .update(kairosItem)
    .set({
      status: "vencida",
      error,
      idempotencyKey: sql`'vencida:' || ${kairosItem.id}::text || ':' || ${kairosItem.idempotencyKey}`,
      updatedAt: now,
    })
    .where(eq(kairosItem.id, id))
}

/**
 * Quién redactó un mensaje o un guion de Kairós: el modelo, o las plantillas
 * deterministas cuando el modelo no está configurado (sin la clave del
 * proveedor, o `LLM_MODEL=fake`). La pantalla lo dice con `KAIROS_TEMPLATE_NOTE`.
 */
export type KairosDrafter = "modelo" | "plantilla"

/** Lo que dice un borrador hecho sin modelo, para que nadie lo tome por uno del modelo. */
export const KAIROS_TEMPLATE_NOTE = "Borrador hecho con plantilla: el modelo no está configurado"

export interface KairosItemView {
  id: string
  clientId: string | null
  clientName: string | null
  product: ClinicalProduct | null
  kind: KairosItemKind
  title: string
  /** Por qué lo preparó, con qué datos. */
  reason: string
  status: KairosItemStatus
  payload: Record<string, unknown>
  /** Un mensaje o un guion están listos cuando el modelo los redactó; lo demás, siempre. */
  ready: boolean
  /** Quién redactó el mensaje o el guion; null si no es un borrador o aún no tiene. */
  drafter: KairosDrafter | null
  /** `KAIROS_TEMPLATE_NOTE` si lo redactó una plantilla; null si no. */
  draftNote: string | null
  adminOnly: boolean
  expiresAt: Date
  createdAt: Date
  decidedAt: Date | null
  decidedByName: string | null
  result: Record<string, unknown> | null
  error: string | null
}

const decider = alias(user, "kairos_decider")
type ItemRow = typeof kairosItem.$inferSelect

const isReady = (kind: string, payload: Record<string, unknown>) =>
  !(DRAFT_KINDS as readonly string[]).includes(kind) ||
  Boolean(payload.draft && typeof payload.draft === "object")

/** Quién redactó el borrador del ítem; los anteriores a esta marca son del modelo. */
function draftAuthorOf(
  kind: string,
  payload: Record<string, unknown>,
): { drafter: KairosDrafter | null; draftNote: string | null } {
  if (!(DRAFT_KINDS as readonly string[]).includes(kind)) return { drafter: null, draftNote: null }
  const draft = payload.draft
  if (!draft || typeof draft !== "object") return { drafter: null, draftNote: null }
  const drafter: KairosDrafter =
    (draft as { drafter?: unknown }).drafter === "plantilla" ? "plantilla" : "modelo"
  return { drafter, draftNote: drafter === "plantilla" ? KAIROS_TEMPLATE_NOTE : null }
}

function toItemView(row: {
  item: ItemRow
  clientName: string | null
  product: string | null
  decidedByName: string | null
}): KairosItemView {
  const { item } = row
  return {
    id: item.id,
    clientId: item.clientId,
    clientName: row.clientName,
    product: row.product && isClinicalProduct(row.product) ? row.product : null,
    kind: item.kind as KairosItemKind,
    title: item.title,
    reason: item.reason,
    status: item.status as KairosItemStatus,
    payload: item.payload,
    ready: isReady(item.kind, item.payload),
    ...draftAuthorOf(item.kind, item.payload),
    adminOnly: item.adminOnly,
    expiresAt: item.expiresAt,
    createdAt: item.createdAt,
    decidedAt: item.decidedAt,
    decidedByName: row.decidedByName,
    result: item.result ?? null,
    error: item.error,
  }
}

export interface KairosItemFilter {
  /** «espera»: lo que espera un sí; «hecho»: lo ya decidido, vencido o ejecutado. */
  status: "espera" | "hecho"
  clientId?: string
  limit?: number
}

/**
 * Lo que preparó Kairós: lo que espera un sí (lo que vence antes arriba) o lo
 * ya decidido (lo último arriba). Soporte no ve lo que es solo de
 * administración. Vence antes lo que esperó 48 h.
 */
export async function listKairosItems(
  tx: Db,
  actor: AdminActor,
  filter: KairosItemFilter,
  now = new Date(),
): Promise<{ items: KairosItemView[]; total: number }> {
  requireStaff(actor)
  if (filter.status !== "espera" && filter.status !== "hecho")
    throw invalidField("status", "Elige «espera» o «hecho»")
  if (filter.clientId !== undefined && !UUID.test(filter.clientId))
    throw invalidField("clientId", "El cliente no es válido")
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), 100)
  await expireKairosItems(tx, now)
  const where = and(
    filter.status === "espera" ? eq(kairosItem.status, "espera") : ne(kairosItem.status, "espera"),
    filter.clientId ? eq(kairosItem.clientId, filter.clientId) : undefined,
    actor.role === "admin" ? undefined : eq(kairosItem.adminOnly, false),
  )
  const found = await tx
    .select({
      item: kairosItem,
      clientName: saasClient.name,
      product: saasClient.product,
      decidedByName: decider.name,
    })
    .from(kairosItem)
    .leftJoin(saasClient, eq(saasClient.id, kairosItem.clientId))
    .leftJoin(decider, eq(decider.id, kairosItem.decidedBy))
    .where(where)
    .orderBy(
      ...(filter.status === "espera"
        ? [asc(kairosItem.expiresAt), asc(kairosItem.id)]
        : [
            desc(sql`coalesce(${kairosItem.decidedAt}, ${kairosItem.updatedAt})`),
            desc(kairosItem.id),
          ]),
    )
    .limit(limit)
  const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(kairosItem).where(where)
  return { items: found.map(toItemView), total: count?.n ?? 0 }
}

/* ---------- Aprobar o descartar ---------- */

/** Un envío preparado por la operación de los envíos (`prepareOutreach`): la ruta lo envía después del commit. */
export interface KairosOutreachPrepared {
  id: string
}

export interface KairosOutreachInput {
  channel: SaasOutreachChannel
  contactId?: string
  to?: string
  subject?: string
  body: string
  proposalId?: string
  kairosItemId?: string
}

export interface KairosClientPatch {
  city?: string
  professionals?: (typeof SAAS_CLIENT_PROFESSIONALS)[number]
  currentTool?: (typeof SAAS_CLIENT_TOOLS)[number]
}

export interface KairosPresentationInput {
  outcome: "se_hizo" | "no_se_conecto" | "reprogramar"
  body: string
  nextDueOn?: string
}

export interface KairosProposalInput {
  planId: string
  discountBps: number
  discountMonths?: number
  trialDays?: number
  trialCreditCents?: number
  billingCycle: "mensual" | "quincenal"
  validUntil: string
}

/**
 * Las operaciones de la pantalla que ejecuta un sí. Viven en los otros
 * módulos del ARM (envíos y presentaciones en `admin-sales.ts`, datos y
 * contactos en `admin-clients.ts`, correos en `admin-inbound-email.ts`) y
 * las pasa la ruta: aprobar lo
 * de Kairós es la misma operación que hace la persona, con sus reglas y su
 * auditoría, nunca una copia.
 */
export interface KairosExecutors<O extends KairosOutreachPrepared = KairosOutreachPrepared> {
  prepareOutreach(
    tx: Db,
    actor: AdminActor,
    clientId: string,
    input: KairosOutreachInput,
  ): Promise<O>
  updateClient(
    tx: Db,
    actor: AdminActor,
    clientId: string,
    patch: KairosClientPatch,
  ): Promise<unknown>
  linkContactToUser(tx: Db, actor: AdminActor, contactId: string, userId: string): Promise<unknown>
  assignInboundEmail(tx: Db, actor: AdminActor, emailId: string, clientId: string): Promise<unknown>
  recordPresentation(
    tx: Db,
    actor: AdminActor,
    taskId: string,
    input: KairosPresentationInput,
  ): Promise<unknown>
  createProposal(
    tx: Db,
    actor: AdminActor,
    clientId: string,
    input: KairosProposalInput,
  ): Promise<{ id: string }>
}

export interface KairosDecideInput {
  action: "aprobar" | "descartar"
  /** Lo que la persona cambió antes de aprobar («Cambiar»); solo lo que ese tipo deja cambiar. */
  edited?: Record<string, unknown>
}

export interface KairosDecision<O extends KairosOutreachPrepared = KairosOutreachPrepared> {
  id: string
  kind: KairosItemKind
  status: KairosItemStatus
  result: Record<string, unknown> | null
  error: string | null
  /** Un mensaje aprobado: el envío que la ruta manda después del commit (correo) o abre por enlace (WhatsApp). */
  outreach?: O
}

/** Lo que cada tipo deja cambiar antes de aprobar. */
const EDITABLE: Record<KairosItemKind, readonly string[]> = {
  mensaje: ["channel", "contactId", "to", "subject", "body"],
  propuesta: [
    "planId",
    "discountBps",
    "discountMonths",
    "trialDays",
    "trialCreditCents",
    "billingCycle",
    "validUntil",
  ],
  guion: [],
  dato: ["fields"],
  vinculo: [],
  duplicado: [],
  demo: [],
  presentacion_hecha: ["outcome", "body", "nextDueOn"],
  correo_sin_cliente: ["clientId"],
}

function cleanEdits(kind: KairosItemKind, edited: unknown): Record<string, unknown> {
  if (edited === undefined || edited === null) return {}
  if (typeof edited !== "object" || Array.isArray(edited))
    throw invalidField("edited", "Lo cambiado no es válido")
  const allowed = EDITABLE[kind]
  for (const key of Object.keys(edited)) {
    if (!allowed.includes(key)) throw invalidField(`edited.${key}`, "Eso no se cambia aquí")
  }
  return edited as Record<string, unknown>
}

const optText = (value: unknown): string | undefined => str(value)?.trim() ?? undefined
const optInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined

type Executed<O> = { status: KairosItemStatus; result: Record<string, unknown>; outreach?: O }

async function executeItem<O extends KairosOutreachPrepared>(
  tx: Db,
  actor: AdminActor,
  item: ItemRow,
  payload: Record<string, unknown>,
  executors: KairosExecutors<O>,
): Promise<Executed<O>> {
  const kind = item.kind as KairosItemKind
  const clientId = item.clientId
  const needClient = (): string => {
    if (!clientId)
      throw new ServiceError("KAIROS_ITEM_WITHOUT_CLIENT", 409, "Esto ya no tiene cliente")
    return clientId
  }
  switch (kind) {
    case "mensaje": {
      const channel = str(payload.channel)
      if (!channel || !(SAAS_OUTREACH_CHANNELS as readonly string[]).includes(channel)) {
        throw invalidField("edited.channel", "Elige correo o WhatsApp")
      }
      const body = optText(payload.body)
      if (!body) throw invalidField("edited.body", "Escribe el mensaje")
      const outreach = await executors.prepareOutreach(tx, actor, needClient(), {
        channel: channel as SaasOutreachChannel,
        contactId: optText(payload.contactId),
        to: optText(payload.to),
        subject: optText(payload.subject),
        body,
        proposalId: optText(payload.proposalId),
        kairosItemId: item.id,
      })
      // Hasta saber si salió: el correo lo envía la ruta después del commit y el
      // WhatsApp lo confirma la persona («Salió»); nunca se reintenta solo.
      return { status: "incierta", result: { outreachId: outreach.id, channel }, outreach }
    }
    case "dato": {
      const id = needClient()
      const fields =
        payload.fields && typeof payload.fields === "object"
          ? (payload.fields as Record<string, unknown>)
          : {}
      const [current] = await rows<{
        city: string | null
        professionals: string | null
        current_tool: string | null
      }>(tx, sql`select city, professionals, current_tool from saas_client where id = ${id}::uuid`)
      if (!current) throw notFound("Cliente")
      // Kairós solo completa lo vacío: nunca pisa lo que escribió una persona.
      const patch: KairosClientPatch = {}
      const city = optText(fields.city)
      if (city && !current.city) patch.city = city
      const professionals = SAAS_CLIENT_PROFESSIONALS.find(
        (value) => value === fields.professionals,
      )
      if (professionals && !current.professionals) patch.professionals = professionals
      const tool = SAAS_CLIENT_TOOLS.find((value) => value === fields.currentTool)
      if (tool && !current.current_tool) patch.currentTool = tool
      if (Object.keys(patch).length === 0)
        throw new ServiceError("KAIROS_DATA_FILLED", 409, "Esos datos ya están completos")
      await executors.updateClient(tx, actor, id, patch)
      return { status: "ejecutada", result: { fields: Object.keys(patch) } }
    }
    case "vinculo": {
      const contactId = optText(payload.contactId)
      const userId = optText(payload.userId)
      const emailId = optText(payload.emailId)
      if (contactId && userId) {
        await executors.linkContactToUser(tx, actor, contactId, userId)
        return { status: "ejecutada", result: { contactId, userId } }
      }
      if (emailId) {
        const target = optText(payload.clientId) ?? needClient()
        await executors.assignInboundEmail(tx, actor, emailId, target)
        return { status: "ejecutada", result: { emailId, clientId: target } }
      }
      throw new ServiceError("KAIROS_ITEM_INCOMPLETE", 409, "Falta a quién ligar")
    }
    case "correo_sin_cliente": {
      const emailId = optText(payload.emailId)
      if (!emailId) throw new ServiceError("KAIROS_ITEM_INCOMPLETE", 409, "Falta el correo")
      const target = optText(payload.clientId)
      if (!target || !UUID.test(target))
        throw invalidField("edited.clientId", "Elige el cliente de este correo")
      await executors.assignInboundEmail(tx, actor, emailId, target)
      return { status: "ejecutada", result: { emailId, clientId: target } }
    }
    case "duplicado":
      // Fusionar es de una persona: el sí solo abre la fusión con los dos.
      return {
        status: "ejecutada",
        result: { open: "fusion", keepId: str(payload.keepId), dropId: str(payload.dropId) },
      }
    case "presentacion_hecha": {
      const taskId = optText(payload.taskId)
      if (!taskId) throw new ServiceError("KAIROS_ITEM_INCOMPLETE", 409, "Falta la presentación")
      const outcome = str(payload.outcome) ?? "se_hizo"
      if (outcome !== "se_hizo" && outcome !== "no_se_conecto" && outcome !== "reprogramar") {
        throw invalidField(
          "edited.outcome",
          "Elige si se hizo, no se conectó o hay que reprogramar",
        )
      }
      const body = optText(payload.body)
      if (!body) throw invalidField("edited.body", "Escribe qué pasó en la presentación")
      const nextDueOn = optText(payload.nextDueOn)
      if (nextDueOn && !ISO_DAY.test(nextDueOn))
        throw invalidField("edited.nextDueOn", "La fecha no es válida")
      await executors.recordPresentation(tx, actor, taskId, {
        outcome,
        body,
        ...(nextDueOn ? { nextDueOn } : {}),
      })
      return { status: "ejecutada", result: { taskId, outcome } }
    }
    case "propuesta": {
      const planId = optText(payload.planId)
      if (!planId) throw invalidField("edited.planId", "Elige el plan")
      const validUntil = optText(payload.validUntil)
      if (!validUntil || !ISO_DAY.test(validUntil))
        throw invalidField("edited.validUntil", "Pon hasta cuándo vale")
      const billingCycle = str(payload.billingCycle) ?? "mensual"
      if (billingCycle !== "mensual" && billingCycle !== "quincenal")
        throw invalidField("edited.billingCycle", "Elige mensual o quincenal")
      const proposal = await executors.createProposal(tx, actor, needClient(), {
        planId,
        discountBps: optInt(payload.discountBps) ?? 0,
        discountMonths: optInt(payload.discountMonths),
        trialDays: optInt(payload.trialDays),
        trialCreditCents: optInt(payload.trialCreditCents),
        billingCycle,
        validUntil,
      })
      return { status: "ejecutada", result: { proposalId: proposal.id } }
    }
    case "demo":
      // Kairós no crea demos: el sí lleva a Demos con la receta que propone.
      return {
        status: "ejecutada",
        result: { open: "demos", product: str(payload.product), demoKind: str(payload.demoKind) },
      }
    case "guion":
      // El guion se lee; aprobarlo es «listo», no ejecuta nada.
      return { status: "ejecutada", result: { taskId: str(payload.taskId) } }
  }
}

/**
 * Aprobar o descartar lo que preparó Kairós, con el ítem bloqueado (`for
 * update`): dos personas no lo deciden dos veces. Lo vencido (48 h) o lo que
 * ya no vale porque el cliente cambió (`expected_state`) queda `vencida` y no
 * se ejecuta: Kairós lo vuelve a preparar en la próxima pasada. Aprobar
 * ejecuta la operación de la pantalla (`executors`) en un punto de guardado:
 * si esa operación dice que ya no se puede (409 o 404), el ítem queda
 * `fallida` con su motivo; un dato mal puesto (400) vuelve a la persona sin
 * tocar el ítem. Un mensaje aprobado queda `incierta` hasta saber si salió
 * (`settleKairosOutreach`).
 */
export async function decideKairosItem<O extends KairosOutreachPrepared = KairosOutreachPrepared>(
  tx: Db,
  actor: AdminActor,
  id: string,
  input: KairosDecideInput,
  executors: KairosExecutors<O>,
  now = new Date(),
): Promise<KairosDecision<O>> {
  requireStaff(actor)
  if (!UUID.test(id)) throw notFound("Lo que preparó Kairós")
  if (input.action !== "aprobar" && input.action !== "descartar")
    throw invalidField("action", "Elige aprobar o descartar")
  const [item] = await tx.select().from(kairosItem).where(eq(kairosItem.id, id)).for("update")
  if (!item || (item.adminOnly && actor.role !== "admin")) throw notFound("Lo que preparó Kairós")
  const kind = item.kind as KairosItemKind
  if (item.status !== "espera") {
    throw new ServiceError(
      "KAIROS_ITEM_DECIDED",
      409,
      `Esto ya está ${STATUS_WORDS[item.status as KairosItemStatus] ?? "decidido"}`,
    )
  }
  const decision = (
    status: KairosItemStatus,
    result: Record<string, unknown> | null,
    error: string | null,
  ): KairosDecision<O> => ({
    id: item.id,
    kind,
    status,
    result,
    error,
  })
  if (item.expiresAt <= now) {
    const error = "Venció a las 48 h: si todavía hace falta, Kairós lo vuelve a preparar"
    await markStale(tx, item.id, now, error)
    return decision("vencida", null, error)
  }
  if (input.action === "descartar") {
    await tx
      .update(kairosItem)
      .set({ status: "descartada", decidedBy: actor.userId, decidedAt: now, updatedAt: now })
      .where(eq(kairosItem.id, item.id))
    await writeAdminAudit(tx, actor, {
      action: "arm.kairos_item_discarded",
      entityId: item.id,
      metadata: { kind },
    })
    return decision("descartada", null, null)
  }
  if (ADMIN_KINDS.has(kind) && actor.role !== "admin")
    throw new ServiceError("FORBIDDEN", 403, "Esto lo aprueba Administración")
  const edits = cleanEdits(kind, input.edited)
  const current = await captureState(tx, kind, item.clientId, item.payload)
  if (stable(item.expectedState ?? {}) !== stable(current)) {
    const error =
      "El cliente cambió desde que Kairós lo preparó: lo vuelve a preparar en la próxima pasada"
    await markStale(tx, item.id, now, error)
    return decision("vencida", null, error)
  }
  const payload = { ...item.payload, ...edits }
  let executed: Executed<O>
  try {
    executed = await tx.transaction((inner) =>
      executeItem(inner as Db, actor, item, payload, executors),
    )
  } catch (error) {
    if (error instanceof ServiceError && (error.status === 409 || error.status === 404)) {
      await tx
        .update(kairosItem)
        .set({
          status: "fallida",
          error: error.message.slice(0, 500),
          decidedBy: actor.userId,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(kairosItem.id, item.id))
      await writeAdminAudit(tx, actor, {
        action: "arm.kairos_item_failed",
        entityId: item.id,
        metadata: { kind, code: error.code },
      })
      return decision("fallida", null, error.message)
    }
    throw error
  }
  await tx
    .update(kairosItem)
    .set({
      status: executed.status,
      result: executed.result,
      decidedBy: actor.userId,
      decidedAt: now,
      updatedAt: now,
    })
    .where(eq(kairosItem.id, item.id))
  await writeAdminAudit(tx, actor, {
    action: "arm.kairos_item_approved",
    entityId: item.id,
    metadata: { kind, edited: Object.keys(edits).length > 0 },
  })
  return {
    ...decision(executed.status, executed.result, null),
    ...(executed.outreach ? { outreach: executed.outreach } : {}),
  }
}

/**
 * Después de que un envío que salió de un ítem cambia de estado (el correo
 * enviado o incierto, el WhatsApp «Salió» o «No salió»), el ítem lo sigue:
 * enviado → ejecutada; no salió → fallida; lo demás sigue por confirmar. La
 * ruta lo llama tras marcar o resolver el envío. Devuelve el estado del ítem,
 * o null si el envío no salió de Kairós.
 */
export async function settleKairosOutreach(
  tx: Db,
  outreachId: string,
): Promise<KairosItemStatus | null> {
  if (!UUID.test(outreachId)) return null
  const [outreach] = await tx
    .select({ status: saasOutreach.status, itemId: saasOutreach.kairosItemId })
    .from(saasOutreach)
    .where(eq(saasOutreach.id, outreachId))
  if (!outreach?.itemId) return null
  const next: KairosItemStatus =
    outreach.status === "enviado"
      ? "ejecutada"
      : outreach.status === "no_salio"
        ? "fallida"
        : "incierta"
  const [row] = await tx
    .update(kairosItem)
    .set({
      status: next,
      error: next === "fallida" ? "No salió" : null,
      result: sql`coalesce(${kairosItem.result}, '{}'::jsonb) || ${JSON.stringify({ outreachStatus: outreach.status })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(kairosItem.id, outreach.itemId), eq(kairosItem.status, "incierta")))
    .returning({ status: kairosItem.status })
  return (row?.status as KairosItemStatus | undefined) ?? null
}

/**
 * Guarda lo que redactó el modelo (o la plantilla, sin modelo configurado)
 * para un mensaje o un guion en espera: desde ahí está listo. La redacción
 * original queda en `payload.draft` con quién la hizo (`drafter`); lo que la
 * persona cambie va en `edited` al aprobar. Devuelve false si ya no espera.
 */
export async function saveKairosDraft(
  tx: Db,
  itemId: string,
  draft: { subject?: string | null; body: string; drafter?: KairosDrafter },
): Promise<boolean> {
  const body = draft.body?.trim() ?? ""
  if (!body) throw invalidField("body", "El borrador está vacío")
  if (body.length > 5000) throw invalidField("body", "Usa como máximo 5000 caracteres")
  const subject = draft.subject?.trim() || null
  if (subject && subject.length > 200)
    throw invalidField("subject", "Usa como máximo 200 caracteres")
  const drafter: KairosDrafter = draft.drafter === "plantilla" ? "plantilla" : "modelo"
  const patch = {
    draft: { subject, body, drafter },
    subject,
    body,
    draftNote: drafter === "plantilla" ? KAIROS_TEMPLATE_NOTE : null,
  }
  const done = await tx
    .update(kairosItem)
    .set({
      payload: sql`${kairosItem.payload} || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(kairosItem.id, itemId),
        eq(kairosItem.status, "espera"),
        inArray(kairosItem.kind, [...DRAFT_KINDS]),
      ),
    )
    .returning({
      id: kairosItem.id,
      kind: kairosItem.kind,
      clientId: kairosItem.clientId,
      adminOnly: kairosItem.adminOnly,
    })
  const row = done[0]
  if (!row) return false
  await writeAdminAudit(tx, null, {
    action: "kairos.draft_written",
    entityId: row.id,
    metadata: { kind: row.kind, clientId: row.clientId, adminOnly: row.adminOnly, drafter },
  })
  return true
}

/* ---------- La pasada de reglas ---------- */

/** Lo que el modelo tiene que redactar: solo lo necesario (nunca datos de pacientes, importes ni adjuntos). */
export interface KairosDraftRequest {
  itemId: string
  kind: DraftKind
  /** Para qué es: primera_respuesta, recordar_invitacion, recordar_propuesta, retomar, pedir_archivos, recordar_equipo, guion. */
  goal: string
  channel: SaasOutreachChannel | null
  client: { id: string; name: string; city: string | null; product: ClinicalProduct }
  contact: { name: string } | null
  /** Quien firma: el responsable del cliente, si hay. */
  sender: { name: string } | null
  demo: { name: string } | null
  /** Los hechos con que redactar, en frases. */
  facts: string[]
  /** Si es solo para Administración (puede citar la propuesta); si no, nada solo de administración. */
  adminOnly: boolean
}

export interface KairosPassResult {
  clientsCreated: number
  clientsLinked: number
  activities: number
  tasks: number
  items: number
  signals: number
  /** Lo que espera la redacción del modelo (el worker la pide, con tope). */
  needsDraft: KairosDraftRequest[]
}

interface ClientInfo {
  id: string
  name: string
  city: string | null
  product: string
  ownerUserId: string | null
  organizationId: string | null
}

interface ContactInfo {
  id: string
  name: string
  email: string | null
  phone: string | null
  preferredChannel: string | null
}

/** Por dónde escribirle a una persona: su canal preferido si se puede; si no, WhatsApp con teléfono o correo. */
function channelFor(
  contact: ContactInfo | undefined,
): { channel: SaasOutreachChannel; to: string } | null {
  if (!contact) return null
  if (contact.preferredChannel === "correo" && contact.email)
    return { channel: "correo", to: contact.email }
  if (contact.phone && contact.preferredChannel !== "correo")
    return { channel: "whatsapp", to: contact.phone }
  if (contact.email) return { channel: "correo", to: contact.email }
  return null
}

class Pass {
  readonly today: string
  readonly result: KairosPassResult = {
    clientsCreated: 0,
    clientsLinked: 0,
    activities: 0,
    tasks: 0,
    items: 0,
    signals: 0,
    needsDraft: [],
  }
  private clients = new Map<string, ClientInfo>()
  private contacts = new Map<string, ContactInfo | null>()

  constructor(
    readonly tx: Db,
    readonly now: Date,
  ) {
    this.today = limaDate(now)
  }

  get nowSql(): SQL {
    return sql`${this.now.toISOString()}::timestamptz`
  }

  ago(days: number): SQL {
    return sql`${new Date(this.now.getTime() - days * DAY).toISOString()}::timestamptz`
  }

  async client(id: string): Promise<ClientInfo | null> {
    const cached = this.clients.get(id)
    if (cached) return cached
    const [row] = await this.tx
      .select({
        id: saasClient.id,
        name: saasClient.name,
        city: saasClient.city,
        product: saasClient.product,
        ownerUserId: saasClient.ownerUserId,
        organizationId: saasClient.organizationId,
      })
      .from(saasClient)
      .where(eq(saasClient.id, id))
    if (!row) return null
    this.clients.set(id, row)
    return row
  }

  /** La persona principal del cliente (o la primera que se anotó). */
  async contact(clientId: string): Promise<ContactInfo | undefined> {
    if (this.contacts.has(clientId)) return this.contacts.get(clientId) ?? undefined
    const [row] = await rows<{
      id: string
      name: string
      email: string | null
      phone: string | null
      preferred_channel: string | null
    }>(
      this.tx,
      sql`select id, name, email, phone, preferred_channel from saas_client_contact where client_id = ${clientId}::uuid
        order by is_primary desc, created_at asc, id asc limit 1`,
    )
    const contact = row
      ? {
          id: row.id,
          name: row.name,
          email: row.email,
          phone: row.phone,
          preferredChannel: row.preferred_channel,
        }
      : null
    this.contacts.set(clientId, contact)
    return contact ?? undefined
  }

  /**
   * Pone una tarea de Kairós una vez por hecho (`once`) o, si el hecho sigue,
   * una por día mientras no haya otra abierta (`daily`). La clave es
   * `regla:cliente:hecho:día`.
   */
  async task(plan: {
    rule: string
    clientId: string
    fact: string
    repeat: "once" | "daily"
    kind: SaasTaskKind
    title: string
    dueOn?: string
    dueAt?: Date | null
    contactId?: string | null
    demoId?: string | null
    adminOnly?: boolean
  }): Promise<string | null> {
    const prefix = `${plan.rule}:${plan.clientId}:${plan.fact}:`
    const [found] = await this.tx
      .select({ id: saasTask.id })
      .from(saasTask)
      .where(
        and(
          sql`left(${saasTask.kairosKey}, ${prefix.length}) = ${prefix}`,
          plan.repeat === "daily" ? eq(saasTask.status, "abierta") : undefined,
        ),
      )
      .limit(1)
    if (found) return null
    const client = await this.client(plan.clientId)
    if (!client) return null
    const [row] = await this.tx
      .insert(saasTask)
      .values({
        clientId: plan.clientId,
        kind: plan.kind,
        title: plan.title.slice(0, 200),
        dueOn: plan.dueOn ?? this.today,
        dueAt: plan.dueAt ?? null,
        assigneeUserId: client.ownerUserId,
        contactId: plan.contactId ?? null,
        demoId: plan.demoId ?? null,
        byKairos: true,
        kairosKey: `${prefix}${this.today}`,
        createdAt: this.now,
        updatedAt: this.now,
      })
      .onConflictDoNothing()
      .returning({ id: saasTask.id })
    if (!row) return null
    await writeAdminAudit(this.tx, null, {
      action: "kairos.task_created",
      entityId: row.id,
      organizationId: client.organizationId,
      metadata: {
        rule: plan.rule,
        kind: plan.kind,
        clientId: plan.clientId,
        adminOnly: plan.adminOnly ?? plan.kind === "cobro",
      },
    })
    this.result.tasks += 1
    return row.id
  }

  /**
   * Deja algo en espera de un sí, una vez por hecho: si ya hay uno de ese
   * hecho (en espera o decidido), no prepara otro; uno vencido libera su
   * clave. Congela el estado al prepararlo.
   */
  async item(plan: {
    rule: string
    clientId: string | null
    fact: string
    kind: KairosItemKind
    title: string
    reason: string
    payload: Record<string, unknown>
    adminOnly: boolean
  }): Promise<string | null> {
    const prefix = `${plan.rule}:${plan.clientId ?? "-"}:${plan.fact}:`
    const [found] = await this.tx
      .select({ id: kairosItem.id })
      .from(kairosItem)
      .where(sql`left(${kairosItem.idempotencyKey}, ${prefix.length}) = ${prefix}`)
      .limit(1)
    if (found) return null
    const expectedState = await captureState(this.tx, plan.kind, plan.clientId, plan.payload)
    const [row] = await this.tx
      .insert(kairosItem)
      .values({
        clientId: plan.clientId,
        kind: plan.kind,
        title: plan.title.slice(0, 200),
        reason: plan.reason.slice(0, 1000),
        payload: plan.payload,
        expectedState,
        idempotencyKey: `${prefix}${this.today}`,
        expiresAt: new Date(this.now.getTime() + KAIROS_ITEM_HOURS * HOUR),
        adminOnly: plan.adminOnly,
        createdAt: this.now,
        updatedAt: this.now,
      })
      .onConflictDoNothing()
      .returning({ id: kairosItem.id })
    if (!row) return null
    const client = plan.clientId ? await this.client(plan.clientId) : null
    await writeAdminAudit(this.tx, null, {
      action: "kairos.item_prepared",
      entityId: row.id,
      organizationId: client?.organizationId ?? null,
      metadata: {
        rule: plan.rule,
        kind: plan.kind,
        clientId: plan.clientId,
        adminOnly: plan.adminOnly,
      },
    })
    this.result.items += 1
    return row.id
  }

  /** Un mensaje para que una persona lo apruebe; sin por dónde escribirle, no se prepara. */
  async message(plan: {
    rule: string
    clientId: string
    fact: string
    goal: string
    title: string
    reason: string
    facts: string[]
    adminOnly: boolean
    extra?: Record<string, unknown>
  }): Promise<string | null> {
    const contact = await this.contact(plan.clientId)
    const route = channelFor(contact)
    if (!route || !contact) return null
    return this.item({
      rule: plan.rule,
      clientId: plan.clientId,
      fact: plan.fact,
      kind: "mensaje",
      title: plan.title,
      reason: plan.reason,
      adminOnly: plan.adminOnly,
      payload: {
        goal: plan.goal,
        channel: route.channel,
        contactId: contact.id,
        to: route.to,
        subject: null,
        body: null,
        draft: null,
        facts: plan.facts,
        ...plan.extra,
      },
    })
  }

  /** ¿Hay una tarea de Kairós abierta con esa clave? */
  async openTask(prefix: string): Promise<boolean> {
    const [found] = await this.tx
      .select({ id: saasTask.id })
      .from(saasTask)
      .where(
        and(
          eq(saasTask.status, "abierta"),
          sql`left(${saasTask.kairosKey}, ${prefix.length}) = ${prefix}`,
        ),
      )
      .limit(1)
    return Boolean(found)
  }

  /**
   * Deja un aviso en «Lo que hizo» una sola vez por clave (`entity_id`): lo que pasó fuera
   * de Kairós y él cuenta (una carga, un informe que salió). Solo de Administración.
   */
  async notice(plan: {
    action: "kairos.load_noticed" | "kairos.report_noticed"
    key: string
    clientId: string
    metadata: Record<string, unknown>
  }): Promise<boolean> {
    const [found] = await rows<{ id: string }>(
      this.tx,
      sql`select id from admin_audit where action = ${plan.action} and entity_id = ${plan.key} limit 1`,
    )
    if (found) return false
    const client = await this.client(plan.clientId)
    if (!client) return false
    await writeAdminAudit(this.tx, null, {
      action: plan.action,
      entityId: plan.key,
      organizationId: client.organizationId,
      metadata: { ...plan.metadata, clientId: plan.clientId, adminOnly: true },
    })
    return true
  }

  /** Una señal que pide una tarea: la tarea una vez por hecho y la señal en «Lo que hizo». */
  async signalTask(
    clientId: string,
    signal: KairosSignal,
    task: { kind: SaasTaskKind; title: string },
  ): Promise<void> {
    const id = await this.task({
      rule: `senal_${signal.code}`,
      clientId,
      fact: signal.fact,
      repeat: "once",
      kind: task.kind,
      title: task.title,
      adminOnly: signal.adminOnly,
    })
    if (!id) return
    const client = await this.client(clientId)
    await writeAdminAudit(this.tx, null, {
      action: "kairos.signal",
      entityId: clientId,
      organizationId: client?.organizationId ?? null,
      metadata: { code: signal.code, clientId, taskId: id, adminOnly: signal.adminOnly },
    })
    this.result.signals += 1
  }
}

/** (11) Cuenta sin cliente: la liga al cliente de su solicitud o crea uno (las demos nunca son clientes). */
async function ruleAccountsWithoutClient(pass: Pass): Promise<void> {
  const { tx } = pass
  const orphans = await rows<{ id: string; client_id: string | null }>(
    tx,
    sql`select o.id,
      (select r.client_id from saas_waitlist_request r join saas_client c on c.id = r.client_id
        where r.organization_id = o.id and c.organization_id is null order by r.created_at desc limit 1) as client_id
    from organization o
    where not exists (select 1 from saas_subscription s where s.organization_id = o.id and s.is_demo)
      and not exists (select 1 from saas_demo d where d.organization_id = o.id)
      and not exists (select 1 from saas_client c where c.organization_id = o.id)
    order by o.created_at asc nulls last, o.id`,
  )
  for (const org of orphans) {
    // La misma operación que el alta y la invitación: liga (o crea) el cliente y cierra su venta como «entró».
    const clientId = await linkClientToOrganization(tx, null, {
      clientId: org.client_id,
      organizationId: org.id,
      origin: "web",
      now: pass.now,
    })
    if (!clientId) continue
    await writeAdminAudit(tx, null, {
      action: org.client_id ? "kairos.client_linked" : "kairos.client_created",
      entityId: clientId,
      organizationId: org.id,
      metadata: { clientId },
    })
    if (org.client_id) pass.result.clientsLinked += 1
    else pass.result.clientsCreated += 1
  }
}

/** (10) Correos entrantes: con cliente, su actividad; sin cliente, que una persona diga de quién es. */
async function ruleInboundEmails(pass: Pass): Promise<void> {
  const { tx } = pass
  const withClient = await rows<{
    id: string
    client_id: string
    subject: string | null
    mailbox: string
    received_at: string
  }>(
    tx,
    sql`select e.id, e.client_id, e.subject, e.mailbox, ${iso(sql`e.received_at`)} as received_at
    from saas_inbound_email e
    join saas_client c on c.id = e.client_id
    where not exists (
      select 1 from saas_follow_up f
      where f.client_id = e.client_id and f.kind = 'correo' and f.direction = 'entro' and f.happened_at = e.received_at)
    order by e.received_at asc`,
  )
  for (const email of withClient) {
    const client = await pass.client(email.client_id)
    const subject = email.subject?.trim()
    // Sin `request_id`: un correo que llega no es haberle respondido (la lista de espera no lo cuenta).
    const [entry] = await rows<{ id: string }>(
      tx,
      sql`insert into saas_follow_up (client_id, body, kind, direction, happened_at, by_kairos)
      values (${email.client_id}::uuid, ${(subject ? `Correo recibido: ${subject}` : "Correo recibido, sin asunto").slice(0, 2000)},
        'correo', 'entro', ${email.received_at}::timestamptz, true)
      returning id`,
    )
    if (!entry) continue
    await writeAdminAudit(tx, null, {
      action: "kairos.email_recorded",
      entityId: entry.id,
      organizationId: client?.organizationId ?? null,
      metadata: { clientId: email.client_id, emailId: email.id, mailbox: email.mailbox },
    })
    pass.result.activities += 1
  }
  const unassigned = await rows<{
    id: string
    mailbox: string
    product: string
    from_address: string
    from_name: string | null
    subject: string | null
    received_at: string
  }>(
    tx,
    sql`select id, mailbox, product, from_address, from_name, subject, ${iso(sql`received_at`)} as received_at
    from saas_inbound_email where client_id is null order by received_at asc`,
  )
  for (const email of unassigned) {
    const who = email.from_name?.trim() || email.from_address
    await pass.item({
      rule: "correo_sin_cliente",
      clientId: null,
      fact: email.id,
      kind: "correo_sin_cliente",
      title: `Correo sin cliente: ${who}`,
      reason: `Llegó a ${email.mailbox}@ de ${productWords(productOf(email.product)).name} el ${dayText(limaDate(new Date(email.received_at)))} y su correo no es el de ningún cliente: di de quién es`,
      adminOnly: false,
      payload: {
        emailId: email.id,
        mailbox: email.mailbox,
        product: email.product,
        from: email.from_address,
        fromName: email.from_name,
        subject: email.subject,
        receivedAt: email.received_at,
        clientId: null,
      },
    })
  }
}

/**
 * (12) Duplicados por correo: dos clientes con la misma persona que se pueden
 * fusionar (la regla única `clientDuplicatePairsSql`, la misma de la señal
 * «puede estar repetida»); fusionar lo decide una persona.
 */
async function ruleDuplicates(pass: Pass): Promise<void> {
  const pairs = await rows<{ keep_id: string; drop_id: string; keep_name: string; email: string }>(
    pass.tx,
    sql`select distinct on (ca.id, cb.id) ca.id as keep_id, cb.id as drop_id, ca.name as keep_name, p.email
    from (${clientDuplicatePairsSql}) p
    join saas_client ca on ca.id = p.a_id
    join saas_client cb on cb.id = p.b_id
    where (ca.created_at, ca.id) < (cb.created_at, cb.id)
    order by ca.id, cb.id, p.email`,
  )
  for (const pair of pairs) {
    await pass.item({
      rule: "duplicado",
      clientId: pair.drop_id,
      fact: pair.keep_id,
      kind: "duplicado",
      title: `¿Es la misma que ${pair.keep_name}?`,
      reason: `Las dos tienen a ${pair.email} como contacto`,
      adminOnly: true,
      payload: { keepId: pair.keep_id, dropId: pair.drop_id, email: pair.email },
    })
  }
}

/** (3) y (4) Las solicitudes por responder y las invitaciones que vencen: la regla de Inicio (`waitlistHomeRows`). */
async function ruleWaitlist(pass: Pass): Promise<void> {
  const { tx, now } = pass
  const home = (await waitlistHomeRows(tx, KAIROS_READER, now)).filter((row) => row.reason !== null)
  if (home.length === 0) return
  const links = await tx
    .select({
      id: sql<string>`r.id`,
      clientId: sql<string | null>`r.client_id`,
      createdAt: sql<string>`${iso(sql`r.created_at`)}`,
      called: sql<boolean>`exists (select 1 from saas_follow_up f where f.client_id = r.client_id and f.kind = 'llamada'
        and r.invite_expires_at is not null and f.happened_at >= r.invite_expires_at)`,
    })
    .from(sql`saas_waitlist_request r`)
    .where(
      sql`r.id in (${sql.join(
        home.map((row) => sql`${row.id}::uuid`),
        sql`, `,
      )})`,
    )
  const byId = new Map(links.map((link) => [link.id, link]))
  for (const row of home) {
    const link = byId.get(row.id)
    const clientId = link?.clientId
    if (!clientId) continue
    if (row.reason === "por_responder" && row.answer) {
      const arrived = dayText(limaDate(new Date(link.createdAt)))
      const due =
        row.answer.due === "vencida"
          ? `venció el ${dayText(row.answer.day)}`
          : row.answer.due === "hoy"
            ? "es hoy"
            : `es hasta el ${dayText(row.answer.day)}`
      await pass.task({
        rule: "responder",
        clientId,
        fact: row.id,
        repeat: "once",
        kind: "escribir",
        title: "Responder la solicitud de la web",
        dueOn: row.answer.due === "vencida" ? pass.today : row.answer.day,
      })
      await pass.message({
        rule: "responder",
        clientId,
        fact: row.id,
        goal: "primera_respuesta",
        title: `Primera respuesta a ${row.firstName} ${row.lastName}`.trim(),
        reason: `Dejó su solicitud en la web el ${arrived} y nadie le respondió; el plazo ${due}`,
        facts: [
          `${row.clinicName} dejó su solicitud en la web el ${arrived}`,
          `Producto: ${productWords(row.product).name}`,
        ],
        adminOnly: false,
        extra: { requestId: row.id },
      })
      continue
    }
    if (row.reason === "invitacion" && row.inviteExpiresAt) {
      const day = limaDate(row.inviteExpiresAt)
      if (row.inviteExpiresAt <= now) {
        // Vencida: lo que sigue es llamarla (volver a invitar lo decide una persona).
        if (link.called) continue
        await pass.task({
          rule: "invitacion",
          clientId,
          fact: `${row.id}:${day}`,
          repeat: "once",
          kind: "llamar",
          title: `Llamar: su invitación venció el ${dayText(day)}`,
        })
        continue
      }
      await pass.task({
        rule: "invitacion",
        clientId,
        fact: `${row.id}:${day}`,
        repeat: "once",
        kind: "escribir",
        title: `Recordar la invitación: vence el ${dayText(day)}`,
      })
      await pass.message({
        rule: "invitacion",
        clientId,
        fact: `${row.id}:${day}`,
        goal: "recordar_invitacion",
        title: `Recordatorio a ${row.firstName} ${row.lastName}: su invitación vence`.trim(),
        reason: `Su invitación vence el ${dayText(day)} y todavía no entró`,
        facts: [`La invitación de ${row.clinicName} vence el ${dayText(day)}`],
        adminOnly: false,
        extra: { requestId: row.id },
      })
    }
  }
}

/** (5) La propuesta enviada que vence en 3 días: un recordatorio (solo Administración: es de precios). */
async function ruleProposalsExpiring(pass: Pass): Promise<void> {
  const found = await rows<{ id: string; client_id: string; valid_until: string; version: number }>(
    pass.tx,
    sql`select p.id, p.client_id, p.valid_until::text as valid_until, p.version from saas_proposal p
    join saas_client c on c.id = p.client_id
    where p.status = 'enviada' and c.archived_at is null and not ${proposalReplacedSql()}
      and p.valid_until >= ${pass.today}::date and p.valid_until <= ${plusDays(pass.today, PROPOSAL_SOON_DAYS)}::date`,
  )
  for (const proposal of found) {
    await pass.message({
      rule: "propuesta_vence",
      clientId: proposal.client_id,
      fact: proposal.id,
      goal: "recordar_propuesta",
      title: "Recordar que la propuesta vence",
      reason: `La propuesta ${proposal.version} vale hasta el ${dayText(proposal.valid_until)} y no hay respuesta`,
      facts: [`La propuesta vale hasta el ${dayText(proposal.valid_until)}`],
      adminOnly: true,
      extra: { proposalId: proposal.id },
    })
  }
}

/** (6) Llegó el día de volver a quien dijo «no por ahora»: tarea y mensaje para retomar. */
async function ruleReturnOn(pass: Pass): Promise<void> {
  const found = await rows<{ id: string; client_id: string; return_on: string }>(
    pass.tx,
    sql`select o.id, o.client_id, o.return_on::text as return_on from saas_opportunity o
    join saas_client c on c.id = o.client_id
    where o.decision = 'no_por_ahora' and o.return_on <= ${pass.today}::date and c.archived_at is null
      and not exists (select 1 from saas_opportunity x where x.client_id = o.client_id and (x.decision is null or x.created_at > o.created_at))`,
  )
  for (const opportunity of found) {
    const reason = `Dijo «no por ahora» y pidió volver el ${dayText(opportunity.return_on)}`
    await pass.task({
      rule: "retomar",
      clientId: opportunity.client_id,
      fact: opportunity.id,
      repeat: "once",
      kind: "llamar",
      title: "Retomar: dijo «no por ahora»",
    })
    await pass.message({
      rule: "retomar",
      clientId: opportunity.client_id,
      fact: opportunity.id,
      goal: "retomar",
      title: "Mensaje para retomar",
      reason,
      facts: [reason],
      adminOnly: false,
      extra: { opportunityId: opportunity.id },
    })
  }
}

/** (7) Presentaciones: el guion de las de las próximas 24 h y, si la demo se abrió hoy, la pregunta de si se hizo. */
async function rulePresentations(pass: Pass): Promise<void> {
  const { tx } = pass
  const soon = await rows<{
    id: string
    client_id: string
    demo_id: string | null
    contact_id: string | null
    due_on: string
    due_at: string | null
    demo_name: string | null
  }>(
    tx,
    sql`select t.id, t.client_id, t.demo_id, t.contact_id, t.due_on::text as due_on, ${iso(sql`t.due_at`)} as due_at, d.name as demo_name
    from saas_task t
    join saas_client c on c.id = t.client_id
    left join saas_demo d on d.id = t.demo_id
    where t.kind = 'presentacion' and t.status = 'abierta' and c.archived_at is null
      and ((t.due_at is not null and t.due_at > ${pass.nowSql} and t.due_at <= ${new Date(pass.now.getTime() + 24 * HOUR).toISOString()}::timestamptz)
        or (t.due_at is null and t.due_on between ${pass.today}::date and ${plusDays(pass.today, 1)}::date))`,
  )
  for (const task of soon) {
    const when = task.due_at
      ? `el ${dayText(limaDate(new Date(task.due_at)))} a las ${timeText(new Date(task.due_at))}`
      : `el ${dayText(task.due_on)}`
    await pass.item({
      rule: "guion",
      clientId: task.client_id,
      fact: task.id,
      kind: "guion",
      title: "Guion de la presentación",
      reason: `La presentación es ${when}${task.demo_name ? ` con la demo ${task.demo_name}` : ""}`,
      adminOnly: false,
      payload: {
        taskId: task.id,
        demoId: task.demo_id,
        contactId: task.contact_id,
        goal: "guion",
        draft: null,
        body: null,
      },
    })
  }
  const opened = await rows<{
    id: string
    client_id: string
    demo_name: string
    opened_at: string
  }>(
    tx,
    sql`select t.id, t.client_id, d.name as demo_name, ${iso(sql`d.opened_at`)} as opened_at
    from saas_task t
    join saas_client c on c.id = t.client_id
    join saas_demo d on d.id = t.demo_id
    where t.kind = 'presentacion' and t.status = 'abierta' and c.archived_at is null and t.due_on <= ${pass.today}::date
      and d.opened_at is not null and (d.opened_at at time zone 'America/Lima')::date = ${pass.today}::date
      and not exists (select 1 from saas_follow_up f where f.client_id = t.client_id and f.kind = 'presentacion'
        and (f.happened_at at time zone 'America/Lima')::date = ${pass.today}::date)`,
  )
  for (const task of opened) {
    const client = await pass.client(task.client_id)
    await pass.item({
      rule: "presentacion_hecha",
      clientId: task.client_id,
      fact: task.id,
      kind: "presentacion_hecha",
      title: `¿Se hizo la presentación con ${client?.name ?? "el cliente"}?`,
      reason: `La demo ${task.demo_name} se abrió hoy a las ${timeText(new Date(task.opened_at))}`,
      adminOnly: false,
      payload: {
        taskId: task.id,
        outcome: "se_hizo",
        body: `Se hizo la presentación con la demo ${task.demo_name}.`,
      },
    })
  }
}

/** (8) El alta: los archivos que no llegan, lo que cargó la skill, el informe que falta o no se sabe si salió, el equipo que no entra. */
async function ruleOnboarding(pass: Pass): Promise<void> {
  const { tx } = pass
  const letters = await rows<{ client_id: string; file_id: string; sent_at: string }>(
    tx,
    sql`select c.id as client_id, f.id as file_id, ${iso(sql`f.created_at`)} as sent_at
    from saas_client c
    join lateral (
      select id, created_at from saas_client_file g where g.client_id = c.id and g.kind = 'carta' and g.deleted_at is null
      order by created_at desc limit 1
    ) f on true
    where c.archived_at is null and c.organization_id is not null and f.created_at <= ${pass.ago(LETTER_WAIT_DAYS)}
      and not exists (select 1 from saas_client_file g where g.client_id = c.id and g.kind = 'archivo_clinica' and g.created_at >= f.created_at)
      and not exists (select 1 from saas_inbound_email e where e.client_id = c.id and jsonb_array_length(e.attachments) > 0 and e.received_at >= f.created_at)
      and not exists (select 1 from admin_audit l where l.organization_id = c.organization_id
        and l.action in ('org.setup_import', 'org.data_import'))`,
  )
  for (const letter of letters) {
    const sent = dayText(limaDate(new Date(letter.sent_at)))
    await pass.task({
      rule: "carta_sin_archivos",
      clientId: letter.client_id,
      fact: letter.file_id,
      repeat: "once",
      kind: "alta",
      title: "Pedir los archivos de la carga",
    })
    await pass.message({
      rule: "carta_sin_archivos",
      clientId: letter.client_id,
      fact: letter.file_id,
      goal: "pedir_archivos",
      title: "Recordar los archivos de la carga",
      reason: `La carta de bienvenida salió el ${sent} y todavía no llegaron sus archivos`,
      facts: [
        `La carta de bienvenida salió el ${sent}`,
        "Todavía no llegaron los archivos para cargar sus datos",
      ],
      adminOnly: false,
    })
  }
  await ruleLoadsAndReports(pass)
  const teams = await rows<{ client_id: string; ids: string[]; n: number }>(
    tx,
    sql`select c.id as client_id, array_agg(i.id order by i.id) as ids, count(*)::int as n
    from saas_client c join invitation i on i.organization_id = c.organization_id
    where c.archived_at is null and i.status = 'pending' and coalesce(i.role, 'member') not like '%owner%'
      and i.created_at <= ${pass.ago(TEAM_INVITE_DAYS)} and i.expires_at > ${pass.nowSql}
    group by c.id`,
  )
  for (const team of teams) {
    const fact = createHash("sha256").update(team.ids.join(",")).digest("hex").slice(0, 16)
    const people =
      team.n === 1
        ? "Una persona del equipo no aceptó"
        : `${team.n} personas del equipo no aceptaron`
    await pass.message({
      rule: "equipo_sin_aceptar",
      clientId: team.client_id,
      fact,
      goal: "recordar_equipo",
      title: "Recordar al equipo que acepte su invitación",
      reason: `${people} su invitación en ${TEAM_INVITE_DAYS} días`,
      facts: [`${people} la invitación a la cuenta`],
      adminOnly: false,
      extra: { invitationIds: team.ids },
    })
  }
}

/** Cuánto espera Kairós a que una carga termine antes de contarla: las tandas de pacientes siguen llegando. */
const LOAD_SETTLE_MS = 10 * 60_000

const LOAD_WORDS: Record<ClinicLoadRecord["kind"], string> = {
  configuracion: "Se cargó la configuración",
  pacientes: "Se cargaron los pacientes",
}

/** El prefijo de la clave de las tareas de Kairós de un informe que no se sabe si salió. */
const unknownReportPrefix = (clientId: string, number: number) =>
  `informe_desconocido:${clientId}:informe-${number}-`

/** El número del informe de una tarea «Revisar en Zoho…», leído de su clave; null si no es una. */
export function unknownReportNumberOf(kairosKey: string | null): number | null {
  const match = kairosKey?.match(/^informe_desconocido:[^:]+:informe-(\d+)-/)
  return match ? Number(match[1]) : null
}

/**
 * Lo que hizo la skill de carga en el servidor (ADR 0183), leído del mismo registro que
 * muestra la ficha › Alta (`listClinicLoads` y `listProgressReports`, nunca una copia):
 * cada carga, una vez, en «Lo que hizo» con sus cifras y a nombre de quien la hizo (una
 * carga de pacientes cuenta cuando sus tandas llevan 10 minutos quietas); cada informe
 * que salió, una vez; «Enviar el informe» si lo último cargado no tiene informe después;
 * y la tarea urgente «Revisar en Zoho si salió el informe N.º n» por cada vez que un
 * informe queda «no se sabe si salió» (si un reenvío vuelve a cortarse, vuelve la tarea).
 * Lo que ya se resolvió se cierra solo (`settleReportTasks`).
 */
async function ruleLoadsAndReports(pass: Pass): Promise<void> {
  const { tx } = pass
  const actions = sql.join(
    ["org.setup_import", "org.data_import", ...Object.values(PROGRESS_REPORT_ACTIONS)].map(
      (action) => sql`${action}`,
    ),
    sql`, `,
  )
  const accounts = await rows<{ client_id: string; organization_id: string }>(
    tx,
    sql`select c.id as client_id, c.organization_id from saas_client c
    where c.archived_at is null and c.organization_id is not null
      and exists (select 1 from admin_audit a where a.organization_id = c.organization_id and a.action in (${actions}))
    order by c.created_at asc, c.id asc`,
  )
  for (const account of accounts) {
    const clientId = account.client_id
    const orgId = account.organization_id
    const loads = await listClinicLoads(tx, orgId)
    const reports = await listProgressReports(tx, orgId)
    const quiet = pass.now.getTime() - LOAD_SETTLE_MS
    for (const load of loads) {
      if (Date.parse(load.at) > quiet) continue
      await pass.notice({
        action: "kairos.load_noticed",
        key: `carga:${load.id}`,
        clientId,
        metadata: { loadKind: load.kind, summary: load.summary, by: load.by, at: load.at },
      })
    }
    for (const report of reports) {
      if (report.state !== "enviado") continue
      await pass.notice({
        action: "kairos.report_noticed",
        key: `informe:${orgId}:${report.number}`,
        clientId,
        metadata: {
          number: report.number,
          to: report.to,
          registered: report.registeredLater,
          resent: report.resent,
        },
      })
    }
    const lastLoad = loads[0]
    const reportedAfter = lastLoad
      ? reports.some((report) => Date.parse(report.at) >= Date.parse(lastLoad.at))
      : true
    if (lastLoad && !reportedAfter && !(await pass.openTask(`carga_sin_informe:${clientId}:`)))
      await pass.task({
        rule: "carga_sin_informe",
        clientId,
        fact: lastLoad.id,
        repeat: "once",
        kind: "alta",
        title: "Enviar el informe",
        adminOnly: true,
      })
    for (const report of reports) {
      // Una por vez: si la de antes sigue abierta (un reenvío que volvió a cortarse), basta esa.
      if (report.state !== "desconocido") continue
      if (await pass.openTask(unknownReportPrefix(clientId, report.number))) continue
      await pass.task({
        rule: "informe_desconocido",
        clientId,
        fact: `informe-${report.number}-${Date.parse(report.at)}`,
        repeat: "once",
        kind: "alta",
        title: `Revisar en Zoho si salió el informe N.º ${report.number}`,
        // Urgente: arriba en Hoy desde ya.
        dueAt: pass.now,
        adminOnly: true,
      })
    }
    await settleReportTasks(tx, orgId, pass.now, { loads, reports, clientId })
  }
}

/**
 * Cierra las tareas de Kairós de un informe que ya salió: «Revisar en Zoho si salió el
 * informe N.º n» cuando ese número quedó enviado, y «Enviar el informe» cuando el último
 * informe, después de la última carga, salió. Deja en «Lo que hizo» que la cerró. La usa
 * la pasada y la ruta del registro después de «Revisé en Zoho: salió» o de un reenvío.
 */
export async function settleReportTasks(
  tx: Db,
  orgId: string,
  now: Date,
  known?: { loads: ClinicLoadRecord[]; reports: ProgressReportRecord[]; clientId: string },
): Promise<number> {
  let clientId = known?.clientId
  if (!clientId) {
    const [client] = await tx
      .select({ id: saasClient.id })
      .from(saasClient)
      .where(eq(saasClient.organizationId, orgId))
      .limit(1)
    if (!client) return 0
    clientId = client.id
  }
  const loads = known?.loads ?? (await listClinicLoads(tx, orgId))
  const reports = known?.reports ?? (await listProgressReports(tx, orgId))
  const close: Array<{ prefix: string; why: string }> = []
  for (const report of reports)
    if (report.state === "enviado")
      close.push({
        prefix: unknownReportPrefix(clientId, report.number),
        why: `salió el informe N.º ${report.number}`,
      })
  const lastLoad = loads[0]
  const lastSent = reports
    .filter((report) => report.state === "enviado")
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  if (lastSent && (!lastLoad || Date.parse(lastSent.at) >= Date.parse(lastLoad.at)))
    close.push({
      prefix: `carga_sin_informe:${clientId}:`,
      why: `salió el informe N.º ${lastSent.number}`,
    })
  let closed = 0
  for (const { prefix, why } of close) {
    const done = await tx
      .update(saasTask)
      .set({
        status: "hecha",
        doneAt: now,
        doneNote: `Kairós la cerró: ${why}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(saasTask.status, "abierta"),
          eq(saasTask.byKairos, true),
          sql`left(${saasTask.kairosKey}, ${prefix.length}) = ${prefix}`,
        ),
      )
      .returning({ id: saasTask.id, title: saasTask.title })
    for (const task of done) {
      await writeAdminAudit(tx, null, {
        action: "kairos.task_closed",
        entityId: task.id,
        organizationId: orgId,
        metadata: { clientId, taskId: task.id, title: task.title, why, adminOnly: true },
      })
      closed += 1
    }
  }
  return closed
}

/** (9) Riesgo de las que tienen cuenta: cada señal con su tarea, una vez por hecho. */
async function ruleRisk(pass: Pass): Promise<void> {
  const TASKS: Record<KairosSignalCode, { kind: SaasTaskKind; title: string } | null> = {
    comprobante_rechazado: { kind: "cobro", title: "Hablar del comprobante rechazado" },
    sin_sesiones: { kind: "llamar", title: "Llamar: nadie de la clínica entra" },
    mensajes_caen: { kind: "llamar", title: "Llamar: sus mensajes bajaron" },
    caso_esperando: { kind: "otro", title: "Seguir el caso de soporte que espera a la clínica" },
    sin_proximo_paso: null,
    se_enfria: null,
    invitacion_vencida: null,
    propuesta_sin_respuesta: null,
  }
  for (const row of await kairosRiskRows(pass.tx, KAIROS_READER, pass.now)) {
    for (const signal of row.signals) {
      const task = TASKS[signal.code]
      if (task) await pass.signalTask(row.clientId, signal, task)
    }
  }
}

/** (2) y (1) Se enfría (sin contacto en 7 días) y sin próximo paso, con la venta abierta. */
async function ruleCoolingAndNextStep(pass: Pass): Promise<void> {
  for (const row of await kairosCoolingRows(pass.tx, KAIROS_READER, pass.now)) {
    const cooling = row.signals.find((signal) => signal.code === "se_enfria")
    const noNextStep = row.signals.some((signal) => signal.code === "sin_proximo_paso")
    const contact = await pass.contact(row.clientId)
    const who = contact?.name ?? row.name
    if (cooling && noNextStep) {
      await pass.signalTask(row.clientId, cooling, {
        kind: "llamar",
        title: `Retomar el contacto con ${who}: ${cooling.words.toLowerCase()}`,
      })
      continue
    }
    if (noNextStep) {
      await pass.task({
        rule: "sin_proximo_paso",
        clientId: row.clientId,
        fact: row.opportunityId,
        repeat: "daily",
        kind: "llamar",
        title: `Llamar a ${who}: no tiene próximo paso`,
        contactId: contact?.id ?? null,
      })
    }
  }
}

/** Lo que espera la redacción del modelo, con lo justo para redactarlo. */
async function draftRequests(pass: Pass): Promise<KairosDraftRequest[]> {
  const { tx } = pass
  const pending = await tx
    .select({ item: kairosItem })
    .from(kairosItem)
    .where(
      and(
        eq(kairosItem.status, "espera"),
        inArray(kairosItem.kind, [...DRAFT_KINDS]),
        sql`coalesce(${kairosItem.payload} -> 'draft', 'null'::jsonb) = 'null'::jsonb`,
        sql`${kairosItem.expiresAt} > ${pass.nowSql}`,
      ),
    )
    .orderBy(asc(kairosItem.createdAt))
  const out: KairosDraftRequest[] = []
  for (const { item } of pending) {
    if (!item.clientId) continue
    const client = await pass.client(item.clientId)
    if (!client) continue
    const payload = item.payload
    const contactId = str(payload.contactId)
    const [contact] = contactId
      ? await rows<{ name: string }>(
          tx,
          sql`select name from saas_client_contact where id = ${contactId}::uuid`,
        )
      : []
    const [sender] = client.ownerUserId
      ? await rows<{ name: string }>(
          tx,
          sql`select name from "user" where id = ${client.ownerUserId}`,
        )
      : []
    const demoId = str(payload.demoId)
    const [demo] = demoId
      ? await rows<{ name: string }>(tx, sql`select name from saas_demo where id = ${demoId}::uuid`)
      : []
    // Lo último que se habló, sin lo que es solo de administración si el borrador no lo es.
    const recent = await rows<{ kind: string; outcome: string | null; body: string }>(
      tx,
      sql`select kind, outcome, body from saas_follow_up where client_id = ${item.clientId}::uuid and not from_note
        ${item.adminOnly ? sql`` : sql`and not admin_only`}
        order by happened_at desc limit 3`,
    )
    const facts = [
      item.reason,
      ...(Array.isArray(payload.facts)
        ? payload.facts.filter((fact): fact is string => typeof fact === "string")
        : []),
      ...recent.map(
        (entry) =>
          `Antes (${entry.kind}): ${entry.body.slice(0, 300)}${entry.outcome ? ` · quedó en: ${entry.outcome.slice(0, 200)}` : ""}`,
      ),
    ]
    const channel = str(payload.channel)
    out.push({
      itemId: item.id,
      kind: item.kind as DraftKind,
      goal: str(payload.goal) ?? item.kind,
      channel:
        channel && (SAAS_OUTREACH_CHANNELS as readonly string[]).includes(channel)
          ? (channel as SaasOutreachChannel)
          : null,
      client: {
        id: client.id,
        name: client.name,
        city: client.city,
        product: productOf(client.product),
      },
      contact: contact ? { name: contact.name } : null,
      sender: sender ? { name: sender.name } : null,
      demo: demo ? { name: demo.name } : null,
      facts,
      adminOnly: item.adminOnly,
    })
  }
  return out
}

/**
 * Una pasada de Kairós sin modelo: cada regla del ARM, idempotente por su
 * clave (`regla:cliente:hecho:día`), con la pasada bloqueada para que dos
 * workers no la corran a la vez. Solo pone tareas, marca señales, liga o crea
 * el cliente de una cuenta nueva, anota los correos que llegan y deja ítems
 * en espera; nunca envía ni decide. `now` lo da la base. Devuelve lo que
 * necesita redacción del modelo (`needsDraft`).
 */
export async function kairosRulesPass(tx: Db, now: Date): Promise<KairosPassResult> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('kairos:pass'))`)
  await expireKairosItems(tx, now)
  const pass = new Pass(tx, now)
  // Primero lo que crea clientes y actividades; las reglas de tareas, de lo más
  // concreto a lo más general: «sin próximo paso» al final, para no poner una
  // tarea genérica donde otra regla ya puso la suya.
  await ruleAccountsWithoutClient(pass)
  await ruleInboundEmails(pass)
  await ruleDuplicates(pass)
  await ruleWaitlist(pass)
  await ruleProposalsExpiring(pass)
  await ruleReturnOn(pass)
  await rulePresentations(pass)
  await ruleOnboarding(pass)
  await ruleRisk(pass)
  await ruleCoolingAndNextStep(pass)
  pass.result.needsDraft = await draftRequests(pass)
  return pass.result
}

/* ---------- Lo que hizo ---------- */

export type KairosUndo =
  | { kind: "cancelar_tarea"; taskId: string }
  | { kind: "vaciar_dato"; clientId: string; field: "city" | "professionals" | "currentTool" }

export interface KairosDoneEntry {
  id: string
  at: Date
  /** Lo que hizo, en una frase. */
  words: string
  clientId: string | null
  clientName: string | null
  /** Cómo deshacerlo, si todavía se puede (la ruta usa la operación de siempre: cancelar la tarea, vaciar el dato). */
  undo: KairosUndo | null
  /**
   * Lo mismo en varias fichas de una misma pasada, agrupado en una frase
   * («Resumió 4 fichas: A, B, C y D»): cada una con su cliente y su Deshacer.
   */
  members?: KairosDoneMember[]
}

export interface KairosDoneMember {
  id: string
  words: string
  clientId: string | null
  clientName: string | null
  undo: KairosUndo | null
}

/** Para agrupar: qué hizo (`key`), la frase de varias fichas y su pasada. Sin esto, la entrada va sola. */
interface DoneGroupable {
  key: string
  many: (names: string, count: number) => string
  /** La pasada: el instante de su transacción, o el que anotó la pasada (`passAt`). */
  pass: string
}

type RawDoneEntry = KairosDoneEntry & { group?: DoneGroupable }

const NAMES_SHOWN = 5

/** «A, B, C y D»; con más de cinco, «A, B, C, D, E y 3 más». */
function namesList(names: string[]): string {
  const unique = [...new Set(names)]
  if (unique.length <= NAMES_SHOWN)
    return new Intl.ListFormat("es", { type: "conjunction" }).format(unique)
  return `${unique.slice(0, NAMES_SHOWN).join(", ")} y ${unique.length - NAMES_SHOWN} más`
}

const SIGNAL_WORDS: Record<KairosSignalCode, string> = {
  sin_proximo_paso: "no tiene próximo paso",
  se_enfria: "se enfría",
  invitacion_vencida: "su invitación venció y nadie la llamó",
  propuesta_sin_respuesta: "su propuesta no tiene respuesta",
  comprobante_rechazado: "se rechazó su comprobante",
  sin_sesiones: "nadie de la clínica entra",
  mensajes_caen: "sus mensajes bajan",
  caso_esperando: "un caso de soporte espera a la clínica",
}

const DATA_FIELDS = {
  city: "la ciudad",
  professionals: "cuántos profesionales son",
  currentTool: "con qué trabaja hoy",
} as const

/**
 * «Lo que hizo» Kairós: su auditoría (`kairos.*`, actor nulo) y las tareas que
 * puso, en frases y con Deshacer cuando todavía se puede. Las acciones que no
 * conoce se omiten (nunca se muestra un código). Soporte no ve lo que es solo
 * de administración ni las tareas de cobro.
 */
export async function kairosDone(
  tx: Db,
  actor: AdminActor,
  options: { limit?: number; before?: Date } = {},
): Promise<KairosDoneEntry[]> {
  return (await kairosDoneRaw(tx, actor, options)).map(({ group: _group, ...entry }) => entry)
}

async function kairosDoneRaw(
  tx: Db,
  actor: AdminActor,
  options: { limit?: number; before?: Date },
): Promise<RawDoneEntry[]> {
  requireStaff(actor)
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200)
  const admin = actor.role === "admin"
  const audits = await tx
    .select({
      id: adminAudit.id,
      at: adminAudit.createdAt,
      action: adminAudit.action,
      entityId: adminAudit.entityId,
      metadata: adminAudit.metadata,
    })
    .from(adminAudit)
    .where(
      and(
        sql`${adminAudit.action} like 'kairos.%'`,
        sql`${adminAudit.actorUserId} is null`,
        options.before
          ? sql`${adminAudit.createdAt} < ${options.before.toISOString()}::timestamptz`
          : undefined,
        admin
          ? undefined
          : sql`coalesce((${adminAudit.metadata} ->> 'adminOnly')::boolean, false) = false`,
      ),
    )
    .orderBy(desc(adminAudit.createdAt), desc(adminAudit.id))
    .limit(limit)
  // Las tareas de Kairós que no dejaron auditoría (por ejemplo, de la semilla).
  const loose = await tx
    .select({ id: saasTask.id, at: saasTask.createdAt })
    .from(saasTask)
    .where(
      and(
        eq(saasTask.byKairos, true),
        admin ? undefined : ne(saasTask.kind, "cobro"),
        options.before
          ? sql`${saasTask.createdAt} < ${options.before.toISOString()}::timestamptz`
          : undefined,
        sql`not exists (select 1 from admin_audit a where a.action = 'kairos.task_created' and a.entity_id = ${saasTask.id}::text)`,
      ),
    )
    .orderBy(desc(saasTask.createdAt))
    .limit(limit)
  const meta = (value: Record<string, unknown> | null, key: string) => str(value?.[key])
  const taskIds = [
    ...audits
      .filter((a) => a.action === "kairos.task_created" && a.entityId && UUID.test(a.entityId))
      .map((a) => a.entityId as string),
    ...loose.map((t) => t.id),
  ]
  const tasks = new Map(
    (taskIds.length
      ? await tx
          .select({
            id: saasTask.id,
            title: saasTask.title,
            status: saasTask.status,
            kind: saasTask.kind,
            clientId: saasTask.clientId,
          })
          .from(saasTask)
          .where(inArray(saasTask.id, taskIds))
      : []
    ).map((task) => [task.id, task]),
  )
  const itemIds = audits
    .filter(
      (a) =>
        (a.action === "kairos.item_prepared" || a.action === "kairos.draft_written") &&
        a.entityId &&
        UUID.test(a.entityId),
    )
    .map((a) => a.entityId as string)
  const items = new Map(
    (itemIds.length
      ? await tx
          .select({ id: kairosItem.id, title: kairosItem.title, kind: kairosItem.kind })
          .from(kairosItem)
          .where(inArray(kairosItem.id, itemIds))
      : []
    ).map((item) => [item.id, item]),
  )
  const clientIds = new Set<string>()
  for (const a of audits) {
    const id = meta(a.metadata, "clientId")
    if (id && UUID.test(id)) clientIds.add(id)
  }
  for (const task of tasks.values()) clientIds.add(task.clientId)
  const clients = new Map(
    (clientIds.size
      ? await tx
          .select({
            id: saasClient.id,
            name: saasClient.name,
            city: saasClient.city,
            professionals: saasClient.professionals,
            currentTool: saasClient.currentTool,
          })
          .from(saasClient)
          .where(inArray(saasClient.id, [...clientIds]))
      : []
    ).map((client) => [client.id, client]),
  )
  const out: RawDoneEntry[] = []
  const taskGroup = (title: string, pass: string): DoneGroupable => ({
    key: `tarea:${title}`,
    many: (names) => `Puso la tarea «${title}» a ${names}`,
    pass,
  })
  for (const a of audits) {
    const clientId = meta(a.metadata, "clientId")
    const client = clientId ? clients.get(clientId) : undefined
    const pass = meta(a.metadata, "passAt") ?? a.at.toISOString()
    let words: string | null = null
    let undo: KairosUndo | null = null
    let group: DoneGroupable | undefined
    switch (a.action) {
      case "kairos.task_created": {
        const task = a.entityId ? tasks.get(a.entityId) : undefined
        if (!task) break
        if (!admin && task.kind === "cobro") break
        words = `Puso la tarea «${task.title}»`
        if (task.status === "abierta") undo = { kind: "cancelar_tarea", taskId: task.id }
        group = taskGroup(task.title, pass)
        break
      }
      case "kairos.item_prepared": {
        const item = a.entityId ? items.get(a.entityId) : undefined
        const kind = item?.kind as KairosItemKind | undefined
        words = item && kind ? `Preparó ${ITEM_KIND_WORDS[kind] ?? "algo"}: ${item.title}` : null
        break
      }
      case "kairos.draft_written": {
        const item = a.entityId ? items.get(a.entityId) : undefined
        words = item ? `Redactó «${item.title}»` : null
        break
      }
      case "kairos.client_created":
        words = client ? `Creó el cliente ${client.name} de una cuenta nueva` : null
        break
      case "kairos.client_linked":
        words = client ? `Ligó la cuenta nueva a ${client.name}, el cliente de su solicitud` : null
        break
      case "kairos.email_recorded":
        if (!client) break
        words = `Anotó un correo que llegó de ${client.name}`
        group = { key: "correo", many: (names) => `Anotó correos que llegaron de ${names}`, pass }
        break
      case "kairos.signal": {
        const code = meta(a.metadata, "code") as KairosSignalCode | null
        if (!code || !SIGNAL_WORDS[code] || !client) break
        words = `Avisó que ${client.name}: ${SIGNAL_WORDS[code]}`
        group = {
          key: `senal:${code}`,
          many: (names) => `Avisó que ${SIGNAL_WORDS[code]}: ${names}`,
          pass,
        }
        break
      }
      case "kairos.client_data_filled": {
        const field = meta(a.metadata, "field") as keyof typeof DATA_FIELDS | null
        if (!field || !DATA_FIELDS[field] || !client) break
        words = `Completó ${DATA_FIELDS[field]} de ${client.name}`
        if (client[field] !== null && clientId) undo = { kind: "vaciar_dato", clientId, field }
        group = {
          key: `dato:${field}`,
          many: (names) => `Completó ${DATA_FIELDS[field]} de ${names}`,
          pass,
        }
        break
      }
      case "kairos.summary_written":
        if (!client) break
        words = `Resumió la ficha de ${client.name}`
        group = {
          key: "resumen",
          many: (names, count) => `Resumió ${count} fichas: ${names}`,
          pass,
        }
        break
      case "kairos.load_noticed": {
        const kind = meta(a.metadata, "loadKind") as ClinicLoadRecord["kind"] | null
        const summary = meta(a.metadata, "summary")
        const by = meta(a.metadata, "by")
        if (!kind || !LOAD_WORDS[kind] || !summary || !client) break
        words = `${LOAD_WORDS[kind]} de ${client.name}: ${summary}${by ? ` (lo cargó ${by})` : ""}`
        break
      }
      case "kairos.report_noticed": {
        const number = a.metadata?.number
        if (typeof number !== "number" || !client) break
        const to = meta(a.metadata, "to")
        const how =
          a.metadata?.registered === true
            ? ", por correo aparte; se registró después"
            : a.metadata?.resent === true
              ? ", reenviado"
              : ""
        words = `Salió el informe N.º ${number} de ${client.name}${to ? ` a ${to}` : ""}${how}`
        break
      }
      case "kairos.task_closed": {
        const title = meta(a.metadata, "title")
        const why = meta(a.metadata, "why")
        words = title && why ? `Cerró la tarea «${title}»: ${why}` : null
        break
      }
    }
    if (!words) continue
    out.push({
      id: a.id,
      at: a.at,
      words,
      clientId: client ? (clientId as string) : null,
      clientName: client?.name ?? null,
      undo,
      ...(group ? { group } : {}),
    })
  }
  for (const entry of loose) {
    const task = tasks.get(entry.id)
    if (!task) continue
    const client = clients.get(task.clientId)
    out.push({
      id: task.id,
      at: entry.at,
      words: `Puso la tarea «${task.title}»`,
      clientId: task.clientId,
      clientName: client?.name ?? null,
      undo: task.status === "abierta" ? { kind: "cancelar_tarea", taskId: task.id } : null,
      group: taskGroup(task.title, entry.at.toISOString()),
    })
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit)
}

/**
 * «Lo que hizo» para la pantalla: lo repetido del mismo tipo en una misma
 * pasada va en una frase («Resumió 4 fichas: A, B, C y D»), con cada ficha y
 * su Deshacer adentro. `nextBefore` sigue la página aunque agrupar la acorte.
 */
export async function kairosDonePage(
  tx: Db,
  actor: AdminActor,
  options: { limit?: number; before?: Date } = {},
): Promise<{ items: KairosDoneEntry[]; nextBefore: Date | null }> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200)
  const raw = await kairosDoneRaw(tx, actor, { ...options, limit })
  const items: KairosDoneEntry[] = []
  const groups = new Map<
    string,
    { entry: KairosDoneEntry; group: DoneGroupable; members: KairosDoneMember[] }
  >()
  for (const { group, ...entry } of raw) {
    const member: KairosDoneMember = {
      id: entry.id,
      words: entry.words,
      clientId: entry.clientId,
      clientName: entry.clientName,
      undo: entry.undo,
    }
    const key = group ? `${group.key}@${group.pass}` : null
    const found = key ? groups.get(key) : undefined
    if (found) {
      found.members.push(member)
      continue
    }
    items.push(entry)
    if (key && group) groups.set(key, { entry, group, members: [member] })
  }
  for (const { entry, group, members } of groups.values()) {
    if (members.length < 2) continue
    const names = members.map((m) => m.clientName).filter((name): name is string => Boolean(name))
    // La frase de varias es la más nueva; cada ficha y su Deshacer quedan en `members`.
    entry.words = group.many(namesList(names), new Set(names).size)
    entry.clientId = null
    entry.clientName = null
    entry.undo = null
    entry.members = members
  }
  return { items, nextBefore: raw.length === limit ? (raw.at(-1)?.at ?? null) : null }
}

/* ---------- Hoy ---------- */

export interface TodayTaskRow {
  id: string
  clientId: string
  clientName: string
  product: ClinicalProduct
  kind: SaasTaskKind
  title: string
  dueOn: string
  dueAt: Date | null
  assignee: { userId: string; name: string } | null
  byKairos: boolean
  overdue: boolean
  why: string
  /**
   * «Revisar en Zoho si salió el informe N.º n»: con qué resolverla ahí mismo («Revisé en
   * Zoho: salió» o «No salió: reenviar»). Solo Administración.
   */
  report?: { organizationId: string; number: number; to: string | null; canResend: boolean }
}

type WithWhy<T> = T & { clientId: string | null; why: string }

export interface StaffToday {
  /** Hoy, en Lima. */
  today: string
  /** «2 días hábiles»: el plazo que la web promete para responder una solicitud. */
  answerWithin: string
  /** «Kairós dejó listo»: lo que espera un sí y ya está redactado (los primeros 5) y cuántos hay. */
  kairosReady: { items: KairosItemView[]; total: number }
  /** Las tareas de hoy y las vencidas, mías o de todos. */
  tasks: TodayTaskRow[]
  /** «Se enfrían». */
  cooling: KairosCoolingRow[]
  /** «En riesgo»: solo clientes con cuenta. */
  atRisk: KairosRiskRow[]
  /** Las filas de Inicio de antes, cada una con su cliente y su por qué. */
  prospects: WithWhy<WaitlistHomeRow>[]
  support: WithWhy<SupportHomeRow>[]
  owners: WithWhy<OwnerPendingRow>[]
  /** Solo Administración. */
  expiring: WithWhy<ExpiringTermRow>[]
}

function prospectWhy(row: WaitlistHomeRow, now: Date): string {
  if (row.reason === "por_responder" && row.answer) {
    if (row.answer.due === "vencida") return `Respuesta vencida el ${dayText(row.answer.day)}`
    if (row.answer.due === "hoy") return "Responder hoy"
    return `Responder hasta el ${dayText(row.answer.day)}`
  }
  if (row.reason === "invitacion" && row.inviteExpiresAt) {
    const day = dayText(limaDate(row.inviteExpiresAt))
    return row.inviteExpiresAt <= now
      ? `Su invitación venció el ${day}`
      : `Su invitación vence el ${day}`
  }
  if (row.followUp)
    return row.followUp.overdue
      ? `Tocaba volver a contactarla el ${dayText(row.followUp.on)}`
      : "Toca volver a contactarla hoy"
  return "Espera una respuesta"
}

/**
 * Hoy, para quien entra a la administración: lo que Kairós dejó listo, las
 * tareas de hoy y vencidas (mías o de todos), quién se enfría, quién está en
 * riesgo y, debajo, las filas de Inicio de siempre (con las mismas reglas:
 * `waitlistHomeRows`, `supportHomeRows`, `ownersPendingRows` y, solo
 * Administración, `listExpiringTerms`). Cada fila dice por qué está y de qué
 * cliente es, para abrir su ficha. Vence antes lo que esperó 48 h; nada más
 * se escribe.
 */
export async function todayForStaff(
  tx: Db,
  actor: AdminActor,
  options: { who: "mias" | "todas" },
  now = new Date(),
): Promise<StaffToday> {
  requireStaff(actor)
  if (options.who !== "mias" && options.who !== "todas")
    throw invalidField("who", "Elige «mías» o «todas»")
  const admin = actor.role === "admin"
  const today = limaDate(now)
  await expireKairosItems(tx, now)
  const readyWhere = and(
    eq(kairosItem.status, "espera"),
    admin ? undefined : eq(kairosItem.adminOnly, false),
    sql`(${kairosItem.kind} not in ('mensaje', 'guion') or coalesce(${kairosItem.payload} -> 'draft', 'null'::jsonb) <> 'null'::jsonb)`,
  )
  const ready = await tx
    .select({
      item: kairosItem,
      clientName: saasClient.name,
      product: saasClient.product,
      decidedByName: decider.name,
    })
    .from(kairosItem)
    .leftJoin(saasClient, eq(saasClient.id, kairosItem.clientId))
    .leftJoin(decider, eq(decider.id, kairosItem.decidedBy))
    .where(readyWhere)
    .orderBy(asc(kairosItem.expiresAt), asc(kairosItem.id))
    .limit(READY_ON_TODAY)
  const [readyCount] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(kairosItem)
    .where(readyWhere)

  const assignee = alias(user, "task_assignee")
  const taskRows = await tx
    .select({
      task: saasTask,
      clientName: saasClient.name,
      product: saasClient.product,
      organizationId: saasClient.organizationId,
      assigneeName: assignee.name,
    })
    .from(saasTask)
    .innerJoin(saasClient, eq(saasClient.id, saasTask.clientId))
    .leftJoin(assignee, eq(assignee.id, saasTask.assigneeUserId))
    .where(
      and(
        eq(saasTask.status, "abierta"),
        lte(saasTask.dueOn, today),
        sql`${saasClient.archivedAt} is null`,
        options.who === "mias" ? eq(saasTask.assigneeUserId, actor.userId) : undefined,
        admin ? undefined : ne(saasTask.kind, "cobro"),
      ),
    )
    .orderBy(asc(saasTask.dueOn), sql`${saasTask.dueAt} asc nulls last`, asc(saasTask.createdAt))
  // Los informes de las tareas «Revisar en Zoho…», leídos del registro (solo Administración).
  const reportsOf = new Map<string, ProgressReportRecord[]>()
  if (admin)
    for (const { task, organizationId } of taskRows)
      if (
        organizationId &&
        task.byKairos &&
        unknownReportNumberOf(task.kairosKey) !== null &&
        !reportsOf.has(organizationId)
      )
        reportsOf.set(organizationId, await listProgressReports(tx, organizationId))
  const tasks: TodayTaskRow[] = taskRows.map(
    ({ task, clientName, product, organizationId, assigneeName }) => {
      const overdue = task.dueOn < today || (task.dueAt !== null && task.dueAt < now)
      const when =
        task.dueOn < today
          ? `Vencida desde el ${dayText(task.dueOn)}`
          : task.dueAt
            ? `${task.dueAt < now ? "Era hoy" : "Hoy"} a las ${timeText(task.dueAt)}`
            : "Para hoy"
      const reportNumber = task.byKairos ? unknownReportNumberOf(task.kairosKey) : null
      const found =
        admin && reportNumber !== null && organizationId
          ? reportsOf.get(organizationId)?.find((item) => item.number === reportNumber)
          : undefined
      // Solo mientras siga sin saberse: si ya salió, la tarea se cierra en la próxima pasada.
      const report =
        found && organizationId && found.state === "desconocido"
          ? {
              organizationId,
              number: found.number,
              to: found.to,
              canResend: Boolean(found.pdfKey && found.mail && found.to),
            }
          : null
      return {
        id: task.id,
        clientId: task.clientId,
        clientName,
        product: productOf(product),
        kind: task.kind as SaasTaskKind,
        title: task.title,
        dueOn: task.dueOn,
        dueAt: task.dueAt,
        assignee: task.assigneeUserId
          ? { userId: task.assigneeUserId, name: assigneeName ?? "Sin nombre" }
          : null,
        byKairos: task.byKairos,
        overdue,
        why: task.byKairos ? `${when} · La puso Kairós` : when,
        ...(report ? { report } : {}),
      }
    },
  )
  // Lo urgente (un informe que no se sabe si salió) y lo vencido, arriba.
  tasks.sort(
    (a, b) =>
      Number(Boolean(b.report)) - Number(Boolean(a.report)) ||
      Number(b.overdue) - Number(a.overdue),
  )

  const cooling = await kairosCoolingRows(tx, actor, now)
  const atRisk = await kairosRiskRows(tx, actor, now)

  const prospects = await waitlistHomeRows(tx, actor, now)
  const support = await supportHomeRows(tx, actor, now)
  const owners = await ownersPendingRows(tx, now)
  const expiring = admin ? await listExpiringTerms(tx, now) : []
  const { waitlistAnswerDays } = await currentSaasTerms(tx, now)

  const requestIds = prospects.map((row) => row.id)
  const requestClients = new Map(
    (requestIds.length
      ? await rows<{ id: string; client_id: string | null }>(
          tx,
          sql`select id, client_id from saas_waitlist_request where id in (${sql.join(
            requestIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        )
      : []
    ).map((row) => [row.id, row.client_id]),
  )
  const orgIds = [
    ...new Set([
      ...support.map((row) => row.organizationId),
      ...owners.map((row) => row.organizationId),
      ...expiring.map((row) => row.organizationId),
    ]),
  ].filter((id): id is string => Boolean(id))
  const orgClients = new Map(
    (orgIds.length
      ? await tx
          .select({ id: saasClient.id, organizationId: saasClient.organizationId })
          .from(saasClient)
          .where(inArray(saasClient.organizationId, orgIds))
      : []
    ).map((row) => [row.organizationId as string, row.id]),
  )
  const clientOfOrg = (orgId: string | null) => (orgId ? (orgClients.get(orgId) ?? null) : null)

  return {
    today,
    answerWithin: businessDaysWords(waitlistAnswerDays),
    kairosReady: { items: ready.map(toItemView), total: readyCount?.n ?? 0 },
    tasks,
    cooling,
    atRisk,
    prospects: prospects.map((row) => ({
      ...row,
      clientId: requestClients.get(row.id) ?? null,
      why: prospectWhy(row, now),
    })),
    support: support.map((row) => ({
      ...row,
      clientId: clientOfOrg(row.organizationId),
      why: row.answerBy
        ? `Responder hasta el ${dayText(limaDate(new Date(row.answerBy)))}`
        : `Nos espera desde el ${dayText(limaDate(new Date(row.waitingSince)))}`,
    })),
    owners: owners.map((row) => ({
      ...row,
      clientId: clientOfOrg(row.organizationId),
      why: `La propietaria no aceptó; su invitación ${row.expiresAt <= now ? "venció" : "vence"} el ${dayText(limaDate(row.expiresAt))}`,
    })),
    expiring: expiring.map((row) => ({
      ...row,
      clientId: clientOfOrg(row.organizationId),
      why:
        row.kind === "precio_especial"
          ? `Su precio especial termina el ${dayText(limaDate(row.endsAt))}`
          : `Sus condiciones de Fundadora terminan el ${dayText(limaDate(row.endsAt))}`,
    })),
  }
}

/* ---------- Gasto del modelo ---------- */

export interface KairosAiUseInput {
  purpose: KairosAiPurpose
  model: string
  inputTokens?: number | null
  outputTokens?: number | null
  cachedTokens?: number | null
  /** Nulo si el modelo no tiene precio conocido: nunca un precio supuesto. */
  costMicros?: number | null
  clientId?: string | null
}

/** Lo que gastó Kairós en el modelo: gasto de Sallca, nunca en la cuenta de una clínica. */
export async function recordKairosAiUse(tx: Db, input: KairosAiUseInput): Promise<{ id: string }> {
  if (!(KAIROS_AI_PURPOSES as readonly string[]).includes(input.purpose))
    throw invalidField("purpose", "Para qué se usó el modelo no es válido")
  const model = input.model?.trim() ?? ""
  if (!model || model.length > 120) throw invalidField("model", "Falta el modelo")
  const count = (field: string, value: number | null | undefined): number | null => {
    if (value === undefined || value === null) return null
    if (!Number.isSafeInteger(value) || value < 0)
      throw invalidField(field, "Debe ser un entero de 0 o más")
    return value
  }
  if (input.clientId !== undefined && input.clientId !== null && !UUID.test(input.clientId))
    throw invalidField("clientId", "El cliente no es válido")
  const [row] = await tx
    .insert(kairosAiUsage)
    .values({
      purpose: input.purpose,
      model,
      inputTokens: count("inputTokens", input.inputTokens),
      outputTokens: count("outputTokens", input.outputTokens),
      cachedTokens: count("cachedTokens", input.cachedTokens),
      costMicros: count("costMicros", input.costMicros),
      clientId: input.clientId ?? null,
    })
    .returning({ id: kairosAiUsage.id })
  if (!row) throw new ServiceError("INTERNAL", 500, "No se anotó el gasto del modelo")
  return row
}

/** Lo que el escritor de Kairós informa de cada llamada (`onUse` de `createKairosWriter`). */
export interface KairosAiUseReport extends Omit<KairosAiUseInput, "purpose"> {
  purpose: string
}

/**
 * El `onUse` del escritor de Kairós, el mismo en la API y en el worker: anota
 * cada llamada al modelo en su propia transacción (`recordKairosAiUse`).
 */
export function kairosAiUseRecorder(ownerDb: Db): (use: KairosAiUseReport) => Promise<void> {
  return async (use) => {
    await ownerDb.transaction((tx) =>
      recordKairosAiUse(tx as Db, { ...use, purpose: use.purpose as KairosAiPurpose }),
    )
  }
}
