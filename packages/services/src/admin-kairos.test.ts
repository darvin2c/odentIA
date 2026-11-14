import {
  kairosAiUsage,
  kairosItem,
  saasClient,
  saasClientContact,
  saasClientFile,
  saasClientMilestone,
  saasInboundEmail,
  saasOpportunity,
  saasOutreach,
  saasProposal,
  saasTask,
} from "@odentia/db/schema/admin-arm"
import { adminAudit, adminStaff } from "@odentia/db/schema/admin-core"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { supportCase } from "@odentia/db/schema/admin-support"
import { invitation, member, organization, user } from "@odentia/db/schema/auth"
import {
  saasFollowUp,
  saasPayment,
  saasPlan,
  saasSubscription,
  saasWaitlistRequest,
} from "@odentia/db/schema/saas-billing"
import { and, eq, like, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { cargaDeleteAfter, markClientFileCarga } from "./admin-client-files.js"
import type { AdminActor } from "./admin-core.js"
import {
  decideKairosItem,
  type KairosExecutors,
  type KairosPassResult,
  kairosCoolingRows,
  kairosDone,
  kairosDonePage,
  kairosRulesPass,
  listKairosItems,
  recordKairosAiUse,
  saveKairosDraft,
  settleKairosOutreach,
  settleReportTasks,
  todayForStaff,
} from "./admin-kairos.js"
import { pendingKairosDraftJobs } from "./admin-kairos-drafts.js"
import { listClinicLoads, PROGRESS_REPORT_ACTIONS } from "./clinic-progress-report.js"
import { ServiceError } from "./errors.js"
import { limaDate } from "./peru-business-days.js"
import { createSaasPlan } from "./saas-billing.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Kairós: las reglas de cada pasada, lo que espera un sí, «Lo que hizo» y Hoy, con Postgres real. */
setupTestDb()
const admin: AdminActor = { userId: "kz-admin", role: "admin" }
const support: AdminActor = { userId: "kz-support", role: "support" }
const OWNER = "kz-owner"
/** Quien carga en las clínicas del alta (de Administración) y una que ya no está en el equipo. */
const LOADER = "kz-alta-cargadora"
const GONE = "kz-alta-inactiva"
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
  async prepareEmailReply(_tx, actor, emailId, input) {
    calls.push({ op: "prepareEmailReply", args: [actor.userId, emailId, input] })
    return { id: "00000000-0000-4000-8000-000000000001" }
  },
  async recordPresentation(_tx, actor, taskId, input) {
    calls.push({ op: "recordPresentation", args: [actor.userId, taskId, input] })
  },
  async createProposal(_tx, actor, clientId, input) {
    calls.push({ op: "createProposal", args: [actor.userId, clientId, input] })
    return { id: "00000000-0000-4000-8000-000000000000" }
  },
  // La operación real de Documentos: la marca de verdad.
  async markClientFileCarga(tx, actor, fileId) {
    calls.push({ op: "markClientFileCarga", args: [actor.userId, fileId] })
    return markClientFileCarga(tx, actor, fileId, NOW)
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

/* ---------- El alta: clínicas propias (kz-alta-*), para no tocar los conteos de arriba ---------- */

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
let fileSeq = 0

/** Un archivo del cliente: un adjunto (`correo`), lo marcado como la carga o la carta. */
async function clientFile(
  clientId: string,
  kind: "correo" | "archivo_clinica" | "carta",
  filename: string,
  contentType: string,
  options: { receivedAt: Date; deletedAt?: Date; deleteAfter?: string | null; cargaAt?: Date },
): Promise<string> {
  fileSeq += 1
  const [row] = await ownerDb
    .insert(saasClientFile)
    .values({
      clientId,
      kind,
      filename,
      objectKey: `clients/${clientId}/kz-alta-${fileSeq}`,
      contentType,
      sizeBytes: 10,
      receivedAt: options.receivedAt,
      createdAt: options.receivedAt,
      deleteAfter:
        options.deleteAfter !== undefined
          ? options.deleteAfter
          : kind === "archivo_clinica"
            ? cargaDeleteAfter(options.receivedAt, NOW)
            : null,
      cargaAt: kind === "archivo_clinica" ? (options.cargaAt ?? options.receivedAt) : null,
      deletedAt: options.deletedAt ?? null,
    })
    .returning({ id: saasClientFile.id })
  if (!row) throw new Error("sin archivo")
  return row.id
}

/** Una clínica con cuenta, su cliente (sin venta abierta) y, si se pide, su propietaria. */
async function altaClient(
  key: string,
  options: { owner?: string; ownerMember?: Date } = {},
): Promise<string> {
  const org = `kz-alta-${key}`
  await insertOrg(ownerDb, org, org)
  const id = await client(`alta-${key}`, `Clínica Alta ${key} (ficticia)`, {
    open: false,
    organizationId: org,
    ...(options.owner ? { owner: options.owner } : {}),
  })
  ids[`alta-${key}`] = id
  if (options.ownerMember) {
    await ownerDb.insert(user).values({
      id: `${org}-duena`,
      name: `Dueña ${key}`,
      email: `${org}@kairos.test`,
    })
    await ownerDb.insert(member).values({
      id: `${org}-m`,
      organizationId: org,
      userId: `${org}-duena`,
      role: "owner",
      createdAt: options.ownerMember,
    })
  }
  return id
}

/** Un paso ya guardado hace tiempo (así el alta lleva días sin avanzar). */
async function milestone(clientId: string, step: string, at: Date): Promise<void> {
  await ownerDb
    .insert(saasClientMilestone)
    .values({ clientId, step, reachedAt: at, source: "hecho", createdAt: at, updatedAt: at })
}

async function seedAlta(): Promise<void> {
  // E4: lo que llegó por correo a un cliente (sin cuenta todavía).
  const posible = await client("alta-posible", "Clínica Alta Posible (ficticia)", { open: false })
  ids.fileXlsx = await clientFile(posible, "correo", "pacientes.xlsx", XLSX, { receivedAt: ago(3) })
  ids.fileCsv = await clientFile(posible, "correo", "pacientes.csv", "text/csv", {
    receivedAt: ago(5),
  })
  ids.fileDocx = await clientFile(posible, "correo", "datos.docx", DOCX, { receivedAt: ago(1) })
  ids.filePdf = await clientFile(posible, "correo", "contrato.pdf", "application/pdf", {
    receivedAt: ago(2),
  })
  ids.fileJpg = await clientFile(posible, "correo", "captura.jpg", "image/jpeg", {
    receivedAt: ago(2),
  })
  ids.fileLate = await clientFile(posible, "correo", "lista.xlsx", XLSX, { receivedAt: ago(26) })
  ids.fileOld = await clientFile(posible, "correo", "vieja.xlsx", XLSX, { receivedAt: ago(31) })
  // Lo que estaba programado para borrarse antes del cambio: se sugiere una vez, aunque sea un PDF.
  ids.fileLifted = await clientFile(posible, "correo", "escaneo.pdf", "application/pdf", {
    receivedAt: ago(40),
  })
  await ownerDb.insert(adminAudit).values({
    actorRole: "system",
    action: "client_file.retention_lifted",
    entityId: ids.fileLifted,
    metadata: { clientId: posible },
  })

  // E5: marcada hace 3 días sin cargar (antes cargó Carla); otra a 4 días de borrarse; otra
  // que se borró a los 30 días sin cargar (con su tarea abierta); y una borrada a mano.
  const plazo = await altaClient("plazo", { owner: support.userId })
  await ownerDb.insert(adminAudit).values({
    actorUserId: LOADER,
    actorRole: "admin",
    action: "org.setup_import",
    organizationId: "kz-alta-plazo",
    metadata: { nueva: 3, planSha256: "e".repeat(64) },
    createdAt: ago(10),
  })
  ids.filePlazo = await clientFile(plazo, "archivo_clinica", "carga.xlsx", XLSX, {
    receivedAt: ago(3),
  })
  const borra = await altaClient("borra", { owner: support.userId })
  await clientFile(borra, "archivo_clinica", "carga.xlsx", XLSX, { receivedAt: ago(26) })
  const borrado = await altaClient("borrado", { owner: support.userId })
  ids.fileBorrado = await clientFile(borrado, "archivo_clinica", "carga.xlsx", XLSX, {
    receivedAt: ago(31),
    deletedAt: new Date(NOW.getTime() - 3_600_000),
  })
  await ownerDb.insert(saasTask).values({
    clientId: borrado,
    kind: "alta",
    title: `Cargar los datos de Clínica Alta borrado (ficticia)`,
    dueOn: plusDays(-5),
    byKairos: true,
    adminOnly: true,
    kairosKey: `carga_pendiente:${borrado}:${ids.fileBorrado}:${plusDays(-5)}`,
  })
  const manual = await altaClient("manual", { owner: support.userId })
  await clientFile(manual, "archivo_clinica", "carga.xlsx", XLSX, {
    receivedAt: ago(10),
    deletedAt: NOW,
  })

  // E6: la configuración con 3 que no entraron y una tanda de pacientes con 1; y otra que
  // cargó alguien que ya no está en el equipo.
  await altaClient("errores", { owner: support.userId })
  await ownerDb.insert(adminAudit).values([
    {
      actorUserId: LOADER,
      actorRole: "admin",
      action: "org.setup_import",
      organizationId: "kz-alta-errores",
      metadata: { nueva: 5, error: 3, planSha256: "f".repeat(64) },
      createdAt: ago(1),
    },
    {
      actorUserId: LOADER,
      actorRole: "admin",
      action: "org.data_import",
      organizationId: "kz-alta-errores",
      metadata: { planSha256: "1".repeat(64), from: 0, creadas: 4, errores: 1 },
      createdAt: ago(1),
    },
  ])
  await altaClient("inactiva", { owner: LOADER })
  await ownerDb.insert(adminAudit).values({
    actorUserId: GONE,
    actorRole: "admin",
    action: "org.setup_import",
    organizationId: "kz-alta-inactiva",
    metadata: { nueva: 2, error: 2, planSha256: "2".repeat(64) },
    createdAt: ago(1),
  })

  // E9: la propietaria invitada hace 3 días; el equipo con una invitación vencida; la prueba
  // que termina en 5 días, otra en 8 y otra pagada; el pago revertido.
  const duena = await altaClient("duena", { owner: support.userId })
  await ownerDb.insert(invitation).values({
    id: "kz-alta-inv-duena",
    organizationId: "kz-alta-duena",
    email: "duena@alta.test",
    role: "owner",
    status: "pending",
    expiresAt: new Date(NOW.getTime() + 2 * DAY),
    createdAt: ago(3),
    inviterId: admin.userId,
  })
  // Lleva días sin avanzar, pero lo de la propietaria ya lo cubre su recordatorio.
  await milestone(duena, "contrato", ago(10))
  await altaClient("equipo", { owner: support.userId, ownerMember: ago(9) })
  await ownerDb.insert(invitation).values({
    id: "kz-alta-inv-equipo",
    organizationId: "kz-alta-equipo",
    email: "asistente@alta.test",
    role: "member",
    status: "pending",
    expiresAt: ago(1),
    createdAt: ago(8),
    inviterId: "kz-alta-equipo-duena",
  })
  await altaClient("prueba", { owner: LOADER })
  await altaClient("prueba8", { owner: LOADER })
  await altaClient("pagada", { owner: LOADER })
  // Toda cuenta nace con su prueba (el disparador de la base): se mueve su fin.
  for (const [org, days] of [
    ["kz-alta-prueba", 5],
    ["kz-alta-prueba8", 8],
    ["kz-alta-pagada", 3],
  ] as const)
    await ownerDb
      .update(saasSubscription)
      .set({ status: "prueba", trialEndsAt: new Date(NOW.getTime() + days * DAY) })
      .where(eq(saasSubscription.organizationId, org))
  await altaClient("revertido", { owner: LOADER })
  await ownerDb.insert(saasPayment).values([
    {
      organizationId: "kz-alta-pagada",
      amountCents: 2900,
      currency: "USD",
      methodCode: "transferencia",
      status: "confirmado",
      idempotencyKey: "kz-alta-pago-1",
      confirmedAt: ago(2),
      confirmedBy: admin.userId,
    },
    {
      organizationId: "kz-alta-revertido",
      amountCents: 2900,
      currency: "USD",
      methodCode: "transferencia",
      status: "reversado",
      idempotencyKey: "kz-alta-pago-2",
      confirmedAt: ago(10),
      confirmedBy: admin.userId,
      reversedAt: ago(2),
      reversedBy: admin.userId,
      reverseReason: "El abono se devolvió",
    },
  ])

  // Trabadas: una a la que le toca a la clínica (el contrato) y otra que espera a Meta.
  const trabada = await altaClient("trabada", { owner: support.userId, ownerMember: ago(10) })
  await milestone(trabada, "entro", ago(10))
  const meta = await altaClient("meta", { owner: support.userId, ownerMember: ago(20) })
  for (const step of [
    "entro",
    "contrato",
    "carta",
    "archivos",
    "configuracion",
    "pacientes",
    "informe",
    "equipo",
  ])
    await milestone(meta, step, ago(20))

  // La carta salió hace 8 días y llegó un correo con adjuntos: eso no calla el pedido.
  const carta = await altaClient("carta", { owner: support.userId })
  await clientFile(carta, "carta", "carta.pdf", "application/pdf", { receivedAt: ago(8) })
  await ownerDb.insert(saasInboundEmail).values({
    clientId: carta,
    mailbox: "soporte",
    product: "dental",
    messageId: "<kz-alta-carta@kairos.test>",
    fromAddress: "alta-carta@kairos.test",
    toAddress: "soporte@odentia32.com",
    subject: "Unas fotos",
    receivedAt: ago(2),
    attachments: [{ filename: "foto.jpg", contentType: "image/jpeg", size: 3, fileId: null }],
  })
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ada Administración", email: "ada@kairos.test" },
    { id: support.userId, name: "Sofía Soporte", email: "sofia@kairos.test" },
    { id: OWNER, name: "Dueña Riesgo", email: "duena@kairos.test" },
    { id: LOADER, name: "Carla Cargadora", email: "carla@kairos.test" },
    { id: GONE, name: "Inés Inactiva", email: "ines@kairos.test" },
  ])
  // A quién van las tareas: solo a quien está activo en el equipo (y, si es solo de
  // Administración, a quien es de Administración).
  await ownerDb.insert(adminStaff).values([
    { userId: admin.userId, role: "admin" },
    { userId: support.userId, role: "support" },
    { userId: LOADER, role: "admin" },
    { userId: GONE, role: "admin", active: false },
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
  // A la dirección de una persona del equipo, sin cliente.
  const [toPerson] = await ownerDb
    .insert(saasInboundEmail)
    .values({
      mailbox: "persona",
      product: "dental",
      messageId: "<a-una-persona@kairos.test>",
      fromAddress: "otra@nadie.test",
      toAddress: "ana.torres@odentia32.com",
      subject: "Para Ana",
      receivedAt: ago(1),
      // Trae un Excel: la sugerencia dice que puede ser la carga.
      attachments: [{ filename: "pacientes.xlsx", contentType: "text/csv", size: 3, fileId: null }],
    })
    .returning({ id: saasInboundEmail.id })
  ids.personEmail = toPerson?.id ?? ""

  await seedAlta()
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
    // Las de las clínicas del alta (kz-alta-*) se miran abajo.
    const noticed = (
      await ownerDb
        .select({ organizationId: adminAudit.organizationId, metadata: adminAudit.metadata })
        .from(adminAudit)
        .where(eq(adminAudit.action, "kairos.load_noticed"))
    ).filter((row) => !row.organizationId?.startsWith("kz-alta-"))
    expect(noticed.map((row) => row.organizationId).sort()).toEqual([LOADED_ORG, LOAD_ORG].sort())
    expect(noticed[0]?.metadata).toMatchObject({
      loadKind: "configuracion",
      summary: "20 nuevos · 2 cambiaron · 7 ya estaban",
      by: "Ada Administración",
      adminOnly: true,
    })
  })

  it("se cargó y no hay informe: «Enviar el informe» a quien cargó (su responsable es de Soporte); si se intentó, no", async () => {
    const pending = await tasksOf(ids.cargada as string)
    expect(pending.map((task) => [task.title, task.assigneeUserId])).toEqual([
      ["Enviar el informe", admin.userId],
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
    // Las dos son solo de Administración: Soporte no las ve, aunque sea el responsable.
    expect([...pending, ...urgent].every((task) => task.adminOnly)).toBe(true)
    const forSupport = await ownerDb.transaction((tx) =>
      todayForStaff(tx, support, { who: "todas" }, NOW),
    )
    expect(forSupport.tasks.every((task) => task.report === undefined)).toBe(true)
    expect(
      forSupport.tasks.some((task) => task.clientId === ids.cargada || task.clientId === ids.carga),
    ).toBe(false)
    const supportDone = await kairosDone(ownerDb, support, { limit: 200 })
    expect(supportDone.some((entry) => entry.words.includes("Enviar el informe"))).toBe(false)
    expect(
      (await kairosDone(ownerDb, admin, { limit: 200 })).some((entry) =>
        entry.words.includes("Enviar el informe"),
      ),
    ).toBe(true)
  })

  it("riesgo: cada señal con su tarea, una vez por hecho; el comprobante, como tarea de cobro", async () => {
    const tasks = await tasksOf(ids.riesgo as string)
    const kinds = tasks.map((task) => task.kind).sort()
    expect(kinds).toEqual(["cobro", "llamar", "otro"])
    // La de cobro queda marcada solo de Administración; las otras, no.
    expect(tasks.filter((task) => task.adminOnly).map((task) => task.kind)).toEqual(["cobro"])
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
      // Llegó a contacto@: es comercial, Soporte no lo ve.
      adminOnly: true,
    })
    const orphans = await itemsOf(null, "correo_sin_cliente")
    const orphan = orphans.find((item) => item.payload.emailId === ids.orphanEmail)
    expect(orphan?.payload).toMatchObject({ emailId: ids.orphanEmail, from: "alguien@nadie.test" })
    // Lo comercial es solo de Administración, y dice que el remitente no está verificado.
    expect(orphan?.adminOnly).toBe(true)
    expect(orphan?.reason).toContain("de un remitente no verificado")
    // La dirección real de la persona, no «persona@».
    const toPerson = orphans.find((item) => item.payload.emailId === ids.personEmail)
    expect(toPerson?.reason).toContain("Llegó a ana.torres@ de odentIA")
    expect(toPerson?.reason).toContain("puede ser la carga de datos")
    expect(orphan?.reason).not.toContain("carga")
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

  it("lo que espera redacción del modelo lo pide la pasada de borradores, con su ítem", async () => {
    const jobs = await ownerDb.transaction((tx) => pendingKairosDraftJobs(tx, { limit: 50 }, NOW))
    expect(jobs.map((job) => job.itemId)).toEqual(
      expect.arrayContaining([ids.webItem, ids.backItem, ids.scriptItem, ids.proposalItem]),
    )
    const web = jobs.find((job) => job.itemId === ids.webItem)
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
      (item) => item.status === "espera" && item.payload.emailId === ids.orphanEmail,
    )
    expect(fresh).toBeDefined()
    ids.orphanItem = fresh?.id ?? ""
  })

  it("asignar un correo pide el cliente; con él, usa la operación de los correos", async () => {
    // Llegó a contacto@: para Soporte no existe.
    await expect(
      decide(support, ids.orphanItem as string, { action: "aprobar" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      decide(admin, ids.orphanItem as string, { action: "aprobar" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { "edited.clientId": expect.any(String) },
    })
    const [still] = await ownerDb
      .select()
      .from(kairosItem)
      .where(eq(kairosItem.id, ids.orphanItem as string))
    expect(still?.status).toBe("espera")
    const decision = await decide(admin, ids.orphanItem as string, {
      action: "aprobar",
      edited: { clientId: ids.nueva },
    })
    expect(decision.status).toBe("ejecutada")
    expect(lastCall("assignInboundEmail")?.args).toEqual([admin.userId, ids.orphanEmail, ids.nueva])
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
    // Ningún código de acción a la vista (los correos de prueba son @kairos.test: esos sí).
    expect(
      forAdmin.every(
        (entry) => !entry.words.replace(/[\w.+-]+@kairos\.test/g, "").includes("kairos."),
      ),
    ).toBe(true)
  })

  it("lo repetido de una misma pasada va en una frase, con cada ficha y su Deshacer adentro", async () => {
    const passAt = new Date(NOW.getTime() - 3 * 86_400_000)
    const summary = (key: string, at: Date, pass: Date | null) => ({
      actorUserId: null,
      actorRole: "system",
      action: "kairos.summary_written",
      entityId: ids[key] as string,
      metadata: {
        clientId: ids[key] as string,
        sources: 2,
        ...(pass ? { passAt: pass.toISOString() } : {}),
      },
      createdAt: at,
    })
    await ownerDb.insert(adminAudit).values([
      // Una pasada: cada resumen en su transacción, segundos después.
      summary("fria", new Date(passAt.getTime() + 1_000), passAt),
      summary("nueva", new Date(passAt.getTime() + 2_000), passAt),
      summary("web", new Date(passAt.getTime() + 3_000), passAt),
      // Otra pasada, el día anterior: va aparte.
      summary("propuesta", new Date(passAt.getTime() - 86_400_000), null),
    ])
    const page = await kairosDonePage(ownerDb, admin, {
      limit: 200,
      before: new Date(passAt.getTime() + 60_000),
    })
    const grouped = page.items.filter((entry) => entry.words.startsWith("Resumió"))
    expect(grouped.map((entry) => entry.words)).toEqual([
      "Resumió 3 fichas: Clínica Web (ficticia), Clínica Nueva (ficticia) y Clínica Fría (ficticia)",
      "Resumió la ficha de Clínica Propuesta (ficticia)",
    ])
    expect(grouped[0]?.members?.map((member) => member.clientId)).toEqual([
      ids.web,
      ids.nueva,
      ids.fria,
    ])
    expect(grouped[0]).toMatchObject({ clientId: null, undo: null })
    expect(grouped[1]?.members).toBeUndefined()
    // La lista de siempre no agrupa.
    const raw = await kairosDone(ownerDb, admin, {
      limit: 200,
      before: new Date(passAt.getTime() + 60_000),
    })
    expect(raw.filter((entry) => entry.words.startsWith("Resumió"))).toHaveLength(4)
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
    // La suya y «Enviar el informe», que va a quien cargó.
    expect(mine.tasks.map((task) => task.clientId).sort()).toEqual(
      [ids.fria as string, ids.cargada as string].sort(),
    )
    expect(mine.tasks.every((task) => task.why.includes("La puso Kairós"))).toBe(true)
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
    // Las de Soporte siguen ahí.
    expect(today.tasks.some((task) => task.clientId === ids.nueva)).toBe(true)
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

describe("lo que encontró la revisión", () => {
  it("la propuesta que vence no se recuerda a una venta perdida ni a una clínica con cuenta; y si se cerró después, no se aprueba", async () => {
    const [plan] = await ownerDb
      .select({ id: saasPlan.id })
      .from(saasPlan)
      .where(eq(saasPlan.code, "kz-plan"))
    const proposalFor = async (clientId: string) => {
      const [row] = await ownerDb
        .insert(saasProposal)
        .values({
          clientId,
          version: 1,
          planId: plan?.id ?? "",
          listPriceCents: 2900,
          currency: "USD",
          validUntil: plusDays(2),
          status: "enviada",
          sentAt: ago(1),
        })
        .returning({ id: saasProposal.id })
      return row?.id ?? ""
    }
    const lost = await client("vence-perdida", "Clínica Vence Perdida (ficticia)", {
      open: false,
      createdAt: ago(10),
    })
    await ownerDb.insert(saasOpportunity).values({
      clientId: lost,
      decision: "perdido",
      reason: "precio",
      decidedAt: NOW,
      createdAt: ago(10),
    })
    await proposalFor(lost)
    await insertOrg(ownerDb, "kz-vence-cuenta", "kz-vence-cuenta")
    const withAccount = await client("vence-cuenta", "Clínica Vence Con Cuenta (ficticia)", {
      organizationId: "kz-vence-cuenta",
      createdAt: ago(10),
    })
    await proposalFor(withAccount)
    // Una que sí estaba viva cuando se preparó y se perdió después.
    const later = await client("vence-despues", "Clínica Vence Después (ficticia)", {
      createdAt: ago(10),
    })
    await proposalFor(later)
    await pass()
    const reminder = async (clientId: string) =>
      (await itemsOf(clientId, "mensaje")).find(
        (item) => (item.payload as { goal?: string }).goal === "recordar_propuesta",
      )
    expect(await reminder(lost)).toBeUndefined()
    expect(await reminder(withAccount)).toBeUndefined()
    const prepared = await reminder(later)
    expect(prepared).toBeDefined()
    await ownerDb
      .update(saasOpportunity)
      .set({ decision: "perdido", reason: "precio", decidedAt: NOW })
      .where(eq(saasOpportunity.clientId, later))
    const result = await decide(admin, prepared?.id ?? "", {
      action: "aprobar",
      edited: { body: "La propuesta vence pronto" },
    })
    expect(result.status).toBe("vencida")
  })

  it("una clínica con cuenta y una venta abierta por error no se «enfría»", async () => {
    await insertOrg(ownerDb, "kz-enfria-cuenta", "kz-enfria-cuenta")
    const id = await client("enfria-cuenta", "Clínica Enfría Con Cuenta (ficticia)", {
      organizationId: "kz-enfria-cuenta",
      createdAt: ago(20),
    })
    const rows = await ownerDb.transaction((tx) =>
      kairosCoolingRows(tx, admin, NOW, { clientIds: [id] }),
    )
    expect(rows).toEqual([])
  })

  it("el caso de cobro que espera a la clínica es una tarea de cobro: Soporte no la ve", async () => {
    await insertOrg(ownerDb, "kz-caso-cobro", "kz-caso-cobro")
    const id = await client("caso-cobro", "Clínica Caso Cobro (ficticia)", {
      organizationId: "kz-caso-cobro",
      open: false,
    })
    await ownerDb
      .insert(saasOpportunity)
      .values({ clientId: id, decision: "entro", decidedAt: NOW })
    await ownerDb.insert(supportCase).values({
      organizationId: "kz-caso-cobro",
      kind: "cobro",
      question: "¿Por qué me cobraron dos veces?",
      dedupeKey: "kz-caso-cobro-1",
      openedBy: OWNER,
      status: "esperando_clinica",
      lastPublicMessageAt: ago(5),
      createdAt: ago(6),
      updatedAt: ago(5),
    })
    await pass()
    const task = (await tasksOf(id)).find((t) => t.title.startsWith("Seguir el caso"))
    expect(task?.kind).toBe("cobro")
  })
})

describe("Kairós vigila el alta", () => {
  const possibleOf = async (fileId: string) =>
    (await itemsOf(ids["alta-posible"] as string, "posible_carga")).filter(
      (item) => item.payload.fileId === fileId,
    )
  const keyed = async (clientId: string, rule: string) =>
    (await tasksOf(clientId)).filter((task) => task.kairosKey?.startsWith(`${rule}:`))

  it("posible carga: Excel, CSV y Word de los últimos 30 días sí; PDF, imagen o lo de antes no; lo des-programado, una vez", async () => {
    for (const key of ["fileXlsx", "fileCsv", "fileDocx", "fileLate", "fileLifted"])
      expect(await possibleOf(ids[key] as string)).toHaveLength(1)
    for (const key of ["filePdf", "fileJpg", "fileOld"])
      expect(await possibleOf(ids[key] as string)).toHaveLength(0)
    const [xlsx] = await possibleOf(ids.fileXlsx as string)
    expect(xlsx).toMatchObject({ adminOnly: true, status: "espera" })
    // Vence a los 30 días de llegar, no a las 48 h.
    expect(xlsx?.expiresAt.getTime()).toBe(ago(3).getTime() + 30 * DAY)
    expect(xlsx?.reason).toContain("Si es la carga, se borra el")
    expect(xlsx?.payload).toMatchObject({
      urgent: false,
      dueNow: false,
      filename: "pacientes.xlsx",
    })
    // A los 25 días ya llega urgente; lo que pasó los 30, «se borra al marcarlo» antes del sí.
    const [late] = await possibleOf(ids.fileLate as string)
    expect(late?.payload).toMatchObject({ urgent: true, dueNow: false })
    expect(late?.reason).toMatch(/se borra en [45] días$/)
    const [lifted] = await possibleOf(ids.fileLifted as string)
    expect(lifted?.payload).toMatchObject({ dueNow: true, lifted: true })
    expect(lifted?.reason).toContain("se borra al marcarlo")
    expect(lifted?.expiresAt.getTime()).toBe(NOW.getTime() + 7 * DAY)
  })

  it("posible carga: Soporte no la ve ni la decide; en Hoy va primero, la urgente arriba", async () => {
    const forSupport = await listKairosItems(
      ownerDb,
      support,
      { status: "espera", limit: 100 },
      NOW,
    )
    expect(forSupport.items.some((item) => item.kind === "posible_carga")).toBe(false)
    const [xlsx] = await possibleOf(ids.fileXlsx as string)
    await expect(decide(support, xlsx?.id as string, { action: "aprobar" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    const today = await ownerDb.transaction((tx) => todayForStaff(tx, admin, { who: "todas" }, NOW))
    expect(today.kairosReady.items[0]).toMatchObject({ kind: "posible_carga" })
    expect(today.kairosReady.items[0]?.payload.urgent).toBe(true)
  })

  it("posible carga: a los 25 días el mismo ítem pasa a urgente, sin otro", async () => {
    const [before] = await possibleOf(ids.fileCsv as string)
    await ownerDb.execute(
      sql`update admin.saas_client_file set received_at = ${ago(26).toISOString()}::timestamptz where id = ${ids.fileCsv}::uuid`,
    )
    await pass()
    const after = await possibleOf(ids.fileCsv as string)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: before?.id, status: "espera" })
    expect(after[0]?.payload.urgent).toBe(true)
  })

  it("posible carga: «Sí, es la carga» la marca con la operación de Documentos; pasados los 30 días queda para borrarse ya", async () => {
    const [xlsx] = await possibleOf(ids.fileXlsx as string)
    const decision = await decide(admin, xlsx?.id as string, { action: "aprobar" })
    expect(decision).toMatchObject({ status: "ejecutada" })
    expect(decision.result).toMatchObject({
      fileId: ids.fileXlsx,
      dueNow: false,
      deleteAfter: cargaDeleteAfter(ago(3), NOW),
    })
    expect(lastCall("markClientFileCarga")?.args).toEqual([admin.userId, ids.fileXlsx])
    const [marked] = await ownerDb
      .select()
      .from(saasClientFile)
      .where(eq(saasClientFile.id, ids.fileXlsx as string))
    expect(marked?.kind).toBe("archivo_clinica")
    const [lifted] = await possibleOf(ids.fileLifted as string)
    const late = await decide(admin, lifted?.id as string, { action: "aprobar" })
    expect(late.result).toMatchObject({ dueNow: true })
  })

  it("posible carga: «No» no la vuelve a preparar, ni después de vencer; lo marcado en Documentos se retira solo", async () => {
    const [docx] = await possibleOf(ids.fileDocx as string)
    expect((await decide(admin, docx?.id as string, { action: "descartar" })).status).toBe(
      "descartada",
    )
    const [csv] = await possibleOf(ids.fileCsv as string)
    await ownerDb
      .update(kairosItem)
      .set({ expiresAt: new Date(NOW.getTime() - 1000) })
      .where(eq(kairosItem.id, csv?.id as string))
    // Lo de 26 días se marca en Documentos: su ítem se retira solo.
    await ownerDb.transaction((tx) => markClientFileCarga(tx, admin, ids.fileLate as string, NOW))
    await pass()
    expect(await possibleOf(ids.fileDocx as string)).toHaveLength(1)
    expect((await possibleOf(ids.fileCsv as string)).map((item) => item.status)).toEqual([
      "vencida",
    ])
    const [late] = await possibleOf(ids.fileLate as string)
    expect(late).toMatchObject({ status: "vencida" })
    expect(late?.error).toContain("ya se marcó como la carga de datos")
    const done = await kairosDone(ownerDb, admin, { limit: 200 })
    expect(done.map((entry) => entry.words)).toContain(
      "Retiró «¿Es la carga de datos? lista.xlsx»: ya se marcó como la carga de datos",
    )
  })

  it("la carga marcada: a los 2 días, a quien cargó antes; urgente a 5 días de borrarse; se cierran al cargarla", async () => {
    const [pending] = await keyed(ids["alta-plazo"] as string, "carga_pendiente")
    expect(pending).toMatchObject({
      title: "Cargar los datos de Clínica Alta plazo (ficticia)",
      assigneeUserId: LOADER,
      adminOnly: true,
      status: "abierta",
    })
    // Su responsable es de Soporte y nadie cargó: no va a nadie (Soporte no la vería).
    const [urgent] = await keyed(ids["alta-borra"] as string, "carga_por_borrarse")
    expect(urgent?.title).toMatch(
      /^Cargar los datos de Clínica Alta borra \(ficticia\): se borran en [45] días$/,
    )
    expect(urgent).toMatchObject({ assigneeUserId: null, adminOnly: true })
    expect(urgent?.dueAt?.getTime()).toBe(NOW.getTime())
    expect(await keyed(ids["alta-borra"] as string, "carga_pendiente")).toHaveLength(0)
    await ownerDb.insert(adminAudit).values({
      actorUserId: LOADER,
      actorRole: "admin",
      action: "org.setup_import",
      organizationId: "kz-alta-plazo",
      metadata: { nueva: 1, planSha256: "3".repeat(64) },
      createdAt: NOW,
    })
    await pass()
    const [closed] = await keyed(ids["alta-plazo"] as string, "carga_pendiente")
    expect(closed).toMatchObject({
      status: "hecha",
      doneNote: "Kairós la cerró: se cargaron sus datos",
    })
  })

  it("se borró sin cargar: pedirlos otra vez (lo aprueba una persona) y se cierra lo que quedaba; un borrado a mano no da nada", async () => {
    const borrado = ids["alta-borrado"] as string
    const [message] = (await itemsOf(borrado, "mensaje")).filter(
      (item) => item.payload.goal === "pedir_archivos_otra_vez",
    )
    expect(message).toMatchObject({ status: "espera", adminOnly: false })
    const [task] = await keyed(borrado, "carga_pendiente")
    expect(task).toMatchObject({
      status: "hecha",
      doneNote: "Kairós la cerró: se borraron sin cargar",
    })
    const manual = ids["alta-manual"] as string
    expect(await itemsOf(manual, "mensaje")).toHaveLength(0)
    expect(await tasksOf(manual)).toHaveLength(0)
  })

  it("los que no entraron: una tarea por tipo de carga, a quien cargó, «Revisado» en Hoy; una carga sin errores cierra la suya", async () => {
    const errores = ids["alta-errores"] as string
    const tasks = await keyed(errores, "carga_con_errores")
    expect(tasks.map((task) => task.title).sort()).toEqual([
      "Revisar el 1 que no entró en la carga de pacientes",
      "Revisar los 3 que no entraron en la configuración",
    ])
    expect(tasks.every((task) => task.assigneeUserId === LOADER && task.adminOnly)).toBe(true)
    const today = await ownerDb.transaction((tx) => todayForStaff(tx, admin, { who: "todas" }, NOW))
    const row = today.tasks.find((item) => item.title.startsWith("Revisar los 3"))
    expect(row?.doneLabel).toBe("Revisado")
    // Quien cargó ya no está en el equipo: va al responsable.
    const [gone] = await keyed(ids["alta-inactiva"] as string, "carga_con_errores")
    expect(gone).toMatchObject({
      title: "Revisar los 2 que no entraron en la configuración",
      assigneeUserId: LOADER,
    })
    // La configuración se vuelve a cargar sin errores; la de pacientes sigue.
    await ownerDb.insert(adminAudit).values({
      actorUserId: LOADER,
      actorRole: "admin",
      action: "org.setup_import",
      organizationId: "kz-alta-errores",
      metadata: { nueva: 3, planSha256: "4".repeat(64) },
      createdAt: new Date(NOW.getTime() - 20 * 60_000),
    })
    // Cerrada a mano: no se reabre.
    const patients = tasks.find((task) => task.title.includes("pacientes"))
    await ownerDb
      .update(saasTask)
      .set({ status: "hecha", doneAt: NOW })
      .where(eq(saasTask.id, patients?.id as string))
    await pass()
    const after = await keyed(errores, "carga_con_errores")
    expect(after).toHaveLength(2)
    expect(after.find((task) => task.title.includes("configuración"))?.doneNote).toBe(
      "Kairós la cerró: la configuración se volvió a cargar sin errores",
    )
    // El registro de la carga dice quién y cuántos no entraron.
    const loads = await listClinicLoads(ownerDb, "kz-alta-errores")
    expect(loads.find((load) => load.kind === "pacientes")).toMatchObject({
      byUserId: LOADER,
      errors: 1,
    })
    expect(
      loads.filter((load) => load.kind === "configuracion").map((load) => load.errors),
    ).toEqual([0, 3])
  })

  it("la propietaria que no acepta: un recordatorio, que sale una sola vez en Hoy; aceptarla lo vence", async () => {
    const duena = ids["alta-duena"] as string
    const [reminder] = (await itemsOf(duena, "mensaje")).filter(
      (item) => item.payload.goal === "recordar_propietaria",
    )
    expect(reminder?.payload).toMatchObject({ invitationIds: ["kz-alta-inv-duena"] })
    // Lleva días sin avanzar, pero esto ya lo cubre: no hay «El alta no avanza».
    expect(
      [...(await itemsOf(duena)), ...(await tasksOf(duena))].some((row) =>
        ("idempotencyKey" in row ? row.idempotencyKey : row.kairosKey)?.startsWith("alta_trabada:"),
      ),
    ).toBe(false)
    const before = await ownerDb.transaction((tx) =>
      todayForStaff(tx, admin, { who: "todas" }, NOW),
    )
    expect(before.owners.some((row) => row.clientId === duena)).toBe(true)
    await ownerDb.transaction((tx) =>
      saveKairosDraft(tx, reminder?.id as string, { body: "Hola, tu invitación te espera." }),
    )
    // Que vaya entre los primeros de «Kairós dejó listo» (lo demás vence a las 48 h).
    await ownerDb
      .update(kairosItem)
      .set({ expiresAt: new Date(NOW.getTime() + 3_600_000) })
      .where(eq(kairosItem.id, reminder?.id as string))
    const after = await ownerDb.transaction((tx) => todayForStaff(tx, admin, { who: "todas" }, NOW))
    expect(after.kairosReady.items.map((item) => item.id)).toContain(reminder?.id)
    expect(after.owners.some((row) => row.clientId === duena)).toBe(false)
    await ownerDb
      .update(invitation)
      .set({ status: "accepted" })
      .where(eq(invitation.id, "kz-alta-inv-duena"))
    expect((await decide(support, reminder?.id as string, { action: "aprobar" })).status).toBe(
      "vencida",
    )
  })

  it("el equipo con invitaciones vencidas: «Reenviar»; reenviarlas la cierra y, si vuelven a vencer, hay otra", async () => {
    const equipo = ids["alta-equipo"] as string
    const [first] = await keyed(equipo, "equipo_vencido")
    expect(first).toMatchObject({
      title: "Reenviar la invitación que venció",
      assigneeUserId: support.userId,
      adminOnly: false,
    })
    await ownerDb
      .update(invitation)
      .set({ expiresAt: new Date(NOW.getTime() + 7 * DAY) })
      .where(eq(invitation.id, "kz-alta-inv-equipo"))
    await pass()
    expect((await keyed(equipo, "equipo_vencido"))[0]).toMatchObject({ status: "hecha" })
    await ownerDb
      .update(invitation)
      .set({ expiresAt: new Date(NOW.getTime() - 3_600_000) })
      .where(eq(invitation.id, "kz-alta-inv-equipo"))
    await pass()
    expect((await keyed(equipo, "equipo_vencido")).map((task) => task.status).sort()).toEqual([
      "abierta",
      "hecha",
    ])
  })

  it("la prueba que termina en 7 días o menos, sin pago: una tarea de cobro; a 8 días o pagada, no", async () => {
    const [trial] = await keyed(ids["alta-prueba"] as string, "prueba_por_terminar")
    expect(trial).toMatchObject({ kind: "cobro", adminOnly: true, assigneeUserId: LOADER })
    expect(trial?.title).toMatch(/^Su prueba termina el .+: hablar del primer pago$/)
    expect(await keyed(ids["alta-prueba8"] as string, "prueba_por_terminar")).toHaveLength(0)
    expect(await keyed(ids["alta-pagada"] as string, "prueba_por_terminar")).toHaveLength(0)
  })

  it("el primer pago revertido: una sola tarea de cobro", async () => {
    const tasks = await keyed(ids["alta-revertido"] as string, "primer_pago_revertido")
    expect(tasks.map((task) => [task.title, task.kind, task.adminOnly])).toEqual([
      ["Se revirtió el primer pago de Clínica Alta revertido (ficticia)", "cobro", true],
    ])
  })

  it("el alta trabada: mensaje si le toca a la clínica; si espera a Meta, solo una tarea", async () => {
    const trabada = ids["alta-trabada"] as string
    const [message] = (await itemsOf(trabada, "mensaje")).filter(
      (item) => item.payload.goal === "alta_sin_avanzar",
    )
    expect(message?.title).toBe("El alta no avanza: falta que acepte el contrato de encargo")
    expect(message?.reason).toMatch(/^Lleva 10 días sin avanzar/)
    expect(await keyed(trabada, "alta_trabada")).toHaveLength(0)
    const meta = ids["alta-meta"] as string
    expect(
      (await itemsOf(meta, "mensaje")).some((item) => item.payload.goal === "alta_sin_avanzar"),
    ).toBe(false)
    const [task] = await keyed(meta, "alta_trabada")
    expect(task).toMatchObject({
      title: "El alta espera a Meta: falta que conecte su WhatsApp",
      kind: "alta",
      assigneeUserId: support.userId,
    })
  })

  it("«Pedir los archivos» no lo calla un correo con adjuntos; lo marcado como la carga lo cierra solo (tarea y mensaje)", async () => {
    const carta = ids["alta-carta"] as string
    const [task] = await keyed(carta, "carta_sin_archivos")
    expect(task?.status).toBe("abierta")
    const [message] = await itemsOf(carta, "mensaje")
    expect(message?.status).toBe("espera")
    await clientFile(carta, "archivo_clinica", "carga.xlsx", XLSX, { receivedAt: NOW })
    await pass()
    expect((await keyed(carta, "carta_sin_archivos"))[0]).toMatchObject({
      status: "hecha",
      doneNote: "Kairós la cerró: llegaron sus archivos",
    })
    const [closed] = await itemsOf(carta, "mensaje")
    expect(closed).toMatchObject({ status: "vencida" })
  })

  it("otra pasada no repite nada de lo del alta", async () => {
    expect(await pass()).toMatchObject({ tasks: 0, items: 0, signals: 0 })
  })
})

describe("Kairós cierra lo que ya se resolvió y vigila cada carga que se puede borrar", () => {
  const keyed = async (clientId: string, rule: string) =>
    (await tasksOf(clientId)).filter((task) => task.kairosKey?.startsWith(`${rule}:`))
  const open = async (clientId: string, rule: string) =>
    (await keyed(clientId, rule)).filter((task) => task.status === "abierta")
  const payment = (org: string, key: string) =>
    ownerDb.insert(saasPayment).values({
      organizationId: org,
      amountCents: 2900,
      currency: "USD",
      methodCode: "transferencia",
      status: "confirmado",
      idempotencyKey: key,
      confirmedAt: NOW,
      confirmedBy: admin.userId,
    })

  it("el primer pago revertido se cierra cuando vuelve a haber un pago confirmado", async () => {
    const revertido = ids["alta-revertido"] as string
    expect(await open(revertido, "primer_pago_revertido")).toHaveLength(1)
    await payment("kz-alta-revertido", "kz-rev-pago-ok")
    await pass()
    const [task] = await keyed(revertido, "primer_pago_revertido")
    expect(task).toMatchObject({
      status: "hecha",
      doneNote: "Kairós la cerró: ya hay un pago confirmado",
    })
  })

  it("la prueba por terminar se cierra al pagar o cuando ya no está en prueba", async () => {
    const prueba = ids["alta-prueba"] as string
    expect(await open(prueba, "prueba_por_terminar")).toHaveLength(1)
    await payment("kz-alta-prueba", "kz-rev-pago-prueba")
    const fin = await altaClient("pruebafin", { owner: LOADER })
    await ownerDb
      .update(saasSubscription)
      .set({ status: "prueba", trialEndsAt: new Date(NOW.getTime() + 3 * DAY) })
      .where(eq(saasSubscription.organizationId, "kz-alta-pruebafin"))
    await pass()
    expect((await keyed(prueba, "prueba_por_terminar"))[0]).toMatchObject({
      status: "hecha",
      doneNote: "Kairós la cerró: ya hay un pago confirmado",
    })
    expect(await open(fin, "prueba_por_terminar")).toHaveLength(1)
    await ownerDb
      .update(saasSubscription)
      .set({ status: "activa" })
      .where(eq(saasSubscription.organizationId, "kz-alta-pruebafin"))
    await pass()
    expect((await keyed(fin, "prueba_por_terminar"))[0]).toMatchObject({
      status: "hecha",
      doneNote: "Kairós la cerró: ya no está en prueba",
    })
  })

  it("el alta trabada: cuando avanza a otro paso, la de antes se cierra y queda una sola abierta", async () => {
    const meta = ids["alta-meta"] as string
    const [before] = await open(meta, "alta_trabada")
    expect(before?.title).toBe("El alta espera a Meta: falta que conecte su WhatsApp")
    // Se conectó hace 15 días: sigue trabada, ahora en «Primer uso».
    await milestone(meta, "whatsapp", ago(15))
    await pass()
    const [closed] = (await keyed(meta, "alta_trabada")).filter((task) => task.id === before?.id)
    expect(closed).toMatchObject({
      status: "hecha",
      doneNote: "Kairós la cerró: el alta avanzó a otro paso",
    })
    // Ahora le toca a la clínica: un mensaje, y ninguna tarea abierta de antes.
    expect(await open(meta, "alta_trabada")).toHaveLength(0)
    const stuck = async () =>
      (await itemsOf(meta, "mensaje")).filter((item) =>
        item.idempotencyKey.includes(`alta_trabada:${meta}:`),
      )
    expect((await stuck()).map((item) => [item.title, item.status])).toEqual([
      ["El alta no avanza: falta que alguien de la clínica entre", "espera"],
    ])
    // Alguien entra hoy: ya no está trabada y el mensaje se retira.
    await milestone(meta, "primer_uso", NOW)
    await pass()
    expect((await stuck()).map((item) => [item.status, item.error])).toEqual([
      ["vencida", "Ya no hace falta: el alta ya no está trabada"],
    ])
  })

  it("el alta trabada en un paso que solo hace Administración (la carta) no es para Soporte", async () => {
    const carta = await altaClient("cartatrab", { owner: support.userId, ownerMember: ago(10) })
    await milestone(carta, "entro", ago(10))
    await milestone(carta, "contrato", ago(10))
    await pass()
    const [task] = await open(carta, "alta_trabada")
    expect(task).toMatchObject({
      title: "El alta no avanza: falta subir la carta de bienvenida",
      adminOnly: true,
      assigneeUserId: null,
    })
  })

  it("dos cargas sin cargar: avisa por la que se borra primero; borrada a mano, sigue la otra; sin nada vivo, se cierra", async () => {
    const dos = await altaClient("dosarch", { owner: LOADER })
    const older = await clientFile(dos, "archivo_clinica", "primera.xlsx", XLSX, {
      receivedAt: ago(27),
    })
    const newer = await clientFile(dos, "archivo_clinica", "segunda.xlsx", XLSX, {
      receivedAt: ago(3),
    })
    await pass()
    const [urgent] = await open(dos, "carga_por_borrarse")
    expect(urgent?.kairosKey).toContain(`:${older}:`)
    expect(urgent?.title).toMatch(/: se borran en [23] días$/)
    expect(await open(dos, "carga_pendiente")).toHaveLength(0)
    // La primera se borra a mano: la urgente se cierra y sigue la segunda (marcada hace 3 días).
    await ownerDb.update(saasClientFile).set({ deletedAt: NOW }).where(eq(saasClientFile.id, older))
    await pass()
    expect((await keyed(dos, "carga_por_borrarse"))[0]).toMatchObject({
      status: "hecha",
      doneNote: "Kairós la cerró: ese archivo ya no está; sigue el que se borra antes",
    })
    const stillOpen = [
      ...(await open(dos, "carga_pendiente")),
      ...(await open(dos, "carga_por_borrarse")),
    ]
    expect(stillOpen).toHaveLength(1)
    expect(stillOpen[0]?.kairosKey).toContain(`carga_pendiente:${dos}:${newer}:`)
    // La segunda también se borra a mano: no queda nada por cargar.
    await ownerDb.update(saasClientFile).set({ deletedAt: NOW }).where(eq(saasClientFile.id, newer))
    await pass()
    expect((await keyed(dos, "carga_pendiente"))[0]).toMatchObject({
      status: "hecha",
      doneNote: "Kairós la cerró: el archivo ya no está y no queda nada por cargar",
    })
  })

  it("la urgente dice en cada pasada los días que quedan, en la misma tarea", async () => {
    const dias = await altaClient("dias", { owner: LOADER })
    await clientFile(dias, "archivo_clinica", "carga.xlsx", XLSX, { receivedAt: ago(26) })
    await pass()
    const [task] = await open(dias, "carga_por_borrarse")
    // Lo que dijo hace unos días.
    await ownerDb
      .update(saasTask)
      .set({ title: "Cargar los datos de Clínica Alta dias (ficticia): se borran en 9 días" })
      .where(eq(saasTask.id, task?.id as string))
    await pass()
    const after = await keyed(dias, "carga_por_borrarse")
    expect(after).toHaveLength(1)
    expect(after[0]?.title).toMatch(/: se borran en [34] días$/)
  })

  it("los que no entraron: la carga más nueva con errores reemplaza la tarea de la anterior", async () => {
    const otra = await altaClient("errores2", { owner: LOADER })
    await ownerDb.insert(adminAudit).values({
      actorUserId: LOADER,
      actorRole: "admin",
      action: "org.setup_import",
      organizationId: "kz-alta-errores2",
      metadata: { nueva: 5, error: 3, planSha256: "5".repeat(64) },
      createdAt: ago(1),
    })
    await pass()
    expect((await open(otra, "carga_con_errores")).map((task) => task.title)).toEqual([
      "Revisar los 3 que no entraron en la configuración",
    ])
    await ownerDb.insert(adminAudit).values({
      actorUserId: LOADER,
      actorRole: "admin",
      action: "org.setup_import",
      organizationId: "kz-alta-errores2",
      metadata: { nueva: 5, error: 2, planSha256: "6".repeat(64) },
      createdAt: new Date(NOW.getTime() - 20 * 60_000),
    })
    await pass()
    expect((await open(otra, "carga_con_errores")).map((task) => task.title)).toEqual([
      "Revisar los 2 que no entraron en la configuración",
    ])
    const old = (await keyed(otra, "carga_con_errores")).find((task) => task.status === "hecha")
    expect(old?.doneNote).toBe(
      "Kairós la cerró: la reemplaza la de la carga más nueva de la configuración",
    )
  })

  it("se borró sin cargar y después se cargó: el pedido se retira y no se vuelve a preparar", async () => {
    const borrado = ids["alta-borrado"] as string
    const asked = async () =>
      (await itemsOf(borrado, "mensaje")).filter(
        (item) => item.payload.goal === "pedir_archivos_otra_vez",
      )
    expect((await asked()).filter((item) => item.status === "espera")).toHaveLength(1)
    await ownerDb.insert(adminAudit).values({
      actorUserId: LOADER,
      actorRole: "admin",
      action: "org.setup_import",
      organizationId: "kz-alta-borrado",
      metadata: { nueva: 2, planSha256: "7".repeat(64) },
      createdAt: new Date(NOW.getTime() - 20 * 60_000),
    })
    await pass()
    const after = await asked()
    expect(after.filter((item) => item.status === "espera")).toHaveLength(0)
    expect(after.map((item) => item.error)).toContain("Ya no hace falta: se cargaron sus datos")
    await pass()
    expect((await asked()).filter((item) => item.status === "espera")).toHaveLength(0)
  })

  it("«¿Es la carga?» dice al leerla si se borra al marcarla, aunque se haya preparado antes", async () => {
    const tarde = await client("alta-tarde", "Clínica Alta Tarde (ficticia)", { open: false })
    const file = await clientFile(tarde, "correo", "pacientes.xlsx", XLSX, { receivedAt: ago(20) })
    await pass()
    const [item] = await itemsOf(tarde, "posible_carga")
    expect(item?.payload).toMatchObject({ dueNow: false })
    // Pasaron los días sin otra pasada: ya llegó hace 31 (lo guardado dice lo de antes).
    await ownerDb.execute(
      sql`update admin.kairos_item set payload = payload || ${JSON.stringify({ receivedAt: ago(31).toISOString() })}::jsonb where id = ${item?.id}::uuid`,
    )
    const listed = await listKairosItems(
      ownerDb,
      admin,
      { status: "espera", clientId: tarde, limit: 10 },
      NOW,
    )
    const [view] = listed.items.filter((row) => row.payload.fileId === file)
    expect(view?.payload).toMatchObject({ dueNow: true, urgent: true })
    expect(view?.reason).toMatch(/Si es la carga, se borra al marcarlo$/)
  })

  it("lo que el código anterior programó para borrarse mientras se desplegaba deja de estarlo y se liga a su correo", async () => {
    const posible = ids["alta-posible"] as string
    const [row] = await ownerDb
      .insert(saasClientFile)
      .values({
        clientId: posible,
        kind: "correo",
        filename: "despliegue.pdf",
        objectKey: `clients/${posible}/kz-alta-despliegue`,
        contentType: "application/pdf",
        sizeBytes: 10,
        receivedAt: NOW,
        createdAt: NOW,
        deleteAfter: plusDays(30),
      })
      .returning({ id: saasClientFile.id })
    const fileId = row?.id as string
    const [email] = await ownerDb
      .insert(saasInboundEmail)
      .values({
        clientId: posible,
        mailbox: "soporte",
        product: "dental",
        messageId: "<kz-alta-despliegue@kairos.test>",
        fromAddress: "alta-posible@kairos.test",
        toAddress: "soporte@odentia32.com",
        subject: "Lo de la clínica",
        receivedAt: ago(1),
        attachments: [
          { filename: "despliegue.pdf", contentType: "application/pdf", size: 10, fileId },
        ],
      })
      .returning({ id: saasInboundEmail.id })
    const liftedAudits = () =>
      ownerDb
        .select()
        .from(adminAudit)
        .where(
          and(
            eq(adminAudit.action, "client_file.retention_lifted"),
            eq(adminAudit.entityId, fileId),
          ),
        )
    await pass()
    const [lifted] = await ownerDb
      .select()
      .from(saasClientFile)
      .where(eq(saasClientFile.id, fileId))
    expect(lifted).toMatchObject({ deleteAfter: null, inboundEmailId: email?.id })
    expect(lifted?.receivedAt.getTime()).toBe(ago(1).getTime())
    expect((await liftedAudits()).map((audit) => audit.metadata)).toEqual([
      { clientId: posible, deleteAfter: plusDays(30) },
    ])
    // Kairós lo pregunta una vez, como lo de antes del cambio.
    expect(
      (await itemsOf(posible, "posible_carga")).filter((item) => item.payload.fileId === fileId),
    ).toHaveLength(1)
    await pass()
    expect(await liftedAudits()).toHaveLength(1)
  })

  it("en Hoy, de las posibles cargas que no son urgentes caben dos; las demás siguen en Kairós", async () => {
    const muchas = await client("alta-muchas", "Clínica Alta Muchas (ficticia)", { open: false })
    for (const days of [1, 2, 3, 4])
      await clientFile(muchas, "correo", `pacientes-${days}.xlsx`, XLSX, {
        receivedAt: ago(days),
      })
    await pass()
    const today = await ownerDb.transaction((tx) => todayForStaff(tx, admin, { who: "todas" }, NOW))
    const calm = today.kairosReady.items.filter(
      (item) => item.kind === "posible_carga" && item.payload.urgent !== true,
    )
    expect(calm.length).toBeGreaterThan(0)
    expect(calm.length).toBeLessThanOrEqual(2)
    const all = await listKairosItems(
      ownerDb,
      admin,
      { status: "espera", clientId: muchas, limit: 100 },
      NOW,
    )
    expect(all.items.filter((item) => item.kind === "posible_carga")).toHaveLength(4)
  })

  it("la propietaria que ya no tiene invitación pendiente: el recordatorio se retira en la pasada", async () => {
    const duena = await altaClient("duena2", { owner: support.userId })
    await ownerDb.insert(invitation).values({
      id: "kz-alta-inv-duena2",
      organizationId: "kz-alta-duena2",
      email: "duena2@alta.test",
      role: "owner",
      status: "pending",
      expiresAt: new Date(NOW.getTime() + 2 * DAY),
      createdAt: ago(3),
      inviterId: admin.userId,
    })
    await pass()
    const reminder = async () =>
      (await itemsOf(duena, "mensaje")).filter(
        (item) => item.payload.goal === "recordar_propietaria",
      )
    expect((await reminder()).map((item) => item.status)).toEqual(["espera"])
    await ownerDb
      .update(invitation)
      .set({ status: "accepted" })
      .where(eq(invitation.id, "kz-alta-inv-duena2"))
    await pass()
    const [after] = await reminder()
    expect(after).toMatchObject({
      status: "vencida",
      error: "Ya no hace falta: ya no tiene una invitación pendiente",
    })
  })
})
