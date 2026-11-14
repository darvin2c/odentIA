import { AGREEMENT_VERSION } from "@odentia/auth/legal"
import {
  saasClient,
  saasClientFile,
  saasClientMilestone,
  saasInboundEmail,
} from "@odentia/db/schema/admin-arm"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { clinicImportRow } from "@odentia/db/schema/admin-imports"
import { invitation, member, session, user } from "@odentia/db/schema/auth"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { saasPayment, saasSubscription } from "@odentia/db/schema/saas-billing"
import { processingAgreementAcceptance } from "@odentia/db/schema/workspace"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import {
  ALTA_STUCK_DAYS,
  clearStepNotApplicable,
  isStuck,
  markStepNotApplicable,
  ONBOARDING_STEP_KEYS,
  type OnboardingStep,
  type OnboardingSteps,
  onboardingColumn,
  onboardingSteps,
  syncOnboardingMilestones,
} from "./admin-onboarding.js"
import { PROGRESS_REPORT_ACTIONS } from "./clinic-progress-report.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Ficha › Alta: los pasos salen de lo que ya pasó y guardan su primera vez
 * (`saas_client_milestone`); una persona solo marca «No aplica». La carga y el
 * informe salen del registro de lo que hizo la skill en el servidor (ADR 0183).
 */
setupTestDb()
const admin: AdminActor = { userId: "on-admin", role: "admin" }
const support: AdminActor = { userId: "on-support", role: "support" }
const ORG = "on-org"
const FRESH = "on-fresh"
const DAY = 86_400_000
const NOW = new Date()
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)
/** El día (yyyy-mm-dd, UTC) de hace tantos días: `delete_after` es una fecha. */
const dayAgo = (days: number) => ago(days).toISOString().slice(0, 10)
let fullClient: string
let freshClient: string
let prospect: string

const stepOf = (result: OnboardingSteps, key: (typeof ONBOARDING_STEP_KEYS)[number]) => {
  const found = result.steps.find((item) => item.key === key)
  if (!found) throw new Error(`sin paso ${key}`)
  return found
}

async function client(name: string, organizationId?: string): Promise<string> {
  const [row] = await ownerDb
    .insert(saasClient)
    .values({ name, product: "dental", organizationId })
    .returning({ id: saasClient.id })
  if (!row) throw new Error("sin cliente")
  return row.id
}

/** Una clínica con cuenta y su cliente, cada prueba con la suya. */
async function clinic(slug: string): Promise<{ orgId: string; clientId: string }> {
  const orgId = `on-${slug}`
  await insertOrg(ownerDb, orgId, `on-${slug}`)
  return { orgId, clientId: await client(`Clínica ${slug} (ficticia)`, orgId) }
}

async function milestoneOf(clientId: string, step: string) {
  const [row] = await ownerDb
    .select()
    .from(saasClientMilestone)
    .where(and(eq(saasClientMilestone.clientId, clientId), eq(saasClientMilestone.step, step)))
  return row ?? null
}

async function archivoClinica(
  clientId: string,
  input: { receivedAt: Date; deleteAfter: string; deletedAt?: Date },
) {
  await ownerDb.insert(saasClientFile).values({
    clientId,
    kind: "archivo_clinica",
    filename: "pacientes.xlsx",
    objectKey: `clients/${clientId}/${crypto.randomUUID()}.xlsx`,
    contentType: "text/csv",
    sizeBytes: 1,
    createdAt: input.receivedAt,
    receivedAt: input.receivedAt,
    deleteAfter: input.deleteAfter,
    ...(input.deletedAt ? { deletedAt: input.deletedAt } : {}),
  })
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ada Administración", email: "ada@onboarding.test" },
    { id: support.userId, name: "Sofía Soporte", email: "sofia@onboarding.test" },
    { id: "on-owner", name: "Dra. Norte", email: "norte@onboarding.test" },
    { id: "on-asist", name: "Asistente", email: "asist@onboarding.test" },
  ])
  await insertOrg(ownerDb, ORG, "on-clinica")
  await insertOrg(ownerDb, FRESH, "on-nueva")
  fullClient = await client("Clínica Norte (ficticia)", ORG)
  freshClient = await client("Clínica Nueva (ficticia)", FRESH)
  prospect = await client("Clínica Prospecto (ficticia)")

  // Clínica Norte hizo casi todo.
  await ownerDb.insert(member).values([
    { id: "on-m1", organizationId: ORG, userId: "on-owner", role: "owner", createdAt: ago(10) },
    { id: "on-m2", organizationId: ORG, userId: "on-asist", role: "member", createdAt: ago(5) },
  ])
  await ownerDb.insert(invitation).values([
    {
      id: "on-i1",
      organizationId: ORG,
      email: "asist@onboarding.test",
      role: "member",
      status: "accepted",
      expiresAt: ago(-2),
      inviterId: "on-owner",
    },
  ])
  await ownerDb.insert(processingAgreementAcceptance).values({
    organizationId: ORG,
    version: AGREEMENT_VERSION,
    acceptedBy: "on-owner",
    acceptedAt: ago(10),
  })
  await ownerDb.insert(saasClientFile).values({
    clientId: fullClient,
    kind: "carta",
    filename: "carta.pdf",
    objectKey: "clients/x/carta.pdf",
    contentType: "application/pdf",
    sizeBytes: 1,
    createdAt: ago(9),
  })
  // La carga ya se borró (a mano, antes de vencer), pero igual llegó.
  await archivoClinica(fullClient, {
    receivedAt: ago(8),
    deleteAfter: dayAgo(-22),
    deletedAt: ago(1),
  })
  // Lo que deja la skill al cargar y al registrar un informe que salió por correo aparte.
  await ownerDb.insert(adminAudit).values([
    {
      actorUserId: admin.userId,
      actorRole: "admin",
      action: "org.setup_import",
      organizationId: ORG,
      metadata: { planSha256: "b".repeat(64), nueva: 20, cambia: 2, igual: 7 },
      createdAt: ago(6),
    },
    {
      actorUserId: admin.userId,
      actorRole: "admin",
      action: PROGRESS_REPORT_ACTIONS.enviado,
      organizationId: ORG,
      entityId: "informe-1",
      metadata: { to: "norte@onboarding.test", sentAt: ago(4).toISOString(), registered: true },
      createdAt: ago(3),
    },
  ])
  await ownerDb.insert(clinicImportRow).values([
    {
      organizationId: ORG,
      sourceKey: "1",
      contactId: crypto.randomUUID(),
      outcome: "creada",
      planSha256: "a".repeat(64),
      createdBy: admin.userId,
      createdAt: ago(6),
    },
    {
      organizationId: ORG,
      sourceKey: "2",
      contactId: crypto.randomUUID(),
      outcome: "creada",
      planSha256: "a".repeat(64),
      createdBy: admin.userId,
      createdAt: ago(6),
    },
  ])
  await ownerDb.insert(session).values({
    id: "on-s1",
    userId: "on-owner",
    token: "on-token-1",
    expiresAt: ago(-5),
    createdAt: ago(9),
    updatedAt: ago(9),
  })
  await ownerDb.insert(saasPayment).values({
    organizationId: ORG,
    amountCents: 2900,
    currency: "USD",
    methodCode: "transferencia",
    status: "confirmado",
    idempotencyKey: "on-pago-1",
    confirmedAt: ago(2),
  })

  // La nueva: su propietaria no aceptó y mandó sus datos por correo.
  await ownerDb.insert(invitation).values({
    id: "on-i2",
    organizationId: FRESH,
    email: "nueva@onboarding.test",
    role: "owner",
    status: "pending",
    expiresAt: ago(-3),
    inviterId: admin.userId,
  })
  await ownerDb.insert(saasInboundEmail).values({
    clientId: freshClient,
    mailbox: "soporte",
    product: "dental",
    messageId: "<on-1@correo.test>",
    fromAddress: "nueva@onboarding.test",
    toAddress: "soporte@odentia32.com",
    receivedAt: ago(1),
    attachments: [{ filename: "datos.xlsx", contentType: "text/csv", size: 1, fileId: null }],
  })
  await ownerDb.insert(adminAudit).values({
    actorUserId: admin.userId,
    actorRole: "admin",
    action: PROGRESS_REPORT_ACTIONS.desconocido,
    organizationId: FRESH,
    entityId: "informe-1",
  })
})

describe("onboardingSteps", () => {
  it("una clínica que avanzó: cada paso con su fecha; falta lo que no pasó", async () => {
    const result = await onboardingSteps(ownerDb, admin, fullClient, NOW)
    expect(result.steps.map((item) => item.key)).toEqual([...ONBOARDING_STEP_KEYS])
    expect(result.organizationId).toBe(ORG)
    const done = Object.fromEntries(
      result.steps.map((item) => [item.key, item.doneAt?.getTime() ?? null]),
    )
    expect(done).toEqual({
      entro: ago(10).getTime(),
      contrato: ago(10).getTime(),
      carta: ago(9).getTime(),
      archivos: ago(8).getTime(),
      configuracion: ago(6).getTime(),
      pacientes: ago(6).getTime(),
      informe: ago(4).getTime(),
      equipo: ago(5).getTime(),
      whatsapp: null,
      primer_uso: ago(9).getTime(),
      primer_pago: ago(2).getTime(),
    })
    expect(stepOf(result, "carta")).toMatchObject({
      label: "Carta de bienvenida subida",
      state: "hecho",
      waitingOn: null,
    })
    expect(stepOf(result, "carta").detail).toMatch(/^Se subió el /)
    expect(stepOf(result, "archivos").detail).toContain("1 archivo")
    expect(stepOf(result, "configuracion").detail).toContain(
      "20 nuevos · 2 cambiaron · 7 ya estaban",
    )
    expect(stepOf(result, "pacientes").detail).toContain("2 personas en la carga")
    // El informe que salió por correo aparte cuenta desde el día en que salió, no el del registro.
    expect(stepOf(result, "informe").detail).toContain("por correo aparte")
    expect(stepOf(result, "primer_pago").detail).not.toMatch(/\d{3,}|USD|29/)
    expect(result).toMatchObject({
      done: 10,
      total: 11,
      notApplicable: 0,
      next: "whatsapp",
      column: "pago",
      stuck: false,
      enteredAt: ago(10),
      lastProgressAt: ago(2),
    })
  })

  it("lo que falta dice qué pasa y a quién le toca; Soporte no ve lo de Administración", async () => {
    const forAdmin = await onboardingSteps(ownerDb, admin, freshClient, NOW)
    expect(stepOf(forAdmin, "entro")).toMatchObject({
      doneAt: null,
      state: "falta",
      waitingOn: "clinica",
      action: { code: "reenviar_invitacion", adminOnly: false },
    })
    expect(stepOf(forAdmin, "entro").detail).toContain("no aceptó")
    // Un correo a soporte@ con adjuntos ya no basta: solo lo que se marca como la carga.
    expect(stepOf(forAdmin, "archivos")).toMatchObject({
      doneAt: null,
      state: "falta",
      waitingOn: "clinica",
      detail: "Falta: la clínica aún no mandó sus datos",
    })
    // La carga la hace la skill: lo que falta lo dice, sin un botón para cargar.
    expect(stepOf(forAdmin, "configuracion")).toMatchObject({ doneAt: null, waitingOn: "nosotros" })
    expect(stepOf(forAdmin, "configuracion")).not.toHaveProperty("action")
    expect(stepOf(forAdmin, "configuracion").detail).toContain("skill")
    expect(stepOf(forAdmin, "informe")).toMatchObject({
      doneAt: null,
      action: { code: "revisar_informe" },
    })
    expect(stepOf(forAdmin, "informe").detail).toContain("No se sabe si salió")
    expect(stepOf(forAdmin, "contrato")).toMatchObject({ doneAt: null, waitingOn: "clinica" })
    // Sin propietaria no hay «solo la propietaria».
    expect(stepOf(forAdmin, "equipo").detail).toBe("Nadie de la clínica entró todavía")
    expect(forAdmin).toMatchObject({ next: "entro", column: "bienvenida" })

    const forSupport = await onboardingSteps(ownerDb, support, freshClient, NOW)
    expect(forSupport.steps.every((item) => !item.action?.adminOnly)).toBe(true)
    expect(stepOf(forSupport, "informe")).not.toHaveProperty("action")
    expect(stepOf(forSupport, "entro").action?.code).toBe("reenviar_invitacion")
    // «No aplica»: Soporte en equipo y WhatsApp, no en pacientes (es de la carga).
    expect(stepOf(forSupport, "equipo")).toMatchObject({
      canMarkNotApplicable: true,
      suggestedReason: "Trabaja sola",
    })
    expect(stepOf(forSupport, "pacientes").canMarkNotApplicable).toBe(false)
    expect(stepOf(forAdmin, "pacientes")).toMatchObject({
      canMarkNotApplicable: true,
      suggestedReason: "No tenía lista de pacientes",
    })
    expect(stepOf(forAdmin, "carta").canMarkNotApplicable).toBe(false)
  })

  it("sin cuenta: todo falta, pero lo que ya mandó cuenta", async () => {
    const result = await onboardingSteps(ownerDb, admin, prospect, NOW)
    expect(result).toMatchObject({ organizationId: null, done: 0, next: "entro", column: null })
    expect(stepOf(result, "entro").detail).toContain("Aún no tiene cuenta")
    expect(result.steps.every((item) => !item.canMarkNotApplicable)).toBe(true)
    await expect(onboardingSteps(ownerDb, null, prospect, NOW)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(
      onboardingSteps(ownerDb, admin, "00000000-0000-4000-8000-000000000000", NOW),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("WhatsApp conectado de verdad", () => {
  const whatsapp = (result: OnboardingSteps) => stepOf(result, "whatsapp")

  it("sin conexión: «Espera a Meta» mientras «Conectar con Facebook» no esté; si está, le toca a la clínica", async () => {
    const { clientId } = await clinic("wa-sin")
    const waiting = whatsapp(await onboardingSteps(ownerDb, admin, clientId, NOW))
    expect(waiting).toMatchObject({ label: "Espera a Meta", waitingOn: "meta", state: "falta" })
    expect(waiting.detail).toContain("Meta todavía no lo aprueba")
    const ready = whatsapp(
      await onboardingSteps(ownerDb, admin, clientId, NOW, { metaSignupAvailable: true }),
    )
    expect(ready).toMatchObject({ label: "WhatsApp conectado", waitingOn: "clinica" })
    expect(ready.detail).toContain("aún no conectó")
  })

  it("a mano: falta hasta que Meta verifica la dirección; después sigue hecho aunque se desactive", async () => {
    const { orgId, clientId } = await clinic("wa-mano")
    const [row] = await ownerDb
      .insert(channelConnection)
      .values({
        organizationId: orgId,
        channel: "whatsapp",
        provider: "whatsapp_cloud_api",
        displayName: "+51 987 000 333",
        configEncrypted: "x",
        webhookSecret: "y",
        createdAt: ago(3),
      })
      .returning({ id: channelConnection.id })
    if (!row) throw new Error("sin conexión")
    const pending = whatsapp(await onboardingSteps(ownerDb, admin, clientId, NOW))
    expect(pending).toMatchObject({
      doneAt: null,
      waitingOn: "clinica",
      label: "WhatsApp conectado",
    })
    expect(pending.detail).toContain("pegar la dirección de avisos")

    await ownerDb
      .update(channelConnection)
      .set({ webhookVerifiedAt: ago(2) })
      .where(eq(channelConnection.id, row.id))
    expect(whatsapp(await onboardingSteps(ownerDb, admin, clientId, NOW)).doneAt).toEqual(ago(2))

    await ownerDb
      .update(channelConnection)
      .set({ status: "disabled" })
      .where(eq(channelConnection.id, row.id))
    const off = whatsapp(await onboardingSteps(ownerDb, admin, clientId, NOW))
    expect(off).toMatchObject({ state: "hecho", doneAt: ago(2) })
    expect(off.detail).toContain("hoy está desactivado")
  })

  it("con Facebook: falta hasta que llega el primer mensaje a ese número", async () => {
    const { orgId, clientId } = await clinic("wa-fb")
    const [row] = await ownerDb
      .insert(channelConnection)
      .values({
        organizationId: orgId,
        channel: "whatsapp",
        provider: "whatsapp_cloud_api",
        displayName: "+51 987 000 444",
        configEncrypted: "x",
        webhookSecret: "y",
        // Lo que guarda «Conectar con Facebook»; aquí basta con que no sea nulo.
        signup: {} as never,
      })
      .returning({ id: channelConnection.id })
    if (!row) throw new Error("sin conexión")
    expect(whatsapp(await onboardingSteps(ownerDb, admin, clientId, NOW)).detail).toBe(
      "Falta: que llegue el primer mensaje a ese número",
    )
    const [person] = await ownerDb
      .insert(contact)
      .values({ organizationId: orgId, displayName: "Paciente Ficticia" })
      .returning({ id: contact.id })
    if (!person) throw new Error("sin contacto")
    const [thread] = await ownerDb
      .insert(conversation)
      .values({
        organizationId: orgId,
        contactId: person.id,
        channelConnectionId: row.id,
        externalThreadId: "51987000444",
      })
      .returning({ id: conversation.id })
    if (!thread) throw new Error("sin conversación")
    // Un mensaje que salió no cuenta; el primero que llegó, sí.
    await ownerDb.insert(message).values([
      {
        organizationId: orgId,
        conversationId: thread.id,
        direction: "out",
        senderKind: "agent",
        body: "Hola",
        createdAt: ago(3),
      },
      {
        organizationId: orgId,
        conversationId: thread.id,
        direction: "in",
        senderKind: "contact",
        body: "Hola",
        createdAt: ago(1),
      },
    ])
    expect(whatsapp(await onboardingSteps(ownerDb, admin, clientId, NOW))).toMatchObject({
      state: "hecho",
      doneAt: ago(1),
    })
  })
})

describe("la primera vez guardada", () => {
  it("el contrato cuenta desde la primera aceptación, aunque sea de una versión anterior", async () => {
    const { orgId, clientId } = await clinic("hist-contrato")
    await ownerDb
      .insert(user)
      .values({ id: "on-hc", name: "Dra. Vieja", email: "hc@onboarding.test" })
    await ownerDb.insert(processingAgreementAcceptance).values({
      organizationId: orgId,
      version: "2020-01-01",
      acceptedBy: "on-hc",
      acceptedAt: ago(20),
    })
    const step = stepOf(await onboardingSteps(ownerDb, admin, clientId, NOW), "contrato")
    expect(step).toMatchObject({ state: "hecho", doneAt: ago(20) })
    expect(step.detail).toContain("falta la vigente")
  })

  it("lo guardado no se pierde: sesiones borradas y una invitación nueva no reabren el paso", async () => {
    const { orgId, clientId } = await clinic("hist-uso")
    await ownerDb.insert(user).values([
      { id: "on-hu1", name: "Dra. Uso", email: "hu1@onboarding.test" },
      { id: "on-hu2", name: "Asistente Uso", email: "hu2@onboarding.test" },
    ])
    await ownerDb.insert(member).values([
      { id: "on-hum1", organizationId: orgId, userId: "on-hu1", role: "owner", createdAt: ago(9) },
      { id: "on-hum2", organizationId: orgId, userId: "on-hu2", role: "member", createdAt: ago(7) },
    ])
    await ownerDb.insert(session).values({
      id: "on-hus1",
      userId: "on-hu1",
      token: "on-hu-token",
      expiresAt: ago(-5),
      createdAt: ago(8),
      updatedAt: ago(8),
    })
    const first = await syncOnboardingMilestones(ownerDb, NOW)
    const mine = first.reached.filter((row) => row.clientId === clientId).map((row) => row.step)
    expect(mine).toEqual(expect.arrayContaining(["entro", "equipo", "primer_uso"]))
    expect(await milestoneOf(clientId, "primer_uso")).toMatchObject({
      reachedAt: ago(8),
      source: "hecho",
    })

    await ownerDb.delete(session).where(eq(session.id, "on-hus1"))
    await ownerDb.insert(invitation).values({
      id: "on-hui1",
      organizationId: orgId,
      email: "nuevo@onboarding.test",
      role: "member",
      status: "pending",
      expiresAt: ago(-6),
      inviterId: "on-hu1",
    })
    const result = await onboardingSteps(ownerDb, admin, clientId, NOW)
    expect(stepOf(result, "primer_uso")).toMatchObject({ state: "hecho", doneAt: ago(8) })
    expect(stepOf(result, "equipo")).toMatchObject({ state: "hecho", doneAt: ago(7) })
    expect(stepOf(result, "equipo").detail).toContain("1 invitación sin aceptar")

    // Una segunda pasada no devuelve nada nuevo ni mueve lo guardado.
    const again = await syncOnboardingMilestones(ownerDb, NOW)
    expect(again.reached.filter((row) => row.clientId === clientId)).toEqual([])
    expect(again.lost.filter((row) => row.clientId === clientId)).toEqual([])
    await ownerDb.insert(session).values({
      id: "on-hus2",
      userId: "on-hu1",
      token: "on-hu-token-2",
      expiresAt: ago(-5),
      createdAt: ago(1),
      updatedAt: ago(1),
    })
    await syncOnboardingMilestones(ownerDb, NOW)
    expect((await milestoneOf(clientId, "primer_uso"))?.reachedAt).toEqual(ago(8))
    const alta = again.alta.find((row) => row.clientId === clientId)
    expect(alta).toMatchObject({ organizationId: orgId, column: "bienvenida", stuck: false })
  })

  it("el pago revertido hace faltar el primer pago; uno confirmado después lo alcanza con su fecha", async () => {
    const { orgId, clientId } = await clinic("hist-pago")
    const [paid] = await ownerDb
      .insert(saasPayment)
      .values({
        organizationId: orgId,
        amountCents: 2900,
        currency: "USD",
        methodCode: "transferencia",
        status: "confirmado",
        idempotencyKey: "on-hp-1",
        confirmedAt: ago(10),
      })
      .returning({ id: saasPayment.id })
    if (!paid) throw new Error("sin pago")
    await syncOnboardingMilestones(ownerDb, NOW)
    expect((await milestoneOf(clientId, "primer_pago"))?.reachedAt).toEqual(ago(10))

    await ownerDb
      .update(saasPayment)
      .set({ status: "reversado", reversedAt: ago(3) })
      .where(eq(saasPayment.id, paid.id))
    const reversed = stepOf(await onboardingSteps(ownerDb, admin, clientId, NOW), "primer_pago")
    expect(reversed).toMatchObject({
      state: "falta",
      doneAt: null,
      lost: { reason: "pago_revertido", at: ago(3) },
      waitingOn: "clinica",
    })
    expect(reversed.detail).toContain("Se revirtió el pago")
    const sync = await syncOnboardingMilestones(ownerDb, NOW)
    expect(sync.lost.filter((row) => row.clientId === clientId)).toEqual([
      { clientId, step: "primer_pago", reason: "pago_revertido", at: ago(3) },
    ])
    expect(await milestoneOf(clientId, "primer_pago")).toMatchObject({
      reachedAt: null,
      lostAt: ago(3),
      lostReason: "pago_revertido",
    })
    expect(
      (await syncOnboardingMilestones(ownerDb, NOW)).lost.filter(
        (row) => row.clientId === clientId,
      ),
    ).toEqual([])

    await ownerDb.insert(saasPayment).values({
      organizationId: orgId,
      amountCents: 2900,
      currency: "USD",
      methodCode: "transferencia",
      status: "confirmado",
      idempotencyKey: "on-hp-2",
      confirmedAt: ago(1),
    })
    const back = await syncOnboardingMilestones(ownerDb, NOW)
    expect(
      back.reached.filter((row) => row.clientId === clientId && row.step === "primer_pago"),
    ).toEqual([{ clientId, step: "primer_pago", at: ago(1) }])
    expect(await milestoneOf(clientId, "primer_pago")).toMatchObject({
      reachedAt: ago(1),
      lostAt: null,
      lostReason: null,
    })
    expect(
      stepOf(await onboardingSteps(ownerDb, admin, clientId, NOW), "primer_pago"),
    ).toMatchObject({
      state: "hecho",
      doneAt: ago(1),
    })
  })

  it("lo devuelto se pagó: no hace faltar el primer pago", async () => {
    const { orgId, clientId } = await clinic("hist-devuelto")
    await ownerDb.insert(saasPayment).values({
      organizationId: orgId,
      amountCents: 2900,
      currency: "USD",
      methodCode: "transferencia",
      status: "devuelto",
      idempotencyKey: "on-hd-1",
      confirmedAt: ago(4),
    })
    expect(
      stepOf(await onboardingSteps(ownerDb, admin, clientId, NOW), "primer_pago"),
    ).toMatchObject({
      state: "hecho",
      doneAt: ago(4),
    })
  })
})

describe("«Datos recibidos» y lo que se borró sin cargar", () => {
  it("lo marcado que venció sin carga vuelve a faltar; la primera pasada guarda lo perdido", async () => {
    const { clientId } = await clinic("files-vencido")
    await archivoClinica(clientId, {
      receivedAt: ago(40),
      deleteAfter: dayAgo(10),
      deletedAt: ago(9),
    })
    // El relleno de 0120 lo dejó alcanzado.
    await ownerDb
      .insert(saasClientMilestone)
      .values({ clientId, step: "archivos", reachedAt: ago(40), source: "hecho" })
    const step = stepOf(await onboardingSteps(ownerDb, admin, clientId, NOW), "archivos")
    expect(step).toMatchObject({
      state: "falta",
      waitingOn: "clinica",
      lost: { reason: "borrados_sin_cargar", at: ago(9) },
      action: { code: "subir_archivos" },
    })
    expect(step.detail).toContain("Se borraron sin cargar")
    const sync = await syncOnboardingMilestones(ownerDb, NOW)
    expect(sync.lost.filter((row) => row.clientId === clientId)).toEqual([
      { clientId, step: "archivos", reason: "borrados_sin_cargar", at: ago(9) },
    ])
    // Vuelve a llegar: cuenta desde la llegada nueva.
    await archivoClinica(clientId, { receivedAt: ago(2), deleteAfter: dayAgo(-28) })
    await syncOnboardingMilestones(ownerDb, NOW)
    expect(await milestoneOf(clientId, "archivos")).toMatchObject({
      reachedAt: ago(2),
      lostAt: null,
    })
    expect(stepOf(await onboardingSteps(ownerDb, admin, clientId, NOW), "archivos")).toMatchObject({
      state: "hecho",
      doneAt: ago(2),
    })
  })

  it("con una carga después, sigue hecho; un borrado a mano antes de vencer no la hace retroceder", async () => {
    const loaded = await clinic("files-cargado")
    await archivoClinica(loaded.clientId, {
      receivedAt: ago(40),
      deleteAfter: dayAgo(10),
      deletedAt: ago(9),
    })
    await ownerDb.insert(adminAudit).values({
      actorUserId: admin.userId,
      actorRole: "admin",
      action: "org.setup_import",
      organizationId: loaded.orgId,
      createdAt: ago(30),
    })
    expect(
      stepOf(await onboardingSteps(ownerDb, admin, loaded.clientId, NOW), "archivos"),
    ).toMatchObject({
      state: "hecho",
      doneAt: ago(40),
    })

    const manual = await clinic("files-mano")
    await archivoClinica(manual.clientId, {
      receivedAt: ago(5),
      deleteAfter: dayAgo(-25),
      deletedAt: ago(1),
    })
    const step = stepOf(await onboardingSteps(ownerDb, admin, manual.clientId, NOW), "archivos")
    expect(step).toMatchObject({ state: "hecho", doneAt: ago(5) })
    expect(step).not.toHaveProperty("lost")
  })

  it("lo de soporte@ cuenta como respaldo solo si la clínica ya tuvo una carga", async () => {
    const { orgId, clientId } = await clinic("files-respaldo")
    await ownerDb.insert(saasInboundEmail).values({
      clientId,
      mailbox: "soporte",
      product: "dental",
      messageId: "<on-respaldo@correo.test>",
      fromAddress: "respaldo@onboarding.test",
      toAddress: "soporte@odentia32.com",
      receivedAt: ago(12),
      attachments: [{ filename: "datos.xlsx", contentType: "text/csv", size: 1, fileId: null }],
    })
    expect(stepOf(await onboardingSteps(ownerDb, admin, clientId, NOW), "archivos").state).toBe(
      "falta",
    )
    await ownerDb.insert(adminAudit).values({
      actorUserId: admin.userId,
      actorRole: "admin",
      action: "org.data_import",
      organizationId: orgId,
      createdAt: ago(10),
    })
    expect(stepOf(await onboardingSteps(ownerDb, admin, clientId, NOW), "archivos")).toMatchObject({
      state: "hecho",
      doneAt: ago(12),
    })
    await syncOnboardingMilestones(ownerDb, NOW)
    expect(await milestoneOf(clientId, "archivos")).toMatchObject({
      reachedAt: ago(12),
      source: "respaldo",
    })
  })
})

describe("«No aplica»", () => {
  it("lo marca una persona con su motivo; deja de contar y el siguiente paso lo salta", async () => {
    const { orgId, clientId } = await clinic("na")
    await ownerDb
      .insert(user)
      .values({ id: "on-na1", name: "Dra. Sola", email: "na1@onboarding.test" })
    await ownerDb
      .insert(member)
      .values({
        id: "on-nam1",
        organizationId: orgId,
        userId: "on-na1",
        role: "owner",
        createdAt: ago(9),
      })
    await ownerDb.insert(processingAgreementAcceptance).values({
      organizationId: orgId,
      version: AGREEMENT_VERSION,
      acceptedBy: "on-na1",
      acceptedAt: ago(9),
    })

    await expect(
      markStepNotApplicable(ownerDb, support, clientId, "pacientes", "No tenía lista", NOW),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      markStepNotApplicable(ownerDb, admin, clientId, "carta", "Ya la tiene", NOW),
    ).rejects.toMatchObject({ status: 400, fields: { step: expect.any(String) } })
    await expect(
      markStepNotApplicable(ownerDb, support, clientId, "equipo", "   ", NOW),
    ).rejects.toMatchObject({ fields: { reason: expect.any(String) } })
    await expect(
      markStepNotApplicable(ownerDb, support, clientId, "equipo", "x".repeat(301), NOW),
    ).rejects.toMatchObject({ fields: { reason: expect.any(String) } })
    await expect(
      markStepNotApplicable(ownerDb, null, clientId, "equipo", "Trabaja sola", NOW),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      markStepNotApplicable(ownerDb, admin, prospect, "equipo", "Trabaja sola", NOW),
    ).rejects.toMatchObject({ code: "CLIENT_WITHOUT_ACCOUNT" })

    const before = await onboardingSteps(ownerDb, support, clientId, NOW)
    await markStepNotApplicable(ownerDb, support, clientId, "equipo", "  Trabaja sola ", ago(1))
    const after = await onboardingSteps(ownerDb, support, clientId, NOW)
    expect(stepOf(after, "equipo")).toMatchObject({
      state: "no_aplica",
      doneAt: null,
      waitingOn: null,
      detail: "No aplica: Trabaja sola",
      notApplicable: { reason: "Trabaja sola", by: "Sofía Soporte", at: ago(1) },
      canMarkNotApplicable: true,
    })
    expect(after).toMatchObject({ total: 10, done: before.done, notApplicable: 1 })
    expect(after.steps.find((item) => item.key === after.next)?.state).toBe("falta")
    expect(after.next).not.toBe("equipo")
    expect(after.lastProgressAt).toEqual(ago(1))

    await markStepNotApplicable(ownerDb, admin, clientId, "pacientes", "No tenía lista", NOW)
    const audits = await ownerDb
      .select({ action: adminAudit.action, metadata: adminAudit.metadata })
      .from(adminAudit)
      .where(and(eq(adminAudit.entityId, clientId), eq(adminAudit.organizationId, orgId)))
    expect(audits).toEqual(
      expect.arrayContaining([
        {
          action: "client.onboarding_not_applicable",
          metadata: { step: "equipo", reason: "Trabaja sola" },
        },
        {
          action: "client.onboarding_not_applicable",
          metadata: { step: "pacientes", reason: "No tenía lista" },
        },
      ]),
    )

    // Quitarlo borra la fila si no tenía primera vez.
    await expect(
      clearStepNotApplicable(ownerDb, support, clientId, "pacientes", NOW),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await clearStepNotApplicable(ownerDb, support, clientId, "equipo", NOW)
    expect(await milestoneOf(clientId, "equipo")).toBeNull()
    expect(stepOf(await onboardingSteps(ownerDb, support, clientId, NOW), "equipo").state).toBe(
      "falta",
    )
    const cleared = await ownerDb
      .select()
      .from(adminAudit)
      .where(
        and(
          eq(adminAudit.entityId, clientId),
          eq(adminAudit.action, "client.onboarding_not_applicable_cleared"),
        ),
      )
    expect(cleared).toHaveLength(1)
  })

  it("si el hecho pasa después, queda hecho; quitarlo conserva la primera vez", async () => {
    const { orgId, clientId } = await clinic("na-hecho")
    await ownerDb.insert(user).values([
      { id: "on-nh1", name: "Dra. Equipo", email: "nh1@onboarding.test" },
      { id: "on-nh2", name: "Asistente Equipo", email: "nh2@onboarding.test" },
    ])
    await ownerDb
      .insert(member)
      .values({
        id: "on-nhm1",
        organizationId: orgId,
        userId: "on-nh1",
        role: "owner",
        createdAt: ago(9),
      })
    await markStepNotApplicable(ownerDb, support, clientId, "equipo", "Trabaja sola", ago(5))
    await ownerDb
      .insert(member)
      .values({
        id: "on-nhm2",
        organizationId: orgId,
        userId: "on-nh2",
        role: "member",
        createdAt: ago(2),
      })
    const step = stepOf(await onboardingSteps(ownerDb, support, clientId, NOW), "equipo")
    expect(step).toMatchObject({ state: "hecho", doneAt: ago(2), canMarkNotApplicable: false })
    await syncOnboardingMilestones(ownerDb, NOW)
    await clearStepNotApplicable(ownerDb, admin, clientId, "equipo", NOW)
    expect(await milestoneOf(clientId, "equipo")).toMatchObject({
      reachedAt: ago(2),
      naReason: null,
      naAt: null,
    })
  })
})

describe("la columna del alta y lo trabado", () => {
  const steps = (
    states: Partial<Record<(typeof ONBOARDING_STEP_KEYS)[number], OnboardingStep["state"]>>,
  ) => ONBOARDING_STEP_KEYS.map((key) => ({ key, state: states[key] ?? "hecho" }))

  it("sin cuenta no está en el alta; pagó, va a «pago»; si no, el primer grupo con algo que falta", () => {
    expect(onboardingColumn(steps({ entro: "falta", primer_pago: "falta" }), false)).toBeNull()
    expect(onboardingColumn(steps({ entro: "falta", primer_pago: "falta" }), true)).toBe(
      "bienvenida",
    )
    expect(onboardingColumn(steps({ carta: "falta", primer_pago: "falta" }), true)).toBe(
      "bienvenida",
    )
    expect(onboardingColumn(steps({ equipo: "falta", primer_pago: "hecho" }), true)).toBe("pago")
    expect(onboardingColumn(steps({ whatsapp: "no_aplica", primer_pago: "falta" }), true)).toBe(
      "primer_pago",
    )
    expect(
      onboardingColumn(steps({ informe: "falta", whatsapp: "falta", primer_pago: "falta" }), true),
    ).toBe("sus_datos")
  })

  it("trabada con 7 días sin avance, no con 6; nunca en «pago» ni en «Primer pago» con la prueba vigente", () => {
    const at = (days: number) => new Date(NOW.getTime() - days * DAY)
    expect(ALTA_STUCK_DAYS).toBe(7)
    expect(isStuck(at(7), "sus_datos", NOW)).toBe(true)
    expect(isStuck(at(6), "sus_datos", NOW)).toBe(false)
    expect(isStuck(at(30), "pago", NOW)).toBe(false)
    expect(isStuck(at(30), null, NOW)).toBe(false)
    expect(isStuck(at(30), "primer_pago", NOW, { trialActive: true })).toBe(false)
    expect(isStuck(at(30), "primer_pago", NOW, { trialActive: false })).toBe(true)
    // Al desplegar, los días cuentan desde el primer registro de sus hitos.
    expect(isStuck(at(30), "arranque", NOW, { trackedSince: at(2) })).toBe(false)
    expect(isStuck(at(30), "arranque", NOW, { trackedSince: at(8) })).toBe(true)
  })
})

describe("la pasada solo recorre lo que está en alta", () => {
  it("salta demos y archivados", async () => {
    const demo = await clinic("sync-demo")
    await ownerDb
      .update(saasSubscription)
      .set({ isDemo: true })
      .where(eq(saasSubscription.organizationId, demo.orgId))
    await ownerDb.insert(user).values({ id: "on-sd1", name: "Demo", email: "sd1@onboarding.test" })
    await ownerDb
      .insert(member)
      .values({
        id: "on-sdm1",
        organizationId: demo.orgId,
        userId: "on-sd1",
        role: "owner",
        createdAt: ago(3),
      })
    const archived = await clinic("sync-archivado")
    await ownerDb
      .update(saasClient)
      .set({ archivedAt: ago(1) })
      .where(eq(saasClient.id, archived.clientId))
    const sync = await syncOnboardingMilestones(ownerDb, NOW)
    const ids = new Set(sync.alta.map((row) => row.clientId))
    expect(ids.has(demo.clientId)).toBe(false)
    expect(ids.has(archived.clientId)).toBe(false)
    expect(await milestoneOf(demo.clientId, "entro")).toBeNull()
    expect(ids.has(fullClient)).toBe(true)
    expect(ids.has(prospect)).toBe(false)
  })
})
