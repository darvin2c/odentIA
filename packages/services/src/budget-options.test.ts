/**
 * Paso 3 de la fase 3 (ADR 0034): un solo borrador por persona que crece con
 * cada atención, dos o tres opciones en un mismo presupuesto (decisión 13),
 * lo propio del odontólogo es lo que él indicó, «Agendar» une lo aceptado a
 * la cita y su atención lo trae, y «Qué sigue» decide frase y botón.
 */
import { randomUUID } from "node:crypto"
import { scheduleChair } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import {
  appointmentPlanItem,
  encounterPlanItem,
  patientContact,
  treatmentBudgetItem,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { opportunity } from "@odentia/db/schema/opportunities"
import { branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { createAppointment } from "./appointments.js"
import { previewBudgetSend, sendBudget } from "./budget-send.js"
import {
  addBudgetItems,
  createBudget,
  decideBudget,
  deliverBudget,
  duplicateBudgetOption,
  getBudgetDetail,
  listBudgets,
  recommendBudgetOption,
  removeBudgetItems,
  removeBudgetOption,
} from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createEncounter, finalizeEncounter } from "./encounters.js"
import { createOpportunity } from "./opportunities.js"
import { getPlanNextStep } from "./plan-next.js"
import { addPlanItem } from "./plan.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
import type { Storage } from "./storage.js"
import { getWorkspaceHome, type WorkspaceAccess } from "./workspace.js"
import { withOrgContext } from "@odentia/db"
setupTestDb()

const all = () => true

async function withItems(n: number) {
  const f = await clinicalFixture()
  const items = []
  for (let i = 0; i < n; i++) {
    items.push(
      await f.run((tx) =>
        addPlanItem(tx, ...f.args, { serviceId: f.service.id, sourceEncounterId: f.encounter.id }),
      ),
    )
  }
  return { f, items }
}

it("un solo borrador por persona: preparar otra vez suma al mismo; enviado, lo nuevo abre otro solo con lo nuevo", async () => {
  const { f, items } = await withItems(3)
  const [a, b, c] = items as [(typeof items)[number], (typeof items)[number], (typeof items)[number]]
  const first = await f.run((tx) => createBudget(tx, ...f.args, { itemIds: [a.id] }))
  const again = await f.run((tx) => createBudget(tx, ...f.args, { itemIds: [b.id] }))
  expect(again.id).toBe(first.id)
  expect(again.items.map((line) => line.planItemId).sort()).toEqual([a.id, b.id].sort())
  expect(again.stateText).toBe("Por enviar")
  await f.run((tx) => deliverBudget(tx, ...f.args, first.id))
  const next = await f.run((tx) => createBudget(tx, ...f.args, { itemIds: [c.id] }))
  expect(next.id).not.toBe(first.id)
  expect(next.items.map((line) => line.planItemId)).toEqual([c.id])
  // La base tampoco admite dos borradores de la misma persona.
  const drafts = (await f.run((tx) => listBudgets(tx, "org_a", f.patient.id))).filter((x) => x.status === "borrador")
  expect(drafts).toHaveLength(1)
})

it("al firmar la atención queda armado el presupuesto con lo indicado en ella, sin enviarse", async () => {
  const { f, items } = await withItems(2)
  await f.ready(f.encounter.id)
  const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, {}))
  expect(closed.budget).toMatchObject({ itemCount: 2, added: 2, totalCents: 240000, currency: "PEN" })
  const budgets = await f.run((tx) => listBudgets(tx, "org_a", f.patient.id))
  expect(budgets).toHaveLength(1)
  expect(budgets[0]).toMatchObject({ status: "borrador", presentedAt: null })
  expect(budgets[0]!.items.map((line) => line.planItemId).sort()).toEqual(items.map((item) => item.id).sort())
})

it("dos opciones: cada una con su total, nunca sumadas; al elegir una, la otra queda «No elegida» y lo que solo estaba en ella también", async () => {
  const { f, items } = await withItems(3)
  const [resinas, resina46, corona46] = items as [(typeof items)[number], (typeof items)[number], (typeof items)[number]]
  // Opción A: resinas + resina en la 46; la corona se cotiza aparte.
  await ownerDb.update(treatmentPlanItem).set({ priceCents: 90000 }).where(eq(treatmentPlanItem.id, corona46.id))
  const draft = await f.run((tx) => createBudget(tx, ...f.args, { itemIds: [resinas.id, resina46.id] }))
  const optionA = draft.options[0]!
  const duplicated = await f.run((tx) => duplicateBudgetOption(tx, ...f.args, draft.id, optionA.id))
  expect(duplicated.options.map((option) => option.label)).toEqual(["Opción A", "Opción B"])
  const optionB = duplicated.options[1]!
  // En la B se cambia la resina por la corona.
  await f.run((tx) => removeBudgetItems(tx, ...f.args, draft.id, { itemIds: [resina46.id], optionId: optionB.id }))
  const withCrown = await f.run((tx) =>
    addBudgetItems(tx, ...f.args, draft.id, { itemIds: [corona46.id], optionId: optionB.id }),
  )
  const totals = Object.fromEntries(withCrown.options.map((option) => [option.label, option.totalCents]))
  expect(totals).toEqual({ "Opción A": 240000, "Opción B": 210000 })
  // Vale la recomendada (la A), no la suma de las dos.
  expect(withCrown.totalCents).toBe(240000)
  const recommended = await f.run((tx) => recommendBudgetOption(tx, ...f.args, draft.id, optionB.id))
  expect(recommended.totalCents).toBe(210000)
  await f.run((tx) => deliverBudget(tx, ...f.args, draft.id))
  // Con varias opciones hay que elegir una.
  await expect(
    f.run((tx) =>
      decideBudget(tx, ...f.args, draft.id, {
        decisions: [
          { planItemId: resinas.id, decision: "aceptado" },
          { planItemId: corona46.id, decision: "aceptado" },
        ],
      }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  // Elige la B y deja la corona para después.
  const decided = await f.run((tx) =>
    decideBudget(tx, ...f.args, draft.id, {
      optionId: optionB.id,
      decisions: [
        { planItemId: resinas.id, decision: "aceptado" },
        { planItemId: corona46.id, decision: "pospuesto" },
      ],
    }),
  )
  expect(decided.status).toBe("parcial")
  expect(decided.stateText).toBe("Aceptó 1 de 2")
  expect(decided.options.map((option) => option.decision)).toEqual(["no_elegida", "elegida"])
  expect(decided.acceptedCents).toBe(120000)
  expect(decided.items.filter((line) => line.optionId === optionA.id).every((line) => line.decision === "no_elegida")).toBe(true)
  const [onlyInA] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, resina46.id))
  expect(onlyInA).toMatchObject({ decisionStatus: "no_elegida" })
  const [inBoth] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, resinas.id))
  expect(inBoth).toMatchObject({ decisionStatus: "aceptado" })
  // Ya eligió: otra opción no se elige después.
  await expect(
    f.run((tx) =>
      decideBudget(tx, ...f.args, draft.id, {
        optionId: optionA.id,
        decisions: [
          { planItemId: resinas.id, decision: "aceptado" },
          { planItemId: resina46.id, decision: "aceptado" },
        ],
      }),
    ),
  ).rejects.toMatchObject({ code: "BUDGET_DECISION_FINAL" })
})

it("las opciones solo cambian en borrador; siempre queda una y se renumeran", async () => {
  const { f, items } = await withItems(1)
  const draft = await f.run((tx) => createBudget(tx, ...f.args, { itemIds: [items[0]!.id] }))
  await expect(
    f.run((tx) => removeBudgetOption(tx, ...f.args, draft.id, draft.options[0]!.id)),
  ).rejects.toMatchObject({ code: "BUDGET_LAST_OPTION" })
  const two = await f.run((tx) => duplicateBudgetOption(tx, ...f.args, draft.id, draft.options[0]!.id))
  const three = await f.run((tx) => duplicateBudgetOption(tx, ...f.args, draft.id, draft.options[0]!.id))
  expect(three.options).toHaveLength(3)
  await expect(
    f.run((tx) => duplicateBudgetOption(tx, ...f.args, draft.id, draft.options[0]!.id)),
  ).rejects.toMatchObject({ code: "BUDGET_OPTIONS_MAX" })
  // Quitar la A (recomendada): la que queda primera pasa a ser la A y la recomendada.
  const left = await f.run((tx) => removeBudgetOption(tx, ...f.args, draft.id, draft.options[0]!.id))
  expect(left.options.map((option) => [option.label, option.isRecommended])).toEqual([
    ["Opción A", true],
    ["Opción B", false],
  ])
  expect(left.options[0]!.id).toBe(two.options[1]!.id)
  await f.run((tx) => deliverBudget(tx, ...f.args, draft.id))
  await expect(
    f.run((tx) => duplicateBudgetOption(tx, ...f.args, draft.id, left.options[0]!.id)),
  ).rejects.toMatchObject({ code: "BUDGET_STATUS" })
})

it("el valor de la oportunidad es el de la recomendada mientras decide y el de lo elegido después", async () => {
  const { f, items } = await withItems(2)
  const [a, b] = items as [(typeof items)[number], (typeof items)[number]]
  const draft = await f.run((tx) => createBudget(tx, ...f.args, { itemIds: [a.id, b.id] }))
  const two = await f.run((tx) => duplicateBudgetOption(tx, ...f.args, draft.id, draft.options[0]!.id))
  await f.run((tx) => removeBudgetItems(tx, ...f.args, draft.id, { itemIds: [b.id], optionId: two.options[1]!.id }))
  // La persona del paciente y su oportunidad por ese tratamiento, por la operación de siempre.
  const [self] = await ownerDb
    .select({ contactId: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.patientId, f.patient.id), eq(patientContact.relationship, "self")))
  const opp = await f.run((tx) =>
    createOpportunity(tx, "org_a", { contactId: self!.contactId, patientId: f.patient.id, serviceId: f.service.id, title: "Tratamiento" }, { userId: f.actor }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, draft.id))
  const [linked] = await ownerDb.select().from(opportunity).where(eq(opportunity.id, opp.id))
  expect(linked?.amountCents).toBe(240000)
  await f.run((tx) =>
    decideBudget(tx, ...f.args, draft.id, {
      optionId: two.options[1]!.id,
      decisions: [{ planItemId: a.id, decision: "aceptado" }],
    }),
  )
  const [won] = await ownerDb.select().from(opportunity).where(eq(opportunity.id, opp.id))
  expect(won).toMatchObject({ status: "won", amountCents: 120000 })
})

it("el odontólogo actúa sobre lo que él indicó, aunque el plan lo haya abierto otro", async () => {
  const { f, items } = await withItems(1)
  const other = randomUUID()
  const third = randomUUID()
  await ownerDb.insert(user).values([
    { id: other, name: "Otro clínico", email: `${other}@example.test` },
    { id: third, name: "Tercer clínico", email: `${third}@example.test` },
  ])
  await ownerDb.insert(member).values([
    { id: randomUUID(), organizationId: "org_a", userId: other, role: "dentist", createdAt: new Date() },
    { id: randomUUID(), organizationId: "org_a", userId: third, role: "dentist", createdAt: new Date() },
  ])
  // El plan lo abrió f.actor; este tratamiento lo indicó `other`.
  const own = await withOrgContext(appDb, "org_a", (tx) =>
    addPlanItem(tx, "org_a", other, f.patient.id, { serviceId: f.service.id, sourceEncounterId: f.encounter.id }),
  )
  const asDentist = { memberRole: "dentist" }
  const budget = await withOrgContext(appDb, "org_a", (tx) =>
    createBudget(tx, "org_a", other, f.patient.id, { itemIds: [own.id] }, asDentist),
  )
  // Un tratamiento que no indicó no lo puede sumar.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      addBudgetItems(tx, "org_a", other, f.patient.id, budget.id, { itemIds: [items[0]!.id] }, asDentist),
    ),
  ).rejects.toMatchObject({ code: "BUDGET_NOT_OWN_PLAN" })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      getBudgetDetail(tx, "org_a", f.patient.id, budget.id, { actorUserId: third, memberRole: "dentist" }),
    ),
  ).rejects.toMatchObject({ code: "BUDGET_NOT_OWN_PLAN" })
  const seen = await withOrgContext(appDb, "org_a", (tx) =>
    listBudgets(tx, "org_a", f.patient.id, undefined, { actorUserId: other, memberRole: "dentist" }),
  )
  expect(seen.map((row) => row.id)).toEqual([budget.id])
})

it("«Agendar» une lo aceptado a la cita, su atención lo trae y «Qué sigue» avanza", async () => {
  const { f, items } = await withItems(2)
  const [a, b] = items as [(typeof items)[number], (typeof items)[number]]
  await f.ready(f.encounter.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, {}))
  const draft = (await f.run((tx) => listBudgets(tx, "org_a", f.patient.id)))[0]!
  expect((await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, all))).kind).toBe("enviar")
  await f.run((tx) => deliverBudget(tx, ...f.args, draft.id))
  expect(await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, all))).toMatchObject({
    kind: "respuesta",
    text: "Enviado · espera respuesta",
    action: { label: "¿Qué respondió?", budgetId: draft.id },
  })
  await f.run((tx) =>
    decideBudget(tx, ...f.args, draft.id, {
      decisions: [
        { planItemId: a.id, decision: "aceptado" },
        { planItemId: b.id, decision: "pospuesto" },
      ],
    }),
  )
  const next = await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, all))
  expect(next).toMatchObject({ kind: "agendar", text: "Aceptó 1 de 2: falta agendar", action: { label: "Agendar", planItemIds: [a.id] } })
  // Sin permiso de agenda, la frase se dice pero el botón no.
  const reader = await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, (p) => p !== "appointments.write"))
  expect(reader.action).toBeNull()

  const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}` }).returning()
  await ownerDb.insert(scheduleChair).values({ organizationId: "org_a", branchId: site!.id, name: "Unidad dental 1" })
  const startsAt = new Date(Date.now() + 3 * 24 * 3_600_000)
  startsAt.setUTCMinutes(0, 0, 0)
  const cita = await f.run((tx) =>
    createAppointment(tx, "org_a", f.actor, {
      patientId: f.patient.id,
      dentistUserId: f.actor,
      branchId: site!.id,
      startsAt: startsAt.toISOString(),
      durationMin: 30,
      outsideSchedule: true,
      planItemIds: [a.id],
      notice: false,
    }),
  )
  const links = await ownerDb.select().from(appointmentPlanItem).where(eq(appointmentPlanItem.appointmentId, cita.id))
  expect(links.map((link) => link.planItemId)).toEqual([a.id])
  // Lo no aceptado no se agenda.
  await expect(
    f.run((tx) =>
      createAppointment(tx, "org_a", f.actor, {
        patientId: f.patient.id,
        dentistUserId: f.actor,
        branchId: site!.id,
        startsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
        durationMin: 30,
        outsideSchedule: true,
        planItemIds: [b.id],
        notice: false,
      }),
    ),
  ).rejects.toMatchObject({ code: "ITEM_NOT_ACCEPTED" })
  // Con la cita puesta, lo que sigue es la respuesta que falta (lo que piensa).
  expect((await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, all))).text).toBe("Lo está pensando")
  // La atención de esa cita trae el tratamiento.
  const attention = await f.run((tx) => createEncounter(tx, ...f.args, { appointmentId: cita.id }))
  const brought = await ownerDb
    .select()
    .from(encounterPlanItem)
    .where(and(eq(encounterPlanItem.encounterId, attention.id), eq(encounterPlanItem.planItemId, a.id)))
  expect(brought).toHaveLength(1)
})

it("«Te espera»: el presupuesto armado que nadie envió sale al día siguiente a quien lo envía, y se va al enviarlo", async () => {
  const { f, items } = await withItems(2)
  const draft = await f.run((tx) => createBudget(tx, ...f.args, { itemIds: items.map((item) => item.id) }))
  const sender: WorkspaceAccess = {
    patients: true, appointments: false, conversations: false, tasks: false, finance: false, clinical: false,
    crm: true, agent: false, allTasks: false, configure: false, ownAppointments: false, sendsBudgets: true,
  }
  const unsent = async (access: WorkspaceAccess) =>
    (await f.run((tx) => getWorkspaceHome(tx, "org_a", f.actor, access))).waiting.filter((row) => row.kind === "unsentBudget")
  // Armado hoy: todavía no espera a nadie.
  expect(await unsent(sender)).toEqual([])
  // Su último tratamiento entró hace dos días.
  await ownerDb
    .update(treatmentBudgetItem)
    .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
    .where(eq(treatmentBudgetItem.budgetId, draft.id))
  expect(await unsent(sender)).toEqual([
    expect.objectContaining({ id: draft.id, patientId: f.patient.id, itemCount: 2, totalCents: 240000, options: 1 }),
  ])
  // Solo a quien envía presupuestos.
  expect(await unsent({ ...sender, sendsBudgets: false })).toEqual([])
  // Enviado (o entregado en mano), se va solo.
  await f.run((tx) => deliverBudget(tx, ...f.args, draft.id))
  expect(await unsent(sender)).toEqual([])
})

it("enviar: dice antes por dónde saldría; sin vía no entrega nada, y el agente nunca envía un borrador", async () => {
  const { f, items } = await withItems(1)
  const draft = await f.run((tx) => createBudget(tx, ...f.args, { itemIds: [items[0]!.id] }))
  // Sin WhatsApp ni correo en la clínica: lo dice antes de pulsar.
  const preview = await f.run((tx) => previewBudgetSend(tx, "org_a", f.patient.id, draft.id))
  expect(preview).toMatchObject({ channel: null, via: null, label: null })
  expect(preview.blocked).toBeTruthy()
  expect(preview.text).toContain("1 tratamiento por")
  const noStorage = {} as Storage
  const input = { patientId: f.patient.id, budgetId: draft.id, requestId: randomUUID() }
  await expect(
    f.run((tx) => sendBudget(tx, "org_a", { userId: f.actor }, input, { storage: noStorage })),
  ).rejects.toMatchObject({ code: "BUDGET_NO_ROUTE" })
  // Nada quedó a medias: sigue «Por enviar», para imprimirlo y entregarlo.
  expect((await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, draft.id))).stateText).toBe("Por enviar")
  // El agente reenvía lo ya preparado; un borrador espera a la clínica (decisión 4).
  await expect(
    f.run((tx) => sendBudget(tx, "org_a", { userId: null, by: "agente" }, { ...input, requestId: randomUUID() }, { storage: noStorage })),
  ).rejects.toMatchObject({ code: "BUDGET_NOT_READY" })
})
