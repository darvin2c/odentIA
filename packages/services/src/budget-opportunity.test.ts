/**
 * El presupuesto entregado también abre su oportunidad (ADR 0144, precisa la
 * 0028): sin ninguna abierta que le corresponda, nace en «Presupuesto
 * enviado», unida a él y a nombre de quien lo entregó; reenviarlo no abre
 * otra, con una abierta se une como siempre, el segundo que espera respuesta
 * abre la suya y la revisión sigue con la del que reemplaza. Igual en latidIA.
 */
import { randomUUID } from "node:crypto"
import { patient, serviceCatalog } from "@odentia/db/schema/clinical"
import { channelConnection, contact } from "@odentia/db/schema/crm"
import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { sendBudget } from "./budget-send.js"
import { createBudget, decideBudget, deliverBudget, reviseBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createOpportunity, getOpportunity, listOpportunities } from "./opportunities.js"
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

const opportunitiesOf = async (f: Fixture) =>
  (await f.run((tx) => listOpportunities(tx, f.args[0], { patientId: f.patient.id }))).items

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
