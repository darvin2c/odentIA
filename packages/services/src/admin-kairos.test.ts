import {
  kairosAiUsage,
  kairosItem,
  saasClient,
  saasClientContact,
  saasInboundEmail,
  saasOpportunity,
  saasOutreach,
  saasProposal,
  saasTask,
} from "@odentia/db/schema/admin-arm"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { supportCase } from "@odentia/db/schema/admin-support"
import { member, organization, user } from "@odentia/db/schema/auth"
import { saasFollowUp, saasPayment, saasWaitlistRequest } from "@odentia/db/schema/saas-billing"
import { and, eq, like, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import {
  decideKairosItem,
  type KairosExecutors,
  type KairosPassResult,
  kairosDone,
  kairosRulesPass,
  listKairosItems,
  recordKairosAiUse,
  saveKairosDraft,
  settleKairosOutreach,
  settleReportTasks,
  todayForStaff,
} from "./admin-kairos.js"
import { PROGRESS_REPORT_ACTIONS } from "./clinic-progress-report.js"
import { ServiceError } from "./errors.js"
import { limaDate } from "./peru-business-days.js"
import { createSaasPlan } from "./saas-billing.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Kairós: las reglas de cada pasada, lo que espera un sí, «Lo que hizo» y Hoy, con Postgres real. */
setupTestDb()
const admin: AdminActor = { userId: "kz-admin", role: "admin" }
const support: AdminActor = { userId: "kz-support", role: "support" }
const OWNER = "kz-owner"
const RISK_ORG = "kz-riesgo"
const DEMO_ORG = "kz-demo-org"
const LOAD_ORG = "kz-carga"
const LOADED_ORG = "kz-cargada"
const DAY = 86_400_000
const NOW = new Date()
const TODAY = limaDate(NOW)
const plusDays = (days: number) =>
  new Date(new Date(`${TODAY}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10)
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)

const ids: Record<string, string> = {}
let first: KairosPassResult

/** Un cliente con su persona principal y, si se pide, su venta abierta. */
async function client(
  key: string,
  name: string,
  options: {
    createdAt?: Date
    open?: boolean
    owner?: string
    organizationId?: string
    email?: string
    phone?: string
  } = {},
): Promise<string> {
  const createdAt = options.createdAt ?? NOW
  const [row] = await ownerDb
    .insert(saasClient)
    .values({
      name,
      product: "dental",
      origin: "otro",
      ownerUserId: options.owner ?? null,
      organizationId: options.organizationId ?? null,
      createdAt,
      updatedAt: createdAt,
    })
    .returning({ id: saasClient.id })
  if (!row) throw new Error("sin cliente")
  await ownerDb.insert(saasClientContact).values({
    clientId: row.id,
    name: `Persona de ${name}`,
    email: options.email ?? `${key}@kairos.test`,
    phone: options.phone ?? null,
    isPrimary: true,
    createdAt,
    updatedAt: createdAt,
  })
  if (options.open !== false)
    await ownerDb
      .insert(saasOpportunity)
      .values({ clientId: row.id, createdAt, updatedAt: createdAt })
  ids[key] = row.id
  return row.id
}

async function itemsOf(clientId: string | null, kind?: string) {
  return ownerDb
    .select()
    .from(kairosItem)
    .where(
      and(
        clientId ? eq(kairosItem.clientId, clientId) : sql`${kairosItem.clientId} is null`,
        kind ? eq(kairosItem.kind, kind) : undefined,
      ),
    )
}

async function tasksOf(clientId: string) {
  return ownerDb.select().from(saasTask).where(eq(saasTask.clientId, clientId))
}

/** Dobles de las operaciones de la pantalla: anotan cada llamada; el envío deja su fila de verdad. */
const calls: Array<{ op: string; args: unknown[] }> = []
const executors: KairosExecutors = {
  async prepareOutreach(tx, actor, clientId, input) {
    calls.push({ op: "prepareOutreach", args: [actor.userId, clientId, input] })
    const [row] = await tx
      .insert(saasOutreach)
      .values({
        clientId,
        channel: input.channel,
        toAddress: input.to ?? "sin-destino",
        subject: input.subject ?? null,
        body: input.body,
        kairosItemId: input.kairosItemId ?? null,
        createdBy: actor.userId,
      })
      .returning({ id: saasOutreach.id })
    if (!row) throw new Error("sin envío")
    return row
  },
  async updateClient(_tx, actor, clientId, patch) {
    calls.push({ op: "updateClient", args: [actor.userId, clientId, patch] })
  },
  async linkContactToUser(_tx, actor, contactId, userId) {
    calls.push({ op: "linkContactToUser", args: [actor.userId, contactId, userId] })
  },
  async assignInboundEmail(_tx, actor, emailId, clientId) {
    calls.push({ op: "assignInboundEmail", args: [actor.userId, emailId, clientId] })
  },
  async recordPresentation(_tx, actor, taskId, input) {
    calls.push({ op: "recordPresentation", args: [actor.userId, taskId, input] })
  },
  async createProposal(_tx, actor, clientId, input) {
    calls.push({ op: "createProposal", args: [actor.userId, clientId, input] })
    return { id: "00000000-0000-4000-8000-000000000000" }
  },
}
const lastCall = (op: string) => [...calls].reverse().find((call) => call.op === op)
const decide = (
  actor: AdminActor,
  id: string,
  input: Parameters<typeof decideKairosItem>[3],
  ex: KairosExecutors = executors,
) => ownerDb.transaction((tx) => decideKairosItem(tx, actor, id, input, ex, NOW))
const pass = () => ownerDb.transaction((tx) => kairosRulesPass(tx, NOW))

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ada Administración", email: "ada@kairos.test" },
    { id: support.userId, name: "Sofía Soporte", email: "sofia@kairos.test" },
    { id: OWNER, name: "Dueña Riesgo", email: "duena@kairos.test" },
  ])

  // Una clínica con cuenta, sin cliente todavía, que nadie usa: Kairós crea su cliente y la marca en riesgo.
  await insertOrg(ownerDb, RISK_ORG, "kz-riesgo")
  await ownerDb
    .update(organization)
    .set({ createdAt: ago(20) })
    .where(eq(organization.id, RISK_ORG))
  await ownerDb.insert(member).values({
    id: "kz-m1",
    organizationId: RISK_ORG,
    userId: OWNER,
    role: "owner",
    createdAt: ago(20),
  })
  await ownerDb.insert(saasPayment).values({
    organizationId: RISK_ORG,
    amountCents: 2900,
    currency: "USD",
    methodCode: "transferencia",
    status: "rechazado",
    idempotencyKey: "kz-pago-1",
    rejectedAt: ago(2),
    rejectedBy: admin.userId,
    rejectReason: "El abono no aparece",
  })
  await ownerDb.insert(supportCase).values({
    organizationId: RISK_ORG,
    kind: "pregunta",
    question: "¿Cómo cambio el horario?",
    dedupeKey: "kz-caso-1",
    openedBy: OWNER,
    status: "esperando_clinica",
    lastPublicMessageAt: ago(5),
    createdAt: ago(6),
    updatedAt: ago(5),
  })

  // Una demo para presentar nunca es cliente.
  await insertOrg(ownerDb, DEMO_ORG, "kz-demo-org")
  await ownerDb.insert(saasDemo).values({
    organizationId: DEMO_ORG,
    product: "dental",
    kind: "dental",
    size: "pequeno",
    months: 6,
    countryCode: "PE",
    name: "Demo con cuenta",
    slug: "kz-demo-org",
    presenterUserId: admin.userId,
    createdBy: admin.userId,
    seed: 1,
  })

  // (2) Se enfría: venta abierta, sin tarea, el último contacto hace 10 días. Es de Ada.
  const cold = await client("fria", "Clínica Fría (ficticia)", {
    createdAt: ago(20),
    owner: admin.userId,
    phone: "+51987654321",
  })
  await ownerDb.insert(saasFollowUp).values({
    clientId: cold,
    body: "La llamamos",
    kind: "llamada",
    direction: "salio",
    happenedAt: ago(10),
    createdAt: ago(10),
  })

  // (1) Sin próximo paso: recién creada, sin tarea.
  await client("nueva", "Clínica Nueva (ficticia)")

  // (3) Solicitud de la web por responder.
  const web = await client("web", "Clínica Web (ficticia)", { phone: "+51911111111" })
  const [request] = await ownerDb
    .insert(saasWaitlistRequest)
    .values({
      firstName: "Rosa",
      lastName: "Mamani",
      email: "web@kairos.test",
      phone: "+51 911 111 111",
      clinicName: "Clínica Web (ficticia)",
      countryCode: "PE",
      city: "Cusco",
      professionals: "2-3",
      currentTool: "cuaderno_excel",
      clientId: web,
    })
    .returning({ id: saasWaitlistRequest.id })
  ids.request = request?.id ?? ""

  // (5) Propuesta enviada que vence en 2 días (con una tarea abierta: no pide «próximo paso»).
  const plan = await createSaasPlan(ownerDb, admin.userId, {
    code: "kz-plan",
    name: "Plan Kairós",
    currency: "USD",
    priceCents: 2900,
    creditCents: 0,
    conversationMicros: 300_000,
    consultationMicros: 240_000,
    recoveryMicros: 2_400_000,
    maxDiscountBps: 2000,
    sellerDiscountBps: 1000,
    trialCreditCents: 10_000,
    trialMaxCreditCents: 10_000,
    trialDays: 30,
    trialMaxDays: 60,
  })
  const offered = await client("propuesta", "Clínica Propuesta (ficticia)")
  await ownerDb.insert(saasProposal).values({
    clientId: offered,
    version: 1,
    planId: plan.id,
    listPriceCents: 2900,
    currency: "USD",
    validUntil: plusDays(2),
    status: "enviada",
    sentAt: ago(1),
  })
  await ownerDb.insert(saasTask).values({
    clientId: offered,
    kind: "llamar",
    title: "Llamar por la propuesta",
    dueOn: plusDays(1),
  })

  // (6) Dijo «no por ahora» y pidió volver ayer.
  const back = await client("vuelve", "Clínica Vuelve (ficticia)", { open: false })
  await ownerDb.insert(saasOpportunity).values({
    clientId: back,
    decision: "no_por_ahora",
    reason: "no_es_el_momento",
    returnOn: plusDays(-1),
    decidedAt: ago(30),
    decidedBy: admin.userId,
  })

  // (7) Presentación mañana y presentación de hoy con la demo abierta hoy.
  const [tomorrowDemo] = await ownerDb
    .insert(saasDemo)
    .values({
      product: "dental",
      kind: "dental",
      size: "mediano",
      months: 12,
      countryCode: "PE",
      name: "Demo odentIA mediana",
      slug: "kz-demo-manana",
      presenterUserId: admin.userId,
      createdBy: admin.userId,
      seed: 2,
    })
    .returning({ id: saasDemo.id })
  const soon = await client("manana", "Clínica Mañana (ficticia)")
  await ownerDb.insert(saasTask).values({
    clientId: soon,
    kind: "presentacion",
    title: "Presentación",
    dueOn: plusDays(1),
    demoId: tomorrowDemo?.id,
  })
  const [openedDemo] = await ownerDb
    .insert(saasDemo)
    .values({
      product: "dental",
      kind: "dental",
      size: "pequeno",
      months: 6,
      countryCode: "PE",
      name: "Demo odentIA pequeña",
      slug: "kz-demo-hoy",
      presenterUserId: admin.userId,
      createdBy: admin.userId,
      seed: 3,
      openedAt: NOW,
    })
    .returning({ id: saasDemo.id })
  const presented = await client("presento", "Clínica Presentó (ficticia)")
  const [todayTask] = await ownerDb
    .insert(saasTask)
    .values({
      clientId: presented,
      kind: "presentacion",
      title: "Presentación",
      dueOn: TODAY,
      demoId: openedDemo?.id,
    })
    .returning({ id: saasTask.id })
  ids.presentationTask = todayTask?.id ?? ""

  // (8) La skill cargó en el servidor: una clínica con su configuración y un informe que no
  // se sabe si salió, y otra con la configuración cargada y sin informe.
  await insertOrg(ownerDb, LOAD_ORG, "kz-carga")
  const load = await client("carga", "Clínica Carga (ficticia)", {
    open: false,
    organizationId: LOAD_ORG,
  })
  await ownerDb
    .insert(saasOpportunity)
    .values({ clientId: load, decision: "entro", decidedAt: NOW })
  await insertOrg(ownerDb, LOADED_ORG, "kz-cargada")
  const loaded = await client("cargada", "Clínica Cargada (ficticia)", {
    open: false,
    organizationId: LOADED_ORG,
    owner: support.userId,
  })
  await ownerDb
    .insert(saasOpportunity)
    .values({ clientId: loaded, decision: "entro", decidedAt: NOW })
  const setup = { nueva: 20, cambia: 2, igual: 7, planSha256: "c".repeat(64) }
  await ownerDb.insert(adminAudit).values([
    {
      actorUserId: admin.userId,
      actorRole: "admin",
      action: "org.setup_import",
      organizationId: LOAD_ORG,
      metadata: setup,
      createdAt: ago(2),
    },
    {
      actorUserId: admin.userId,
      actorRole: "admin",
      action: PROGRESS_REPORT_ACTIONS.enviando,
      organizationId: LOAD_ORG,
      entityId: "informe-1",
      metadata: { to: "duena@carga.test" },
      createdAt: ago(1),
    },
    {
      actorUserId: admin.userId,
      actorRole: "admin",
      action: PROGRESS_REPORT_ACTIONS.desconocido,
      organizationId: LOAD_ORG,
      entityId: "informe-1",
      metadata: { to: "duena@carga.test" },
      // El correo se cortó un momento después de reservarlo.
      createdAt: new Date(ago(1).getTime() + 1000),
    },
    {
      actorUserId: admin.userId,
      actorRole: "admin",
      action: "org.setup_import",
      organizationId: LOADED_ORG,
      metadata: setup,
      createdAt: ago(1),
    },
    // Una pasada de pacientes que sigue llegando: no cuenta hasta que se queda quieta.
    {
      actorUserId: admin.userId,
      actorRole: "admin",
      action: "org.data_import",
      organizationId: LOADED_ORG,
      metadata: { planSha256: "d".repeat(64), from: 0, creadas: 3 },
      createdAt: new Date(NOW.getTime() - 60_000),
    },
  ])

  // (12) Dos fichas con la misma persona.
  await client("dup1", "Dental Repetida (ficticia)", {
    email: "dup@kairos.test",
    createdAt: ago(3),
  })
  await client("dup2", "Dental Repetida Dos (ficticia)", { email: "dup@kairos.test" })
  // Las que `mergeClients` no fusionaría no se proponen: las dos con cuenta, o de otro producto.
  await insertOrg(ownerDb, "kz-dup-cuenta-1", "kz-dup-cuenta-1")
  await insertOrg(ownerDb, "kz-dup-cuenta-2", "kz-dup-cuenta-2")
  await client("dupCuenta1", "Dental Con Cuenta (ficticia)", {
    email: "dup-cuentas@kairos.test",
    organizationId: "kz-dup-cuenta-1",
    open: false,
    createdAt: ago(3),
  })
  await client("dupCuenta2", "Dental Con Cuenta Dos (ficticia)", {
    email: "dup-cuentas@kairos.test",
    organizationId: "kz-dup-cuenta-2",
    open: false,
  })
  await client("dupProducto1", "Dental De Otro Producto (ficticia)", {
    email: "dup-producto@kairos.test",
    createdAt: ago(3),
  })
  await client("dupProducto2", "Consultorio De Otro Producto (ficticio)", {
    email: "dup-producto@kairos.test",
  })
  await ownerDb
    .update(saasClient)
    .set({ product: "medical" })
    .where(eq(saasClient.id, ids.dupProducto2 as string))

  // (10) Un correo sin cliente y otro de un cliente, sin su actividad.
  const [orphan] = await ownerDb
    .insert(saasInboundEmail)
    .values({
      mailbox: "contacto",
      product: "dental",
      messageId: "<sin-cliente@kairos.test>",
      fromAddress: "alguien@nadie.test",
      fromName: "Alguien",
      toAddress: "contacto@odentia32.com",
      subject: "Quiero información",
      receivedAt: ago(1),
    })
    .returning({ id: saasInboundEmail.id })
  ids.orphanEmail = orphan?.id ?? ""
  await ownerDb.insert(saasInboundEmail).values({
    clientId: ids.nueva,
    mailbox: "contacto",
    product: "dental",
    messageId: "<con-cliente@kairos.test>",
    fromAddress: "nueva@kairos.test",
    toAddress: "contacto@odentia32.com",
    subject: "Una pregunta",
    receivedAt: ago(0.5),
  })

  first = await pass()
})

describe("la pasada de Kairós", () => {
  it("crea el cliente de cada cuenta sin cliente, con su venta entrada; la demo nunca es cliente", async () => {
    expect(first.clientsCreated).toBeGreaterThanOrEqual(1)
    const [risk] = await ownerDb
      .select()
      .from(saasClient)
      .where(eq(saasClient.organizationId, RISK_ORG))
    expect(risk).toMatchObject({ origin: "web", createdBy: null })
    ids.riesgo = risk?.id ?? ""
    const [opportunity] = await ownerDb
      .select()
      .from(saasOpportunity)
      .where(eq(saasOpportunity.clientId, ids.riesgo))
    expect(opportunity?.decision).toBe("entro")
    expect(
      await ownerDb.select().from(saasClient).where(eq(saasClient.organizationId, DEMO_ORG)),
    ).toHaveLength(0)
  })

  it("todo lo que hace queda en la auditoría con actor nulo y una acción kairos.*", async () => {
    const audits = await ownerDb
      .select()
      .from(adminAudit)
      .where(like(adminAudit.action, "kairos.%"))
    expect(audits.length).toBeGreaterThan(0)
    expect(
      audits.every((audit) => audit.actorUserId === null && audit.actorRole === "system"),
    ).toBe(true)
    // Nunca un texto libre en los metadatos.
    expect(JSON.stringify(audits.map((audit) => audit.metadata))).not.toContain(
      "Quiero información",
    )
  })

  it("se enfría: pone una tarea para retomar, la señal queda en lo que hizo, y no otra de «próximo paso»", async () => {
    const tasks = await tasksOf(ids.fria as string)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      byKairos: true,
      kind: "llamar",
      status: "abierta",
      assigneeUserId: admin.userId,
      dueOn: TODAY,
    })
    expect(tasks[0]?.title).toContain("días sin contacto")
    const [signal] = await ownerDb
      .select()
      .from(adminAudit)
      .where(
        and(eq(adminAudit.action, "kairos.signal"), eq(adminAudit.entityId, ids.fria as string)),
      )
    expect(signal?.metadata).toMatchObject({ code: "se_enfria" })
  })

  it("sin próximo paso: una tarea «Llamar» para su responsable, con su clave", async () => {
    const tasks = await tasksOf(ids.nueva as string)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.title).toMatch(/^Llamar a .*: no tiene próximo paso$/)
    expect(tasks[0]?.kairosKey).toMatch(new RegExp(`^sin_proximo_paso:${ids.nueva}:.*:${TODAY}$`))
  })

  it("solicitud por responder: la tarea «Responder» y el borrador de la primera respuesta, por WhatsApp", async () => {
    const tasks = await tasksOf(ids.web as string)
    expect(tasks.map((task) => task.title)).toEqual(["Responder la solicitud de la web"])
    const [message] = await itemsOf(ids.web as string, "mensaje")
    expect(message).toMatchObject({ status: "espera", adminOnly: false })
    expect(message?.payload).toMatchObject({
      goal: "primera_respuesta",
      channel: "whatsapp",
      to: "+51911111111",
      requestId: ids.request,
      draft: null,
    })
    expect(message?.expiresAt.getTime()).toBe(NOW.getTime() + 48 * 3_600_000)
    ids.webItem = message?.id ?? ""
  })

  it("la propuesta que vence pronto: un recordatorio solo para Administración", async () => {
    const [message] = await itemsOf(ids.propuesta as string, "mensaje")
    expect(message).toMatchObject({ adminOnly: true })
    expect(message?.payload).toMatchObject({ goal: "recordar_propuesta" })
    ids.proposalItem = message?.id ?? ""
  })

  it("llegó el día de volver: tarea y mensaje para retomar", async () => {
    expect((await tasksOf(ids.vuelve as string)).map((task) => task.title)).toEqual([
      "Retomar: dijo «no por ahora»",
    ])
    const [message] = await itemsOf(ids.vuelve as string, "mensaje")
    expect(message?.payload).toMatchObject({
      goal: "retomar",
      channel: "correo",
      to: "vuelve@kairos.test",
    })
    ids.backItem = message?.id ?? ""
  })

  it("presentaciones: el guion de la de mañana y, con la demo abierta hoy, la pregunta de si se hizo", async () => {
    const [script] = await itemsOf(ids.manana as string, "guion")
    expect(script?.reason).toContain("Demo odentIA mediana")
    ids.scriptItem = script?.id ?? ""
    const [done] = await itemsOf(ids.presento as string, "presentacion_hecha")
    expect(done?.reason).toContain("Demo odentIA pequeña se abrió hoy")
    expect(done?.payload).toMatchObject({ taskId: ids.presentationTask, outcome: "se_hizo" })
    ids.presentedItem = done?.id ?? ""
  })

  it("lo que cargó la skill: cada carga quieta en «Lo que hizo» con sus cifras y quién; la que sigue llegando, todavía no", async () => {
    const noticed = await ownerDb
      .select({ organizationId: adminAudit.organizationId, metadata: adminAudit.metadata })
      .from(adminAudit)
      .where(eq(adminAudit.action, "kairos.load_noticed"))
    expect(noticed.map((row) => row.organizationId).sort()).toEqual([LOADED_ORG, LOAD_ORG].sort())
    expect(noticed[0]?.metadata).toMatchObject({
      loadKind: "configuracion",
      summary: "20 nuevos · 2 cambiaron · 7 ya estaban",
      by: "Ada Administración",
      adminOnly: true,
    })
  })

  it("se cargó y no hay informe: «Enviar el informe» al responsable; si se intentó, no", async () => {
    const pending = await tasksOf(ids.cargada as string)
    expect(pending.map((task) => [task.title, task.assigneeUserId])).toEqual([
      ["Enviar el informe", support.userId],
    ])
    const urgent = await tasksOf(ids.carga as string)
    expect(urgent.map((task) => task.title)).toEqual(["Revisar en Zoho si salió el informe N.º 1"])
    expect(urgent[0]?.dueAt?.getTime()).toBe(NOW.getTime())
    // En Hoy va arriba y lleva con qué resolverla, solo para Administración.
    const forAdmin = await ownerDb.transaction((tx) =>
      todayForStaff(tx, admin, { who: "todas" }, NOW),
    )
    expect(forAdmin.tasks[0]).toMatchObject({
      clientId: ids.carga,
      report: { organizationId: LOAD_ORG, number: 1, to: "duena@carga.test", canResend: false },
    })
    const forSupport = await ownerDb.transaction((tx) =>
      todayForStaff(tx, support, { who: "todas" }, NOW),
    )
    expect(forSupport.tasks.every((task) => task.report === undefined)).toBe(true)
  })

  it("riesgo: cada señal con su tarea, una vez por hecho; el comprobante, como tarea de cobro", async () => {
    const tasks = await tasksOf(ids.riesgo as string)
    const kinds = tasks.map((task) => task.kind).sort()
    expect(kinds).toEqual(["cobro", "llamar", "otro"])
    const codes = (
      await ownerDb
        .select({ metadata: adminAudit.metadata })
        .from(adminAudit)
        .where(
          and(
            eq(adminAudit.action, "kairos.signal"),
            eq(adminAudit.entityId, ids.riesgo as string),
          ),
        )
    ).map((row) => row.metadata?.code)
    expect(codes.sort()).toEqual(["caso_esperando", "comprobante_rechazado", "sin_sesiones"])
  })

  it("correos: el de un cliente queda como su actividad; el que no es de nadie, para que una persona diga de quién es", async () => {
    const [activity] = await ownerDb
      .select()
      .from(saasFollowUp)
      .where(and(eq(saasFollowUp.clientId, ids.nueva as string), eq(saasFollowUp.kind, "correo")))
    expect(activity).toMatchObject({
      direction: "entro",
      byKairos: true,
      requestId: null,
      body: "Correo recibido: Una pregunta",
    })
    const [orphan] = await itemsOf(null, "correo_sin_cliente")
    expect(orphan?.payload).toMatchObject({ emailId: ids.orphanEmail, from: "alguien@nadie.test" })
    ids.orphanItem = orphan?.id ?? ""
  })

  it("duplicados por correo: solo los marca, para Administración", async () => {
    const [dup] = await itemsOf(ids.dup2 as string, "duplicado")
    expect(dup).toMatchObject({ adminOnly: true })
    expect(dup?.payload).toMatchObject({ keepId: ids.dup1, dropId: ids.dup2 })
    ids.dupItem = dup?.id ?? ""
    // La misma regla que «puede estar repetida»: nada que `mergeClients` rechazaría.
    for (const key of ["dupCuenta1", "dupCuenta2", "dupProducto1", "dupProducto2"])
      expect(await itemsOf(ids[key] as string, "duplicado")).toHaveLength(0)
  })

  it("devuelve lo que necesita redacción del modelo, sin lo que es solo de administración en lo de Soporte", () => {
    const drafts = first.needsDraft.map((draft) => draft.itemId)
    expect(drafts).toEqual(
      expect.arrayContaining([ids.webItem, ids.backItem, ids.scriptItem, ids.proposalItem]),
    )
    const web = first.needsDraft.find((draft) => draft.itemId === ids.webItem)
    expect(web).toMatchObject({
      kind: "mensaje",
      goal: "primera_respuesta",
      channel: "whatsapp",
      adminOnly: false,
    })
    expect(web?.client.name).toBe("Clínica Web (ficticia)")
  })

  it("es idempotente: otra pasada no repite nada", async () => {
    const again = await pass()
    expect(again).toMatchObject({
      clientsCreated: 0,
      clientsLinked: 0,
      activities: 0,
      tasks: 0,
      items: 0,
      signals: 0,
    })
  })
})

describe("lo que espera un sí", () => {
  it("un borrador guardado deja el mensaje listo", async () => {
    expect(
      await ownerDb.transaction((tx) =>
        saveKairosDraft(tx, ids.webItem as string, { body: "Hola Rosa, gracias por escribirnos." }),
      ),
    ).toBe(true)
    const { items } = await listKairosItems(
      ownerDb,
      admin,
      { status: "espera", clientId: ids.web },
      NOW,
    )
    expect(items[0]).toMatchObject({
      id: ids.webItem,
      ready: true,
      clientName: "Clínica Web (ficticia)",
    })
  })

  it("Soporte no ve lo que es solo de administración", async () => {
    const forSupport = await listKairosItems(ownerDb, support, { status: "espera" }, NOW)
    const forAdmin = await listKairosItems(ownerDb, admin, { status: "espera" }, NOW)
    expect(forSupport.items.every((item) => !item.adminOnly)).toBe(true)
    expect(forSupport.items.map((item) => item.id)).not.toContain(ids.dupItem)
    expect(forAdmin.items.map((item) => item.id)).toContain(ids.dupItem)
    expect(forAdmin.total).toBeGreaterThan(forSupport.total)
    await expect(
      decide(support, ids.dupItem as string, { action: "aprobar" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("aprobar un mensaje crea el envío con la misma operación de la pantalla y queda por confirmar hasta que sale", async () => {
    const decision = await decide(support, ids.webItem as string, {
      action: "aprobar",
      edited: { body: "Hola Rosa, te escribo de Sallca." },
    })
    expect(decision.status).toBe("incierta")
    expect(lastCall("prepareOutreach")?.args).toEqual([
      support.userId,
      ids.web,
      expect.objectContaining({
        channel: "whatsapp",
        to: "+51911111111",
        body: "Hola Rosa, te escribo de Sallca.",
        kairosItemId: ids.webItem,
      }),
    ])
    const outreachId = decision.outreach?.id as string
    await ownerDb
      .update(saasOutreach)
      .set({ status: "enviado", sentAt: NOW })
      .where(eq(saasOutreach.id, outreachId))
    expect(await ownerDb.transaction((tx) => settleKairosOutreach(tx, outreachId))).toBe(
      "ejecutada",
    )
    const [item] = await ownerDb
      .select()
      .from(kairosItem)
      .where(eq(kairosItem.id, ids.webItem as string))
    expect(item).toMatchObject({ status: "ejecutada", decidedBy: support.userId })
    expect(item?.result).toMatchObject({ outreachId, outreachStatus: "enviado" })
    await expect(decide(admin, ids.webItem as string, { action: "aprobar" })).rejects.toMatchObject(
      { code: "KAIROS_ITEM_DECIDED", status: 409 },
    )
  })

  it("descartar no lo vuelve a preparar; decidido, no se decide otra vez", async () => {
    const decision = await decide(admin, ids.proposalItem as string, { action: "descartar" })
    expect(decision.status).toBe("descartada")
    await expect(
      decide(admin, ids.proposalItem as string, { action: "descartar" }),
    ).rejects.toMatchObject({ code: "KAIROS_ITEM_DECIDED" })
    await pass()
    expect(await itemsOf(ids.propuesta as string, "mensaje")).toHaveLength(1)
    const [audit] = await ownerDb
      .select()
      .from(adminAudit)
      .where(
        and(
          eq(adminAudit.action, "arm.kairos_item_discarded"),
          eq(adminAudit.entityId, ids.proposalItem as string),
        ),
      )
    expect(audit?.actorUserId).toBe(admin.userId)
  })

  it("si el cliente cambió desde que se preparó, queda vencido y la pasada siguiente lo vuelve a preparar", async () => {
    await ownerDb.insert(saasFollowUp).values({
      clientId: ids.vuelve as string,
      body: "Nos llamó",
      kind: "llamada",
      direction: "entro",
      happenedAt: NOW,
    })
    const before = calls.length
    const decision = await decide(admin, ids.backItem as string, { action: "aprobar" })
    expect(decision).toMatchObject({ status: "vencida" })
    expect(decision.error).toContain("cambió")
    expect(calls.length).toBe(before)
    await pass()
    const items = await itemsOf(ids.vuelve as string, "mensaje")
    expect(items.map((item) => item.status).sort()).toEqual(["espera", "vencida"])
  })

  it("vence a las 48 h aunque nadie lo mire (vencimiento perezoso) y se vuelve a preparar", async () => {
    await ownerDb
      .update(kairosItem)
      .set({ expiresAt: new Date(NOW.getTime() - 1000) })
      .where(eq(kairosItem.id, ids.orphanItem as string))
    await listKairosItems(ownerDb, admin, { status: "espera" }, NOW)
    const [expired] = await ownerDb
      .select()
      .from(kairosItem)
      .where(eq(kairosItem.id, ids.orphanItem as string))
    expect(expired?.status).toBe("vencida")
    await pass()
    const fresh = (await itemsOf(null, "correo_sin_cliente")).find(
      (item) => item.status === "espera",
    )
    expect(fresh).toBeDefined()
    ids.orphanItem = fresh?.id ?? ""
  })

  it("asignar un correo pide el cliente; con él, usa la operación de los correos", async () => {
    await expect(
      decide(support, ids.orphanItem as string, { action: "aprobar" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { "edited.clientId": expect.any(String) },
    })
    const [still] = await ownerDb
      .select()
      .from(kairosItem)
      .where(eq(kairosItem.id, ids.orphanItem as string))
    expect(still?.status).toBe("espera")
    const decision = await decide(support, ids.orphanItem as string, {
      action: "aprobar",
      edited: { clientId: ids.nueva },
    })
    expect(decision.status).toBe("ejecutada")
    expect(lastCall("assignInboundEmail")?.args).toEqual([
      support.userId,
      ids.orphanEmail,
      ids.nueva,
    ])
  })

  it("solo deja cambiar lo que ese tipo permite", async () => {
    await expect(
      decide(admin, ids.scriptItem as string, { action: "aprobar", edited: { body: "otro" } }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { "edited.body": expect.any(String) },
    })
    expect((await decide(admin, ids.scriptItem as string, { action: "aprobar" })).status).toBe(
      "ejecutada",
    )
  })

  it("«Sí, anotar» una presentación usa la operación de las presentaciones", async () => {
    const decision = await decide(support, ids.presentedItem as string, { action: "aprobar" })
    expect(decision.status).toBe("ejecutada")
    expect(lastCall("recordPresentation")?.args).toEqual([
      support.userId,
      ids.presentationTask,
      expect.objectContaining({
        outcome: "se_hizo",
        body: expect.stringContaining("Demo odentIA pequeña"),
      }),
    ])
  })

  it("si la operación dice que ya no se puede, queda fallida con su motivo y lo que hizo se deshace", async () => {
    const failing: KairosExecutors = {
      ...executors,
      async updateClient(tx) {
        await tx
          .update(saasClient)
          .set({ city: "Deshecha" })
          .where(eq(saasClient.id, ids.carga as string))
        throw new ServiceError("CLIENT_ARCHIVED", 409, "Ese cliente está archivado")
      },
    }
    const [data] = await ownerDb
      .insert(kairosItem)
      .values({
        clientId: ids.carga,
        kind: "dato",
        title: "Completar la ciudad",
        reason: "Lo dijo en la llamada",
        payload: { fields: { city: "Arequipa" } },
        expectedState: { data: { city: null, professionals: null, current_tool: null } },
        idempotencyKey: "kz:dato-falla",
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      })
      .returning({ id: kairosItem.id })
    const decision = await decide(admin, data?.id as string, { action: "aprobar" }, failing)
    expect(decision).toMatchObject({ status: "fallida", error: "Ese cliente está archivado" })
    const [loaded] = await ownerDb
      .select({ city: saasClient.city })
      .from(saasClient)
      .where(eq(saasClient.id, ids.carga as string))
    expect(loaded?.city).toBeNull()
  })

  it("lo que solo aprueba Administración no lo aprueba Soporte, aunque lo vea", async () => {
    const [contact] = await ownerDb
      .select()
      .from(saasClientContact)
      .where(eq(saasClientContact.clientId, ids.carga as string))
    const [link] = await ownerDb
      .insert(kairosItem)
      .values({
        clientId: ids.carga,
        kind: "vinculo",
        title: "Ligar a la dueña",
        reason: "Su correo es el de su usuario",
        payload: { contactId: contact?.id, userId: OWNER },
        expectedState: { contactUser: null },
        idempotencyKey: "kz:vinculo",
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      })
      .returning({ id: kairosItem.id })
    await expect(decide(support, link?.id as string, { action: "aprobar" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    })
    expect((await decide(admin, link?.id as string, { action: "aprobar" })).status).toBe(
      "ejecutada",
    )
    expect(lastCall("linkContactToUser")?.args).toEqual([admin.userId, contact?.id, OWNER])
  })

  it("un dato solo completa lo vacío, con la operación de la ficha", async () => {
    const [data] = await ownerDb
      .insert(kairosItem)
      .values({
        clientId: ids.nueva,
        kind: "dato",
        title: "Completar la ciudad",
        reason: "Lo dijo en la llamada",
        payload: { fields: { city: "Arequipa", professionals: "2-3" } },
        expectedState: { data: { city: null, professionals: null, current_tool: null } },
        idempotencyKey: "kz:dato",
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      })
      .returning({ id: kairosItem.id })
    expect((await decide(support, data?.id as string, { action: "aprobar" })).status).toBe(
      "ejecutada",
    )
    expect(lastCall("updateClient")?.args).toEqual([
      support.userId,
      ids.nueva,
      { city: "Arequipa", professionals: "2-3" },
    ])
  })
})

describe("lo que hizo", () => {
  it("en frases, con Deshacer en sus tareas abiertas; Soporte no ve lo de cobro ni lo solo de administración", async () => {
    const forAdmin = await kairosDone(ownerDb, admin, { limit: 200 })
    const forSupport = await kairosDone(ownerDb, support, { limit: 200 })
    const coldTask = forAdmin.find(
      (entry) => entry.clientId === ids.fria && entry.words.startsWith("Puso la tarea"),
    )
    expect(coldTask?.undo).toMatchObject({ kind: "cancelar_tarea" })
    expect(forAdmin.some((entry) => entry.words.startsWith("Creó el cliente"))).toBe(true)
    expect(forAdmin.some((entry) => entry.words.includes("Hablar del comprobante rechazado"))).toBe(
      true,
    )
    expect(
      forSupport.some((entry) => entry.words.includes("Hablar del comprobante rechazado")),
    ).toBe(false)
    expect(
      forAdmin.some(
        (entry) =>
          entry.words ===
          "Se cargó la configuración de Clínica Carga (ficticia): 20 nuevos · 2 cambiaron · 7 ya estaban (lo cargó Ada Administración)",
      ),
    ).toBe(true)
    expect(forSupport.some((entry) => entry.words.startsWith("Se cargó"))).toBe(false)
    expect(forAdmin.every((entry) => !entry.words.includes("kairos."))).toBe(true)
  })
})

describe("el informe que no se sabe si salió", () => {
  it("cuando queda enviado, la tarea urgente se cierra sola, Kairós lo cuenta y no la vuelve a poner", async () => {
    await ownerDb.insert(adminAudit).values({
      actorUserId: admin.userId,
      actorRole: "admin",
      action: PROGRESS_REPORT_ACTIONS.enviado,
      organizationId: LOAD_ORG,
      entityId: "informe-1",
      metadata: { to: "duena@carga.test", sentAt: ago(1).toISOString() },
      createdAt: NOW,
    })
    const later = new Date(NOW.getTime() + 60_000)
    expect(await ownerDb.transaction((tx) => settleReportTasks(tx, LOAD_ORG, later))).toBe(1)
    const [task] = await tasksOf(ids.carga as string)
    expect(task).toMatchObject({
      status: "hecha",
      doneNote: "Kairós la cerró: salió el informe N.º 1",
    })
    await ownerDb.transaction((tx) => kairosRulesPass(tx, later))
    expect((await tasksOf(ids.carga as string)).map((row) => row.status)).toEqual(["hecha"])
    const done = await kairosDone(ownerDb, admin, { limit: 200 })
    expect(done.map((entry) => entry.words)).toEqual(
      expect.arrayContaining([
        "Salió el informe N.º 1 de Clínica Carga (ficticia) a duena@carga.test",
        "Cerró la tarea «Revisar en Zoho si salió el informe N.º 1»: salió el informe N.º 1",
      ]),
    )
  })
})

describe("Hoy", () => {
  it("lo listo de Kairós, las tareas (mías o todas), quién se enfría y quién está en riesgo, cada fila con su por qué", async () => {
    const all = await ownerDb.transaction((tx) => todayForStaff(tx, admin, { who: "todas" }, NOW))
    expect(all.today).toBe(TODAY)
    expect(all.kairosReady.items.length).toBeLessThanOrEqual(5)
    expect(all.kairosReady.items.every((item) => item.ready && item.status === "espera")).toBe(true)
    expect(all.tasks.some((task) => task.clientId === ids.nueva)).toBe(true)
    expect(all.tasks.every((task) => task.why.length > 0)).toBe(true)
    const mine = await ownerDb.transaction((tx) => todayForStaff(tx, admin, { who: "mias" }, NOW))
    expect(mine.tasks.map((task) => task.clientId)).toEqual([ids.fria])
    expect(mine.tasks[0]?.why).toContain("La puso Kairós")
    const cold = all.cooling.find((row) => row.clientId === ids.fria)
    expect(cold?.why).toContain("días sin contacto")
    const risk = all.atRisk.find((row) => row.clientId === ids.riesgo)
    expect(risk?.why).toContain("Se rechazó su comprobante")
    expect(risk?.why).toContain("Nadie de la clínica entró todavía")
  })

  it("a Soporte: sin las tareas de cobro, sin el comprobante, sin precios que vencen", async () => {
    const today = await ownerDb.transaction((tx) =>
      todayForStaff(tx, support, { who: "todas" }, NOW),
    )
    expect(today.tasks.some((task) => task.kind === "cobro")).toBe(false)
    const risk = today.atRisk.find((row) => row.clientId === ids.riesgo)
    expect(risk?.why).not.toContain("comprobante")
    expect(risk?.why).toContain("Un caso de soporte espera a la clínica")
    expect(today.expiring).toEqual([])
    expect(today.kairosReady.items.every((item) => !item.adminOnly)).toBe(true)
  })

  it("las filas de antes llevan su cliente y su por qué", async () => {
    // El envío del doble no anota una actividad: la solicitud sigue por responder.
    const today = await ownerDb.transaction((tx) => todayForStaff(tx, admin, { who: "todas" }, NOW))
    const prospect = today.prospects.find((row) => row.id === ids.request)
    expect(prospect).toMatchObject({ clientId: ids.web })
    expect(prospect?.why).toMatch(/^Respon/)
    for (const row of [...today.prospects, ...today.support, ...today.owners, ...today.expiring])
      expect(row.why.length).toBeGreaterThan(0)
  })
})

describe("gasto del modelo", () => {
  it("se anota como gasto de Sallca y rechaza lo que no es válido", async () => {
    const { id } = await recordKairosAiUse(ownerDb, {
      purpose: "borrador",
      model: "claude-test",
      inputTokens: 1200,
      outputTokens: 300,
      cachedTokens: 0,
      costMicros: null,
      clientId: ids.web,
    })
    const [row] = await ownerDb.select().from(kairosAiUsage).where(eq(kairosAiUsage.id, id))
    expect(row).toMatchObject({
      purpose: "borrador",
      inputTokens: 1200,
      costMicros: null,
      clientId: ids.web,
    })
    await expect(
      recordKairosAiUse(ownerDb, { purpose: "otra" as "borrador", model: "x" }),
    ).rejects.toMatchObject({ fields: { purpose: expect.any(String) } })
    await expect(
      recordKairosAiUse(ownerDb, { purpose: "resumen", model: "x", inputTokens: -1 }),
    ).rejects.toMatchObject({
      fields: { inputTokens: expect.any(String) },
    })
  })
})
