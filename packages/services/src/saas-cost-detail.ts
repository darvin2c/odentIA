import { type OrgRole, roleLabel } from "@odentia/auth/permissions"
import type { Db } from "@odentia/db"
import { agentRunLedger } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import {
  encounter,
  encounterDictationSuggestion,
  patientContact,
} from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { reportQuestion } from "@odentia/db/schema/reports"
import { and, eq, gte, inArray, lt } from "drizzle-orm"
import type { ArgosStoredPlan } from "./argos-saved.js"
import { notFound } from "./errors.js"
import { findOrgLocale, orgProduct } from "./locale.js"
import { channelWords } from "./report-figures.js"
import { currentSaasPeriod, listPeriodActions, netMicros } from "./saas-actions.js"
import { type CostUsageRow, loadClinicCostContext } from "./saas-cost.js"
import { FREE_OUTCOMES, getArgosAllowance, questionsUsed } from "./saas-included.js"

/**
 * Cada acción de una clínica con lo que nos costó (lienzo «Gastos por
 * organización», tableros 2 a 5). Solo lo ve el rol admin de odentIA.
 *
 * - Sale de la misma unión de gastos y acciones que «Costo y margen»
 *   (`loadClinicCostContext`): una acción cuesta aquí lo mismo que suma su fila.
 * - De Clío se ven las pausas de cada atención y qué dejó hecho; nunca lo
 *   dictado ni el diagnóstico (son datos clínicos).
 * - De Sofi, cada respuesta con lo que hizo; nunca el texto de los mensajes.
 * - De Argos, lo que entendió de cada pregunta, nunca lo que escribió la
 *   persona (ADR 0070). La pregunta anterior a `ai_usage.report_question_id`
 *   no sabe su costo: se reparte el del día entre las de ese día («repartido»).
 * - El paciente se nombra con la inicial y el apellido («L. Ramos»); el equipo,
 *   con su nombre (decisión D2).
 */

export type CostAgent = "sofi" | "clio" | "argos"
export type CostAgentFilter = "todo" | CostAgent | "sin_cobro"

export interface CostActionItem {
  /** `a:<acción>`, `q:<pregunta>`, `e:<atención sin cobro>` o `c:<conversación sin cobro>`. */
  key: string
  agent: CostAgent
  /** «Informa», «Completa», «Pregunta», «Cita recuperada», «Sin cobro»… */
  type: string
  occurredAt: Date
  /** El paciente («L. Ramos») o quien preguntó a Argos. */
  who: string | null
  /** El canal, «con M. Díaz» o el rol de quien preguntó. */
  whoDetail: string | null
  what: string
  /** Lo que suma a la cuenta del mes, en millonésimas; null si no suma. */
  chargedMicros: number | null
  /** Lo que se dice en vez del importe: «Incluida», «12 de 300», «No cuenta». */
  chargedNote: string | null
  costMicros: number
  calls: number
  /** El costo se repartió entre las preguntas del día (antes de anotarse por pregunta). */
  spread: boolean
  free: boolean
  professionalId: string | null
  channel: string | null
  /** Pausas de Clío o respuestas de Sofi. */
  steps: number | null
  /** De una pregunta a Argos: cómo terminó («Respondida», «Sin la cifra»). */
  outcome?: string
}

export interface CostActionList {
  period: { start: Date; end: Date; credit: "prueba" | "mes" }
  /** La zona de la clínica: las horas se dicen en ella. */
  timezone: string
  items: CostActionItem[]
  total: number
  page: number
  pageSize: number
  counts: Record<CostAgentFilter, number>
  /** Lo que no se cobró de cada agente. */
  freeCounts: Record<"sofi" | "clio", number>
  professionals: Array<{ id: string; name: string; count: number }>
  channels: Array<{ channel: string; count: number }>
  askers: Array<{ name: string; count: number }>
  /** El costo de IA de cada día del tramo, en la zona de la clínica; `ahead`: aún no llega. */
  days: Array<{ day: string; costMicros: number; ahead: boolean }>
  /** Preguntas del mes que cuentan y las incluidas en el plan. */
  questions: { counted: number; included: number; free: number }
}

const PAGE_SIZE = 25

const TIER_NAME: Record<string, string> = {
  informa: "Informa",
  gestiona: "Gestiona",
  agenda: "Agenda",
  simple: "Simple",
  estandar: "Estándar",
  completa: "Completa",
}

/** Lo que dejó hecho Clío, por tipo de sugerencia confirmada. */
const DICTATION_WORDS: Record<string, string> = {
  nota: "nota",
  diagnostico: "diagnóstico",
  plan: "plan",
  control: "control",
  odontograma: "odontograma",
  receta: "receta",
  signos: "signos vitales",
  examen: "examen",
  descanso: "descanso médico",
}

/** Cómo terminó una pregunta a Argos (ADR 0070 y 0075). Si cuenta para las del mes lo dice `FREE_OUTCOMES`. */
const OUTCOME_WORDS: Record<string, string> = {
  respondida: "Respondida",
  parcial: "En parte",
  no_sabe: "Sin la cifra",
  pregunta: "Preguntó",
  clinico: "Clínica",
  accion: "Pidió una acción",
  ayuda: "Era de la Ayuda",
  otro: "Otro tema",
  no_pudo: "No pudo",
}

/** Lo que entendió Argos cuando no hay título: según cómo terminó. */
const OUTCOME_WHAT: Record<string, string> = {
  no_sabe: "No hay una cifra que lo responda",
  pregunta: "Dudó y preguntó cuál quería",
  clinico: "Era una pregunta clínica: no la responde",
  accion: "Pedía hacer algo, no una cifra",
  ayuda: "Era de cómo se usa: la llevó a la Ayuda",
  otro: "No era del negocio",
  no_pudo: "El proveedor no respondió",
}

/** De dónde salió la reserva de una cita recuperada. */
const BOOKED_FROM: Record<string, string> = {
  agent: "en la conversación",
  enlace: "desde el enlace",
}

/** Lo que hizo Sofi en una respuesta, por las herramientas que usó. Lo demás es «Respondió». */
const TOOL_WORDS: Record<string, string> = {
  buscar_huecos: "Buscó horarios libres",
  proponer_cita: "Propuso una cita",
  confirmar_propuesta: "Reservó la cita",
  confirmar_cita: "Confirmó la cita",
  reprogramar_cita: "Movió la cita",
  cancelar_cita: "Canceló la cita",
  ver_sedes_y_servicios: "Buscó servicios y precios",
  consultar_conocimiento: "Buscó en lo que sabe de la clínica",
  buscar_en_la_clinica: "Buscó en la clínica",
  enviar_enlace_cita: "Envió el enlace para reservar",
  ver_presupuesto: "Revisó su presupuesto",
  reenviar_presupuesto: "Reenvió el presupuesto",
  anotar_respuesta_presupuesto: "Anotó su respuesta al presupuesto",
  enviar_comprobante: "Envió el comprobante",
  update_contact: "Actualizó sus datos",
  request_human_handoff: "Pasó el caso al equipo",
  create_task: "Dejó una tarea al equipo",
  despedirse_y_cerrar: "Se despidió y cerró",
}

const RUN_STATUS_WORDS: Record<string, string> = {
  handoff: "Pasó el caso al equipo",
  error: "Falló",
  sin_respuesta: "No respondió",
  omitida: "No hizo falta responder",
}

/** «L. Ramos»: la inicial del nombre y los apellidos (decisión D2). */
export function shortPersonName(person: {
  givenNames: string | null
  familyName: string | null
  displayName: string
}): string {
  const given = person.givenNames?.trim()
  const family = person.familyName?.trim()
  if (given && family) return `${given.charAt(0).toLocaleUpperCase("es")}. ${family}`
  const words = person.displayName.trim().split(/\s+/)
  if (words.length < 2) return person.displayName.trim()
  return `${(words[0] ?? "").charAt(0).toLocaleUpperCase("es")}. ${words.slice(1).join(" ")}`
}

/** «Nota, diagnóstico y odontograma». */
function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} y ${items.at(-1)}`
}
const capital = (text: string) =>
  text ? text.charAt(0).toLocaleUpperCase("es") + text.slice(1) : text

/** La pantalla de Argos a la que lleva una respuesta, en palabras. */
const SCREEN_WORDS: Record<string, string> = {
  finanzas: "Finanzas",
  pacientes: "Pacientes",
  agenda: "Agenda",
  presupuestos: "Presupuestos",
  inventario: "Inventario",
  servicios: "Servicios",
  reportes: "Reportes",
}

/** La pregunta nombró a una persona (la encontrara o no): su título puede llevar el nombre. */
function aboutPatient(plan: ArgosStoredPlan | null): boolean {
  return !!plan && (!!plan.paciente || plan.pacientes !== undefined)
}

/**
 * Lo que entendió Argos de una pregunta: su título. Si la pregunta nombró a
 * un paciente, el título puede llevar su nombre: se dice solo eso.
 */
function understoodOf(plan: ArgosStoredPlan | null, outcome: string): string {
  if (aboutPatient(plan)) return "Una pregunta sobre un paciente"
  const title = plan?.titulo?.trim()
  return title || OUTCOME_WHAT[outcome] || "Sin título"
}

/** La clave de lo que no dice a qué atención o conversación pertenece. */
const NO_ID = "00000000-0000-0000-0000-000000000000"

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** El día en la zona de la clínica (`yyyy-MM-dd`). */
function dayFormat(timezone: string) {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  return (date: Date) => format.format(date)
}

interface Loaded {
  context: Awaited<ReturnType<typeof loadClinicCostContext>>
  items: CostActionItem[]
  timezone: string
  /** El costo exacto de cada pregunta y, sin él, lo repartido del día. */
  questionUsage: Map<string, CostUsageRow[]>
  included: number
}

async function loadItems(
  tx: Db,
  orgId: string,
  which: "actual" | "anterior",
  now?: Date,
): Promise<Loaded> {
  const context = await loadClinicCostContext(tx, orgId, { which, ...(now ? { now } : {}) })
  const { period, plan, actions, usage, actionCost, targets } = context
  // Sin perfil regional (una clínica a medio dar de alta), los días van en UTC.
  const { timezone } = await findOrgLocale(tx, orgId)
  const product = await orgProduct(tx, orgId)
  const dayOf = dayFormat(timezone)

  // Lo que no se cobró, por atención (Clío) o por conversación (Sofi); lo que no dice
  // cuál va junto con la clave vacía, para que la lista sume lo mismo que su fila.
  const clioFree = new Map<string, CostUsageRow[]>()
  const sofiFree = new Map<string, CostUsageRow[]>()
  for (const row of usage) {
    const target = targets.get(row.id)
    if (!target || !("bucket" in target)) continue
    if (target.bucket === "clio_sin_cobro") pushTo(clioFree, row.encounterId ?? NO_ID, row)
    if (target.bucket === "sofi_sin_cobro") pushTo(sofiFree, row.conversationId ?? NO_ID, row)
  }
  const encounterIds = [
    ...new Set([
      ...actions
        .filter((row) => row.kind === "consulta" && row.encounterId)
        .map((row) => row.encounterId as string),
      ...[...clioFree.keys()].filter((id) => id !== NO_ID),
    ]),
  ]
  const encounters = encounterIds.length
    ? await tx
        .select({
          id: encounter.id,
          professionalUserId: encounter.professionalUserId,
          startedAt: encounter.startedAt,
          contactId: patientContact.contactId,
        })
        .from(encounter)
        .leftJoin(
          patientContact,
          and(
            eq(patientContact.organizationId, encounter.organizationId),
            eq(patientContact.patientId, encounter.patientId),
            eq(patientContact.relationship, "self"),
          ),
        )
        .where(and(eq(encounter.organizationId, orgId), inArray(encounter.id, encounterIds)))
    : []
  const encounterOf = new Map(encounters.map((row) => [row.id, row]))
  const confirmed = encounterIds.length
    ? await tx
        .select({
          encounterId: encounterDictationSuggestion.encounterId,
          kind: encounterDictationSuggestion.kind,
        })
        .from(encounterDictationSuggestion)
        .where(
          and(
            eq(encounterDictationSuggestion.organizationId, orgId),
            inArray(encounterDictationSuggestion.encounterId, encounterIds),
            eq(encounterDictationSuggestion.status, "confirmada"),
          ),
        )
    : []
  const doneOf = new Map<string, string[]>()
  for (const row of confirmed) {
    const list = doneOf.get(row.encounterId) ?? []
    if (!list.includes(row.kind)) list.push(row.kind)
    doneOf.set(row.encounterId, list)
  }
  const doneWords = (encounterId: string) => {
    const kinds = doneOf.get(encounterId) ?? []
    const order = Object.keys(DICTATION_WORDS)
    return capital(
      listWords(
        [...kinds]
          .sort((a, b) => order.indexOf(a) - order.indexOf(b))
          .map((kind) => DICTATION_WORDS[kind] ?? kind),
      ),
    )
  }

  // Las preguntas a Argos del tramo que pasaron por un modelo, o que tienen gasto propio.
  const questions = await tx
    .select({
      id: reportQuestion.id,
      userId: reportQuestion.userId,
      outcome: reportQuestion.outcome,
      plan: reportQuestion.plan,
      usedModel: reportQuestion.usedModel,
      createdAt: reportQuestion.createdAt,
    })
    .from(reportQuestion)
    .where(
      and(
        eq(reportQuestion.organizationId, orgId),
        gte(reportQuestion.createdAt, period.start),
        lt(reportQuestion.createdAt, period.end),
      ),
    )
    .orderBy(reportQuestion.createdAt)
  const questionUsage = new Map<string, CostUsageRow[]>()
  const unlinkedByDay = new Map<string, CostUsageRow[]>()
  for (const row of usage) {
    // Lo de Jev va en su fila, como en «Costo y margen»: aquí solo lo que suma «Argos · Preguntas».
    const target = targets.get(row.id)
    if (!target || !("bucket" in target) || target.bucket !== "preguntas") continue
    if (row.reportQuestionId) pushTo(questionUsage, row.reportQuestionId, row)
    else pushTo(unlinkedByDay, dayOf(row.createdAt), row)
  }
  const asked = questions.filter((row) => row.usedModel || questionUsage.has(row.id))
  // Lo que no dice su pregunta se reparte entre las del día que tampoco lo dicen (las de antes del cambio).
  const spreadOf = new Map<string, { micros: number; calls: number }>()
  for (const [day, rows] of unlinkedByDay) {
    const sharing = asked.filter(
      (row) => !questionUsage.has(row.id) && dayOf(row.createdAt) === day,
    )
    if (!sharing.length) continue
    const micros = rows.reduce((sum, row) => sum + (row.costMicros ?? 0), 0)
    const calls = rows.reduce((sum, row) => sum + row.calls, 0)
    for (const row of sharing)
      spreadOf.set(row.id, {
        micros: Math.round(micros / sharing.length),
        calls: Math.round(calls / sharing.length),
      })
  }

  // Los nombres: equipo con su nombre y rol; pacientes con la inicial y el apellido.
  const userIds = [
    ...new Set([
      ...encounters.map((row) => row.professionalUserId),
      ...asked.map((row) => row.userId),
    ]),
  ]
  const people = userIds.length
    ? await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds))
    : []
  const nameOf = new Map(people.map((row) => [row.id, row.name]))
  const roles = userIds.length
    ? await tx
        .select({ userId: member.userId, role: member.role })
        .from(member)
        .where(and(eq(member.organizationId, orgId), inArray(member.userId, userIds)))
    : []
  const roleOf = new Map(roles.map((row) => [row.userId, row.role]))
  const contactIds = [
    ...new Set(
      [
        ...actions.map((row) => row.contactId),
        ...encounters.map((row) => row.contactId),
        ...[...sofiFree.values()].map((rows) => rows[0]?.contactId ?? null),
      ].filter((id): id is string => !!id),
    ),
  ]
  const contacts = contactIds.length
    ? await tx
        .select({
          id: contact.id,
          givenNames: contact.givenNames,
          familyName: contact.familyName,
          displayName: contact.displayName,
        })
        .from(contact)
        .where(and(eq(contact.organizationId, orgId), inArray(contact.id, contactIds)))
    : []
  const shortOf = new Map(contacts.map((row) => [row.id, shortPersonName(row)]))
  const patientOf = (contactId: string | null) =>
    contactId ? (shortOf.get(contactId) ?? null) : null

  const items: CostActionItem[] = []
  const pausesOf = (rows: CostUsageRow[]) =>
    new Set(rows.map((row) => row.createdAt.getTime())).size
  const usageOfAction = new Map<string, CostUsageRow[]>()
  for (const row of usage) {
    const target = targets.get(row.id)
    if (target && "action" in target) pushTo(usageOfAction, target.action, row)
  }

  for (const row of actions) {
    const cost = actionCost.get(row.id) ?? { micros: 0, calls: 0 }
    const charged = row.priceMicros === null ? null : netMicros(row)
    const base = {
      key: `a:${row.id}`,
      occurredAt: row.occurredAt,
      chargedMicros: charged,
      chargedNote: charged === null ? "Sin precio" : null,
      costMicros: cost.micros,
      calls: cost.calls,
      spread: false,
      free: false,
    }
    if (row.kind === "conversacion") {
      const steps = new Set(
        (usageOfAction.get(row.id) ?? []).map(
          (item) => `${item.conversationId}:${item.createdAt.getTime()}`,
        ),
      ).size
      items.push({
        ...base,
        agent: "sofi",
        type: TIER_NAME[row.tier ?? ""] ?? "Conversación",
        who: patientOf(row.contactId) ?? row.personName,
        whoDetail:
          row.tier === "agenda" ? "en la clínica" : row.channel ? channelWords(row.channel) : null,
        what:
          row.tier === "agenda"
            ? "Vino a la cita que reservó Sofi: sube de Gestiona a Agenda"
            : row.detail,
        professionalId: null,
        channel: row.channel,
        steps: row.tier === "agenda" ? null : steps,
      })
    } else if (row.kind === "consulta") {
      const seen = row.encounterId ? encounterOf.get(row.encounterId) : undefined
      const professional = seen ? (nameOf.get(seen.professionalUserId) ?? null) : null
      const patient = patientOf(row.contactId ?? seen?.contactId ?? null)
      items.push({
        ...base,
        agent: "clio",
        type: TIER_NAME[row.tier ?? ""] ?? "Consulta",
        who: professional,
        whoDetail: patient ? `con ${patient}` : null,
        what: (row.encounterId && doneWords(row.encounterId)) || row.detail,
        professionalId: seen?.professionalUserId ?? null,
        channel: null,
        steps: pausesOf(usageOfAction.get(row.id) ?? []),
      })
    } else if (row.kind === "cita") {
      items.push({
        ...base,
        agent: "argos",
        type: "Cita recuperada",
        who: patientOf(row.contactId) ?? row.personName,
        // El canal de una cita recuperada es de dónde salió la reserva (`appointment.source`).
        whoDetail: row.channel ? (BOOKED_FROM[row.channel] ?? channelWords(row.channel)) : null,
        what: row.detail,
        professionalId: null,
        channel: row.channel,
        steps: null,
      })
    } else if (row.kind === "preguntas") {
      items.push({
        ...base,
        agent: "argos",
        type: "Paquete de preguntas",
        who: null,
        whoDetail: null,
        what: row.units ? `${row.units} preguntas más` : row.detail,
        professionalId: null,
        channel: null,
        steps: null,
      })
    }
  }

  // Las preguntas: «N de 300» mientras alcanzan las incluidas, después «Paquete». Con la
  // regla de «Costo y margen»: un plan que no cobra paquetes no tiene tope y todas son incluidas.
  const limited = !!plan && plan.argosPackMicros !== null
  const included = limited ? (plan?.argosIncludedQuestions ?? 0) : 0
  let counted = 0
  for (const row of asked) {
    const label = OUTCOME_WORDS[row.outcome] ?? row.outcome
    const counts = row.usedModel && !FREE_OUTCOMES.includes(row.outcome)
    if (counts) counted += 1
    const linked = questionUsage.get(row.id)
    const spread = linked ? null : (spreadOf.get(row.id) ?? null)
    const micros = linked
      ? linked.reduce((sum, item) => sum + (item.costMicros ?? 0), 0)
      : (spread?.micros ?? 0)
    const calls = linked ? linked.reduce((sum, item) => sum + item.calls, 0) : (spread?.calls ?? 0)
    const role = roleOf.get(row.userId)
    items.push({
      key: `q:${row.id}`,
      agent: "argos",
      type: "Pregunta",
      occurredAt: row.createdAt,
      who: nameOf.get(row.userId) ?? "Alguien del equipo",
      whoDetail: role ? roleLabel(role as OrgRole, product) : null,
      what: understoodOf(row.plan as ArgosStoredPlan | null, row.outcome),
      chargedMicros: null,
      chargedNote: !counts
        ? "No cuenta"
        : !limited
          ? "Incluida"
          : counted > included
            ? "Paquete"
            : `${counted} de ${included}`,
      costMicros: micros,
      calls,
      spread: spread !== null,
      free: !counts,
      professionalId: null,
      channel: null,
      steps: null,
      outcome: label,
    })
  }

  for (const [encounterId, rows] of clioFree) {
    const seen = encounterOf.get(encounterId)
    const pauses = pausesOf(rows)
    const patient = patientOf(seen?.contactId ?? null)
    items.push({
      key: `e:${encounterId}`,
      agent: "clio",
      type: "Sin cobro",
      occurredAt: rows[0]?.createdAt ?? seen?.startedAt ?? period.start,
      who: seen ? (nameOf.get(seen.professionalUserId) ?? null) : null,
      whoDetail: patient ? `con ${patient}` : null,
      what:
        encounterId === NO_ID
          ? "Dictado que no dice de qué atención es"
          : `Escuchó ${pauses === 1 ? "1 pausa" : `${pauses} pausas`} y no se confirmó nada`,
      chargedMicros: null,
      chargedNote: "Sin cobro",
      costMicros: rows.reduce((sum, row) => sum + (row.costMicros ?? 0), 0),
      calls: rows.reduce((sum, row) => sum + row.calls, 0),
      spread: false,
      free: true,
      professionalId: seen?.professionalUserId ?? null,
      channel: null,
      steps: pauses,
    })
  }
  for (const [conversationId, rows] of sofiFree) {
    items.push({
      key: `c:${conversationId}`,
      agent: "sofi",
      type: "Sin cobro",
      occurredAt: rows[0]?.createdAt ?? period.start,
      who: patientOf(rows[0]?.contactId ?? null) ?? "Sin nombre",
      whoDetail: null,
      what:
        conversationId === NO_ID
          ? "Respuestas que no dicen de qué conversación son"
          : "No contó como conversación: pasó al equipo, fue ajeno o spam",
      chargedMicros: null,
      chargedNote: "Sin cobro",
      costMicros: rows.reduce((sum, row) => sum + (row.costMicros ?? 0), 0),
      calls: rows.reduce((sum, row) => sum + row.calls, 0),
      spread: false,
      free: true,
      professionalId: null,
      channel: null,
      steps: new Set(rows.map((row) => row.createdAt.getTime())).size,
    })
  }
  items.sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || a.key.localeCompare(b.key),
  )
  return { context, items, timezone, questionUsage, included }
}

/**
 * Cada acción del tramo con lo que se cobró y lo que nos costó (tablero 2),
 * filtrada por agente, profesional o canal, por páginas.
 */
export async function listClinicCostActions(
  tx: Db,
  orgId: string,
  input: {
    which?: "actual" | "anterior"
    agent?: CostAgentFilter
    professionalId?: string | null
    channel?: string | null
    page?: number
    now?: Date
  } = {},
): Promise<CostActionList> {
  const { context, items, timezone, included } = await loadItems(
    tx,
    orgId,
    input.which ?? "actual",
    input.now,
  )
  const agent = input.agent ?? "todo"
  const counts: Record<CostAgentFilter, number> = {
    todo: items.length,
    sofi: items.filter((item) => item.agent === "sofi").length,
    clio: items.filter((item) => item.agent === "clio").length,
    argos: items.filter((item) => item.agent === "argos").length,
    sin_cobro: items.filter((item) => item.free).length,
  }
  const byAgent = items.filter((item) =>
    agent === "todo" ? true : agent === "sin_cobro" ? item.free : item.agent === agent,
  )
  const filtered = byAgent.filter(
    (item) =>
      (!input.professionalId || item.professionalId === input.professionalId) &&
      (!input.channel || item.channel === input.channel),
  )
  const tally = <T extends string>(values: Array<T | null>) => {
    const map = new Map<T, number>()
    for (const value of values) if (value) map.set(value, (map.get(value) ?? 0) + 1)
    return map
  }
  const professionals = [
    ...tally(items.filter((item) => item.agent === "clio").map((item) => item.professionalId)),
  ].map(([id, count]) => ({
    id,
    name: items.find((item) => item.professionalId === id)?.who ?? "Profesional",
    count,
  }))
  const channels = [
    ...tally(items.filter((item) => item.agent === "sofi").map((item) => item.channel)),
  ].map(([channel, count]) => ({ channel, count }))
  const askers = [
    ...tally(items.filter((item) => item.type === "Pregunta").map((item) => item.who)),
  ]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)

  const dayOf = dayFormat(timezone)
  const cost = new Map<string, number>()
  for (const row of context.usage)
    cost.set(dayOf(row.createdAt), (cost.get(dayOf(row.createdAt)) ?? 0) + (row.costMicros ?? 0))
  const days: CostActionList["days"] = []
  const today = dayOf(context.now)
  for (
    let at = context.period.start.getTime();
    at < context.period.end.getTime();
    at += 86_400_000
  ) {
    const day = dayOf(new Date(at))
    if (days.at(-1)?.day === day) continue
    days.push({ day, costMicros: cost.get(day) ?? 0, ahead: day > today })
  }
  const last = dayOf(new Date(context.period.end.getTime() - 1))
  if (days.at(-1)?.day !== last)
    days.push({ day: last, costMicros: cost.get(last) ?? 0, ahead: last > today })

  // Una página que ya no existe (otro mes, otro filtro) muestra la última.
  const page = Math.min(
    Math.max(1, Math.floor(input.page ?? 1)),
    Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)),
  )
  const questionItems = items.filter((item) => item.type === "Pregunta")
  return {
    period: { start: context.period.start, end: context.period.end, credit: context.period.credit },
    timezone,
    items: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    total: filtered.length,
    page,
    pageSize: PAGE_SIZE,
    counts,
    freeCounts: {
      sofi: items.filter((item) => item.free && item.agent === "sofi").length,
      clio: items.filter((item) => item.free && item.agent === "clio").length,
    },
    professionals,
    channels,
    askers,
    days,
    questions: {
      counted: questionItems.filter((item) => !item.free).length,
      included,
      free: questionItems.filter((item) => item.free).length,
    },
  }
}

export interface CostStep {
  /** El primer gasto del paso: no se repite aunque dos pasos compartan hora. */
  id: string
  at: Date
  /** «Buscó horarios libres», «Nota y diagnóstico», «Escribió la consulta». */
  what: string
  model: string
  calls: number
  inputTokens: number | null
  outputTokens: number | null
  costMicros: number
}

export interface CostActionDetail {
  key: string
  agent: CostAgent
  /** Las pausas (Clío), las respuestas (Sofi) o las llamadas de una pregunta (Argos). */
  steps: CostStep[]
  /** Clío: lo que quedó confirmado; Argos: lo que entendió, por partes. */
  facts: Array<{ label: string; value: string }>
  costMicros: number
  /** El costo de esta pregunta se repartió entre las del día. */
  spread: boolean
}

/** Los gastos de un paso, juntos: el mismo momento es la misma pausa o la misma respuesta. */
function stepsOf(
  rows: CostUsageRow[],
  keyOf: (row: CostUsageRow) => string = (row) => String(row.createdAt.getTime()),
): Array<{ id: string; at: Date; rows: CostUsageRow[] }> {
  const groups = new Map<string, { id: string; at: Date; rows: CostUsageRow[] }>()
  for (const row of rows) {
    const key = keyOf(row)
    const group = groups.get(key) ?? { id: row.id, at: row.createdAt, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => a.at.getTime() - b.at.getTime())
}

const sumOf = (
  rows: CostUsageRow[],
  field: "costMicros" | "calls" | "inputTokens" | "outputTokens",
) =>
  rows.some((row) => row[field] !== null)
    ? rows.reduce((sum, row) => sum + (row[field] ?? 0), 0)
    : null
const modelsOf = (rows: CostUsageRow[]) => [...new Set(rows.map((row) => row.model))].join(" + ")

/**
 * De qué se compone una acción (tableros 3 a 5): las pausas de una atención
 * con lo que sugirió cada una, las respuestas de Sofi con lo que hizo, o lo
 * que entendió Argos y sus llamadas. Sin texto de mensajes ni nada clínico.
 */
export async function getClinicCostActionDetail(
  tx: Db,
  orgId: string,
  input: { key: string; which?: "actual" | "anterior"; now?: Date },
): Promise<CostActionDetail> {
  const { context, items, questionUsage } = await loadItems(
    tx,
    orgId,
    input.which ?? "actual",
    input.now,
  )
  const item = items.find((row) => row.key === input.key)
  if (!item) throw notFound("Acción")
  const [kind, id] = [input.key.slice(0, 1), input.key.slice(2)]
  const { usage, targets } = context
  const own = usage.filter((row) => {
    const target = targets.get(row.id)
    if (kind === "a") return !!target && "action" in target && target.action === id
    if (kind === "e")
      return (
        !!target &&
        "bucket" in target &&
        target.bucket === "clio_sin_cobro" &&
        (row.encounterId ?? NO_ID) === id
      )
    if (kind === "c")
      return (
        !!target &&
        "bucket" in target &&
        target.bucket === "sofi_sin_cobro" &&
        (row.conversationId ?? NO_ID) === id
      )
    return false
  })

  if (item.agent === "clio") {
    const encounterId =
      kind === "e" ? id : context.actions.find((row) => row.id === id)?.encounterId
    const suggestions =
      encounterId && encounterId !== NO_ID
        ? await tx
            .select({
              kind: encounterDictationSuggestion.kind,
              status: encounterDictationSuggestion.status,
              createdAt: encounterDictationSuggestion.createdAt,
            })
            .from(encounterDictationSuggestion)
            .where(
              and(
                eq(encounterDictationSuggestion.organizationId, orgId),
                eq(encounterDictationSuggestion.encounterId, encounterId),
              ),
            )
        : []
    const pauses = stepsOf(own)
    // Lo que sugirió cada pausa: lo que se guardó después de su gasto y antes de la pausa siguiente.
    const steps = pauses.map((pause, index) => {
      const next = pauses[index + 1]?.at.getTime() ?? Number.POSITIVE_INFINITY
      const kinds = [
        ...new Set(
          suggestions
            .filter(
              (row) =>
                row.createdAt.getTime() >= pause.at.getTime() && row.createdAt.getTime() < next,
            )
            .map((row) => row.kind),
        ),
      ]
      return {
        id: pause.id,
        at: pause.at,
        what: kinds.length
          ? capital(listWords(kinds.map((value) => DICTATION_WORDS[value] ?? value)))
          : "Nada nuevo",
        model: modelsOf(pause.rows),
        calls: sumOf(pause.rows, "calls") ?? 0,
        inputTokens: sumOf(pause.rows, "inputTokens"),
        outputTokens: sumOf(pause.rows, "outputTokens"),
        costMicros: sumOf(pause.rows, "costMicros") ?? 0,
      }
    })
    const confirmed = [
      ...new Set(suggestions.filter((row) => row.status === "confirmada").map((row) => row.kind)),
    ]
    const facts = confirmed.length
      ? [
          {
            label: "Dejó hecho y confirmado",
            value: capital(listWords(confirmed.map((value) => DICTATION_WORDS[value] ?? value))),
          },
        ]
      : [{ label: "Dejó hecho y confirmado", value: "Nada" }]
    if (pauses.length > 1) {
      const minutes = Math.max(
        1,
        Math.round(((pauses.at(-1)?.at.getTime() ?? 0) - (pauses[0]?.at.getTime() ?? 0)) / 60_000),
      )
      facts.push({
        label: "Dictó durante",
        value: `${minutes} ${minutes === 1 ? "minuto" : "minutos"}`,
      })
    }
    return {
      key: item.key,
      agent: "clio",
      steps,
      facts,
      costMicros: item.costMicros,
      spread: false,
    }
  }

  if (item.agent === "sofi" || (item.agent === "argos" && item.type === "Cita recuperada")) {
    // Cada respuesta: los gastos de una corrida se guardan juntos; lo que hizo sale de su fila del libro.
    const conversationIds = [
      ...new Set(own.map((row) => row.conversationId).filter((value): value is string => !!value)),
    ]
    const runs = conversationIds.length
      ? await tx
          .select({
            conversationId: agentRunLedger.conversationId,
            startedAt: agentRunLedger.startedAt,
            status: agentRunLedger.status,
            toolsUsed: agentRunLedger.toolsUsed,
          })
          .from(agentRunLedger)
          .where(
            and(
              eq(agentRunLedger.organizationId, orgId),
              inArray(agentRunLedger.conversationId, conversationIds),
              gte(agentRunLedger.startedAt, new Date(context.period.start.getTime() - 3_600_000)),
              lt(agentRunLedger.startedAt, context.period.end),
            ),
          )
      : []
    const steps = stepsOf(own, (row) => `${row.conversationId}:${row.createdAt.getTime()}`).map(
      (step) => {
        const run = runs
          .filter(
            (candidate) =>
              candidate.conversationId === step.rows[0]?.conversationId &&
              candidate.startedAt.getTime() <= step.at.getTime(),
          )
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0]
        const did = run
          ? [
              ...new Set(
                run.toolsUsed
                  .map((tool) => TOOL_WORDS[tool])
                  .filter((value): value is string => !!value),
              ),
            ]
          : []
        const lower = (text: string) => text.charAt(0).toLocaleLowerCase("es") + text.slice(1)
        const what = did.length
          ? capital(listWords(did.map(lower)))
          : run && RUN_STATUS_WORDS[run.status]
            ? (RUN_STATUS_WORDS[run.status] as string)
            : "Respondió"
        return {
          id: step.id,
          at: run?.startedAt ?? step.at,
          what,
          model: modelsOf(step.rows),
          calls: sumOf(step.rows, "calls") ?? 0,
          inputTokens: sumOf(step.rows, "inputTokens"),
          outputTokens: sumOf(step.rows, "outputTokens"),
          costMicros: sumOf(step.rows, "costMicros") ?? 0,
        }
      },
    )
    return {
      key: item.key,
      agent: item.agent,
      steps,
      facts: [],
      costMicros: item.costMicros,
      spread: false,
    }
  }

  if (kind === "q") {
    const [row] = await tx
      .select({ outcome: reportQuestion.outcome, plan: reportQuestion.plan })
      .from(reportQuestion)
      .where(and(eq(reportQuestion.organizationId, orgId), eq(reportQuestion.id, id)))
      .limit(1)
    const plan = (row?.plan ?? null) as ArgosStoredPlan | null
    const outcome = OUTCOME_WORDS[row?.outcome ?? ""]
    const facts: Array<{ label: string; value: string }> = [
      { label: "Lo que entendió", value: understoodOf(plan, row?.outcome ?? "") },
    ]
    if (outcome) facts.push({ label: "Cómo terminó", value: outcome })
    if (plan?.fuente)
      facts.push({
        label: "De dónde sale",
        value: plan.fuente === "oficial" ? "Una cifra oficial de Reportes" : "Un cálculo de Argos",
      })
    if (plan?.sede) facts.push({ label: "Sede", value: plan.sede })
    if (plan?.parcial && plan.falta && !aboutPatient(plan))
      facts.push({ label: "Le faltó", value: plan.falta })
    if (plan?.pantalla && SCREEN_WORDS[plan.pantalla])
      facts.push({ label: "Llevó a", value: SCREEN_WORDS[plan.pantalla] as string })
    if (plan?.seguir?.length)
      facts.push({
        label: "Para seguir",
        value: `${plan.seguir.filter(Boolean).length} opciones ya calculadas`,
      })
    const linked = questionUsage.get(id) ?? []
    const steps = linked.map((usageRow) => ({
      id: usageRow.id,
      at: usageRow.createdAt,
      what: "Escribió la consulta",
      model: usageRow.model,
      calls: usageRow.calls,
      inputTokens: usageRow.inputTokens,
      outputTokens: usageRow.outputTokens,
      costMicros: usageRow.costMicros ?? 0,
    }))
    return {
      key: item.key,
      agent: "argos",
      steps,
      facts,
      costMicros: item.costMicros,
      spread: item.spread,
    }
  }

  return {
    key: item.key,
    agent: item.agent,
    steps: [],
    facts: [],
    costMicros: item.costMicros,
    spread: false,
  }
}

export interface ClinicAgentCounts {
  period: { start: Date; end: Date; credit: "prueba" | "mes" }
  /** La zona de la clínica: las fechas del mes se dicen en ella. */
  timezone: string
  sofi: { conversations: number; byTier: Record<"informa" | "gestiona" | "agenda", number> }
  clio: { consultations: number; byTier: Record<"simple" | "estandar" | "completa", number> }
  /** `included`: las preguntas del plan; `limited` false si el plan no las cuenta. */
  argos: { questions: number; included: number; limited: boolean; recovered: number }
}

/**
 * Cuántas cosas hicieron los agentes en el mes, sin importes (decisión D4):
 * lo ve todo el personal, también soporte. Cuenta lo mismo que el cobro
 * (`listPeriodActions`), sin lo anulado, lo devuelto ni lo que va dentro de una cita.
 */
export async function getClinicAgentCounts(
  tx: Db,
  orgId: string,
  now = new Date(),
): Promise<ClinicAgentCounts> {
  const period = await currentSaasPeriod(tx, orgId, now)
  const actions = (await listPeriodActions(tx, orgId, period)).filter(
    (row) => row.state !== "anulada" && row.state !== "dentro_de_cita" && row.state !== "devuelta",
  )
  const allowance = await getArgosAllowance(tx, orgId, now)
  const tier = (kind: string, value: string) =>
    actions.filter((row) => row.kind === kind && row.tier === value).length
  return {
    period: { start: period.start, end: period.end, credit: period.credit },
    timezone: (await findOrgLocale(tx, orgId)).timezone,
    sofi: {
      conversations: actions.filter((row) => row.kind === "conversacion" && row.tier !== "agenda")
        .length,
      byTier: {
        informa: tier("conversacion", "informa"),
        gestiona: tier("conversacion", "gestiona"),
        agenda: tier("conversacion", "agenda"),
      },
    },
    clio: {
      consultations: actions.filter((row) => row.kind === "consulta").length,
      byTier: {
        simple: tier("consulta", "simple"),
        estandar: tier("consulta", "estandar"),
        completa: tier("consulta", "completa"),
      },
    },
    argos: {
      questions: await questionsUsed(tx, orgId, period.start, period.end),
      included: allowance.included,
      limited: allowance.limited,
      recovered: actions.filter((row) => row.kind === "cita").length,
    },
  }
}
