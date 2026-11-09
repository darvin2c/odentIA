/**
 * Anular una atención con lo indicado en un presupuesto (error visto en
 * producción el 8 nov): un presupuesto que nunca se entregó frenaba la
 * anulación con «cancélala o revísala antes de anular», sin salida. Ahora lo no
 * entregado se anula con la atención, lo entregado se anula si quien anula lo
 * confirma, y solo frena lo que no se deshace (un cobro, algo hecho, una firma).
 */

import { encounter, treatmentBudget, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { opportunity } from "@odentia/db/schema/opportunities"
import { and, eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addEncounterProcedure, getEncounterVoidPreview, voidEncounter } from "./encounters.js"
import { createCharge } from "./payments.js"
import { addPlanItem } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Indicado en la atención del fixture (o, con `elsewhere`, en una anterior ya firmada). */
async function indicate(f: Fixture, elsewhere = false) {
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
    }),
  )
  if (!elsewhere) return item
  const [before] = await ownerDb
    .insert(encounter)
    .values({
      organizationId: f.args[0],
      patientId: f.patient.id,
      professionalUserId: f.actor,
      status: "finalizada",
    })
    .returning()
  await ownerDb
    .update(treatmentPlanItem)
    .set({ sourceEncounterId: before!.id })
    .where(eq(treatmentPlanItem.id, item.id))
  return item
}

const budgetOf = async (id: string) => {
  const [row] = await ownerDb.select().from(treatmentBudget).where(eq(treatmentBudget.id, id))
  return row!
}
const itemOf = async (id: string) => {
  const [row] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, id))
  return row!
}
const preview = (f: Fixture) =>
  f.run((tx) => getEncounterVoidPreview(tx, ...f.args, f.encounter.id))
const voidIt = (f: Fixture, budgets?: Array<{ id: string; status: string }>) =>
  f.run((tx) =>
    voidEncounter(tx, ...f.args, f.encounter.id, {
      reason: "Paciente equivocado",
      ...(budgets ? { budgets } : {}),
    }),
  )

it("un presupuesto por enviar con lo de esta atención se anula con ella, sin pedir nada", async () => {
  const f = await clinicalFixture()
  const item = await indicate(f)
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )

  const seen = await preview(f)
  expect(seen).toMatchObject({ blocked: false, confirm: [] })
  expect(seen.budgets).toEqual([
    expect.objectContaining({
      id: budget.id,
      budgetNumber: budget.budgetNumber,
      delivered: false,
      effect: "anula",
      others: 0,
    }),
  ])

  const voided = await voidIt(f)
  expect(voided.status).toBe("anulada")
  expect((await budgetOf(budget.id)).status).toBe("cancelado")
  expect(await itemOf(item.id)).toMatchObject({ status: "cancelado", budgetId: null })
})

it("un borrador que lleva además lo de otra atención solo pierde lo de esta", async () => {
  const f = await clinicalFixture()
  const here = await indicate(f)
  const other = await indicate(f, true)
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [here.id, other.id] }),
  )

  const seen = await preview(f)
  expect(seen.budgets).toEqual([
    expect.objectContaining({ effect: "quita", others: 1, delivered: false }),
  ])

  await voidIt(f)
  expect((await budgetOf(budget.id)).status).toBe("borrador")
  const lines = await ownerDb.execute<{ plan_item_id: string }>(
    sql`select plan_item_id from treatment_budget_item where budget_id = ${budget.id}`,
  )
  expect(lines.map((row) => row.plan_item_id)).toEqual([other.id])
  expect(await itemOf(other.id)).toMatchObject({ status: "pendiente", budgetId: budget.id })
})

it("uno entregado se anula solo con la confirmación de lo que mostró el diálogo", async () => {
  const f = await clinicalFixture()
  const item = await indicate(f)
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))

  const seen = await preview(f)
  expect(seen.confirm).toEqual([{ id: budget.id, status: "presentado" }])
  expect(seen.budgets[0]).toMatchObject({ delivered: true, effect: "anula" })

  // Sin confirmarlo no se anula nada.
  await expect(voidIt(f)).rejects.toMatchObject({ code: "VOID_BUDGETS_CHANGED" })
  // Confirmado con otro estado (alguien anotó la respuesta mientras tanto): tampoco.
  await expect(voidIt(f, [{ id: budget.id, status: "borrador" }])).rejects.toMatchObject({
    code: "VOID_BUDGETS_CHANGED",
  })
  expect((await budgetOf(budget.id)).status).toBe("presentado")

  await voidIt(f, seen.confirm)
  expect((await budgetOf(budget.id)).status).toBe("cancelado")
})

it("uno aceptado se anula con la atención y su oportunidad deja de contar como ganada", async () => {
  const f = await clinicalFixture()
  const item = await indicate(f)
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
    }),
  )
  const [won] = await ownerDb.select().from(opportunity).where(eq(opportunity.budgetId, budget.id))
  expect(won?.status).toBe("won")

  const seen = await preview(f)
  expect(seen.confirm).toEqual([{ id: budget.id, status: "aceptado" }])
  await voidIt(f, seen.confirm)

  expect((await budgetOf(budget.id)).status).toBe("cancelado")
  const [after] = await ownerDb.select().from(opportunity).where(eq(opportunity.id, won!.id))
  expect(after?.status).not.toBe("won")
})

it("lo que no aceptó no frena: el presupuesto queda como constancia", async () => {
  const f = await clinicalFixture()
  const item = await indicate(f)
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [{ planItemId: item.id, decision: "rechazado" }],
    }),
  )

  expect((await preview(f)).budgets).toEqual([])
  await voidIt(f)
  expect((await budgetOf(budget.id)).status).toBe("rechazado")
  expect((await itemOf(item.id)).status).toBe("cancelado")
})

it("un cobro vigente frena y dice qué se cobró", async () => {
  const f = await clinicalFixture()
  const item = await indicate(f)
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const decided = await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
    }),
  )
  await f.run((tx) => createCharge(tx, ...f.args, { budgetItemId: decided.items[0]!.id }))

  const seen = await preview(f)
  expect(seen.blocked).toBe(true)
  expect(seen.confirm).toEqual([])
  expect(seen.budgets[0]).toMatchObject({
    effect: "frena",
    blocks: [{ kind: "cobro", treatments: [] }],
  })
  await expect(voidIt(f)).rejects.toMatchObject({ code: "VOID_BLOCKED" })
  expect((await budgetOf(budget.id)).status).toBe("aceptado")
})

it("la firma de quien decide frena; y uno respondido con tratamientos de otras atenciones se revisa, no se anula entero", async () => {
  const f = await clinicalFixture()
  const item = await indicate(f)
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
    }),
  )
  await ownerDb
    .update(treatmentBudget)
    .set({
      decisionSignature: {
        strokes: [[[0, 0]]],
        signerName: "Quien decide",
        signerKind: "paciente",
        declaration: "",
        accepted: [],
        note: "",
      },
      decisionSignedAt: new Date(),
    })
    .where(eq(treatmentBudget.id, budget.id))
  expect((await preview(f)).budgets[0]?.blocks).toEqual([
    expect.objectContaining({ kind: "firma", signerName: "Quien decide" }),
  ])
  await expect(voidIt(f, [{ id: budget.id, status: "aceptado" }])).rejects.toMatchObject({
    code: "VOID_BLOCKED",
  })

  const g = await clinicalFixture()
  const here = await indicate(g)
  const other = await indicate(g, true)
  const mixed = await g.run((tx) =>
    createBudget(tx, ...g.args, { planId: g.plan.id, itemIds: [here.id, other.id] }),
  )
  await g.run((tx) => deliverBudget(tx, ...g.args, mixed.id))
  await g.run((tx) =>
    decideBudget(tx, ...g.args, mixed.id, {
      decisions: [
        { planItemId: here.id, decision: "aceptado" },
        { planItemId: other.id, decision: "aceptado" },
      ],
    }),
  )
  expect((await preview(g)).budgets[0]).toMatchObject({
    effect: "frena",
    blocks: [{ kind: "otros", others: 1 }],
  })
})

it("entregado sin respuesta y con lo de otra atención: se anula entero y lo otro vuelve al plan sin presupuesto", async () => {
  const f = await clinicalFixture()
  const here = await indicate(f)
  const other = await indicate(f, true)
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [here.id, other.id] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const seen = await preview(f)
  expect(seen.budgets[0]).toMatchObject({ effect: "anula", others: 1, delivered: true })
  await voidIt(f, seen.confirm)
  expect((await budgetOf(budget.id)).status).toBe("cancelado")
  expect(await itemOf(other.id)).toMatchObject({ status: "pendiente", budgetId: null })
  const [mine] = await ownerDb
    .select({ status: treatmentPlanItem.status })
    .from(treatmentPlanItem)
    .where(and(eq(treatmentPlanItem.id, here.id)))
  expect(mine?.status).toBe("cancelado")
})

it("aceptó una parte (lo otro de esta atención no): se anula, sin pedir una revisión imposible", async () => {
  const f = await clinicalFixture()
  const yes = await indicate(f)
  const no = await indicate(f)
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [yes.id, no.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [
        { planItemId: yes.id, decision: "aceptado" },
        { planItemId: no.id, decision: "rechazado" },
      ],
    }),
  )
  const seen = await preview(f)
  expect(seen.budgets[0]).toMatchObject({ effect: "anula", others: 0 })
  expect(seen.confirm).toEqual([{ id: budget.id, status: "parcial" }])
  await voidIt(f, seen.confirm)
  expect((await budgetOf(budget.id)).status).toBe("cancelado")
})

it("lo aceptado y hecho en esta misma atención se deshace con ella y su presupuesto se anula", async () => {
  const f = await clinicalFixture()
  const item = await indicate(f)
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  expect(["en_curso", "realizado"]).toContain((await itemOf(item.id)).status)

  const seen = await preview(f)
  expect(seen.budgets[0]).toMatchObject({ effect: "anula", blocks: [] })
  await voidIt(f, seen.confirm)
  expect((await budgetOf(budget.id)).status).toBe("cancelado")
  expect((await itemOf(item.id)).status).toBe("cancelado")
})

it("quien ve la caja lee qué se cobró", async () => {
  const f = await clinicalFixture()
  const item = await indicate(f)
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const decided = await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }),
  )
  await f.run((tx) => createCharge(tx, ...f.args, { budgetItemId: decided.items[0]!.id }))
  const seen = await f.run((tx) => getEncounterVoidPreview(tx, ...f.args, f.encounter.id, { seesCharges: true }))
  expect(seen.budgets[0]?.blocks).toEqual([{ kind: "cobro", treatments: ["Tratamiento propio"] }])
})
