/**
 * «Se debe validar que el número exista y se haya entregado» (27 nov): el presupuesto enviado
 * por WhatsApp quedaba «Entregado el 27 nov» apenas el mensaje entraba en la cola, aunque
 * WhatsApp no lo entregara (número sin WhatsApp, mal escrito). Lo que se dice de la entrega
 * sigue el estado del mensaje que informa el proveedor; el presupuesto sigue presentado.
 */
import { randomUUID } from "node:crypto"
import { type NormalizedStatus, whatsappCloudApiAdapter } from "@odentia/channels"
import { channelConnection, contactIdentity, conversation, message } from "@odentia/db/schema/crm"
import { and, eq, sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { auditEvent } from "@odentia/db/schema/org"
import { getAgentPatientBudgets } from "./agent-operations.js"
import { previewMessageRoute } from "./automation-routing.js"
import { BUDGET_READY_MESSAGE_KEY } from "./automation-messages.js"
import { budgetDeliveries, budgetDeliveryOf, budgetNotReachedSql, type BudgetSendFact } from "./budget-delivery.js"
import { previewBudgetSend, sendBudget } from "./budget-send.js"
import { createBudget, deliverBudget, getBudgetDetail } from "./budgets.js"
import { currentCatalogMessage } from "./clinic-messages.js"
import { createConsentDocument, createConsentTemplate, listConsentDocuments, markConsentSentByLink, publishConsentTemplate } from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { applyStatus } from "./conversations.js"
import { addPlanItem } from "./plan.js"
import { getPlanNextSteps } from "./plan-next.js"
import { lastHealthDocumentSend } from "./health-documents.js"
import { createPatient, patientPersonId } from "./patients.js"
import { configurePublicLinks } from "./public-links.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { sendConsentToSign } from "./su-enlace.js"
import type { Storage } from "./storage.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const ORG = "org_a"
const KEY = secretsKeyFromEnv("cd".repeat(32))
const ZONE = { locale: "es-PE", timezone: "America/Lima" }
const SENT_AT = new Date("2026-11-27T15:00:00Z")

/** El aviso de estado tal como lo manda Meta, leído por el mismo adaptador que el webhook. */
function metaStatus(externalId: string, status: "delivered" | "read" | "failed", code?: number): NormalizedStatus[] {
  const rawBody = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "waba",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: "numero" },
          statuses: [{ id: externalId, status, timestamp: "1764255600", ...(code ? { errors: [{ code, title: "Error" }] } : {}) }],
        },
      }],
    }],
  })
  return whatsappCloudApiAdapter.parseWebhook({ headers: {}, rawBody, config: {} }).statuses
}

const send = (over: Partial<BudgetSendFact>): BudgetSendFact => ({
  at: SENT_AT,
  channel: "whatsapp",
  deliveredBudget: true,
  messageStatus: "sent",
  error: null,
  ...over,
})

describe("lo que se dice de la entrega, sin base", () => {
  const presented = { presentedAt: SENT_AT }

  it("mientras WhatsApp no confirma, «Enviado»; con su acuse, «Entregado» o «Leído»", () => {
    expect(budgetDeliveryOf(presented, [send({ messageStatus: "queued" })], ZONE)).toMatchObject({
      state: "enviado",
      text: "Enviado por WhatsApp el 27 nov",
      label: "Enviado · espera respuesta",
      reached: true,
      problem: null,
    })
    expect(budgetDeliveryOf(presented, [send({ messageStatus: "sent" })], ZONE)?.text).toBe("Enviado por WhatsApp el 27 nov")
    expect(budgetDeliveryOf(presented, [send({ messageStatus: "delivered" })], ZONE)).toMatchObject({
      state: "entregado",
      text: "Entregado por WhatsApp · enviado el 27 nov",
      label: "Entregado · espera respuesta",
    })
    expect(budgetDeliveryOf(presented, [send({ messageStatus: "read" })], ZONE)?.text).toBe("Leído por WhatsApp · enviado el 27 nov")
  })

  it("un número sin WhatsApp (131026): «No llegó», por qué y qué hacer", () => {
    const [failed] = metaStatus("wamid.x", "failed", 131026)
    const delivery = budgetDeliveryOf(presented, [send({ messageStatus: "failed", error: failed!.error ?? null })], ZONE)
    expect(delivery).toMatchObject({ state: "no_llego", reached: false, label: "No le llegó", text: "No llegó por WhatsApp · enviado el 27 nov" })
    expect(delivery?.problem).toMatch(/^Su número no tiene WhatsApp, está mal escrito o no recibe mensajes de la clínica\. Corrige su número/)
    expect(delivery?.problem).toContain("vuelve a enviarlo desde su presupuesto, o imprímelo y entrégaselo")
  })

  it("la clave falsa de una demo (190) sale como «No llegó» y no como «Entregado»", () => {
    const delivery = budgetDeliveryOf(
      presented,
      [send({
        messageStatus: "failed",
        error: "WhatsApp no envió el mensaje porque la conexión con Meta venció o fue retirada. Vuelve a conectar con Facebook en Configuración › Integraciones › WhatsApp.",
      })],
      ZONE,
    )
    expect(delivery).toMatchObject({ state: "no_llego", reached: false, label: "No le llegó" })
    expect(delivery?.problem).toMatch(/^El WhatsApp de la clínica no pudo enviarlo \(la conexión con Meta venció o fue retirada/)
  })

  it("lo entregado en mano dice su fecha y ya le llegó, aunque después un envío falle", () => {
    expect(budgetDeliveryOf(presented, [], ZONE)).toMatchObject({ state: "en_mano", text: "Entregado el 27 nov", reached: true })
    const later = budgetDeliveryOf(presented, [send({ deliveredBudget: false, messageStatus: "failed", error: null })], ZONE)
    expect(later).toMatchObject({ state: "no_llego", reached: true, label: "Entregado · espera respuesta" })
  })

  it("por correo no hay acuse: «Enviado por correo», nunca «Entregado»", () => {
    expect(budgetDeliveryOf(presented, [send({ channel: "email", messageStatus: "sent" })], ZONE)).toMatchObject({
      state: "enviado",
      text: "Enviado por correo el 27 nov",
    })
  })

  it("un reenvío que salió ya no deja «No le llegó»", () => {
    const delivery = budgetDeliveryOf(presented, [send({ messageStatus: "failed" }), send({ deliveredBudget: false, messageStatus: "delivered" })], ZONE)
    expect(delivery).toMatchObject({ state: "entregado", reached: true })
    // Y si el que llegó es el anterior, lo tiene: el reenvío que falla no dice «Enviado».
    const resent = budgetDeliveryOf(presented, [send({ messageStatus: "read" }), send({ deliveredBudget: false, messageStatus: "failed" })], ZONE)
    expect(resent).toMatchObject({ state: "no_llego", reached: true, label: "Entregado · espera respuesta" })
  })
})

const storage = {
  putAttachment: async ({ orgId, conversationId, bytes }: { orgId: string; conversationId: string; bytes: Uint8Array }) => ({
    objectKey: `${orgId}/${conversationId}/${randomUUID()}.pdf`,
    mimeType: "application/pdf",
    filename: "presupuesto.pdf",
    size: bytes.byteLength,
  }),
} as unknown as Storage

/** El WhatsApp de la clínica (uno solo por clínica) y el de la persona; `wrote`: cuándo escribió. */
async function whatsappOf(contactId: string, digits: string, wrote: Date | null) {
  const [existing] = await ownerDb
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(and(eq(channelConnection.organizationId, ORG), eq(channelConnection.channel, "whatsapp"), eq(channelConnection.status, "active")))
  const [connection] = existing
    ? [existing]
    : await ownerDb
        .insert(channelConnection)
        .values({
          organizationId: ORG, channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA",
          externalId: `wa-${randomUUID().slice(0, 8)}`, configEncrypted: "prueba", webhookSecret: "prueba", status: "active",
        })
        .returning({ id: channelConnection.id })
  const [identity] = await ownerDb
    .insert(contactIdentity)
    .values({ organizationId: ORG, contactId, channel: "whatsapp", externalUserId: digits, isPrimary: true })
    .returning({ id: contactIdentity.id })
  await ownerDb.insert(conversation).values({
    organizationId: ORG, contactId, contactIdentityId: identity!.id, channelConnectionId: connection!.id,
    externalThreadId: digits, lastInboundAt: wrote,
  })
}

const celular = () => `519${randomUUID().replace(/\D/g, "").padEnd(8, "0").slice(0, 8)}`
const all = () => true

it("enviado por WhatsApp y rechazado: la ficha dice «No le llegó», por qué y qué hacer; el presupuesto sigue presentado", async () => {
  const f = await clinicalFixture()
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  await whatsappOf(personId, celular(), new Date())
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  const sent = await f.run((tx) =>
    sendBudget(tx, ORG, { userId: f.actor }, { patientId: f.patient.id, budgetId: budget.id, requestId: randomUUID() }, { storage }),
  )
  expect(sent).toMatchObject({ channel: "whatsapp", deliveredBudget: true })

  // En la cola: enviado, no entregado.
  const queued = await f.run((tx) => getBudgetDetail(tx, ORG, f.patient.id, budget.id))
  expect(queued.status).toBe("presentado")
  expect(queued.delivery).toMatchObject({ state: "enviado", label: "Enviado · espera respuesta", reached: true })
  const pending = (await f.run((tx) => getPlanNextSteps(tx, ORG, f.patient.id, all))).steps.find((step) => step.kind === "respuesta")
  expect(pending?.text).toBe("Enviado · espera respuesta")
  expect(pending?.detail).toContain("Enviado por WhatsApp el ")
  expect(pending?.detail).not.toContain("Entregado")

  // Meta lo acepta y después avisa que no lo pudo entregar (131026).
  const wamid = `wamid.${randomUUID()}`
  await ownerDb.update(message).set({ status: "sent", externalId: wamid }).where(eq(message.id, sent.messageId))
  await f.run((tx) => applyStatus(tx, ORG, metaStatus(wamid, "failed", 131026)))

  const failed = await f.run((tx) => getBudgetDetail(tx, ORG, f.patient.id, budget.id))
  // La decisión de la clínica no cambia: sigue presentado, con su fecha y su vigencia.
  expect(failed).toMatchObject({ status: "presentado", awaitsAnswer: true, stateText: "Entregado · espera respuesta" })
  expect(failed.presentedAt).not.toBeNull()
  expect(failed.delivery).toMatchObject({ state: "no_llego", reached: false, label: "No le llegó" })
  const step = (await f.run((tx) => getPlanNextSteps(tx, ORG, f.patient.id, all))).steps.find((row) => row.kind === "respuesta")
  expect(step?.text).toBe("No le llegó")
  expect(step?.detail).toContain("No llegó por WhatsApp · enviado el ")
  expect(step?.detail).toContain("Su número no tiene WhatsApp, está mal escrito o no recibe mensajes de la clínica")
  expect(step?.detail).not.toContain("Entregado")

  // La misma regla en SQL: lo que no le llegó no se cuenta como recibido ni lo sigue Sofi.
  const [inSql] = await f.run((tx) =>
    tx.execute<{ unreached: boolean }>(sql`select ${budgetNotReachedSql(ORG, sql`${budget.id}`)} as unreached`),
  )
  expect(inSql?.unreached).toBe(true)
})

it("entregado en mano, «Entregado el…»; con el acuse de WhatsApp, «Entregado por WhatsApp»; la regla en SQL coincide", async () => {
  const f = await clinicalFixture()
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  await whatsappOf(personId, celular(), new Date())
  const first = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const handed = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [first.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, handed.id))
  const second = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const viaWhatsApp = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [second.id] }))
  const sent = await f.run((tx) =>
    sendBudget(tx, ORG, { userId: f.actor }, { patientId: f.patient.id, budgetId: viaWhatsApp.id, requestId: randomUUID() }, { storage }),
  )
  const wamid = `wamid.${randomUUID()}`
  await ownerDb.update(message).set({ status: "sent", externalId: wamid }).where(eq(message.id, sent.messageId))
  await f.run((tx) => applyStatus(tx, ORG, metaStatus(wamid, "delivered")))

  const deliveries = await f.run(async (tx) =>
    budgetDeliveries(tx, ORG, [
      await getBudgetDetail(tx, ORG, f.patient.id, handed.id),
      await getBudgetDetail(tx, ORG, f.patient.id, viaWhatsApp.id),
    ]),
  )
  expect(deliveries.get(handed.id)).toMatchObject({ state: "en_mano", reached: true })
  expect(deliveries.get(handed.id)?.text).toMatch(/^Entregado el \d+ \w+/)
  expect(deliveries.get(viaWhatsApp.id)).toMatchObject({ state: "entregado", reached: true, label: "Entregado · espera respuesta" })
  for (const id of [handed.id, viaWhatsApp.id]) {
    const [row] = await f.run((tx) => tx.execute<{ unreached: boolean }>(sql`select ${budgetNotReachedSql(ORG, sql`${id}`)} as unreached`))
    expect(row?.unreached, id).toBe(false)
  }
})

it("antes de enviar: un WhatsApp que no puede ser un número real no se usa, y se dice por qué donde se envía", async () => {
  const f = await clinicalFixture()
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  // Un celular de Perú con un dígito de menos, guardado como su WhatsApp, y no escribió en 24 horas.
  await whatsappOf(personId, "5199215437", null)
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  const spec = await f.run((tx) => currentCatalogMessage(tx, ORG, BUDGET_READY_MESSAGE_KEY))
  const route = await f.run((tx) => previewMessageRoute(tx, ORG, personId, spec))
  expect(route).toEqual({
    cause: "sin_destino",
    detail: "No tiene correo registrado y su WhatsApp (+5199215437) no puede ser un número real: revisa que sea un celular de 9 dígitos",
  })
  const preview = await f.run((tx) => previewBudgetSend(tx, ORG, f.patient.id, budget.id))
  expect(preview.channel).toBeNull()
  expect(preview.blocked).toContain("no puede ser un número real")
})

/** Un mensaje que salió hacia la persona y WhatsApp rechazó con 131026, como lo deja el aviso de Meta. */
async function rejectedMessage(f: Awaited<ReturnType<typeof clinicalFixture>>, messageId: string) {
  const wamid = `wamid.${randomUUID()}`
  await ownerDb.update(message).set({ status: "sent", externalId: wamid }).where(eq(message.id, messageId))
  await f.run((tx) => applyStatus(tx, ORG, metaStatus(wamid, "failed", 131026)))
}

it("Sofi no recibe «Entregado» de lo que no le llegó: recibe que no le llegó y por qué", async () => {
  const f = await clinicalFixture()
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  await whatsappOf(personId, celular(), new Date())
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  const sent = await f.run((tx) =>
    sendBudget(tx, ORG, { userId: f.actor }, { patientId: f.patient.id, budgetId: budget.id, requestId: randomUUID() }, { storage }),
  )
  await rejectedMessage(f, sent.messageId)
  const found = await f.run((tx) => getAgentPatientBudgets(tx, ORG, personId, f.patient.id))
  const view = found.budgets.find((row) => row.budgetId === budget.id)
  expect(view?.stateText).toBe("No le llegó")
  expect(view?.notReached).toMatch(/^No llegó por WhatsApp · enviado el .+\. Su número no tiene WhatsApp, está mal escrito o no recibe mensajes de la clínica\.$/)
  // Lo que Sofi recibe es lo que la persona tiene: sin lo que hace la clínica.
  expect(view?.notReached).not.toContain("Corrige su número")
})

it("la receta enviada dice lo que pasó con su mensaje: «No llegó» con el motivo, no «Ya se le envió»", async () => {
  const f = await clinicalFixture()
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  await whatsappOf(personId, celular(), new Date())
  const [thread] = await ownerDb.select({ id: conversation.id }).from(conversation).where(eq(conversation.contactId, personId))
  const [sentMessage] = await ownerDb
    .insert(message)
    .values({ organizationId: ORG, conversationId: thread!.id, direction: "out", senderKind: "user", body: "Tu receta", status: "queued" })
    .returning({ id: message.id })
  const prescriptionId = randomUUID()
  await ownerDb.insert(auditEvent).values({
    organizationId: ORG,
    actorUserId: f.actor,
    action: "health_document.sent",
    entity: "message",
    entityId: sentMessage!.id,
    metadata: { patientId: f.patient.id, documentType: "prescription", documentId: prescriptionId, recipientName: "Paciente de prueba", channel: "whatsapp" },
  })
  const last = () => f.run((tx) => lastHealthDocumentSend(tx, ORG, f.patient.id, { documentType: "prescription", documentId: prescriptionId }))
  expect((await last())?.delivery).toMatchObject({ state: "enviado", text: expect.stringMatching(/^Enviado por WhatsApp el /) })
  await rejectedMessage(f, sentMessage!.id)
  const failed = (await last())?.delivery
  expect(failed).toMatchObject({ state: "no_llego", reason: "Su número no tiene WhatsApp, está mal escrito o no recibe mensajes de la clínica." })
  expect(failed?.text).toMatch(/^No llegó por WhatsApp · enviado el /)
  expect(failed?.problem).toContain("vuelve a enviarla desde sus documentos, o imprímela y entrégasela")
})

it("el consentimiento enviado a firmar dice «No llegó» con qué hacer, no «Lo tiene en su enlace»", async () => {
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
  try {
    const f = await clinicalFixture()
    const digits = randomUUID().replace(/\D/g, "").padEnd(16, "0")
    const ana = await f.run((tx) =>
      createPatient(tx, ORG, f.actor, { displayName: "Ana Soto", givenNames: "Ana", familyName: "Soto", birthDate: "1990-01-01", docType: "DNI", docNumber: digits.slice(0, 8) }),
    )
    const personId = (await f.run((tx) => patientPersonId(tx, ORG, ana.id)))!
    await whatsappOf(personId, `519${digits.slice(8, 16)}`, new Date())
    const draft = await f.run((tx) =>
      createConsentTemplate(tx, ORG, f.actor, {
        key: `t-${randomUUID().slice(0, 8)}`,
        title: "Exodoncia",
        sections: { procedure: "Extracción con anestesia local.", benefits: ["Quitar el dolor"], risks: ["Sangrado"], alternatives: ["Endodoncia"], consequences: "Puede avanzar." },
      }),
    )
    const template = await f.run((tx) => publishConsentTemplate(tx, ORG, f.actor, draft.id))
    const consent = await f.run((tx) => createConsentDocument(tx, ORG, f.actor, { templateId: template.id, patientId: ana.id, procedureRef: "Exodoncia de la pieza 38" }))
    const sent = await f.run(async (tx) => {
      await markConsentSentByLink(tx, ORG, f.actor, consent.id)
      return sendConsentToSign(tx, ORG, f.actor, { patientId: ana.id, consentId: consent.id }, { secretsKey: KEY })
    })
    const delivery = async () => (await f.run((tx) => listConsentDocuments(tx, ORG, { patientId: ana.id }))).find((row) => row.id === consent.id)?.linkDelivery
    expect(await delivery()).toMatchObject({ state: "enviado" })
    await rejectedMessage(f, sent.messageId)
    const failed = await delivery()
    expect(failed).toMatchObject({ state: "no_llego", text: expect.stringMatching(/^No llegó por WhatsApp · enviado el /) })
    expect(failed?.problem).toContain("Corrige su número en sus Datos y vuelve a enviárselo con «Enviarlo por mensaje»")
  } finally {
    configurePublicLinks(null)
  }
})
