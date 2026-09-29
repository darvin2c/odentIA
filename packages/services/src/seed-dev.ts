/**
 * Seed de dev determinista para prueba manual del panel.
 *
 * Solo manual (`pnpm db:seed`); NUNCA en CI ni importado por tests
 * (cada test crea sus fixtures mínimas). Idempotente: borra solo las
 * orgs/usuarios semilla y los recrea. Prerrequisito: `seed:cie10` antes
 * (los códigos K02.1/K04.0/Z01.2 deben existir; si falta alguno el script
 * falla rápido nombrándolo, sin skips silenciosos).
 *
 * Regla permanente: toda función nueva que añada pantalla o entidad debe
 * extender este archivo con su escenario mínimo en la misma PR.
 */
import { randomUUID } from "node:crypto"
import { deflateSync } from "node:zlib"
import { DEFAULT_REGISTRATION_CONFIG } from "@odentia/clinical"
import { createOwnerDb } from "@odentia/db"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { account, invitation, member, organization, user } from "@odentia/db/schema/auth"
import {
  clinicalFollowUp,
  clinicalNote,
  encounter,
  encounterPlanItem,
  encounterProcedure,
  encounterTooth,
  odontogramAssessment,
  odontogramEntry,
  orgCounter,
  patient,
  patientAllergy,
  patientAnamnesis,
  patientCharge,
  patientCondition,
  patientContact,
  patientDocument,
  patientDocumentContext,
  patientMedication,
  patientPayment,
  patientPaymentApplication,
  patientPaymentRefund,
  patientRegistration,
  patientRegistrationLink,
  patientResponsibility,
  prescription,
  prescriptionItem,
  serviceCatalog,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentOptionGroup,
  treatmentPlan,
  treatmentPlanItem,
  treatmentTemplate,
} from "@odentia/db/schema/clinical"
import {
  agentConfig,
  channelConnection,
  contact,
  contactIdentity,
  conversation,
  crmTask,
  customFieldDef,
  message,
  pipeline,
  pipelineStage,
} from "@odentia/db/schema/crm"
import { auditEvent, branch, orgProfile, patientRegistrationConfig } from "@odentia/db/schema/org"
import { hashPassword } from "better-auth/crypto"
import { and, eq, inArray, or, sql } from "drizzle-orm"
import { upsertAgentConfig } from "./agentConfig.js"
import { createAppointment, createChair } from "./appointments.js"
import { createBudget, decideBudget, presentBudget, reviseBudget } from "./budgets.js"
import {
  addClinicalNote,
  addOdontogramEntries,
  correctDocumentContext,
  createOdontogramAssessment,
  registerPatientDocument,
  savePatientHealth,
  voidOdontogramEntry,
} from "./clinical.js"
import { createConnection } from "./connections.js"
import { createContact, updateContact } from "./contacts.js"
import {
  addEncounterAddendum,
  addEncounterProcedure,
  createEncounter,
  finalizeEncounter,
  updateEncounterDraft,
} from "./encounters.js"
import { createFieldDef } from "./fields.js"
import { cancelFollowUp, completeFollowUp, createFollowUp, scheduleFollowUp } from "./follow-ups.js"
import {
  createPatientRegistrationLink,
  registerPatient,
  savePatientRegistrationConfig,
} from "./patient-registration.js"
import { createPatient, updatePatient } from "./patients.js"
import { applyPayment, createCharge, createPayment, refundPayment } from "./payments.js"
import { ensureDefaultPipeline } from "./pipelines.js"
import { addPlanItem, createOptionGroup, createTreatmentPlan, setPlanItemStatus } from "./plan.js"
import { cancelPrescription, createPrescription } from "./prescriptions.js"
import { grantResponsibility } from "./responsibilities.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { createService } from "./service-catalog.js"
import { createStorage } from "./storage.js"
import { completeTask, createTask } from "./tasks.js"
import { closeOpportunity, createOpportunity } from "./opportunities.js"
import { seedAgent } from "./seed-agent.js"
import { seedAutomation } from "./seed-automation.js"
import { seedAvailability } from "./seed-availability.js"
import { seedChannels } from "./seed-channels.js"
import { seedClinicalForms } from "./seed-clinical-forms.js"
import { seedFinance } from "./seed-finance.js"
import { seedInventory } from "./seed-inventory.js"
import { seedMailbox } from "./seed-mailbox.js"
import { seedOpportunities } from "./seed-opportunities.js"
import { seedPortal } from "./seed-portal.js"
import { seedWebchat } from "./seed-webchat.js"
import { seedWorkspace } from "./seed-workspace.js"
import { seedRoles } from "./seed-roles.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL es obligatoria para sembrar (rol owner)")
// Storage real (MinIO local / R2 prod): los documentos demo se suben de verdad,
// nunca con rutas S3 inventadas. Requiere las mismas variables que la API.
function storageEnvFromProcess(): {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  avatarsBucket: string
  publicBaseUrl: string
  attachmentsBucket: string
} {
  const missing = ["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_ATTACHMENTS_BUCKET"].filter(
    (k) => !process.env[k],
  )
  if (missing.length) throw new Error(`Storage demo sin configurar (faltan ${missing.join(", ")})`)
  const endpoint = process.env.S3_ENDPOINT!
  return {
    endpoint,
    region: process.env.S3_REGION ?? "auto",
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
    avatarsBucket: process.env.S3_BUCKET ?? "avatars",
    publicBaseUrl: process.env.S3_PUBLIC_URL ?? endpoint,
    attachmentsBucket: process.env.S3_ATTACHMENTS_BUCKET!,
  }
}
const storage = createStorage(storageEnvFromProcess())
// PNG real mínimo (1x1) para evidencias demo: bytes válidos que sí se almacenan.
const DEMO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
)
// Nota de voz demo: WAV PCM mono 8 kHz de un beep corto. Se sintetiza (no hay
// encoder de audio disponible) y Chrome lo reproduce sin códec adicional.
function demoVoiceNoteWav(): Buffer {
  const rate = 8000
  const samples = Math.round(rate * 0.6)
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const envelope = 1 - i / samples
    pcm.writeInt16LE(Math.round(12000 * envelope * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
const DEMO_VOICE_WAV = demoVoiceNoteWav()
// Radiografía demo visible (96×64, RGBA) para el adjunto de la bandeja: con un
// PNG 1×1 no se distingue una imagen cargada de una rota al verificar el render.
function demoXRayPng(): Buffer {
  const width = 96
  const height = 64
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < width; x++) {
      const i = rowStart + 1 + x * 4
      const dx = (x - width / 2) / (width / 2)
      const dy = (y - height / 2) / (height / 2)
      const r = Math.hypot(dx, dy)
      // Anillo claro (diente) sobre fondo oscuro + marca diagonal (lesión).
      const ring = r > 0.45 && r < 0.85
      const mark = Math.abs((y - height / 2) * 1.4 - (x - width / 2)) < 3
      const value = mark ? 235 : ring ? 205 : 45
      raw[i] = value
      raw[i + 1] = Math.min(255, value + (mark ? 10 : 25))
      raw[i + 2] = Math.min(255, value + (mark ? 20 : 40))
      raw[i + 3] = 255
    }
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length, 0)
    const payload = Buffer.concat([Buffer.from(type, "ascii"), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(payload), 0)
    return Buffer.concat([length, payload, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bits por canal
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}
function crc32(input: Buffer): number {
  let crc = 0xffffffff
  for (const byte of input) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
const DEMO_XRAY_PNG = demoXRayPng()
const secretsKey = secretsKeyFromEnv(process.env.SECRETS_KEY)

const db = createOwnerDb(databaseUrl)

const ORG_A = "seed-org-dental-smile"
const ORG_B = "seed-org-clinica-norte"
const SEED_ORGS = [ORG_A, ORG_B]
const ANA_ID = "seed-user-ana"
const LUIS_ID = "seed-user-luis"
const CORA_ID = "seed-user-cora"
const SEED_USERS = [ANA_ID, LUIS_ID, CORA_ID]
const PASSWORD = "Demo1234"
// Teléfono compartido del hogar Rosa/Jorge. No puede modelarse con dos filas
// de contact_identity: el unique (organization_id, channel, external_user_id)
// lo impide (ver comentario de invariante en el schema). Rosa lo porta como
// identidad whatsapp; Jorge lo referencia en sus notas.
const SHARED_PHONE = "+51987654999"

const hoursAgo = (h: number): Date => new Date(Date.now() - h * 3_600_000)
const daysAgo = (d: number): Date => new Date(Date.now() - d * 86_400_000)
const tomorrowIso = (): string => new Date(Date.now() + 86_400_000).toISOString()
async function wipeSeed(): Promise<void> {
  const previousDocuments = await db
    .select({ storageKey: patientDocument.storageKey })
    .from(patientDocument)
    .where(inArray(patientDocument.organizationId, SEED_ORGS))
  const previousMessages = await db
    .select({ attachments: message.attachments })
    .from(message)
    .where(inArray(message.organizationId, SEED_ORGS))
  // Hijos de los nuevos dominios: purga únicamente las organizaciones demo.
  for (const table of [
    "portal_access_log", "portal_session", "portal_link",
    "automation_link_token", "automation_job", "automation_consent", "automation_rule",
    "agent_run_ledger", "agent_proposal", "agent_handoff",
    "agent_knowledge_revision", "agent_knowledge_entry", "agent_policy",
    "workspace_notification", "opportunity_event", "opportunity",
    "clinical_form_addendum", "clinical_form_response", "consent_event", "consent_document",
    "clinical_order", "clinical_form_template", "consent_template",
    "professional_specialty", "service_specialty", "org_specialty",
    "commission_settlement_line", "commission_settlement", "commission_rule",
    "installment_quota", "installment_plan", "cash_movement", "expense", "cash_shift",
    "stock_movement", "product_lot", "purchase_order_line", "purchase_order",
    "product", "warehouse", "supplier", "mailbox_oauth_state",
    "waitlist_entry", "schedule_block", "professional_schedule",
  ]) {
    await db.execute(sql`delete from ${sql.identifier(table)} where organization_id in (${ORG_A}, ${ORG_B})`)
  }
  // Finanzas, recetas, controles y responsabilidades: antes que sus padres
  // (vínculos de contacto, atenciones, ítems, líneas y documentos).
  await db
    .delete(patientPaymentApplication)
    .where(inArray(patientPaymentApplication.organizationId, SEED_ORGS))
  await db
    .delete(patientPaymentRefund)
    .where(inArray(patientPaymentRefund.organizationId, SEED_ORGS))
  await db.delete(patientCharge).where(inArray(patientCharge.organizationId, SEED_ORGS))
  await db.delete(patientPayment).where(inArray(patientPayment.organizationId, SEED_ORGS))
  await db.delete(prescriptionItem).where(inArray(prescriptionItem.organizationId, SEED_ORGS))
  await db.delete(prescription).where(inArray(prescription.organizationId, SEED_ORGS))
  await db.delete(clinicalFollowUp).where(inArray(clinicalFollowUp.organizationId, SEED_ORGS))
  await db
    .delete(patientResponsibility)
    .where(inArray(patientResponsibility.organizationId, SEED_ORGS))
  await db.delete(patientRegistration).where(inArray(patientRegistration.organizationId, SEED_ORGS))
  await db
    .delete(patientRegistrationLink)
    .where(inArray(patientRegistrationLink.organizationId, SEED_ORGS))
  await db.delete(patientContact).where(inArray(patientContact.organizationId, SEED_ORGS))
  await db
    .delete(patientRegistrationConfig)
    .where(inArray(patientRegistrationConfig.organizationId, SEED_ORGS))
  await db.delete(message).where(inArray(message.organizationId, SEED_ORGS))
  await db.delete(crmTask).where(inArray(crmTask.organizationId, SEED_ORGS))
  // Las citas creadas por el agente referencian su conversación: se suelta la
  // referencia antes de borrarla (las citas se purgan más abajo).
  await db
    .update(appointment)
    .set({ conversationId: null })
    .where(inArray(appointment.organizationId, SEED_ORGS))
  await db.delete(conversation).where(inArray(conversation.organizationId, SEED_ORGS))
  await db.delete(contactIdentity).where(inArray(contactIdentity.organizationId, SEED_ORGS))
  await db.delete(encounterProcedure).where(inArray(encounterProcedure.organizationId, SEED_ORGS))
  await db.delete(encounterTooth).where(inArray(encounterTooth.organizationId, SEED_ORGS))
  await db.delete(clinicalNote).where(inArray(clinicalNote.organizationId, SEED_ORGS))
  // Los ítems del plan referencian el hallazgo que los motivó: se suelta la
  // referencia antes de borrar el odontograma (los ítems se borran después).
  await db
    .update(treatmentPlanItem)
    .set({ odontogramEntryId: null })
    .where(inArray(treatmentPlanItem.organizationId, SEED_ORGS))
  await db.delete(odontogramEntry).where(inArray(odontogramEntry.organizationId, SEED_ORGS))
  await db
    .delete(odontogramAssessment)
    .where(inArray(odontogramAssessment.organizationId, SEED_ORGS))
  // Contextos antes que documentos; vínculos atención-plan antes que ítems y
  // presupuestos (FK en cascada parcial, orden explícito e idempotente).
  await db
    .delete(patientDocumentContext)
    .where(inArray(patientDocumentContext.organizationId, SEED_ORGS))
  await db.delete(encounterPlanItem).where(inArray(encounterPlanItem.organizationId, SEED_ORGS))
  await db.delete(patientDocument).where(inArray(patientDocument.organizationId, SEED_ORGS))
  await db.delete(patientAnamnesis).where(inArray(patientAnamnesis.organizationId, SEED_ORGS))
  await db.delete(patientAllergy).where(inArray(patientAllergy.organizationId, SEED_ORGS))
  await db.delete(patientCondition).where(inArray(patientCondition.organizationId, SEED_ORGS))
  await db.delete(patientMedication).where(inArray(patientMedication.organizationId, SEED_ORGS))
  // Solo el reset manual owner elimina snapshots demo; el guard runtime queda intacto.
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`alter table treatment_budget_item disable trigger treatment_budget_item_guard_trigger`,
    )
    await tx
      .delete(treatmentBudgetItem)
      .where(inArray(treatmentBudgetItem.organizationId, SEED_ORGS))
    await tx.execute(
      sql`alter table treatment_budget_item enable trigger treatment_budget_item_guard_trigger`,
    )
  })
  await db.delete(treatmentPlanItem).where(inArray(treatmentPlanItem.organizationId, SEED_ORGS))
  await db
    .delete(treatmentOptionGroup)
    .where(inArray(treatmentOptionGroup.organizationId, SEED_ORGS))
  await db.delete(treatmentBudget).where(inArray(treatmentBudget.organizationId, SEED_ORGS))
  await db.delete(treatmentPlan).where(inArray(treatmentPlan.organizationId, SEED_ORGS))
  await db.delete(appointment).where(inArray(appointment.organizationId, SEED_ORGS))
  await db.delete(scheduleChair).where(inArray(scheduleChair.organizationId, SEED_ORGS))
  await db.delete(encounter).where(inArray(encounter.organizationId, SEED_ORGS))
  await db.delete(serviceCatalog).where(inArray(serviceCatalog.organizationId, SEED_ORGS))
  // El snapshot del registro referencia `user`, `patient`, `contact` y `branch`
  // sin cascada: sin borrarlo primero, la baja del usuario semilla falla por FK.
  // Se borra por organización **y** por actor: una corrida de e2e deja registros
  // en su propia organización que también apuntan a los usuarios semilla.
  await db
    .delete(patientRegistration)
    .where(
      or(
        inArray(patientRegistration.organizationId, SEED_ORGS),
        inArray(patientRegistration.actorUserId, SEED_USERS),
      ),
    )
  await db.delete(patient).where(inArray(patient.organizationId, SEED_ORGS))
  await db.delete(contact).where(inArray(contact.organizationId, SEED_ORGS))
  await db.delete(pipelineStage).where(inArray(pipelineStage.organizationId, SEED_ORGS))
  await db.delete(pipeline).where(inArray(pipeline.organizationId, SEED_ORGS))
  await db.delete(channelConnection).where(inArray(channelConnection.organizationId, SEED_ORGS))
  await db.delete(customFieldDef).where(inArray(customFieldDef.organizationId, SEED_ORGS))
  await db.delete(agentConfig).where(inArray(agentConfig.organizationId, SEED_ORGS))
  await db.delete(orgCounter).where(inArray(orgCounter.organizationId, SEED_ORGS))
  await db.delete(branch).where(inArray(branch.organizationId, SEED_ORGS))
  await db.delete(orgProfile).where(inArray(orgProfile.organizationId, SEED_ORGS))
  await db.delete(auditEvent).where(inArray(auditEvent.organizationId, SEED_ORGS))
  await db.delete(member).where(inArray(member.organizationId, SEED_ORGS))
  await db.delete(invitation).where(inArray(invitation.organizationId, SEED_ORGS))
  await db.delete(organization).where(inArray(organization.id, SEED_ORGS))
  await db.execute(sql`delete from "verification" where "identifier" ilike '%@odentia.dev%'`)
  await db.delete(user).where(inArray(user.id, SEED_USERS))
  for (const document of previousDocuments) await storage.deleteAttachment(document.storageKey)
  for (const row of previousMessages) {
    if (!Array.isArray(row.attachments)) continue
    for (const attachment of row.attachments) {
      if (
        attachment &&
        typeof attachment === "object" &&
        "objectKey" in attachment &&
        typeof attachment.objectKey === "string"
      ) {
        await storage.deleteAttachment(attachment.objectKey)
      }
    }
  }
}

async function seedConversation(args: {
  orgId: string
  contactId: string
  connectionId: string
  thread: string
  status?: string
  agentStatus?: string
  assignedUserId?: string | null
  unreadCount?: number
  lastInboundAt?: Date | null
  lastOutboundAt?: Date | null
  lastMessageAt?: Date | null
}): Promise<{ id: string }> {
  const [connection] = await db
    .select({ channel: channelConnection.channel })
    .from(channelConnection)
    .where(eq(channelConnection.id, args.connectionId))
  const identities = await db
    .select({ id: contactIdentity.id, externalUserId: contactIdentity.externalUserId })
    .from(contactIdentity)
    .where(
      and(
        eq(contactIdentity.organizationId, args.orgId),
        eq(contactIdentity.contactId, args.contactId),
        eq(contactIdentity.channel, connection!.channel),
      ),
    )
  const identity = identities.length === 1 ? identities[0] : undefined
  const [row] = await db
    .insert(conversation)
    .values({
      organizationId: args.orgId,
      contactId: args.contactId,
      contactIdentityId: identity?.id ?? null,
      channelConnectionId: args.connectionId,
      externalThreadId:
        connection?.channel === "whatsapp" && identity ? identity.externalUserId : args.thread,
      status: args.status ?? "open",
      assignedUserId: args.assignedUserId ?? null,
      agentStatus: args.agentStatus ?? "on",
      unreadCount: args.unreadCount ?? 0,
      lastInboundAt: args.lastInboundAt ?? null,
      lastOutboundAt: args.lastOutboundAt ?? null,
      lastMessageAt: args.lastMessageAt ?? null,
    })
    .returning({ id: conversation.id })
  if (!row) throw new Error(`No se pudo crear la conversación ${args.thread}`)
  return row
}

async function seedMessage(args: {
  orgId: string
  conversationId: string
  direction: string
  senderKind: string
  senderUserId?: string | null
  body?: string | null
  contentType?: string
  attachments?: unknown[]
  externalId: string
  status: string
  createdAt: Date
}): Promise<void> {
  const [row] = await db
    .insert(message)
    .values({
      organizationId: args.orgId,
      conversationId: args.conversationId,
      direction: args.direction,
      senderKind: args.senderKind,
      senderUserId: args.senderUserId ?? null,
      contentType: args.contentType ?? "text",
      body: args.body ?? null,
      attachments: args.attachments ?? [],
      externalId: args.externalId,
      status: args.status,
      createdAt: args.createdAt,
    })
    .returning({ id: message.id })
  if (!row) throw new Error(`No se pudo crear el mensaje ${args.externalId}`)
}

async function countWhere(table: string, orgId: string): Promise<number> {
  const rows = (await db.execute(
    sql.raw(`select count(*)::int as n from "${table}" where "organization_id" = '${orgId}'`),
  )) as unknown as Array<{ n: number }>
  return rows[0]?.n ?? 0
}

await wipeSeed()

// --- Identidad fija ---
await db.insert(organization).values([
  { id: ORG_A, name: "Dental Smile", slug: "dental-smile", createdAt: new Date() },
  { id: ORG_B, name: "Clínica Norte", slug: "clinica-norte", createdAt: new Date() },
])
await db.insert(user).values([
  {
    id: ANA_ID,
    name: "Dra. Ana Torres",
    firstName: "Ana",
    lastName: "Torres",
    email: "ana@odentia.dev",
    emailVerified: true,
  },
  {
    id: LUIS_ID,
    name: "Luis Prado",
    firstName: "Luis",
    lastName: "Prado",
    email: "luis@odentia.dev",
    emailVerified: true,
  },
  {
    id: CORA_ID,
    name: "Dra. Cora Vega",
    firstName: "Cora",
    lastName: "Vega",
    email: "cora@odentia.dev",
    emailVerified: true,
  },
])
const passwordHash = await hashPassword(PASSWORD)
await db.insert(account).values(
  [ANA_ID, LUIS_ID, CORA_ID].map((userId) => ({
    id: randomUUID(),
    accountId: userId,
    providerId: "credential",
    userId,
    password: passwordHash,
  })),
)
await db.insert(member).values([
  { id: randomUUID(), organizationId: ORG_A, userId: ANA_ID, role: "owner", createdAt: new Date() },
  {
    id: randomUUID(),
    organizationId: ORG_A,
    userId: LUIS_ID,
    role: "dentist",
    createdAt: new Date(),
  },
  {
    id: randomUUID(),
    organizationId: ORG_B,
    userId: LUIS_ID,
    role: "dentist",
    createdAt: new Date(),
  },
  {
    id: randomUUID(),
    organizationId: ORG_B,
    userId: CORA_ID,
    role: "owner",
    createdAt: new Date(),
  },
])
await db.insert(orgProfile).values([
  {
    organizationId: ORG_A,
    legalName: "Dental Smile S.A.C.",
    fiscalDocNumber: "20601234567",
    // Explicito: país, moneda, idioma y zona son el contrato de la agenda y del
    // formato de los teléfonos (IANA canónico y ISO-3166-1).
    countryCode: "PE",
    currency: "PEN",
    locale: "es-PE",
    timezone: "America/Lima",
  },
  {
    organizationId: ORG_B,
    legalName: "Clínica Norte S.A.C.",
    fiscalDocNumber: "20550987654",
    countryCode: "PE",
    currency: "PEN",
    locale: "es-PE",
    timezone: "America/Lima",
  },
])
const [miraflores] = await db
  .insert(branch)
  .values([
    // Miraflores hereda la zona de la organización (`timezone` en null).
    { organizationId: ORG_A, name: "Sede Miraflores", ubigeo: "150122" },
    // Surco ejercita el camino contrario: teléfono y zona propios.
    {
      organizationId: ORG_A,
      name: "Sede Surco",
      ubigeo: "150140",
      phone: "+51987655001",
      timezone: "America/Lima",
    },
  ])
  .returning({ id: branch.id })
if (!miraflores) throw new Error("No se pudo crear la sucursal Sede Miraflores")
await db.insert(branch).values([{ organizationId: ORG_B, name: "Sede Lima" }])

// --- CRM con servicios ---
const pipeA = await ensureDefaultPipeline(db, ORG_A)
const pipeB = await ensureDefaultPipeline(db, ORG_B)

await createFieldDef(db, ORG_A, { key: "dni", label: "DNI", type: "text" })
await createFieldDef(db, ORG_A, {
  key: "fecha_nacimiento",
  label: "Fecha de nacimiento",
  type: "date",
})
await createFieldDef(db, ORG_A, {
  key: "aseguradora",
  label: "Aseguradora",
  type: "select",
  options: ["Rimac", "Pacifico", "Particular"],
})

const connA = await createConnection(
  db,
  ORG_A,
  secretsKey,
  {
    channel: "whatsapp",
    provider: "whatsapp_cloud_api",
    displayName: "WhatsApp Dental Smile",
    config: {
      phoneNumberId: "seed",
      displayPhoneNumber: "+51999888777",
      accessToken: "seed-dev",
    },
  },
  { fetch, validateExternal: false },
)
const connB = await createConnection(
  db,
  ORG_B,
  secretsKey,
  {
    channel: "whatsapp",
    provider: "whatsapp_cloud_api",
    displayName: "WhatsApp Norte",
    config: {
      phoneNumberId: "seed",
      displayPhoneNumber: "+51999888776",
      accessToken: "seed-dev",
    },
  },
  { fetch, validateExternal: false },
)

// --- Contactos A (reparto por etapa según posición) ---
const CONTACTS_A = [
  { name: "Rosa Quispe", phone: SHARED_PHONE },
  { name: "Jorge Mamani", phone: "+51987654302" },
  { name: "Elena Huamán", phone: "+51987654303" },
  { name: "Carlos Paredes", phone: "+51987654304" },
  { name: "Lucía Fernández", phone: "+51987654305" },
  { name: "Miguel Torres", phone: "+51987654306" },
  { name: "Carmen Rojas", phone: "+51987654307" },
  { name: "Diego Salazar", phone: "+51987654308" },
  { name: "Patricia León", phone: "+51987654309" },
  { name: "Andrés Vega", phone: "+51987654310" },
]
const contactIdByName = new Map<string, string>()
for (let i = 0; i < CONTACTS_A.length; i++) {
  const c = CONTACTS_A[i]!
  const stageId = pipeA.stages[i % pipeA.stages.length]!.id
  const notes =
    c.name === "Jorge Mamani"
      ? `Teléfono familiar compartido: ${SHARED_PHONE} (titular: Rosa Quispe)`
      : undefined
  const created = await createContact(
    db,
    ORG_A,
    { displayName: c.name, phone: c.phone, notes },
    { userId: ANA_ID },
  )
  const historicalStage = pipeA.stages[i % pipeA.stages.length]!
  const openStage = pipeA.stages.find(stage => stage.kind === "open")!
  const commercial = await createOpportunity(db, ORG_A, {
    contactId: created.id,
    stageId: historicalStage.kind === "open" ? stageId : openStage.id,
    title: `Seguimiento · ${c.name}`,
  }, { userId: ANA_ID })
  if (historicalStage.kind === "won" || historicalStage.kind === "lost") {
    await closeOpportunity(db, ORG_A, commercial.id, {
      outcome: historicalStage.kind,
      reason: "Resultado del escenario de demostración",
    }, { userId: ANA_ID })
  }
  await db.insert(contactIdentity).values({
    organizationId: ORG_A,
    contactId: created.id,
    channel: "whatsapp",
    externalUserId: `wa:${c.phone.replace(/\D/g, "")}`,
    displayName: c.name,
    isPrimary: true,
  })
  contactIdByName.set(c.name, created.id)
}

// --- Conversaciones A ---
const convRosa = await seedConversation({
  orgId: ORG_A,
  contactId: contactIdByName.get("Rosa Quispe")!,
  connectionId: connA.id,
  thread: "seed-thread-1",
  unreadCount: 3,
  lastInboundAt: hoursAgo(1),
  lastMessageAt: hoursAgo(1),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convRosa.id,
  direction: "inbound",
  senderKind: "contact",
  body: "Hola, ¿tienen cita para mañana por dolor de muela?",
  externalId: "seed-msg-1",
  status: "received",
  createdAt: hoursAgo(3),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convRosa.id,
  direction: "inbound",
  senderKind: "contact",
  body: "Es un dolor fuerte en la muela de abajo, del lado derecho",
  externalId: "seed-msg-2",
  status: "received",
  createdAt: hoursAgo(2),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convRosa.id,
  direction: "inbound",
  senderKind: "contact",
  body: "¿Atienden por la tarde? Trabajo hasta las 5",
  externalId: "seed-msg-3",
  status: "received",
  createdAt: hoursAgo(1),
})
// Adjuntos demo con bytes reales: la imagen se ve inline y la nota de voz con
// su transcripción debajo (así se prueba el render sin TRANSCRIBE_*).
const rosaImageRef = await storage.putAttachment({
  orgId: ORG_A,
  conversationId: convRosa.id,
  bytes: DEMO_XRAY_PNG,
  contentType: "image/png",
  ext: "png",
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convRosa.id,
  direction: "inbound",
  senderKind: "contact",
  body: "Esta es la muela que me duele",
  contentType: "image",
  attachments: [
    {
      objectKey: rosaImageRef.objectKey,
      mimeType: rosaImageRef.mimeType,
      filename: "radiografia-demo.png",
      size: rosaImageRef.size,
    },
  ],
  externalId: "seed-msg-4",
  status: "received",
  createdAt: hoursAgo(1),
})
const rosaVoiceRef = await storage.putAttachment({
  orgId: ORG_A,
  conversationId: convRosa.id,
  bytes: DEMO_VOICE_WAV,
  contentType: "audio/wav",
  ext: "wav",
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convRosa.id,
  direction: "inbound",
  senderKind: "contact",
  body: "Hola, quiero una cita para mañana",
  contentType: "audio",
  attachments: [
    {
      objectKey: rosaVoiceRef.objectKey,
      mimeType: rosaVoiceRef.mimeType,
      filename: "nota-de-voz-demo.wav",
      size: rosaVoiceRef.size,
    },
  ],
  externalId: "seed-msg-5",
  status: "received",
  createdAt: hoursAgo(1),
})

const convJorge = await seedConversation({
  orgId: ORG_A,
  contactId: contactIdByName.get("Jorge Mamani")!,
  connectionId: connA.id,
  thread: "seed-thread-2",
  assignedUserId: LUIS_ID,
  lastInboundAt: hoursAgo(5),
  lastOutboundAt: hoursAgo(4),
  lastMessageAt: hoursAgo(4),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convJorge.id,
  direction: "inbound",
  senderKind: "contact",
  body: "Buenas tardes, quiero cotizar una endodoncia",
  externalId: "seed-msg-4",
  status: "read",
  createdAt: hoursAgo(5),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convJorge.id,
  direction: "outbound",
  senderKind: "user",
  senderUserId: LUIS_ID,
  body: "Hola Jorge, claro que sí. ¿Podrías venir mañana para una evaluación? El precio depende del caso.",
  externalId: "seed-msg-5",
  status: "read",
  createdAt: hoursAgo(4),
})

const elenaClosedAt = daysAgo(2)
const convElena = await seedConversation({
  orgId: ORG_A,
  contactId: contactIdByName.get("Elena Huamán")!,
  connectionId: connA.id,
  thread: "seed-thread-3",
  status: "closed",
  lastInboundAt: elenaClosedAt,
  lastOutboundAt: new Date(elenaClosedAt.getTime() + 600_000),
  lastMessageAt: new Date(elenaClosedAt.getTime() + 600_000),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convElena.id,
  direction: "inbound",
  senderKind: "contact",
  body: "Hola, quiero confirmar mi cita de limpieza de mañana",
  externalId: "seed-msg-6",
  status: "read",
  createdAt: elenaClosedAt,
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convElena.id,
  direction: "outbound",
  senderKind: "agent",
  body: "Hola Elena, tu cita de limpieza quedó confirmada para mañana a las 10:00 am.",
  externalId: "seed-msg-7",
  status: "read",
  createdAt: new Date(elenaClosedAt.getTime() + 600_000),
})

const convCarlos = await seedConversation({
  orgId: ORG_A,
  contactId: contactIdByName.get("Carlos Paredes")!,
  connectionId: connA.id,
  thread: "seed-thread-4",
  agentStatus: "off",
  unreadCount: 1,
  lastInboundAt: hoursAgo(6),
  lastMessageAt: hoursAgo(6),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convCarlos.id,
  direction: "inbound",
  senderKind: "contact",
  body: "¿Cuánto cuesta una extracción de muela del juicio?",
  externalId: "seed-msg-8",
  status: "received",
  createdAt: hoursAgo(6),
})

// --- Tareas A ---
await createTask(db, ORG_A, {
  title: "Llamar a Rosa para confirmar cita",
  contactId: contactIdByName.get("Rosa Quispe")!,
  assigneeUserId: LUIS_ID,
  dueAt: tomorrowIso(),
  createdBy: "user",
})
const budget = await createTask(db, ORG_A, {
  title: "Enviar presupuesto de endodoncia",
  createdBy: "user",
})
await completeTask(db, ORG_A, budget.id)
await createTask(db, ORG_A, {
  title: "Revisar stock de anestesia",
  assigneeUserId: ANA_ID,
  createdBy: "user",
})

// --- Agente A (B sin fila: ejercita el default deshabilitado) ---
await upsertAgentConfig(db, ORG_A, {
  enabled: true,
  model: null,
  systemPrompt: "Eres el asistente de Dental Smile. Responde en español, tono amable.",
  handoffKeywords: ["humano", "asesor", "recepcion"],
  maxTurns: 10,
})

// --- Pacientes + clínica (org A) ---
const PATIENTS_A = [
  { name: "Rosa Quispe", doc: "45678901", birth: "1990-05-14", sex: "F" },
  { name: "Elena Huamán", doc: "45678902", birth: "1985-11-02", sex: "F" },
  { name: "Carlos Paredes", doc: "45678903", birth: "1978-03-21", sex: "M" },
  { name: "Lucía Fernández", doc: "45678904", birth: "1995-07-30", sex: "F" },
  { name: "Miguel Torres", doc: "45678905", birth: "1982-01-17", sex: "M" },
  { name: "Carmen Rojas", doc: "45678906", birth: "1992-09-08", sex: "F" },
]
const patientIdByName = new Map<string, string>()
for (const p of PATIENTS_A) {
  const row = await createPatient(db, ORG_A, ANA_ID, {
    displayName: p.name,
    contacts: [
      { contactId: contactIdByName.get(p.name)!, relationship: "self", isPreferred: true },
    ],
    docType: "DNI",
    docNumber: p.doc,
    birthDate: p.birth,
    sex: p.sex,
    phone:
      p.name === "Rosa Quispe" ? SHARED_PHONE : CONTACTS_A.find((c) => c.name === p.name)?.phone,
    registeredBranchId: miraflores.id,
  })
  patientIdByName.set(p.name, row.id)
}

const rosaPatientId = patientIdByName.get("Rosa Quispe")!
// Antecedentes en un solo guardado transaccional (revisión 0 → 1).
const rosaHealthV1 = await savePatientHealth(db, ORG_A, ANA_ID, rosaPatientId, {
  expectedRevision: 0,
  reviewStatus: { allergies: "recorded", conditions: "recorded", medications: "recorded" },
  allergies: [{ substance: "Penicilina", reaction: "Urticaria", severity: "severa" }],
  conditions: [
    { name: "Hipertensión arterial", status: "activa", notes: "Controlada con medicación" },
  ],
  medications: [{ name: "Losartán", dose: "50 mg", frequency: "1 vez al día" }],
  anamnesis: {
    expectedVersion: 0,
    answers: {
      antecedentesPersonales: {
        hospitalizaciones: "Ninguna",
        cirugias: "Ninguna",
        transfusiones: "Ninguna",
      },
      antecedentesFamiliares: "Madre con hipertensión arterial",
      antecedentesOdontologicos: {
        ultimaVisita: "Hace 1 año",
        cepilladosAlDia: 2,
        experienciaPrevia: "regular",
        ansiedadDental: "leve",
      },
    },
  },
})
// Segunda revisión: suma bruxismo a la entrevista (versión 2) sin tocar lo demás.
await savePatientHealth(db, ORG_A, ANA_ID, rosaPatientId, {
  expectedRevision: 1,
  reviewStatus: { allergies: "recorded", conditions: "recorded", medications: "recorded" },
  allergies: rosaHealthV1.allergies.map((a) => ({
    id: a.id,
    substance: a.substance,
    reaction: a.reaction,
    severity: a.severity,
  })),
  conditions: rosaHealthV1.conditions.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    notes: c.notes,
  })),
  medications: [
    ...rosaHealthV1.medications.map((m) => ({
      id: m.id,
      name: m.name,
      dose: m.dose,
      frequency: m.frequency,
    })),
    {
      name: "Ácido acetilsalicílico",
      dose: "100 mg",
      frequency: "1 vez al día",
      notes: "Suspendida por indicación médica",
      endDate: "2024-06-01",
    },
  ],
  anamnesis: {
    expectedVersion: 1,
    answers: {
      antecedentesPersonales: {
        hospitalizaciones: "Ninguna",
        cirugias: "Ninguna",
        transfusiones: "Ninguna",
      },
      antecedentesFamiliares: "Madre con hipertensión arterial",
      antecedentesOdontologicos: {
        ultimaVisita: "Hace 1 año",
        cepilladosAlDia: 2,
        experienciaPrevia: "regular",
        ansiedadDental: "leve",
        bruxismo: true,
      },
    },
  },
})
// Catálogo base en ambas orgs (precios de ejemplo se administran aquí; el plan
// solo congela desde el servicio elegido, nunca montos manuales).
const seedOffers: Array<{
  code: string
  name: string
  specialty: string
  scope: string
  priceCents: number
  durationMin: number
}> = [
  {
    code: "OBTURACION",
    name: "Obturación con resina",
    specialty: "restauradora",
    scope: "tooth",
    priceCents: 18000,
    durationMin: 45,
  },
  {
    code: "ENDODONCIA",
    name: "Endodoncia unirradicular",
    specialty: "endodoncia",
    scope: "tooth",
    priceCents: 45000,
    durationMin: 90,
  },
  {
    code: "CORONA",
    name: "Corona cerámica",
    specialty: "protesis",
    scope: "tooth",
    priceCents: 90000,
    durationMin: 60,
  },
  {
    code: "BLANQUEAMIENTO",
    name: "Blanqueamiento dental",
    specialty: "estetica",
    scope: "arch",
    priceCents: 60000,
    durationMin: 60,
  },
  {
    code: "LIMPIEZA",
    name: "Limpieza dental (profilaxis)",
    specialty: "prevencion",
    scope: "general",
    priceCents: 12000,
    durationMin: 45,
  },
  {
    code: "ORTODONCIA_CTRL",
    name: "Control de ortodoncia",
    specialty: "ortodoncia",
    scope: "general",
    priceCents: 10000,
    durationMin: 30,
  },
]
const catalogA: Array<Awaited<ReturnType<typeof createService>>> = []
for (const offer of seedOffers) {
  catalogA.push(await createService(db, ORG_A, ANA_ID, offer))
  await createService(db, ORG_B, CORA_ID, offer)
}
const serviceIdA = (code: string): string => {
  const found = catalogA.find((s) => s.code === code)
  if (!found) throw new Error(`Servicio ${code} ausente del catálogo semilla`)
  return found.id
}
// Oferta oficial precisa: resina posterior de una superficie (CPMS D2391).
// El mismo snapshot se conserva en plan, presupuesto y atención.
const [resinaTemplate] = await db
  .select()
  .from(treatmentTemplate)
  .where(eq(treatmentTemplate.key, "cpms:RM-550-2023-MINSA:D2391"))
  .limit(1)
if (!resinaTemplate) throw new Error("Falta CPMS D2391: ejecuta seed:procedures")
const resinaCpmsA = await createService(db, ORG_A, ANA_ID, {
  templateId: resinaTemplate.id,
  code: "RESINA-CPMS",
  priceCents: 18000,
  durationMin: 45,
})
catalogA.push(resinaCpmsA)
await createService(db, ORG_B, CORA_ID, {
  templateId: resinaTemplate.id,
  code: "RESINA-CPMS",
  priceCents: 18000,
  durationMin: 45,
})
// Consultas CPMS en el tarifario: la consulta también es una prestación con
// tarifa (D0140); el control postoperatorio va incluido (D0171 a S/ 0).
const consultaTemplates = await db
  .select()
  .from(treatmentTemplate)
  .where(
    inArray(treatmentTemplate.key, [
      "cpms:RM-550-2023-MINSA:D0140",
      "cpms:RM-550-2023-MINSA:D0171",
    ]),
  )
if (consultaTemplates.length !== 2) {
  throw new Error("Faltan consultas CPMS D0140/D0171: ejecuta seed:procedures")
}
for (const tpl of consultaTemplates) {
  const isControl = tpl.key.endsWith(":D0171")
  const offer = {
    templateId: tpl.id,
    code: isControl ? "CONTROL-POSTOP" : "CONSULTA",
    priceCents: isControl ? 0 : 8000,
    durationMin: 30,
  }
  catalogA.push(await createService(db, ORG_A, ANA_ID, offer))
  await createService(db, ORG_B, CORA_ID, offer)
}
// Evaluación inicial (borrador) antes del plan: la indicación nace aquí y la
// ejecución continúa en la misma atención (un solo borrador por paciente).
const draft = await createEncounter(db, ORG_A, ANA_ID, rosaPatientId, {
  reason: "Dolor molar inferior derecho",
  teeth: [36, 46],
  branchId: miraflores.id,
})
// Plan 1 de Rosa: existe antes del presupuesto y continúa en varias visitas.
const planRestaurador = await createTreatmentPlan(db, ORG_A, ANA_ID, rosaPatientId, {
  title: "Plan restaurador molar",
  originEncounterId: draft.id,
})
const hallazgos36 = await addOdontogramEntries(db, ORG_A, ANA_ID, rosaPatientId, {
  toothNumber: 36,
  condition: "caries",
  surfaces: ["occlusal"],
  details: { variant: "dentin" },
  diagnosisCode: "K02.1",
  encounterId: draft.id,
})
const obt36 = await addPlanItem(db, ORG_A, ANA_ID, rosaPatientId, {
  serviceId: resinaCpmsA.id,
  planId: planRestaurador.id,
  sourceEncounterId: draft.id,
  odontogramEntryId: hallazgos36[0]!.id,
  toothNumber: 36,
  surfaces: ["occlusal"],
  diagnosisCode: "K02.1",
  detail: "Obturación pieza 36",
})
const endo46 = await addPlanItem(db, ORG_A, ANA_ID, rosaPatientId, {
  serviceId: serviceIdA("ENDODONCIA"),
  planId: planRestaurador.id,
  sourceEncounterId: draft.id,
  toothNumber: 46,
  diagnosisCode: "K04.0",
  detail: "Endodoncia pieza 46",
})
const corona46 = await addPlanItem(db, ORG_A, ANA_ID, rosaPatientId, {
  serviceId: serviceIdA("CORONA"),
  planId: planRestaurador.id,
  sourceEncounterId: draft.id,
  toothNumber: 46,
  diagnosisCode: "K04.0",
  detail: "Corona cerámica pieza 46 (diferida)",
})
// Presupuesto 1 de Rosa: 3 ítems del plan, aceptación parcial (corona diferida
// por la paciente; NUNCA se infiere aceptación histórica, todo pasa por decisión).
const budgetRestaurador = await createBudget(db, ORG_A, ANA_ID, rosaPatientId, {
  planId: planRestaurador.id,
  itemIds: [obt36.id, endo46.id, corona46.id],
  title: "Plan restaurador molar",
  notes: "Obturación 36 + endodoncia 46; corona diferida a segunda etapa.",
})
await presentBudget(db, ORG_A, ANA_ID, rosaPatientId, budgetRestaurador.id)
await decideBudget(db, ORG_A, ANA_ID, rosaPatientId, budgetRestaurador.id, {
  decisions: [
    { planItemId: obt36.id, decision: "aceptado" },
    { planItemId: endo46.id, decision: "aceptado" },
    { planItemId: corona46.id, decision: "pospuesto" },
  ],
  decisionNote: "Acepta obturación y endodoncia; corona queda para una segunda etapa.",
})
// Decisión aceptada pero estado clínico programado: van por carriles separados.
await setPlanItemStatus(db, ORG_A, ANA_ID, rosaPatientId, endo46.id, { status: "programado" })
// Plan 2 de Rosa + presupuesto presentado, pendiente de decisión (nada aceptado aún).
const planEstetica = await createTreatmentPlan(db, ORG_A, ANA_ID, rosaPatientId, {
  title: "Plan estética dental",
  originEncounterId: draft.id,
})
const blaq = await addPlanItem(db, ORG_A, ANA_ID, rosaPatientId, {
  serviceId: serviceIdA("BLANQUEAMIENTO"),
  planId: planEstetica.id,
  sourceEncounterId: draft.id,
  arch: "upper",
  detail: "Blanqueamiento dental",
})
const limp = await addPlanItem(db, ORG_A, ANA_ID, rosaPatientId, {
  serviceId: serviceIdA("LIMPIEZA"),
  planId: planEstetica.id,
  sourceEncounterId: draft.id,
  detail: "Limpieza dental (profilaxis)",
})
const budgetEstetica = await createBudget(db, ORG_A, ANA_ID, rosaPatientId, {
  planId: planEstetica.id,
  itemIds: [blaq.id, limp.id],
  title: "Plan estética dental",
  notes: "Pendiente de decisión de la paciente.",
})
await presentBudget(db, ORG_A, ANA_ID, rosaPatientId, budgetEstetica.id)
// Tratamiento suspendido con motivo y sin decisión: demuestra que suspender no es
// un callejón (el recorrido ofrece «Reanudar tratamiento») y que la suspensión es
// independiente del carril económico.
await setPlanItemStatus(db, ORG_A, ANA_ID, rosaPatientId, blaq.id, {
  status: "suspendido",
  statusReason: "La paciente posterga el blanqueamiento hasta terminar la restauración.",
})
// Plan 3 de Rosa + presupuesto presentado y rechazado en su totalidad.
const planOrto = await createTreatmentPlan(db, ORG_A, ANA_ID, rosaPatientId, {
  title: "Plan ortodoncia",
  originEncounterId: draft.id,
})
const ctrlOrto = await addPlanItem(db, ORG_A, ANA_ID, rosaPatientId, {
  serviceId: serviceIdA("ORTODONCIA_CTRL"),
  planId: planOrto.id,
  sourceEncounterId: draft.id,
  detail: "Control de ortodoncia",
})
const budgetOrto = await createBudget(db, ORG_A, ANA_ID, rosaPatientId, {
  planId: planOrto.id,
  itemIds: [ctrlOrto.id],
  title: "Plan ortodoncia",
})
await presentBudget(db, ORG_A, ANA_ID, rosaPatientId, budgetOrto.id)
await decideBudget(db, ORG_A, ANA_ID, rosaPatientId, budgetOrto.id, {
  decisions: [{ planItemId: ctrlOrto.id, decision: "rechazado" }],
  decisionNote: "Rechaza ortodoncia por ahora; reevaluar en 6 meses.",
})
await addOdontogramEntries(db, ORG_A, ANA_ID, rosaPatientId, {
  toothNumber: 46,
  condition: "caries",
  surfaces: ["occlusal"],
  details: { variant: "enamel" },
  encounterId: draft.id,
})
const wear = await addOdontogramEntries(db, ORG_A, ANA_ID, rosaPatientId, {
  toothNumber: 26,
  condition: "tooth_wear",
  surfaces: ["buccal"],
})
const wearId = wear[0]?.id
if (!wearId) throw new Error("No se pudo crear la entrada de odontograma de la pieza 26")
await voidOdontogramEntry(
  db,
  ORG_A,
  ANA_ID,
  wearId,
  rosaPatientId,
  "Registro de prueba anulado en seed",
)
await addClinicalNote(db, ORG_A, ANA_ID, rosaPatientId, {
  note: "Paciente con dolor a la percusión en pieza 36; se planifica obturación y endodoncia en 46.",
  diagnosisCode: "K02.1",
  encounterId: draft.id,
})
// Documentos demo con bytes reales en storage (el registro exige borrador).
const rxRef = await storage.putPatientDocument({
  orgId: ORG_A,
  patientId: rosaPatientId,
  bytes: DEMO_PNG,
  contentType: "image/png",
  ext: "png",
})
const docRx = await registerPatientDocument(db, ORG_A, ANA_ID, rosaPatientId, {
  category: "radiografia",
  label: "[DEMO] Radiografía periapical pieza 36",
  storageKey: rxRef.objectKey,
  contentType: rxRef.mimeType,
  sizeBytes: rxRef.size,
  encounterId: draft.id,
  toothNumbers: [36],
  tags: ["radiografia", "diagnostico-inicial"],
})
// Corrección versionada: suma etiqueta sin tocar blob ni clasificación.
await correctDocumentContext(db, ORG_A, ANA_ID, rosaPatientId, docRx.id, {
  expectedVersion: 1,
  tags: ["radiografia", "diagnostico-inicial", "pieza-36"],
})
const fotoRef = await storage.putPatientDocument({
  orgId: ORG_A,
  patientId: rosaPatientId,
  bytes: DEMO_PNG,
  contentType: "image/png",
  ext: "png",
})
await registerPatientDocument(db, ORG_A, ANA_ID, rosaPatientId, {
  category: "foto_clinica",
  label: "[DEMO] Foto clínica piezas 36 y 46",
  storageKey: fotoRef.objectKey,
  contentType: fotoRef.mimeType,
  sizeBytes: fotoRef.size,
  encounterId: draft.id,
  planItemId: endo46.id,
  toothNumbers: [36, 46],
  tags: ["foto-clinica", "seguimiento"],
})
// Cierre con datos útiles: evolución, indicaciones y siguiente paso.
await updateEncounterDraft(db, ORG_A, ANA_ID, rosaPatientId, draft.id, {
  evolution: "Obturación de pieza 36 sin complicaciones; endodoncia de 46 programada.",
  indications: "Higiene con cepillo suave, control en 7 días; acudir si hay dolor.",
  nextStep: "Endodoncia pieza 46 en próxima cita.",
  nextAppointmentAt: tomorrowIso(),
})
// Solo el aceptado se realiza; conserva el vínculo atención-plan.
await addEncounterProcedure(db, ORG_A, ANA_ID, rosaPatientId, draft.id, {
  toothNumber: 36,
  diagnosisCode: "K02.1",
  planItemId: obt36.id,
})
// El cierre cobra el acto ejecutado (cargo automático, una sola vez).
const cierreRosa = await finalizeEncounter(db, ORG_A, ANA_ID, rosaPatientId, draft.id)
await addEncounterAddendum(db, ORG_A, ANA_ID, rosaPatientId, draft.id, {
  text: "Adenda demo: la paciente toleró bien la obturación; sin sangrado posterior.",
})
await createOdontogramAssessment(db, ORG_A, ANA_ID, rosaPatientId, {
  purpose: "initial",
  specifications: "Odontograma inicial NTS 188-MINSA/DGIESP-2022: caries oclusal en 36 y 46.",
  observations:
    "Paciente con dolor a la percusión en pieza 36; se planifica obturación y endodoncia en 46.",
  examinerName: "Ana Torres",
  registrationNumber: "COP 12345",
  signature: [
    [
      [5, 90],
      [20, 70],
      [40, 75],
    ],
    [
      [60, 80],
      [75, 65],
    ],
  ],
})
await addClinicalNote(db, ORG_A, ANA_ID, rosaPatientId, {
  note: "Control post-obturación: sin dolor, oclusión estable. Pendiente endodoncia pieza 46.",
})

// Alternativas excluyentes para pieza 46 (mismo plan, nueva atención borrador:
// la indicación solo nace de una atención abierta).
const evaluacion46 = await createEncounter(db, ORG_A, ANA_ID, rosaPatientId, {
  reason: "Evaluación de alternativas pieza 46",
})
// Segunda sesión de la misma indicación: no completa el tratamiento.
await addEncounterProcedure(db, ORG_A, ANA_ID, rosaPatientId, evaluacion46.id, {
  planItemId: obt36.id,
})
await correctDocumentContext(db, ORG_A, ANA_ID, rosaPatientId, docRx.id, {
  expectedVersion: 2,
  planItemId: obt36.id,
})
const opciones46 = await createOptionGroup(db, ORG_A, ANA_ID, rosaPatientId, {
  planId: planRestaurador.id,
  title: "Restauración definitiva pieza 46",
})
await addPlanItem(db, ORG_A, ANA_ID, rosaPatientId, {
  serviceId: serviceIdA("OBTURACION"),
  planId: planRestaurador.id,
  sourceEncounterId: evaluacion46.id,
  optionGroupId: opciones46.id,
  toothNumber: 46,
  detail: "Restauración con resina pieza 46 (alternativa conservadora)",
})
await addPlanItem(db, ORG_A, ANA_ID, rosaPatientId, {
  serviceId: serviceIdA("CORONA"),
  planId: planRestaurador.id,
  sourceEncounterId: evaluacion46.id,
  optionGroupId: opciones46.id,
  isRecommended: true,
  toothNumber: 46,
  detail: "Corona cerámica pieza 46 (alternativa recomendada)",
})

// Controles longitudinales: ciclo completo (programado→realizado contra la
// atención finalizada), uno pendiente de mantenimiento y uno cancelado.
const controlObt = await createFollowUp(db, ORG_A, ANA_ID, rosaPatientId, {
  kind: "tratamiento",
  planItemId: obt36.id,
  originEncounterId: draft.id,
  title: "Control post-obturación pieza 36",
  instructions: "Verificar oclusión y sensibilidad.",
  dueAt: tomorrowIso(),
})
await scheduleFollowUp(db, ORG_A, ANA_ID, rosaPatientId, controlObt.id, {
  scheduledAt: tomorrowIso(),
})
await completeFollowUp(db, ORG_A, ANA_ID, rosaPatientId, controlObt.id, {
  encounterId: draft.id,
  outcome: "Sin dolor; oclusión estable.",
})
await createFollowUp(db, ORG_A, ANA_ID, rosaPatientId, {
  kind: "mantenimiento",
  title: "Profilaxis semestral",
  instructions: "Recordar higiene con cepillo suave.",
  dueAt: tomorrowIso(),
})
const controlEndo = await createFollowUp(db, ORG_A, ANA_ID, rosaPatientId, {
  kind: "tratamiento",
  planItemId: endo46.id,
  title: "Control endodoncia pieza 46",
  dueAt: tomorrowIso(),
})
await cancelFollowUp(db, ORG_A, ANA_ID, rosaPatientId, controlEndo.id, {
  reason: "Se reprogramará tras la primera sesión de endodoncia.",
})

// Recetas inmutables: una vigente ligada al tratamiento y una anulada con
// motivo (la alergia a penicilina de Rosa obliga a retirar amoxicilina).
await createPrescription(db, ORG_A, ANA_ID, rosaPatientId, {
  planItemId: obt36.id,
  notes: "Solo si aparece dolor no controlado.",
  items: [
    {
      medicationName: "Ibuprofeno 400 mg",
      dose: "400 mg",
      route: "Oral",
      frequency: "Cada 8 horas",
      duration: "3 días",
      quantity: 9,
      instructions: "Tomar con alimentos.",
    },
  ],
})
const recetaAnulada = await createPrescription(db, ORG_A, ANA_ID, rosaPatientId, {
  items: [
    {
      medicationName: "Amoxicilina 500 mg",
      dose: "500 mg",
      route: "Oral",
      frequency: "Cada 8 horas",
      duration: "7 días",
      quantity: 21,
    },
  ],
})
await cancelPrescription(db, ORG_A, ANA_ID, rosaPatientId, recetaAnulada.id, {
  reason: "Alergia a penicilina registrada; se retira la prescripción.",
})

// Cuenta económica: el cargo de la obturación ya lo generó el cierre; aquí se
// añade un cargo manual, el pago con aplicación parcial y la devolución.
const cargoObt = cierreRosa.charges[0]
if (!cargoObt) throw new Error("El cierre no generó el cargo de la obturación")
await createCharge(db, ORG_A, ANA_ID, rosaPatientId, {
  description: "Control post-obturación",
  amountCents: 5000,
  currency: "PEN",
})
const rosaSelfContactId = contactIdByName.get("Rosa Quispe")!
const pagoRosa = await createPayment(db, ORG_A, ANA_ID, rosaPatientId, {
  payerContactId: rosaSelfContactId,
  amountCents: 15000,
  currency: "PEN",
  paidAt: new Date().toISOString(),
  method: "yape",
  reference: "YAPE-SEED-001",
})
await applyPayment(db, ORG_A, ANA_ID, rosaPatientId, pagoRosa.id, {
  chargeId: cargoObt.id,
  amountCents: 10000,
})
await refundPayment(db, ORG_A, ANA_ID, rosaPatientId, pagoRosa.id, {
  amountCents: 2000,
  reason: "Ajuste de tarifa acordado en recepción.",
})

// Responsabilidad: Rosa es titular económica de su propia cuenta.
await grantResponsibility(db, ORG_A, ANA_ID, rosaPatientId, {
  contactId: rosaSelfContactId,
  kind: "responsable_economico",
  startsAt: new Date().toISOString().slice(0, 10),
  notes: "Titular de la cuenta del paciente.",
})

const elenaPatientId = patientIdByName.get("Elena Huamán")!
await savePatientHealth(db, ORG_A, ANA_ID, elenaPatientId, {
  expectedRevision: 0,
  reviewStatus: { allergies: "recorded", conditions: "unknown", medications: "unknown" },
  allergies: [{ substance: "Látex", reaction: "Enrojecimiento", severity: "leve" }],
  conditions: [],
  medications: [],
})
await addClinicalNote(db, ORG_A, ANA_ID, elenaPatientId, {
  note: "Control de rutina sin hallazgos",
  diagnosisCode: "Z01.2",
})
// Plan de Elena + presupuesto en borrador (sin presentar): ejercita el estado inicial.
const elenaEval = await createEncounter(db, ORG_A, ANA_ID, elenaPatientId, {
  reason: "Control de rutina",
})
const elenaPlan = await createTreatmentPlan(db, ORG_A, ANA_ID, elenaPatientId, {
  title: "Plan profilaxis",
  originEncounterId: elenaEval.id,
})
const elenaItem = await addPlanItem(db, ORG_A, ANA_ID, elenaPatientId, {
  serviceId: serviceIdA("LIMPIEZA"),
  planId: elenaPlan.id,
  sourceEncounterId: elenaEval.id,
  detail: "Limpieza dental (profilaxis)",
})
await createBudget(db, ORG_A, ANA_ID, elenaPatientId, {
  planId: elenaPlan.id,
  itemIds: [elenaItem.id],
  title: "Plan profilaxis",
})

// --- Volumen para paginación: 40 contactos+pacientes ---
for (let i = 1; i <= 40; i++) {
  const n = String(i).padStart(2, "0")
  const created = await createContact(db, ORG_A, {
    displayName: `Paciente Demo ${n}`,
  })
  await createOpportunity(db, ORG_A, {
    contactId: created.id, stageId: pipeA.stages[0]!.id, title: `Seguimiento · Paciente Demo ${n}`,
  }, { userId: ANA_ID })
  await createPatient(db, ORG_A, ANA_ID, {
    displayName: `Paciente Demo ${n}`,
    contacts: [{ contactId: created.id, relationship: "self", isPreferred: true }],
    phone: `+519000000${n}`,
  })
}

// --- Org B mínima (aislamiento visual) ---
const sofia = await createContact(db, ORG_B, {
  displayName: "Sofía Ramos",
})
const hugo = await createContact(db, ORG_B, {
  displayName: "Hugo Díaz",
})
await createOpportunity(db, ORG_B, {
  contactId: sofia.id, stageId: pipeB.stages[0]!.id, title: "Seguimiento · Sofía Ramos",
}, { userId: CORA_ID })
await createOpportunity(db, ORG_B, {
  contactId: hugo.id, stageId: pipeB.stages[1]!.id, title: "Seguimiento · Hugo Díaz",
}, { userId: CORA_ID })
await db.insert(contactIdentity).values([
  {
    organizationId: ORG_B,
    contactId: sofia.id,
    channel: "whatsapp",
    externalUserId: "wa:51987654401",
    displayName: "Sofía Ramos",
    isPrimary: true,
  },
  {
    organizationId: ORG_B,
    contactId: hugo.id,
    channel: "whatsapp",
    externalUserId: "wa:51987654402",
    displayName: "Hugo Díaz",
    isPrimary: true,
  },
])
await createPatient(db, ORG_B, CORA_ID, {
  displayName: "Sofía Ramos",
  contacts: [{ contactId: sofia.id, relationship: "self", isPreferred: true }],
  docType: "DNI",
  docNumber: "60111222",
  birthDate: "1993-04-25",
  sex: "F",
})
const convSofia = await seedConversation({
  orgId: ORG_B,
  contactId: sofia.id,
  connectionId: connB.id,
  thread: "seed-thread-B1",
  unreadCount: 1,
  lastInboundAt: hoursAgo(2),
  lastMessageAt: hoursAgo(2),
})
await seedMessage({
  orgId: ORG_B,
  conversationId: convSofia.id,
  direction: "inbound",
  senderKind: "contact",
  body: "Hola, ¿tienen disponibilidad para una limpieza dental esta semana?",
  externalId: "seed-msg-B1",
  status: "received",
  createdAt: hoursAgo(2),
})

// Registro directo: escenarios de demostración sin cuentas de pacientes.
const registrationConfig = await db.transaction((tx) =>
  savePatientRegistrationConfig(tx, ORG_A, ANA_ID, {
    expectedVersion: 0,
    enabled: true,
    fields: {
      ...DEFAULT_REGISTRATION_CONFIG.fields,
      "dental.ultimaVisita": "optional",
      "dental.experienciaPrevia": "optional",
      "dental.ansiedadDental": "optional",
    },
    privacyNotice:
      "AVISO DE DEMOSTRACIÓN: autorizo el tratamiento de estos datos ficticios para mostrar el registro de pacientes. No utilizar datos reales en esta demostración.",
  }),
)
await db.transaction((tx) =>
  savePatientRegistrationConfig(tx, ORG_B, CORA_ID, {
    expectedVersion: 0,
    enabled: false,
    fields: DEFAULT_REGISTRATION_CONFIG.fields,
    privacyNotice: "",
  }),
)
const rosaContactId = contactIdByName.get("Rosa Quispe")!
const telegramConnection = await createConnection(
  db,
  ORG_A,
  secretsKey,
  {
    channel: "telegram",
    provider: "telegram_bot_api",
    displayName: "Telegram Dental Smile",
    config: { botToken: "123456:demo-token", botUsername: "dental_smile_demo_bot" },
  },
  { fetch, validateExternal: false },
)
await db.insert(contactIdentity).values({
  organizationId: ORG_A,
  contactId: rosaContactId,
  channel: "telegram",
  externalUserId: "tg:123456789",
  displayName: "Rosa Quispe",
})
const rosaTelegram = await seedConversation({
  orgId: ORG_A,
  contactId: rosaContactId,
  connectionId: telegramConnection.id,
  thread: "tg:123456789",
  lastInboundAt: hoursAgo(1),
  lastMessageAt: hoursAgo(1),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: rosaTelegram.id,
  direction: "inbound",
  senderKind: "contact",
  body: "Quisiera registrar a mi hijo.",
  externalId: "seed-tg-rosa-1",
  status: "received",
  createdAt: hoursAgo(1),
})
const pedro = await db.transaction((tx) =>
  registerPatient(
    tx,
    ORG_A,
    { kind: "internal", userId: ANA_ID, contactId: rosaContactId },
    {
      submissionId: randomUUID(),
      answers: {
        demographics: { displayName: "Pedro Quispe", birthDate: "2016-05-20" },
        respondent: "representative",
        representative: {
          displayName: "Rosa Quispe",
          relationship: "guardian",
          relationshipDetail: "Madre",
          phone: SHARED_PHONE,
        },
        privacyAccepted: false,
      },
      contacts: [
        {
          contactId: rosaContactId,
          relationship: "guardian",
          relationshipDetail: "Madre",
          isPreferred: true,
        },
      ],
    },
  ),
)
// Representante legal vigente: habilita a Rosa para decidir por el menor.
await grantResponsibility(db, ORG_A, ANA_ID, pedro.id, {
  contactId: rosaContactId,
  kind: "representante_legal",
  startsAt: new Date().toISOString().slice(0, 10),
  notes: "Madre del menor; autoriza decisiones clínicas y económicas.",
})
// Recorrido del menor: la propuesta se presenta y queda SIN decisión a propósito,
// para ejercitar el selector «Quién decide» (Rosa como representante legal, no el
// propio paciente) y la revisión de una propuesta ya presentada.
const consultaPedro = await createEncounter(db, ORG_A, ANA_ID, pedro.id, {
  reason: "Primera consulta preventiva",
})
const planPedro = await createTreatmentPlan(db, ORG_A, ANA_ID, pedro.id, {
  title: "Plan preventivo infantil",
  originEncounterId: consultaPedro.id,
})
const limpiezaPedro = await addPlanItem(db, ORG_A, ANA_ID, pedro.id, {
  serviceId: serviceIdA("LIMPIEZA"),
  planId: planPedro.id,
  sourceEncounterId: consultaPedro.id,
  detail: "Limpieza dental (profilaxis)",
})
const presupuestoPedro = await createBudget(db, ORG_A, ANA_ID, pedro.id, {
  planId: planPedro.id,
  itemIds: [limpiezaPedro.id],
  title: "Plan preventivo infantil",
  notes: "Profilaxis; se evalúa sellante según hallazgo.",
})
await presentBudget(db, ORG_A, ANA_ID, pedro.id, presupuestoPedro.id)
// La revisión 2 agrega la obturación decidua y deja la revisión 1 sustituida.
const obtPedro = await addPlanItem(db, ORG_A, ANA_ID, pedro.id, {
  serviceId: serviceIdA("OBTURACION"),
  planId: planPedro.id,
  sourceEncounterId: consultaPedro.id,
  toothNumber: 75,
  diagnosisCode: "K02.1",
  detail: "Obturación pieza 75",
})
const revisionPedro = await reviseBudget(db, ORG_A, ANA_ID, pedro.id, presupuestoPedro.id, {
  itemIds: [limpiezaPedro.id, obtPedro.id],
  reason: "Se agrega la obturación de la pieza 75 tras el hallazgo en la consulta.",
})
await presentBudget(db, ORG_A, ANA_ID, pedro.id, revisionPedro.id)

await db.transaction((tx) =>
  registerPatient(
    tx,
    ORG_A,
    { kind: "public", entryPoint: "qr" },
    {
      submissionId: randomUUID(),
      formVersion: registrationConfig.version,
      answers: {
        demographics: {
          displayName: "Valeria Quispe · QR demo",
          birthDate: "1998-04-10",
          phone: SHARED_PHONE,
        },
        respondent: "patient",
        privacyAccepted: true,
        health: {
          bloodGroup: "O+",
          allergies: {
            state: "recorded",
            items: [{ substance: "Penicilina", reaction: "Urticaria", severity: "severa" }],
          },
          conditions: { state: "unknown", items: [] },
          medications: { state: "none", items: [] },
        },
      },
    },
  ),
)
await db.transaction((tx) =>
  updateContact(
    tx,
    ORG_A,
    contactIdByName.get("Jorge Mamani")!,
    { isActive: false },
    { userId: ANA_ID },
  ),
)
await db.transaction((tx) =>
  updatePatient(tx, ORG_A, ANA_ID, patientIdByName.get("Miguel Torres")!, { isActive: false }),
)
await db.transaction((tx) =>
  createPatientRegistrationLink(tx, ORG_A, ANA_ID, {
    contactId: rosaContactId,
    conversationId: convRosa.id,
  }),
)

// --- Agenda: sillones y citas reales (la constraint impide sembrar solapes;
// los avisos de la UI cubren datos históricos o importaciones, no este seed) ---
const surco = await db.query.branch.findFirst({
  where: and(eq(branch.organizationId, ORG_A), eq(branch.name, "Sede Surco")),
})
if (!surco) throw new Error("Falta la sucursal Sede Surco")
const chairsMiraflores = await Promise.all(
  ["Sillón 1", "Sillón 2", "Sillón 3"].map((name) =>
    createChair(db, ORG_A, { branchId: miraflores.id, name }),
  ),
)
await createChair(db, ORG_A, { branchId: surco.id, name: "Sillón único" })
const domainSeed = {
  orgId: ORG_A, ownerUserId: ANA_ID, branchId: miraflores.id,
  patientId: patientIdByName.get("Rosa Quispe")!, contactId: rosaContactId,
}
await db.transaction(tx => seedAvailability(tx, domainSeed))
await db.transaction(tx => seedAvailability(tx, { ...domainSeed, branchId: surco.id }))
const chairA = (index: number): string => {
  const chair = chairsMiraflores[index]
  if (!chair) throw new Error("Faltan sillones semilla")
  return chair.id
}
/** Hora local de Lima (UTC-5 fijo en la semilla) → instante ISO. */
const lima = (dayOffset: number, hhmm: string): string => {
  const base = new Date()
  base.setUTCDate(base.getUTCDate() + dayOffset)
  return `${base.toISOString().slice(0, 10)}T${hhmm}:00-05:00`
}
const agendaSeed: Array<{
  patient: string
  dentist: string
  chair: number
  day: number
  start: string
  end: string
  service: string
  status?: "programada" | "confirmada" | "atendida" | "no_asistio" | "cancelada"
}> = [
  {
    patient: "Rosa Quispe",
    dentist: ANA_ID,
    chair: 0,
    day: 0,
    start: "09:00",
    end: "09:45",
    service: "LIMPIEZA",
    status: "confirmada",
  },
  {
    patient: "Elena Huamán",
    dentist: ANA_ID,
    chair: 0,
    day: 0,
    start: "10:00",
    end: "10:45",
    service: "OBTURACION",
  },
  {
    patient: "Carlos Paredes",
    dentist: LUIS_ID,
    chair: 1,
    day: 0,
    start: "09:30",
    end: "10:00",
    service: "ORTODONCIA_CTRL",
    status: "confirmada",
  },
  {
    patient: "Lucía Fernández",
    dentist: ANA_ID,
    chair: 2,
    day: 0,
    start: "11:00",
    end: "11:30",
    service: "LIMPIEZA",
  },
  {
    patient: "Carmen Rojas",
    dentist: LUIS_ID,
    chair: 1,
    day: 1,
    start: "09:00",
    end: "09:45",
    service: "ENDODONCIA",
  },
  {
    patient: "Rosa Quispe",
    dentist: ANA_ID,
    chair: 0,
    day: 1,
    start: "09:00",
    end: "10:00",
    service: "ENDODONCIA",
    status: "programada",
  },
  // Ayer: ejecutada, ausencia y cancelación (estas dos últimas liberan recurso).
  {
    patient: "Elena Huamán",
    dentist: ANA_ID,
    chair: 0,
    day: -1,
    start: "09:00",
    end: "09:45",
    service: "LIMPIEZA",
    status: "atendida",
  },
  {
    patient: "Carlos Paredes",
    dentist: LUIS_ID,
    chair: 1,
    day: -1,
    start: "09:00",
    end: "09:30",
    service: "ORTODONCIA_CTRL",
    status: "no_asistio",
  },
  {
    patient: "Carmen Rojas",
    dentist: ANA_ID,
    chair: 0,
    day: -1,
    start: "09:00",
    end: "09:45",
    service: "LIMPIEZA",
    status: "cancelada",
  },
]
for (const item of agendaSeed) {
  const seedPatientId = patientIdByName.get(item.patient)
  if (!seedPatientId) throw new Error(`Falta el paciente semilla ${item.patient}`)
  await createAppointment(db, ORG_A, ANA_ID, {
    branchId: miraflores.id,
    patientId: seedPatientId,
    dentistUserId: item.dentist,
    chairId: chairA(item.chair),
    serviceId: serviceIdA(item.service),
    startsAt: lima(item.day, item.start),
    endsAt: lima(item.day, item.end),
    status: item.status ?? "programada",
  })
}
for (const seed of [
  seedAgent, seedAutomation, seedClinicalForms, seedInventory, seedFinance,
  seedMailbox, seedOpportunities, seedPortal, seedWorkspace, seedRoles,
]) {
  await db.transaction(tx => seed(tx, domainSeed))
}
await db.transaction(tx => seedChannels(tx, domainSeed, secretsKey, { fetch }))
await db.transaction(tx => seedWebchat(tx, domainSeed, { secretsKey, fetch }))

// --- Resumen ---
async function summary(orgId: string, label: string): Promise<string> {
  const tables = [
    "contact",
    "patient",
    "conversation",
    "message",
    "encounter",
    "task",
    "treatment_budget",
    "treatment_option_group",
    "clinical_follow_up",
    "prescription",
    "patient_charge",
    "patient_payment",
    "patient_responsibility",
    "treatment_plan_item",
    "patient_document",
  ] as const
  const counts: string[] = []
  for (const t of tables) counts.push(`${t}=${await countWhere(t, orgId)}`)
  return `org ${label} (${orgId}): ${counts.join(" ")}`
}
console.log("seed-dev ok")
console.log(await summary(ORG_A, "dental-smile"))
console.log(await summary(ORG_B, "clinica-norte"))
console.log("credenciales (password Demo1234): ana@odentia.dev, luis@odentia.dev, cora@odentia.dev")
process.exit(0)
