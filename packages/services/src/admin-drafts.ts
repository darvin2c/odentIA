import type { Db } from "@odentia/db"
import { type AutomationDraft, automationJob, automationRule } from "@odentia/db/schema/automation"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, inArray, type SQL, sql } from "drizzle-orm"
import {
  type AdminLine,
  type AdminLineKey,
  adminLineOf,
  describeLine,
  flowOf,
  type LineFlow,
  type LineTiming,
  say,
  TASK_AREA_LABELS,
} from "./admin-lines.js"
import { type AdminChanges, type AdminInterpretation, OUT_OF_REACH } from "./admin-request.js"
import {
  adminRuntime,
  findLineRule,
  lineConfigOf,
  lineDays,
  lineTiming,
  type RuleRow,
  setLine,
  type SetLineInput,
  TASK_NOTE_CHARS,
} from "./automation.js"
import { AUTOMATION_MESSAGES, automationMessageOf, MESSAGE_VARIABLES, renderMessage } from "./automation-messages.js"
import { findMessageTemplate } from "./channel-templates.js"
import { notFound, ServiceError, validation } from "./errors.js"

/* ---------- Pedírselo con palabras: del pedido al borrador ---------- */

/**
 * Un pedido entendido nunca cambia nada: queda como **borrador** en su línea,
 * con el flujo que resultaría, una prueba con los últimos 30 días y lo que se
 * revisó. Una persona lo prende, lo guarda o lo descarta; mientras tanto la
 * línea sigue como estaba.
 *
 * Aquí no se llama a ningún modelo. La interpretación llega ya hecha
 * (`interpretAdminRequest`) y todo lo demás —las cifras de la prueba, la
 * revisión, los textos— sale de consultas y del catálogo.
 */

export interface AdminRequestResult {
  /** Se reconoció de qué línea se habla y qué se quiere. */
  understood: boolean
  /** Línea a la que fue a parar el pedido, para abrirla. */
  key: AdminLineKey | null
  /** Hay un borrador nuevo esperando en esa línea. */
  draft: boolean
  /** Lo que se le responde cuando no queda un borrador. */
  message: string | null
  /** Pidió eliminar una línea creada por la clínica: la pantalla lo confirma antes. */
  confirmDelete: boolean
  /** Para medir: quién entendió el pedido y cuánto costó. */
  model: string | null
  usage: { inputTokens: number; outputTokens: number } | null
}

/** Lo que se dice cuando el pedido no encaja en ninguna pieza: sin inventar una. */
export const ADMIN_NOT_UNDERSTOOD =
  "No reconocí una línea en lo que pides. Aquí solo armo lo que el sistema ya sabe hacer: prender, apagar o ajustar una línea de esta página, o crear la de «una persona cancela su cita». Si necesitas otra cosa, envíala como pedido desde Ayuda."

/** Lo que se dice cuando el modelo no responde: lo prendido sigue funcionando. */
export const ADMIN_MODEL_DOWN =
  "Ahora no puedo leer pedidos con palabras. Lo que tienes prendido sigue funcionando y los interruptores también: puedes hacer el cambio a mano."

interface LineState {
  enabled: boolean
  agentPart: boolean
  teamPart: boolean
  days: number | null
  timing: LineTiming
  taskNote: string | null
}

function stateOf(line: AdminLine, rule: RuleRow | null): LineState {
  return {
    enabled: rule?.enabled ?? false,
    agentPart: line.agent ? (rule?.agentPart ?? true) : false,
    teamPart: rule?.teamPart ?? true,
    days: lineDays(rule, line.key),
    timing: lineTiming(rule),
    taskNote: lineConfigOf(rule?.config).taskNote ?? null,
  }
}

function applyChanges(line: AdminLine, state: LineState, changes: AutomationDraft["changes"]): LineState {
  const timing: LineTiming = { ...state.timing }
  if (changes.hoursBefore) timing.hoursBefore = changes.hoursBefore
  if (changes.delayHours !== undefined) timing.delayHours = changes.delayHours
  if (changes.hour !== undefined) timing.hour = changes.hour
  return {
    enabled: changes.enabled ?? state.enabled,
    agentPart: line.agent ? (changes.agentPart ?? state.agentPart) : false,
    teamPart: line.key === "seguimiento_comercial" ? true : (changes.teamPart ?? state.teamPart),
    days: changes.days ?? state.days,
    timing,
    taskNote: changes.taskNote ?? state.taskNote,
  }
}

const same = (a: readonly number[] | undefined, b: readonly number[] | undefined) =>
  JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort())

/** Deja solo lo que de verdad cambia respecto de cómo está la línea. */
function effective(line: AdminLine, state: LineState, changes: AdminChanges): AutomationDraft["changes"] {
  const out: AutomationDraft["changes"] = {}
  if (changes.enabled !== undefined && changes.enabled !== state.enabled) out.enabled = changes.enabled
  if (line.agent && changes.agentPart !== undefined && changes.agentPart !== state.agentPart) out.agentPart = changes.agentPart
  if (line.key !== "seguimiento_comercial" && changes.teamPart !== undefined && changes.teamPart !== state.teamPart) out.teamPart = changes.teamPart
  if (changes.days !== undefined && changes.days !== state.days) out.days = changes.days
  if (changes.hoursBefore && !same(changes.hoursBefore, state.timing.hoursBefore ?? [24, 3])) out.hoursBefore = changes.hoursBefore
  if (changes.delayHours !== undefined && changes.delayHours !== (state.timing.delayHours ?? line.delayHours)) out.delayHours = changes.delayHours
  if (changes.hour !== undefined && changes.hour !== state.timing.hour) out.hour = changes.hour
  return out
}

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/**
 * Guarda como borrador lo que se entendió de un pedido. No prende, no apaga y
 * no ajusta nada. Si el pedido no deja ningún cambio posible, lo dice y no
 * queda borrador.
 */
export async function saveAdminDraft(
  tx: Db,
  orgId: string,
  actorUserId: string,
  request: string,
  interpretation: AdminInterpretation,
): Promise<AdminRequestResult> {
  const measured = { model: interpretation.model, usage: interpretation.usage }
  const nothing = (message: string, key: AdminLineKey | null = null): AdminRequestResult => ({
    understood: key !== null,
    key,
    draft: false,
    message,
    confirmDelete: false,
    ...measured,
  })
  const line = interpretation.key ? adminLineOf(interpretation.key) : null
  if (!interpretation.understood || !line || !interpretation.intent) return nothing(ADMIN_NOT_UNDERSTOOD)
  const existing = await findLineRule(tx, orgId, line.key)
  const unsupported = [...interpretation.unsupported]
  let changes: AdminChanges = { ...interpretation.changes }

  if (interpretation.intent === "eliminar") {
    if (line.custom) {
      if (!existing) return nothing(`«${line.name}» no existe en tu clínica: no hay nada que eliminar.`, line.key)
      return { understood: true, key: line.key, draft: false, message: null, confirmDelete: true, ...measured }
    }
    // Las que vienen armadas no se eliminan: lo más parecido es apagarlas.
    if (!existing?.enabled) {
      return nothing(`«${line.name}» viene armada y no se elimina; ya está apagada, en «Listas para activar».`, line.key)
    }
    unsupported.push("Las líneas que vienen armadas no se eliminan: se apagan y vuelven a «Listas para activar».")
    changes = { enabled: false }
  }
  // Una línea que la clínica aún no tiene se crea para prenderla, no para dejarla a medias.
  const creates = !!line.custom && !existing
  if (creates) {
    if (interpretation.intent === "apagar") return nothing(`«${line.name}» no existe en tu clínica: no hay nada que apagar.`, line.key)
    changes.enabled = true
  }
  const state = stateOf(line, existing)
  const real = effective(line, state, changes)
  const next = applyChanges(line, state, real)
  if (!next.agentPart && !next.teamPart) {
    return nothing(`En «${line.name}» tiene que quedar al menos una parte: que el agente escriba o que quede una tarea para el equipo. Para que no haga nada, apágala.`, line.key)
  }
  if (Object.keys(real).length === 0) {
    const how = lower(describeLine(line, state, state.timing))
    return nothing(
      unsupported.length > 0
        ? unsupported.join(" ")
        : `«${line.name}» ya está así: ${state.enabled ? "prendida" : "apagada"}, ${how} No hay nada que cambiar.`,
      line.key,
    )
  }
  // La línea necesita su fila para guardar el borrador; se crea apagada, sin prender nada.
  const rule = existing ?? (await setLine(tx, orgId, actorUserId, line.key, {}))
  const draft: AutomationDraft = {
    request: request.trim().slice(0, 600),
    changes: real,
    unsupported,
    creates,
    by: actorUserId,
    at: new Date().toISOString(),
  }
  await tx
    .update(automationRule)
    .set({ draft, updatedAt: new Date() })
    .where(and(eq(automationRule.id, rule.id), eq(automationRule.organizationId, orgId)))
  // La auditoría dice que hubo un pedido y qué cambiaría; no copia el texto escrito.
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "admin_line.draft_saved",
    entity: "automation_rule",
    entityId: rule.id,
    metadata: { key: line.key, changes: real, creates, model: interpretation.model },
  })
  return { understood: true, key: line.key, draft: true, message: null, confirmDelete: false, ...measured }
}

async function requireDraft(tx: Db, orgId: string, key: string): Promise<{ line: AdminLine; rule: RuleRow; draft: AutomationDraft }> {
  const line = adminLineOf(key)
  if (!line) throw notFound("Línea del administrador")
  const rule = await findLineRule(tx, orgId, line.key)
  if (!rule?.draft) throw notFound("Borrador de la línea")
  return { line, rule, draft: rule.draft }
}

/**
 * Prende o guarda lo que dice el borrador. Es `setLine`, la misma operación de
 * los interruptores: las reglas de prender (solo lo nuevo) y de apagar
 * (descarta lo pendiente) son las de siempre.
 */
export async function applyAdminDraft(tx: Db, orgId: string, actorUserId: string, key: string): Promise<RuleRow> {
  const { line, rule, draft } = await requireDraft(tx, orgId, key)
  if (draft.changes.enabled === true && !(await adminRuntime(tx, orgId)).adminOn) {
    throw new ServiceError("ADMIN_OFF", 409, "Enciende primero al administrador: mientras esté apagado no hace nada")
  }
  const input: SetLineInput = { ...draft.changes }
  const saved = await setLine(tx, orgId, actorUserId, line.key, input)
  await tx
    .update(automationRule)
    .set({ draft: null })
    .where(and(eq(automationRule.id, rule.id), eq(automationRule.organizationId, orgId)))
  return { ...saved, draft: null }
}

/**
 * «Ponlo en la tarea»: lo que el agente no puede hacer (ofrecer algo, decir
 * otra cosa) queda como indicación para la persona que reciba la tarea. La
 * escribe quien administra, con sus palabras; se suma al borrador y, como una
 * indicación sin tarea no sirve, deja prendida la tarea para el equipo. Vacía,
 * se quita del borrador.
 */
export async function setAdminDraftNote(tx: Db, orgId: string, key: string, note: string): Promise<void> {
  const { line, rule, draft } = await requireDraft(tx, orgId, key)
  const text = note.replace(/\s+/g, " ").trim()
  if (text.length > TASK_NOTE_CHARS) throw validation(`La indicación para la tarea admite hasta ${TASK_NOTE_CHARS} caracteres`)
  const changes = { ...draft.changes }
  if (text) {
    changes.taskNote = text
    if (line.agent && line.key !== "seguimiento_comercial") {
      if (rule.teamPart) delete changes.teamPart
      else changes.teamPart = true
    }
  } else {
    delete changes.taskNote
  }
  await tx
    .update(automationRule)
    .set({ draft: { ...draft, changes } })
    .where(and(eq(automationRule.id, rule.id), eq(automationRule.organizationId, orgId)))
}

/** Descarta el borrador. Si era una línea nueva que nunca se prendió, la quita. */
export async function discardAdminDraft(tx: Db, orgId: string, actorUserId: string, key: string): Promise<{ removed: boolean }> {
  const { line, rule, draft } = await requireDraft(tx, orgId, key)
  const where = and(eq(automationRule.id, rule.id), eq(automationRule.organizationId, orgId))
  const removed = draft.creates && !!line.custom && !rule.enabled && rule.enabledAt === null
  if (removed) await tx.delete(automationRule).where(where)
  else await tx.update(automationRule).set({ draft: null }).where(where)
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "admin_line.draft_discarded",
    entity: "automation_rule",
    entityId: rule.id,
    metadata: { key: line.key, removed },
  })
  return { removed }
}

/**
 * Elimina una línea creada por la clínica: deja de ejecutarse y se cancela lo
 * que tenía por enviar. Lo ya hecho —mensajes, tareas y el registro de qué
 * pasó— se conserva. Las que vienen armadas no se eliminan: se apagan.
 */
export async function deleteAdminLine(tx: Db, orgId: string, actorUserId: string, key: string): Promise<{ cancelled: number }> {
  const line = adminLineOf(key)
  if (!line) throw notFound("Línea del administrador")
  if (!line.custom) throw validation(`«${line.name}» viene armada y no se elimina: apágala y vuelve a «Listas para activar»`)
  const rule = await findLineRule(tx, orgId, line.key)
  if (!rule) throw notFound("Línea del administrador")
  const now = new Date()
  const cancelled = await tx
    .update(automationJob)
    .set({ status: "cancelado", lastError: "Línea eliminada", updatedAt: now })
    .where(
      and(
        eq(automationJob.organizationId, orgId),
        eq(automationJob.ruleId, rule.id),
        inArray(automationJob.status, ["pendiente", "por_aprobar"]),
      ),
    )
    .returning({ id: automationJob.id })
  await tx.delete(automationRule).where(and(eq(automationRule.id, rule.id), eq(automationRule.organizationId, orgId)))
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "admin_line.deleted",
    entity: "automation_rule",
    entityId: rule.id,
    metadata: { key: line.key, cancelled: cancelled.length },
  })
  return { cancelled: cancelled.length }
}

/* ---------- La prueba con los últimos 30 días ---------- */

export const LINE_TEST_DAYS = 30
const LINE_TEST_LIMIT = 2000

export type LineTestRoute = "respuesta" | "plantilla" | "correo" | "no_pudo" | "tarea"

export interface LineTest {
  days: number
  total: number
  /** «18 cancelaciones». */
  title: string
  rows: Array<{ route: LineTestRoute; total: number; label: string; detail: string }>
  /** Cómo se hizo la cuenta, y que no se envió nada. */
  how: string
}

/** Lo que habría disparado la línea en los últimos 30 días: paciente y, si el caso la trae, la persona a quien escribir. */
function population(line: AdminLine, orgId: string, days: number | null): { rows: SQL; one: string; many: string } | null {
  const window = sql`now() - make_interval(days => ${LINE_TEST_DAYS})`
  if (line.key === "recordatorio_cita") {
    return {
      rows: sql`select a.patient_id, null::uuid as contact_id from appointment a
        where a.organization_id = ${orgId} and a.status <> 'cancelada' and a.starts_at >= ${window} and a.starts_at < now()`,
      one: "cita",
      many: "citas",
    }
  }
  if (line.key === "recordatorio_control") {
    return {
      rows: sql`select f.patient_id, null::uuid as contact_id from clinical_follow_up f
        where f.organization_id = ${orgId} and f.status <> 'cancelado' and f.due_at >= ${window} and f.due_at < now()`,
      one: "control",
      many: "controles",
    }
  }
  if (line.key === "seguimiento_presupuesto") {
    const wait = sql`make_interval(days => ${days ?? 2})`
    return {
      rows: sql`select b.patient_id, b.decision_contact_id as contact_id from treatment_budget b
        where b.organization_id = ${orgId} and b.presented_at is not null
          and b.presented_at + ${wait} >= ${window} and b.presented_at + ${wait} < now()
          and (b.decided_at is null or b.decided_at > b.presented_at + ${wait})`,
      one: `presupuesto que pasó ${days ?? 2} ${(days ?? 2) === 1 ? "día" : "días"} sin respuesta`,
      many: `presupuestos que pasaron ${days ?? 2} ${(days ?? 2) === 1 ? "día" : "días"} sin respuesta`,
    }
  }
  if (line.key === "seguimiento_no_asistencia") {
    return {
      rows: sql`select a.patient_id, null::uuid as contact_id from appointment a
        where a.organization_id = ${orgId} and a.status = 'no_asistio' and a.starts_at >= ${window} and a.starts_at < now()`,
      one: "inasistencia",
      many: "inasistencias",
    }
  }
  if (line.key === "cita_cancelada") {
    return {
      rows: sql`select a.patient_id, null::uuid as contact_id from appointment a
        where a.organization_id = ${orgId} and a.status = 'cancelada' and exists (
          select 1 from audit_event e
          where e.organization_id = a.organization_id and e.entity = 'appointment' and e.entity_id = a.id::text
            and e.action = 'appointment.status_cancelada' and e.created_at >= ${window}
            and (e.actor_user_id is null or e.metadata->>'cancelReason' = 'paciente'))`,
      one: "cancelación",
      many: "cancelaciones",
    }
  }
  return null
}

/**
 * Prueba una línea con lo que pasó en la clínica en los últimos 30 días: cuántas
 * veces se habría disparado y, con los datos de hoy de cada persona (su
 * permiso, su WhatsApp, su correo), por dónde le habría llegado. Solo lee: no
 * se envía nada ni se abre ninguna conversación. Null en las líneas que no
 * escriben a la persona o cuyo disparo no se puede reconstruir.
 */
export async function testAdminLine(
  tx: Db,
  orgId: string,
  line: AdminLine,
  state: { agentPart: boolean; teamPart: boolean; days: number | null },
): Promise<LineTest | null> {
  if (!line.agent) return null
  const found = population(line, orgId, state.days)
  if (!found) return null
  const purpose = line.agent.purpose
  const rows = await tx.execute<{ consent: boolean; whatsapp: boolean; recent: boolean; email: boolean; reachable: boolean }>(sql`
    with pop as (${found.rows} limit ${LINE_TEST_LIMIT}),
    who as (
      select coalesce(pop.contact_id, (
        select pc.contact_id from patient_contact pc
        join contact c on c.id = pc.contact_id and c.organization_id = pc.organization_id and c.is_active
        where pc.organization_id = ${orgId} and pc.patient_id = pop.patient_id
        order by pc.is_preferred desc, (pc.relationship = 'self') desc, pc.created_at asc, pc.id asc limit 1)) as cid
      from pop)
    select
      who.cid is not null as reachable,
      coalesce((select s.status = 'granted' from automation_consent s
        where s.organization_id = ${orgId} and s.contact_id = who.cid and s.purpose = ${purpose} limit 1), false) as consent,
      exists (select 1 from contact_identity i
        where i.organization_id = ${orgId} and i.contact_id = who.cid and i.channel = 'whatsapp') as whatsapp,
      exists (select 1 from conversation v
        join channel_connection n on n.id = v.channel_connection_id and n.organization_id = v.organization_id and n.channel = 'whatsapp'
        where v.organization_id = ${orgId} and v.contact_id = who.cid and v.status = 'open'
          and v.last_inbound_at >= now() - interval '24 hours') as recent,
      exists (select 1 from contact c
        where c.organization_id = ${orgId} and c.id = who.cid and c.email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$') as email
    from who`)
  const connections = await tx.execute<{ id: string; channel: string }>(sql`
    select id, channel from channel_connection
    where organization_id = ${orgId} and status = 'active' and channel in ('whatsapp', 'email')
    order by created_at asc, id asc`)
  const whatsapp = connections.find((row) => row.channel === "whatsapp")
  const mailbox = connections.some((row) => row.channel === "email")
  const spec = automationMessageOf(line.key)
  const approved = !!whatsapp && !!spec && (await findMessageTemplate(tx, orgId, whatsapp.id, spec.key))?.status === "aprobada"
  const count: Record<LineTestRoute, number> = { respuesta: 0, plantilla: 0, correo: 0, no_pudo: 0, tarea: 0 }
  for (const row of rows) {
    if (!state.agentPart) count.tarea++
    else if (!row.reachable || !row.consent) count.no_pudo++
    else if (row.whatsapp && whatsapp && row.recent) count.respuesta++
    else if (row.whatsapp && whatsapp && approved) count.plantilla++
    else if (row.email && mailbox) count.correo++
    else count.no_pudo++
  }
  const total = rows.length
  const team = TASK_AREA_LABELS[line.team.area].team
  const all: LineTest["rows"] = [
    { route: "respuesta", total: count.respuesta, label: "El agente, por WhatsApp, como respuesta", detail: "Escribieron en las últimas 24 horas." },
    { route: "plantilla", total: count.plantilla, label: "El agente, por WhatsApp, con el mensaje aprobado", detail: "No escribieron en las últimas 24 horas." },
    { route: "correo", total: count.correo, label: "El agente, por correo", detail: "No hay WhatsApp por el que llegarles y sí tienen correo." },
    {
      route: "no_pudo",
      total: count.no_pudo,
      label: "No pudo",
      detail: state.teamPart
        ? `Avisa por qué y cómo habilitar a cada una, y queda una tarea para ${team}.`
        : "Avisa por qué y cómo habilitar a cada una.",
    },
    { route: "tarea", total: count.tarea, label: `Tarea para ${team}`, detail: "El agente no escribe: lo hace una persona." },
  ]
  return {
    days: LINE_TEST_DAYS,
    total,
    title: `${total} ${total === 1 ? found.one : found.many}`,
    rows: all.filter((row) => row.total > 0),
    how: `Lo que pasó en tu clínica en los últimos ${LINE_TEST_DAYS} días, con los datos de hoy de cada persona: su permiso, su WhatsApp y su correo. Es una estimación; no se envió nada.`,
  }
}

/* ---------- Lo que se revisa antes de prender ---------- */

export interface LineCheck {
  ok: boolean
  text: string
}

/** Lo que conviene saber antes de prender o guardar. Cada punto es un hecho de la clínica hoy, no una opinión. */
export async function reviewAdminLine(tx: Db, orgId: string, line: AdminLine, next: { enabled: boolean; agentPart: boolean }): Promise<LineCheck[]> {
  const runtime = await adminRuntime(tx, orgId)
  const checks: LineCheck[] = []
  if (next.enabled && !runtime.adminOn) checks.push({ ok: false, text: "El administrador está apagado: enciéndelo para poder prenderla." })
  if (!line.agent || !next.agentPart) {
    checks.push({ ok: true, text: `No envía ningún mensaje: solo deja tareas para ${TASK_AREA_LABELS[line.team.area].team}.` })
    return checks
  }
  checks.push({
    ok: true,
    text: `Respeta el permiso de cada persona y el horario de silencio (de ${runtime.quietStart} a ${runtime.quietEnd}, con la hora de cada sede).`,
  })
  if (!runtime.receptionOn) checks.push({ ok: false, text: "Recepción está apagada: mientras siga así, esta línea no le escribe a nadie." })
  const spec = automationMessageOf(line.key)
  if (spec) {
    const [whatsapp] = await tx.execute<{ id: string }>(sql`
      select id from channel_connection
      where organization_id = ${orgId} and status = 'active' and channel = 'whatsapp'
      order by created_at asc, id asc limit 1`)
    const template = whatsapp ? await findMessageTemplate(tx, orgId, whatsapp.id, spec.key) : null
    if (!whatsapp) checks.push({ ok: false, text: "La clínica no tiene WhatsApp conectado: solo podrá escribir por correo a quien lo tenga." })
    else if (template?.status === "aprobada") checks.push({ ok: true, text: "WhatsApp ya aprobó el mensaje de esta línea." })
    else if (template?.status === "en_revision") {
      checks.push({ ok: false, text: "WhatsApp todavía no aprobó el mensaje de esta línea. Ya está pedido; hasta entonces solo le escribe a quien escribió en las últimas 24 horas, o por correo." })
    } else if (template) {
      checks.push({ ok: false, text: `WhatsApp tiene el mensaje de esta línea ${template.status}${template.reason ? ` (${template.reason})` : ""}: solo le escribe a quien escribió en las últimas 24 horas, o por correo.` })
    } else {
      checks.push({ ok: false, text: "WhatsApp todavía no tiene un mensaje aprobado para esto. Se pide solo al prenderla; hasta que lo apruebe, solo le escribe a quien escribió en las últimas 24 horas, o por correo." })
    }
  }
  if (runtime.supervised && line.agent.purpose !== "recordatorio") {
    checks.push({ ok: true, text: "Recepción está en «Supervisado»: los mensajes de esta línea esperan tu aprobación antes de salir." })
  }
  checks.push({ ok: true, text: "Como mucho un mensaje al día por persona: si ese día ya recibió otro, este espera al siguiente." })
  return checks
}

/* ---------- El borrador, como lo ve la pantalla ---------- */

export interface AdminDraftChange {
  /** `cambio` trae antes y ahora; `nueva` y `quita` son una parte que entra o sale. */
  kind: "cambio" | "nueva" | "quita"
  before: string | null
  after: string
}

export interface AdminDraftView {
  /** Lo que la persona escribió. */
  request: string
  /** La línea no existía en la clínica. */
  creates: boolean
  /** Qué hace el botón principal. */
  action: "prender" | "guardar" | "apagar"
  /** «La armé así: …», «Así quedaría…». */
  summary: string
  changes: AdminDraftChange[]
  /** El flujo como quedaría, con solo lo que se ejecutaría. */
  flow: LineFlow
  /** Pasos del flujo que son nuevos o cambian. */
  marks: Record<string, "nueva" | "cambio">
  /** Lo que pidió y no se puede, con el motivo. */
  unsupported: string[]
  /** Null si no aplica o si el rol de quien lee no ve esos casos. */
  test: LineTest | null
  review: LineCheck[]
  /** Cómo le llegaría, con datos de ejemplo. */
  message: { text: string; buttons: string[] } | null
  /**
   * Lo que sí se puede con algo que el agente no hace: dejarlo como indicación
   * en la tarea, para que lo haga una persona. Null si no hay nada que ofrecer.
   */
  taskNote: { value: string | null; max: number; team: string } | null
  at: string
}

/** El borrador de una línea, listo para decidir. Null si no tiene. */
export async function draftViewOf(
  tx: Db,
  orgId: string,
  can: (permission: string) => boolean,
  line: AdminLine,
  rule: RuleRow | null,
): Promise<AdminDraftView | null> {
  const draft = rule?.draft
  if (!rule || !draft) return null
  const state = stateOf(line, rule)
  const next = applyChanges(line, state, draft.changes)
  const team = TASK_AREA_LABELS[line.team.area].team
  const changes: AdminDraftChange[] = []
  const marks: AdminDraftView["marks"] = {}
  if (draft.changes.days !== undefined) {
    changes.push({ kind: "cambio", before: line.trigger(state.days), after: line.trigger(next.days) })
    marks.inicio = "cambio"
    if (line.wait(state.days, state.timing) !== line.wait(next.days, next.timing)) marks.espera = "cambio"
  }
  if (draft.changes.hoursBefore || draft.changes.delayHours !== undefined || draft.changes.hour !== undefined) {
    changes.push({ kind: "cambio", before: line.wait(state.days, state.timing), after: line.wait(next.days, next.timing) ?? "" })
    marks.espera = "cambio"
  }
  if (draft.changes.agentPart === true && line.agent) {
    changes.push({ kind: "nueva", before: null, after: `El agente Recepción ${say(line.agent.does, next.timing)}.` })
    marks.puede = "nueva"
    marks.escribe = "nueva"
  }
  if (draft.changes.agentPart === false) {
    changes.push({ kind: "quita", before: null, after: `El agente ya no le escribe: ${lower(line.team.does)}.` })
    marks.tarea = "cambio"
  }
  if (draft.changes.teamPart === true) {
    changes.push({ kind: "nueva", before: null, after: next.agentPart ? `Si el agente no puede, además queda una tarea para ${team}.` : `${line.team.does}.` })
    marks.tarea = "nueva"
  }
  if (draft.changes.teamPart === false) {
    changes.push({ kind: "quita", before: null, after: "Ya no queda una tarea para el equipo cuando el agente no puede. El aviso de por qué sigue saliendo." })
  }
  if (draft.changes.taskNote) {
    changes.push({ kind: "nueva", before: null, after: `La tarea para ${team} dirá: «${draft.changes.taskNote}». El agente no lo dice: lo hace una persona.` })
    marks.tarea = marks.tarea ?? "cambio"
  }
  const turnsOn = draft.changes.enabled === true
  const turnsOff = draft.changes.enabled === false
  const described = describeLine(line, { ...next, enabled: true }, next.timing)
  const summary = draft.creates
    ? `La armé así: ${lower(described)} Todavía no hace nada.`
    : turnsOff
      ? "Al apagarla deja de hacerse y se descarta lo que estaba por salir. Lo ya hecho se conserva."
      : turnsOn
        ? `Al prenderla: ${lower(described)} Solo actúa sobre lo que pase desde ese momento.`
        : "Así quedaría. Mientras no guardes, sigue funcionando como estaba."
  const spec = automationMessageOf(line.key)
  const example =
    spec && next.agentPart
      ? renderMessage(spec, Object.fromEntries(spec.variables.map((name) => [name, MESSAGE_VARIABLES[name].example])))
      : null
  return {
    request: draft.request,
    creates: draft.creates,
    action: turnsOff ? "apagar" : turnsOn ? "prender" : "guardar",
    summary,
    changes,
    flow: flowOf(line, next, { days: next.days, timing: next.timing }),
    marks,
    unsupported: draft.unsupported,
    test: turnsOff || !can(line.permission) ? null : await testAdminLine(tx, orgId, line, next),
    review: turnsOff ? [] : await reviewAdminLine(tx, orgId, line, next),
    message: spec && example ? { text: example.text, buttons: AUTOMATION_MESSAGES[spec.key].buttons.map((button) => button.title) } : null,
    taskNote:
      !turnsOff && (draft.unsupported.includes(OUT_OF_REACH) || draft.changes.taskNote)
        ? { value: draft.changes.taskNote ?? null, max: TASK_NOTE_CHARS, team }
        : null,
    at: draft.at,
  }
}
