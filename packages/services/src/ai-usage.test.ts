import { type Db, withOrgContext } from "@odentia/db"
import { agentRunLedger, aiUsage } from "@odentia/db/schema/agent"
import { eq, sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { recordAgentRun } from "./agent-operations.js"
import {
  AGENT_TEST_BUDGET_MICROS,
  type AiUsageEntry,
  assertAgentTestBudget,
  getAiCostByOrigin,
  recordAiUsage,
} from "./ai-usage.js"
import { getClinicCostMargin } from "./saas-cost.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/** Uso de IA por origen (ADR 0031, fase 1): lo que se guarda, quién lo ve y el tope de pruebas. */
setupTestDb()
const ORG = "org_a"
const OTHER = "org_b"

function run<T>(fn: (tx: Db) => Promise<T>, org = ORG): Promise<T> {
  return withOrgContext(appDb, org, fn)
}

const entry = (over: Partial<AiUsageEntry> = {}): AiUsageEntry => ({
  provider: "openai",
  model: "gpt-6-luna",
  calls: 1,
  inputTokens: 1_000,
  cachedInputTokens: null,
  cacheWriteTokens: null,
  outputTokens: 100,
  audioSeconds: null,
  costMicros: 150,
  ...over,
})

const month = () => ({ start: new Date(Date.now() - 24 * 60 * 60 * 1000), end: new Date(Date.now() + 60 * 1000) })

describe("uso de IA por origen", () => {
  it("suma por origen, separa lo que no tiene precio y no se ve desde otra clínica", async () => {
    await run((tx) => recordAiUsage(tx, ORG, { origin: "dictado", entries: [entry(), entry({ calls: 2, costMicros: 300 })] }))
    await run((tx) =>
      recordAiUsage(tx, ORG, { origin: "dictado", entries: [entry({ provider: "jev", model: "jev-1.13.0", costMicros: null })] }),
    )
    await run((tx) => recordAiUsage(tx, ORG, { origin: "vectores", entries: [entry({ model: "text-embedding-3-small", costMicros: 20 })] }))
    const byOrigin = await run((tx) => getAiCostByOrigin(tx, ORG, month()))
    expect(byOrigin).toEqual([
      { origin: "dictado", calls: 4, costMicros: 450, unpricedCalls: 1 },
      { origin: "vectores", calls: 1, costMicros: 20, unpricedCalls: 0 },
    ])
    expect(await run((tx) => getAiCostByOrigin(tx, OTHER, month()), OTHER)).toEqual([])
    // Ni siquiera filtrando por la otra clínica: RLS no deja leer sus filas.
    expect(await run((tx) => getAiCostByOrigin(tx, ORG, month()), OTHER)).toEqual([])
  })

  it("es un libro: la aplicación registra y lee, nunca corrige ni borra", async () => {
    await expect(run((tx) => tx.update(aiUsage).set({ costMicros: 0 }).where(eq(aiUsage.organizationId, ORG)))).rejects.toThrow()
    await expect(run((tx) => tx.delete(aiUsage).where(eq(aiUsage.organizationId, ORG)))).rejects.toThrow()
  })

  it("una corrida guarda su costo en el libro y cada proveedor en el uso, con origen recepción", async () => {
    await run((tx) =>
      recordAgentRun(tx, ORG, {
        model: "gpt-6-luna",
        status: "ok",
        startedAt: new Date(),
        llmCalls: 2,
        cacheWriteTokens: 400,
        usage: [
          entry({ provider: "openai", model: "gpt-6-luna", calls: 2, costMicros: 155 }),
          entry({ provider: "jev", model: "jev-1.13.0", costMicros: null }),
        ],
      }),
    )
    const [ledgerRow] = await run((tx) =>
      tx.select().from(agentRunLedger).where(eq(agentRunLedger.organizationId, ORG)).orderBy(sql`started_at desc`).limit(1),
    )
    // El costo de la fila es lo que tiene precio; Jev queda sin costo, no en cero.
    expect(ledgerRow).toMatchObject({ costMicros: 155, cacheWriteTokens: 400 })
    const recepcion = (await run((tx) => getAiCostByOrigin(tx, ORG, month()))).find((item) => item.origin === "recepcion")
    expect(recepcion).toEqual({ origin: "recepcion", calls: 3, costMicros: 155, unpricedCalls: 1 })
  })

  it("rechaza un origen que no existe", async () => {
    // @ts-expect-error origen inválido a propósito
    await expect(run((tx) => recordAiUsage(tx, ORG, { origin: "otro", entries: [entry()] }))).rejects.toMatchObject({ code: "VALIDATION" })
  })
})

describe("tope de pruebas", () => {
  it("cuenta solo lo que se gasta probando en los últimos 30 días", async () => {
    await run((tx) => assertAgentTestBudget(tx, OTHER), OTHER)
    // Atender pacientes no consume el tope de pruebas.
    await run((tx) => recordAiUsage(tx, OTHER, { origin: "recepcion", entries: [entry({ costMicros: AGENT_TEST_BUDGET_MICROS })] }), OTHER)
    // Lo de hace más de 30 días ya no cuenta.
    await ownerDb.insert(aiUsage).values({
      organizationId: OTHER,
      origin: "probar",
      provider: "openai",
      model: "gpt-6-luna",
      costMicros: AGENT_TEST_BUDGET_MICROS,
      createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    })
    await run((tx) => assertAgentTestBudget(tx, OTHER), OTHER)
    await run((tx) => recordAiUsage(tx, OTHER, { origin: "probar", entries: [entry({ costMicros: AGENT_TEST_BUDGET_MICROS - 1 })] }), OTHER)
    await run((tx) => assertAgentTestBudget(tx, OTHER), OTHER)
    await run((tx) => recordAiUsage(tx, OTHER, { origin: "vista_previa", entries: [entry({ costMicros: 1 })] }), OTHER)
    await expect(run((tx) => assertAgentTestBudget(tx, OTHER), OTHER)).rejects.toMatchObject({ code: "AGENT_TEST_LIMIT", status: 429 })
  })
})

describe("costo y margen en la administración (ADR 0085)", () => {
  it("suma la IA del tramo, pone lo que no tiene acción en su fila y cuenta lo que no tiene precio", async () => {
    const cost = await getClinicCostMargin(ownerDb, ORG)
    const line = (key: string) => cost.lines.find((item) => item.key === key)
    expect(cost.aiMicros).toBe(450 + 20 + 155)
    // Sin consulta cobrada, el dictado es un borrador descartado; sin conversación cobrada, lo de Sofi no se cobró.
    expect(line("clio:sin_cobro")).toMatchObject({ costMicros: 450, count: 3 })
    expect(line("sofi:sin_cobro")).toMatchObject({ costMicros: 155, count: 2 })
    expect(line("soporte")).toMatchObject({ costMicros: 20, count: 1 })
    expect(line("jev")).toMatchObject({ costMicros: 0, count: 2 })
    expect(cost.unpricedCalls).toBe(2)
  })
})
