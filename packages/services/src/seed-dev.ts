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
import { encodeDemoDicom } from "@odentia/clinical"
import sharp from "sharp"
import { randomUUID } from "node:crypto"
import { deflateSync } from "node:zlib"
import { DEFAULT_REGISTRATION_CONFIG } from "@odentia/clinical"
import { createOwnerDb } from "@odentia/db"
import { saasAction, saasSubscription } from "@odentia/db/schema/saas-billing"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { agentSearchItem, aiUsage } from "@odentia/db/schema/agent"
import { account, invitation, member, organization, user } from "@odentia/db/schema/auth"
import {
  clinicalFollowUp,
  clinicalNote,
  encounter,
  encounterDiagnosis,
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
import { consentDocument, professionalProfile } from "@odentia/db/schema/clinical-forms"
import {
  agentConfig,
  channelConnection,
  clinicMessage,
  contact,
  contactIdentity,
  conversation,
  customFieldDef,
  message,
  pipeline,
  pipelineStage,
} from "@odentia/db/schema/crm"
import { auditEvent, branch, orgProfile, patientRegistrationConfig } from "@odentia/db/schema/org"
import { hashPassword } from "better-auth/crypto"
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { createHandoff } from "./agent-operations.js"
import { upsertAgentConfig } from "./agentConfig.js"
import { createAppointment, createChair } from "./appointments.js"
import { createScheduleBlock } from "./availability.js"
import { adjustBudgetLines, createBudget, decideBudget, deliverBudget, reviseBudget } from "./budgets.js"
import {
  addClinicalNote,
  addOdontogramEntries,
  correctDocumentContext,
  createOdontogramAssessment,
  registerPatientDocument,
  retirePatientDocument,
  savePatientHealth,
  voidOdontogramEntry,
} from "./clinical.js"
import { createConnection } from "./connections.js"
import { createContact, updateContact } from "./contacts.js"
import { grantDataConsent } from "./data-consents.js"
import { addEncounterDiagnosis, voidEncounterDiagnosis } from "./encounter-diagnoses.js"
import {
  addEncounterAddendum,
  addEncounterProcedure,
  createEncounter,
  finalizeEncounter,
  updateEncounterDraft,
} from "./encounters.js"
import { createFieldDef } from "./fields.js"
import { cancelFollowUp, completeFollowUp, createFollowUp, scheduleFollowUp } from "./follow-ups.js"
import { setCommissionRate } from "./finance.js"
import { closeOpportunity, createOpportunity, listOpportunities } from "./opportunities.js"
import {
  createPatientRegistrationLink,
  registerPatient,
  savePatientRegistrationConfig,
} from "./patient-registration.js"
import { createPatient, updatePatient } from "./patients.js"
import { collectCharge, createCharge, refundCredit } from "./payments.js"
import { ensureDefaultPaymentMethods, listPaymentMethods } from "./payment-methods.js"
import { ensureDefaultPipeline } from "./pipelines.js"
import { addPlanItem, createOptionGroup, createTreatmentPlan, setPlanItemStatus } from "./plan.js"
import { cancelPrescription, createPrescription } from "./prescriptions.js"
import { setProfessionalProfile } from "./professional-profiles.js"
import { createPromotion } from "./promotions.js"
import { grantResponsibility } from "./responsibilities.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { seedAgent } from "./seed-agent.js"
import { seedAutomation, seedChannelTemplates } from "./seed-automation.js"
import { seedAvailability } from "./seed-availability.js"
import { seedChannels } from "./seed-channels.js"
import { generateConsentPdf } from "./consent-pdf.js"
import { makeImageThumbnail } from "./thumbnails.js"
import { seedClinicalForms } from "./seed-clinical-forms.js"
import { seedCrmActivity } from "./seed-crm-activity.js"
import { seedFinance } from "./seed-finance.js"
import { seedInventory } from "./seed-inventory.js"
import { seedMailbox } from "./seed-mailbox.js"
import { seedOpportunities } from "./seed-opportunities.js"
import { seedPortal } from "./seed-portal.js"
import { seedReports } from "./seed-reports.js"
import { seedRoles } from "./seed-roles.js"
import { seedWebchat } from "./seed-webchat.js"
import { seedWorkspace } from "./seed-workspace.js"
import { seedAdminCore } from "./seed-admin-core.js"
import { seedAdminOrganizations } from "./seed-admin-organizations.js"
import { seedAdminSupport } from "./seed-admin-support.js"
import { seedSaasBillingDemo } from "./seed-saas-billing.js"
import { createService, updateService } from "./service-catalog.js"
import { createStorage } from "./storage.js"
import { completeTask, createTask } from "./tasks.js"

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
/**
 * Imagen clínica de demostración (no es de un paciente real): radiografía o
 * foto esquemática dibujada con SVG para que la galería, el visor y la
 * comparación se vean como con imágenes reales. `variant` desplaza la lesión.
 */
async function demoClinicalImage(kind: "rx" | "foto", variant = 0): Promise<Buffer> {
  const [w, h] = kind === "rx" ? [640, 480] : [800, 600]
  const bg = kind === "rx" ? "#1b1b1b" : "#7a2f35"
  const tooth = kind === "rx" ? "#b9b9b9" : "#f1ead8"
  const teeth = [120, 300, 480]
    .map(
      (x) =>
        `<rect x="${x}" y="70" width="140" height="260" rx="48" fill="${tooth}"/>` +
        (kind === "rx"
          ? `<rect x="${x + 22}" y="320" width="34" height="130" rx="14" fill="#9a9a9a"/><rect x="${x + 84}" y="320" width="34" height="130" rx="14" fill="#9a9a9a"/><ellipse cx="${x + 70}" cy="150" rx="34" ry="40" fill="#e8e8e8"/>`
          : ""),
    )
    .join("")
  const lesion = `<ellipse cx="${160 + variant * 6}" cy="${120 + variant * 4}" rx="${26 - variant}" ry="${20 - variant}" fill="${kind === "rx" ? "#3d3d3d" : "#4a3420"}"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${bg}"/>${teeth}${lesion}</svg>`
  return sharp(Buffer.from(svg)).blur(kind === "rx" ? 2.2 : 0.6).png().toBuffer()
}

/** Guarda la imagen demo y su miniatura, como hace la subida real. */
async function putDemoImage(patientId: string, kind: "rx" | "foto", variant = 0) {
  const bytes = await demoClinicalImage(kind, variant)
  const ref = await storage.putPatientDocument({
    orgId: ORG_A,
    patientId,
    bytes,
    contentType: "image/png",
    ext: "png",
  })
  const thumb = await makeImageThumbnail(bytes)
  const thumbRef = thumb
    ? await storage.putPatientDocument({
        orgId: ORG_A,
        patientId,
        bytes: thumb,
        contentType: "image/webp",
        ext: "webp",
      })
    : null
  return { ...ref, thumbnailKey: thumbRef?.objectKey ?? null }
}

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
    "support_access_audit",
    "support_access_grant",
    "support_attachment",
    "support_message",
    "support_case",
    "saas_notice",
    "saas_negotiation",
    "saas_action",
    "portal_challenge",
    "portal_passkey",
    "portal_verification",
    "portal_request",
    "portal_grant",
    "portal_policy",
    "portal_access_log",
    // La bitácora de consultas referencia paciente, usuario y organización sin cascada.
    "clinical_access_log",
    "portal_session",
    "portal_link",
    "channel_template",
    "automation_link_token",
    "automation_job",
    "automation_consent",
    "automation_rule",
    "agent_decision_log",
    "ai_usage",
    "agent_run_ledger",
    "agent_proposal",
    "agent_handoff",
    "agent_knowledge_revision",
    "agent_knowledge_entry",
    "crm_note",
    "task",
    "workspace_notification",
    "opportunity_event",
    "opportunity",
    "clinical_form_addendum",
    "clinical_form_response",
    "consent_event",
    "consent_document",
    "clinical_order",
    "clinical_form_template",
    "consent_template",
    "professional_specialty",
    "service_specialty",
    "org_specialty",
    "commission_settlement_line",
    "commission_settlement",
    "commission_rule",
    "cash_closure",
    "cash_movement",
    "expense",
    "cash_shift",
    "stock_movement",
    "product_lot",
    "purchase_order_line",
    "purchase_order",
    "product",
    "warehouse",
    "supplier",
    "mailbox_oauth_state",
    "schedule_block",
    "professional_schedule",
  ]) {
    await db.execute(
      sql`delete from ${sql.identifier(table)} where organization_id in (${ORG_A}, ${ORG_B})`,
    )
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
  await db.execute(sql`delete from payment_ticket where organization_id in (${ORG_A}, ${ORG_B})`)
  await db.execute(sql`delete from ticket_counter where organization_id in (${ORG_A}, ${ORG_B})`)
  await db.execute(sql`delete from organization_payment_method where organization_id in (${ORG_A}, ${ORG_B})`)
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
  await db
    .delete(patientRegistrationConfig)
    .where(inArray(patientRegistrationConfig.organizationId, SEED_ORGS))
  await db.delete(appointment).where(inArray(appointment.organizationId, SEED_ORGS))
  await db.delete(message).where(inArray(message.organizationId, SEED_ORGS))
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
  // Los diagnósticos migrados desde notas antiguas las referencian (`legacy_note_id`): van antes.
  await db.delete(encounterDiagnosis).where(inArray(encounterDiagnosis.organizationId, SEED_ORGS))
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
  await db.delete(scheduleChair).where(inArray(scheduleChair.organizationId, SEED_ORGS))
  await db.delete(encounter).where(inArray(encounter.organizationId, SEED_ORGS))
  await db.execute(sql`delete from promotion_service_price where organization_id in (${ORG_A}, ${ORG_B})`)
  await db.execute(sql`delete from promotion where organization_id in (${ORG_A}, ${ORG_B})`)
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
  // Persona única: un paciente no existe sin su propia persona, así que sus
  // vínculos y la ficha se retiran en la misma transacción.
  await db.transaction(async (tx) => {
    await tx.delete(patientContact).where(inArray(patientContact.organizationId, SEED_ORGS))
    await tx.delete(patient).where(inArray(patient.organizationId, SEED_ORGS))
  })
  await db.delete(contact).where(inArray(contact.organizationId, SEED_ORGS))
  await db.delete(pipelineStage).where(inArray(pipelineStage.organizationId, SEED_ORGS))
  await db.delete(pipeline).where(inArray(pipeline.organizationId, SEED_ORGS))
  await db.delete(channelConnection).where(inArray(channelConnection.organizationId, SEED_ORGS))
  // Los mensajes de WhatsApp son de la organización, no de la conexión; sus versiones se van en cascada.
  await db.delete(clinicMessage).where(inArray(clinicMessage.organizationId, SEED_ORGS))
  await db.delete(customFieldDef).where(inArray(customFieldDef.organizationId, SEED_ORGS))
  // El índice de búsqueda del agente apunta a la organización: se borra antes.
  await db.delete(agentSearchItem).where(inArray(agentSearchItem.organizationId, SEED_ORGS))
  await db.delete(agentConfig).where(inArray(agentConfig.organizationId, SEED_ORGS))
  await db.delete(orgCounter).where(inArray(orgCounter.organizationId, SEED_ORGS))
  await db.delete(branch).where(inArray(branch.organizationId, SEED_ORGS))
  await db.delete(orgProfile).where(inArray(orgProfile.organizationId, SEED_ORGS))
  await db.delete(auditEvent).where(inArray(auditEvent.organizationId, SEED_ORGS))
  await db.delete(professionalProfile).where(inArray(professionalProfile.organizationId, SEED_ORGS))
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
  /** Cerrada: con su motivo y quién (nulo = el agente), como la deja `closeConversationWith`. */
  closed?: { reason: "resuelta" | "sin_respuesta" | "equipo" | "manual"; at: Date; byUserId: string | null }
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
      status: args.closed ? "closed" : (args.status ?? "open"),
      closedAt: args.closed?.at ?? null,
      closeReason: args.closed?.reason ?? null,
      closedByUserId: args.closed?.byUserId ?? null,
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
await db.transaction(async (tx) => {
  await tx.insert(organization).values([
    { id: ORG_A, name: "Dental Smile", slug: "dental-smile", createdAt: new Date() },
    { id: ORG_B, name: "Clínica Norte", slug: "clinica-norte", createdAt: new Date() },
  ])
  await tx.update(saasSubscription).set({ isDemo: true }).where(inArray(saasSubscription.organizationId, SEED_ORGS))
})
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
// Colegiatura con la que firman (ADR 0003). Luis queda sin colegiatura en la
// clínica B para ejercitar el aviso «falta tu colegiatura» al cerrar.
// Título y colegio se escriben: el perfil no trae los de ningún país por defecto.
const PERU_DENTIST = { professionalTitle: "Cirujano dentista", registrationBody: "COP" }
await setProfessionalProfile(db, ORG_A, ANA_ID, ANA_ID, {
  ...PERU_DENTIST,
  signatureName: "Ana Torres",
  registrationNumber: "12345",
  specialtyRegistration: "RNE 1024",
})
await setProfessionalProfile(db, ORG_A, ANA_ID, LUIS_ID, { ...PERU_DENTIST, registrationNumber: "23456" })
await setProfessionalProfile(db, ORG_B, CORA_ID, CORA_ID, { ...PERU_DENTIST, registrationNumber: "34567" })
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
await db.transaction(async (tx) => {
  await ensureDefaultPaymentMethods(tx, ORG_A, ANA_ID, "PE")
  await ensureDefaultPaymentMethods(tx, ORG_B, CORA_ID, "PE")
})
const [miraflores] = await db
  .insert(branch)
  .values([
    // Miraflores hereda la zona de la organización (`timezone` en null).
    { organizationId: ORG_A, name: "Sede Miraflores", ubigeo: "150122" },
    // Surco ejercita el camino contrario: teléfono y zona propios. Queda sin sillones
    // ni horarios: es la sede limpia para probar la configuración desde cero.
    {
      organizationId: ORG_A,
      name: "Sede Surco",
      ubigeo: "150140",
      phone: "+51987655001",
      timezone: "America/Lima",
    },
  ])
  .returning({ id: branch.id })
if (!miraflores) throw new Error("No se pudo crear la Sede Miraflores")
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
      wabaId: "seed-waba",
      displayPhoneNumber: "+51999888777",
      accessToken: "seed-dev",
      appSecret: "seed-dev",
    },
  },
  { fetch, validateExternal: false },
)
// La salud del número, como la entregaría WhatsApp: dato de la semilla, nadie la leyó de Meta.
await db
  .update(channelConnection)
  .set({
    webhookVerifiedAt: new Date(Date.now() - 7 * 24 * 3_600_000),
    health: {
      quality: "alta",
      dailyLimit: 2000,
      unlimited: false,
      number: "+51 999 888 777",
      name: "Clínica Dental Smile",
      checkedAt: new Date().toISOString(),
    },
  })
  .where(eq(channelConnection.id, connA.id))
// Sus mensajes: los siete con los que viene, en estados variados, y uno propio.
await seedChannelTemplates(db, { orgId: ORG_A, connectionId: connA.id })
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
      wabaId: "seed-waba",
      displayPhoneNumber: "+51999888776",
      accessToken: "seed-dev",
      appSecret: "seed-dev",
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
  if (c.name === "Rosa Quispe") {
    await updateContact(db, ORG_A, created.id, { preferredChannel: "whatsapp" }, { userId: ANA_ID })
  }
  const historicalStage = pipeA.stages[i % pipeA.stages.length]!
  const openStage = pipeA.stages.find((stage) => stage.kind === "open")!
  const commercial = await createOpportunity(
    db,
    ORG_A,
    {
      contactId: created.id,
      stageId: historicalStage.kind === "open" ? stageId : openStage.id,
      title: `Seguimiento · ${c.name}`,
    },
    { userId: ANA_ID },
  )
  if (historicalStage.kind === "won" || historicalStage.kind === "lost") {
    await closeOpportunity(
      db,
      ORG_A,
      commercial.id,
      {
        outcome: historicalStage.kind,
        reason: "Resultado del escenario de demostración",
      },
      { userId: ANA_ID },
    )
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
  direction: "in",
  senderKind: "contact",
  body: "Hola, ¿tienen cita para mañana por dolor de muela?",
  externalId: "seed-msg-1",
  status: "received",
  createdAt: hoursAgo(3),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convRosa.id,
  direction: "in",
  senderKind: "contact",
  body: "Es un dolor fuerte en la muela de abajo, del lado derecho",
  externalId: "seed-msg-2",
  status: "received",
  createdAt: hoursAgo(2),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convRosa.id,
  direction: "in",
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
  direction: "in",
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
  direction: "in",
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
  direction: "in",
  senderKind: "contact",
  body: "Buenas tardes, quiero cotizar una endodoncia",
  externalId: "seed-msg-4",
  status: "read",
  createdAt: hoursAgo(5),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convJorge.id,
  direction: "out",
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
  // El agente confirmó y Elena se despidió: cerrada como resuelta.
  closed: { reason: "resuelta", at: new Date(elenaClosedAt.getTime() + 900_000), byUserId: null },
  lastInboundAt: elenaClosedAt,
  lastOutboundAt: new Date(elenaClosedAt.getTime() + 600_000),
  lastMessageAt: new Date(elenaClosedAt.getTime() + 600_000),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convElena.id,
  direction: "in",
  senderKind: "contact",
  body: "Hola, quiero confirmar mi cita de limpieza de mañana",
  externalId: "seed-msg-6",
  status: "read",
  createdAt: elenaClosedAt,
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convElena.id,
  direction: "out",
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
  direction: "in",
  senderKind: "contact",
  body: "¿Cuánto cuesta una extracción de muela del juicio?",
  externalId: "seed-msg-8",
  status: "received",
  createdAt: hoursAgo(6),
})

// Ninguna conversación queda abierta (ADR 0024): una que espera al paciente
// con el agente a cargo y una cerrada por cada motivo, para ver la Bandeja.
const convLucia = await seedConversation({
  orgId: ORG_A,
  contactId: contactIdByName.get("Lucía Fernández")!,
  connectionId: connA.id,
  thread: "seed-thread-5",
  lastInboundAt: hoursAgo(3),
  lastOutboundAt: hoursAgo(2),
  lastMessageAt: hoursAgo(2),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convLucia.id,
  direction: "in",
  senderKind: "contact",
  body: "¿Atienden ortodoncia los sábados?",
  externalId: "seed-msg-9",
  status: "read",
  createdAt: hoursAgo(3),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convLucia.id,
  direction: "out",
  senderKind: "agent",
  body: "Sí, Lucía: los sábados atendemos de 9:00 a 13:00. ¿Quieres que te busque un horario para una evaluación?",
  externalId: "seed-msg-10",
  status: "delivered",
  createdAt: hoursAgo(2),
})
const CLOSED_SEED: Array<{ name: string; thread: string; reason: "sin_respuesta" | "equipo" | "manual"; by: string | null; said: string; answer: string }> = [
  {
    name: "Miguel Torres",
    thread: "seed-thread-6",
    reason: "sin_respuesta",
    by: null,
    said: "¿Cuánto cuesta un blanqueamiento?",
    answer: "Miguel, cuando quieras retomar, escríbenos por aquí: estamos atentos para ayudarte.",
  },
  {
    name: "Carmen Rojas",
    thread: "seed-thread-7",
    reason: "equipo",
    by: LUIS_ID,
    said: "Quiero hablar con alguien por mi factura",
    answer: "Carmen, cuando quieras retomar, escríbenos por aquí: estamos atentos para ayudarte.",
  },
  {
    name: "Diego Salazar",
    thread: "seed-thread-8",
    reason: "manual",
    by: ANA_ID,
    said: "Número equivocado, disculpen",
    answer: "No te preocupes, Diego. ¡Que tengas buen día!",
  },
]
for (const [index, item] of CLOSED_SEED.entries()) {
  const at = daysAgo(index + 1)
  const conv = await seedConversation({
    orgId: ORG_A,
    contactId: contactIdByName.get(item.name)!,
    connectionId: connA.id,
    thread: item.thread,
    lastInboundAt: at,
    lastOutboundAt: new Date(at.getTime() + 600_000),
    lastMessageAt: new Date(at.getTime() + 600_000),
    closed: { reason: item.reason, at: new Date(at.getTime() + 900_000), byUserId: item.by },
  })
  await seedMessage({
    orgId: ORG_A,
    conversationId: conv.id,
    direction: "in",
    senderKind: "contact",
    body: item.said,
    externalId: `seed-msg-closed-${index}-in`,
    status: "read",
    createdAt: at,
  })
  await seedMessage({
    orgId: ORG_A,
    conversationId: conv.id,
    direction: "out",
    senderKind: item.by ? "user" : "agent",
    senderUserId: item.by,
    body: item.answer,
    externalId: `seed-msg-closed-${index}-out`,
    status: "read",
    createdAt: new Date(at.getTime() + 600_000),
  })
}

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
  llm: "chatgpt_6",
  systemPrompt: "Eres el asistente de Dental Smile. Responde en español, tono amable.",
  handoffKeywords: ["humano", "asesor", "recepcion"],
  maxTurns: 10,
  // La voz de la clínica y una indicación por función: lo que se ve en Agente › Recepción.
  personaName: "Sofi",
  treatment: "tu",
  tone: "cercano",
  about: "Clínica dental familiar con dos sedes. Atendemos sin apuro y explicamos cada tratamiento antes de empezar.",
  functionNotes: { agendar: "Ofrece primero los horarios de la mañana; las tardes se llenan rápido." },
})

// --- Derivaciones del agente: cola con plazo visible y caso ya tomado ---
await createHandoff(db, ORG_A, null, {
  conversationId: convCarlos.id,
  reason: "Pregunta por precio de extracción y pide hablar con una persona",
  summary:
    "Carlos consultó el costo de una extracción de muela del juicio; el agente no da precios inventados y derivó con prioridad alta.",
  priority: "alta",
  createdBy: "agent",
})
await createHandoff(db, ORG_A, null, {
  conversationId: convJorge.id,
  reason: "El interlocutor se mostró molesto por la espera",
  summary: "Jorge reportó demora en la atención anterior; se derivó a recepción para seguimiento.",
  priority: "media",
  assigneeUserId: LUIS_ID,
  createdBy: "agent",
})

// --- Pacientes + clínica (org A) ---
// Identidad estándar (ADR 0004): nombre separado y documento con su tipo; una
// extranjera con carné de extranjería y otra con pasaporte y país emisor.
const PATIENTS_A: Array<{
  name: string
  doc: string
  birth: string
  sex: string
  docType?: string
  docCountry?: string
  nationality?: string
}> = [
  { name: "Rosa Quispe", doc: "45678901", birth: "1990-05-14", sex: "F" },
  {
    name: "Elena Huamán",
    doc: "001234567",
    birth: "1985-11-02",
    sex: "F",
    docType: "CE",
    nationality: "VE",
  },
  { name: "Carlos Paredes", doc: "45678903", birth: "1978-03-21", sex: "M" },
  { name: "Lucía Fernández", doc: "45678904", birth: "1995-07-30", sex: "F" },
  { name: "Miguel Torres", doc: "45678905", birth: "1982-01-17", sex: "M" },
  {
    name: "Carmen Rojas",
    doc: "AB1234567",
    birth: "1992-09-08",
    sex: "F",
    docType: "PASAPORTE",
    docCountry: "CO",
    nationality: "CO",
  },
]
const patientIdByName = new Map<string, string>()
for (const p of PATIENTS_A) {
  const [given, paternal] = p.name.split(" ")
  const rosa = p.name === "Rosa Quispe"
  const row = await createPatient(db, ORG_A, ANA_ID, {
    displayName: p.name,
    givenNames: given,
    paternalSurname: paternal,
    contacts: [
      { contactId: contactIdByName.get(p.name)!, relationship: "self", isPreferred: true },
    ],
    docType: p.docType ?? "DNI",
    docNumber: p.doc,
    docCountry: p.docCountry ?? null,
    nationality: p.nationality ?? "PE",
    // Filiación completa de la paciente de demostración.
    ...(rosa
      ? {
          maritalStatus: "casado",
          educationLevel: "superior_universitaria_completa",
          occupation: "Docente",
          birthPlaceUbigeo: "080000",
          address: "Jr. Las Begonias 120, dpto. 302",
          addressUbigeo: "150000",
          addressReference: "Frente al parque Kennedy",
          emergencyContactName: "Carlos Paredes",
          emergencyContactRelationship: "conyuge",
          emergencyContactPhone: "+51912345678",
          insuranceType: "EPS",
          insurerName: "Pacífico EPS",
          affiliationNumber: "EPS-00987123",
        }
      : {}),
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
  allergies: [
    {
      substance: "Penicilina",
      category: "medicamento",
      reaction: "Urticaria",
      severity: "severa",
      kind: "alergia",
      criticality: "alta",
      verification: "confirmada",
    },
  ],
  familyHistory: [{ relationship: "madre", condition: "Hipertensión arterial" }],
  asaClass: "II",
  conditions: [
    { name: "Hipertensión arterial", status: "activa", notes: "Controlada con medicación" },
  ],
  medications: [
    { name: "Cozaar", genericName: "Losartán", dose: "50 mg", frequency: "1 vez al día" },
  ],
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
    category: a.category,
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
      genericName: m.genericName,
      dose: m.dose,
      frequency: m.frequency,
    })),
    {
      name: "Aspirina",
      genericName: "Ácido acetilsalicílico",
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
  billingMode?: "treatment" | "session"
  /** Cómo dice el precio el agente: la semilla muestra las tres formas (ADR 0021). */
  priceDisclosure: "exacto" | "desde" | "evaluacion"
}> = [
  {
    code: "EVALUACION",
    name: "Evaluación odontológica",
    specialty: "diagnostico",
    scope: "general",
    priceCents: 5000,
    durationMin: 30,
    priceDisclosure: "exacto",
  },
  {
    code: "OBTURACION",
    name: "Obturación con resina",
    specialty: "restauradora",
    scope: "tooth",
    priceCents: 18000,
    durationMin: 45,
    priceDisclosure: "exacto",
  },
  {
    code: "ENDODONCIA",
    name: "Endodoncia unirradicular",
    specialty: "endodoncia",
    scope: "tooth",
    priceCents: 45000,
    durationMin: 90,
    priceDisclosure: "desde",
  },
  {
    code: "CORONA",
    name: "Corona cerámica",
    specialty: "protesis",
    scope: "tooth",
    priceCents: 90000,
    durationMin: 60,
    priceDisclosure: "evaluacion",
  },
  {
    code: "BLANQUEAMIENTO",
    name: "Blanqueamiento dental",
    specialty: "estetica",
    scope: "arch",
    priceCents: 60000,
    durationMin: 60,
    priceDisclosure: "exacto",
  },
  {
    code: "LIMPIEZA",
    name: "Limpieza dental (profilaxis)",
    specialty: "prevencion",
    scope: "general",
    priceCents: 12000,
    durationMin: 45,
    priceDisclosure: "exacto",
  },
  {
    code: "ORTODONCIA_CTRL",
    name: "Control de ortodoncia",
    specialty: "ortodoncia",
    scope: "general",
    priceCents: 10000,
    durationMin: 30,
    billingMode: "session",
    priceDisclosure: "exacto",
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
// Lo que no se dice con precio exacto ofrece la evaluación de la clínica.
for (const code of ["ENDODONCIA", "CORONA"]) {
  await updateService(db, ORG_A, ANA_ID, serviceIdA(code), { evaluationServiceId: serviceIdA("EVALUACION") })
}
await db.transaction(async (tx) => {
  await createPromotion(tx, ORG_A, ANA_ID, {
    name: "Profilaxis preventiva demo",
    startsAt: daysAgo(1).toISOString(),
    endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    conditions: "Precio promocional para la profilaxis.",
    items: [{ serviceId: serviceIdA("LIMPIEZA"), mode: "fixed", priceCents: 7900 }],
  })
  await createPromotion(tx, ORG_A, ANA_ID, {
    name: "Corona desde un precio acordado",
    startsAt: daysAgo(1).toISOString(),
    conditions: "El odontólogo confirma el precio final en el presupuesto.",
    items: [{ serviceId: serviceIdA("CORONA"), mode: "from", priceCents: 65000 }],
  })
  await setCommissionRate(tx, ORG_A, ANA_ID, { professionalUserId: ANA_ID, rateBps: 4000 })
  await setCommissionRate(tx, ORG_A, ANA_ID, { professionalUserId: LUIS_ID, rateBps: 3500 })
})
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
  // Endodoncia en dos sesiones (apertura y obturación): ejercita el progreso.
  plannedSessions: 2,
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
await deliverBudget(db, ORG_A, ANA_ID, rosaPatientId, budgetRestaurador.id)
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
await deliverBudget(db, ORG_A, ANA_ID, rosaPatientId, budgetEstetica.id)
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
await deliverBudget(db, ORG_A, ANA_ID, rosaPatientId, budgetOrto.id)
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
  encounterId: draft.id,
})
// Diagnósticos CIE-10 de la atención (ADR 0003): con tipo y sitio dental.
await addEncounterDiagnosis(db, ORG_A, ANA_ID, rosaPatientId, draft.id, {
  cie10Code: "K02.1",
  diagnosisType: "definitivo",
  toothNumber: 36,
  surfaces: ["occlusal"],
  note: "Dolor a la percusión; caries en dentina.",
})
await addEncounterDiagnosis(db, ORG_A, ANA_ID, rosaPatientId, draft.id, {
  cie10Code: "K04.0",
  diagnosisType: "presuntivo",
  toothNumber: 46,
})
// Un diagnóstico mal registrado se anula con motivo; queda en la traza.
const dxErrado = await addEncounterDiagnosis(db, ORG_A, ANA_ID, rosaPatientId, draft.id, {
  cie10Code: "K02.1",
  diagnosisType: "presuntivo",
  toothNumber: 37,
})
await voidEncounterDiagnosis(db, ORG_A, ANA_ID, rosaPatientId, draft.id, dxErrado.id, {
  reason: "Pieza equivocada: era la 36",
})
// Documentos demo con bytes reales en storage (el registro exige borrador).
const rxRef = await putDemoImage(rosaPatientId, "rx", 0)
const docRx = await registerPatientDocument(db, ORG_A, ANA_ID, rosaPatientId, {
  category: "radiografia",
  label: "[DEMO] Radiografía periapical pieza 36",
  storageKey: rxRef.objectKey,
  contentType: rxRef.mimeType,
  sizeBytes: rxRef.size,
  thumbnailKey: rxRef.thumbnailKey,
  imageType: "periapical",
  capturedAt: new Date(Date.now() - 20 * 60_000),
  source: "Sensor intraoral · sala 2",
  encounterId: draft.id,
  toothNumbers: [36],
  tags: ["radiografia", "diagnostico-inicial"],
})
// Corrección versionada: suma etiqueta sin tocar blob ni clasificación.
await correctDocumentContext(db, ORG_A, ANA_ID, rosaPatientId, docRx.id, {
  expectedVersion: 1,
  tags: ["radiografia", "diagnostico-inicial", "pieza-36"],
})
const fotoRef = await putDemoImage(rosaPatientId, "foto", 0)
await registerPatientDocument(db, ORG_A, ANA_ID, rosaPatientId, {
  category: "foto_clinica",
  label: "[DEMO] Foto clínica piezas 36 y 46",
  storageKey: fotoRef.objectKey,
  contentType: fotoRef.mimeType,
  sizeBytes: fotoRef.size,
  thumbnailKey: fotoRef.thumbnailKey,
  imageType: "foto_intraoral",
  capturedAt: new Date(Date.now() - 15 * 60_000),
  encounterId: draft.id,
  planItemId: endo46.id,
  toothNumbers: [36, 46],
  tags: ["foto-clinica", "seguimiento"],
})
// Imágenes previas para comparar y filtrar por tipo y periodo: panorámica de
// un centro externo e interproximal de control, ya informadas.
for (const previa of [
  {
    imageType: "panoramica",
    label: "[DEMO] Panorámica inicial",
    days: 18,
    source: "Centro radiológico externo",
    teeth: [] as number[],
  },
  {
    imageType: "bitewing",
    label: "[DEMO] Interproximal derecha",
    days: 14,
    source: "Sensor intraoral · sala 2",
    teeth: [16, 46],
  },
  {
    imageType: "periapical",
    label: "[DEMO] Periapical 36 de control previo",
    days: 200,
    source: "Sensor intraoral · sala 1",
    teeth: [36],
  },
] as const) {
  const ref = await putDemoImage(rosaPatientId, "rx", previa.days > 100 ? 5 : 1)
  await registerPatientDocument(db, ORG_A, ANA_ID, rosaPatientId, {
    category: "radiografia",
    label: previa.label,
    storageKey: ref.objectKey,
    contentType: ref.mimeType,
    sizeBytes: ref.size,
    thumbnailKey: ref.thumbnailKey,
    imageType: previa.imageType,
    capturedAt: new Date(Date.now() - previa.days * 86_400_000),
    source: previa.source,
    reportStatus: "informado",
    toothNumbers: [...previa.teeth],
  })
}
// Periapical del sensor en DICOM (16 bits, con espaciado del detector) para
// el visor DICOM; se genera con el codificador de demostración.
{
  const { data, info } = await sharp(await demoClinicalImage("rx", 2))
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const pixels = new Uint16Array(info.width * info.height)
  for (let i = 0; i < pixels.length; i++) pixels[i] = Math.round(((data[i] ?? 0) / 255) * 4095)
  const dicom = encodeDemoDicom({
    width: info.width,
    height: info.height,
    pixels,
    pixelSpacingMm: [0.04, 0.04],
  })
  const ref = await storage.putPatientDocument({
    orgId: ORG_A,
    patientId: rosaPatientId,
    bytes: dicom,
    contentType: "application/dicom",
    ext: "dcm",
  })
  await registerPatientDocument(db, ORG_A, ANA_ID, rosaPatientId, {
    category: "radiografia",
    label: "[DEMO] Periapical 36 del sensor (DICOM)",
    storageKey: ref.objectKey,
    contentType: "application/dicom",
    sizeBytes: ref.size,
    imageType: "periapical",
    capturedAt: new Date(Date.now() - 10 * 60_000),
    source: "Sensor intraoral · sala 2",
    toothNumbers: [36],
  })
}
// Una imagen subida al paciente equivocado se retira con motivo; no se borra.
const erradaRef = await putDemoImage(rosaPatientId, "rx", 3)
const errada = await registerPatientDocument(db, ORG_A, ANA_ID, rosaPatientId, {
  category: "radiografia",
  label: "[DEMO] Periapical de otro paciente",
  storageKey: erradaRef.objectKey,
  contentType: erradaRef.mimeType,
  sizeBytes: erradaRef.size,
  thumbnailKey: erradaRef.thumbnailKey,
  imageType: "periapical",
})
await retirePatientDocument(db, ORG_A, ANA_ID, rosaPatientId, errada.id, {
  reason: "Subida al paciente equivocado",
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

// El cierre clínico requiere atención finalizada, no una reserva retrospectiva.
const controlObt = await createFollowUp(db, ORG_A, ANA_ID, rosaPatientId, {
  kind: "tratamiento",
  planItemId: obt36.id,
  originEncounterId: draft.id,
  title: "Control post-obturación pieza 36",
  instructions: "Verificar oclusión y sensibilidad.",
  dueAt: tomorrowIso(),
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
  diagnosisCode: "K02.1",
  items: [
    {
      genericName: "ibuprofeno",
      strength: "400 mg",
      dosageForm: "tableta",
      dose: "1 tableta",
      route: "oral",
      frequency: "Cada 8 horas",
      duration: "3 días",
      quantity: 9,
      instructions: "Tomar con alimentos.",
    },
  ],
})
// Se emitió confirmando el aviso de alergia por error y se anula: queda la traza.
const recetaAnulada = await createPrescription(db, ORG_A, ANA_ID, rosaPatientId, {
  acknowledgeAllergies: true,
  items: [
    {
      genericName: "amoxicilina",
      strength: "500 mg",
      dosageForm: "cápsula",
      dose: "1 cápsula",
      route: "oral",
      frequency: "Cada 8 horas",
      duration: "7 días",
      quantity: 21,
    },
  ],
})
await cancelPrescription(db, ORG_A, ANA_ID, rosaPatientId, recetaAnulada.id, {
  reason: "Alergia a penicilina registrada; se retira la prescripción.",
})

// Cobro parcial y adelanto con devolución: todos pasan por el mismo servicio de caja.
const cargoObt = cierreRosa.charges[0]
if (!cargoObt) throw new Error("El cierre no generó el cargo de la obturación")
await createCharge(db, ORG_A, ANA_ID, rosaPatientId, {
  branchId: miraflores.id,
  description: "Control post-obturación",
  amountCents: 5000,
  currency: "PEN",
})
const rosaSelfContactId = contactIdByName.get("Rosa Quispe")!
await db.transaction(async (tx) => {
  const methods = await listPaymentMethods(tx, ORG_A)
  const wallet = methods.find((method) => method.name === "Yape")
  const cash = methods.find((method) => method.typeCode === "10")
  if (!wallet || !cash) throw new Error("Faltan medios de pago de la clínica demo")
  await collectCharge(tx, ORG_A, ANA_ID, rosaPatientId, {
    branchId: miraflores.id,
    payerContactId: rosaSelfContactId,
    chargeIds: [cargoObt.id],
    requestId: "50206010-0000-4000-8000-000000000003",
    payments: [{ paymentMethodId: wallet.id, amountCents: 10000, reference: "YAPE-SEED-001" }],
  })
  await collectCharge(tx, ORG_A, ANA_ID, rosaPatientId, {
    branchId: miraflores.id,
    advanceCents: 5000,
    requestId: "50206010-0000-4000-8000-000000000004",
    payments: [{ paymentMethodId: cash.id, amountCents: 5000 }],
  })
  await refundCredit(tx, ORG_A, ANA_ID, rosaPatientId, {
    branchId: miraflores.id, amountCents: 2000, paymentMethodId: cash.id,
    reason: "Devolución parcial del adelanto solicitada por la paciente.",
  })
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
})
// Plan de Elena + presupuesto en borrador (sin presentar): ejercita el estado inicial.
const elenaEval = await createEncounter(db, ORG_A, ANA_ID, elenaPatientId, {
  reason: "Control de rutina",
})
await addEncounterDiagnosis(db, ORG_A, ANA_ID, elenaPatientId, elenaEval.id, {
  cie10Code: "Z01.2",
  diagnosisType: "definitivo",
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
const elenaBudget = await createBudget(db, ORG_A, ANA_ID, elenaPatientId, {
  planId: elenaPlan.id,
  itemIds: [elenaItem.id],
  title: "Plan profilaxis",
})
await db.transaction((tx) => adjustBudgetLines(tx, ORG_A, ANA_ID, elenaPatientId, elenaBudget.id, {
  lines: [{ planItemId: elenaItem.id, priceCents: 10000, reason: "Precio acordado para la demostración" }],
}))

// --- Volumen para paginación: 40 contactos+pacientes ---
for (let i = 1; i <= 40; i++) {
  const n = String(i).padStart(2, "0")
  const created = await createContact(db, ORG_A, {
    displayName: `Paciente Demo ${n}`,
  })
  await createOpportunity(
    db,
    ORG_A,
    {
      contactId: created.id,
      stageId: pipeA.stages[0]!.id,
      title: `Seguimiento · Paciente Demo ${n}`,
    },
    { userId: ANA_ID },
  )
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
await createOpportunity(
  db,
  ORG_B,
  {
    contactId: sofia.id,
    stageId: pipeB.stages[0]!.id,
    title: "Seguimiento · Sofía Ramos",
  },
  { userId: CORA_ID },
)
await createOpportunity(
  db,
  ORG_B,
  {
    contactId: hugo.id,
    stageId: pipeB.stages[1]!.id,
    title: "Seguimiento · Hugo Díaz",
  },
  { userId: CORA_ID },
)
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
  direction: "in",
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
// Consentimiento de datos (Ley 29733) con la versión vigente del aviso.
await db.transaction((tx) =>
  grantDataConsent(tx, ORG_A, ANA_ID, rosaPatientId, {
    purposes: ["atencion", "recordatorios"],
    grantedByContactId: rosaContactId,
  }),
)
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
  direction: "in",
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
        demographics: {
          displayName: "Pedro Quispe",
          givenNames: "Pedro",
          paternalSurname: "Quispe",
          birthDate: "2016-05-20",
        },
        respondent: "representative",
        // El alta del menor registra a su representante legal (con documento)
        // y le asigna la responsabilidad en la misma transacción.
        representative: {
          displayName: "Rosa Quispe",
          relationship: "guardian",
          relationshipDetail: "Madre",
          phone: SHARED_PHONE,
          docType: "DNI",
          docNumber: "45678901",
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
// Rosa ya es representante legal vigente desde el alta: decide por el menor.
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
await deliverBudget(db, ORG_A, ANA_ID, pedro.id, presupuestoPedro.id)
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
await deliverBudget(db, ORG_A, ANA_ID, pedro.id, revisionPedro.id)

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
if (!surco) throw new Error("Falta la Sede Surco")
const chairsMiraflores = await Promise.all(
  ["Sillón 1", "Sillón 2", "Sillón 3"].map((name) =>
    createChair(db, ORG_A, { branchId: miraflores.id, name }),
  ),
)
const domainSeed = {
  orgId: ORG_A,
  ownerUserId: ANA_ID,
  branchId: miraflores.id,
  patientId: patientIdByName.get("Rosa Quispe")!,
  contactId: rosaContactId,
  conversationId: convRosa.id,
}
// Solo Miraflores lleva agenda: Surco se deja limpia (sin sillones, horarios ni ausencias)
// para ver los estados de «falta configurar» y montar una sede desde la propia agenda.
await db.transaction((tx) => seedAvailability(tx, domainSeed))
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
// Ausencias claras en Miraflores, lejos de las citas sembradas (ayer, hoy y mañana):
// un permiso y unas vacaciones de dos profesionales, un feriado de toda la sede y un
// sillón en mantenimiento.
const limaDay = (dayOffset: number): string => lima(dayOffset, "00:00")
for (const block of [
  { dentistUserId: ANA_ID, kind: "ausencia", reason: "Permiso", startsAt: lima(4, "15:00"), endsAt: lima(4, "18:00") },
  { dentistUserId: LUIS_ID, kind: "ausencia", reason: "Vacaciones", startsAt: limaDay(6), endsAt: limaDay(9) },
  { kind: "bloqueo", reason: "Feriado", startsAt: limaDay(12), endsAt: limaDay(13) },
  { chairId: chairA(2), kind: "bloqueo", reason: "Mantenimiento", startsAt: lima(3, "09:00"), endsAt: lima(3, "12:00") },
]) {
  await createScheduleBlock(db, ORG_A, ANA_ID, { branchId: miraflores.id, ...block })
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
  // Tarde de hoy: la agenda muestra «lo que viene», huecos entre citas y por confirmar.
  {
    patient: "Carmen Rojas",
    dentist: ANA_ID,
    chair: 0,
    day: 0,
    start: "15:00",
    end: "15:45",
    service: "LIMPIEZA",
    status: "confirmada",
  },
  {
    patient: "Carlos Paredes",
    dentist: LUIS_ID,
    chair: 1,
    day: 0,
    start: "15:30",
    end: "16:30",
    service: "ENDODONCIA",
  },
  {
    patient: "Elena Huamán",
    dentist: LUIS_ID,
    chair: 1,
    day: 0,
    start: "17:00",
    end: "17:30",
    service: "ORTODONCIA_CTRL",
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
  const reserved = await createAppointment(db, ORG_A, ANA_ID, {
    branchId: miraflores.id,
    patientId: seedPatientId,
    dentistUserId: item.dentist,
    chairId: chairA(item.chair),
    serviceId: serviceIdA(item.service),
    startsAt: lima(item.day, item.start),
    endsAt: lima(item.day, item.end),
    status: item.status ?? "programada",
  })
  if (item.patient === "Rosa Quispe" && item.day === 1) {
    await db.transaction(async (tx) => {
      const control = await createFollowUp(tx, ORG_A, ANA_ID, rosaPatientId, {
        kind: "tratamiento",
        planItemId: endo46.id,
        title: "Control de evolución endodóntica",
        dueAt: lima(1, "09:00"),
      })
      await scheduleFollowUp(tx, ORG_A, ANA_ID, rosaPatientId, control.id, {
        appointmentId: reserved.id,
      })
    })
  }
}
for (const seed of [
  seedAgent,
  seedAutomation,
  seedClinicalForms,
  seedInventory,
  seedFinance,
  seedMailbox,
  seedOpportunities,
  seedPortal,
  seedWorkspace,
  seedRoles,
]) {
  await db.transaction((tx) => seed(tx, domainSeed))
}
// Consentimientos firmados en la semilla: su PDF con huella, como al firmar
// desde la API (mismo generador).
for (const signed of await db
  .select({ id: consentDocument.id })
  .from(consentDocument)
  .where(
    and(
      eq(consentDocument.organizationId, ORG_A),
      eq(consentDocument.status, "firmado"),
      isNull(consentDocument.pdfDocumentId),
    ),
  )) {
  await generateConsentPdf({
    run: (fn) => fn(db),
    storage,
    orgId: ORG_A,
    userId: ANA_ID,
    consentId: signed.id,
  })
}
await db.transaction(async (tx) => {
  const { items } = await listOpportunities(tx, ORG_A, {
    contactId: rosaContactId,
    q: "Ortodoncia · evaluación inicial",
    limit: 1,
  })
  const commercial = items[0]
  if (!commercial) throw new Error("Falta la oportunidad de demostración conectada")
  await seedCrmActivity(tx, { ...domainSeed, opportunityId: commercial.id })
})
await db.transaction((tx) => seedChannels(tx, domainSeed, secretsKey, { fetch }))
await db.transaction((tx) => seedWebchat(tx, domainSeed, { secretsKey, fetch }))
// Dos meses de historia para que Reportes tenga con qué comparar.
await db.transaction((tx) =>
  seedReports(tx, {
    ...domainSeed,
    chairId: chairA(0),
    dentistUserIds: [ANA_ID, LUIS_ID],
    patientIds: [...patientIdByName.values()],
  }),
)
await db.transaction(async (tx) => {
  const staff = await seedAdminCore(tx)
  await seedSaasBillingDemo(tx, storage)
  await seedAdminOrganizations(tx)
  await seedAdminSupport(tx, { organizationId: ORG_A, userId: ANA_ID, staffUserId: staff.supportUserId })
})
// Lo que hicieron los agentes este mes (ADR 0030), para ver Plan y pagos y
// «Ver cada acción» con datos: conversaciones, una consulta y una cita, con
// el precio base del plan de la semilla. Ejemplos; ningún agente los hizo.
{
  const people = [...contactIdByName.values()].slice(0, 6)
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000)
  await db.insert(saasAction).values([
    ...people.map((contactId, index) => ({
      organizationId: ORG_A,
      kind: "conversacion",
      occurredAt: hoursAgo(6 + index * 30),
      contactId,
      channel: index % 2 === 0 ? "whatsapp" : "instagram",
      detail: `Atendió una conversación por ${index % 2 === 0 ? "WhatsApp" : "Instagram"}`,
      currency: "USD",
      basePriceMicros: 500_000,
      priceMicros: 500_000,
      dedupeKey: `semilla:conversacion:${index}`,
    })),
    {
      organizationId: ORG_A,
      kind: "consulta",
      occurredAt: hoursAgo(20),
      contactId: people[0] ?? null,
      detail: "Ordenó la consulta dictada por Ana Torres",
      currency: "USD",
      basePriceMicros: 400_000,
      priceMicros: 400_000,
      dedupeKey: "semilla:consulta:0",
    },
    {
      organizationId: ORG_A,
      kind: "cita",
      occurredAt: hoursAgo(50),
      contactId: people[1] ?? null,
      channel: "enlace",
      windowStart: hoursAgo(120),
      detail: "Volvió tras «Seguir un presupuesto» y reservó desde el enlace",
      currency: "USD",
      basePriceMicros: 4_000_000,
      priceMicros: 4_000_000,
      dedupeKey: "semilla:cita:0",
    },
  ]).onConflictDoNothing()
}
// Uso de IA del mes para la ficha de la clínica en la administración (ADR 0030).
// Cifras de ejemplo con el costo que da la tabla de precios del agente; no
// salen de ningún proveedor. Jev queda sin costo: no tiene precio cargado.
await db.insert(aiUsage).values([
  { organizationId: ORG_A, origin: "recepcion", provider: "anthropic", model: "claude-haiku-5-5", calls: 120, inputTokens: 360_000, cachedInputTokens: 240_000, cacheWriteTokens: 12_000, outputTokens: 6_000, costMicros: 17_700 },
  { organizationId: ORG_A, origin: "dictado", provider: "openai", model: "gpt-6-luna", calls: 14, inputTokens: 28_000, outputTokens: 4_200, costMicros: 4_900 },
  { organizationId: ORG_A, origin: "probar", provider: "openai", model: "gpt-6-luna", calls: 9, inputTokens: 27_000, outputTokens: 900, costMicros: 3_150 },
  { organizationId: ORG_A, origin: "transcripcion", provider: "transcripcion", model: "whisper-1", calls: 6, audioSeconds: 240, costMicros: 24_000 },
  { organizationId: ORG_A, origin: "vectores", provider: "vectores", model: "text-embedding-3-small", calls: 3, inputTokens: 15_000, costMicros: 300 },
  { organizationId: ORG_A, origin: "ya_aviso", provider: "jev", model: "jev-1.13.0", calls: 4, inputTokens: 1_200, outputTokens: 8, costMicros: null },
])

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
