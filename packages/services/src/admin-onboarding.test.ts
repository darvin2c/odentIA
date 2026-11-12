import { AGREEMENT_VERSION } from "@odentia/auth/legal"
import {
  saasClient,
  saasClientFile,
  saasImportDraft,
  saasInboundEmail,
} from "@odentia/db/schema/admin-arm"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { clinicImportRow } from "@odentia/db/schema/admin-imports"
import { invitation, member, session, user } from "@odentia/db/schema/auth"
import { channelConnection } from "@odentia/db/schema/crm"
import { saasPayment } from "@odentia/db/schema/saas-billing"
import { processingAgreementAcceptance } from "@odentia/db/schema/workspace"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import { ONBOARDING_STEP_KEYS, type OnboardingSteps, onboardingSteps } from "./admin-onboarding.js"
import { PROGRESS_REPORT_ACTIONS } from "./clinic-progress-report.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Ficha › Alta: los pasos se calculan de lo que ya pasó; nadie los marca a mano. */
setupTestDb()
const admin: AdminActor = { userId: "on-admin", role: "admin" }
const support: AdminActor = { userId: "on-support", role: "support" }
const ORG = "on-org"
const FRESH = "on-fresh"
const DAY = 86_400_000
const NOW = new Date()
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)
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
  await ownerDb.insert(saasClientFile).values([
    {
      clientId: fullClient,
      kind: "carta",
      filename: "carta.pdf",
      objectKey: "clients/x/carta.pdf",
      contentType: "application/pdf",
      sizeBytes: 1,
      createdAt: ago(9),
    },
    // Lo de la clínica ya se borró a los 30 días, pero igual llegó.
    {
      clientId: fullClient,
      kind: "archivo_clinica",
      filename: "agenda.xlsx",
      objectKey: "clients/x/agenda.xlsx",
      contentType: "text/csv",
      sizeBytes: 1,
      createdAt: ago(8),
      deletedAt: ago(1),
    },
  ])
  await ownerDb.insert(saasImportDraft).values({
    clientId: fullClient,
    organizationId: ORG,
    kind: "plan_configuracion",
    number: 1,
    payloadKey: "clients/x/plan.json",
    status: "usada",
    uploadedBy: admin.userId,
    approvedBy: admin.userId,
    approvedAt: ago(7),
  })
  await ownerDb.insert(adminAudit).values([
    {
      actorUserId: admin.userId,
      actorRole: "admin",
      action: "org.setup_import",
      organizationId: ORG,
      createdAt: ago(6),
    },
    {
      actorUserId: admin.userId,
      actorRole: "admin",
      action: PROGRESS_REPORT_ACTIONS.enviado,
      organizationId: ORG,
      entityId: "informe-1",
      createdAt: ago(4),
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
  await ownerDb.insert(saasImportDraft).values({
    clientId: freshClient,
    organizationId: FRESH,
    kind: "plan_configuracion",
    number: 1,
    payloadKey: "clients/y/plan.json",
    status: "lista",
    uploadedBy: admin.userId,
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
      plan: ago(7).getTime(),
      configuracion: ago(6).getTime(),
      pacientes: ago(6).getTime(),
      informe: ago(4).getTime(),
      equipo: ago(5).getTime(),
      whatsapp: null,
      primer_uso: ago(9).getTime(),
      primer_pago: ago(2).getTime(),
    })
    expect(stepOf(result, "pacientes").detail).toContain("2 personas en la carga")
    expect(stepOf(result, "primer_pago").detail).not.toMatch(/\d{3,}|USD|29/)
    expect(result).toMatchObject({ done: 11, total: 12, next: "whatsapp" })
  })

  it("lo que falta dice qué hacer; las acciones de la carga no le llegan a Soporte", async () => {
    const forAdmin = await onboardingSteps(ownerDb, admin, freshClient, NOW)
    expect(stepOf(forAdmin, "entro")).toMatchObject({
      doneAt: null,
      action: { code: "reenviar_invitacion", adminOnly: false },
    })
    expect(stepOf(forAdmin, "entro").detail).toContain("no aceptó")
    expect(stepOf(forAdmin, "archivos").doneAt?.getTime()).toBe(ago(1).getTime())
    expect(stepOf(forAdmin, "archivos").detail).toContain("1 correo con adjuntos")
    expect(stepOf(forAdmin, "plan")).toMatchObject({
      doneAt: null,
      action: { code: "revisar_plan", adminOnly: true },
    })
    expect(stepOf(forAdmin, "informe")).toMatchObject({
      doneAt: null,
      action: { code: "revisar_informe" },
    })
    expect(stepOf(forAdmin, "informe").detail).toContain("No se sabe si salió")
    expect(stepOf(forAdmin, "contrato").doneAt).toBeNull()
    expect(forAdmin.next).toBe("entro")

    const forSupport = await onboardingSteps(ownerDb, support, freshClient, NOW)
    expect(forSupport.steps.every((item) => !item.action?.adminOnly)).toBe(true)
    expect(stepOf(forSupport, "plan")).not.toHaveProperty("action")
    expect(stepOf(forSupport, "entro").action?.code).toBe("reenviar_invitacion")
  })

  it("sin cuenta: todo falta, pero lo que ya mandó cuenta", async () => {
    const result = await onboardingSteps(ownerDb, admin, prospect, NOW)
    expect(result).toMatchObject({ organizationId: null, done: 0, next: "entro" })
    expect(stepOf(result, "entro").detail).toContain("Aún no tiene cuenta")
    await expect(onboardingSteps(ownerDb, null, prospect, NOW)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(
      onboardingSteps(ownerDb, admin, "00000000-0000-4000-8000-000000000000", NOW),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("WhatsApp conectado cuenta con el canal activo", async () => {
    await ownerDb.insert(channelConnection).values({
      organizationId: ORG,
      channel: "whatsapp",
      provider: "whatsapp_cloud_api",
      displayName: "+51 987 000 333",
      configEncrypted: "x",
      webhookSecret: "y",
      createdAt: ago(1),
    })
    const result = await onboardingSteps(ownerDb, admin, fullClient, NOW)
    expect(stepOf(result, "whatsapp").doneAt?.getTime()).toBe(ago(1).getTime())
    expect(result).toMatchObject({ done: 12, next: null })
  })
})
