import type { Db } from "@odentia/db"
import { type AgentAdvisorSettings, agentConfig, crmTask } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import type { AutomationKind } from "@odentia/db/schema/automation"
import { and, eq, sql } from "drizzle-orm"
import { CHECKUP_REMINDER_WINDOW_HOURS, listRules } from "./automation.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { getOrgLocale, type OrgLocale } from "./locale.js"
import { createTask } from "./tasks.js"

/* ---------- Asesor: qué conviene atender primero, con la lista que lo respalda ---------- */

/**
 * El asesor no usa un modelo: cada detección es una consulta a la base de
 * datos. Así cada cifra se puede mostrar con su lista y cómo se calculó, y un
 * número nunca sale de un texto generado. Solo recomienda: la acción queda
 * lista y la ejecuta una persona.
 */
export const ADVISOR_MAX_RECOMMENDATIONS = 3
/** Filas que viajan en el detalle; el total real va aparte. */
const ADVISOR_LIST_LIMIT = 200
const ADVISOR_PREVIEW_ITEMS = 4

export interface AdvisorDetection {
  key: string
  /** Área de la clínica, como rótulo de la tarjeta. */
  area: string
  label: string
  description: string
  /** Permiso que necesita quien la lee: el asesor no enseña lo que su rol no ve. */
  permission: string
  /** Umbral de días por defecto, cuando la detección lo tiene. */
  defaultDays: number | null
  /** Título de la tarea que se crea por cada persona de la lista. */
  taskTitle: (item: AdvisorItem) => string
  /** Cómo se llama esa tarea en el botón: «tarea de llamada», «tarea». */
  taskNoun: { one: string; many: string }
  /**
   * Automatización real que evita que la lista vuelva a llenarse, si existe.
   * El asesor solo la ofrece: encenderla es la operación de Automatizaciones,
   * la pide una persona y exige su permiso (`crm.write`).
   */
  automation: { kind: AutomationKind; label: string; shortLabel: string; reach: string } | null
}

const CALL_TASK = { one: "tarea de llamada", many: "tareas de llamada" }
const PLAIN_TASK = { one: "tarea", many: "tareas" }

/** Lo que el asesor sabe de la automatización ligada a una recomendación. */
export interface AdvisorAutomation {
  kind: AutomationKind
  /** «recordatorio de control»: nombre para «Encender el …». */
  label: string
  shortLabel: string
  /** A quién escribe y a quién no, tal como funciona hoy la regla. */
  reach: string
  /** Regla que se enciende; null si la clínica todavía no la tiene. */
  ruleId: string | null
  enabled: boolean
  channel: string
}

export interface AdvisorItem {
  id: string
  /** Paciente o contacto al que se refiere. */
  personName: string
  line: string
  patientId: string | null
  contactId: string | null
  opportunityId: string | null
}

export interface AdvisorRecommendation {
  key: string
  area: string
  title: string
  detail: string
  /** Cómo se calculó, en palabras, con el umbral usado. */
  how: string
  total: number
  /** Primeras filas, para la tarjeta; el detalle trae hasta el tope. */
  items: AdvisorItem[]
  days: number | null
  /** Momento del cálculo: los datos son de ahora, no de una foto antigua. */
  computedAt: string
  taskNoun: { one: string; many: string }
  /** Solo para quien puede ver las automatizaciones (`crm.read`). */
  automation: AdvisorAutomation | null
}

export const ADVISOR_DETECTIONS: readonly AdvisorDetection[] = [
  {
    key: "controles_vencidos",
    area: "Controles",
    label: "Controles vencidos",
    description: "Pacientes con un control pendiente que ya pasó su fecha y sin una cita futura.",
    permission: "appointments.read",
    defaultDays: null,
    taskTitle: (item) => `Llamar a ${item.personName} para agendar su control`,
    taskNoun: CALL_TASK,
    automation: {
      kind: "recordatorio_control",
      label: "recordatorio de control",
      shortLabel: "recordatorio",
      // La regla avisa antes de la fecha (`syncCheckupReminders`); no escribe a quien ya la pasó.
      reach: `a quien tiene un control en las próximas ${CHECKUP_REMINDER_WINDOW_HOURS} horas y dio su consentimiento para recordatorios. No escribe a quienes ya se les pasó la fecha`,
    },
  },
  {
    key: "presupuestos_sin_cita",
    area: "Presupuestos",
    label: "Presupuestos sin cita",
    description: "Presupuestos aceptados hace días y cuyo paciente no tiene una cita futura.",
    permission: "appointments.read",
    defaultDays: 7,
    taskTitle: (item) => `Llamar a ${item.personName} para agendar su tratamiento`,
    taskNoun: CALL_TASK,
    // «Seguimiento de presupuesto» escribe por presupuestos presentados sin decisión, no por los aceptados sin cita.
    automation: null,
  },
  {
    key: "atenciones_sin_firmar",
    area: "Atenciones",
    label: "Atenciones sin firmar",
    description: "Atenciones que siguen en borrador desde un día anterior.",
    permission: "clinical.read",
    defaultDays: null,
    taskTitle: (item) => `Revisar y firmar la atención de ${item.personName}`,
    taskNoun: PLAIN_TASK,
    automation: null,
  },
  {
    key: "seguimientos_sin_responsable",
    area: "Seguimiento",
    label: "Seguimientos sin responsable",
    description: "Oportunidades abiertas que nadie del equipo lleva.",
    permission: "crm.read",
    defaultDays: null,
    taskTitle: (item) => `Asignar responsable al seguimiento de ${item.personName}`,
    taskNoun: PLAIN_TASK,
    automation: null,
  },
  {
    key: "cobranza_vencida",
    area: "Cobranza",
    label: "Cobranza vencida",
    description: "Cuotas con saldo que ya pasaron su fecha.",
    permission: "finance.read",
    defaultDays: null,
    taskTitle: (item) => `Llamar a ${item.personName} por su cuota vencida`,
    taskNoun: CALL_TASK,
    automation: null,
  },
] as const

function detectionOf(key: string): AdvisorDetection {
  const detection = ADVISOR_DETECTIONS.find((item) => item.key === key)
  if (!detection) throw notFound("Recomendación")
  return detection
}

/* ---------- Ajustes ---------- */

export interface AdvisorSettings {
  enabled: boolean
  detections: Array<{
    key: string
    area: string
    label: string
    description: string
    on: boolean
    days: number | null
    defaultDays: number | null
    snoozedUntil: string | null
  }>
}

async function rawSettings(tx: Db, orgId: string): Promise<AgentAdvisorSettings> {
  const [row] = await tx.select({ advisor: agentConfig.advisor }).from(agentConfig).where(eq(agentConfig.organizationId, orgId)).limit(1)
  return row?.advisor ?? {}
}

function describeSettings(raw: AgentAdvisorSettings, now: Date): AdvisorSettings {
  return {
    enabled: raw.enabled === true,
    detections: ADVISOR_DETECTIONS.map((detection) => {
      const own = raw.detections?.[detection.key] ?? {}
      const snoozed = own.snoozedUntil && new Date(own.snoozedUntil) > now ? own.snoozedUntil : null
      return {
        key: detection.key,
        area: detection.area,
        label: detection.label,
        description: detection.description,
        on: own.off !== true,
        days: detection.defaultDays === null ? null : (own.days ?? detection.defaultDays),
        defaultDays: detection.defaultDays,
        snoozedUntil: snoozed,
      }
    }),
  }
}

export async function getAdvisorSettings(tx: Db, orgId: string): Promise<AdvisorSettings> {
  return describeSettings(await rawSettings(tx, orgId), new Date())
}

export interface UpdateAdvisorInput {
  enabled?: boolean
  detections?: Record<string, { on?: boolean; days?: number | null; snoozeDays?: number | null }>
}

/** Enciende o apaga el asesor y cada detección; cambia su umbral o la pospone. */
export async function updateAdvisorSettings(tx: Db, orgId: string, actorUserId: string, input: UpdateAdvisorInput): Promise<AdvisorSettings> {
  const current = await rawSettings(tx, orgId)
  const next: AgentAdvisorSettings = { enabled: input.enabled ?? current.enabled === true, detections: { ...(current.detections ?? {}) } }
  for (const [key, change] of Object.entries(input.detections ?? {})) {
    const detection = detectionOf(key)
    const own = { ...(next.detections?.[key] ?? {}) }
    if (change.on !== undefined) {
      if (change.on) delete own.off
      else own.off = true
    }
    if (change.days !== undefined) {
      if (detection.defaultDays === null) throw validation(`«${detection.label}» no tiene un umbral de días`)
      if (change.days === null) delete own.days
      else {
        if (!Number.isInteger(change.days) || change.days < 1 || change.days > 365) throw validation("El umbral va de 1 a 365 días")
        own.days = change.days
      }
    }
    if (change.snoozeDays !== undefined) {
      if (change.snoozeDays === null) delete own.snoozedUntil
      else {
        if (!Number.isInteger(change.snoozeDays) || change.snoozeDays < 1 || change.snoozeDays > 90) throw validation("Se pospone entre 1 y 90 días")
        own.snoozedUntil = new Date(Date.now() + change.snoozeDays * 86_400_000).toISOString()
      }
    }
    next.detections = { ...next.detections, [key]: own }
  }
  await tx
    .insert(agentConfig)
    .values({ organizationId: orgId, advisor: next })
    .onConflictDoUpdate({ target: agentConfig.organizationId, set: { advisor: next, updatedAt: new Date() } })
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "agent.advisor_updated",
    entity: "agent_config",
    entityId: orgId,
    metadata: { enabled: next.enabled, changed: Object.keys(input.detections ?? {}) },
  })
  return describeSettings(next, new Date())
}

/* ---------- Detecciones ---------- */

interface DetectionResult {
  total: number
  items: AdvisorItem[]
  title: string
  detail: string
  how: string
}

const dayOf = (value: Date | string, zone: OrgLocale) =>
  new Date(value).toLocaleDateString(zone.locale, { timeZone: zone.timezone, day: "numeric", month: "long" })
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** Sin cita futura: ninguna cita programada o confirmada desde ahora. */
const NO_FUTURE_APPOINTMENT = sql`not exists (
  select 1 from appointment a
  where a.organization_id = p.organization_id and a.patient_id = p.id
    and a.starts_at > now() and a.status in ('programada', 'confirmada'))`

async function overdueControls(tx: Db, orgId: string, zone: OrgLocale): Promise<DetectionResult> {
  const rows = await tx.execute<{ id: string; patient_id: string; name: string; title: string; due_at: Date | string; total: number; old: number }>(sql`
    select f.id, p.id as patient_id, p.display_name as name, f.title, f.due_at,
           count(*) over ()::int as total,
           (count(*) filter (where f.due_at < now() - interval '30 days') over ())::int as old
    from clinical_follow_up f
    join patient p on p.id = f.patient_id and p.organization_id = f.organization_id
    where f.organization_id = ${orgId} and f.status = 'pendiente' and f.due_at < now()
      and p.is_active and ${NO_FUTURE_APPOINTMENT}
    order by f.due_at asc
    limit ${ADVISOR_LIST_LIMIT}`)
  const total = Number(rows[0]?.total ?? 0)
  const old = Number(rows[0]?.old ?? 0)
  return {
    total,
    items: rows.map((row) => ({
      id: row.id,
      personName: row.name,
      line: `${row.title} · venció el ${dayOf(row.due_at, zone)}`,
      patientId: row.patient_id,
      contactId: null,
      opportunityId: null,
    })),
    title: `${total} ${plural(total, "control vencido de un paciente sin cita", "controles vencidos de pacientes sin cita")}`,
    detail: old > 0 ? `${old} ${plural(old, "venció", "vencieron")} hace más de 30 días.` : "Todos vencieron en los últimos 30 días.",
    how: "Controles pendientes con fecha vencida, de pacientes activos que no tienen una cita programada o confirmada desde ahora.",
  }
}

async function budgetsWithoutAppointment(tx: Db, orgId: string, zone: OrgLocale, days: number): Promise<DetectionResult> {
  const rows = await tx.execute<{ id: string; patient_id: string; name: string; title: string; number: number; decided_at: Date | string; total: number }>(sql`
    select b.id, p.id as patient_id, p.display_name as name, b.title, b.budget_number as number, b.decided_at,
           count(*) over ()::int as total
    from treatment_budget b
    join patient p on p.id = b.patient_id and p.organization_id = b.organization_id
    where b.organization_id = ${orgId} and b.status in ('aceptado', 'parcial')
      and b.decided_at < now() - make_interval(days => ${days})
      and p.is_active and ${NO_FUTURE_APPOINTMENT}
    order by b.decided_at asc
    limit ${ADVISOR_LIST_LIMIT}`)
  const total = Number(rows[0]?.total ?? 0)
  return {
    total,
    items: rows.map((row) => ({
      id: row.id,
      personName: row.name,
      // Sin importes: quien agenda ve el presupuesto mínimo, no sus líneas.
      line: `Presupuesto N.º ${row.number} · ${row.title} · aceptado el ${dayOf(row.decided_at, zone)}`,
      patientId: row.patient_id,
      contactId: null,
      opportunityId: null,
    })),
    title: `${total} ${plural(total, "presupuesto aceptado", "presupuestos aceptados")} hace más de ${days} días, sin cita`,
    detail: "El paciente aceptó y todavía no tiene fecha para empezar.",
    how: `Presupuestos aceptados (del todo o en parte) hace más de ${days} días, de pacientes activos que no tienen una cita programada o confirmada desde ahora.`,
  }
}

async function unsignedEncounters(tx: Db, orgId: string, zone: OrgLocale): Promise<DetectionResult> {
  const rows = await tx.execute<{ id: string; patient_id: string; name: string; dentist: string | null; started_at: Date | string; total: number }>(sql`
    select e.id, p.id as patient_id, p.display_name as name, u.name as dentist, e.started_at,
           count(*) over ()::int as total
    from encounter e
    join patient p on p.id = e.patient_id and p.organization_id = e.organization_id
    left join "user" u on u.id = e.dentist_user_id
    where e.organization_id = ${orgId} and e.status = 'borrador'
      and e.started_at < date_trunc('day', now() at time zone ${zone.timezone}) at time zone ${zone.timezone}
    order by e.started_at asc
    limit ${ADVISOR_LIST_LIMIT}`)
  const total = Number(rows[0]?.total ?? 0)
  const byDentist = new Map<string, number>()
  for (const row of rows) byDentist.set(row.dentist ?? "Sin profesional", (byDentist.get(row.dentist ?? "Sin profesional") ?? 0) + 1)
  const who = [...byDentist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => `${name} tiene ${n}`)
  return {
    total,
    items: rows.map((row) => ({
      id: row.id,
      personName: row.name,
      line: `${row.dentist ?? "Sin profesional"} · abierta desde el ${dayOf(row.started_at, zone)}`,
      patientId: row.patient_id,
      contactId: null,
      opportunityId: null,
    })),
    title: `${total} ${plural(total, "atención en borrador", "atenciones en borrador")} desde un día anterior, sin firmar`,
    detail: who.length ? `${who.join(" y ")}.` : "",
    how: "Atenciones que siguen en borrador y se abrieron antes de hoy. Una atención sin firmar no forma parte de la historia.",
  }
}

async function followUpsWithoutOwner(tx: Db, orgId: string, zone: OrgLocale): Promise<DetectionResult> {
  const rows = await tx.execute<{ id: string; contact_id: string; name: string; title: string; next_action_at: Date | string | null; total: number; due: number }>(sql`
    select o.id, c.id as contact_id, c.display_name as name, o.title, o.next_action_at,
           count(*) over ()::int as total,
           (count(*) filter (where o.next_action_at < now()) over ())::int as due
    from opportunity o
    join contact c on c.id = o.contact_id and c.organization_id = o.organization_id
    where o.organization_id = ${orgId} and o.status = 'open' and o.assigned_user_id is null
    order by o.next_action_at asc nulls last, o.created_at asc
    limit ${ADVISOR_LIST_LIMIT}`)
  const total = Number(rows[0]?.total ?? 0)
  const due = Number(rows[0]?.due ?? 0)
  return {
    total,
    items: rows.map((row) => ({
      id: row.id,
      personName: row.name,
      line: `${row.title}${row.next_action_at ? ` · próxima acción el ${dayOf(row.next_action_at, zone)}` : " · sin próxima acción"}`,
      patientId: null,
      contactId: row.contact_id,
      opportunityId: row.id,
    })),
    title: `${total} ${plural(total, "seguimiento abierto", "seguimientos abiertos")} sin responsable`,
    detail: due > 0 ? `${due} ${plural(due, "tiene", "tienen")} la próxima acción vencida.` : "Ninguno tiene la próxima acción vencida todavía.",
    how: "Oportunidades abiertas que no tienen a nadie del equipo asignado.",
  }
}

async function overdueCollections(tx: Db, orgId: string, zone: OrgLocale): Promise<DetectionResult> {
  const rows = await tx.execute<{ id: string; patient_id: string; name: string; nro: number; due_at: string; owed: number; currency: string; total: number }>(sql`
    select q.id, p.id as patient_id, p.display_name as name, q.nro, q.due_at::text as due_at,
           (q.amount_cents - q.paid_cents)::int as owed, pl.currency,
           count(*) over ()::int as total
    from installment_quota q
    join installment_plan pl on pl.id = q.plan_id and pl.organization_id = q.organization_id
    join patient p on p.id = pl.patient_id and p.organization_id = pl.organization_id
    where q.organization_id = ${orgId} and pl.status = 'vigente'
      and q.status in ('pendiente', 'parcial', 'vencida') and q.amount_cents > q.paid_cents
      and q.due_at < (now() at time zone ${zone.timezone})::date
    order by q.due_at asc
    limit ${ADVISOR_LIST_LIMIT}`)
  const total = Number(rows[0]?.total ?? 0)
  const people = new Set(rows.map((row) => row.patient_id)).size
  return {
    total,
    items: rows.map((row) => ({
      id: row.id,
      personName: row.name,
      // La fecha es un día de calendario: se muestra tal cual, sin pasarla por la zona.
      line: `Cuota ${row.nro} · venció el ${dayOf(`${row.due_at}T12:00:00Z`, { ...zone, timezone: "UTC" })} · debe ${(row.owed / 100).toFixed(2)} ${row.currency}`,
      patientId: row.patient_id,
      contactId: null,
      opportunityId: null,
    })),
    title: `${total} ${plural(total, "cuota vencida", "cuotas vencidas")} con saldo`,
    detail: `De ${people} ${plural(people, "paciente", "pacientes")}${total > rows.length ? " (entre los primeros de la lista)" : ""}.`,
    how: "Cuotas de planes vigentes con saldo por pagar y fecha anterior a hoy.",
  }
}

async function runDetection(tx: Db, orgId: string, key: string, zone: OrgLocale, days: number | null): Promise<DetectionResult> {
  if (key === "controles_vencidos") return overdueControls(tx, orgId, zone)
  if (key === "presupuestos_sin_cita") return budgetsWithoutAppointment(tx, orgId, zone, days ?? 7)
  if (key === "atenciones_sin_firmar") return unsignedEncounters(tx, orgId, zone)
  if (key === "seguimientos_sin_responsable") return followUpsWithoutOwner(tx, orgId, zone)
  if (key === "cobranza_vencida") return overdueCollections(tx, orgId, zone)
  throw notFound("Recomendación")
}

/**
 * Estado de la automatización de una detección, leído con el mismo listado de
 * reglas que usa Automatizaciones. No cambia nada: encender es de esa pantalla.
 */
async function automationOf(tx: Db, orgId: string, detection: AdvisorDetection, can: (permission: string) => boolean): Promise<AdvisorAutomation | null> {
  if (!detection.automation || !can("crm.read")) return null
  const rules = (await listRules(tx, orgId)).filter((rule) => rule.kind === detection.automation?.kind)
  const active = rules.find((rule) => rule.enabled)
  const rule = active ?? rules[0]
  return { ...detection.automation, ruleId: rule?.id ?? null, enabled: active !== undefined, channel: rule?.channel ?? "whatsapp" }
}

function toRecommendation(
  detection: AdvisorDetection,
  result: DetectionResult,
  days: number | null,
  limit: number,
  automation: AdvisorAutomation | null,
): AdvisorRecommendation {
  // Apagada, nadie recibe el aviso previo: se dice en la tarjeta, como dato y no como causa.
  const off = automation && !automation.enabled ? `El ${automation.label} está apagado.` : ""
  return {
    key: detection.key,
    area: detection.area,
    title: result.title,
    detail: [off, result.detail].filter(Boolean).join(" "),
    taskNoun: detection.taskNoun,
    automation,
    how: result.how,
    total: result.total,
    items: result.items.slice(0, limit),
    days,
    computedAt: new Date().toISOString(),
  }
}

export interface AdvisorView {
  enabled: boolean
  recommendations: AdvisorRecommendation[]
  /** Cuántas más hay además de las mostradas. */
  more: number
}

/**
 * Lo que el asesor recomienda atender, para quien lo lee: solo las detecciones
 * encendidas, sin posponer, que su rol puede ver y que hoy encuentran algo. A
 * lo sumo tres a la vez, en orden fijo. `preview` ignora el interruptor
 * general: es la vista previa antes de encenderlo.
 */
export async function getAdvisorRecommendations(
  tx: Db,
  orgId: string,
  can: (permission: string) => boolean,
  opts: { preview?: boolean; all?: boolean } = {},
): Promise<AdvisorView> {
  const settings = await getAdvisorSettings(tx, orgId)
  if (!settings.enabled && !opts.preview) return { enabled: false, recommendations: [], more: 0 }
  const zone = await getOrgLocale(tx, orgId)
  const found: AdvisorRecommendation[] = []
  for (const detection of ADVISOR_DETECTIONS) {
    const own = settings.detections.find((item) => item.key === detection.key)
    if (!own?.on || own.snoozedUntil || !can(detection.permission)) continue
    const result = await runDetection(tx, orgId, detection.key, zone, own.days)
    if (result.total > 0) found.push(toRecommendation(detection, result, own.days, ADVISOR_PREVIEW_ITEMS, await automationOf(tx, orgId, detection, can)))
  }
  const shown = opts.all ? found : found.slice(0, ADVISOR_MAX_RECOMMENDATIONS)
  return { enabled: settings.enabled, recommendations: shown, more: found.length - shown.length }
}

/** Una recomendación con su lista completa (hasta el tope), para revisar y decidir. */
export async function getAdvisorRecommendation(
  tx: Db,
  orgId: string,
  can: (permission: string) => boolean,
  key: string,
): Promise<AdvisorRecommendation> {
  const detection = detectionOf(key)
  if (!can(detection.permission)) throw new ServiceError("FORBIDDEN", 403, "Tu rol no puede ver esta recomendación")
  const settings = await getAdvisorSettings(tx, orgId)
  const own = settings.detections.find((item) => item.key === key)
  const zone = await getOrgLocale(tx, orgId)
  const days = own?.days ?? detection.defaultDays
  return toRecommendation(detection, await runDetection(tx, orgId, key, zone, days), days, ADVISOR_LIST_LIMIT, await automationOf(tx, orgId, detection, can))
}

/**
 * La acción preparada: una tarea por cada persona de la lista. La pide una
 * persona, nunca el asesor por su cuenta. Repetirla el mismo día no duplica
 * tareas: cada una lleva una clave por detección, fila y día.
 */
export async function createAdvisorTasks(
  tx: Db,
  orgId: string,
  actorUserId: string,
  can: (permission: string) => boolean,
  key: string,
): Promise<{ created: number; total: number }> {
  const detection = detectionOf(key)
  if (!can(detection.permission)) throw new ServiceError("FORBIDDEN", 403, "Tu rol no puede ver esta recomendación")
  const recommendation = await getAdvisorRecommendation(tx, orgId, can, key)
  const zone = await getOrgLocale(tx, orgId)
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone.timezone }).format(new Date())
  let created = 0
  for (const item of recommendation.items) {
    const idempotencyKey = `asesor:${key}:${item.id}:${today}`
    const [existing] = await tx
      .select({ id: crmTask.id })
      .from(crmTask)
      .where(and(eq(crmTask.organizationId, orgId), eq(crmTask.idempotencyKey, idempotencyKey)))
      .limit(1)
    if (existing) continue
    await createTask(tx, orgId, {
      title: detection.taskTitle(item).slice(0, 200),
      patientId: item.patientId,
      contactId: item.contactId,
      opportunityId: item.opportunityId,
      createdBy: "user",
      actorUserId,
      idempotencyKey,
    })
    created += 1
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "agent.advisor_tasks_created",
    entity: "agent_config",
    entityId: orgId,
    metadata: { key, created, total: recommendation.items.length },
  })
  return { created, total: recommendation.items.length }
}
