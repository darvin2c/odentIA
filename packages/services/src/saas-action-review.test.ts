import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { supportCase, supportMessage } from "@odentia/db/schema/admin-support"
import { member, user } from "@odentia/db/schema/auth"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { saasAction, saasActionReview, saasCharge, saasChargeLine, saasCommercialTerms, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, asc, eq } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { currentSaasPeriod, listPeriodActions } from "./saas-actions.js"
import { decideActionReview, readReviewConversation, requestActionReview } from "./saas-action-review.js"
import { createSaasPlan } from "./saas-billing.js"
import { SAAS_TERMS_INITIAL } from "./saas-commercial-terms.js"
import { addMonth, closeSaasPeriods } from "./saas-invoicing.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * «Pedir revisión» de lo que se cobró (issue 77, ADR 0054): el spam se devuelve
 * solo hasta el 10 %, lo demás lo decide odentIA con su respuesta, solo este
 * mes y el anterior, y lo ya cobrado vuelve en el cargo siguiente.
 */
setupTestDb()

const STAFF = { userId: "review-staff", role: "admin" as const }
let planId = ""

beforeAll(async () => {
  await ownerDb.insert(user).values({ id: STAFF.userId, name: "Marco", email: "marco@odentia.test" })
  await ownerDb.update(saasPlan).set({ isDefault: false })
  const plan = await createSaasPlan(ownerDb, STAFF.userId, {
    code: "rev-odentia",
    name: "Plan odentIA",
    currency: "USD",
    priceCents: 2900,
    creditCents: 2900,
    conversationMicros: 500_000,
    consultationMicros: 400_000,
    recoveryMicros: 4_000_000,
    trialCreditCents: 5000,
    trialMaxCreditCents: 13000,
    isDefault: true,
  })
  planId = plan.id
})

/** Una clínica con plan activo; su mes va de hace 10 días a dentro de 20, salvo que se diga otro. */
async function clinic(over: Partial<typeof saasSubscription.$inferInsert> = {}) {
  const orgId = `rev-${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  const start = new Date(Date.now() - 10 * 86_400_000)
  const values = { status: "activa", planId, activatedAt: start, currentPeriodStart: start, currentPeriodEnd: new Date(start.getTime() + 30 * 86_400_000), ...over }
  await ownerDb.insert(saasSubscription).values({ organizationId: orgId, ...values }).onConflictDoUpdate({ target: saasSubscription.organizationId, set: values })
  const owner = randomUUID()
  await ownerDb.insert(user).values({ id: owner, name: "Jorge", email: `${owner}@rev.test` })
  await ownerDb.insert(member).values({ id: randomUUID(), userId: owner, organizationId: orgId, role: "owner", createdAt: new Date() })
  return { orgId, actor: { userId: owner, roleLabel: "Dueño" } }
}

/** Una conversación cobrada de una persona nueva, en `at`; con `thread`, también su hilo con un mensaje. */
async function conversationAction(orgId: string, at: Date, micros = 500_000, thread = false): Promise<{ id: string; contactId: string }> {
  const [person] = await ownerDb.insert(contact).values({ organizationId: orgId, displayName: `Persona ${randomUUID().slice(0, 4)}` }).returning({ id: contact.id })
  let conversationId: string | null = null
  if (thread) {
    const [connection] = await ownerDb
      .insert(channelConnection)
      .values({ organizationId: orgId, channel: "telegram", provider: "telegram_bot_api", displayName: "Bot", configEncrypted: "c", webhookSecret: randomUUID(), status: "active" })
      .returning({ id: channelConnection.id })
    const [row] = await ownerDb
      .insert(conversation)
      .values({ organizationId: orgId, contactId: person!.id, channelConnectionId: connection!.id, externalThreadId: `tg:${randomUUID()}` })
      .returning({ id: conversation.id })
    conversationId = row!.id
    await ownerDb.insert(message).values({ organizationId: orgId, conversationId, direction: "inbound", senderKind: "contact", body: "¿Atienden los domingos?" })
  }
  const [row] = await ownerDb
    .insert(saasAction)
    .values({
      organizationId: orgId,
      kind: "conversacion",
      occurredAt: at,
      contactId: person!.id,
      conversationId,
      detail: "Atendió una conversación por WhatsApp",
      currency: "USD",
      basePriceMicros: 500_000,
      priceMicros: micros,
      dedupeKey: randomUUID(),
    })
    .returning({ id: saasAction.id })
  return { id: row!.id, contactId: person!.id }
}

const run = <T>(orgId: string, fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)

it("si era spam se devuelve al instante hasta el 10 % del mes, la persona pasa a Spam y lo demás va a odentIA", async () => {
  const { orgId, actor } = await clinic()
  const now = Date.now()
  const actions: Array<{ id: string; contactId: string }> = []
  for (let i = 0; i < 10; i += 1) actions.push(await conversationAction(orgId, new Date(now - (i + 1) * 60_000)))

  const first = await run(orgId, (tx) => requestActionReview(tx, orgId, actor, { actionId: actions[0]!.id, reason: "spam" }))
  expect(first).toEqual({ status: "devuelta", automatic: true, caseId: null })
  const [person] = await ownerDb.select({ screen: contact.screen }).from(contact).where(eq(contact.id, actions[0]!.contactId))
  expect(person?.screen).toBe("spam")
  const rows = await run(orgId, async (tx) => listPeriodActions(tx, orgId, await currentSaasPeriod(tx, orgId)))
  expect(rows.find((row) => row.id === actions[0]!.id)).toMatchObject({ state: "devuelta", review: { status: "devuelta", automatic: true } })

  // 10 % de 10 conversaciones es 1: la siguiente, aunque sea spam, la revisa odentIA.
  const second = await run(orgId, (tx) => requestActionReview(tx, orgId, actor, { actionId: actions[1]!.id, reason: "spam", note: "Publicidad de préstamos" }))
  expect(second).toMatchObject({ status: "pendiente", automatic: false })
  const [kase] = await ownerDb.select().from(supportCase).where(eq(supportCase.id, second.caseId!))
  expect(kase).toMatchObject({ kind: "cobro", organizationId: orgId, openedBy: actor.userId, detail: "Publicidad de préstamos" })
  expect(kase?.question).toContain("Revisión de cobro")
  // Una sola revisión por fila.
  await expect(run(orgId, (tx) => requestActionReview(tx, orgId, actor, { actionId: actions[1]!.id, reason: "otro" }))).rejects.toMatchObject({
    code: "REVIEW_EXISTS",
  })
})

it("odentIA devuelve o mantiene con su respuesta; la conversación solo con permiso y hasta responder", async () => {
  const { orgId, actor } = await clinic()
  const kept = await conversationAction(orgId, new Date(Date.now() - 120_000))
  const back = await conversationAction(orgId, new Date(Date.now() - 60_000), 500_000, true)
  const asked = await run(orgId, (tx) => requestActionReview(tx, orgId, actor, { actionId: back.id, reason: "agente", note: "Dio un horario que no tenemos", allowRead: true }))
  const other = await run(orgId, (tx) => requestActionReview(tx, orgId, actor, { actionId: kept.id, reason: "doble" }))
  expect(asked.status).toBe("pendiente")
  // Con permiso, odentIA lee la conversación mientras no responda; sin permiso, no.
  const read = await ownerDb.transaction((tx) => readReviewConversation(tx as Db, STAFF, asked.caseId!))
  expect(read.map((row) => row.body)).toEqual(["¿Atienden los domingos?"])
  await expect(ownerDb.transaction((tx) => readReviewConversation(tx as Db, STAFF, other.caseId!))).rejects.toMatchObject({ status: 404 })

  await ownerDb.transaction((tx) => decideActionReview(tx as Db, STAFF, { caseId: asked.caseId!, accept: true, answer: "Tienen razón: el agente leyó el horario de verano." }))
  await expect(
    ownerDb.transaction((tx) => decideActionReview(tx as Db, STAFF, { caseId: asked.caseId!, accept: false, answer: "Otra vez" })),
  ).rejects.toMatchObject({ code: "REVIEW_ALREADY_DECIDED" })
  await ownerDb.transaction((tx) => decideActionReview(tx as Db, STAFF, { caseId: other.caseId!, accept: false, answer: "Es una sola conversación ese día." }))

  const reviews = await ownerDb.select().from(saasActionReview).where(eq(saasActionReview.organizationId, orgId)).orderBy(asc(saasActionReview.requestedAt))
  expect(reviews.map((row) => [row.actionId, row.status, row.decidedByStaffId, row.readUntil])).toEqual([
    [back.id, "devuelta", STAFF.userId, null],
    [kept.id, "mantenida", STAFF.userId, null],
  ])
  const rows = await run(orgId, async (tx) => listPeriodActions(tx, orgId, await currentSaasPeriod(tx, orgId)))
  expect(rows.find((row) => row.id === back.id)?.state).toBe("devuelta")
  expect(rows.find((row) => row.id === kept.id)).toMatchObject({ state: "credito", review: { status: "mantenida", answer: "Es una sola conversación ese día." } })
  // La respuesta llega a la clínica en su caso, que queda resuelto.
  const [kase] = await ownerDb.select().from(supportCase).where(eq(supportCase.id, asked.caseId!))
  expect(kase?.status).toBe("resuelto")
  const replies = await ownerDb.select().from(supportMessage).where(and(eq(supportMessage.caseId, asked.caseId!), eq(supportMessage.isInternal, false)))
  expect(replies.map((row) => row.body)).toEqual(["Tienen razón: el agente leyó el horario de verano."])
  // Respondida, odentIA ya no lee la conversación.
  await expect(ownerDb.transaction((tx) => readReviewConversation(tx as Db, STAFF, asked.caseId!))).rejects.toMatchObject({
    code: "REVIEW_READ_NOT_ALLOWED",
  })
})

it("solo este mes y el anterior", async () => {
  const { orgId, actor } = await clinic()
  const old = await conversationAction(orgId, new Date(Date.now() - 95 * 86_400_000))
  await expect(run(orgId, (tx) => requestActionReview(tx, orgId, actor, { actionId: old.id, reason: "otro" }))).rejects.toMatchObject({
    code: "REVIEW_WINDOW_CLOSED",
  })
  // Del mes anterior sí, aunque ya se haya facturado.
  const last = await conversationAction(orgId, new Date(Date.now() - 25 * 86_400_000))
  await expect(run(orgId, (tx) => requestActionReview(tx, orgId, actor, { actionId: last.id, reason: "otro" }))).resolves.toMatchObject({
    status: "pendiente",
  })
})

it("lo ya cobrado por encima del crédito vuelve como «Devolución por revisión», una sola vez; lo que cubrió el crédito no se devuelve en dinero", async () => {
  const end = new Date(Date.now() - 3_600_000)
  const start = new Date(end.getTime() - 30 * 86_400_000)
  const { orgId, actor } = await clinic({ activatedAt: start, currentPeriodStart: start, currentPeriodEnd: end })
  // La primera gasta justo los USD 29 del crédito; la segunda ya pasó del crédito y se pagó aparte.
  const covered = await conversationAction(orgId, new Date(start.getTime() + 3_600_000), 29_000_000)
  const charged = await conversationAction(orgId, new Date(start.getTime() + 86_400_000), 450_000)
  await closeSaasPeriods(ownerDb, new Date())
  const [firstCharge] = await ownerDb.select().from(saasCharge).where(eq(saasCharge.organizationId, orgId))
  expect(firstCharge).toBeDefined()

  for (const action of [covered, charged]) {
    const asked = await run(orgId, (tx) => requestActionReview(tx, orgId, actor, { actionId: action.id, reason: "agente" }))
    await ownerDb.transaction((tx) => decideActionReview(tx as Db, STAFF, { caseId: asked.caseId!, accept: true, answer: "Devolvemos la conversación." }))
  }
  const previous = await run(orgId, async (tx) => listPeriodActions(tx, orgId, { start, end, credit: "mes", creditCents: 2900 }))
  expect(previous.find((row) => row.id === covered.id)?.review).toMatchObject({ status: "devuelta", coveredByCredit: true })
  expect(previous.find((row) => row.id === charged.id)?.review).toMatchObject({ status: "devuelta", coveredByCredit: false })

  const next = addMonth(end)
  await closeSaasPeriods(ownerDb, new Date(next.getTime() + 3_600_000))
  await closeSaasPeriods(ownerDb, new Date(next.getTime() + 7_200_000))
  const charges = await ownerDb.select().from(saasCharge).where(eq(saasCharge.organizationId, orgId)).orderBy(asc(saasCharge.periodStart))
  expect(charges).toHaveLength(2)
  const lines = await ownerDb.select().from(saasChargeLine).where(eq(saasChargeLine.chargeId, charges[1]!.id)).orderBy(asc(saasChargeLine.sortOrder))
  expect(lines.filter((line) => line.kind === "revision").map((line) => [line.quantity, line.amountCents])).toEqual([[1, -45]])
  const [review] = await ownerDb.select().from(saasActionReview).where(eq(saasActionReview.actionId, charged.id))
  expect(review?.creditChargeId).toBe(charges[1]!.id)
  const [coveredReview] = await ownerDb.select().from(saasActionReview).where(eq(saasActionReview.actionId, covered.id))
  expect(coveredReview?.creditChargeId).toBeNull()
})

// Va al final: cambia las condiciones comerciales para las pruebas que siguen en este archivo.
it("el spam al instante usa la parte que rige al pedir la revisión (ADR 0074)", async () => {
  // La administración subió el spam que se devuelve sin revisar al 20 %.
  await ownerDb.insert(saasCommercialTerms).values({ ...SAAS_TERMS_INITIAL, reviewAutoPercent: 20, effectiveFrom: new Date(Date.now() - 1000) })
  const { orgId, actor } = await clinic()
  const now = Date.now()
  const actions: Array<{ id: string; contactId: string }> = []
  for (let i = 0; i < 10; i += 1) actions.push(await conversationAction(orgId, new Date(now - (i + 1) * 60_000)))
  // 20 % de 10 conversaciones son 2 al instante; la tercera la revisa odentIA.
  const results = []
  for (const action of actions.slice(0, 3)) results.push(await run(orgId, (tx) => requestActionReview(tx, orgId, actor, { actionId: action.id, reason: "spam" })))
  expect(results.map((result) => result.automatic)).toEqual([true, true, false])
})
