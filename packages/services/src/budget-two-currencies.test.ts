/**
 * Un presupuesto en dos monedas sigue siendo uno solo: cada línea queda en la moneda
 * con que se indicó, hay un total por moneda y entre monedas nunca se suma ni se
 * convierte. Lo único que se estima al cambio de hoy es el valor de la oportunidad. Una
 * clínica de una sola moneda ve lo de siempre.
 */
import { formatMoney, sumAcceptedByCurrency, sumAcceptedCents } from "@odentia/clinical"
import { encounter, serviceCatalog, treatmentPlan } from "@odentia/db/schema/clinical"
import { patient } from "@odentia/db/schema/clinical"
import { eq, sql } from "drizzle-orm"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  budgetAnswerSummary,
  getAgentPatientBudgets,
  planBudgetAnswer,
} from "./agent-operations.js"
import { runArgosQuery } from "./argos-query.js"
import { buildBudgetSnapshot, renderBudgetPdf } from "./budget-pdf.js"
import {
  addBudgetItems,
  adjustBudgetLines,
  assembleEncounterBudget,
  createBudget,
  decideBudget,
  deliverBudget,
  getBudgetDetail,
  listBudgets,
  removeBudgetItems,
  reviseBudget,
} from "./budgets.js"
import { makeSigner, readyToClose } from "./clinical-test-fixture.js"
import { DocumentKit } from "./document-kit.js"
import { addEncounterProcedure, finalizeEncounter } from "./encounters.js"
import { twoCurrencyClinic } from "./exam-two-currencies.js"
import { createOpportunity, getOpportunity, updateOpportunity } from "./opportunities.js"
import { budgetLine } from "./plan-next.js"
import { addPlanItem, updatePlanItem } from "./plan.js"
import {
  createPromotion,
  listClinicPromotionSummaries,
  requirePromotionPrice,
} from "./promotions.js"
import { getReportPromotions } from "./report-finance.js"
import { createService } from "./service-catalog.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
import { getWorkspaceHome, type WorkspaceAccess } from "./workspace.js"

setupTestDb()

const DAY = 24 * 60 * 60 * 1000
const LOCALE = "es-PE"
const soles = (cents: number) => formatMoney(cents, "PEN", LOCALE)
const dollars = (cents: number) => formatMoney(cents, "USD", LOCALE)

/** Una clínica con una persona, su atención, su plan y un servicio por moneda. */
async function clinic(rate: string | null = "3.75") {
  const c = await twoCurrencyClinic(ownerDb, appDb, { rate })
  const patientId = await c.person("Lucía Ramos")
  const [row] = await ownerDb
    .select({ personId: patient.personId })
    .from(patient)
    .where(eq(patient.id, patientId))
  const [session] = await ownerDb
    .insert(encounter)
    .values({
      organizationId: c.orgId,
      patientId,
      professionalUserId: c.actor,
      branchId: c.branchId,
      reason: "Consulta",
    })
    .returning()
  const [plan] = await ownerDb
    .insert(treatmentPlan)
    .values({
      organizationId: c.orgId,
      patientId,
      title: "Plan clínico",
      originEncounterId: session!.id,
    })
    .returning()
  const service = async (name: string, priceCents: number, currency: string) => {
    const [created] = await ownerDb
      .insert(serviceCatalog)
      .values({
        organizationId: c.orgId,
        name,
        scope: "general",
        source: "custom",
        priceCents,
        currency,
      })
      .returning()
    return created!
  }
  const resin = await service("Resina", 30_000, "PEN")
  const implant = await service("Implante", 100_000, "USD")
  const args = [c.orgId, c.actor, patientId] as const
  const indicate = (serviceId: string) =>
    c.run((tx) =>
      addPlanItem(tx, ...args, { serviceId, planId: plan!.id, sourceEncounterId: session!.id }),
    )
  return {
    ...c,
    patientId,
    contactId: row!.personId,
    encounterId: session!.id,
    planId: plan!.id,
    resin,
    implant,
    args,
    indicate,
    /** Sus dos líneas, una en soles y otra en dólares, en un solo borrador. */
    twoLines: async () => {
      const pen = await indicate(resin.id)
      const usd = await indicate(implant.id)
      const budget = await c.run((tx) =>
        createBudget(tx, ...args, { planId: plan!.id, itemIds: [pen.id, usd.id] }),
      )
      return { pen, usd, budget }
    },
  }
}

/** Quien envía presupuestos, sin nada más que le salga en Inicio. */
const SENDS_BUDGETS: WorkspaceAccess = {
  patients: false,
  appointments: false,
  conversations: false,
  tasks: false,
  finance: false,
  clinical: false,
  crm: false,
  agent: false,
  allTasks: false,
  configure: false,
  ownAppointments: false,
  sendsBudgets: true,
}

/** La fila «Su presupuesto sigue sin enviar» de «Te espera». */
function unsentRow(home: { waiting: readonly unknown[] }) {
  return (home.waiting as Array<Record<string, unknown>>).find(
    (item) => item.kind === "unsentBudget",
  )
}

describe("un presupuesto, un total por moneda", () => {
  it("lleva líneas en soles y en dólares y no las suma", async () => {
    const f = await clinic()
    const { budget } = await f.twoLines()

    expect(budget.items.map((line) => line.currency).sort()).toEqual(["PEN", "USD"])
    expect(
      budget.totals.map(({ currency, count, totalCents }) => ({ currency, count, totalCents })),
    ).toEqual([
      { currency: "PEN", count: 1, totalCents: 30_000 },
      { currency: "USD", count: 1, totalCents: 100_000 },
    ])
    expect(budget.options[0]?.totals).toEqual(budget.totals)
    // No hay una cifra que lo diga todo: 130,000 no es nada.
    expect(budget.totalCents).toBeNull()
    expect(budget.options[0]?.totalCents).toBeNull()
    expect(budgetLine(budget, LOCALE)).toBe(
      `2 tratamientos · ${soles(30_000)} + ${dollars(100_000)}`,
    )
  })

  it("todo presupuesto nuevo guarda la cabecera sin moneda", async () => {
    const f = await clinic()
    const { budget } = await f.twoLines()
    const revised = await f.run(async (tx) => {
      await deliverBudget(tx, ...f.args, budget.id)
      return reviseBudget(tx, ...f.args, budget.id, {
        itemIds: budget.items.map((line) => line.planItemId),
        reason: "Cambió el plan",
      })
    })
    const rows = await ownerDb.execute<{ currency: string | null }>(
      sql`select currency from treatment_budget where organization_id = ${f.orgId}`,
    )
    expect(rows.map((row) => row.currency)).toEqual([null, null])
    expect(revised.totals.map((total) => total.currency)).toEqual(["PEN", "USD"])
  })

  it("a un borrador en soles entra lo que va en dólares, y cambiar de servicio lleva su moneda", async () => {
    const f = await clinic()
    const pen = await f.indicate(f.resin.id)
    const usd = await f.indicate(f.implant.id)
    const draft = await f.run((tx) =>
      createBudget(tx, ...f.args, { planId: f.planId, itemIds: [pen.id] }),
    )
    expect(draft.totals.map((total) => total.currency)).toEqual(["PEN"])
    const grown = await f.run((tx) =>
      addBudgetItems(tx, ...f.args, draft.id, { itemIds: [usd.id] }),
    )
    expect(grown.totals.map((total) => total.currency)).toEqual(["PEN", "USD"])

    await f.run((tx) =>
      updatePlanItem(tx, ...f.args, pen.id, {
        serviceId: f.implant.id,
        encounterId: f.encounterId,
      }),
    )
    const moved = await f.run((tx) => getBudgetDetail(tx, f.orgId, f.patientId, draft.id))
    expect(moved.totals.map(({ currency, totalCents }) => ({ currency, totalCents }))).toEqual([
      { currency: "USD", totalCents: 200_000 },
    ])
    expect(moved.totalCents).toBe(200_000)
  })

  it("sin líneas vale cero en la moneda de la clínica", async () => {
    const f = await clinic()
    const pen = await f.indicate(f.resin.id)
    const draft = await f.run((tx) =>
      createBudget(tx, ...f.args, { planId: f.planId, itemIds: [pen.id] }),
    )
    const empty = await f.run((tx) =>
      removeBudgetItems(tx, ...f.args, draft.id, { itemIds: [pen.id] }),
    )
    expect(empty.currency).toBe("PEN")
    expect(empty.totals).toEqual([
      {
        currency: "PEN",
        count: 0,
        totalCents: 0,
        acceptedCents: 0,
        tariffTotalCents: 0,
        discountCents: 0,
      },
    ])
  })

  it("lo viejo conserva su moneda en la cabecera, pero las cifras salen de las líneas", async () => {
    const f = await clinic()
    const pen = await f.indicate(f.resin.id)
    const draft = await f.run((tx) =>
      createBudget(tx, ...f.args, { planId: f.planId, itemIds: [pen.id] }),
    )
    await ownerDb.execute(sql`update treatment_budget set currency = 'PEN' where id = ${draft.id}`)
    const old = await f.run((tx) => getBudgetDetail(tx, f.orgId, f.patientId, draft.id))
    expect(old).toMatchObject({ currency: "PEN", totalCents: 30_000 })
    expect(old.totals.map((total) => total.totalCents)).toEqual([30_000])

    // Y la cabecera no se lee: aunque diga otra cosa, manda la línea.
    await ownerDb.execute(sql`update treatment_budget set currency = 'USD' where id = ${draft.id}`)
    const read = await f.run((tx) => getBudgetDetail(tx, f.orgId, f.patientId, draft.id))
    expect(read).toMatchObject({ currency: "PEN", totalCents: 30_000 })
  })
})

describe("aceptar una parte", () => {
  it("lo aceptado va por moneda, y la moneda que no aceptó queda en cero", async () => {
    const f = await clinic()
    const { pen, usd, budget } = await f.twoLines()
    const decided = await f.run(async (tx) => {
      await deliverBudget(tx, ...f.args, budget.id)
      return decideBudget(tx, ...f.args, budget.id, {
        decisions: [
          { planItemId: pen.id, decision: "pospuesto" },
          { planItemId: usd.id, decision: "aceptado" },
        ],
      })
    })
    expect(decided.status).toBe("parcial")
    expect(
      decided.totals.map(({ currency, acceptedCents }) => ({ currency, acceptedCents })),
    ).toEqual([
      { currency: "PEN", acceptedCents: 0 },
      { currency: "USD", acceptedCents: 100_000 },
    ])
    expect(decided.acceptedCents).toBeNull()
  })

  it("la misma regla para el servidor y la pantalla: una suma por moneda, nunca entre ellas", () => {
    const lines = [
      { lineTotalCents: 100, decision: "aceptado", currency: "PEN" },
      { lineTotalCents: 200, decision: "aceptado", currency: "USD" },
      { lineTotalCents: 300, decision: "aceptado", currency: "USD" },
      { lineTotalCents: 900, decision: "pospuesto", currency: "USD" },
    ]
    expect(sumAcceptedByCurrency(lines)).toEqual([
      { currency: "PEN", totalCents: 100 },
      { currency: "USD", totalCents: 500 },
    ])
    expect(sumAcceptedCents(lines)).toBeNull()
    // Con una moneda, la firma y el resultado de siempre.
    expect(sumAcceptedCents([{ lineTotalCents: 100, decision: "aceptado" }])).toBe(100)
    expect(sumAcceptedCents([{ lineTotalCents: null, decision: "aceptado" }])).toBeNull()
    expect(sumAcceptedCents([{ lineTotalCents: 100, decision: "pospuesto" }])).toBe(0)
  })

  it("el agente repite lo que acepta con su moneda", async () => {
    const f = await clinic()
    const { pen, usd, budget } = await f.twoLines()
    await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
    const planned = await f.run((tx) =>
      planBudgetAnswer(tx, f.orgId, f.contactId, {
        patientId: f.patientId,
        budgetId: budget.id,
        decisions: [
          { planItemId: pen.id, decision: "aceptado" },
          { planItemId: usd.id, decision: "aceptado" },
        ],
      }),
    )
    expect(planned.answer.acceptedCents).toBeNull()
    expect(budgetAnswerSummary(planned.answer, { locale: LOCALE })).toContain(
      `(${soles(30_000)} + ${dollars(100_000)})`,
    )
  })
})

describe("la hoja", () => {
  afterEach(() => vi.restoreAllMocks())

  async function printedText(snap: Parameters<typeof renderBudgetPdf>[0]): Promise<string> {
    const lay = vi.spyOn(DocumentKit.prototype, "lay")
    await renderBudgetPdf(snap)
    return JSON.stringify(lay.mock.calls.map((call) => call[0]))
  }

  it("cada línea va con su símbolo y el total dice las dos monedas", async () => {
    const f = await clinic()
    const { budget } = await f.twoLines()
    const snap = await f.run((tx) => buildBudgetSnapshot(tx, f.orgId, f.patientId, budget.id))
    expect(snap.lines.map((line) => line.currency).sort()).toEqual(["PEN", "USD"])
    expect(snap.totalCents).toBeNull()
    const text = await printedText(snap)
    expect(text).toContain(`${soles(30_000)} + ${dollars(100_000)}`)
    expect(text).toContain(dollars(100_000))
    expect(text).toContain(soles(30_000))
    // El total de la hoja también: «por definir» diría que falta un precio, y no falta.
    expect(text).not.toContain("por definir")
    // Nunca 130,000 en ninguna moneda.
    expect(text).not.toContain(soles(130_000))
    expect(text).not.toContain(dollars(130_000))
  })

  it("con una moneda, el total de siempre", async () => {
    const f = await clinic(null)
    const pen = await f.indicate(f.resin.id)
    const budget = await f.run((tx) =>
      createBudget(tx, ...f.args, { planId: f.planId, itemIds: [pen.id] }),
    )
    const snap = await f.run((tx) => buildBudgetSnapshot(tx, f.orgId, f.patientId, budget.id))
    expect(snap).toMatchObject({ currency: "PEN", totalCents: 30_000, subtotalCents: 30_000 })
    const text = await printedText(snap)
    expect(text).toContain(soles(30_000))
    expect(text).not.toContain(" + ")
  })
})

describe("cerrar la atención", () => {
  it("lo cobrado y lo presupuestado van con un total por moneda", async () => {
    const f = await clinic()
    await makeSigner(f.orgId, f.actor)
    // Hecho hoy, en las dos monedas.
    const donePen = await f.indicate(f.resin.id)
    const doneUsd = await f.indicate(f.implant.id)
    const accepted = await f.run(async (tx) => {
      const budget = await createBudget(tx, ...f.args, {
        planId: f.planId,
        itemIds: [donePen.id, doneUsd.id],
      })
      await deliverBudget(tx, ...f.args, budget.id)
      return decideBudget(tx, ...f.args, budget.id, {
        decisions: [
          { planItemId: donePen.id, decision: "aceptado" },
          { planItemId: doneUsd.id, decision: "aceptado" },
        ],
      })
    })
    expect(accepted.status).toBe("aceptado")
    await f.run(async (tx) => {
      await addEncounterProcedure(tx, ...f.args, f.encounterId, { planItemId: donePen.id })
      await addEncounterProcedure(tx, ...f.args, f.encounterId, { planItemId: doneUsd.id })
    })
    // Indicado para después, en las dos monedas: ninguna línea queda fuera por ir en otra.
    await f.indicate(f.resin.id)
    await f.indicate(f.implant.id)
    await readyToClose(f.orgId, f.actor, f.patientId, f.encounterId)

    const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounterId))

    expect(closed.billing.totals).toEqual([
      { currency: "PEN", totalCents: 30_000 },
      { currency: "USD", totalCents: 100_000 },
    ])
    expect(closed.billing.chargedCents).toBeNull()
    expect(closed.budget?.added).toBe(2)
    expect(
      closed.budget?.totals.map(({ currency, totalCents }) => ({ currency, totalCents })),
    ).toEqual([
      { currency: "PEN", totalCents: 30_000 },
      { currency: "USD", totalCents: 100_000 },
    ])
    expect(closed.budget?.totalCents).toBeNull()
  })

  it("armar lo indicado no omite lo que va en otra moneda que el borrador", async () => {
    const f = await clinic()
    const pen = await f.indicate(f.resin.id)
    const usd = await f.indicate(f.implant.id)
    const draft = await f.run((tx) =>
      createBudget(tx, ...f.args, { planId: f.planId, itemIds: [pen.id] }),
    )
    const assembled = await f.run((tx) => assembleEncounterBudget(tx, ...f.args, f.encounterId))
    expect(assembled?.id).toBe(draft.id)
    expect(assembled?.added).toBe(1)
    const lines = await f.run(
      async (tx) => (await getBudgetDetail(tx, f.orgId, f.patientId, draft.id)).items,
    )
    expect(lines.map((line) => line.planItemId).sort()).toEqual([pen.id, usd.id].sort())
  })
})

describe("la oportunidad", () => {
  const open = (f: Awaited<ReturnType<typeof clinic>>) =>
    f.run((tx) =>
      createOpportunity(
        tx,
        f.orgId,
        { contactId: f.contactId, patientId: f.patientId, title: "Implante", amountCents: 1_000 },
        { userId: f.actor, origin: "persona" },
      ),
    )

  it("con dos monedas se estima en moneda del negocio al cambio de hoy", async () => {
    const f = await clinic()
    const opportunity = await open(f)
    const { budget } = await f.twoLines()
    await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
    const detail = await f.run((tx) => getOpportunity(tx, f.orgId, opportunity.id))
    // S/ 300 + USD 1,000 a 3.75 = S/ 4,050.
    expect(detail).toMatchObject({
      amountCents: 405_000,
      currency: "PEN",
      amountFromBudget: true,
      amountEstimated: true,
    })
  })

  it("si acepta solo lo de una moneda, su valor es esa moneda, sin estimar", async () => {
    const f = await clinic()
    const opportunity = await open(f)
    const { pen, usd, budget } = await f.twoLines()
    await f.run(async (tx) => {
      await deliverBudget(tx, ...f.args, budget.id)
      await decideBudget(tx, ...f.args, budget.id, {
        decisions: [
          { planItemId: pen.id, decision: "rechazado" },
          { planItemId: usd.id, decision: "aceptado" },
        ],
      })
    })
    const detail = await f.run((tx) => getOpportunity(tx, f.orgId, opportunity.id))
    expect(detail).toMatchObject({ amountCents: 100_000, currency: "USD", amountEstimated: false })
  })

  it("con una moneda no se estima nada", async () => {
    const f = await clinic(null)
    const opportunity = await open(f)
    const pen = await f.indicate(f.resin.id)
    const budget = await f.run((tx) =>
      createBudget(tx, ...f.args, { planId: f.planId, itemIds: [pen.id] }),
    )
    await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
    const detail = await f.run((tx) => getOpportunity(tx, f.orgId, opportunity.id))
    expect(detail).toMatchObject({
      amountCents: 30_000,
      currency: "PEN",
      amountFromBudget: true,
      amountEstimated: false,
    })
  })

  it("un valor a mano sigue en la moneda que ya tenía, si la clínica la usa", async () => {
    const f = await clinic()
    const opportunity = await open(f)
    const usd = await f.indicate(f.implant.id)
    const budget = await f.run((tx) =>
      createBudget(tx, ...f.args, { planId: f.planId, itemIds: [usd.id] }),
    )
    await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
    const edited = await f.run((tx) =>
      updateOpportunity(
        tx,
        f.orgId,
        opportunity.id,
        { amountCents: 90_000 },
        { userId: f.actor, origin: "persona" },
      ),
    )
    expect(edited).toMatchObject({ amountCents: 90_000, currency: "USD" })
  })

  it("en Argos un presupuesto es una sola fila, con todo en moneda del negocio", async () => {
    const f = await clinic()
    const { budget } = await f.twoLines()
    await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
    const { rows } = await runArgosQuery(appDb, {
      orgId: f.orgId,
      memberRole: "owner",
      query: "select valor, valor_otra_moneda, otra_moneda from presupuestos",
    })
    expect(rows).toEqual([{ valor: 4050, valor_otra_moneda: 1000, otra_moneda: "USD" }])
  })
})

describe("lo que lee el agente", () => {
  it("con dos monedas, un total por cada una y cada línea con la suya", async () => {
    const f = await clinic()
    const { budget } = await f.twoLines()
    await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
    const found = await f.run((tx) => getAgentPatientBudgets(tx, f.orgId, f.contactId, f.patientId))
    const view = found.budgets[0]!
    expect(view.totalCents).toBeNull()
    expect(view.totals).toEqual([
      { currency: "PEN", totalCents: 30_000 },
      { currency: "USD", totalCents: 100_000 },
    ])
    expect(view.options[0]?.lines.map((line) => line.currency).sort()).toEqual(["PEN", "USD"])
  })

  it("con una, la misma forma de siempre", async () => {
    const f = await clinic(null)
    const pen = await f.indicate(f.resin.id)
    const budget = await f.run((tx) =>
      createBudget(tx, ...f.args, { planId: f.planId, itemIds: [pen.id] }),
    )
    await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
    const found = await f.run((tx) => getAgentPatientBudgets(tx, f.orgId, f.contactId, f.patientId))
    const view = found.budgets[0]!
    expect(view).toMatchObject({ currency: "PEN", totalCents: 30_000 })
    expect(view).not.toHaveProperty("totals")
    expect(view.options[0]).not.toHaveProperty("totals")
    expect(view.options[0]?.lines[0]).not.toHaveProperty("currency")
  })
})

describe("una clínica de una moneda", () => {
  it("sigue sin poder indicar en otra: el servicio solo admite la suya", async () => {
    const f = await clinic(null)
    await expect(
      f.run((tx) =>
        createService(tx, f.orgId, f.actor, {
          name: "En dólares",
          priceCents: 1_000,
          currency: "USD",
        }),
      ),
    ).rejects.toMatchObject({ fields: { currency: expect.any(String) } })
  })

  it("ve las cifras de siempre", async () => {
    const f = await clinic(null)
    const first = await f.indicate(f.resin.id)
    const second = await f.indicate(f.resin.id)
    const budget = await f.run((tx) =>
      createBudget(tx, ...f.args, { planId: f.planId, itemIds: [first.id, second.id] }),
    )
    expect(budget).toMatchObject({
      currency: "PEN",
      totalCents: 60_000,
      acceptedCents: 0,
      tariffTotalCents: 60_000,
      discountCents: 0,
    })
    expect(budget.options[0]).toMatchObject({ totalCents: 60_000, acceptedCents: 0 })
    expect(budget.totals).toHaveLength(1)
    expect(budgetLine(budget, LOCALE)).toBe(`2 tratamientos · ${soles(60_000)}`)
    const listed = await f.run((tx) => listBudgets(tx, f.orgId, f.patientId))
    expect(listed[0]).toMatchObject({ currency: "PEN", totalCents: 60_000 })
  })

  it("en «Te espera» no recibe nada nuevo", async () => {
    const f = await clinic(null)
    const pen = await f.indicate(f.resin.id)
    const budget = await f.run((tx) =>
      createBudget(tx, ...f.args, { planId: f.planId, itemIds: [pen.id] }),
    )
    await ownerDb.execute(
      sql`update treatment_budget_item set created_at = now() - interval '3 days' where budget_id = ${budget.id}`,
    )
    // Firmada la atención, el presupuesto queda armado (en borrador aún se prepara).
    await ownerDb.execute(sql`update encounter set status = 'finalizada', signer_name = 'Clínico', signer_registration = 'COP 1' where id = ${f.encounterId}`)
    const home = await f.run((tx) => getWorkspaceHome(tx, f.orgId, f.actor, SENDS_BUDGETS))
    const row = unsentRow(home)
    expect(row).toMatchObject({ totalCents: 30_000, currency: "PEN", itemCount: 1 })
    expect(row).not.toHaveProperty("totals")
  })
})

describe("«Te espera» con dos monedas", () => {
  it("dice un total por cada una", async () => {
    const f = await clinic()
    const { budget } = await f.twoLines()
    await ownerDb.execute(
      sql`update treatment_budget_item set created_at = now() - interval '3 days' where budget_id = ${budget.id}`,
    )
    // Firmada la atención, el presupuesto queda armado (en borrador aún se prepara).
    await ownerDb.execute(sql`update encounter set status = 'finalizada', signer_name = 'Clínico', signer_registration = 'COP 1' where id = ${f.encounterId}`)
    const home = await f.run((tx) => getWorkspaceHome(tx, f.orgId, f.actor, SENDS_BUDGETS))
    const row = unsentRow(home)
    expect(row).toMatchObject({
      totalCents: null,
      itemCount: 2,
      totals: [
        { currency: "PEN", totalCents: 30_000 },
        { currency: "USD", totalCents: 100_000 },
      ],
    })
  })
})

describe("la promoción, en la moneda de su servicio", () => {
  const promo = (f: Awaited<ReturnType<typeof clinic>>, serviceId: string, priceCents: number) =>
    f.run((tx) =>
      createPromotion(tx, f.orgId, f.actor, {
        name: "Sonrisa",
        startsAt: new Date(Date.now() - DAY).toISOString(),
        endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
        conditions: null,
        items: [{ serviceId, mode: "fixed", priceCents }],
      }),
    )

  it("toma la moneda del servicio y, si el servicio cambió de moneda, deja de cotizarse", async () => {
    const f = await clinic()
    const created = await promo(f, f.implant.id, 80_000)
    const price = await f.run((tx) => requirePromotionPrice(tx, f.orgId, created.id, f.implant.id))
    expect(price).toMatchObject({ priceCents: 80_000, currency: "USD", tariffCents: 100_000 })

    await ownerDb.execute(
      sql`update service_catalog set currency = 'PEN', price_cents = 300000 where id = ${f.implant.id}`,
    )
    await expect(
      f.run((tx) => requirePromotionPrice(tx, f.orgId, created.id, f.implant.id)),
    ).rejects.toMatchObject({ code: "PROMOTION_NO_SERVICE" })
    // Y a la caja y al agente no les llega un precio que ya no dice nada.
    const summaries = await f.run((tx) => listClinicPromotionSummaries(tx, f.orgId))
    expect(summaries[0]?.items).toEqual([])
  })

  it("en Reportes, lo descontado en la otra moneda entra al cambio de hoy", async () => {
    const f = await clinic()
    const created = await promo(f, f.implant.id, 80_000)
    const usd = await f.indicate(f.implant.id)
    await f.run(async (tx) => {
      const budget = await createBudget(tx, ...f.args, { planId: f.planId, itemIds: [usd.id] })
      await adjustBudgetLines(tx, ...f.args, budget.id, {
        lines: [{ planItemId: usd.id, promotionId: created.id }],
      })
      await deliverBudget(tx, ...f.args, budget.id)
      await decideBudget(tx, ...f.args, budget.id, {
        decisions: [{ planItemId: usd.id, decision: "aceptado" }],
      })
    })
    const report = await f.run((tx) => getReportPromotions(tx, f.orgId, { period: "este_mes" }))
    // USD 200 de descuento a 3.75.
    expect(report.promotions[0]).toMatchObject({
      name: "Sonrisa",
      accepted: 1,
      discountCents: 75_000,
    })
    expect(report.discountCents).toBe(75_000)
  })
})
