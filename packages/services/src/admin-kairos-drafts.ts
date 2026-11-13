import { type ClinicalProduct, isClinicalProduct, productWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  type KairosWeeklyFigure,
  kairosItem,
  kairosWeekly,
  type SAAS_CLIENT_PROFESSIONALS,
  type SAAS_CLIENT_TOOLS,
  SAAS_OUTREACH_CHANNELS,
  type SaasOutreachChannel,
  saasClient,
  saasClientContact,
} from "@odentia/db/schema/admin-arm"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { user } from "@odentia/db/schema/auth"
import { saasFollowUp } from "@odentia/db/schema/saas-billing"
import { and, asc, desc, eq, inArray, isNotNull, not, sql } from "drizzle-orm"
import { CLIENT_STAGE_WORDS, type ClientStage, clientStageSql } from "./admin-clients.js"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import { type KairosDrafter, kairosReadySql, saveKairosDraft } from "./admin-kairos.js"
import { forecastReport, funnelReport, revenueReport } from "./admin-reports.js"
import { dayWords } from "./document-kit.js"
import { ServiceError } from "./errors.js"
import { limaDate } from "./peru-business-days.js"

const ZONE = { locale: "es-PE", timezone: "America/Lima" }

/**
 * Lo que redacta el modelo de Kairós para el ARM, fuera de toda transacción:
 * los mensajes y guiones que la pasada de reglas dejó en espera
 * (`draftPendingKairosItems`) y el resumen de la semana de Reportes
 * (`writeKairosWeekly`). Lo usan la ruta `/api/admin/kairos/run` y el worker.
 *
 * Al modelo viaja solo lo permitido: el nombre, el producto, la ciudad y la
 * etapa de la clínica, el nombre de la persona, quien firma y los hechos de
 * la venta. Nunca datos de pacientes, adjuntos ni el cuerpo de un correo que
 * llegó; y en lo que ve Soporte, ni notas solo de administración ni importes.
 * Redactar no envía nada: el borrador queda en el ítem y una persona decide.
 */

/** Los datos de la clínica que ve el modelo (`KairosClientFacts` del escritor de Kairós). */
export interface KairosDraftClientFacts {
  name: string
  product: ClinicalProduct
  city?: string | null
  professionals?: string | null
  currentTool?: string | null
  stage: string
}

/**
 * Lo que necesita este módulo del escritor de Kairós (`KairosWriter` de
 * `@odentia/agent`, o su doble determinista): la forma, no el paquete, para
 * que los servicios no dependan del agente.
 */
export interface KairosDraftWriter {
  /** «plantilla» si redacta sin modelo (no configurado); sin el campo, el modelo. */
  readonly drafter?: KairosDrafter
  draftMessage(input: {
    client: KairosDraftClientFacts
    contact?: { name: string; title?: string | null }
    channel: SaasOutreachChannel
    goal: string
    facts: string[]
    senderName: string
  }): Promise<{ subject?: string; body: string }>
  presentationScript(input: {
    client: KairosDraftClientFacts
    facts: string[]
    demo?: { name: string } | null
  }): Promise<{ script: string }>
}

export interface KairosWeeklyWriter {
  readonly drafter?: KairosDrafter
  weeklySummary(input: { figures: KairosWeeklyFigure[] }): Promise<{ text: string }>
}

/** Cuántos borradores pide una pasada como máximo. */
export const KAIROS_DRAFTS_PER_PASS = 20
const DRAFTS_MAX = 50
const FACT_MAX = 300
const RECENT_ACTIVITIES = 3

type SaasClientProfessionals = (typeof SAAS_CLIENT_PROFESSIONALS)[number]
type SaasClientTool = (typeof SAAS_CLIENT_TOOLS)[number]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PROFESSIONALS_WORDS: Record<SaasClientProfessionals, string> = {
  "1": "1 profesional",
  "2-3": "2 a 3 profesionales",
  "4-9": "4 a 9 profesionales",
  "10+": "10 o más profesionales",
}

const TOOL_WORDS: Record<SaasClientTool, string> = {
  nada: "No usa ningún sistema",
  cuaderno_excel: "Cuaderno o Excel",
  otro_software: "Otro programa",
}

const ACTIVITY_WORDS: Record<string, string> = {
  llamada: "Llamada",
  whatsapp: "WhatsApp",
  correo: "Correo",
  reunion: "Reunión",
  presentacion: "Presentación",
  propuesta: "Propuesta",
  nota: "Nota",
}

/* ---------- Lo que puede ver el modelo ---------- */

/** Un importe escrito («S/ 120», «USD 29», «29 dólares»): lo que ve Soporte no lo lleva. */
const MONEY =
  /(?:S\/\.?|US\$|\$|€|\b(?:USD|PEN|EUR)\b)\s?\d[\d.,]*|\d[\d.,]*\s?(?:soles|d[oó]lares|euros|\b(?:USD|PEN|EUR)\b)/giu
/**
 * Lo que parece un dato de un paciente (su historia, un diagnóstico, un DNI):
 * ese hecho no viaja al modelo. Hablar de «sus pacientes» en la venta sí.
 */
const PATIENT = /historia cl[ií]nica|diagn[oó]stic|\bDNI\b|\b\d{8}\b|\b\d{4}[\s.-]\d{4}\b/iu
/**
 * Un monto sin moneda junto a lo que se cobra o se debe («le cobramos 350»,
 * «debe 1.180»): pasaba el filtro de Soporte (medición del 12 nov).
 */
const BARE_AMOUNT =
  /\b((?:cobr|pag|deb|deud|import|mont|preci|cuot|sald)\p{L}*)(\s+(?:de\s+|unos\s+|como\s+)?)\d[\d.,]*/giu
/**
 * Un paciente con su nombre («la paciente Juana Pérez tiene caries»): pasaba
 * el filtro (medición del 12 nov). Sin la marca `i`, para que el nombre sea el
 * que empieza con mayúscula.
 */
const NAMED_PATIENT = /\b[Pp]acientes?\s+(?:[Ss]r\.?\s+|[Ss]ra\.?\s+)?\p{Lu}\p{Ll}+/u

/**
 * Un hecho tal como puede viajar al modelo, o null si no puede: lo que parece
 * de un paciente se omite entero; para lo que ve Soporte, los importes se
 * tachan. Corto a 300 caracteres.
 */
export function kairosAllowedFact(text: string, options: { adminOnly: boolean }): string | null {
  const clean = text.replace(/\s+/g, " ").trim()
  if (!clean || PATIENT.test(clean) || NAMED_PATIENT.test(clean)) return null
  const told = options.adminOnly
    ? clean
    : clean.replace(MONEY, "[importe]").replace(BARE_AMOUNT, "$1$2[importe]")
  return told.length > FACT_MAX ? `${told.slice(0, FACT_MAX - 1)}…` : told
}

/** Un borrador por redactar, con lo justo que verá el modelo. */
export interface KairosDraftJob {
  itemId: string
  kind: "mensaje" | "guion"
  goal: string
  channel: SaasOutreachChannel | null
  client: KairosDraftClientFacts
  contact: { name: string; title: string | null } | null
  senderName: string
  demo: { name: string } | null
  facts: string[]
  adminOnly: boolean
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null

/**
 * Lo que espera redacción: mensajes y guiones en espera, vigentes, sin
 * borrador y con cliente no archivado, los más viejos primero, con sus hechos
 * permitidos. Solo lee.
 */
export async function pendingKairosDraftJobs(
  tx: Db,
  options: { limit?: number } = {},
  now = new Date(),
): Promise<KairosDraftJob[]> {
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? KAIROS_DRAFTS_PER_PASS), 1),
    DRAFTS_MAX,
  )
  const pending = await tx
    .select({
      item: kairosItem,
      client: {
        name: saasClient.name,
        product: saasClient.product,
        city: saasClient.city,
        professionals: saasClient.professionals,
        currentTool: saasClient.currentTool,
        ownerUserId: saasClient.ownerUserId,
      },
      stage: clientStageSql(now),
    })
    .from(kairosItem)
    .innerJoin(saasClient, eq(saasClient.id, kairosItem.clientId))
    .where(
      and(
        eq(kairosItem.status, "espera"),
        inArray(kairosItem.kind, ["mensaje", "guion"]),
        sql`not ${kairosReadySql}`,
        sql`${kairosItem.expiresAt} > ${now.toISOString()}::timestamptz`,
        sql`${saasClient.archivedAt} is null`,
      ),
    )
    .orderBy(asc(kairosItem.createdAt), asc(kairosItem.id))
    .limit(limit)

  const jobs: KairosDraftJob[] = []
  for (const { item, client, stage } of pending) {
    const clientId = item.clientId
    if (!clientId) continue
    const payload = item.payload
    const product: ClinicalProduct = isClinicalProduct(client.product) ? client.product : "dental"
    const contactId = str(payload.contactId)
    const [contact] =
      contactId && UUID.test(contactId)
        ? await tx
            .select({ name: saasClientContact.name, title: saasClientContact.title })
            .from(saasClientContact)
            .where(
              and(eq(saasClientContact.id, contactId), eq(saasClientContact.clientId, clientId)),
            )
            .limit(1)
        : []
    const [sender] = client.ownerUserId
      ? await tx
          .select({ name: user.name })
          .from(user)
          .where(eq(user.id, client.ownerUserId))
          .limit(1)
      : []
    const demoId = str(payload.demoId)
    const [demo] =
      demoId && UUID.test(demoId)
        ? await tx
            .select({ name: saasDemo.name })
            .from(saasDemo)
            .where(eq(saasDemo.id, demoId))
            .limit(1)
        : []
    // Lo último que se habló: sin lo que es solo de administración si el
    // borrador no lo es, sin la nota vieja y sin el cuerpo de un correo que
    // llegó (lo escribió la clínica y puede traer cualquier cosa).
    const recent = await tx
      .select({
        kind: saasFollowUp.kind,
        direction: saasFollowUp.direction,
        outcome: saasFollowUp.outcome,
        body: saasFollowUp.body,
        happenedAt: saasFollowUp.happenedAt,
      })
      .from(saasFollowUp)
      .where(
        and(
          eq(saasFollowUp.clientId, clientId),
          not(saasFollowUp.fromNote),
          item.adminOnly ? undefined : not(saasFollowUp.adminOnly),
        ),
      )
      .orderBy(desc(saasFollowUp.happenedAt))
      .limit(RECENT_ACTIVITIES)
    const told = (text: string) => kairosAllowedFact(text, { adminOnly: item.adminOnly })
    const facts = [
      item.reason,
      ...(Array.isArray(payload.facts)
        ? payload.facts.filter((fact): fact is string => typeof fact === "string")
        : []),
    ]
      .map(told)
      .filter((fact): fact is string => fact !== null)
      // El motivo del ítem suele repetir su primer hecho («Dijo «no por ahora»…» dos veces).
      .filter((fact, index, all) => all.indexOf(fact) === index)
    for (const entry of recent) {
      const label = ACTIVITY_WORDS[entry.kind] ?? "Actividad"
      // En palabras: el borrador con plantilla lo copia tal cual y el modelo
      // no debe devolver una fecha AAAA-MM-DD a la clínica.
      const day = dayWords(entry.happenedAt, ZONE)
      if (entry.kind === "correo" && entry.direction === "entro") {
        facts.push(`${label} de la clínica el ${day}`)
        continue
      }
      const body = told(entry.body)
      if (!body) continue
      const outcome = entry.outcome ? told(entry.outcome) : null
      facts.push(`${label} del ${day}: ${body}${outcome ? ` · quedó en: ${outcome}` : ""}`)
    }
    const channel = str(payload.channel)
    jobs.push({
      itemId: item.id,
      kind: item.kind === "guion" ? "guion" : "mensaje",
      goal: str(payload.goal) ?? item.kind,
      channel:
        channel && (SAAS_OUTREACH_CHANNELS as readonly string[]).includes(channel)
          ? (channel as SaasOutreachChannel)
          : null,
      client: {
        name: client.name,
        product,
        city: client.city,
        professionals: client.professionals
          ? (PROFESSIONALS_WORDS[client.professionals as SaasClientProfessionals] ?? null)
          : null,
        currentTool: client.currentTool
          ? (TOOL_WORDS[client.currentTool as SaasClientTool] ?? null)
          : null,
        stage: CLIENT_STAGE_WORDS[stage as ClientStage] ?? String(stage),
      },
      contact: contact ? { name: contact.name, title: contact.title } : null,
      senderName: sender?.name?.trim() || `El equipo de ${productWords(product).name}`,
      demo: demo ? { name: demo.name } : null,
      facts,
      adminOnly: item.adminOnly,
    })
  }
  return jobs
}

export interface KairosDraftsOutcome {
  /** Los que quedaron redactados y listos para un sí. */
  drafted: string[]
  /** Los que ya no esperaban, o alguien redactó antes. */
  skipped: string[]
  /** Los que el modelo no pudo redactar: la pasada siguiente los vuelve a pedir. */
  failed: Array<{ itemId: string; error: string }>
  /** Quién redactó: el modelo, o la plantilla si el modelo no está configurado. */
  drafter: KairosDrafter
}

/**
 * Redacta con el modelo los mensajes y guiones que esperan borrador (como
 * mucho `limit`, 20 por defecto) y guarda cada borrador en su ítem
 * (`saveKairosDraft`). El modelo corre fuera de toda transacción; cada
 * borrador se guarda en la suya, con el ítem bloqueado, solo si todavía
 * espera y nadie lo redactó. Un fallo del modelo no frena a los demás.
 */
export async function draftPendingKairosItems(
  ownerDb: Db,
  writer: KairosDraftWriter,
  options: { limit?: number } = {},
  now = new Date(),
): Promise<KairosDraftsOutcome> {
  const jobs = await ownerDb.transaction((tx) => pendingKairosDraftJobs(tx, options, now))
  const drafter: KairosDrafter = writer.drafter ?? "modelo"
  const outcome: KairosDraftsOutcome = { drafted: [], skipped: [], failed: [], drafter }
  for (const job of jobs) {
    let draft: { subject?: string | null; body: string; drafter: KairosDrafter }
    try {
      if (job.kind === "guion") {
        const { script } = await writer.presentationScript({
          client: job.client,
          facts: job.facts,
          demo: job.demo,
        })
        draft = { body: script, drafter }
      } else {
        if (!job.channel) {
          outcome.skipped.push(job.itemId)
          continue
        }
        const written = await writer.draftMessage({
          client: job.client,
          ...(job.contact ? { contact: job.contact } : {}),
          channel: job.channel,
          goal: job.goal,
          facts: job.facts,
          senderName: job.senderName,
        })
        draft = {
          subject: job.channel === "correo" ? (written.subject ?? null) : null,
          body: written.body,
          drafter,
        }
      }
    } catch (error) {
      outcome.failed.push({
        itemId: job.itemId,
        error: error instanceof Error ? error.message.slice(0, 300) : "El modelo no respondió",
      })
      continue
    }
    try {
      const saved = await ownerDb.transaction(async (tx) => {
        const [row] = await tx
          .select({ status: kairosItem.status, payload: kairosItem.payload })
          .from(kairosItem)
          .where(eq(kairosItem.id, job.itemId))
          .for("update")
        if (
          row?.status !== "espera" ||
          (row.payload.draft && typeof row.payload.draft === "object")
        )
          return false
        return saveKairosDraft(tx, job.itemId, draft)
      })
      ;(saved ? outcome.drafted : outcome.skipped).push(job.itemId)
    } catch (error) {
      // Un borrador que no cabe (vacío, muy largo) no se guarda: se vuelve a pedir.
      if (!(error instanceof ServiceError)) throw error
      outcome.failed.push({ itemId: job.itemId, error: error.message })
    }
  }
  return outcome
}

/* ---------- El resumen de la semana ---------- */

/** El lunes (día de Lima) de la semana de `now`. */
export function kairosWeekStart(now = new Date()): string {
  const today = limaDate(now)
  const day = new Date(`${today}T00:00:00Z`)
  const back = (day.getUTCDay() + 6) % 7
  return new Date(day.getTime() - back * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Quien lee los reportes para el resumen de la semana: la misma regla de la
 * pantalla, sin quitar nada. Solo lee; nunca escribe como este actor.
 */
const KAIROS_READER: AdminActor = { userId: "kairos", role: "admin" }

/**
 * Las cifras que cita el resumen de la semana, del cálculo de los reportes
 * (nunca del modelo): embudo de los últimos 3 meses, cobrado del mes y lo
 * que suman las propuestas enviadas vigentes.
 */
export async function kairosWeeklyFigures(tx: Db, now = new Date()): Promise<KairosWeeklyFigure[]> {
  const [funnel, revenue, forecast] = [
    await funnelReport(tx, KAIROS_READER, { months: 3 }, now),
    await revenueReport(tx, KAIROS_READER, now, { months: 3 }),
    await forecastReport(tx, KAIROS_READER, now),
  ]
  const figures: KairosWeeklyFigure[] = [
    { label: `Clientes nuevos (${funnel.spanWords})`, words: funnel.clients.words },
    { label: "Conversión a cuenta", words: funnel.conversion.words },
    ...funnel.stages.map((stage) => ({
      label: `Llegaron a ${stage.label}`,
      words: stage.reached.words,
    })),
    { label: "Perdidas", words: funnel.lost.words },
    { label: "Clínicas que pagan", words: revenue.paying.words },
    { label: `Cobrado en ${revenue.monthLabel}`, words: revenue.collected.words },
    { label: "Cuota mensual de las que pagan", words: revenue.monthlyFee.words },
    { label: "Propuestas enviadas vigentes", words: forecast.proposals.words },
    { label: "Suman las propuestas vigentes", words: forecast.total.words },
  ]
  return figures.filter((figure) => figure.words.trim())
}

export interface KairosWeeklyRow {
  weekStart: string
  text: string
  figures: KairosWeeklyFigure[]
  createdAt: Date
}

/**
 * Escribe el resumen de la semana de `now`, una sola vez: si ya está, lo
 * devuelve sin llamar al modelo. Las cifras salen de los reportes y el
 * modelo solo las cita. Lo deja en la auditoría como hecho de Kairós.
 */
export async function writeKairosWeekly(
  ownerDb: Db,
  writer: KairosWeeklyWriter,
  now = new Date(),
): Promise<{ row: KairosWeeklyRow; written: boolean }> {
  const weekStart = kairosWeekStart(now)
  const existing = await ownerDb
    .select()
    .from(kairosWeekly)
    .where(eq(kairosWeekly.weekStart, weekStart))
    .limit(1)
  if (existing[0]) return { row: existing[0], written: false }
  const figures = await ownerDb.transaction((tx) => kairosWeeklyFigures(tx, now))
  const { text } = await writer.weeklySummary({ figures })
  const clean = text?.trim() ?? ""
  if (!clean) throw new ServiceError("KAIROS_WEEKLY_EMPTY", 502, "Kairós no escribió el resumen")
  return ownerDb.transaction(async (tx) => {
    const [row] = await tx
      .insert(kairosWeekly)
      .values({ weekStart, text: clean.slice(0, 4000), figures, createdAt: now })
      .onConflictDoNothing()
      .returning()
    if (!row) {
      const [other] = await tx
        .select()
        .from(kairosWeekly)
        .where(eq(kairosWeekly.weekStart, weekStart))
        .limit(1)
      if (!other) throw new ServiceError("INTERNAL", 500, "No se guardó el resumen de la semana")
      return { row: other, written: false }
    }
    await writeAdminAudit(tx, null, {
      action: "kairos.weekly_written",
      entityId: weekStart,
      metadata: { figures: figures.length },
    })
    return { row, written: true }
  })
}

/** El último resumen de la semana, para Reportes: solo Administración. */
export async function latestKairosWeekly(
  tx: Db,
  actor: AdminActor | null,
): Promise<KairosWeeklyRow | null> {
  if (actor?.role !== "admin")
    throw new ServiceError("FORBIDDEN", 403, "Los reportes son de Administración")
  const [row] = await tx
    .select()
    .from(kairosWeekly)
    .where(isNotNull(kairosWeekly.weekStart))
    .orderBy(desc(kairosWeekly.weekStart))
    .limit(1)
  return row ?? null
}
