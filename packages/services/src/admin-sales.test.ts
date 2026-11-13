import { randomUUID } from "node:crypto"
import {
  saasClient,
  saasClientContact,
  saasOpportunity,
  saasOutreach,
  saasProposal,
  saasTask,
} from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import {
  saasFollowUp,
  saasPlan,
  saasSeller,
  saasSubscription,
  saasWaitlistRequest,
} from "@odentia/db/schema/saas-billing"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { clientTimeline, getClient, listClients } from "./admin-clients.js"
import { forecastReport } from "./admin-reports.js"
import {
  addActivity,
  applyInvitedProposal,
  approveSaasProposal,
  cancelClientTask,
  completeClientTask,
  createClientTask,
  createSaasProposal,
  decide,
  decideSaasProposal,
  inviteClient,
  listClientTasks,
  listSaasProposals,
  markOpportunityEntered,
  markOutreachSent,
  moveClientTask,
  outreachEmail,
  pipeline,
  prepareOutreach,
  proposalDisplayStatus,
  proposalNeedsApproval,
  proposalPdf,
  recordPresentation,
  reopenClientOpportunity,
  resolveOutreach,
  schedulePresentation,
  setOpportunity,
  whatsappLink,
} from "./admin-sales.js"
import { limaDate } from "./peru-business-days.js"
import { createSaasPlan } from "./saas-billing.js"
import { completeFounderInvitation, submitWaitlistRequest } from "./saas-founders.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** La venta del ARM: actividades, tareas, decisión, invitación, propuestas, envíos y embudo. */
setupTestDb()
const admin = { userId: "sales-admin", role: "admin" as const }
const support = { userId: "sales-support", role: "support" as const }
const DAY = 86_400_000
let planId: string
let medicalPlanId: string

function day(offset: number, from = new Date()): string {
  return limaDate(new Date(from.getTime() + offset * DAY))
}

async function newClient(over: Partial<typeof saasClient.$inferInsert> = {}) {
  const [row] = await ownerDb
    .insert(saasClient)
    .values({
      name: `Clínica ${randomUUID().slice(0, 6)} (ficticia)`,
      product: "dental",
      origin: "referido",
      ownerUserId: admin.userId,
      ...over,
    })
    .returning()
  if (!row) throw new Error("sin cliente")
  const [contact] = await ownerDb
    .insert(saasClientContact)
    .values({
      clientId: row.id,
      name: "Luis Mamani",
      phone: "+51987654321",
      email: `luis-${row.id.slice(0, 6)}@andes.test`,
      isPrimary: true,
    })
    .returning()
  if (!contact) throw new Error("sin contacto")
  return { client: row, contact }
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ada Admin", email: "admin@sales.test" },
    { id: support.userId, name: "Sara Soporte", email: "support@sales.test" },
  ])
  await ownerDb.insert(adminStaff).values([
    { userId: admin.userId, role: "admin" },
    { userId: support.userId, role: "support" },
  ])
  const plan = await createSaasPlan(ownerDb, admin.userId, {
    code: "sales-lista",
    name: "Plan odentIA (ficticio)",
    currency: "USD",
    priceCents: 2900,
    creditCents: 2900,
    conversationMicros: 500_000,
    consultationMicros: 400_000,
    recoveryMicros: 4_000_000,
    trialCreditCents: 1_000,
    trialMaxCreditCents: 5_000,
    trialDays: 30,
    trialMaxDays: 60,
    maxDiscountBps: 3000,
    sellerDiscountBps: 1000,
  })
  planId = plan.id
  const medical = await createSaasPlan(ownerDb, admin.userId, {
    code: "sales-medico",
    name: "Plan latidIA (ficticio)",
    currency: "USD",
    priceCents: 2900,
    creditCents: 2900,
    conversationMicros: 500_000,
    consultationMicros: 400_000,
    recoveryMicros: 4_000_000,
    product: "medical",
  })
  medicalPlanId = medical.id
})

describe("actividades", () => {
  it("van a la bitácora del cliente y, con solicitud, también a la solicitud", async () => {
    const { client, contact } = await newClient()
    const { id: requestId } = await submitWaitlistRequest(ownerDb, {
      firstName: "Rosa",
      lastName: "Díaz",
      email: `rosa-${client.id.slice(0, 6)}@norte.test`,
      phone: "+51 987 111 222",
      clinicName: client.name,
      countryCode: "PE",
      city: "Lima",
      professionals: "2-3",
      currentTool: "nada",
    })
    await ownerDb
      .update(saasWaitlistRequest)
      .set({ clientId: client.id })
      .where(eq(saasWaitlistRequest.id, requestId))
    const activity = await addActivity(ownerDb, admin, client.id, {
      kind: "llamada",
      direction: "salio",
      body: "Quiere ver cómo traemos sus datos",
      contactId: contact.id,
      adminOnly: true,
    })
    const [row] = await ownerDb.select().from(saasFollowUp).where(eq(saasFollowUp.id, activity.id))
    expect(row).toMatchObject({
      clientId: client.id,
      requestId,
      kind: "llamada",
      direction: "salio",
      adminOnly: true,
      byKairos: false,
    })
  })

  it("lo que anota Soporte nunca es solo de Administración; una nota no lleva dirección", async () => {
    const { client } = await newClient()
    const note = await addActivity(ownerDb, support, client.id, {
      kind: "nota",
      direction: "salio",
      body: "Prefiere WhatsApp",
      adminOnly: true,
    })
    expect(note).toMatchObject({ adminOnly: false, direction: null })
    const kairos = await addActivity(ownerDb, null, client.id, {
      kind: "correo",
      direction: "entro",
      body: "Respondió el correo",
    })
    expect(kairos).toMatchObject({ byKairos: true, authorUserId: null })
  })

  it("rechaza el contacto de otro cliente, lo que no pasó todavía y un cliente archivado", async () => {
    const { client } = await newClient()
    const other = await newClient()
    await expect(
      addActivity(ownerDb, admin, client.id, {
        kind: "llamada",
        body: "x",
        contactId: other.contact.id,
      }),
    ).rejects.toMatchObject({
      fields: { contactId: expect.any(String) },
    })
    await expect(
      addActivity(ownerDb, admin, client.id, {
        kind: "llamada",
        body: "x",
        happenedAt: new Date(Date.now() + 2 * DAY),
      }),
    ).rejects.toMatchObject({ fields: { happenedAt: expect.any(String) } })
    await expect(
      addActivity(ownerDb, admin, client.id, { kind: "llamada", body: "  " }),
    ).rejects.toMatchObject({ fields: { body: expect.any(String) } })
    await ownerDb
      .update(saasClient)
      .set({ archivedAt: new Date() })
      .where(eq(saasClient.id, other.client.id))
    await expect(
      addActivity(ownerDb, admin, other.client.id, { kind: "nota", body: "x" }),
    ).rejects.toMatchObject({ code: "CLIENT_ARCHIVED" })
  })
})

describe("tareas", () => {
  it("se ponen, se listan (mías y todas), se mueven, se hacen con su actividad y se cancelan", async () => {
    const { client, contact } = await newClient()
    const now = new Date()
    const task = await createClientTask(
      ownerDb,
      support,
      client.id,
      { kind: "llamar", title: "Volver a llamar", dueOn: day(-1, now), contactId: contact.id },
      now,
    )
    // Sin responsable dicho, es el del cliente.
    expect(task).toMatchObject({
      assignee: { userId: admin.userId, name: "Ada Admin" },
      overdue: true,
      status: "abierta",
    })
    const mine = await listClientTasks(ownerDb, admin, { who: "mias", dueBy: day(0, now) }, now)
    expect(mine.map((t) => t.id)).toContain(task.id)
    expect(
      (await listClientTasks(ownerDb, support, { who: "mias" }, now)).map((t) => t.id),
    ).not.toContain(task.id)
    expect(
      (await listClientTasks(ownerDb, support, { who: "todas", clientId: client.id }, now)).map(
        (t) => t.id,
      ),
    ).toEqual([task.id])

    const moved = await moveClientTask(ownerDb, admin, task.id, { dueOn: day(2, now) }, now)
    expect(moved).toMatchObject({ dueOn: day(2, now), overdue: false })
    await expect(
      moveClientTask(ownerDb, admin, task.id, { dueOn: "2026-02-30" }, now),
    ).rejects.toMatchObject({ fields: { dueOn: expect.any(String) } })

    const done = await completeClientTask(
      ownerDb,
      admin,
      task.id,
      {
        note: "Hablamos",
        activity: { kind: "llamada", direction: "salio", body: "Confirmó la presentación" },
      },
      now,
    )
    expect(done.task).toMatchObject({ status: "hecha", doneNote: "Hablamos" })
    expect(done.activity).toMatchObject({ kind: "llamada", contactId: contact.id })
    await expect(completeClientTask(ownerDb, admin, task.id)).rejects.toMatchObject({
      code: "TASK_CLOSED",
    })

    const other = await createClientTask(
      ownerDb,
      admin,
      client.id,
      {
        kind: "escribir",
        title: "Mandar el resumen",
        dueOn: day(0, now),
        assigneeUserId: support.userId,
      },
      now,
    )
    expect(other.assignee?.userId).toBe(support.userId)
    expect((await cancelClientTask(ownerDb, admin, other.id)).status).toBe("cancelada")
    await expect(
      createClientTask(
        ownerDb,
        admin,
        client.id,
        { kind: "llamar", title: "x", dueOn: day(0, now), assigneeUserId: "nadie" },
        now,
      ),
    ).rejects.toMatchObject({ fields: { assigneeUserId: expect.any(String) } })
  })

  it("Soporte no ve las tareas de cobro: ni en la ficha, ni en listas, ni en el historial (ADR 0181)", async () => {
    const { client } = await newClient()
    const now = new Date()
    const cobro = await createClientTask(
      ownerDb,
      admin,
      client.id,
      { kind: "cobro", title: "Hablar del comprobante", dueOn: day(-1, now) },
      now,
    )
    const llamar = await createClientTask(
      ownerDb,
      admin,
      client.id,
      { kind: "llamar", title: "Llamar", dueOn: day(1, now) },
      now,
    )
    // La administración la ve primero: es la más próxima.
    const forAdmin = await getClient(ownerDb, admin, client.id, now)
    expect(forAdmin.nextStep?.taskId).toBe(cobro.id)
    expect(forAdmin.openTasks.map((t) => t.id)).toEqual([cobro.id, llamar.id])
    // Para Soporte no existe: el próximo paso es la llamada.
    const forSupport = await getClient(ownerDb, support, client.id, now)
    expect(forSupport.nextStep?.taskId).toBe(llamar.id)
    expect(forSupport.openTasks.map((t) => t.id)).toEqual([llamar.id])
    const listed = await listClients(ownerDb, support, { view: "todos", q: client.name }, now)
    expect(listed.items.find((c) => c.id === client.id)?.nextStep?.taskId).toBe(llamar.id)
    expect(
      (await listClientTasks(ownerDb, support, { clientId: client.id }, now)).map((t) => t.id),
    ).toEqual([llamar.id])
    expect(
      (await listClientTasks(ownerDb, admin, { clientId: client.id }, now)).map((t) => t.id),
    ).toEqual([cobro.id, llamar.id])
    // Ni la mueve, ni la hace, ni la cancela, ni la pone: la misma respuesta que una que no hay.
    for (const attempt of [
      () => moveClientTask(ownerDb, support, cobro.id, { dueOn: day(2, now) }, now),
      () => completeClientTask(ownerDb, support, cobro.id),
      () => cancelClientTask(ownerDb, support, cobro.id),
    ])
      await expect(attempt()).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      createClientTask(ownerDb, support, client.id, {
        kind: "cobro",
        title: "x",
        dueOn: day(0, now),
      }),
    ).rejects.toMatchObject({ fields: { kind: expect.any(String) } })
    // Hecha, sale en el historial solo para la administración.
    await completeClientTask(ownerDb, admin, cobro.id, { note: "Pagó" }, now)
    const later = new Date(now.getTime() + 1000)
    const titles = async (who: typeof admin | typeof support) =>
      (await clientTimeline(ownerDb, who, client.id, {}, later)).items.map((i) => i.title)
    expect(await titles(admin)).toContain("Hecho: Hablar del comprobante")
    expect(await titles(support)).not.toContain("Hecho: Hablar del comprobante")
  })
})

describe("presentaciones", () => {
  it("se agenda como tarea; «Se hizo» deja la presentación; reprogramar mueve la tarea con una nota", async () => {
    const { client, contact } = await newClient()
    const now = new Date()
    const first = await schedulePresentation(
      ownerDb,
      support,
      client.id,
      { dueOn: day(1, now), contactId: contact.id },
      now,
    )
    expect(first).toMatchObject({ kind: "presentacion", status: "abierta" })
    await expect(
      recordPresentation(
        ownerDb,
        admin,
        first.id,
        { outcome: "reprogramar", body: "No pudo" },
        now,
      ),
    ).rejects.toMatchObject({
      fields: { nextDueOn: expect.any(String) },
    })
    const moved = await recordPresentation(
      ownerDb,
      admin,
      first.id,
      { outcome: "reprogramar", body: "Se cruzó con un paciente", nextDueOn: day(3, now) },
      now,
    )
    expect(moved.task).toMatchObject({ dueOn: day(3, now), status: "abierta" })
    expect(moved.activity.kind).toBe("nota")
    const done = await recordPresentation(
      ownerDb,
      admin,
      first.id,
      { outcome: "se_hizo", body: "Le gustó la agenda" },
      now,
    )
    expect(done.task.status).toBe("hecha")
    expect(done.activity).toMatchObject({
      kind: "presentacion",
      outcome: "Se hizo",
      contactId: contact.id,
    })
    // Una presentación agenda también la venta abierta.
    const open = await ownerDb
      .select()
      .from(saasOpportunity)
      .where(and(eq(saasOpportunity.clientId, client.id)))
    expect(open).toHaveLength(1)

    const lost = await schedulePresentation(ownerDb, admin, client.id, { dueOn: day(1, now) }, now)
    const noShow = await recordPresentation(
      ownerDb,
      admin,
      lost.id,
      { outcome: "no_se_conecto", body: "No entró" },
      now,
    )
    expect(noShow.task.status).toBe("cancelada")
    expect(noShow.activity.kind).toBe("nota")
  })
})

describe("oportunidad y decisión", () => {
  it("una sola abierta; vendedor y fecha solo Administración", async () => {
    const { client } = await newClient()
    const [seller] = await ownerDb
      .insert(saasSeller)
      .values({ displayName: "Vendedora (ficticia)", rateBps: 1000 })
      .returning()
    await expect(
      setOpportunity(ownerDb, support, client.id, { expectedOn: day(10) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    const opp = await setOpportunity(ownerDb, admin, client.id, {
      sellerId: seller?.id,
      expectedOn: day(10),
    })
    expect(opp).toMatchObject({
      seller: { id: seller?.id, name: "Vendedora (ficticia)" },
      expectedOn: day(10),
      decision: null,
    })
    const again = await setOpportunity(ownerDb, admin, client.id, { expectedOn: null })
    expect(again.id).toBe(opp.id)
    expect(again.expectedOn).toBeNull()
  })

  it("«No por ahora» pide motivo y día; «Perdido» descarta la solicitud viva y cierra las tareas de venta", async () => {
    const { client } = await newClient()
    const now = new Date()
    await expect(
      decide(ownerDb, support, client.id, { decision: "perdido", reason: "precio" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      decide(
        ownerDb,
        admin,
        client.id,
        { decision: "no_por_ahora", reason: "no_es_el_momento" },
        now,
      ),
    ).rejects.toMatchObject({
      fields: { returnOn: expect.any(String) },
    })
    const later = await decide(
      ownerDb,
      admin,
      client.id,
      { decision: "no_por_ahora", reason: "no_es_el_momento", returnOn: day(60, now) },
      now,
    )
    expect(later.opportunity).toMatchObject({
      decision: "no_por_ahora",
      returnOn: day(60, now),
      reasonWords: "No es el momento",
    })

    const reopened = await reopenClientOpportunity(ownerDb, admin, client.id, now)
    expect(reopened.id).not.toBe(later.opportunity.id)
    expect(reopened.decision).toBeNull()

    const { id: requestId } = await submitWaitlistRequest(ownerDb, {
      firstName: "Elena",
      lastName: "Torres",
      email: `elena-${client.id.slice(0, 6)}@sonrisa.test`,
      phone: "+51 987 333 444",
      clinicName: client.name,
      countryCode: "PE",
      city: "Cusco",
      professionals: "1",
      currentTool: "cuaderno_excel",
    })
    await ownerDb
      .update(saasWaitlistRequest)
      .set({ clientId: client.id })
      .where(eq(saasWaitlistRequest.id, requestId))
    const task = await createClientTask(
      ownerDb,
      admin,
      client.id,
      { kind: "llamar", title: "Llamar", dueOn: day(0, now) },
      now,
    )
    const lost = await decide(
      ownerDb,
      admin,
      client.id,
      { decision: "perdido", reason: "precio", reasonDetail: "Prefiere su cuaderno" },
      now,
    )
    expect(lost).toMatchObject({
      discardedRequestId: requestId,
      cancelledTasks: 1,
      opportunity: { decision: "perdido", reason: "precio" },
    })
    const [request] = await ownerDb
      .select()
      .from(saasWaitlistRequest)
      .where(eq(saasWaitlistRequest.id, requestId))
    expect(request).toMatchObject({
      status: "descartada",
      discardReason: "Precio: Prefiere su cuaderno",
    })
    const [closed] = await ownerDb.select().from(saasTask).where(eq(saasTask.id, task.id))
    expect(closed?.status).toBe("cancelada")
    const decided = await ownerDb
      .select()
      .from(saasOpportunity)
      .where(eq(saasOpportunity.clientId, client.id))
    expect(decided.map((o) => o.decision).sort()).toEqual(["no_por_ahora", "perdido"])
  })
})

describe("propuestas", () => {
  it("versión siguiente con el precio de lista; límites del plan; vencida se calcula", async () => {
    const { client } = await newClient()
    const now = new Date()
    const input = {
      planId,
      discountBps: 1500,
      discountMonths: 6,
      trialDays: 45,
      billingCycle: "mensual" as const,
      validUntil: day(8, now),
    }
    await expect(createSaasProposal(ownerDb, support, client.id, input, now)).rejects.toMatchObject(
      {
        code: "FORBIDDEN",
      },
    )
    await expect(
      createSaasProposal(ownerDb, admin, client.id, { ...input, discountBps: 4000 }, now),
    ).rejects.toMatchObject({
      code: "SAAS_PRICE_BELOW_FLOOR",
      fields: { discountBps: expect.any(String) },
    })
    await expect(
      createSaasProposal(
        ownerDb,
        admin,
        client.id,
        { ...input, trialDays: 90, validUntil: day(-1, now) },
        now,
      ),
    ).rejects.toMatchObject({
      fields: { trialDays: expect.any(String), validUntil: expect.any(String) },
    })
    await expect(
      createSaasProposal(ownerDb, admin, client.id, { ...input, planId: medicalPlanId }, now),
    ).rejects.toMatchObject({
      fields: { planId: expect.any(String) },
    })
    const v1 = await createSaasProposal(ownerDb, admin, client.id, input, now)
    expect(v1).toMatchObject({
      version: 1,
      status: "borrador",
      listPriceCents: 2900,
      currency: "USD",
      displayStatus: "borrador",
    })
    expect(v1.opportunityId).not.toBeNull()
    const v2 = await createSaasProposal(
      ownerDb,
      admin,
      client.id,
      { ...input, discountBps: 0 },
      now,
    )
    expect(v2).toMatchObject({ version: 2, discountMonths: null })
    expect((await listSaasProposals(ownerDb, admin, client.id, now)).map((p) => p.version)).toEqual(
      [2, 1],
    )
    await expect(listSaasProposals(ownerDb, support, client.id, now)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })

    expect(
      proposalDisplayStatus({ status: "enviada", validUntil: "2026-11-10" }, "2026-11-11"),
    ).toBe("vencida")
    expect(
      proposalDisplayStatus({ status: "enviada", validUntil: "2026-11-11" }, "2026-11-11"),
    ).toBe("enviada")
    expect(
      proposalDisplayStatus({ status: "aceptada", validUntil: "2026-11-10" }, "2026-11-11"),
    ).toBe("aceptada")
    await expect(
      decideSaasProposal(ownerDb, admin, v1.id, { accepted: true }),
    ).rejects.toMatchObject({
      code: "PROPOSAL_NOT_SENT",
    })
  })

  it("al salir una versión nueva, la anterior se lee «Reemplazada por la vN», no se acepta ni se reenvía y la previsión cuenta solo la última", async () => {
    const { client, contact } = await newClient()
    const now = new Date()
    const input = {
      planId,
      discountBps: 1000,
      billingCycle: "mensual" as const,
      validUntil: day(10, now),
    }
    const v1 = await createSaasProposal(ownerDb, admin, client.id, input, now)
    const v2 = await createSaasProposal(
      ownerDb,
      admin,
      client.id,
      { ...input, discountBps: 0 },
      now,
    )
    const sent = async (id: string) =>
      ownerDb
        .update(saasProposal)
        .set({ status: "enviada", sentAt: now })
        .where(eq(saasProposal.id, id))
    await sent(v1.id)
    // Mientras la v2 no sale, la v1 sigue vigente.
    expect(
      (await listSaasProposals(ownerDb, admin, client.id, now)).find((p) => p.id === v1.id),
    ).toMatchObject({ displayStatus: "enviada", replacedBy: null })
    await sent(v2.id)
    const listed = await listSaasProposals(ownerDb, admin, client.id, now)
    expect(listed.map((p) => [p.version, p.displayStatus, p.replacedBy])).toEqual([
      [2, "enviada", null],
      [1, "reemplazada", 2],
    ])
    expect(
      proposalDisplayStatus(
        { status: "enviada", validUntil: "2026-11-10", replacedBy: 2 },
        "2026-11-11",
      ),
    ).toBe("reemplazada")
    await expect(
      decideSaasProposal(ownerDb, admin, v1.id, { accepted: true }, now),
    ).rejects.toMatchObject({
      code: "PROPOSAL_REPLACED",
      status: 409,
      message: expect.stringContaining("v2"),
    })
    await expect(
      prepareOutreach(
        ownerDb,
        admin,
        client.id,
        { channel: "whatsapp", contactId: contact.id, body: "La propuesta", proposalId: v1.id },
        now,
      ),
    ).rejects.toMatchObject({ code: "PROPOSAL_REPLACED" })
    const forecast = await forecastReport(ownerDb, admin, now)
    expect(forecast.rows.filter((p) => p.clientId === client.id).map((p) => p.version)).toEqual([2])
    // La vigente sí se acepta.
    expect((await decideSaasProposal(ownerDb, admin, v2.id, { accepted: true }, now)).status).toBe(
      "aceptada",
    )
  })

  it("pide aprobación cuando pasa de lo que da el vendedor y no la arma Administración", async () => {
    const plan = { sellerDiscountBps: 1000, trialDays: 30, trialCreditCents: 1000 }
    expect(proposalNeedsApproval(plan, { discountBps: 1500 }, "support")).toBe(true)
    expect(proposalNeedsApproval(plan, { discountBps: 500, trialDays: 45 }, "support")).toBe(true)
    expect(
      proposalNeedsApproval(
        plan,
        { discountBps: 1000, trialDays: 30, trialCreditCents: 1000 },
        "support",
      ),
    ).toBe(false)
    expect(proposalNeedsApproval(plan, { discountBps: 3000 }, "admin")).toBe(false)
    // Una por aprobar no se envía hasta que Administración la aprueba.
    const { client, contact } = await newClient()
    const v1 = await createSaasProposal(ownerDb, admin, client.id, {
      planId,
      discountBps: 0,
      billingCycle: "mensual",
      validUntil: day(5),
    })
    await ownerDb
      .update(saasProposal)
      .set({ status: "por_aprobar" })
      .where(eq(saasProposal.id, v1.id))
    await expect(
      prepareOutreach(ownerDb, admin, client.id, {
        channel: "whatsapp",
        contactId: contact.id,
        body: "Le envío la propuesta",
        proposalId: v1.id,
      }),
    ).rejects.toMatchObject({
      code: "PROPOSAL_NEEDS_APPROVAL",
    })
    await expect(approveSaasProposal(ownerDb, support, v1.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    const approved = await approveSaasProposal(ownerDb, admin, v1.id)
    expect(approved).toMatchObject({ status: "borrador" })
    expect(approved.approvedAt).not.toBeNull()
  })

  it("el PDF lleva la marca y cabe en dos hojas", async () => {
    const { client } = await newClient({ name: "Dental Andes (ficticia)" })
    const proposal = await createSaasProposal(ownerDb, admin, client.id, {
      planId,
      discountBps: 1500,
      discountMonths: 6,
      trialDays: 45,
      trialCreditCents: 2000,
      billingCycle: "quincenal",
      validUntil: day(10),
    })
    const pdf = await proposalPdf(ownerDb, proposal.id)
    expect(Buffer.from(pdf.bytes.slice(0, 5)).toString()).toBe("%PDF-")
    expect(pdf.pages).toBeGreaterThanOrEqual(1)
    expect(pdf.pages).toBeLessThanOrEqual(2)
    expect(pdf.filename).toBe("propuesta-1-dental-andes-ficticia.pdf")
  })
})

describe("envíos", () => {
  it("WhatsApp: enlace con el texto; «Salió» deja la actividad y pasa la propuesta a enviada", async () => {
    const { client, contact } = await newClient()
    const now = new Date()
    const proposal = await createSaasProposal(
      ownerDb,
      admin,
      client.id,
      { planId, discountBps: 1000, billingCycle: "mensual", validUntil: day(7, now) },
      now,
    )
    await expect(
      prepareOutreach(ownerDb, support, client.id, {
        channel: "whatsapp",
        contactId: contact.id,
        body: "Hola",
        proposalId: proposal.id,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    const outreach = await prepareOutreach(
      ownerDb,
      admin,
      client.id,
      {
        channel: "whatsapp",
        contactId: contact.id,
        body: "Hola Luis, le envío la propuesta & el detalle",
        proposalId: proposal.id,
      },
      now,
    )
    expect(outreach).toMatchObject({ status: "pendiente", to: "+51987654321" })
    expect(outreach.whatsappUrl).toBe(
      `https://wa.me/51987654321?text=${encodeURIComponent("Hola Luis, le envío la propuesta & el detalle")}`,
    )
    expect(whatsappLink("+51987654321", "a b")).toBe("https://wa.me/51987654321?text=a%20b")
    await expect(markOutreachSent(ownerDb, admin, outreach.id, "enviado")).rejects.toMatchObject({
      code: "OUTREACH_NOT_EMAIL",
    })

    const resolved = await resolveOutreach(ownerDb, admin, outreach.id, "salio", now)
    expect(resolved).toMatchObject({ status: "enviado" })
    const [sent] = await ownerDb.select().from(saasProposal).where(eq(saasProposal.id, proposal.id))
    expect(sent?.status).toBe("enviada")
    expect(sent?.sentAt).not.toBeNull()
    const activities = await ownerDb
      .select()
      .from(saasFollowUp)
      .where(eq(saasFollowUp.clientId, client.id))
    expect(activities).toEqual([
      expect.objectContaining({
        kind: "whatsapp",
        direction: "salio",
        proposalId: proposal.id,
        contactId: contact.id,
      }),
    ])
    await expect(resolveOutreach(ownerDb, admin, outreach.id, "no_salio")).rejects.toMatchObject({
      code: "OUTREACH_SETTLED",
    })

    // Reenviarla no cambia su fecha; aceptarla deja su actividad.
    const again = await prepareOutreach(
      ownerDb,
      admin,
      client.id,
      {
        channel: "whatsapp",
        contactId: contact.id,
        body: "Se la reenvío",
        proposalId: proposal.id,
      },
      now,
    )
    await resolveOutreach(ownerDb, admin, again.id, "salio", new Date(now.getTime() + 60_000))
    const [still] = await ownerDb
      .select()
      .from(saasProposal)
      .where(eq(saasProposal.id, proposal.id))
    expect(still?.sentAt?.getTime()).toBe(sent?.sentAt?.getTime())
    const accepted = await decideSaasProposal(
      ownerDb,
      admin,
      proposal.id,
      { accepted: true, note: "Dijo que sí por WhatsApp" },
      now,
    )
    expect(accepted.status).toBe("aceptada")
    await expect(
      prepareOutreach(ownerDb, admin, client.id, {
        channel: "whatsapp",
        contactId: contact.id,
        body: "x",
        proposalId: proposal.id,
      }),
    ).rejects.toMatchObject({
      code: "PROPOSAL_DECIDED",
    })
  })

  it("correo: el incierto no se reintenta y lo resuelve una persona; el correo lleva el PDF", async () => {
    const { client, contact } = await newClient({ product: "medical" })
    await expect(
      prepareOutreach(ownerDb, support, client.id, {
        channel: "correo",
        contactId: contact.id,
        body: "Hola",
      }),
    ).rejects.toMatchObject({
      fields: { subject: expect.any(String) },
    })
    await expect(
      prepareOutreach(ownerDb, support, client.id, {
        channel: "whatsapp",
        to: "987654321",
        body: "Hola",
      }),
    ).rejects.toMatchObject({
      fields: { to: expect.any(String) },
    })
    const proposal = await createSaasProposal(ownerDb, admin, client.id, {
      planId: medicalPlanId,
      discountBps: 0,
      billingCycle: "mensual",
      validUntil: day(7),
    })
    const outreach = await prepareOutreach(ownerDb, admin, client.id, {
      channel: "correo",
      contactId: contact.id,
      subject: "Su propuesta",
      body: "Hola Luis:\n\nLe enviamos la propuesta.",
      proposalId: proposal.id,
    })
    const email = await outreachEmail(ownerDb, outreach.id)
    expect(email).toMatchObject({
      to: contact.email,
      subject: "Su propuesta",
      replyTo: "contacto@latidia72.com",
      brand: "latidia",
    })
    expect(email.attachments).toEqual([expect.objectContaining({ contentType: "application/pdf" })])
    expect(email.text).toContain("Le enviamos la propuesta.")

    const uncertain = await markOutreachSent(ownerDb, admin, outreach.id, "incierto")
    expect(uncertain.status).toBe("incierto")
    await expect(markOutreachSent(ownerDb, admin, outreach.id, "enviado")).rejects.toMatchObject({
      code: "OUTREACH_SETTLED",
    })
    const [still] = await ownerDb
      .select()
      .from(saasProposal)
      .where(eq(saasProposal.id, proposal.id))
    expect(still?.status).toBe("borrador")
    expect(
      await ownerDb.select().from(saasFollowUp).where(eq(saasFollowUp.clientId, client.id)),
    ).toHaveLength(0)
    const failed = await resolveOutreach(ownerDb, support, outreach.id, "no_salio")
    expect(failed.status).toBe("no_salio")

    const sent = await prepareOutreach(ownerDb, support, client.id, {
      channel: "correo",
      to: "Otra@Clinica.test",
      subject: "Hola",
      body: "Seguimos",
    })
    expect(sent.to).toBe("otra@clinica.test")
    expect((await markOutreachSent(ownerDb, support, sent.id, "enviado")).status).toBe("enviado")
    // La base tampoco deja reescribir un envío.
    await expect(
      ownerDb.update(saasOutreach).set({ status: "pendiente" }).where(eq(saasOutreach.id, sent.id)),
    ).rejects.toMatchObject({
      cause: { constraint_name: "saas_outreach_status_flow" },
    })
  })
})

describe("invitar", () => {
  it("sin solicitud crea una desde la administración; pide lo que falta", async () => {
    const { client, contact } = await newClient()
    await expect(
      inviteClient(ownerDb, support, client.id, { email: contact.email ?? "" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      inviteClient(ownerDb, admin, client.id, { email: contact.email ?? "", planId }),
    ).rejects.toMatchObject({
      fields: {
        city: expect.any(String),
        professionals: expect.any(String),
        currentTool: expect.any(String),
      },
    })
    const invited = await inviteClient(ownerDb, admin, client.id, {
      email: contact.email ?? "",
      planId,
      city: "Cusco",
      professionals: "4-9",
      currentTool: "otro_software",
    })
    expect(invited).toMatchObject({ createdRequest: true, planId, email: contact.email })
    expect(invited.token.length).toBeGreaterThan(20)
    const [request] = await ownerDb
      .select()
      .from(saasWaitlistRequest)
      .where(eq(saasWaitlistRequest.id, invited.requestId))
    expect(request).toMatchObject({
      source: "administracion",
      status: "invitada",
      clientId: client.id,
      firstName: "Luis",
      lastName: "Mamani",
      city: "Cusco",
    })
    const [updated] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, client.id))
    expect(updated).toMatchObject({
      city: "Cusco",
      professionals: "4-9",
      currentTool: "otro_software",
    })
    // Reenviar usa la misma solicitud.
    const again = await inviteClient(ownerDb, admin, client.id, {
      email: contact.email ?? "",
      planId,
    })
    expect(again).toMatchObject({ requestId: invited.requestId, createdRequest: false })
  })

  it("con la propuesta aceptada, lleva su plan y al entrar aplica sus condiciones una vez", async () => {
    const { client, contact } = await newClient({
      city: "Arequipa",
      professionals: "2-3",
      currentTool: "nada",
    })
    const now = new Date()
    const proposal = await createSaasProposal(
      ownerDb,
      admin,
      client.id,
      {
        planId,
        discountBps: 2000,
        discountMonths: 3,
        trialDays: 45,
        trialCreditCents: 2000,
        billingCycle: "quincenal",
        validUntil: day(7, now),
      },
      now,
    )
    await expect(
      inviteClient(ownerDb, admin, client.id, {
        email: contact.email ?? "",
        proposalId: proposal.id,
      }),
    ).rejects.toMatchObject({
      fields: { proposalId: expect.any(String) },
    })
    const outreach = await prepareOutreach(
      ownerDb,
      admin,
      client.id,
      { channel: "whatsapp", contactId: contact.id, body: "La propuesta", proposalId: proposal.id },
      now,
    )
    await resolveOutreach(ownerDb, admin, outreach.id, "salio", now)
    await decideSaasProposal(ownerDb, admin, proposal.id, { accepted: true }, now)
    const invited = await inviteClient(
      ownerDb,
      admin,
      client.id,
      { email: contact.email ?? "", proposalId: proposal.id },
      now,
    )
    expect(invited).toMatchObject({ planId, proposalId: proposal.id })

    const orgId = `sales-${randomUUID().slice(0, 8)}`
    await insertOrg(ownerDb, orgId, orgId)
    // Entrar con la invitación aplica las condiciones de la propuesta en la misma transacción.
    await completeFounderInvitation(ownerDb, invited.requestId, orgId, now)
    const [sub] = await ownerDb
      .select()
      .from(saasSubscription)
      .where(eq(saasSubscription.organizationId, orgId))
    expect(sub).toMatchObject({
      planId,
      discountBps: 2000,
      trialDays: 45,
      trialCreditCents: 2000,
      billingCycle: "quincenal",
    })
    expect(Math.round(((sub?.trialEndsAt?.getTime() ?? 0) - now.getTime()) / DAY)).toBe(45)
    expect(sub?.discountEndsAt?.getUTCMonth()).toBe((now.getUTCMonth() + 3) % 12)
    expect(await applyInvitedProposal(ownerDb, invited.requestId, orgId, now)).toMatchObject({
      applied: false,
    })

    await ownerDb
      .update(saasClient)
      .set({ organizationId: orgId })
      .where(eq(saasClient.id, client.id))
    await markOpportunityEntered(ownerDb, null, client.id, now)
    const opps = await ownerDb
      .select()
      .from(saasOpportunity)
      .where(eq(saasOpportunity.clientId, client.id))
    expect(opps.map((o) => o.decision)).toEqual(["entro"])
    await expect(
      inviteClient(ownerDb, admin, client.id, { email: contact.email ?? "" }),
    ).rejects.toMatchObject({ code: "CLIENT_HAS_ACCOUNT" })
  })

  it("no invita a un correo que ya tiene una solicitud viva de otro cliente", async () => {
    const { client } = await newClient({ city: "Lima", professionals: "1", currentTool: "nada" })
    const { id: requestId } = await submitWaitlistRequest(ownerDb, {
      firstName: "Ana",
      lastName: "Quispe",
      email: "ana@ocupado.test",
      phone: "+51 987 555 666",
      clinicName: "Otra clínica",
      countryCode: "PE",
      city: "Lima",
      professionals: "1",
      currentTool: "nada",
    })
    expect(requestId).toBeTruthy()
    await expect(
      inviteClient(ownerDb, admin, client.id, { email: "ANA@ocupado.test", planId }),
    ).rejects.toMatchObject({
      code: "WAITLIST_EMAIL_IN_USE",
      fields: { email: expect.any(String) },
    })
  })
})

describe("embudo", () => {
  it("cada cliente en la columna de su etapa, con próximo paso, señales y lo decidido", async () => {
    const now = new Date()
    const product = "optical" as const
    const contacto = await newClient({ product, name: "Óptica Contacto (ficticia)" })
    const agendada = await newClient({ product, name: "Óptica Agenda (ficticia)" })
    const hecha = await newClient({ product, name: "Óptica Hecha (ficticia)" })
    const propuesta = await newClient({
      product,
      name: "Óptica Mirada (ficticia)",
      ownerUserId: support.userId,
    })
    const perdida = await newClient({ product, name: "Óptica Perdida (ficticia)" })
    const [opticalPlan] = await ownerDb
      .insert(saasPlan)
      .values({
        code: "sales-optico",
        name: "Plan vistIA (ficticio)",
        currency: "USD",
        priceCents: 2900,
        product,
      })
      .returning()
    if (!opticalPlan) throw new Error("sin plan")

    await reopenClientOpportunity(ownerDb, admin, contacto.client.id, now)
    await schedulePresentation(ownerDb, admin, agendada.client.id, { dueOn: day(1, now) }, now)
    const task = await schedulePresentation(
      ownerDb,
      admin,
      hecha.client.id,
      { dueOn: day(0, now) },
      now,
    )
    await recordPresentation(ownerDb, admin, task.id, { outcome: "se_hizo", body: "Bien" }, now)
    const p = await createSaasProposal(
      ownerDb,
      admin,
      propuesta.client.id,
      { planId: opticalPlan.id, discountBps: 0, billingCycle: "mensual", validUntil: day(8, now) },
      now,
    )
    const o = await prepareOutreach(
      ownerDb,
      admin,
      propuesta.client.id,
      { channel: "whatsapp", contactId: propuesta.contact.id, body: "Propuesta", proposalId: p.id },
      now,
    )
    await resolveOutreach(ownerDb, admin, o.id, "salio", now)
    await decide(
      ownerDb,
      admin,
      perdida.client.id,
      { decision: "perdido", reason: "no_respondio" },
      now,
    )

    // Llegó hace 10 días y nadie la contactó: se enfría (la regla de `kairosCoolingRows`).
    await ownerDb
      .update(saasClient)
      .set({ createdAt: new Date(now.getTime() - 10 * DAY) })
      .where(eq(saasClient.id, contacto.client.id))
    const board = await pipeline(ownerDb, support, { product }, now)
    const where = (id: string) =>
      board.columns.find((column) => column.cards.some((card) => card.clientId === id))?.key
    expect(where(contacto.client.id)).toBe("contacto")
    expect(where(agendada.client.id)).toBe("presentacion_agendada")
    expect(where(hecha.client.id)).toBe("presentacion_hecha")
    expect(where(propuesta.client.id)).toBe("propuesta")
    expect(where(perdida.client.id)).toBe("decidio")
    const card = board.columns
      .flatMap((column) => column.cards)
      .find((c) => c.clientId === agendada.client.id)
    expect(card).toMatchObject({
      nextStep: { kind: "presentacion", dueOn: day(1, now) },
      owner: { userId: admin.userId },
      daysInStage: 0,
    })
    const cold = board.columns
      .flatMap((column) => column.cards)
      .find((c) => c.clientId === contacto.client.id)
    expect(cold?.signals.map((s) => s.code)).toEqual(["se_enfria", "sin_proximo_paso"])
    expect(
      board.columns.flatMap((c) => c.cards).find((c) => c.clientId === perdida.client.id)?.decision,
    ).toBe("perdido")

    const mine = await pipeline(ownerDb, support, { product, owner: "mio" }, now)
    expect(mine.columns.flatMap((column) => column.cards).map((c) => c.clientId)).toEqual([
      propuesta.client.id,
    ])
    const none = await pipeline(ownerDb, admin, { product: "medical", origin: "evento" }, now)
    expect(none.columns.every((column) => column.cards.length === 0)).toBe(true)
  })
})
