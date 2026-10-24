import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { aiUsage } from "@odentia/db/schema/agent"
import { reportQuestion } from "@odentia/db/schema/reports"
import { saasAction, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { getSaasConsumption } from "./saas-actions.js"
import { addArgosPack, ensureArgosQuestion } from "./saas-included.js"
import { assertClioCanListen, getAgentSpendGate, getSaasAlerts } from "./saas-terms.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/** El presupuesto del mes (ADR 0085): el único límite; lo que ya empezó se termina y se cobra. */
setupTestDb()
const ORG = "org_a"
const HOUR = 3_600_000
const DAY = 24 * HOUR
const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, ORG, fn)

const action = (
  values: Partial<typeof saasAction.$inferInsert> & { occurredAt: Date; priceMicros: number },
) => ({
  organizationId: ORG,
  kind: "conversacion",
  tier: "gestiona",
  contactId: randomUUID(),
  detail: "Atendió una conversación y gestionó una cita por WhatsApp",
  currency: "USD",
  basePriceMicros: values.priceMicros,
  dedupeKey: randomUUID(),
  ...values,
})

beforeAll(async () => {
  await ownerDb.insert(saasPlan).values({
    code: "odentia-prueba-presupuesto",
    name: "Plan odentIA",
    currency: "USD",
    priceCents: 2900,
    creditCents: 2900,
    conversationInformMicros: 100_000,
    conversationMicros: 500_000,
    conversationAgendaMicros: 1_000_000,
    consultationMicros: 500_000,
    recoveryMicros: 2_000_000,
    argosIncludedQuestions: 1,
    argosPackQuestions: 100,
    argosPackMicros: 3_000_000,
    storageIncludedGb: 20,
    storageGbMicros: 200_000,
    trialCreditCents: 5000,
    trialMaxCreditCents: 13000,
    isDefault: true,
  })
  // Presupuesto de USD 2 por encima del crédito de USD 29.
  const period = {
    status: "activa",
    isDemo: false,
    spendCapCents: 200,
    currentPeriodStart: new Date(Date.now() - 10 * DAY),
    currentPeriodEnd: new Date(Date.now() + 20 * DAY),
  }
  await ownerDb
    .insert(saasSubscription)
    .values({ organizationId: ORG, ...period })
    .onConflictDoUpdate({ target: saasSubscription.organizationId, set: period })
})

describe("lo que ve la clínica", () => {
  it("cuenta lo que pasa del crédito sin el almacenamiento y dice lo cobrado tras llegar al presupuesto", async () => {
    const start = Date.now() - 9 * DAY
    // 62 conversaciones Gestiona: USD 31, USD 2 por encima del crédito, justo el presupuesto.
    await ownerDb
      .insert(saasAction)
      .values(
        Array.from({ length: 62 }, (_, index) =>
          action({ occurredAt: new Date(start + index * HOUR), priceMicros: 500_000 }),
        ),
      )
    expect((await run((tx) => getAgentSpendGate(tx, ORG))).capReached).toBe(true)
    // Después llegaron dos resultados de un trabajo ya hecho: la persona vino a la cita que reservó Sofi y una cita recuperada.
    await ownerDb.insert(saasAction).values([
      action({
        tier: "agenda",
        occurredAt: new Date(start + 70 * HOUR),
        priceMicros: 500_000,
        detail: "Vino a la cita que reservó Sofi: sube de Gestiona a Agenda",
      }),
      action({
        kind: "cita",
        tier: null,
        occurredAt: new Date(start + 71 * HOUR),
        priceMicros: 2_000_000,
        detail: "Volvió tras un mensaje de Argos y reservó desde el enlace",
      }),
      // El almacenamiento extra no cuenta para el presupuesto: guardar nunca detiene a un agente.
      action({
        kind: "almacenamiento",
        tier: null,
        units: 3,
        occurredAt: new Date(start + 72 * HOUR),
        priceMicros: 600_000,
        detail: "Guardó 23 GB en promedio",
      }),
    ])
    const { budget } = await run((tx) => getSaasConsumption(tx, ORG))
    expect(budget).toMatchObject({
      capCents: 200,
      spentCents: 450,
      reachedAt: new Date(start + 61 * HOUR),
      after: { count: 2, amountCents: 250 },
      storageCents: 60,
    })
    expect(budget.after.lines).toEqual([
      { kind: "conversacion", tier: "agenda", count: 1, amountCents: 50 },
      { kind: "cita", tier: null, count: 1, amountCents: 200 },
    ])
    const [alert] = (await run((tx) => getSaasAlerts(tx, ORG))).filter(
      (item) => item.family === "tope",
    )
    expect(alert).toMatchObject({ level: "limite", short: "Llegaste al presupuesto del mes" })
    expect(alert?.message).toContain(
      "Sofi pasa todo a tu equipo, Clío no escucha en las atenciones nuevas y Argos no escribe para recuperar",
    )
  })
})

describe("Clío", () => {
  it("no empieza a escuchar en una atención nueva; la que ya dictaba sigue hasta firmarse", async () => {
    const fresh = await clinicalFixture()
    await expect(
      run((tx) => assertClioCanListen(tx, ORG, fresh.encounter.id)),
    ).rejects.toMatchObject({
      code: "CLIO_BUDGET_REACHED",
      message:
        "Llegaste al presupuesto del mes: Clío no escucha en esta atención. Puedes escribir como siempre.",
    })
    const started = await clinicalFixture()
    await ownerDb
      .insert(aiUsage)
      .values({
        organizationId: ORG,
        origin: "dictado",
        provider: "openai",
        model: "gpt-6-luna",
        calls: 1,
        encounterId: started.encounter.id,
      })
    await expect(
      run((tx) => assertClioCanListen(tx, ORG, started.encounter.id)),
    ).resolves.toBeUndefined()
  })
})

describe("Argos", () => {
  it("responde lo incluido y no suma paquetes, ni con permiso ni solo", async () => {
    await expect(run((tx) => ensureArgosQuestion(tx, ORG))).resolves.toEqual({ added: null })
    const [anyUser] = (await ownerDb.execute(
      sql`select id from "user" limit 1`,
    )) as unknown as Array<{ id: string }>
    await ownerDb
      .insert(reportQuestion)
      .values({ organizationId: ORG, userId: anyUser!.id, outcome: "respondida", usedModel: true })
    await ownerDb
      .update(saasSubscription)
      .set({ argosAutoPack: true })
      .where(eq(saasSubscription.organizationId, ORG))
    const reached = {
      code: "ARGOS_BUDGET_REACHED",
      message: expect.stringMatching(
        /^Llegaste al presupuesto de \p{L}+, así que no puedo sumar más preguntas\. Súbelo en Plan y pagos y sigo respondiendo\.$/u,
      ),
    }
    await expect(run((tx) => ensureArgosQuestion(tx, ORG))).rejects.toMatchObject(reached)
    await expect(run((tx) => addArgosPack(tx, ORG, { automatic: false }))).rejects.toMatchObject(
      reached,
    )
    // Al subir el presupuesto, «Sumar solas» suma el paquete y lo dice.
    await ownerDb
      .update(saasSubscription)
      .set({ spendCapCents: 100_000 })
      .where(eq(saasSubscription.organizationId, ORG))
    expect(await run((tx) => ensureArgosQuestion(tx, ORG))).toEqual({
      added: "Sumé 100 preguntas por USD 3, como pediste en Plan y pagos. Te quedan 100.",
    })
  })
})
