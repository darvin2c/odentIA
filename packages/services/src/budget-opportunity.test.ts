/**
 * El presupuesto entregado también abre su oportunidad (ADR 0144, precisa la
 * 0028): sin ninguna abierta que le corresponda, nace en «Presupuesto
 * enviado», unida a él y a nombre de quien lo entregó; reenviarlo no abre
 * otra, con una abierta se une como siempre, el segundo que espera respuesta
 * abre la suya y la revisión sigue con la del que reemplaza. Igual en latidIA.
 * Lo que encontró la revisión del PR #470: la revisión de lo ya vendido no
 * toma otra, anular la suelta o la cierra, Sofi no la duplica (tampoco por la
 * madre de un menor), al decidir lleva lo elegido y entregar a la vez no abre dos.
 * Lo que nadie respondió se cierra solo pasados 30 días de su vigencia.
 */
import { randomUUID } from "node:crypto"
import { patient, patientContact, serviceCatalog, treatmentBudget } from "@odentia/db/schema/clinical"
import { channelConnection, contact } from "@odentia/db/schema/crm"
import { orgProfile } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { sendBudget } from "./budget-send.js"
import {
  cancelBudget,
  createBudget,
  decideBudget,
  deliverBudget,
  duplicateBudgetOption,
  removeBudgetItems,
  reviseBudget,
} from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  closeUnansweredBudgetOpportunities,
  createOpportunity,
  getOpportunity,
  listOpportunities,
  noteServiceInterest,
  setOpportunityTask,
  updateOpportunity,
} from "./opportunities.js"
import { addPlanItem } from "./plan.js"
import type { Storage } from "./storage.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import { listWorkspaceAudit } from "./workspace.js"

setupTestDb()

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** La persona del paciente: el contacto de su oportunidad. */
async function personOf(patientId: string): Promise<string> {
  const [row] = await ownerDb.select({ personId: patient.personId }).from(patient).where(eq(patient.id, patientId))
  return row!.personId
}

const opportunitiesOf = async (f: Fixture, filter: { patientId?: string; contactId?: string } = { patientId: f.patient.id }) =>
  (await f.run((tx) => listOpportunities(tx, f.args[0], filter))).items

const indicate = (f: Fixture, serviceId: string) =>
  f.run((tx) => addPlanItem(tx, ...f.args, { serviceId, planId: f.plan.id, sourceEncounterId: f.encounter.id }))

async function otherService(orgId: string, name: string, priceCents: number): Promise<string> {
  const [row] = await ownerDb
    .insert(serviceCatalog)
    .values({ organizationId: orgId, name, scope: "general", source: "custom", priceCents, currency: "PEN" })
    .returning({ id: serviceCatalog.id })
  return row!.id
}

it("entregar un presupuesto sin oportunidad abre la suya en «Presupuesto enviado», a nombre de quien lo entregó; aceptarlo la gana", async () => {
  const f = await clinicalFixture()
  const endodoncia = await otherService("org_a", "Endodoncia", 30000)
  const resina = await indicate(f, f.service.id)
  const endo = await indicate(f, endodoncia)
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [resina.id, endo.id] }))
  expect(await opportunitiesOf(f)).toEqual([])
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))

  const [only, ...rest] = await opportunitiesOf(f)
  expect(rest).toEqual([])
  const opened = await f.run((tx) => getOpportunity(tx, "org_a", only!.id))
  expect(opened).toMatchObject({
    contactId: await personOf(f.patient.id),
    patientId: f.patient.id,
    budgetId: budget.id,
    // Sus tratamientos, en una línea; con dos servicios no tiene uno solo.
    title: "Tratamiento propio y Endodoncia",
    serviceId: null,
    moment: "presupuesto_enviado",
    status: "open",
    // Sin responsable es de Recepción.
    assignedUserId: null,
    // Su valor es el total presentado.
    amountCents: 150000,
    currency: "PEN",
    why: "Se abrió sola: Clínico presentó el presupuesto hoy",
    after: "Cuando acepte o rechace el presupuesto, se cierra sola",
  })
  // Un solo paso en su historial: nunca estuvo en «Interesado».
  expect(opened.history).toEqual([
    expect.objectContaining({
      action: "opportunity.created",
      origin: "automatico",
      who: "Automático",
      what: "Se abrió sola en «Presupuesto enviado»: Clínico presentó el presupuesto hoy",
    }),
  ])
  // En la Actividad del equipo, con su frase y el nombre de quien lo entregó.
  const activity = await f.run((tx) => listWorkspaceAudit(tx, "org_a", { action: "opportunity.created_from_budget" }))
  expect(activity.items.find((row) => row.entityId === opened.id)).toMatchObject({
    who: "Clínico",
    what: "Se abrió una oportunidad al entregar un presupuesto",
    areaLabel: "Contactos y ventas",
  })

  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [
        { planItemId: resina.id, decision: "aceptado" },
        { planItemId: endo.id, decision: "aceptado" },
      ],
    }),
  )
  expect(await f.run((tx) => getOpportunity(tx, "org_a", opened.id))).toMatchObject({
    status: "won",
    moment: "decidio",
    closeReason: "acepto_presupuesto",
    why: "Ganada: aceptó el presupuesto",
  })
  // Una nueva versión de lo ya decidido es la misma venta: no abre otra.
  const revision = await f.run((tx) =>
    reviseBudget(tx, ...f.args, budget.id, { itemIds: [resina.id, endo.id], reason: "Cambio de material" }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, revision.id))
  expect(await opportunitiesOf(f)).toHaveLength(1)
})

it("con una oportunidad abierta, el presupuesto se une a ella como siempre y no abre otra", async () => {
  const f = await clinicalFixture()
  const contactId = await personOf(f.patient.id)
  const asked = await f.run((tx) =>
    createOpportunity(tx, "org_a", { contactId, title: "Blanqueamiento" }, { userId: null, origin: "agente" }),
  )
  const item = await indicate(f, f.service.id)
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const opps = await opportunitiesOf(f)
  expect(opps.map((row) => row.id)).toEqual([asked.id])
  expect(await f.run((tx) => getOpportunity(tx, "org_a", asked.id))).toMatchObject({
    budgetId: budget.id,
    moment: "presupuesto_enviado",
    why: "Pasó sola: el equipo presentó el presupuesto hoy",
  })
})

it("reenviar no abre otra; el segundo presupuesto que espera respuesta abre la suya y la revisión sigue con la del que reemplaza", async () => {
  const f = await clinicalFixture()
  const endodoncia = await otherService("org_a", "Endodoncia", 30000)
  const first = await indicate(f, f.service.id)
  const budgetA = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [first.id] }))
  // Sale por correo: la primera vez lo entrega; la segunda solo lo reenvía.
  await ownerDb
    .update(contact)
    .set({ email: `persona-${randomUUID().slice(0, 8)}@example.com` })
    .where(eq(contact.id, await personOf(f.patient.id)))
  const [mailbox] = await ownerDb
    .insert(channelConnection)
    .values({
      organizationId: "org_a", channel: "email", provider: "gmail", displayName: "Correo de la clínica",
      externalId: `clinica-${randomUUID().slice(0, 8)}@example.com`, configEncrypted: "prueba", webhookSecret: "prueba", status: "active",
    })
    .returning({ id: channelConnection.id })
  const storage = {
    putAttachment: async ({ orgId, conversationId, bytes }: { orgId: string; conversationId: string; bytes: Uint8Array }) => ({
      objectKey: `${orgId}/${conversationId}/${randomUUID()}.pdf`,
      mimeType: "application/pdf",
      filename: "presupuesto.pdf",
      size: bytes.byteLength,
    }),
  } as unknown as Storage
  const send = () =>
    f.run((tx) =>
      sendBudget(tx, "org_a", { userId: f.actor }, { patientId: f.patient.id, budgetId: budgetA.id, requestId: randomUUID() }, { storage }),
    )
  try {
    expect((await send()).deliveredBudget).toBe(true)
    expect((await send()).deliveredBudget).toBe(false)
  } finally {
    await ownerDb.update(channelConnection).set({ status: "disabled" }).where(eq(channelConnection.id, mailbox!.id))
  }
  const [ofA, ...none] = await opportunitiesOf(f)
  expect(none).toEqual([])
  expect(ofA).toMatchObject({ budgetId: budgetA.id, moment: "presupuesto_enviado", title: "Tratamiento propio", serviceId: f.service.id })

  // Otro presupuesto mientras el primero espera respuesta: es otro interés y abre el suyo.
  const second = await indicate(f, endodoncia)
  const budgetB = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [second.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budgetB.id))
  const afterB = await opportunitiesOf(f)
  expect(afterB).toHaveLength(2)
  const ofB = afterB.find((row) => row.id !== ofA!.id)!
  expect(ofB).toMatchObject({ budgetId: budgetB.id, title: "Endodoncia", serviceId: endodoncia, amountCents: 30000 })
  expect(afterB.find((row) => row.id === ofA!.id)).toMatchObject({ budgetId: budgetA.id })

  // La nueva versión del primero sigue con su oportunidad, sin abrir otra.
  const revision = await f.run((tx) => reviseBudget(tx, ...f.args, budgetA.id, { itemIds: [first.id], reason: "Ajuste del plan" }))
  await f.run((tx) => deliverBudget(tx, ...f.args, revision.id))
  const afterRevision = await opportunitiesOf(f)
  expect(afterRevision).toHaveLength(2)
  expect(afterRevision.find((row) => row.id === ofA!.id)).toMatchObject({ budgetId: revision.id, moment: "presupuesto_enviado" })

  // Rechazar el segundo pierde solo la suya.
  await f.run((tx) => decideBudget(tx, ...f.args, budgetB.id, { decisions: [{ planItemId: second.id, decision: "rechazado" }] }))
  expect(await f.run((tx) => getOpportunity(tx, "org_a", ofB.id))).toMatchObject({ status: "lost", closeReason: "rechazo_presupuesto" })
  expect(await f.run((tx) => getOpportunity(tx, "org_a", ofA!.id))).toMatchObject({ status: "open", moment: "presupuesto_enviado" })
})

it("en latidIA, igual: el presupuesto entregado abre su oportunidad y rechazarlo la lleva a «Decidió»", async () => {
  await ownerDb.update(orgProfile).set({ product: "medical" }).where(eq(orgProfile.organizationId, "org_b"))
  const f = await clinicalFixture("org_b")
  const item = await indicate(f, f.service.id)
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const [only, ...rest] = await opportunitiesOf(f)
  expect(rest).toEqual([])
  expect(only).toMatchObject({
    contactId: await personOf(f.patient.id),
    budgetId: budget.id,
    title: "Tratamiento propio",
    moment: "presupuesto_enviado",
    why: "Se abrió sola: Clínico presentó el presupuesto hoy",
  })
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "rechazado" }] }))
  expect(await f.run((tx) => getOpportunity(tx, "org_b", only!.id))).toMatchObject({
    status: "lost",
    moment: "decidio",
    closeReason: "rechazo_presupuesto",
  })
})

/** Entrega un presupuesto con esos tratamientos y devuelve el presupuesto, sus tratamientos y su oportunidad. */
async function delivered(f: Fixture, serviceIds: string[]) {
  const items: Array<Awaited<ReturnType<typeof indicate>>> = []
  for (const serviceId of serviceIds) items.push(await indicate(f, serviceId))
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: items.map((item) => item.id) }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const opp = (await opportunitiesOf(f)).find((row) => row.budgetId === budget.id)
  return { budget, items, opp }
}

it("la revisión de un presupuesto ya ganado no toma otra oportunidad abierta ni la gana: la venta cuenta una vez", async () => {
  const f = await clinicalFixture()
  const { budget, items, opp } = await delivered(f, [f.service.id])
  const item = items[0]!
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  const person = await personOf(f.patient.id)
  const asked = await f.run((tx) =>
    createOpportunity(tx, "org_a", { contactId: person, title: "Blanqueamiento" }, { userId: null, origin: "agente" }),
  )
  const revision = await f.run((tx) => reviseBudget(tx, ...f.args, budget.id, { itemIds: [item.id], reason: "Cambio" }))
  await f.run((tx) => deliverBudget(tx, ...f.args, revision.id))
  expect(await f.run((tx) => getOpportunity(tx, "org_a", asked.id))).toMatchObject({ budgetId: null, moment: "interesado" })
  await f.run((tx) => decideBudget(tx, ...f.args, revision.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  const all = await opportunitiesOf(f, { contactId: person })
  expect(all.filter((row) => row.status === "won").map((row) => row.id)).toEqual([opp!.id])
  expect(all.find((row) => row.id === asked.id)).toMatchObject({ status: "open", moment: "interesado" })
})

it("anular el presupuesto cierra como perdida la oportunidad que nació de él; la de otro interés o con una tarea solo se suelta", async () => {
  // Nació de él y nadie la trabajó: perdida, «Otro», a nombre de quien lo anuló.
  const f = await clinicalFixture()
  const { budget, opp } = await delivered(f, [f.service.id])
  await f.run((tx) => cancelBudget(tx, ...f.args, budget.id))
  expect(await f.run((tx) => getOpportunity(tx, "org_a", opp!.id))).toMatchObject({
    status: "lost",
    moment: "decidio",
    closeReason: "otro",
    closeNote: "Se anuló el presupuesto",
  })
  const activity = await f.run((tx) => listWorkspaceAudit(tx, "org_a", { action: "opportunity.closed_budget_cancelled" }))
  expect(activity.items.find((row) => row.entityId === opp!.id)).toMatchObject({
    who: "Clínico",
    what: "Se cerró una oportunidad al anular su presupuesto",
  })

  // La que ya era de otro interés sigue abierta, sin presupuesto, y ya no promete cerrarse sola.
  const g = await clinicalFixture()
  const gPerson = await personOf(g.patient.id)
  const asked = await g.run((tx) =>
    createOpportunity(tx, "org_a", { contactId: gPerson, title: "Blanqueamiento" }, { userId: null, origin: "agente" }),
  )
  const joined = await delivered(g, [g.service.id])
  expect(joined.opp?.id).toBe(asked.id)
  await g.run((tx) => cancelBudget(tx, ...g.args, joined.budget.id))
  expect(await g.run((tx) => getOpportunity(tx, "org_a", asked.id))).toMatchObject({
    status: "open",
    budgetId: null,
    moment: "presupuesto_enviado",
    after: null,
  })

  // La que nació de él pero ya tiene una tarea: alguien la trabaja, solo se suelta.
  const h = await clinicalFixture()
  const worked = await delivered(h, [h.service.id])
  await h.run((tx) =>
    setOpportunityTask(tx, "org_a", worked.opp!.id, { title: "Llamar a ver qué decidió" }, { userId: h.actor, createdBy: "user" }),
  )
  await h.run((tx) => cancelBudget(tx, ...h.args, worked.budget.id))
  expect(await h.run((tx) => getOpportunity(tx, "org_a", worked.opp!.id))).toMatchObject({ status: "open", budgetId: null })
})

it("Sofi no duplica la venta: lo que pregunta la persona por un tratamiento de su presupuesto pendiente actualiza esa oportunidad", async () => {
  const f = await clinicalFixture()
  const endodoncia = await otherService("org_a", "Endodoncia", 30000)
  const { opp } = await delivered(f, [f.service.id, endodoncia])
  const person = await personOf(f.patient.id)
  const noted = await f.run((tx) =>
    noteServiceInterest(tx, "org_a", { contactId: person, conversationId: null, serviceId: endodoncia, said: "¿Cuánto es la endodoncia?" }),
  )
  expect(noted).toEqual({ outcome: "actualizada", opportunityId: opp!.id })
  expect((await opportunitiesOf(f, { contactId: person })).filter((row) => row.status === "open")).toHaveLength(1)
  // Crearla sin paciente (el equipo, o el agente con «crear oportunidad») encuentra la que ya existe.
  await expect(
    f.run((tx) => createOpportunity(tx, "org_a", { contactId: person, title: "Endodoncia", serviceId: endodoncia })),
  ).rejects.toMatchObject({ code: "OPPORTUNITY_EXISTS" })
})

it("menor: el presupuesto se une a lo que anotó su madre del mismo tratamiento, que pasa a llevarlo; de otro tratamiento, no", async () => {
  const f = await clinicalFixture()
  const [mother] = await ownerDb.insert(contact).values({ organizationId: "org_a", displayName: "Mamá de prueba" }).returning({ id: contact.id })
  await ownerDb.insert(patientContact).values({ organizationId: "org_a", patientId: f.patient.id, contactId: mother!.id, relationship: "guardian" })
  const asked = await f.run((tx) =>
    noteServiceInterest(tx, "org_a", { contactId: mother!.id, conversationId: null, serviceId: f.service.id, said: "Para mi hijo" }),
  )
  expect(asked.outcome).toBe("creada")
  const { budget, items, opp } = await delivered(f, [f.service.id])
  expect(opp).toMatchObject({ id: asked.opportunityId, contactId: mother!.id, patientId: f.patient.id, moment: "presupuesto_enviado" })
  expect(await opportunitiesOf(f)).toHaveLength(1)
  // Lo que vuelve a preguntar la madre sigue con la misma.
  const again = await f.run((tx) =>
    noteServiceInterest(tx, "org_a", { contactId: mother!.id, conversationId: null, serviceId: f.service.id, said: "¿Ya está?" }),
  )
  expect(again).toEqual({ outcome: "actualizada", opportunityId: opp!.id })
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: items[0]!.id, decision: "aceptado" }] }))
  expect(await f.run((tx) => getOpportunity(tx, "org_a", opp!.id))).toMatchObject({ status: "won" })

  // Lo que la madre anotó de otro tratamiento no se toma como «la más reciente».
  const g = await clinicalFixture()
  const [other] = await ownerDb.insert(contact).values({ organizationId: "org_a", displayName: "Otra mamá" }).returning({ id: contact.id })
  await ownerDb.insert(patientContact).values({ organizationId: "org_a", patientId: g.patient.id, contactId: other!.id, relationship: "guardian" })
  const blanqueamiento = await otherService("org_a", "Blanqueamiento", 50000)
  const hers = await g.run((tx) =>
    noteServiceInterest(tx, "org_a", { contactId: other!.id, conversationId: null, serviceId: blanqueamiento, said: "Para mí" }),
  )
  const child = await delivered(g, [g.service.id])
  expect(child.opp).toMatchObject({ contactId: await personOf(g.patient.id) })
  expect(await g.run((tx) => getOpportunity(tx, "org_a", hers.opportunityId!))).toMatchObject({ moment: "interesado", patientId: null })
})

it("al decidir, la que nació del presupuesto se llama como la opción elegida", async () => {
  const f = await clinicalFixture()
  const endodoncia = await otherService("org_a", "Endodoncia", 30000)
  const resina = await indicate(f, f.service.id)
  const endo = await indicate(f, endodoncia)
  const draft = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [resina.id, endo.id] }))
  const two = await f.run((tx) => duplicateBudgetOption(tx, ...f.args, draft.id, draft.options[0]!.id))
  const second = two.options.find((option) => option.id !== draft.options[0]!.id)!
  await f.run((tx) => removeBudgetItems(tx, ...f.args, draft.id, { itemIds: [endo.id], optionId: second.id }))
  await f.run((tx) => deliverBudget(tx, ...f.args, draft.id))
  const [opp] = await opportunitiesOf(f)
  expect(opp!.title).toBe("Tratamiento propio y Endodoncia")
  await f.run((tx) =>
    decideBudget(tx, ...f.args, draft.id, { optionId: second.id, decisions: [{ planItemId: resina.id, decision: "aceptado" }] }),
  )
  expect(await f.run((tx) => getOpportunity(tx, "org_a", opp!.id))).toMatchObject({ status: "won", title: "Tratamiento propio" })
})

it("imprimir y enviar a la vez el mismo borrador abre una sola oportunidad", async () => {
  const f = await clinicalFixture()
  const item = await indicate(f, f.service.id)
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  const results = await Promise.allSettled([
    f.run((tx) => deliverBudget(tx, ...f.args, budget.id)),
    f.run((tx) => deliverBudget(tx, ...f.args, budget.id)),
  ])
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(await opportunitiesOf(f)).toHaveLength(1)
})

it("pasados 30 días de su vigencia sin respuesta se cierra sola «No responde»; si responde después, se reabre y se decide; lo que alguien trabaja o no vence, no", async () => {
  const f = await clinicalFixture()
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  /** Un presupuesto entregado con la vigencia que se diga (la vigencia se fija en el borrador). */
  const deliveredUntil = async (validUntil: string) => {
    const item = await indicate(f, f.service.id)
    const draft = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
    await ownerDb.update(treatmentBudget).set({ validUntil }).where(eq(treatmentBudget.id, draft.id))
    await f.run((tx) => deliverBudget(tx, ...f.args, draft.id))
    const opp = (await opportunitiesOf(f)).find((row) => row.budgetId === draft.id)!
    return { budget: draft, item, opp }
  }
  const expired = await deliveredUntil(daysAgo(40))
  const recent = await deliveredUntil(daysAgo(20))
  const withTask = await deliveredUntil(daysAgo(40))
  await f.run((tx) =>
    setOpportunityTask(tx, "org_a", withTask.opp.id, { title: "Llamarla" }, { userId: f.actor, createdBy: "user" }),
  )
  const taken = await deliveredUntil(daysAgo(40))
  await f.run((tx) => updateOpportunity(tx, "org_a", taken.opp.id, { assignedUserId: f.actor }, { userId: f.actor }))
  // Un presupuesto de antes, sin vigencia, no vence (hoy toda entrega la fija).
  const timeless = await deliveredUntil(daysAgo(40))
  await ownerDb.transaction(async (owner) => {
    await owner.execute(sql`set local session_replication_role = replica`)
    await owner.update(treatmentBudget).set({ validUntil: null }).where(eq(treatmentBudget.id, timeless.budget.id))
  })

  expect(await f.run((tx) => closeUnansweredBudgetOpportunities(tx, "org_a", new Date()))).toBe(1)
  expect(await f.run((tx) => closeUnansweredBudgetOpportunities(tx, "org_a", new Date()))).toBe(0)
  expect(await f.run((tx) => getOpportunity(tx, "org_a", expired.opp.id))).toMatchObject({
    status: "lost",
    moment: "decidio",
    closeReason: "no_responde",
    why: "Perdida: «No responde»",
  })
  for (const kept of [recent, withTask, taken, timeless]) {
    expect(await f.run((tx) => getOpportunity(tx, "org_a", kept.opp.id))).toMatchObject({ status: "open", moment: "presupuesto_enviado" })
  }
  const activity = await f.run((tx) => listWorkspaceAudit(tx, "org_a", { action: "opportunity.closed_budget_expired" }))
  expect(activity.items.find((row) => row.entityId === expired.opp.id)).toMatchObject({
    who: "Automático",
    what: "Se cerró una oportunidad: su presupuesto venció sin respuesta",
  })

  // Responde después: se reabre y se decide con la regla de siempre.
  await f.run((tx) =>
    decideBudget(tx, ...f.args, expired.budget.id, { decisions: [{ planItemId: expired.item.id, decision: "aceptado" }] }),
  )
  const won = await f.run((tx) => getOpportunity(tx, "org_a", expired.opp.id))
  expect(won).toMatchObject({ status: "won", closeReason: "acepto_presupuesto" })
  expect(won.history.map((row) => row.action)).toEqual(
    expect.arrayContaining(["opportunity.lost", "opportunity.reopened", "opportunity.won"]),
  )
})
