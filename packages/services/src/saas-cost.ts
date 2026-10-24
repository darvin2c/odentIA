import type { Db } from "@odentia/db"
import { type AiUsageOrigin, aiUsage } from "@odentia/db/schema/agent"
import { organization } from "@odentia/db/schema/auth"
import { conversation } from "@odentia/db/schema/crm"
import { reportQuestion } from "@odentia/db/schema/reports"
import {
  type SaasActionTier,
  saasPlan,
  saasSeller,
  saasSubscription,
  storageUsageDay,
} from "@odentia/db/schema/saas-billing"
import { and, desc, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm"
import { AGENT_TEST_ORIGINS } from "./ai-usage.js"
import { previousSaasPeriod } from "./saas-action-review.js"
import {
  currentSaasPeriod,
  listPeriodActions,
  microsToCents,
  netMicros,
  type SaasActionRow,
  type SaasPeriod,
  STORAGE_GB_BYTES,
} from "./saas-actions.js"
import { saasTermsAt } from "./saas-commercial-terms.js"

/**
 * Costo y margen de cada clínica (ADR 0085, tableros O2 y O3): lo cobrado sin
 * impuesto frente a lo que nos costó, por agente y tipo. Solo lo ve odentIA.
 *
 * - La IA es lo que reportó cada proveedor en cada llamada (`ai_usage`),
 *   unido a su acción: el dictado por su atención, Sofi por la persona y la
 *   ventana de su conversación. Lo que no tiene acción (las pruebas, Jev, lo
 *   que pasó al equipo) va en su fila, como lo que regalamos.
 * - El espacio es lo guardado al precio del proveedor.
 * - El servidor y los gastos fijos son un estimado repartido por clínica.
 */

/** Lo que nos cuesta guardar un GB un mes en el proveedor (Cloudflare R2, estudio del 2026-10-23). */
export const SAAS_STORAGE_COST_MICROS_PER_GB = 15_000
/**
 * Parte del servidor y los gastos fijos de una clínica al mes, estimada en el
 * estudio (unos USD 132 para 24 clínicas). Se ajusta cuando cambie la
 * infraestructura o el número de clínicas.
 */
export const SAAS_FIXED_COST_MICROS = 5_500_000
/** La alarma interna: la IA de una clínica pasa de esta parte de lo que paga… */
export const SAAS_AI_ALARM_SHARE_BPS = 2000
/** …o de este monto al mes. Nunca corta nada: es para revisar un error o un abuso. */
export const SAAS_AI_ALARM_MICROS = 30_000_000
/** Una clínica fundadora sin encender ningún agente en estos días: conviene escribirle. */
export const SAAS_FOUNDER_IDLE_DAYS = 60

export type CostGroup = "sofi" | "clio" | "argos" | "regalo" | "no_ia"

export interface CostLine {
  key: string
  group: CostGroup
  label: string
  /** Cuántas acciones, preguntas o llamadas; null si no se cuenta (el servidor). */
  count: number | null
  chargedCents: number
  costMicros: number
  /** null si no se cobra. */
  marginPct: number | null
  /** «Lo regalamos», «estimado»: lo que dice al lado. */
  note: string | null
  /** Las atenciones o conversaciones de ese tipo, la más cara primero (hasta 20). */
  detail: Array<{
    occurredAt: Date
    personName: string | null
    what: string
    calls: number
    chargedCents: number
    costMicros: number
  }>
}

export interface ClinicCostMargin {
  organizationId: string
  organizationName: string
  period: { start: Date; end: Date; credit: "prueba" | "mes" }
  currency: string
  planName: string | null
  founder: boolean
  chargedCents: number
  aiMicros: number
  storageMicros: number
  fixedMicros: number
  costMicros: number
  marginPct: number | null
  commissionCents: number
  marginAfterCommissionPct: number | null
  /** La IA sobre lo cobrado, en puntos básicos; null si no se cobró nada. */
  aiShareBps: number | null
  alarm: boolean
  /** Fundadora sin encender ningún agente en `SAAS_FOUNDER_IDLE_DAYS`. */
  idle: boolean
  sellerName: string | null
  /** Llamadas sin costo conocido (modelo sin precio o uso no reportado): no están en el total. */
  unpricedCalls: number
  lines: CostLine[]
}

const pct = (charged: number, cost: number): number | null =>
  charged > 0 ? Math.round((1 - cost / charged) * 100) : null

const SOFI_TIERS: SaasActionTier[] = ["informa", "gestiona", "agenda"]
const CLIO_TIERS: SaasActionTier[] = ["simple", "estandar", "completa"]
const TIER_LABEL: Record<SaasActionTier, string> = {
  informa: "Informa",
  gestiona: "Gestiona",
  agenda: "Agenda (subidas)",
  simple: "Simple",
  estandar: "Estándar",
  completa: "Completa",
}
const SUPPORT_ORIGINS: AiUsageOrigin[] = ["vectores", "comprobacion", "transcripcion"]
/** Lo que Argos hace sin cobrar: los pedidos al Administrador y el «¿ya avisó algo?» antes de un seguimiento. */
const ARGOS_ORIGINS: AiUsageOrigin[] = ["administrador", "ya_aviso"]

interface UsageRow {
  origin: string
  provider: string
  calls: number
  costMicros: number | null
  createdAt: Date
  conversationId: string | null
  encounterId: string | null
  contactId: string | null
}

/**
 * Costo y margen de una clínica en su tramo de hoy o en el anterior (tablero
 * O2). Con owner: lo llama la administración.
 */
export async function getClinicCostMargin(
  tx: Db,
  orgId: string,
  input: { which?: "actual" | "anterior"; now?: Date } = {},
): Promise<ClinicCostMargin> {
  const now = input.now ?? new Date()
  const current = await currentSaasPeriod(tx, orgId, now)
  const previous = input.which === "anterior" ? await previousSaasPeriod(tx, orgId, current) : null
  const period: SaasPeriod & { creditCents: number } = previous
    ? {
        start: previous.start,
        end: previous.end,
        credit: "mes",
        creditCents: previous.creditCents ?? current.creditCents,
      }
    : current
  const [sub] = await tx
    .select({
      name: organization.name,
      planId: saasSubscription.planId,
      guaranteedUntil: saasSubscription.guaranteedUntil,
      activatedAt: saasSubscription.activatedAt,
      sellerName: saasSeller.displayName,
      sellerRateBps: saasSeller.rateBps,
      sellerActive: saasSeller.isActive,
    })
    .from(organization)
    .leftJoin(saasSubscription, eq(saasSubscription.organizationId, organization.id))
    .leftJoin(saasSeller, eq(saasSeller.id, saasSubscription.sellerId))
    .where(eq(organization.id, orgId))
    .limit(1)
  const [plan] = sub?.planId
    ? await tx.select().from(saasPlan).where(eq(saasPlan.id, sub.planId)).limit(1)
    : []

  const actions = (await listPeriodActions(tx, orgId, period)).filter(
    (row) => row.state !== "anulada" && row.state !== "dentro_de_cita" && row.state !== "devuelta",
  )
  const subtotalMicros = actions.reduce((sum, row) => sum + netMicros(row), 0)
  // Lo cobrado: la cuota y lo que pasó del crédito, sin impuesto. La prueba es de regalo.
  const chargedCents =
    period.credit === "prueba"
      ? 0
      : (plan?.priceCents ?? 0) + Math.max(0, microsToCents(subtotalMicros) - period.creditCents)

  const usage = (await tx
    .select({
      origin: aiUsage.origin,
      provider: aiUsage.provider,
      calls: aiUsage.calls,
      costMicros: aiUsage.costMicros,
      createdAt: aiUsage.createdAt,
      conversationId: aiUsage.conversationId,
      encounterId: aiUsage.encounterId,
      contactId: conversation.contactId,
    })
    .from(aiUsage)
    .leftJoin(
      conversation,
      and(
        eq(conversation.id, aiUsage.conversationId),
        eq(conversation.organizationId, aiUsage.organizationId),
      ),
    )
    .where(
      and(
        eq(aiUsage.organizationId, orgId),
        gte(aiUsage.createdAt, period.start),
        lt(aiUsage.createdAt, period.end),
      ),
    )) as UsageRow[]

  const windowMs = (await saasTermsAt(tx, period.start)).conversationWindowHours * 3_600_000
  /** Lo que costó cada acción, y lo que no tiene acción por cubo. */
  const actionCost = new Map<string, { micros: number; calls: number }>()
  const bucket = new Map<string, { micros: number; calls: number }>()
  const add = (map: Map<string, { micros: number; calls: number }>, key: string, row: UsageRow) => {
    const item = map.get(key) ?? { micros: 0, calls: 0 }
    item.micros += row.costMicros ?? 0
    item.calls += row.calls
    map.set(key, item)
  }
  const byEncounter = new Map(
    actions
      .filter((row) => row.kind === "consulta" && row.encounterId)
      .map((row) => [row.encounterId as string, row]),
  )
  const conversations = actions.filter(
    (row) => row.kind === "conversacion" && row.tier !== "agenda",
  )
  const citas = actions.filter((row) => row.kind === "cita")
  for (const row of usage) {
    if (row.provider === "jev") add(bucket, "jev", row)
    else if ((AGENT_TEST_ORIGINS as readonly string[]).includes(row.origin))
      add(bucket, "pruebas", row)
    else if (row.origin === "dictado") {
      const action = row.encounterId ? byEncounter.get(row.encounterId) : undefined
      if (action) add(actionCost, action.id, row)
      else add(bucket, "clio_sin_cobro", row)
    } else if (row.origin === "recepcion") {
      const at = row.createdAt.getTime()
      const action =
        conversations.find(
          (item) =>
            item.contactId === row.contactId &&
            item.occurredAt.getTime() <= at &&
            at < item.occurredAt.getTime() + windowMs,
        ) ??
        citas.find((item) => item.contactId === row.contactId && item.occurredAt.getTime() >= at)
      if (action) add(actionCost, action.id, row)
      else add(bucket, "sofi_sin_cobro", row)
    } else if (row.origin === "reportes") add(bucket, "preguntas", row)
    else if ((ARGOS_ORIGINS as string[]).includes(row.origin)) add(bucket, "argos_mensajes", row)
    else if ((SUPPORT_ORIGINS as string[]).includes(row.origin)) add(bucket, "soporte", row)
    else add(bucket, "soporte", row)
  }

  const lineOf = (
    key: string,
    group: CostGroup,
    label: string,
    rows: SaasActionRow[],
    withDetail = false,
  ): CostLine => {
    const chargedCents = microsToCents(rows.reduce((sum, row) => sum + netMicros(row), 0))
    const costMicros = rows.reduce((sum, row) => sum + (actionCost.get(row.id)?.micros ?? 0), 0)
    return {
      key,
      group,
      label,
      count: rows.length,
      chargedCents,
      costMicros,
      marginPct: pct(chargedCents * 10_000, costMicros),
      note: null,
      detail: withDetail
        ? rows
            .map((row) => ({
              occurredAt: row.occurredAt,
              personName: row.personName,
              what: row.detail,
              calls: actionCost.get(row.id)?.calls ?? 0,
              chargedCents: microsToCents(netMicros(row)),
              costMicros: actionCost.get(row.id)?.micros ?? 0,
            }))
            .sort((a, b) => b.costMicros - a.costMicros)
            .slice(0, 20)
        : [],
    }
  }
  const free = (
    key: string,
    label: string,
    count: number | null,
    costMicros: number,
    note = "Lo regalamos",
  ): CostLine => ({
    key,
    group: "regalo",
    label,
    count,
    chargedCents: 0,
    costMicros,
    marginPct: null,
    note,
    detail: [],
  })
  const of = (kind: string, tier?: SaasActionTier) =>
    actions.filter((row) => row.kind === kind && (tier === undefined || row.tier === tier))

  const [questions] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(reportQuestion)
    .where(
      and(
        eq(reportQuestion.organizationId, orgId),
        eq(reportQuestion.usedModel, true),
        notInArray(reportQuestion.outcome, ["no_pudo", "ayuda", "otro"]),
        gte(reportQuestion.createdAt, period.start),
        lt(reportQuestion.createdAt, period.end),
      ),
    )
  const [stored] = await tx
    .select({ bytes: storageUsageDay.bytes })
    .from(storageUsageDay)
    .where(
      and(
        eq(storageUsageDay.organizationId, orgId),
        lt(storageUsageDay.day, period.end.toISOString().slice(0, 10)),
      ),
    )
    .orderBy(desc(storageUsageDay.day))
    .limit(1)
  const gb = (stored?.bytes ?? 0) / STORAGE_GB_BYTES
  const storageMicros = Math.round(gb * SAAS_STORAGE_COST_MICROS_PER_GB)
  const usageOf = (key: string) => bucket.get(key) ?? { micros: 0, calls: 0 }

  const lines: CostLine[] = [
    ...SOFI_TIERS.map((tier) =>
      lineOf(`sofi:${tier}`, "sofi", TIER_LABEL[tier], of("conversacion", tier)),
    ),
    ...CLIO_TIERS.map((tier) =>
      lineOf(`clio:${tier}`, "clio", TIER_LABEL[tier], of("consulta", tier), true),
    ),
    lineOf("argos:cita", "argos", "Citas recuperadas", of("cita")),
    lineOf("argos:paquetes", "argos", "Paquetes de preguntas", of("preguntas")),
    free(
      "argos:preguntas",
      "Argos · Preguntas",
      questions?.n ?? 0,
      usageOf("preguntas").micros,
      "Incluidas en el plan",
    ),
    free(
      "argos:mensajes",
      "Argos · Pedidos, recordatorios y mensajes para recuperar",
      usageOf("argos_mensajes").calls,
      usageOf("argos_mensajes").micros,
    ),
    free(
      "sofi:sin_cobro",
      "Sofi · Lo que pasó al equipo, lo ajeno y el spam",
      usageOf("sofi_sin_cobro").calls,
      usageOf("sofi_sin_cobro").micros,
    ),
    free(
      "clio:sin_cobro",
      "Clío · Borradores descartados",
      usageOf("clio_sin_cobro").calls,
      usageOf("clio_sin_cobro").micros,
    ),
    free("jev", "Jev · decide cada mensaje", usageOf("jev").calls, usageOf("jev").micros),
    free(
      "pruebas",
      "Pruebas (Probar, simulación, práctica)",
      usageOf("pruebas").calls,
      usageOf("pruebas").micros,
    ),
    free(
      "soporte",
      "Vectores, audio y comprobación del modelo",
      usageOf("soporte").calls,
      usageOf("soporte").micros,
    ),
    {
      key: "no_ia:almacenamiento",
      group: "no_ia",
      label: `Almacenamiento · ${gb.toLocaleString("es", { maximumFractionDigits: 1 })} GB`,
      count: null,
      chargedCents: microsToCents(
        of("almacenamiento").reduce((sum, row) => sum + netMicros(row), 0),
      ),
      costMicros: storageMicros,
      marginPct: null,
      note: null,
      detail: [],
    },
    {
      key: "no_ia:servidor",
      group: "no_ia",
      label: "Parte del servidor y gastos fijos",
      count: null,
      chargedCents: 0,
      costMicros: SAAS_FIXED_COST_MICROS,
      marginPct: null,
      note: "Estimado",
      detail: [],
    },
  ]
  const aiMicros = usage.reduce((sum, row) => sum + (row.costMicros ?? 0), 0)
  const costMicros = aiMicros + storageMicros + SAAS_FIXED_COST_MICROS
  const chargedMicros = chargedCents * 10_000
  // La comisión del vendedor se calcula sobre lo que paga la clínica, sin impuesto.
  const commissionCents =
    sub?.sellerActive && sub.sellerRateBps
      ? Math.round((chargedCents * sub.sellerRateBps) / 10_000)
      : 0
  const aiShareBps = chargedMicros > 0 ? Math.round((aiMicros / chargedMicros) * 10_000) : null
  const founder = plan?.seatLimit !== null && plan?.seatLimit !== undefined
  return {
    organizationId: orgId,
    organizationName: sub?.name ?? orgId,
    period: { start: period.start, end: period.end, credit: period.credit },
    currency: plan?.currency ?? "USD",
    planName: plan?.name ?? null,
    founder: founder || sub?.guaranteedUntil != null,
    chargedCents,
    aiMicros,
    storageMicros,
    fixedMicros: SAAS_FIXED_COST_MICROS,
    costMicros,
    marginPct: pct(chargedMicros, costMicros),
    commissionCents,
    marginAfterCommissionPct: pct(chargedMicros, costMicros + commissionCents * 10_000),
    aiShareBps,
    alarm:
      aiMicros > SAAS_AI_ALARM_MICROS ||
      (aiShareBps !== null && aiShareBps > SAAS_AI_ALARM_SHARE_BPS),
    idle:
      (founder || sub?.guaranteedUntil != null) &&
      (await idleSince(tx, orgId, sub?.activatedAt ?? null, now)),
    sellerName: sub?.sellerName ?? null,
    unpricedCalls: usage
      .filter((row) => row.costMicros === null)
      .reduce((sum, row) => sum + row.calls, 0),
    lines,
  }
}

/** Activa hace más de `SAAS_FOUNDER_IDLE_DAYS` días y sin ningún gasto de IA en ese tiempo. */
async function idleSince(
  tx: Db,
  orgId: string,
  activatedAt: Date | null,
  now: Date,
): Promise<boolean> {
  const since = new Date(now.getTime() - SAAS_FOUNDER_IDLE_DAYS * 86_400_000)
  if (!activatedAt || activatedAt > since) return false
  const [used] = await tx
    .select({ id: aiUsage.id })
    .from(aiUsage)
    .where(and(eq(aiUsage.organizationId, orgId), gte(aiUsage.createdAt, since)))
    .limit(1)
  return !used
}

export interface CostMarginOverview {
  clinics: ClinicCostMargin[]
  founders: number
  chargedCents: number
  costMicros: number
  aiMicros: number
  storageMicros: number
  fixedMicros: number
  marginPct: number | null
  marginAfterCommissionPct: number | null
}

/** Todas las clínicas activas en lo que va del mes de cada una (tablero O3), con «Para revisar» arriba. */
export async function getCostMarginOverview(tx: Db, now = new Date()): Promise<CostMarginOverview> {
  const subs = await tx
    .select({ orgId: saasSubscription.organizationId })
    .from(saasSubscription)
    .where(
      and(
        inArray(saasSubscription.status, ["activa", "gracia"]),
        eq(saasSubscription.isDemo, false),
      ),
    )
  const clinics: ClinicCostMargin[] = []
  for (const sub of subs) clinics.push(await getClinicCostMargin(tx, sub.orgId, { now }))
  const charged = clinics.reduce((sum, item) => sum + item.chargedCents, 0)
  const cost = clinics.reduce((sum, item) => sum + item.costMicros, 0)
  const commission = clinics.reduce((sum, item) => sum + item.commissionCents, 0)
  return {
    clinics: clinics.sort(
      (a, b) =>
        Number(b.alarm || b.idle) - Number(a.alarm || a.idle) ||
        (a.marginPct ?? -1) - (b.marginPct ?? -1),
    ),
    founders: clinics.filter((item) => item.founder).length,
    chargedCents: charged,
    costMicros: cost,
    aiMicros: clinics.reduce((sum, item) => sum + item.aiMicros, 0),
    storageMicros: clinics.reduce((sum, item) => sum + item.storageMicros, 0),
    fixedMicros: clinics.reduce((sum, item) => sum + item.fixedMicros, 0),
    marginPct: pct(charged * 10_000, cost),
    marginAfterCommissionPct: pct(charged * 10_000, cost + commission * 10_000),
  }
}
