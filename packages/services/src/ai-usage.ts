import type { Db } from "@odentia/db"
import { AI_USAGE_ORIGINS, type AiUsageOrigin, aiUsage } from "@odentia/db/schema/agent"
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm"
import { ServiceError, validation } from "./errors.js"

/* ---------- Uso de IA por origen (ADR 0030, fase 1: medir) ---------- */

/**
 * Lo que una operación gastó en un proveedor y un modelo. El costo lo calcula
 * el agente con su tabla de precios (`AI_PRICES`); aquí solo se guarda.
 */
export interface AiUsageEntry {
  provider: string
  model: string
  calls: number
  /** null: el proveedor no lo reportó. */
  inputTokens: number | null
  cachedInputTokens: number | null
  cacheWriteTokens: number | null
  outputTokens: number | null
  audioSeconds: number | null
  /** Millonésimas de USD; null si no hay precio para el modelo o el proveedor no reportó el uso. */
  costMicros: number | null
}

const cleanInt = (v: number | null | undefined) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null

/** Suma lo que tiene costo conocido; null si ninguna fila lo tiene (no afirmar 0). */
export function knownCostMicros(entries: readonly AiUsageEntry[]): number | null {
  const known = entries.filter((entry) => entry.costMicros !== null)
  return known.length ? known.reduce((total, entry) => total + (entry.costMicros ?? 0), 0) : null
}

/** Guarda el uso de una operación; sin filas no escribe nada. */
export async function recordAiUsage(
  tx: Db,
  orgId: string,
  input: { origin: AiUsageOrigin; conversationId?: string | null; entries: readonly AiUsageEntry[] },
): Promise<void> {
  if (!(AI_USAGE_ORIGINS as readonly string[]).includes(input.origin)) throw validation("origen de uso inválido")
  const rows = input.entries.filter((entry) => entry.calls > 0)
  if (!rows.length) return
  await tx.insert(aiUsage).values(
    rows.map((entry) => ({
      organizationId: orgId,
      origin: input.origin,
      provider: entry.provider.slice(0, 60),
      model: entry.model.slice(0, 120),
      calls: Math.max(1, Math.round(entry.calls)),
      inputTokens: cleanInt(entry.inputTokens),
      cachedInputTokens: cleanInt(entry.cachedInputTokens),
      cacheWriteTokens: cleanInt(entry.cacheWriteTokens),
      outputTokens: cleanInt(entry.outputTokens),
      audioSeconds: cleanInt(entry.audioSeconds),
      costMicros: cleanInt(entry.costMicros),
      conversationId: input.conversationId ?? null,
    })),
  )
}

export interface AiCostByOrigin {
  origin: AiUsageOrigin
  calls: number
  /** Millonésimas de USD de lo que tiene precio; null si nada lo tiene. */
  costMicros: number | null
  /** Llamadas sin costo conocido (modelo sin precio o uso no reportado). */
  unpricedCalls: number
}

/** Costo real de IA de una clínica en un tramo, por origen y de mayor a menor. */
export async function getAiCostByOrigin(
  tx: Db,
  orgId: string,
  range: { start: Date; end: Date },
): Promise<AiCostByOrigin[]> {
  const rows = await tx
    .select({
      origin: aiUsage.origin,
      calls: sql<number>`coalesce(sum(${aiUsage.calls}), 0)`,
      cost: sql<number | null>`sum(${aiUsage.costMicros})`,
      unpriced: sql<number>`coalesce(sum(${aiUsage.calls}) filter (where ${aiUsage.costMicros} is null), 0)`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.organizationId, orgId), gte(aiUsage.createdAt, range.start), lt(aiUsage.createdAt, range.end)))
    .groupBy(aiUsage.origin)
  return rows
    .map((row) => ({
      origin: row.origin as AiUsageOrigin,
      calls: Number(row.calls),
      costMicros: row.cost === null || row.cost === undefined ? null : Number(row.cost),
      unpricedCalls: Number(row.unpriced),
    }))
    .sort((a, b) => (b.costMicros ?? 0) - (a.costMicros ?? 0) || b.calls - a.calls)
}

/** Lo que se gasta probando al agente desde la plataforma, no atendiendo a nadie. */
export const AGENT_TEST_ORIGINS = ["probar", "simulacion", "vista_previa", "practica_dictado"] as const satisfies readonly AiUsageOrigin[]

/**
 * Tope de gasto en pruebas por clínica en 30 días, en millonésimas de USD.
 * Una prueba cuesta menos de un centavo: USD 3 son cientos de pruebas y
 * acotan lo que una clínica puede gastar sin atender a nadie. Pasa a la
 * administración con los demás precios (fase 3 de la ADR 0030).
 */
export const AGENT_TEST_BUDGET_MICROS = 3_000_000

/**
 * Antes de probar: lanza `AGENT_TEST_LIMIT` si las pruebas de los últimos 30
 * días ya llegaron al tope. Solo cuenta lo que tiene costo conocido.
 */
export async function assertAgentTestBudget(tx: Db, orgId: string, now = new Date()): Promise<void> {
  const [row] = await tx
    .select({ cost: sql<number | null>`sum(${aiUsage.costMicros})` })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.organizationId, orgId),
        inArray(aiUsage.origin, [...AGENT_TEST_ORIGINS]),
        gte(aiUsage.createdAt, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)),
      ),
    )
  if (Number(row?.cost ?? 0) >= AGENT_TEST_BUDGET_MICROS) {
    throw new ServiceError(
      "AGENT_TEST_LIMIT",
      429,
      "Llegaste al tope de pruebas del agente de los últimos 30 días. Las conversaciones con pacientes siguen atendiéndose; para probar más, escríbele a soporte.",
    )
  }
}
