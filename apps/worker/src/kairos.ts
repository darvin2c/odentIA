import type { KairosUse, KairosWriter } from "@odentia/agent"
import type { Db } from "@odentia/db"
import {
  type SaasClientOrigin,
  type SaasLostReason,
  saasClient,
} from "@odentia/db/schema/admin-arm"
import {
  CLIENT_ORIGIN_WORDS,
  CLIENT_STAGE_WORDS,
  type ClientStage,
  clientStageSql,
  draftPendingKairosItems,
  KAIROS_DRAFTS_PER_PASS,
  kairosAiUseRecorder,
  kairosAllowedFact,
  kairosRulesPass,
  LOST_REASON_WORDS,
  purgeDueClientFiles,
  type Storage,
  taskHiddenFromSupportSql,
  writeAdminAudit,
  writeKairosWeekly,
} from "@odentia/services"
import { sql } from "drizzle-orm"

/**
 * La pasada de Kairós en el worker (ARM de la administración): cada 5
 * minutos corre las reglas sin modelo (`kairosRulesPass`), pide al modelo los
 * borradores que esperan (hasta 20: mensajes, guiones y la respuesta de cada
 * correo nuevo a hola@, contacto@, fundadores@ o a una persona del equipo) y
 * borra la carga de datos (lo que Administración marcó así) a los 30 días de
 * llegar, con el texto de su correo. Una vez al día, desde las 07:00 de Lima, renueva «Lo que hay que
 * saber» de hasta 30 clientes con algo nuevo y, si la semana aún no lo tiene,
 * escribe el resumen de la semana de Reportes. Nunca envía nada a una
 * clínica: lo que prepara queda en espera del sí de una persona. La hora la
 * pone la base (`select now()`), para que todas las réplicas decidan lo mismo.
 */

/** Cada cuánto corre la pasada. */
export const KAIROS_TICK_MS = 5 * 60_000
/** Desde qué hora de Lima corre lo del día. */
export const KAIROS_DAILY_HOUR = 7
/** Cuántos resúmenes de clientes renueva por día como máximo. */
export const KAIROS_SUMMARIES_PER_DAY = 30
/** Cuántas actividades del cliente lee para su resumen. */
const SUMMARY_ACTIVITIES = 12

export interface KairosTickDeps {
  ownerDb: Db
  writer: KairosWriter
  storage: Pick<Storage, "deleteAttachment">
  /** La hora de la base; las pruebas la fijan. */
  now?: Date
}

export interface KairosTickResult {
  now: Date
  pass: {
    clientsCreated: number
    clientsLinked: number
    activities: number
    tasks: number
    items: number
    signals: number
  } | null
  drafted: number
  draftsFailed: number
  /** El día de Lima de lo diario, si esta pasada lo reclamó. */
  day: string | null
  summaries: number
  summariesFailed: number
  /** El lunes de la semana cuyo resumen escribió esta pasada. */
  weekly: string | null
  filesDeleted: number
  filesFailed: number
  /** De cuántos correos de la carga se borró el texto. */
  textsCleared: number
  /** Lo que falló, en palabras para el registro; nunca corta las demás partes. */
  errors: string[]
}

const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300)

async function dbNow(ownerDb: Db): Promise<Date> {
  const [row] = await ownerDb.execute<{ now: string }>(sql`select now()::text as now`)
  return new Date(row?.now ?? new Date().toISOString())
}

/**
 * Reclama lo del día: desde las 07:00 de Lima y una sola vez por día, con la
 * pasada bloqueada para que dos workers no lo reclamen a la vez. La clave es
 * la auditoría `kairos.daily_pass` con el día de Lima. Devuelve el día, o
 * null si no toca o ya lo hizo otro.
 */
export async function claimKairosDay(ownerDb: Db, now: Date): Promise<string | null> {
  return ownerDb.transaction(async (tx) => {
    const instant = now.toISOString()
    const [at] = await tx.execute<{ hour: number; day: string }>(sql`select
      extract(hour from ${instant}::timestamptz at time zone 'America/Lima')::int as hour,
      (${instant}::timestamptz at time zone 'America/Lima')::date::text as day`)
    if (!at || Number(at.hour) < KAIROS_DAILY_HOUR) return null
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('kairos:daily'))`)
    const done = await tx.execute<{ id: string }>(
      sql`select id from admin_audit where action = 'kairos.daily_pass' and entity_id = ${at.day} limit 1`,
    )
    if (done.length > 0) return null
    await writeAdminAudit(tx, null, { action: "kairos.daily_pass", entityId: at.day })
    return at.day
  })
}

/* ---------- «Lo que hay que saber» ---------- */

const ACTIVITY_WORDS: Record<string, string> = {
  llamada: "Llamada",
  whatsapp: "WhatsApp",
  correo: "Correo",
  reunion: "Reunión",
  presentacion: "Presentación",
  propuesta: "Propuesta",
  nota: "Nota",
}

const ROLE_WORDS: Record<string, string> = { decide: "decide", usa: "lo usaría", paga: "paga" }

const PROPOSAL_WORDS: Record<string, string> = {
  borrador: "en borrador",
  por_aprobar: "por aprobar",
  enviada: "enviada",
  aceptada: "aceptada",
  no_aceptada: "no aceptada",
}

const DECISION_WORDS: Record<string, string> = {
  entro: "Entró",
  no_por_ahora: "No por ahora",
  perdido: "Perdido",
}

type SummaryClient = {
  id: string
  name: string
  product: "dental" | "medical" | "optical"
  city: string | null
  professionals: string | null
  current_tool: string | null
  origin: string
  organization_id: string | null
  stage: string
}

/**
 * Los clientes con algo nuevo desde su último resumen (o sin resumen y con
 * algo que decir), los de movimiento más reciente primero. Los archivados no.
 */
async function summaryCandidates(ownerDb: Db, now: Date, limit: number): Promise<SummaryClient[]> {
  return ownerDb.execute<SummaryClient>(sql`select saas_client.id, saas_client.name, saas_client.product, saas_client.city, saas_client.professionals,
      saas_client.current_tool, saas_client.origin, saas_client.organization_id, ${clientStageSql(now)} as stage
    from ${saasClient}
    where saas_client.archived_at is null
      and (exists (select 1 from saas_follow_up f where f.client_id = saas_client.id)
        or exists (select 1 from saas_client_contact k where k.client_id = saas_client.id))
      and (saas_client.summary_at is null
        or saas_client.updated_at > saas_client.summary_at
        or exists (select 1 from saas_follow_up f where f.client_id = saas_client.id and f.created_at > saas_client.summary_at)
        or exists (select 1 from saas_task t where t.client_id = saas_client.id and t.updated_at > saas_client.summary_at)
        or exists (select 1 from saas_client_contact k where k.client_id = saas_client.id and k.updated_at > saas_client.summary_at)
        or exists (select 1 from saas_proposal p where p.client_id = saas_client.id and p.updated_at > saas_client.summary_at)
        or exists (select 1 from saas_opportunity o where o.client_id = saas_client.id and o.updated_at > saas_client.summary_at))
    order by (select max(f.created_at) from saas_follow_up f where f.client_id = saas_client.id) desc nulls last,
      saas_client.created_at desc
    limit ${limit}`) as unknown as Promise<SummaryClient[]>
}

/**
 * Un día AAAA-MM-DD en palabras («12 de noviembre de 2026»). El resumen con
 * plantilla copia los hechos tal cual en la ficha, y el modelo no debe
 * devolver una fecha en formato técnico (QA del ARM, 12 nov).
 */
const DAY_WORDS = new Intl.DateTimeFormat("es-PE", {
  timeZone: "UTC",
  day: "numeric",
  month: "long",
  year: "numeric",
})
export const summaryDay = (iso: string): string =>
  /^\d{4}-\d{2}-\d{2}$/.test(iso) ? DAY_WORDS.format(new Date(`${iso}T00:00:00Z`)) : iso

/**
 * Los hechos de un cliente, cada uno con su fuente (`actividad:<id>`,
 * `contacto:<id>`…). Lo ve también Soporte: sin lo que es solo de
 * administración, sin importes, sin el cuerpo de un correo que llegó y sin
 * nada que parezca de un paciente (`kairosAllowedFact`).
 */
export async function clientSummaryFacts(
  ownerDb: Db,
  client: SummaryClient,
): Promise<{ text: string; source: string }[]> {
  const facts: { text: string; source: string }[] = []
  const add = (text: string, source: string) => {
    const told = kairosAllowedFact(text, { adminOnly: false })
    if (told) facts.push({ text: told, source })
  }
  add(
    `Llegó por: ${CLIENT_ORIGIN_WORDS[client.origin as SaasClientOrigin] ?? "Otro"}`,
    "cliente:origen",
  )
  if (client.organization_id) add("Ya tiene su cuenta abierta", "cliente:cuenta")
  const requests = await ownerDb.execute<{ id: string; day: string }>(sql`select id,
      to_char(created_at at time zone 'America/Lima', 'YYYY-MM-DD') as day
    from saas_waitlist_request where client_id = ${client.id}::uuid order by created_at desc limit 1`)
  for (const request of requests)
    add(`Dejó su solicitud en la web el ${summaryDay(request.day)}`, `solicitud:${request.id}`)
  const contacts = await ownerDb.execute<{
    id: string
    name: string
    title: string | null
    roles: string[]
    is_primary: boolean
  }>(
    sql`select id, name, title, roles, is_primary from saas_client_contact
      where client_id = ${client.id}::uuid order by is_primary desc, created_at limit 6`,
  )
  for (const contact of contacts) {
    const roles = (contact.roles ?? []).map((role) => ROLE_WORDS[role]).filter(Boolean)
    add(
      `${contact.name}${contact.title ? `, ${contact.title}` : ""}${roles.length ? ` (${roles.join(", ")})` : ""}${contact.is_primary ? ", persona principal" : ""}`,
      `contacto:${contact.id}`,
    )
  }
  const activities = await ownerDb.execute<{
    id: string
    kind: string
    direction: string | null
    outcome: string | null
    body: string
    day: string
  }>(
    sql`select id, kind, direction, outcome, body,
        to_char(happened_at at time zone 'America/Lima', 'YYYY-MM-DD') as day
      from saas_follow_up
      where client_id = ${client.id}::uuid and not admin_only and not from_note
      order by happened_at desc limit ${SUMMARY_ACTIVITIES}`,
  )
  for (const entry of activities) {
    const label = ACTIVITY_WORDS[entry.kind] ?? "Actividad"
    if (entry.kind === "correo" && entry.direction === "entro") {
      add(`${label} de la clínica el ${summaryDay(entry.day)}`, `actividad:${entry.id}`)
      continue
    }
    const by = entry.direction === "entro" ? " de la clínica" : ""
    add(
      `${label}${by} del ${summaryDay(entry.day)}: ${entry.body}${entry.outcome ? ` · quedó en: ${entry.outcome}` : ""}`,
      `actividad:${entry.id}`,
    )
  }
  // Las tareas solo de Administración (y las de cobro) no las ve Soporte.
  const tasks = await ownerDb.execute<{ id: string; title: string; due_on: string }>(
    sql`select t.id, t.title, t.due_on::text as due_on from saas_task t
      where t.client_id = ${client.id}::uuid and t.status = 'abierta' and not ${taskHiddenFromSupportSql("t")}
      order by t.due_on limit 3`,
  )
  for (const task of tasks)
    add(`Tarea abierta: ${task.title}, para el ${summaryDay(task.due_on)}`, `tarea:${task.id}`)
  const proposals = await ownerDb.execute<{
    id: string
    version: number
    status: string
    valid_until: string
  }>(
    sql`select id, version, status, valid_until::text as valid_until from saas_proposal
      where client_id = ${client.id}::uuid order by version desc limit 1`,
  )
  for (const proposal of proposals)
    add(
      `Propuesta ${proposal.version}: ${PROPOSAL_WORDS[proposal.status] ?? proposal.status}${proposal.status === "enviada" ? `, vale hasta el ${summaryDay(proposal.valid_until)}` : ""}`,
      `propuesta:${proposal.id}`,
    )
  // La última decisión de la venta, sin su nota libre.
  const decisions = await ownerDb.execute<{
    id: string
    decision: string
    reason: string | null
    return_on: string | null
  }>(
    sql`select id, decision, reason, return_on::text as return_on from saas_opportunity
      where client_id = ${client.id}::uuid and decision is not null
      order by decided_at desc limit 1`,
  )
  for (const decided of decisions) {
    const reason = decided.reason ? LOST_REASON_WORDS[decided.reason as SaasLostReason] : null
    add(
      `Se decidió «${DECISION_WORDS[decided.decision] ?? decided.decision}»${reason ? `, por: ${reason}` : ""}${decided.return_on ? `; volver el ${summaryDay(decided.return_on)}` : ""}`,
      `venta:${decided.id}`,
    )
  }
  return facts
}

/**
 * Renueva «Lo que hay que saber» de hasta `limit` clientes con algo nuevo.
 * El modelo corre fuera de toda transacción; cada resumen se guarda con su
 * fuente por frase y `summary_at` = la hora de la pasada, así lo que se anote
 * mientras tanto vuelve a contar como nuevo. Un fallo no frena a los demás.
 */
export async function renewClientSummaries(
  ownerDb: Db,
  writer: Pick<KairosWriter, "summarizeClient">,
  now: Date,
  limit = KAIROS_SUMMARIES_PER_DAY,
): Promise<{ written: number; failed: number; errors: string[] }> {
  const out = { written: 0, failed: 0, errors: [] as string[] }
  for (const client of await summaryCandidates(ownerDb, now, limit)) {
    try {
      const facts = await clientSummaryFacts(ownerDb, client)
      if (facts.length === 0) continue
      const result = await writer.summarizeClient({
        client: {
          name: client.name,
          product: client.product,
          city: client.city,
          professionals: client.professionals,
          currentTool: client.current_tool,
          stage: CLIENT_STAGE_WORDS[client.stage as ClientStage] ?? client.stage,
        },
        facts,
      })
      // Solo las fuentes que se le dieron: Kairós nunca cita algo que no esté anotado.
      const known = new Set(facts.map((fact) => fact.source))
      const sources = result.sources.filter((source) => known.has(source.source))
      const summary = result.summary.trim().slice(0, 2000)
      if (!summary || sources.length === 0) throw new Error("El resumen llegó sin fuentes")
      await ownerDb.transaction(async (tx) => {
        // Sin tocar `updated_at`: el resumen no es un cambio del cliente.
        await tx.execute(sql`update saas_client set summary = ${summary},
            summary_sources = ${JSON.stringify(sources)}::jsonb, summary_at = ${now.toISOString()}::timestamptz
          where id = ${client.id}::uuid`)
        await writeAdminAudit(tx, null, {
          action: "kairos.summary_written",
          entityId: client.id,
          // `passAt`: los resúmenes de una pasada se leen juntos en «Lo que hizo».
          metadata: { clientId: client.id, sources: sources.length, passAt: now.toISOString() },
        })
      })
      out.written += 1
    } catch (error) {
      out.failed += 1
      out.errors.push(`resumen de ${client.id}: ${message(error)}`)
    }
  }
  return out
}

/* ---------- La pasada ---------- */

/**
 * Una vuelta de Kairós. Cada parte corre aunque otra falle: las reglas, los
 * borradores, lo del día y el borrado de archivos vencidos.
 */
export async function runKairosTick(deps: KairosTickDeps): Promise<KairosTickResult> {
  const now = deps.now ?? (await dbNow(deps.ownerDb))
  const result: KairosTickResult = {
    now,
    pass: null,
    drafted: 0,
    draftsFailed: 0,
    day: null,
    summaries: 0,
    summariesFailed: 0,
    weekly: null,
    filesDeleted: 0,
    filesFailed: 0,
    textsCleared: 0,
    errors: [],
  }
  try {
    result.pass = await deps.ownerDb.transaction((tx) => kairosRulesPass(tx, now))
  } catch (error) {
    result.errors.push(`reglas: ${message(error)}`)
  }
  try {
    const drafts = await draftPendingKairosItems(
      deps.ownerDb,
      deps.writer,
      { limit: KAIROS_DRAFTS_PER_PASS },
      now,
    )
    result.drafted = drafts.drafted.length
    result.draftsFailed = drafts.failed.length
    for (const failed of drafts.failed)
      result.errors.push(`borrador de ${failed.itemId}: ${failed.error}`)
  } catch (error) {
    result.errors.push(`borradores: ${message(error)}`)
  }
  try {
    result.day = await claimKairosDay(deps.ownerDb, now)
  } catch (error) {
    result.errors.push(`día: ${message(error)}`)
  }
  if (result.day) {
    try {
      const summaries = await renewClientSummaries(deps.ownerDb, deps.writer, now)
      result.summaries = summaries.written
      result.summariesFailed = summaries.failed
      result.errors.push(...summaries.errors)
    } catch (error) {
      result.errors.push(`resúmenes: ${message(error)}`)
    }
    // El lunes se escribe el de la semana; si ese día falló, lo intenta el día siguiente (una vez por día).
    try {
      const weekly = await writeKairosWeekly(deps.ownerDb, deps.writer, now)
      if (weekly.written) result.weekly = weekly.row.weekStart
    } catch (error) {
      result.errors.push(`semana: ${message(error)}`)
    }
  }
  try {
    const purged = await purgeDueClientFiles(deps.ownerDb, deps.storage, now)
    result.filesDeleted = purged.deleted
    result.filesFailed = purged.failed
    result.textsCleared = purged.textsCleared
  } catch (error) {
    result.errors.push(`archivos: ${message(error)}`)
  }
  return result
}

/**
 * La cola del worker con su regulador: corre la pasada cada `KAIROS_TICK_MS`.
 * Un error queda en el registro y la próxima vuelta lo intenta de nuevo.
 */
export function kairosQueue(deps: Omit<KairosTickDeps, "now">): {
  name: string
  poll: () => Promise<boolean>
} {
  let next = 0
  return {
    name: "kairos",
    poll: async () => {
      if (Date.now() < next) return false
      next = Date.now() + KAIROS_TICK_MS
      const result = await runKairosTick(deps)
      for (const error of result.errors) console.error(`worker: kairos ${error}`)
      return false
    },
  }
}

/** Lo que gastó Kairós en el modelo, como gasto de Sallca (`kairosAiUseRecorder` de los servicios). */
export function kairosUseRecorder(ownerDb: Db): (use: KairosUse) => Promise<void> {
  return kairosAiUseRecorder(ownerDb)
}
