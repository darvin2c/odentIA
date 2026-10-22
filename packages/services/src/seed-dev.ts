/**
 * Seed de dev determinista para prueba manual del panel.
 *
 * Solo manual (`pnpm db:seed`); NUNCA en CI ni importado por tests
 * (cada test crea sus fixtures mínimas). Idempotente: borra solo las
 * orgs/usuarios semilla y los recrea. Prerrequisito: `seed:diagnoses` antes
 * (los códigos K02.1/K04.0/Z01.2 deben existir; si falta alguno el script
 * falla rápido nombrándolo, sin skips silenciosos).
 *
 * Regla permanente: toda función nueva que añada pantalla o entidad debe
 * extender este archivo con su escenario mínimo en la misma PR.
 */
import { LEGAL } from "@odentia/auth/legal"
import { processingAgreementAcceptance } from "@odentia/db/schema/workspace"
import { encodeDemoCtSlice, encodeDemoDicom } from "@odentia/clinical"
import { generateCbctPhantom } from "@odentia/dental"
import { PDFDocument, StandardFonts } from "pdf-lib"
import sharp from "sharp"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { deflateSync } from "node:zlib"
import { DEFAULT_REGISTRATION_CONFIG, DICOM_SAMPLES } from "@odentia/clinical"
import { TREATMENT_KIND_KEYS } from "@odentia/dental"
import { createOwnerDb, withOrgContext } from "@odentia/db"
import { supportNotice } from "@odentia/db/schema/admin-support"
import { saasAction, saasSubscription } from "@odentia/db/schema/saas-billing"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { agentSearchItem, aiUsage } from "@odentia/db/schema/agent"
import { account, invitation, member, organization, user } from "@odentia/db/schema/auth"
import {
  clinicalFollowUp,
  clinicalNote,
  encounter,
  encounterDiagnosis,
  encounterPlanItem,
  encounterProcedure,
  encounterSite,
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
  appointmentPlanItem,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentBudgetOption,
  treatmentPlan,
  treatmentPlanItem,
  treatmentTemplate,
} from "@odentia/db/schema/clinical"
import {
  odontogramAssessment,
  odontogramEntry,
  periodontalChart,
  periodontalTooth,
  planItemFinding,
} from "@odentia/db/schema/dental"
import { consentDocument, consentTemplate, professionalProfile } from "@odentia/db/schema/clinical-forms"
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
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { claimHandoff, createHandoff, recordTopicAskedAgain } from "./agent-operations.js"
import { ANSWER_READY_MESSAGE, replyId } from "./automation-messages.js"
import { upsertAgentConfig } from "./agentConfig.js"
import { addPatientAllergy, removePatientAllergy } from "./allergies.js"
import { createAppointment, createRoom, setAppointmentArrival } from "./appointments.js"
import { createScheduleBlock, setProfessionalSchedule } from "./availability.js"
import {
  addBudgetItems,
  adjustBudgetLines,
  createBudget,
  decideBudget,
  deliverBudget,
  duplicateBudgetOption,
  removeBudgetItems,
  reviseBudget,
} from "./budgets.js"
import {
  addClinicalNote,
  addDeclaredAllergies,
  correctDocumentContext,
  registerPatientDocument,
  retirePatientDocument,
  savePatientHealth,
} from "./clinical.js"
import { addOdontogramEntries, createOdontogramAssessment, voidOdontogramEntry } from "./dental/odontogram.js"
import { createConnection } from "./connections.js"
import { createContact, updateContact } from "./contacts.js"
import { blockContact, markSpam } from "./contact-screen.js"
import { decideActionReview, requestActionReview } from "./saas-action-review.js"
import {
  markImagingFilesUploaded,
  pendingImagingFiles,
  setImagingThumbnail,
  startImagingStudyUpload,
} from "./imaging-studies.js"
import { createContactNote } from "./crm-workspace.js"
import { grantDataConsent } from "./data-consents.js"
import { eraseForDataRequest } from "./data-erasure.js"
import { addCalendarDays, createDataRequest, respondDataRequest, verifyDataRequest } from "./data-requests.js"
import { clinicToday } from "./inventory-stock.js"
import { addEncounterDiagnosis, voidEncounterDiagnosis } from "./encounter-diagnoses.js"
import {
  addEncounterAddendum,
  addEncounterProcedure,
  createEncounter,
  finalizeEncounter,
  updateEncounterDraft,
  voidEncounter,
} from "./encounters.js"
import { createFieldDef } from "./fields.js"
import { cancelFollowUp, completeFollowUp, createFollowUp, scheduleFollowUp } from "./follow-ups.js"
import { setCommissionRate } from "./finance.js"
import { closeOpportunity, createOpportunity, listOpportunities, moveOpportunity, setOpportunityTask } from "./opportunities.js"
import {
  createPatientRegistrationLink,
  leaveRegistrationHold,
  registerPatient,
  savePatientRegistrationConfig,
} from "./patient-registration.js"
import { createPatient, patientPersonId, RegistrationHeld, updatePatient } from "./patients.js"
import { collectCharge, createCharge, refundCredit } from "./payments.js"
import { ensureDefaultPaymentMethods, listPaymentMethods } from "./payment-methods.js"
import { ensureDefaultPipeline } from "./pipelines.js"
import { setConsent, setMessageChoice } from "./automation.js"
import { addPlanItem, createTreatmentPlan, setPlanItemStatus } from "./plan.js"
import { cancelPrescription, createPrescription } from "./prescriptions.js"
import { setProfessionalProfile } from "./professional-profiles.js"
import { createPromotion } from "./promotions.js"
import { grantResponsibility } from "./responsibilities.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { seedAgent } from "./seed-agent.js"
import { seedAutomation, seedChannelTemplates } from "./seed-automation.js"
import { seedAvailability } from "./seed-availability.js"
import { seedChannels } from "./seed-channels.js"
import { seedPeriodontalCase } from "./dental/seed-periodontal.js"
import { generateConsentPdf } from "./consent-pdf.js"
import { makeImageThumbnail } from "./thumbnails.js"
import { registerToothFinding } from "./dental/tooth-panel.js"
import { issuePersonalLink } from "./booking-links.js"
import {
  createClinicalOrder,
  markConsentSentByLink,
  setProfessionalSpecialties,
  signConsentDocument,
} from "./clinical-forms.js"
import { seedClinicalForms } from "./seed-clinical-forms.js"
import { seedCrmActivity } from "./seed-crm-activity.js"
import { seedFinance } from "./seed-finance.js"
import { seedInventory } from "./seed-inventory.js"
import { seedMaterialsAndSales } from "./seed-materials.js"
import { seedMailbox } from "./seed-mailbox.js"
import { seedOpportunities } from "./seed-opportunities.js"
import { seedPortal } from "./seed-portal.js"
import { seedReports } from "./seed-reports.js"
import { seedReportsAgent } from "./seed-reports-agent.js"
import { seedReportsArgos } from "./seed-reports-argos.js"
import { seedReportsFinance } from "./seed-reports-finance.js"
import { seedReportsPatients } from "./seed-reports-patients.js"
import { seedReportsProgress } from "./seed-reports-progress.js"
import { seedRoles } from "./seed-roles.js"
import { seedWebchat } from "./seed-webchat.js"
import { seedWorkspace } from "./seed-workspace.js"
import { SEED_STAFF_ADMIN_ID, SEED_STAFF_SUPPORT_ID, seedAdminCore } from "./seed-admin-core.js"
import { seedAdminOrganizations } from "./seed-admin-organizations.js"
import { seedAdminSupport } from "./seed-admin-support.js"
import { respondConsumerComplaint, submitConsumerComplaint } from "./consumer-complaints.js"
import { seedClinicNoticesDemo, seedSaasBillingDemo } from "./seed-saas-billing.js"
import { createService, quickAddServices, updateService } from "./service-catalog.js"
import { librarySpecialtyIds } from "./specialties.js"
import type { DentalFinalizeParts } from "./dental/hooks.js"
import { createStorage } from "./storage.js"
import { completeTask, createTask, settleTask, updateTask } from "./tasks.js"

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
/** La endodoncista de Dental Smile (fase 4, tablero 2): atiende martes y jueves por la tarde. */
const ROJAS_ID = "seed-user-rojas"
/** El odontólogo de la Sede San Isidro: la segunda sede con historia en Reportes. */
const SALAS_ID = "seed-user-salas"
/** Caja de Dental Smile: responde desde Inicio los temas de pagos que le pasa Sofi (decisión 3 del pulido de la Bandeja). */
const CAJA_ID = "seed-user-caja"
const SEED_USERS = [ANA_ID, LUIS_ID, CORA_ID, ROJAS_ID, SALAS_ID, CAJA_ID]
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
  // Un concepto vendido apunta a su producto (ADR 0067): se suelta antes de borrar
  // los productos; el concepto se borra después con los cobros.
  await db.execute(
    sql`update patient_charge set product_id = null, product_quantity = null, request_key = null
      where organization_id in (${ORG_A}, ${ORG_B}) and product_id is not null`,
  )
  // Hijos de los nuevos dominios: purga únicamente las organizaciones demo.
  for (const table of [
    // La revisión de un cobro apunta a su acción y a su caso de Soporte.
    "saas_action_review",
    "support_access_audit",
    "support_access_grant",
    "support_attachment",
    "support_message",
    "support_notice",
    "support_case",
    "saas_notice",
    "saas_negotiation",
    "saas_charge_line",
    "saas_action",
    "portal_challenge",
    "portal_passkey",
    "portal_verification",
    "portal_grant",
    "portal_policy",
    "portal_access_log",
    // El contador diario de sugerencias de direcciones (ADR 0077).
    "address_lookup_day",
    // La bitácora de consultas referencia paciente, usuario y organización sin cascada.
    "clinical_access_log",
    // Los pedidos sobre sus datos referencian a la persona vinculada (ADR 0080).
    "patient_data_request",
    // Las aperturas de una historia bloqueada referencian al paciente (ADR 0080).
    "patient_record_opening",
    "portal_session",
    "portal_link",
    "channel_template",
    "automation_link_token",
    "automation_job",
    "automation_consent",
    "automation_rule",
    "agent_decision_log",
    "ai_usage",
    // Lo que aprende el agente y lo que recuerda: las dejan las conversaciones
    // reales de desarrollo y referencian conversación, contacto y conocimiento
    // sin cascada; van antes que ellos y en este orden (caso de prueba →
    // lección → revisión → traza).
    "agent_test_case",
    "agent_lesson",
    "agent_review_item",
    "agent_answer_trace",
    "agent_knowledge_gap",
    "agent_person_fact",
    "agent_case_memory",
    "appointment_booking_link",
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
    "commission_settlement_line",
    "commission_settlement",
    "commission_rule",
    "cash_closure",
    "cash_movement",
    "supplier_credit_use",
    "expense_gap_dismissal",
    "expense",
    "cash_shift",
    "stock_movement",
    // Inventario por sede (ADR 0067): faltante, mínimos y materiales antes que sus productos.
    "stock_shortage",
    "product_minimum",
    "service_material",
    "product_lot",
    "purchase_order_line",
    "purchase_order",
    "product",
    "warehouse",
    "supplier",
    "mailbox_oauth_state",
    "schedule_block",
    "professional_schedule",
    "processing_agreement_acceptance",
    "home_visit",
    // Argos en Reportes, metas y el resumen del lunes (ADR 0070 y 0071).
    "report_question",
    "report_pin",
    "report_goal",
    "report_digest_send",
    "report_digest",
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
  // Las devoluciones (ADR 0068) después de lo que las nombra y antes de sus tickets.
  await db.execute(sql`delete from payment_return where organization_id in (${ORG_A}, ${ORG_B})`)
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
  await db.delete(encounterSite).where(inArray(encounterSite.organizationId, SEED_ORGS))
  // Los diagnósticos migrados desde notas antiguas las referencian (`legacy_note_id`): van antes.
  await db.delete(encounterDiagnosis).where(inArray(encounterDiagnosis.organizationId, SEED_ORGS))
  await db.delete(clinicalNote).where(inArray(clinicalNote.organizationId, SEED_ORGS))
  // Los ítems del plan referencian el hallazgo que los motivó: se suelta la
  // referencia antes de borrar el odontograma (los ítems se borran después).
  await db.delete(planItemFinding).where(inArray(planItemFinding.organizationId, SEED_ORGS))
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
  // Lo agendado de un plan apunta a sus tratamientos: va antes que ellos.
  await db.delete(appointmentPlanItem).where(inArray(appointmentPlanItem.organizationId, SEED_ORGS))
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
    // Las opciones de un presupuesto entregado tampoco se quitan en la aplicación.
    await tx.execute(
      sql`alter table treatment_budget_option disable trigger treatment_budget_option_guard_trigger`,
    )
    await tx
      .delete(treatmentBudgetOption)
      .where(inArray(treatmentBudgetOption.organizationId, SEED_ORGS))
    await tx.execute(
      sql`alter table treatment_budget_option enable trigger treatment_budget_option_guard_trigger`,
    )
  })
  await db.delete(treatmentPlanItem).where(inArray(treatmentPlanItem.organizationId, SEED_ORGS))
  await db.delete(treatmentBudget).where(inArray(treatmentBudget.organizationId, SEED_ORGS))
  await db.delete(treatmentPlan).where(inArray(treatmentPlan.organizationId, SEED_ORGS))
  // El periodontograma apunta a su atención (ADR 0054): va antes que ella.
  await db.delete(periodontalTooth).where(inArray(periodontalTooth.organizationId, SEED_ORGS))
  await db.delete(periodontalChart).where(inArray(periodontalChart.organizationId, SEED_ORGS))
  await db.delete(encounter).where(inArray(encounter.organizationId, SEED_ORGS))
  // La atención referencia su cita (ADR 0002): las citas se borran después.
  await db.delete(appointment).where(inArray(appointment.organizationId, SEED_ORGS))
  await db.delete(scheduleRoom).where(inArray(scheduleRoom.organizationId, SEED_ORGS))
  await db.execute(sql`delete from promotion_service_price where organization_id in (${ORG_A}, ${ORG_B})`)
  await db.execute(sql`delete from promotion where organization_id in (${ORG_A}, ${ORG_B})`)
  await db.delete(serviceCatalog).where(inArray(serviceCatalog.organizationId, SEED_ORGS))
  // Los servicios apuntan a su especialidad: la lista de la clínica va después.
  await db.execute(sql`delete from org_specialty where organization_id in (${ORG_A}, ${ORG_B})`)
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
  // Las clínicas demo de los avisos (`seedClinicNoticesDemo`) quedan entre
  // corridas, pero su contrato lo aceptó Ana: esa aceptación se va con ella y
  // la semilla la vuelve a poner junto con su membresía (que se va en cascada).
  await db.execute(
    sql`delete from processing_agreement_acceptance where accepted_by in (${sql.join(
      SEED_USERS.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  )
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
  /** Fase 7 de la Bandeja: reenviado, la reacción de la persona y una ubicación. */
  forwarded?: boolean
  contactReaction?: string | null
  location?: { latitude: number; longitude: number; name?: string; address?: string } | null
  /** Fase 3 de la Bandeja: la pregunta que cita, la respuesta por entregar y «Ver respuesta». */
  replyToMessageId?: string | null
  held?: boolean
  templateName?: string | null
  replyButtons?: { id: string; title: string }[] | null
}): Promise<{ id: string }> {
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
      forwarded: args.forwarded ?? false,
      contactReaction: args.contactReaction ?? null,
      contactReactionAt: args.contactReaction ? args.createdAt : null,
      location: args.location ?? null,
      replyToMessageId: args.replyToMessageId ?? null,
      held: args.held ?? false,
      templateName: args.templateName ?? null,
      templateLanguage: args.templateName ? "es" : null,
      replyButtons: args.replyButtons ?? null,
      createdAt: args.createdAt,
    })
    .returning({ id: message.id })
  if (!row) throw new Error(`No se pudo crear el mensaje ${args.externalId}`)
  return row
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
// Las cuentas semilla ya aceptaron los documentos vigentes; si no, entrar las
// llevaría a «Un paso antes de seguir» (lienzo «Términos con Google»).
const SEED_TERMS = { termsVersion: LEGAL.terms.version, termsAcceptedAt: new Date() }
await db.insert(user).values([
  {
    id: ANA_ID,
    name: "Dra. Ana Torres",
    firstName: "Ana",
    lastName: "Torres",
    email: "ana@odentia.dev",
    emailVerified: true,
    ...SEED_TERMS,
  },
  {
    id: LUIS_ID,
    name: "Luis Prado",
    firstName: "Luis",
    lastName: "Prado",
    email: "luis@odentia.dev",
    emailVerified: true,
    ...SEED_TERMS,
  },
  {
    id: CORA_ID,
    name: "Dra. Cora Vega",
    firstName: "Cora",
    lastName: "Vega",
    email: "cora@odentia.dev",
    emailVerified: true,
    ...SEED_TERMS,
  },
  {
    id: ROJAS_ID,
    name: "Dra. Elena Rojas",
    firstName: "Elena",
    lastName: "Rojas",
    email: "rojas@odentia.dev",
    emailVerified: true,
    ...SEED_TERMS,
  },
  {
    id: SALAS_ID,
    name: "Dr. Diego Salas",
    firstName: "Diego",
    lastName: "Salas",
    email: "salas@odentia.dev",
    emailVerified: true,
    ...SEED_TERMS,
  },
  {
    id: CAJA_ID,
    name: "Paula Ríos",
    firstName: "Paula",
    lastName: "Ríos",
    email: "caja@odentia.dev",
    emailVerified: true,
    ...SEED_TERMS,
  },
])
const passwordHash = await hashPassword(PASSWORD)
await db.insert(account).values(
  SEED_USERS.map((userId) => ({
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
    role: "clinician",
    createdAt: new Date(),
  },
  {
    id: randomUUID(),
    organizationId: ORG_A,
    userId: ROJAS_ID,
    role: "clinician",
    createdAt: new Date(),
  },
  {
    id: randomUUID(),
    organizationId: ORG_A,
    userId: SALAS_ID,
    role: "clinician",
    createdAt: new Date(),
  },
  { id: randomUUID(), organizationId: ORG_A, userId: CAJA_ID, role: "cashier", createdAt: new Date() },
  {
    id: randomUUID(),
    organizationId: ORG_B,
    userId: LUIS_ID,
    role: "clinician",
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
// Cada clínica semilla aceptó el contrato de encargo por su dueña.
await db.insert(processingAgreementAcceptance).values([
  { organizationId: ORG_A, version: LEGAL.agreement.version, acceptedBy: ANA_ID },
  { organizationId: ORG_B, version: LEGAL.agreement.version, acceptedBy: CORA_ID },
])
// Colegiatura con la que firman (ADR 0003). Luis queda sin colegiatura en la
// clínica B para ejercitar el aviso «falta tu colegiatura» al cerrar.
// Título y colegio se escriben: el perfil no trae los de ningún país por defecto.
const PERU_PROFESSIONAL = { professionalTitle: "Cirujano dentista", registrationBody: "COP" }
await setProfessionalProfile(db, ORG_A, ANA_ID, ANA_ID, {
  ...PERU_PROFESSIONAL,
  signatureName: "Ana Torres",
  registrationNumber: "12345",
  specialtyRegistration: "RNE 1024",
})
await setProfessionalProfile(db, ORG_A, ANA_ID, LUIS_ID, { ...PERU_PROFESSIONAL, registrationNumber: "23456" })
await setProfessionalProfile(db, ORG_A, ANA_ID, SALAS_ID, { ...PERU_PROFESSIONAL, signatureName: "Diego Salas", registrationNumber: "56789" })
await setProfessionalProfile(db, ORG_A, ANA_ID, ROJAS_ID, {
  ...PERU_PROFESSIONAL,
  signatureName: "Elena Rojas",
  registrationNumber: "45678",
  specialtyRegistration: "RNE 2048",
})
await setProfessionalProfile(db, ORG_B, CORA_ID, CORA_ID, { ...PERU_PROFESSIONAL, registrationNumber: "34567" })
await db.insert(orgProfile).values([
  {
    organizationId: ORG_A,
    legalName: "Dental Smile S.A.C.",
    // El nombre que ven los pacientes en todo (decisión 19); la razón social, solo en el comprobante.
    tradeName: "Dental Smile",
    fiscalDocNumber: "20601234567",
    // Explicito: país, moneda, idioma y zona son el contrato de la agenda y del
    // formato de los teléfonos (IANA canónico y ISO-3166-1).
    countryCode: "PE",
    currency: "PEN",
    locale: "es-PE",
    timezone: "America/Lima",
    // La lista de diagnósticos que recomienda Perú (decisión 26).
    diagnosisSystem: "ICD-10",
    // El que da el agente ante una urgencia (ADR 0050); la clínica B no tiene y ve el aviso.
    emergencyPhone: "+5115550123",
  },
  {
    organizationId: ORG_B,
    legalName: "Clínica Norte S.A.C.",
    tradeName: "Clínica Norte",
    fiscalDocNumber: "20550987654",
    countryCode: "PE",
    currency: "PEN",
    locale: "es-PE",
    timezone: "America/Lima",
    // La lista de diagnósticos que recomienda Perú (decisión 26).
    diagnosisSystem: "ICD-10",
  },
])
await db.transaction(async (tx) => {
  await ensureDefaultPaymentMethods(tx, ORG_A, ANA_ID, "PE")
  await ensureDefaultPaymentMethods(tx, ORG_B, CORA_ID, "PE")
})
const [miraflores] = await db
  .insert(branch)
  .values([
    // Miraflores hereda la zona de la organización (`timezone` en null). La dirección
    // tiene la forma de la del paciente (issue 36): distrito, provincia y región ISO 3166-2.
    {
      organizationId: ORG_A,
      name: "Sede Miraflores",
      addressLine1: "Av. José Larco 345",
      city: "Miraflores",
      district: "Lima",
      region: "PE-LMA",
      country: "PE",
    },
    // Surco ejercita el camino contrario: teléfono y zona propios. Queda sin unidades dentales
    // ni horarios: es la sede limpia para probar la configuración desde cero.
    {
      organizationId: ORG_A,
      name: "Sede Surco",
      city: "Santiago de Surco",
      district: "Lima",
      region: "PE-LMA",
      country: "PE",
      phone: "+51987655001",
      timezone: "America/Lima",
    },
    // San Isidro es la segunda sede con historia: dos años de citas en Reportes, con el Dr. Salas.
    {
      organizationId: ORG_A,
      name: "Sede San Isidro",
      addressLine1: "Av. Javier Prado Este 2465",
      city: "San Isidro",
      district: "Lima",
      region: "PE-LMA",
      country: "PE",
    },
  ])
  .returning({ id: branch.id })
if (!miraflores) throw new Error("No se pudo crear la Sede Miraflores")
await db.insert(branch).values([{ organizationId: ORG_B, name: "Sede Lima", country: "PE" }])

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
// Sus mensajes: los diez con los que viene, en estados variados, y uno propio.
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
/**
 * El tablero de ventas de la demostración (ADR 0028): cada oportunidad es un
 * interés concreto y está donde la dejó lo que pasó de verdad. Un «hola» no
 * crea ninguna: las demás personas no tienen oportunidad.
 */
const stageOf = (moment: (typeof pipeA.stages)[number]["moment"]) => pipeA.stages.find((stage) => stage.moment === moment)!
const SEED_SALES: Record<string, (contactId: string) => Promise<void>> = {
  // Lo pidió por WhatsApp: lo registró el agente y queda en Recepción.
  "Rosa Quispe": async (contactId) => {
    await createOpportunity(db, ORG_A, { contactId, title: "Blanqueamiento", interestText: "Preguntó cuánto cuesta el blanqueamiento" }, { userId: null, origin: "agente" })
  },
  // Interesado, con su tarea: «Llamar · vence mañana».
  "Jorge Mamani": async (contactId) => {
    const opp = await createOpportunity(db, ORG_A, { contactId, title: "Implante", interestText: "Implante en la pieza 36" }, { userId: ANA_ID })
    await setOpportunityTask(db, ORG_A, opp.id, { title: "Llamar a Jorge por su implante", dueAt: new Date(Date.now() + 24 * 3600_000).toISOString() }, { userId: ANA_ID, createdBy: "user" })
  },
  // Pasó sola: agendó su evaluación.
  "Elena Huamán": async (contactId) => {
    const opp = await createOpportunity(db, ORG_A, { contactId, title: "Ortodoncia", interestText: "Evaluación de ortodoncia" }, { userId: null, origin: "agente" })
    await moveOpportunity(db, ORG_A, opp.id, stageOf("evaluacion_agendada").id, {
      userId: null, origin: "automatico", cause: "cita_agendada", causeAt: new Date(Date.now() + 2 * 24 * 3600_000),
    })
  },
  // Pasó sola: presupuesto presentado.
  "Carlos Paredes": async (contactId) => {
    const opp = await createOpportunity(db, ORG_A, { contactId, title: "Endodoncia", assignedUserId: ANA_ID }, { userId: ANA_ID })
    await moveOpportunity(db, ORG_A, opp.id, stageOf("presupuesto_enviado").id, { userId: null, origin: "automatico", cause: "presupuesto_presentado" })
  },
  // Ganada: aceptó el presupuesto.
  "Lucía Fernández": async (contactId) => {
    const opp = await createOpportunity(db, ORG_A, { contactId, title: "Limpieza" }, { userId: ANA_ID })
    await closeOpportunity(db, ORG_A, opp.id, { outcome: "won", reason: "acepto_presupuesto" }, { userId: null, origin: "automatico" })
  },
  // Perdida: «Precio».
  "Miguel Torres": async (contactId) => {
    const opp = await createOpportunity(db, ORG_A, { contactId, title: "Carillas" }, { userId: ANA_ID })
    await closeOpportunity(db, ORG_A, opp.id, { outcome: "lost", reason: "precio" }, { userId: ANA_ID })
  },
}
for (let i = 0; i < CONTACTS_A.length; i++) {
  const c = CONTACTS_A[i]!
  const created = await createContact(db, ORG_A, { displayName: c.name, phone: c.phone }, { userId: ANA_ID })
  // Las notas de la persona son `crm_note`, con autor (fase 4, «un dato, un lugar»).
  if (c.name === "Jorge Mamani") {
    await createContactNote(
      db,
      ORG_A,
      created.id,
      { body: `Teléfono familiar compartido: ${SHARED_PHONE} (titular: Rosa Quispe)` },
      { userId: ANA_ID },
    )
  }
  if (c.name === "Rosa Quispe") {
    await updateContact(db, ORG_A, created.id, { preferredChannel: "whatsapp" }, { userId: ANA_ID })
  }
  await SEED_SALES[c.name]?.(created.id)
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
// Fase 7 de la Bandeja: lo que antes se perdía se ve. Sofi le propuso un horario
// y Rosa reaccionó con 👍 (no confirma nada), reenvió una promoción ajena y mandó
// su ubicación.
await seedMessage({
  orgId: ORG_A,
  conversationId: convRosa.id,
  direction: "out",
  senderKind: "agent",
  body: "¿Te acomoda mañana a las 17:30 con la Dra. Ana Torres?",
  externalId: "seed-msg-rosa-propuesta",
  status: "read",
  createdAt: new Date(hoursAgo(1).getTime() + 60_000),
  contactReaction: "👍",
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convRosa.id,
  direction: "in",
  senderKind: "contact",
  body: "Promo 2x1 en blanqueamiento hasta el viernes",
  externalId: "seed-msg-rosa-reenvio",
  status: "received",
  createdAt: new Date(hoursAgo(1).getTime() + 120_000),
  forwarded: true,
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convRosa.id,
  direction: "in",
  senderKind: "contact",
  body: "Ubicación: Av. Larco 345, Miraflores",
  contentType: "location",
  externalId: "seed-msg-rosa-ubicacion",
  status: "received",
  createdAt: new Date(hoursAgo(1).getTime() + 180_000),
  location: { latitude: -12.1219, longitude: -77.0297, address: "Av. Larco 345, Miraflores" },
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
  // Derivar no apaga al agente (ADR 0050): el precio es un tema del equipo y él sigue con lo demás.
  unreadCount: 1,
  lastInboundAt: hoursAgo(3),
  lastMessageAt: hoursAgo(3),
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

// --- Spam y bloqueados (issue 77, ADR 0054): una persona por cada forma de
// llegar a Spam (el mismo texto muchas veces, una venta a la clínica y una
// estafa) y una bloqueada por recepción. Ninguna es paciente; no se envía nada.
const SEED_SCREENED = [
  { name: "+1 202 555 0142", phone: "+12025550142", reason: "repeticion", texts: Array.from({ length: 6 }, () => "GANA S/ 500 DIARIOS desde casa 💸 Escribe YA 👉 bit.ly/gana-ya") },
  { name: "MarketDent", phone: "+51944100200", reason: "venta", texts: ["Hola, somos MarketDent 👋 Hacemos páginas web y campañas para clínicas dentales. ¿Con quién puedo hablar para enviarle nuestra propuesta?"] },
  { name: "+51 913 004 221", phone: "+51913004221", reason: "estafa", texts: ["Su paquete está retenido en aduanas. Pague S/ 8,90 aquí para liberarlo: correos-pe.info/pago"] },
  { name: "Kevin Ramos", phone: "+51951220418", reason: "amenazas", texts: ["¿Por qué me cobraron la consulta si no me atendieron?", "Esto no se queda así. Voy a ir a la clínica y van a ver."] },
] as const
for (const [index, item] of SEED_SCREENED.entries()) {
  const person = await createContact(db, ORG_A, { displayName: item.name, phone: item.phone }, { userId: ANA_ID })
  await db.insert(contactIdentity).values({
    organizationId: ORG_A,
    contactId: person.id,
    channel: "whatsapp",
    externalUserId: `wa:${item.phone.replace(/\D/g, "")}`,
    displayName: item.name,
    isPrimary: true,
  })
  const last = hoursAgo(5 + index * 7)
  const conv = await seedConversation({
    orgId: ORG_A,
    contactId: person.id,
    connectionId: connA.id,
    thread: `seed-thread-screened-${index}`,
    unreadCount: 0,
    lastInboundAt: last,
    lastMessageAt: last,
  })
  let firstMessageId = ""
  for (const [n, text] of item.texts.entries()) {
    const msg = await seedMessage({
      orgId: ORG_A,
      conversationId: conv.id,
      direction: "in",
      senderKind: "contact",
      body: text,
      externalId: `seed-msg-screened-${index}-${n}`,
      status: "received",
      createdAt: new Date(last.getTime() - (item.texts.length - 1 - n) * 6 * 60_000),
    })
    firstMessageId ||= msg.id
  }
  if (item.reason === "amenazas") {
    await blockContact(db, ORG_A, {
      contactId: person.id,
      userId: ANA_ID,
      reason: "amenazas",
      note: "Amenazó a recepción después de que le cobramos la consulta.",
    })
  } else {
    await markSpam(db, ORG_A, { contactId: person.id, reason: item.reason, userId: null, messageId: firstMessageId })
  }
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
// Una tarea sin responsable de Recepción («Mías y de mi área») y una que se
// cerró sola porque su motivo desapareció (ADR 0028).
await createTask(db, ORG_A, {
  title: "Llamar a Elena para ofrecerle otra fecha",
  contactId: contactIdByName.get("Elena Huamán")!,
  area: "recepcion",
  dueAt: tomorrowIso(),
  createdBy: "admin",
  reason: "Canceló su cita y no tiene otra.",
  idempotencyKey: "seed:tarea-recepcion",
})
const settledDemo = await createTask(db, ORG_A, {
  title: "Llamar a Rosa Quispe para recordarle su cita",
  contactId: contactIdByName.get("Rosa Quispe")!,
  area: "recepcion",
  createdBy: "admin",
  reason: "Su cita es mañana y no la confirmó.",
  idempotencyKey: "seed:tarea-se-cerro-sola",
})
await settleTask(db, ORG_A, settledDemo.id, "Rosa Quispe confirmó su cita")

// --- Agente A (B sin fila: ejercita el default deshabilitado) ---
await upsertAgentConfig(db, ORG_A, {
  enabled: true,
  handoffKeywords: ["humano", "asesor", "recepcion"],
  maxTurns: 10,
  // La voz de la clínica y una indicación por función: lo que se ve en Agente › Sofi.
  personaName: "Sofi",
  treatment: "tu",
  tone: "cercano",
  about: "Clínica dental familiar con dos sedes. Atendemos sin apuro y explicamos cada tratamiento antes de empezar.",
  functionNotes: { agendar: "Ofrece primero los horarios de la mañana; las tardes se llenan rápido." },
})

// --- Derivaciones del agente: cola con plazo visible y caso ya tomado ---
const carlosTopic = await createHandoff(db, ORG_A, null, {
  conversationId: convCarlos.id,
  reason: "Pregunta por precio de extracción y pide hablar con una persona",
  summary:
    "Carlos consultó el costo de una extracción de muela del juicio; Sofi no da precios inventados y derivó con prioridad alta.",
  priority: "alta",
  createdBy: "agent",
  kind: "precio",
})
// El agente no se calla (ADR 0050): responde lo que sabe y anota cuando vuelve a preguntar por el tema.
await seedMessage({
  orgId: ORG_A,
  conversationId: convCarlos.id,
  direction: "out",
  senderKind: "agent",
  body: "Eso lo ve el equipo de Dental Smile: te escriben hoy antes de las 19:00.",
  externalId: "seed-msg-8a",
  status: "read",
  createdAt: new Date(hoursAgo(6).getTime() + 60_000),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convCarlos.id,
  direction: "in",
  senderKind: "contact",
  body: "¿Atienden los sábados?",
  externalId: "seed-msg-8b",
  status: "received",
  createdAt: hoursAgo(5),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convCarlos.id,
  direction: "out",
  senderKind: "agent",
  body: "Sí, los sábados atendemos de 9:00 a 13:00.",
  externalId: "seed-msg-8c",
  status: "read",
  createdAt: new Date(hoursAgo(5).getTime() + 60_000),
})
const carlosAgain = await seedMessage({
  orgId: ORG_A,
  conversationId: convCarlos.id,
  direction: "in",
  senderKind: "contact",
  body: "¿Y lo del precio de la extracción?",
  externalId: "seed-msg-8d",
  status: "received",
  createdAt: hoursAgo(3),
})
await recordTopicAskedAgain(db, ORG_A, { handoffId: carlosTopic.id, messageId: carlosAgain.id })
await createHandoff(db, ORG_A, null, {
  conversationId: convJorge.id,
  reason: "Jorge se mostró molesto por la espera",
  summary: "Jorge reportó demora en la atención anterior; se derivó a recepción para seguimiento.",
  priority: "media",
  assigneeUserId: LUIS_ID,
  createdBy: "agent",
})

// R3 del pulido de la Bandeja: un pago le llega a caja (Paula), que lo responde desde Inicio.
const convAndres = await seedConversation({
  orgId: ORG_A,
  contactId: contactIdByName.get("Andrés Vega")!,
  connectionId: connA.id,
  thread: "seed-thread-andres",
  unreadCount: 1,
  lastInboundAt: hoursAgo(1),
  lastOutboundAt: new Date(hoursAgo(1).getTime() + 60_000),
  lastMessageAt: new Date(hoursAgo(1).getTime() + 60_000),
})
const andresAsked = await seedMessage({
  orgId: ORG_A,
  conversationId: convAndres.id,
  direction: "in",
  senderKind: "contact",
  body: "Ya les transferí S/ 180 por la limpieza, ¿les llegó?",
  externalId: "seed-msg-andres-1",
  status: "received",
  createdAt: hoursAgo(1),
})
await createHandoff(db, ORG_A, null, {
  conversationId: convAndres.id,
  reason: "Pregunta si llegó su transferencia",
  summary: "Escribió: «Ya les transferí S/ 180 por la limpieza, ¿les llegó?»",
  priority: "media",
  createdBy: "agent",
  kind: "pago",
  sourceMessageId: andresAsked.id,
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convAndres.id,
  direction: "out",
  senderKind: "agent",
  body: "Eso lo revisa caja de Dental Smile: te confirman hoy.",
  externalId: "seed-msg-andres-2",
  status: "read",
  createdAt: new Date(hoursAgo(1).getTime() + 60_000),
})

// R1: Ana respondió a Patricia pasadas las 24 horas. La respuesta queda «Por
// entregar» y salió «Ver respuesta»; el tema ya está resuelto (decisión 4).
const convPatricia = await seedConversation({
  orgId: ORG_A,
  contactId: contactIdByName.get("Patricia León")!,
  connectionId: connA.id,
  thread: "seed-thread-patricia",
  lastInboundAt: hoursAgo(30),
  lastOutboundAt: new Date(hoursAgo(2).getTime() + 60_000),
  lastMessageAt: new Date(hoursAgo(2).getTime() + 60_000),
})
const patriciaAsked = await seedMessage({
  orgId: ORG_A,
  conversationId: convPatricia.id,
  direction: "in",
  senderKind: "contact",
  body: "¿La limpieza incluye la aplicación de flúor?",
  externalId: "seed-msg-patricia-1",
  status: "read",
  createdAt: hoursAgo(30),
})
const patriciaTopic = await createHandoff(db, ORG_A, null, {
  conversationId: convPatricia.id,
  reason: "Pregunta si la limpieza incluye flúor",
  summary: "Escribió: «¿La limpieza incluye la aplicación de flúor?»",
  priority: "baja",
  createdBy: "agent",
  sourceMessageId: patriciaAsked.id,
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convPatricia.id,
  direction: "out",
  senderKind: "agent",
  body: "Eso te lo confirma el equipo de Dental Smile.",
  externalId: "seed-msg-patricia-2",
  status: "read",
  createdAt: new Date(hoursAgo(30).getTime() + 60_000),
})
await claimHandoff(db, ORG_A, ANA_ID, patriciaTopic.id)
await seedMessage({
  orgId: ORG_A,
  conversationId: convPatricia.id,
  direction: "out",
  senderKind: "user",
  senderUserId: ANA_ID,
  body: "Sí, Patricia: la limpieza incluye la aplicación de flúor, sin costo adicional.",
  externalId: "seed-msg-patricia-3",
  status: "held",
  held: true,
  replyToMessageId: patriciaAsked.id,
  createdAt: hoursAgo(2),
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convPatricia.id,
  direction: "out",
  senderKind: "agent",
  contentType: "template",
  body: "Hola, Patricia. Dental Smile respondió tu consulta. Toca «Ver respuesta» para leerla.",
  templateName: ANSWER_READY_MESSAGE.template,
  replyButtons: [{ id: replyId("ver_respuesta", convPatricia.id), title: "Ver respuesta" }],
  externalId: "seed-msg-patricia-4",
  status: "delivered",
  createdAt: new Date(hoursAgo(2).getTime() + 60_000),
})
if (patriciaTopic.taskId) await updateTask(db, ORG_A, patriciaTopic.taskId, { status: "done", actorUserId: ANA_ID })

// Tablero 4b: Lucía escribió por Instagram hace más de un día y nadie le
// respondió. Instagram ya no deja escribirle; tiene su WhatsApp marcado, así
// que la Bandeja ofrece «Escribirle por WhatsApp». Nada se envía.
const igConnection = await createConnection(
  db,
  ORG_A,
  secretsKey,
  {
    channel: "instagram",
    provider: "instagram",
    displayName: "Instagram Dental Smile",
    config: { instagramId: "seed-ig", accessToken: "seed-dev", appSecret: "seed-dev" },
  },
  { fetch, validateExternal: false },
)
await db.insert(contactIdentity).values({
  organizationId: ORG_A,
  contactId: contactIdByName.get("Lucía Fernández")!,
  channel: "instagram",
  externalUserId: "ig:lucia.fernandez",
  displayName: "Lucía Fernández",
})
const convLuciaIg = await seedConversation({
  orgId: ORG_A,
  contactId: contactIdByName.get("Lucía Fernández")!,
  connectionId: igConnection.id,
  thread: "ig:lucia.fernandez",
  unreadCount: 1,
  lastInboundAt: hoursAgo(28),
  lastMessageAt: new Date(hoursAgo(28).getTime() + 60_000),
})
const luciaIgAsked = await seedMessage({
  orgId: ORG_A,
  conversationId: convLuciaIg.id,
  direction: "in",
  senderKind: "contact",
  body: "Hola, ¿hacen descuento en el blanqueamiento si vamos dos?",
  externalId: "seed-ig-lucia-1",
  status: "received",
  createdAt: hoursAgo(28),
})
await createHandoff(db, ORG_A, null, {
  conversationId: convLuciaIg.id,
  reason: "Pide descuento en el blanqueamiento para dos",
  summary: "Escribió: «Hola, ¿hacen descuento en el blanqueamiento si vamos dos?»",
  priority: "media",
  assigneeUserId: ANA_ID,
  createdBy: "agent",
  sourceMessageId: luciaIgAsked.id,
})
await seedMessage({
  orgId: ORG_A,
  conversationId: convLuciaIg.id,
  direction: "out",
  senderKind: "agent",
  body: "Eso lo ve el equipo de Dental Smile: te escriben por aquí.",
  externalId: "seed-ig-lucia-2",
  status: "read",
  createdAt: new Date(hoursAgo(28).getTime() + 60_000),
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
  const [given, ...surnames] = p.name.split(" ")
  const rosa = p.name === "Rosa Quispe"
  const row = await createPatient(db, ORG_A, ANA_ID, {
    displayName: p.name,
    givenNames: given,
    familyName: surnames.join(" "),
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
          // HL7 MaritalStatus y CINE 2011 (decisión 28): casada, universitaria.
          maritalStatus: "M",
          educationLevel: "6",
          occupation: "Docente",
          birthCountry: "PE",
          birthPlace: "Cusco",
          // Dirección internacional con lo de Perú: departamento de la lista
          // (ISO 3166-2:PE), provincia, distrito y referencia.
          address: "Jr. Las Begonias 120, dpto. 302",
          addressCity: "Miraflores",
          addressDistrict: "Lima",
          addressRegion: "PE-LMA",
          addressReference: "Frente al parque Kennedy",
          emergencyContactName: "Carlos Paredes",
          emergencyContactRelationship: "SPS",
          emergencyContactPhone: "+51912345678",
          // EPS: régimen con nombre propio en Perú, de tipo general «Privado».
          insuranceType: "PRIVADO",
          insuranceScheme: "EPS",
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
  familyHistory: [{ relationship: "MTH", condition: "Hipertensión arterial" }],
  asaClass: "II",
  conditions: [
    { name: "Hipertensión arterial", status: "activa", notes: "Controlada con medicación" },
  ],
  // Con su DCI de la lista (queda con su ATC), la dosis con número y unidad y la frecuencia de la lista.
  medications: [
    { name: "Cozaar", genericName: "losartán", doseValue: 50, doseUnit: "mg", frequencyCode: "cada_24_h" },
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
      doseValue: m.doseValue ? Number(m.doseValue) : null,
      doseUnit: m.doseUnit,
      frequency: m.frequency,
      frequencyCode: m.frequencyCode,
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
// Alergias de Rosa como en el tablero 7: «Penicilina» ya quedó con su grupo
// ATC; el látex lo declaró ella en su formulario; «amoxi» quedó escrita a mano
// (sin codificar, para «Elegir de la lista»); el ibuprofeno se quitó porque
// «era otra cosa». La última revisión fue hace 8 meses: la atención pide
// preguntarle por alergias nuevas.
await addDeclaredAllergies(db, ORG_A, ANA_ID, rosaPatientId, [{ substance: "Látex", reaction: "Ronchas con los guantes" }], {
  entity: "seed",
  entityId: "seed-rosa-alergias",
})
await addPatientAllergy(db, ORG_A, ANA_ID, rosaPatientId, { substance: "amoxi", severity: "moderada" })
const rosaIbuprofen = await addPatientAllergy(db, ORG_A, ANA_ID, rosaPatientId, {
  substance: "Ibuprofeno",
  severity: "leve",
  reaction: "Le cae mal al estómago",
})
await removePatientAllergy(db, ORG_A, ANA_ID, rosaPatientId, rosaIbuprofen.id, "otra_cosa")
await db
  .update(patient)
  .set({ allergiesReviewedAt: sql`now() - interval '8 months'`, allergiesReviewedBy: ANA_ID })
  .where(eq(patient.id, rosaPatientId))
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
  /** Qué deja en la pieza al completarse: lo tratado queda dibujado (fase 3, paso 5). */
  leavesFinding?: { condition: string; variant?: string }
  /** En Perú cada servicio lleva su código CPMS, también el propio (ADR 0069). */
  officialCode: string
}> = [
  {
    code: "EVALUACION",
    officialCode: "D0150",
    name: "Evaluación odontológica",
    specialty: "diagnostico",
    scope: "general",
    priceCents: 5000,
    durationMin: 30,
    priceDisclosure: "exacto",
  },
  {
    code: "OBTURACION",
    officialCode: "D2385",
    name: "Obturación con resina",
    specialty: "restauradora",
    scope: "tooth",
    priceCents: 18000,
    durationMin: 45,
    priceDisclosure: "exacto",
  },
  {
    code: "ENDODONCIA",
    officialCode: "D3310",
    name: "Endodoncia unirradicular",
    specialty: "endodoncia",
    scope: "tooth",
    priceCents: 45000,
    durationMin: 90,
    priceDisclosure: "desde",
    leavesFinding: { condition: "root_canal_treatment", variant: "root_canal" },
  },
  {
    code: "CORONA",
    officialCode: "D2740",
    name: "Corona cerámica",
    specialty: "protesis",
    scope: "tooth",
    priceCents: 90000,
    durationMin: 60,
    priceDisclosure: "evaluacion",
    leavesFinding: { condition: "crown", variant: "metal_free" },
  },
  {
    code: "BLANQUEAMIENTO",
    officialCode: "D9972",
    name: "Blanqueamiento dental",
    specialty: "estetica",
    scope: "arch",
    priceCents: 60000,
    durationMin: 60,
    priceDisclosure: "exacto",
  },
  {
    code: "LIMPIEZA",
    officialCode: "D1110",
    name: "Limpieza dental (profilaxis)",
    specialty: "prevencion",
    scope: "general",
    priceCents: 12000,
    durationMin: 45,
    priceDisclosure: "exacto",
  },
  {
    code: "ORTODONCIA_CTRL",
    officialCode: "D8670",
    name: "Control de ortodoncia",
    specialty: "ortodoncia",
    scope: "general",
    priceCents: 10000,
    durationMin: 30,
    billingMode: "session",
    priceDisclosure: "exacto",
  },
  // La exodoncia pide sus consentimientos («Se pide para», fase 3 paso 2B).
  {
    code: "EXODONCIA",
    officialCode: "D7176",
    name: "Exodoncia simple",
    specialty: "cirugia",
    scope: "tooth",
    priceCents: 15000,
    durationMin: 45,
    priceDisclosure: "desde",
    // La causa (DEX o DAO) se deduce al completarla, por lo que la motivó.
    leavesFinding: { condition: "missing_tooth" },
  },
]
// Cada clínica nace con las especialidades de su país (ADR 0039 y 0069): el
// servicio apunta a la suya por id. Aquí se buscan por el tipo que reciben.
const specialtiesA = await librarySpecialtyIds(db, ORG_A, TREATMENT_KIND_KEYS)
const specialtiesB = await librarySpecialtyIds(db, ORG_B, TREATMENT_KIND_KEYS)
const catalogA: Array<Awaited<ReturnType<typeof createService>>> = []
for (const { specialty, ...offer } of seedOffers) {
  catalogA.push(await createService(db, ORG_A, ANA_ID, { ...offer, specialtyId: specialtiesA.get(specialty) }))
  await createService(db, ORG_B, CORA_ID, { ...offer, specialtyId: specialtiesB.get(specialty) })
}
// Implantología sin nadie que la atienda (decisión 2 de la fase 4): la agenda
// ofrece el implante a cualquiera y Especialidades lo avisa con «Elegir quién atiende».
catalogA.push(
  await createService(db, ORG_A, ANA_ID, {
    code: "IMPLANTE",
    officialCode: "D6010",
    name: "Implante dental de titanio",
    specialtyId: specialtiesA.get("implantologia"),
    scope: "tooth",
    priceCents: 250000,
    durationMin: 90,
    priceDisclosure: "evaluacion",
  }),
)
const serviceIdA = (code: string): string => {
  const found = catalogA.find((s) => s.code === code)
  if (!found) throw new Error(`Servicio ${code} ausente del catálogo semilla`)
  return found.id
}
// Lo que no se dice con precio exacto ofrece la evaluación de la clínica.
for (const code of ["ENDODONCIA", "CORONA", "EXODONCIA"]) {
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
// De la biblioteca: la resina posterior de una superficie (en Perú, CPMS
// D2391). El mismo snapshot se conserva en plan, presupuesto y atención.
const [resinaTemplate] = await db
  .select()
  .from(treatmentTemplate)
  .where(eq(treatmentTemplate.key, "resina-fotocurable-1-superficie-posterior"))
  .limit(1)
if (!resinaTemplate) throw new Error("Falta la resina posterior de la biblioteca: ejecuta seed:procedures")
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
// Consultas de la biblioteca en el tarifario: la consulta también es una
// prestación con tarifa (CPMS D0140); el control postoperatorio va incluido
// (CPMS D0171 a S/ 0).
const consultaTemplates = await db
  .select()
  .from(treatmentTemplate)
  .where(inArray(treatmentTemplate.key, ["consulta-odontologica-general", "reevaluacion-postoperatoria"]))
if (consultaTemplates.length !== 2) {
  throw new Error("Faltan las consultas de la biblioteca: ejecuta seed:procedures")
}
for (const tpl of consultaTemplates) {
  const isControl = tpl.key === "reevaluacion-postoperatoria"
  const offer = {
    templateId: tpl.id,
    code: isControl ? "CONTROL-POSTOP" : "CONSULTA",
    priceCents: isControl ? 0 : 8000,
    durationMin: 30,
  }
  catalogA.push(await createService(db, ORG_A, ANA_ID, offer))
  await createService(db, ORG_B, CORA_ID, offer)
}
// Un tarifario de clínica mediana en Dental Smile (fase 4, tablero 1): más de
// 100 servicios activos, muchos más de los 40 que caben en el prompt, para ver
// el índice por especialidad, la búsqueda y el cambio en bloque de «Cómo dice
// el precio». Las tres formas, por tercios; precios y duraciones deterministas.
const libraryForSeed = await db
  .select({ id: treatmentTemplate.id })
  .from(treatmentTemplate)
  // Dental Smile es del Perú: sin las variantes que solo separa la norma de otro
  // país (`coded_only`), que aquí no tienen código CPMS y no se ofrecen.
  .where(and(eq(treatmentTemplate.isActive, true), eq(treatmentTemplate.codedOnly, false)))
  // Primero los «más usados», como los agregaría una clínica (tablero 7b).
  .orderBy(desc(treatmentTemplate.isCommon), asc(treatmentTemplate.key))
  .limit(140)
const ownedTemplates = new Set(catalogA.map((service) => service.templateId).filter(Boolean))
const extraTemplates = libraryForSeed.filter((row) => !ownedTemplates.has(row.id)).slice(0, 96)
if (extraTemplates.length < 90) throw new Error("La biblioteca tiene pocas prestaciones: ejecuta seed:procedures")
for (const [index, priceDisclosure] of (["exacto", "desde", "evaluacion"] as const).entries()) {
  const items = extraTemplates
    .filter((_, position) => position % 3 === index)
    .map((row, position) => ({
      kind: "template" as const,
      templateId: row.id,
      priceCents: (6 + ((position * 7 + index * 5) % 60)) * 1000,
      durationMin: 30 + (position % 4) * 15,
    }))
  catalogA.push(...(await quickAddServices(db, ORG_A, ANA_ID, items, { priceDisclosure })).created)
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
  encounterId: draft.id,
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
// Diagnósticos de la atención (ADR 0003 y 0041): en la lista de la clínica (CIE-10), con tipo y sitio dental.
await addEncounterDiagnosis(db, ORG_A, ANA_ID, rosaPatientId, draft.id, {
  diagnosisCode: "K02.1",
  diagnosisType: "confirmed",
  toothNumber: 36,
  surfaces: ["occlusal"],
  note: "Dolor a la percusión; caries en dentina.",
})
await addEncounterDiagnosis(db, ORG_A, ANA_ID, rosaPatientId, draft.id, {
  diagnosisCode: "K04.0",
  diagnosisType: "provisional",
  toothNumber: 46,
})
// Un diagnóstico mal registrado se anula con motivo; queda en la traza.
const dxErrado = await addEncounterDiagnosis(db, ORG_A, ANA_ID, rosaPatientId, draft.id, {
  diagnosisCode: "K02.1",
  diagnosisType: "provisional",
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
// La misma periapical en cada compresión que lee el visor DICOM (JPEG, JPEG-LS,
// JPEG 2000, RLE, Big Endian y varios cuadros); las genera
// `packages/clinical/samples/dicom/generate.py`. Son muestras, no se informan.
{
  const require = createRequire(import.meta.url)
  for (const sample of DICOM_SAMPLES) {
    if (sample.transferSyntax === "1.2.840.10008.1.2.1") continue // ya está la del sensor
    const bytes = new Uint8Array(
      readFileSync(require.resolve(`@odentia/clinical/samples/dicom/${sample.file}`)),
    )
    const ref = await storage.putPatientDocument({
      orgId: ORG_A,
      patientId: rosaPatientId,
      bytes,
      contentType: "application/dicom",
      ext: "dcm",
    })
    await registerPatientDocument(db, ORG_A, ANA_ID, rosaPatientId, {
      category: "radiografia",
      label: `[DEMO] Periapical en ${sample.name} (DICOM)`,
      storageKey: ref.objectKey,
      contentType: "application/dicom",
      sizeBytes: ref.size,
      imageType: "periapical",
      capturedAt: new Date(Date.now() - 400 * 86_400_000),
      source: "Muestra de formatos DICOM",
      reportStatus: "no_requiere",
      toothNumbers: [36],
    })
  }
}
// Tomografía de demostración (un fantoma sintético, no es de un paciente) para
// el visor de tomografía: la serie CT entra por el mismo camino que la de un CD
// (ADR 0055). Lleva el nombre de Rosa para que no salte el aviso de nombre.
{
  const phantom = generateCbctPhantom()
  const root = "2.25.3400000000000000000034"
  const studyUid = `${root}.1`
  const seriesUid = `${root}.2`
  const slices = phantom.data.map((pixels, k) =>
    encodeDemoCtSlice({
      width: phantom.size,
      height: phantom.size,
      pixels,
      voxelMm: phantom.voxelMm,
      position: [phantom.origin[0], phantom.origin[1], phantom.sliceZ[k]!],
      instanceNumber: k + 1,
      studyUid,
      seriesUid,
      frameOfReferenceUid: `${root}.3`,
      sopUid: `${root}.4.${k + 1}`,
      patientName: "QUISPE^ROSA",
    }),
  )
  const started = await startImagingStudyUpload(db, ORG_A, ANA_ID, rosaPatientId, {
    label: "[DEMO] Tomografía (CBCT) · Centro de imágenes de demostración",
    studyInstanceUid: studyUid,
    dicomPatientName: "QUISPE^ROSA",
    modality: "CT",
    capturedAt: new Date(Date.now() - 20 * 86_400_000),
    source: "Centro de imágenes de demostración",
    toothNumbers: [36, 37],
    sliceCount: slices.length,
    voxelMm: phantom.voxelMm,
    files: slices.map((bytes, k) => ({
      sopInstanceUid: `${root}.4.${k + 1}`,
      seriesInstanceUid: seriesUid,
      sizeBytes: bytes.byteLength,
    })),
  })
  const documentId = started.document.id
  const pending = await pendingImagingFiles(db, ORG_A, rosaPatientId, documentId)
  for (const file of pending) {
    await storage.putAttachmentAt?.(file.storageKey, slices[file.index]!, "application/dicom")
  }
  await markImagingFilesUploaded(
    db,
    ORG_A,
    ANA_ID,
    rosaPatientId,
    documentId,
    pending.map((file) => file.index),
  )
  // Miniatura: el corte a la altura de las raíces inferiores, con ventana de hueso.
  const k = phantom.sliceZ.findIndex((z) => z >= -18)
  const gray = Buffer.from(
    Array.from(phantom.data[k]!, (stored) =>
      Math.max(0, Math.min(255, Math.round(((stored - 1000 - 699.5) / 2999 + 0.5) * 255))),
    ),
  )
  const thumb = await sharp(gray, { raw: { width: phantom.size, height: phantom.size, channels: 1 } })
    .resize(320)
    .webp()
    .toBuffer()
  const thumbRef = await storage.putPatientDocument({
    orgId: ORG_A,
    patientId: rosaPatientId,
    bytes: thumb,
    contentType: "image/webp",
    ext: "webp",
  })
  await setImagingThumbnail(db, ORG_A, rosaPatientId, documentId, thumbRef.objectKey)
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
// Un informe suelto en PDF: no es imagen ni consentimiento, así que Documentos
// lo muestra en «Otros archivos» y lo abre en el mismo visor (issue 149).
{
  const pdf = await PDFDocument.create()
  const sheet = pdf.addPage([595, 842])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  sheet.drawText("Informe de laboratorio (demostración)", { x: 56, y: 770, size: 16, font })
  sheet.drawText("Hemograma y coagulación previos a la exodoncia: dentro de rangos.", {
    x: 56,
    y: 740,
    size: 11,
    font,
  })
  const bytes = Buffer.from(await pdf.save())
  const ref = await storage.putPatientDocument({
    orgId: ORG_A,
    patientId: rosaPatientId,
    bytes,
    contentType: "application/pdf",
    ext: "pdf",
  })
  await registerPatientDocument(db, ORG_A, ANA_ID, rosaPatientId, {
    category: "informe",
    label: "[DEMO] Informe de laboratorio previo a la exodoncia",
    storageKey: ref.objectKey,
    contentType: ref.mimeType,
    sizeBytes: bytes.byteLength,
    source: "Laboratorio de demostración",
  })
}
// Cierre con datos útiles: evolución e indicaciones. Lo que sigue lo dice el plan.
await updateEncounterDraft(db, ORG_A, ANA_ID, rosaPatientId, draft.id, {
  evolution: "Obturación de pieza 36 sin complicaciones; endodoncia de 46 programada.",
  indications: "Higiene con cepillo suave, control en 7 días; acudir si hay dolor.",
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
// El cierre de su evaluación firmó solo el odontograma «Inicio del plan de
// tratamiento» (clínica de Perú, NTS 188); el botón «Firmar odontograma» queda
// para lo judicial, lo personal y el reingreso: Rosa pidió una copia firmada.
if ((cierreRosa.odontogram as DentalFinalizeParts["odontogram"])?.purpose !== "initial")
  throw new Error("El cierre de Rosa debía firmar el odontograma de inicio del plan")
await createOdontogramAssessment(db, ORG_A, ANA_ID, rosaPatientId, {
  purpose: "personal",
  observations: "Copia firmada que pidió la paciente para su seguro.",
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
// Dos opciones en un mismo presupuesto (decisión 13): la 46 se arregla con una
// resina o con una corona, y Rosa elige una. La B nace como copia de la A y se
// cambia lo que hace falta; cada una con su total, nunca sumadas. Queda enviado,
// esperando que elija.
const resinaOpcion46 = await addPlanItem(db, ORG_A, ANA_ID, rosaPatientId, {
  serviceId: serviceIdA("OBTURACION"),
  planId: planRestaurador.id,
  sourceEncounterId: evaluacion46.id,
  toothNumber: 46,
  detail: "Restauración con resina pieza 46",
})
const coronaOpcion46 = await addPlanItem(db, ORG_A, ANA_ID, rosaPatientId, {
  serviceId: serviceIdA("CORONA"),
  planId: planRestaurador.id,
  sourceEncounterId: evaluacion46.id,
  toothNumber: 46,
  detail: "Corona cerámica pieza 46",
})
const opciones46 = await createBudget(db, ORG_A, ANA_ID, rosaPatientId, {
  planId: planRestaurador.id,
  itemIds: [resinaOpcion46.id],
  title: "Restauración definitiva pieza 46",
  notes: "Dos caminos para la 46: elige uno.",
})
const conCorona = await duplicateBudgetOption(db, ORG_A, ANA_ID, rosaPatientId, opciones46.id, opciones46.options[0]!.id)
const opcionB = conCorona.options[1]!.id
await removeBudgetItems(db, ORG_A, ANA_ID, rosaPatientId, opciones46.id, {
  itemIds: [resinaOpcion46.id],
  optionId: opcionB,
})
await addBudgetItems(db, ORG_A, ANA_ID, rosaPatientId, opciones46.id, {
  itemIds: [coronaOpcion46.id],
  optionId: opcionB,
})
await deliverBudget(db, ORG_A, ANA_ID, rosaPatientId, opciones46.id)

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
// Se emitió pese al aviso de alergia, con su motivo, y se anula: queda la traza.
const recetaAnulada = await createPrescription(db, ORG_A, ANA_ID, rosaPatientId, {
  acknowledgeAllergies: true,
  allergyOverrideReason: "Dijo que la tolera; se revisará con ella",
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
  diagnosisCode: "Z01.2",
  diagnosisType: "confirmed",
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
// Ningún borrador queda abandonado (decisión 12): el de Elena quedó armado ayer
// y nadie lo envió, así que hoy le sale a recepción en «Te espera».
await db.update(treatmentBudget).set({ createdAt: daysAgo(1) }).where(eq(treatmentBudget.id, elenaBudget.id))
// «Armado» es cuando entró su último tratamiento: también ayer.
await db.update(treatmentBudgetItem).set({ createdAt: daysAgo(1) }).where(eq(treatmentBudgetItem.budgetId, elenaBudget.id))

// Lucía (tablero 3): la Dra. Ana encontró caries en la 16, la 26 y la 36 e
// indicó una resina en cada una, S/ 180 por pieza. Al firmar la evaluación
// quedó armado el presupuesto; se le envió y respondió «la 16 y la 26 ahora, la
// 36 después» (Aceptó 2 de 3). Lo aceptado se agendó en su cita de hoy, que lo
// trae a la atención.
const luciaPatientId = patientIdByName.get("Lucía Fernández")!
// Su Historia (tablero 1, ADR 0035) muestra también una atención anulada con su
// motivo y la radiografía que se pidió en la evaluación, como hechos.
const luciaPorError = await createEncounter(db, ORG_A, ANA_ID, luciaPatientId, {
  reason: "Consulta",
  branchId: miraflores.id,
})
await voidEncounter(db, ORG_A, ANA_ID, luciaPatientId, luciaPorError.id, { reason: "Abierta por error" })
const luciaEval = await createEncounter(db, ORG_A, ANA_ID, luciaPatientId, {
  reason: "Evaluación: molestia al masticar",
  branchId: miraflores.id,
})
// Panel de la pieza (tablero 4): hallazgo, su CIE-10 (que es el diagnóstico de
// la atención) y la resina, que va a su plan abierto, en un solo paso por pieza.
const luciaResinas: Record<number, string> = {}
for (const tooth of [16, 26, 36]) {
  const panel = await registerToothFinding(db, ORG_A, ANA_ID, luciaPatientId, {
    encounterId: luciaEval.id,
    toothNumbers: [tooth],
    condition: "caries",
    surfaces: ["occlusal"],
    details: { variant: "dentin" },
    diagnosis: { diagnosisCode: "K02.1", diagnosisType: "confirmed" },
    treatment: { serviceId: resinaCpmsA.id },
  })
  luciaResinas[tooth] = panel.planItems[0]!.id
}
await updateEncounterDraft(db, ORG_A, ANA_ID, luciaPatientId, luciaEval.id, {
  evolution: "Caries oclusal en 16, 26 y 36; se indican resinas.",
})
await createClinicalOrder(db, ORG_A, ANA_ID, {
  kind: "imagen",
  patientId: luciaPatientId,
  encounterId: luciaEval.id,
  title: "Radiografía panorámica",
  recipient: "Centro de imágenes",
  diagnosisCode: "K02.1",
})
const cierreLucia = await finalizeEncounter(db, ORG_A, ANA_ID, luciaPatientId, luciaEval.id)
if (!cierreLucia.budget) throw new Error("La evaluación de Lucía debía dejar armado su presupuesto")
// Al firmar, el odontograma quedó firmado como «Inicio del plan de tratamiento».
if ((cierreLucia.odontogram as DentalFinalizeParts["odontogram"])?.purpose !== "initial")
  throw new Error("La evaluación de Lucía debía firmar el odontograma de inicio del plan")
await deliverBudget(db, ORG_A, ANA_ID, luciaPatientId, cierreLucia.budget.id)
await decideBudget(db, ORG_A, ANA_ID, luciaPatientId, cierreLucia.budget.id, {
  decisions: [
    { planItemId: luciaResinas[16]!, decision: "aceptado" },
    { planItemId: luciaResinas[26]!, decision: "aceptado" },
    { planItemId: luciaResinas[36]!, decision: "pospuesto" },
  ],
  decisionNote: "Respondió por WhatsApp: la 16 y la 26 ahora, la 36 después.",
})

// Periodontograma (issue 49): Carlos Paredes, con la visita inicial y la
// reevaluación tras el raspado, como en el lienzo (tableros 4 y 11).
await seedPeriodontalCase(db, {
  orgId: ORG_A,
  professionalUserId: ANA_ID,
  patientId: patientIdByName.get("Carlos Paredes")!,
  branchId: miraflores.id,
  daysAgo,
})

// --- Volumen para paginación: 40 contactos+pacientes ---
for (let i = 1; i <= 40; i++) {
  const n = String(i).padStart(2, "0")
  const created = await createContact(db, ORG_A, {
    displayName: `Paciente Demo ${n}`,
  })
  await createPatient(db, ORG_A, ANA_ID, {
    displayName: `Paciente Demo ${n}`,
    contacts: [{ contactId: created.id, relationship: "self", isPreferred: true }],
    phone: `+519000000${n}`,
  })
}

// --- «Nueva conversación» y «Reservar cita» desde «Contexto» (ADR 0027): alguien
// que recepción anotó por teléfono, todavía sin WhatsApp ni ficha de paciente.
const carmen = await createContact(db, ORG_A, { displayName: "Carmen Huamán", phone: "+51987654100" })

// --- Una persona, una página (ADR 0029): Carmen está «Por registrar» y tiene
// una nota de recepción; Martín Salas no es paciente, es el responsable de su
// hija Sofía (menor), que sí lo es: su página dice «Responsable de Sofía Salas»
// y la de ella, «Habla por ella: Martín Salas».
await createContactNote(db, ORG_A, carmen.id, { body: "Llamó para preguntar por blanqueamiento; prefiere la tarde." }, { userId: ANA_ID })

// --- Lo repetido: personas, citas y dinero (fase 4, paso 7b-2) ---
// Carmen Huamán tiene su teléfono en «Teléfono», pero nadie lo marcó como su
// WhatsApp (decisión 23, caso 2): su página dice «Aún no es su WhatsApp» con
// «Usarlo como su WhatsApp». Rosa Quispe debe S/ 50 y tiene S/ 30 a favor del
// adelanto que se le devolvió en parte (decisión 22): «Saldo: S/ 20» y, en
// Caja, «Aplicar lo que tiene a favor» deja ver lo que falta. El presupuesto
// «Restauración definitiva pieza 46» tiene dos opciones: Reportes cuenta la
// recomendada, nunca la suma (G1).
// Una madre registra a sus dos hijos con su mismo DNI: es la misma persona,
// representante legal de los dos (G2).
const hijoVargas = (displayName: string, givenNames: string, birthDate: string, docNumber: string) =>
  db.transaction((tx) =>
    registerPatient(
      tx,
      ORG_A,
      { kind: "internal", userId: ANA_ID },
      {
        submissionId: randomUUID(),
        answers: {
          demographics: { displayName, givenNames, familyName: "Vargas", birthDate, docType: "DNI", docNumber },
          respondent: "representative",
          representative: {
            displayName: "Gabriela Vargas Soto",
            relationship: "guardian",
            relationshipDetail: "Madre",
            phone: "+51987650500",
            docType: "DNI",
            docNumber: "45123987",
          },
          privacyAccepted: false,
        },
      },
    ),
  )
await hijoVargas("Thiago Vargas", "Thiago", "2015-03-10", "78123401")
await hijoVargas("Valeria Vargas", "Valeria", "2019-08-22", "78123402")
// Buscador rápido (ADR 0066): «maria» trae a varias Marías, cada una con lo
// suyo; madre e hija comparten el 987 111 222 y aparecen las dos; «bruxismo»
// encuentra la atención de una de ellas (solo para quien ve la historia).
const mariaPaz = await createPatient(db, ORG_A, ANA_ID, {
  displayName: "María Luisa Paz",
  givenNames: "María Luisa",
  familyName: "Paz",
  birthDate: "1991-05-14",
  phone: "+51987111222",
  registeredBranchId: miraflores.id,
})
await createPatient(db, ORG_A, ANA_ID, {
  displayName: "Lucía Paz",
  givenNames: "Lucía",
  familyName: "Paz",
  birthDate: "2016-09-02",
  phone: "+51987111222",
  registeredBranchId: miraflores.id,
})
await createPatient(db, ORG_A, ANA_ID, {
  displayName: "María Quispe Huamán",
  givenNames: "María",
  familyName: "Quispe Huamán",
  birthDate: "1964-01-20",
  registeredBranchId: miraflores.id,
})
await createEncounter(db, ORG_A, ANA_ID, mariaPaz.id, {
  reason: "Bruxismo nocturno: se indica placa de descarga",
  branchId: miraflores.id,
})
// Una ortodoncia que se cobra por sesión (12 controles de S/ 100), aceptada, con
// un adelanto de S/ 500 y una devolución de S/ 100: el portal dice los mismos
// montos que Caja (tratamiento aceptado S/ 1 200, pagado S/ 400). Su número no
// tiene WhatsApp: un mensaje rebotó (decisión 23, caso 1).
const marco = await createPatient(db, ORG_A, ANA_ID, {
  displayName: "Marco Torres",
  givenNames: "Marco",
  familyName: "Torres",
  birthDate: "1994-02-11",
  phone: "+51987650600",
  registeredBranchId: miraflores.id,
})
const marcoEval = await createEncounter(db, ORG_A, ANA_ID, marco.id, {
  reason: "Evaluación de ortodoncia",
  branchId: miraflores.id,
})
const marcoPlan = await createTreatmentPlan(db, ORG_A, ANA_ID, marco.id, {
  title: "Ortodoncia",
  originEncounterId: marcoEval.id,
})
const marcoCtrl = await addPlanItem(db, ORG_A, ANA_ID, marco.id, {
  serviceId: serviceIdA("ORTODONCIA_CTRL"),
  planId: marcoPlan.id,
  sourceEncounterId: marcoEval.id,
  detail: "Controles de ortodoncia",
})
const marcoBudget = await createBudget(db, ORG_A, ANA_ID, marco.id, {
  planId: marcoPlan.id,
  itemIds: [marcoCtrl.id],
  title: "Ortodoncia por sesiones",
})
await db.transaction((tx) =>
  adjustBudgetLines(tx, ORG_A, ANA_ID, marco.id, marcoBudget.id, {
    lines: [{ planItemId: marcoCtrl.id, sessionsPlanned: 12 }],
  }),
)
await deliverBudget(db, ORG_A, ANA_ID, marco.id, marcoBudget.id)
await decideBudget(db, ORG_A, ANA_ID, marco.id, marcoBudget.id, {
  decisions: [{ planItemId: marcoCtrl.id, decision: "aceptado" }],
})
await db.transaction(async (tx) => {
  const methods = await listPaymentMethods(tx, ORG_A)
  const cash = methods.find((method) => method.typeCode === "10")
  if (!cash) throw new Error("Falta el efectivo en los medios de pago de la clínica demo")
  await collectCharge(tx, ORG_A, ANA_ID, marco.id, {
    branchId: miraflores.id,
    advanceCents: 50000,
    requestId: "50206010-0000-4000-8000-000000000106",
    payments: [{ paymentMethodId: cash.id, amountCents: 50000 }],
  })
  await refundCredit(tx, ORG_A, ANA_ID, marco.id, {
    branchId: miraflores.id, amountCents: 10000, paymentMethodId: cash.id,
    reason: "Devolución de parte del adelanto: empieza el mes que viene.",
  })
})
const marcoPerson = await patientPersonId(db, ORG_A, marco.id)
if (marcoPerson) {
  await db.insert(contactIdentity).values({
    organizationId: ORG_A,
    contactId: marcoPerson,
    channel: "whatsapp",
    externalUserId: "wa:51987650600",
    isPrimary: true,
    noWhatsappAt: hoursAgo(20),
  })
}

// --- Org B mínima (aislamiento visual) ---
const sofia = await createContact(db, ORG_B, {
  displayName: "Sofía Ramos",
})
const hugo = await createContact(db, ORG_B, {
  displayName: "Hugo Díaz",
})
await createOpportunity(db, ORG_B, { contactId: sofia.id, title: "Ortodoncia" }, { userId: CORA_ID })
const hugoSale = await createOpportunity(db, ORG_B, { contactId: hugo.id, title: "Limpieza" }, { userId: CORA_ID })
await moveOpportunity(db, ORG_B, hugoSale.id, pipeB.stages.find((stage) => stage.moment === "evaluacion_agendada")!.id, { userId: CORA_ID })
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
      // Lo que pide una clínica típica (registro por el código QR): el
      // documento y el sexo cuentan para «Faltan datos»; se le pregunta su
      // salud, si está embarazada y si la han operado; nada censal ni de su
      // historia dental.
      docType: "required",
      docNumber: "required",
      sex: "required",
      email: "hidden",
      address: "hidden",
      bloodGroup: "hidden",
      "personal.embarazo": "optional",
      "personal.cirugias": "optional",
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
    purposes: ["atencion", "comunicaciones"],
    grantedByContactId: rosaContactId,
  }),
)
// Pedidos sobre sus datos (ADR 0080): Rosa pidió una copia de su historia por
// WhatsApp hace dos días (pendiente, sale en «Te espera» al acercarse el plazo)
// y antes había pedido corregir su dirección, ya respondido.
await db.transaction(async (tx) => {
  const today = await clinicToday(tx, ORG_A)
  await createDataRequest(tx, ORG_A, ANA_ID, rosaPatientId, {
    kind: "copia",
    requesterContactId: rosaContactId,
    channel: "whatsapp",
    requestedOn: addCalendarDays(today, -2),
    said: "Quiero una copia de mi historia, me cambio de clínica",
  })
  const fix = await createDataRequest(tx, ORG_A, ANA_ID, rosaPatientId, {
    kind: "corregir",
    requesterContactId: rosaContactId,
    channel: "clinica",
    requestedOn: addCalendarDays(today, -20),
    said: "Me mudé",
  })
  await verifyDataRequest(tx, ORG_A, ANA_ID, rosaPatientId, fix.id, { how: "documento" })
  await respondDataRequest(tx, ORG_A, ANA_ID, rosaPatientId, fix.id, {
    resolution: "Se cambió su dirección a Jr. Las Begonias 120, dpto. 302",
  })
})
// Historia bloqueada (ADR 0080, fase 2): Elena Huamán pidió en la clínica
// borrar sus datos. Lo no clínico se borró y su historia quedó bloqueada:
// solo Administración la ve, en Pacientes › Historias bloqueadas.
const elena = await createPatient(db, ORG_A, ANA_ID, {
  displayName: "Elena Huamán Ccori",
  givenNames: "Elena",
  familyName: "Huamán Ccori",
  docType: "DNI",
  docNumber: "41234567",
  birthDate: "1986-07-19",
  phone: "+51987650214",
  email: "elena.huaman@example.com",
})
await createContactNote(db, ORG_A, elena.personId, { body: "Prefiere que la llamen en la tarde." }, { userId: ANA_ID })
// Borrar usa `erase_person_data`, que solo actúa dentro de la clínica activa.
await withOrgContext(db, ORG_A, async (tx) => {
  const today = await clinicToday(tx, ORG_A)
  const request = await createDataRequest(tx, ORG_A, ANA_ID, elena.id, {
    kind: "borrar",
    requesterContactId: elena.personId,
    channel: "clinica",
    requestedOn: addCalendarDays(today, -3),
    said: "No quiero que guarden mis datos",
  })
  await verifyDataRequest(tx, ORG_A, ANA_ID, elena.id, request.id, { how: "documento" })
  await eraseForDataRequest(tx, ORG_A, ANA_ID, elena.id, request.id)
})
// --- Fase 2.1 (ADR 0030): Pedro Ríos llamó y recepción le dio cita desde la
// Agenda con lo mínimo (nombres, apellidos y teléfono), aunque el registro pide
// la fecha de nacimiento: su página dice lo que falta. Dijo por teléfono que
// acepta novedades y promociones, lo único que pide permiso.
const pedroRios = await db.transaction((tx) =>
  registerPatient(
    tx,
    ORG_A,
    { kind: "internal", userId: ANA_ID, scope: "essentials" },
    {
      submissionId: randomUUID(),
      answers: {
        demographics: { displayName: "Pedro Ríos", givenNames: "Pedro", familyName: "Ríos", phone: "+51987111222" },
        respondent: "staff",
        privacyAccepted: false,
      },
    },
  ),
)
const pedroRiosPerson = await patientPersonId(db, ORG_A, pedroRios.id)
if (pedroRiosPerson) {
  await setConsent(db, ORG_A, ANA_ID, pedroRiosPerson, { purpose: "novedades", granted: true, source: "telefono" })
}
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
          familyName: "Quispe",
          birthDate: "2016-05-20",
          // La clínica de la semilla también pide el sexo.
          sex: "M",
          // La clínica pide el documento: el DNI del menor.
          docType: "DNI",
          docNumber: "78901234",
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
          kinship: "MTH",
          isPreferred: true,
        },
      ],
    },
  ),
)
// Martín Salas (no es paciente) responde por su hija Sofía: la vista «Responsables».
const martin = await createContact(db, ORG_A, {
  displayName: "Martín Salas",
  givenNames: "Martín",
  familyName: "Salas",
  phone: "+51987650001",
})
await db.transaction((tx) =>
  registerPatient(
    tx,
    ORG_A,
    { kind: "internal", userId: ANA_ID, contactId: martin.id },
    {
      submissionId: randomUUID(),
      answers: {
        demographics: {
          displayName: "Sofía Salas",
          givenNames: "Sofía",
          familyName: "Salas",
          birthDate: "2017-08-12",
          sex: "F",
          docType: "DNI",
          docNumber: "79012345",
        },
        respondent: "representative",
        representative: {
          displayName: "Martín Salas",
          relationship: "guardian",
          relationshipDetail: "Padre",
          phone: "+51987650001",
          docType: "DNI",
          docNumber: "41234567",
        },
        privacyAccepted: false,
      },
      contacts: [
        { contactId: martin.id, relationship: "guardian", relationshipDetail: "Padre", kinship: "FTH", isPreferred: true },
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

// Su propio celular: quien se registra por el QR con el de alguien que ya
// está queda por confirmar en «Te espera», y Valeria es de otro hogar.
const VALERIA_PHONE = "+51987000920"
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
          givenNames: "Valeria",
          familyName: "Quispe · QR demo",
          birthDate: "1998-04-10",
          sex: "F",
          phone: VALERIA_PHONE,
          docType: "DNI",
          docNumber: "45678920",
        },
        respondent: "patient",
        privacyAccepted: true,
        // Sin grupo sanguíneo: la clínica de la semilla no lo pregunta.
        health: {
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
// «Te espera» de recepción con lo que deja el registro en línea cuando el
// documento ya es de alguien: Valeria registra a su hijo por el QR (su vínculo
// de «Madre» espera «Confirmar» o «No es ella», tarea `confirmar_representante`)
// y alguien se registra con el DNI de Valeria (no se crea a nadie: queda con lo
// que escribió para «¿Es la misma persona?», tarea `registro_con_documento`).
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
          displayName: "Thiago Quispe · QR demo",
          givenNames: "Thiago",
          familyName: "Quispe",
          birthDate: "2019-03-02",
          sex: "M",
          phone: VALERIA_PHONE,
          docType: "DNI",
          docNumber: "78901299",
        },
        respondent: "representative",
        representative: {
          displayName: "Valeria Quispe · QR demo",
          relationship: "guardian",
          relationshipDetail: "Madre",
          phone: VALERIA_PHONE,
          docType: "DNI",
          docNumber: "45678920",
        },
        health: {
          allergies: { state: "unanswered", items: [] },
          conditions: { state: "unanswered", items: [] },
          medications: { state: "unanswered", items: [] },
        },
        privacyAccepted: true,
      },
    },
  ),
)
await db
  .transaction((tx) =>
    registerPatient(
      tx,
      ORG_A,
      { kind: "public", entryPoint: "qr" },
      {
        submissionId: randomUUID(),
        formVersion: registrationConfig.version,
        answers: {
          demographics: {
            displayName: "Valeria Quispe Rojas",
            givenNames: "Valeria",
            familyName: "Quispe Rojas",
            birthDate: "1990-01-01",
            sex: "F",
            phone: "+51987000999",
            docType: "DNI",
            docNumber: "45678920",
          },
          respondent: "patient",
          health: {
            allergies: { state: "recorded", items: [{ substance: "Penicilina", severity: "desconocida" }] },
            conditions: { state: "unanswered", items: [] },
            medications: { state: "unanswered", items: [] },
          },
          privacyAccepted: true,
        },
      },
    ),
  )
  .catch(async (error: unknown) => {
    if (!(error instanceof RegistrationHeld)) throw error
    await db.transaction((tx) => leaveRegistrationHold(tx, ORG_A, error.hold))
  })
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
// Rosa ya es paciente y pidió registrar a su hijo: su enlace solo le ofrece
// registrar a otra persona («Enviar registro de un familiar»).
await db.transaction((tx) =>
  createPatientRegistrationLink(tx, ORG_A, ANA_ID, {
    contactId: rosaContactId,
    conversationId: convRosa.id,
  }),
)

// --- Agenda: unidades dentales y citas reales (la constraint impide sembrar solapes;
// los avisos de la UI cubren datos históricos o importaciones, no este seed) ---
const surco = await db.query.branch.findFirst({
  where: and(eq(branch.organizationId, ORG_A), eq(branch.name, "Sede Surco")),
})
if (!surco) throw new Error("Falta la Sede Surco")
const roomsMiraflores = await Promise.all(
  ["Unidad dental 1", "Unidad dental 2", "Unidad dental 3"].map((name) =>
    createRoom(db, ORG_A, { branchId: miraflores.id, name }),
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
// Solo Miraflores lleva agenda: Surco se deja limpia (sin unidades dentales, horarios ni ausencias)
// para ver los estados de «falta configurar» y montar una sede desde la propia agenda.
await db.transaction((tx) => seedAvailability(tx, domainSeed))
// La Dra. Rojas, endodoncista, atiende solo martes y jueves por la tarde
// (fase 4, tablero 2): «Endodoncia unirradicular» se ofrece solo en sus horas.
await setProfessionalSchedule(db, ORG_A, ANA_ID, {
  branchId: miraflores.id,
  professionalUserId: ROJAS_ID,
  rules: [2, 4].map((weekday) => ({ weekday, startMin: 14 * 60, endMin: 18 * 60 })),
})
// San Isidro, la segunda sede con historia: dos unidades dentales y el Dr. Salas
// de lunes a sábado (Miraflores le dio horario a todos sus profesionales; él no atiende ahí).
const sanIsidro = await db.query.branch.findFirst({
  where: and(eq(branch.organizationId, ORG_A), eq(branch.name, "Sede San Isidro")),
})
if (!sanIsidro) throw new Error("Falta la Sede San Isidro")
const roomsSanIsidro = await Promise.all(
  ["Unidad dental 1", "Unidad dental 2"].map((name) => createRoom(db, ORG_A, { branchId: sanIsidro.id, name })),
)
await setProfessionalSchedule(db, ORG_A, ANA_ID, { branchId: miraflores.id, professionalUserId: SALAS_ID, rules: [] })
await setProfessionalSchedule(db, ORG_A, ANA_ID, {
  branchId: sanIsidro.id,
  professionalUserId: SALAS_ID,
  rules: [1, 2, 3, 4, 5, 6].flatMap((weekday) => [
    { weekday, startMin: 9 * 60, endMin: 13 * 60 },
    ...(weekday === 6 ? [] : [{ weekday, startMin: 14 * 60, endMin: 18 * 60 }]),
  ]),
})
const roomA = (index: number): string => {
  const room = roomsMiraflores[index]
  if (!room) throw new Error("Faltan unidades dentales semilla")
  return room.id
}
/** Hora local de Lima (UTC-5 fijo en la semilla) → instante ISO. */
const lima = (dayOffset: number, hhmm: string): string => {
  // El día de Lima, no el de UTC: desde las 19:00 de Lima en UTC ya es mañana.
  const base = new Date(Date.now() - 5 * 60 * 60 * 1000)
  base.setUTCDate(base.getUTCDate() + dayOffset)
  return `${base.toISOString().slice(0, 10)}T${hhmm}:00-05:00`
}
// Ausencias claras en Miraflores, lejos de las citas sembradas (ayer, hoy y mañana):
// un permiso y unas vacaciones de dos profesionales, un feriado de toda la sede y una
// unidad dental en mantenimiento.
const limaDay = (dayOffset: number): string => lima(dayOffset, "00:00")
for (const block of [
  { professionalUserId: ANA_ID, kind: "ausencia", reason: "Permiso", startsAt: lima(4, "15:00"), endsAt: lima(4, "18:00") },
  { professionalUserId: LUIS_ID, kind: "ausencia", reason: "Vacaciones", startsAt: limaDay(6), endsAt: limaDay(9) },
  { kind: "bloqueo", reason: "Feriado", startsAt: limaDay(12), endsAt: limaDay(13) },
  { roomId: roomA(2), kind: "bloqueo", reason: "Mantenimiento", startsAt: lima(3, "09:00"), endsAt: lima(3, "12:00") },
]) {
  await createScheduleBlock(db, ORG_A, ANA_ID, { branchId: miraflores.id, ...block })
}
const agendaSeed: Array<{
  patient: string
  professional: string
  room: number
  day: number
  start: string
  end: string
  service: string
  status?: "programada" | "confirmada" | "atendida" | "no_asistio" | "cancelada"
  /** Lo aceptado que se agenda con la cita (ADR 0034). */
  planItemIds?: string[]
}> = [
  {
    patient: "Rosa Quispe",
    professional: ANA_ID,
    room: 0,
    day: 0,
    start: "09:00",
    end: "09:45",
    service: "LIMPIEZA",
    status: "confirmada",
  },
  {
    patient: "Elena Huamán",
    professional: ANA_ID,
    room: 0,
    day: 0,
    start: "10:00",
    end: "10:45",
    service: "OBTURACION",
  },
  {
    patient: "Carlos Paredes",
    professional: LUIS_ID,
    room: 1,
    day: 0,
    start: "09:30",
    end: "10:00",
    service: "ORTODONCIA_CTRL",
    status: "confirmada",
  },
  {
    patient: "Lucía Fernández",
    professional: ANA_ID,
    room: 2,
    day: 0,
    start: "11:00",
    end: "11:30",
    service: "RESINA-CPMS",
    // Sus resinas aceptadas: al atenderla, la atención las trae.
    planItemIds: [luciaResinas[16]!, luciaResinas[26]!],
  },
  {
    patient: "Carmen Rojas",
    professional: LUIS_ID,
    room: 1,
    day: 1,
    start: "09:00",
    end: "09:45",
    service: "ENDODONCIA",
  },
  {
    patient: "Rosa Quispe",
    professional: ANA_ID,
    room: 0,
    day: 1,
    start: "09:00",
    end: "10:00",
    service: "ENDODONCIA",
    status: "programada",
  },
  // Tarde de hoy: la agenda muestra «lo que viene», huecos entre citas y por confirmar.
  {
    patient: "Carmen Rojas",
    professional: ANA_ID,
    room: 0,
    day: 0,
    start: "15:00",
    end: "15:45",
    service: "LIMPIEZA",
    status: "confirmada",
  },
  {
    patient: "Carlos Paredes",
    professional: LUIS_ID,
    room: 1,
    day: 0,
    start: "15:30",
    end: "16:30",
    service: "ENDODONCIA",
  },
  {
    patient: "Elena Huamán",
    professional: LUIS_ID,
    room: 1,
    day: 0,
    start: "17:00",
    end: "17:30",
    service: "ORTODONCIA_CTRL",
  },
  // Ayer: ejecutada, ausencia y cancelación (estas dos últimas liberan recurso).
  {
    patient: "Elena Huamán",
    professional: ANA_ID,
    room: 0,
    day: -1,
    start: "09:00",
    end: "09:45",
    service: "LIMPIEZA",
    status: "atendida",
  },
  {
    patient: "Carlos Paredes",
    professional: LUIS_ID,
    room: 1,
    day: -1,
    start: "09:00",
    end: "09:30",
    service: "ORTODONCIA_CTRL",
    status: "no_asistio",
  },
  {
    patient: "Carmen Rojas",
    professional: ANA_ID,
    room: 0,
    day: -1,
    start: "09:00",
    end: "09:45",
    service: "LIMPIEZA",
    status: "cancelada",
  },
]
/** Las citas reservadas, por persona, día y hora: para marcar después quién llegó hoy. */
const reservedAt = new Map<string, string>()
for (const item of agendaSeed) {
  const seedPatientId = patientIdByName.get(item.patient)
  if (!seedPatientId) throw new Error(`Falta el paciente semilla ${item.patient}`)
  const reserved = await createAppointment(db, ORG_A, ANA_ID, {
    branchId: miraflores.id,
    patientId: seedPatientId,
    professionalUserId: item.professional,
    roomId: roomA(item.room),
    serviceId: serviceIdA(item.service),
    startsAt: lima(item.day, item.start),
    endsAt: lima(item.day, item.end),
    status: item.status ?? "programada",
    ...(item.planItemIds ? { planItemIds: item.planItemIds } : {}),
  })
  reservedAt.set(`${item.patient}|${item.day}|${item.start}`, reserved.id)
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
// La sala de espera de la Dra. Ana hoy (tablero 7): Lucía llegó y espera, y
// Rosa ya está en atención (su evaluación en borrador de hoy se une a su cita
// y la llegada queda marcada a esa hora). Ana es propietaria y atiende: su
// Inicio le muestra «Mis pacientes de hoy».
const luciaToday = reservedAt.get("Lucía Fernández|0|11:00")
const rosaToday = reservedAt.get("Rosa Quispe|0|09:00")
if (!luciaToday || !rosaToday) throw new Error("Faltan las citas de hoy de la semilla")
await setAppointmentArrival(db, ORG_A, ANA_ID, luciaToday, true)
await createEncounter(db, ORG_A, ANA_ID, rosaPatientId, { appointmentId: rosaToday })

// R3: la duda clínica de Rosa le llega a quien la atendió por última vez, que
// la responde desde «Te espera» de Inicio, sin entrar a la Bandeja.
const rosaClinicalAt = new Date(Date.now() - 40 * 60_000)
const rosaAsked = await seedMessage({
  orgId: ORG_A,
  conversationId: convRosa.id,
  direction: "in",
  senderKind: "contact",
  body: "¿Puedo tomar ibuprofeno después de la extracción?",
  externalId: "seed-msg-rosa-ibuprofeno",
  status: "received",
  createdAt: rosaClinicalAt,
})
await db
  .update(conversation)
  .set({ lastInboundAt: rosaClinicalAt, lastMessageAt: rosaClinicalAt })
  .where(eq(conversation.id, convRosa.id))
await createHandoff(db, ORG_A, null, {
  conversationId: convRosa.id,
  reason: "Duda clínica: ibuprofeno después de la extracción",
  summary: "Escribió: «¿Puedo tomar ibuprofeno después de la extracción?»",
  priority: "media",
  createdBy: "agent",
  clinical: true,
  sourceMessageId: rosaAsked.id,
})
for (const seed of [
  seedAgent,
  seedAutomation,
  seedClinicalForms,
  seedInventory,
  seedFinance,
  // Después de Inventario: materiales de dos servicios, la atención de Rosa descontada y un cepillo vendido.
  seedMaterialsAndSales,
  seedMailbox,
  seedOpportunities,
  seedPortal,
  seedWorkspace,
  seedRoles,
]) {
  await db.transaction((tx) => seed(tx, domainSeed))
}
// «Tus mensajes» (ADR 0040): Carmen pidió por teléfono no recibir recordatorios
// (en su página se ve apagado y, con «Recordar la cita» prendida, «Te espera»
// pide llamarla el día antes de su cita); Diego no quiere ningún mensaje.
await db.transaction(async (tx) => {
  await setMessageChoice(tx, ORG_A, ANA_ID, contactIdByName.get("Carmen Rojas")!, {
    choice: "recordatorio",
    receive: false,
    source: "telefono",
  })
  await setMessageChoice(tx, ORG_A, ANA_ID, contactIdByName.get("Diego Salazar")!, {
    choice: "ninguno",
    receive: false,
    source: "presencial",
  })
})
// Quién atiende qué (ADR 0039): la Dra. Rojas, Endodoncia; Ana, Cirugía oral
// (la de la biblioteca, renombrada) y lo general; Luis, lo general.
// Implantología queda sin nadie: la agenda ofrece a cualquiera y
// Especialidades lo avisa.
await db.transaction(async (tx) => {
  await setProfessionalSpecialties(tx, ORG_A, ANA_ID, ROJAS_ID, [specialtiesA.get("endodoncia")!])
  await setProfessionalSpecialties(tx, ORG_A, ANA_ID, ANA_ID, [
    specialtiesA.get("cirugia")!,
    specialtiesA.get("general")!,
  ])
  await setProfessionalSpecialties(tx, ORG_A, ANA_ID, LUIS_ID, [specialtiesA.get("general")!])
})
// Firmado en papel (fase 3, paso 2B): la anestesia local de la exodoncia, con
// la foto de la hoja firmada; el pendiente se cierra con método «papel».
{
  const [paperPending] = await db
    .select({ id: consentDocument.id })
    .from(consentDocument)
    .innerJoin(consentTemplate, eq(consentTemplate.id, consentDocument.templateId))
    .where(
      and(
        eq(consentDocument.organizationId, ORG_A),
        eq(consentDocument.patientId, domainSeed.patientId),
        eq(consentDocument.status, "pendiente"),
        eq(consentTemplate.key, "anestesia-local"),
      ),
    )
    .limit(1)
  if (paperPending) {
    const photo = await putDemoImage(domainSeed.patientId, "foto", 2)
    const sheet = await registerPatientDocument(db, ORG_A, ANA_ID, domainSeed.patientId, {
      category: "consentimiento",
      label: "[DEMO] Hoja firmada: Anestesia local odontológica",
      storageKey: photo.objectKey,
      contentType: "image/png",
      sizeBytes: photo.size,
      thumbnailKey: photo.thumbnailKey,
    })
    await signConsentDocument(db, ORG_A, ANA_ID, paperPending.id, {
      signerKind: "paciente",
      signerContactId: domainSeed.contactId,
      comprehensionConfirmed: true,
      method: "papel",
      paperDocumentId: sheet.id,
    })
  }
}
// «Su enlace» (fase 3, paso 6, ADR 0037): Pedro Ríos tiene su enlace para
// completar lo que le falta (documento y fecha de nacimiento) y ver su cita; y
// el consentimiento de la exodoncia se le envió a la paciente para firmarlo
// desde su teléfono: en su página dice «Se le envió para firmar».
if (pedroRiosPerson) {
  const pedroLink = await db.transaction((tx) =>
    issuePersonalLink(tx, ORG_A, { contactId: pedroRiosPerson, patientId: pedroRios.id, createdBy: ANA_ID }, { secretsKey }),
  )
  console.log(`«Su enlace» de Pedro Ríos (dental-smile): /reserva?token=${pedroLink.token}`)
}
{
  const [exodonciaPending] = await db
    .select({ id: consentDocument.id })
    .from(consentDocument)
    .innerJoin(consentTemplate, eq(consentTemplate.id, consentDocument.templateId))
    .where(
      and(
        eq(consentDocument.organizationId, ORG_A),
        eq(consentDocument.patientId, domainSeed.patientId),
        eq(consentDocument.status, "pendiente"),
        eq(consentTemplate.key, "exodoncia"),
      ),
    )
    .limit(1)
  if (exodonciaPending) await db.transaction((tx) => markConsentSentByLink(tx, ORG_A, ANA_ID, exodonciaPending.id))
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
// Dos años de historia de una clínica mediana en dos sedes: Reportes con
// tendencia, comparación con el año anterior y mapas de días y horas.
const reportsHistory = await db.transaction((tx) => {
  const service = (code: string, weight: number, firstVisit = false) => {
    const found = catalogA.find((item) => item.code === code)
    if (!found || found.priceCents === null) throw new Error(`Falta el servicio semilla ${code}`)
    return { id: found.id, name: found.name, priceCents: found.priceCents, durationMin: found.durationMin ?? 30, weight, firstVisit }
  }
  return seedReports(tx, {
    orgId: ORG_A,
    ownerUserId: ANA_ID,
    branches: [
      { id: miraflores.id, roomIds: roomsMiraflores.map((room) => room.id), rent: 6_500_00 },
      { id: sanIsidro.id, roomIds: roomsSanIsidro.map((room) => room.id), rent: 4_800_00 },
    ],
    professionals: [
      { userId: ANA_ID, signerName: "Ana Torres", registration: "12345", branchId: miraflores.id, weekdays: [1, 2, 3, 4, 5, 6], occupancy: 0.8 },
      { userId: LUIS_ID, signerName: "Luis Prado", registration: "23456", branchId: miraflores.id, weekdays: [1, 2, 3, 4, 5, 6], occupancy: 0.66 },
      { userId: ROJAS_ID, signerName: "Elena Rojas", registration: "45678", branchId: miraflores.id, weekdays: [2, 4], afternoonOnly: true, occupancy: 0.85 },
      { userId: SALAS_ID, signerName: "Diego Salas", registration: "56789", branchId: sanIsidro.id, weekdays: [1, 2, 3, 4, 5, 6], occupancy: 0.7 },
    ],
    services: [
      service("EVALUACION", 1, true),
      service("LIMPIEZA", 30),
      service("OBTURACION", 26),
      service("ORTODONCIA_CTRL", 18),
      service("EXODONCIA", 8),
      service("ENDODONCIA", 7),
      service("BLANQUEAMIENTO", 5),
      service("CORONA", 6),
    ],
    patientIds: [...patientIdByName.values()],
  })
})
// Lo que contó el cobro por acción de esa historia (Reportes › Agente): la suscripción pasa a activa.
await db.transaction((tx) => seedReportsAgent(tx, { orgId: ORG_A, dictating: [{ userId: ANA_ID, fromMonthsAgo: 10, share: [0.25, 0.55] }, { userId: LUIS_ID, fromMonthsAgo: 4, share: [0.3, 0.3] }] }))
// Fase 3 de Reportes: comisiones pagadas, compras en cada estado de pago, promociones usadas y horarios con su historia.
const reportsFinance = await db.transaction((tx) => seedReportsFinance(tx, { orgId: ORG_A, ownerUserId: ANA_ID, professionalIds: [ANA_ID, LUIS_ID, ROJAS_ID, SALAS_ID] }))
// Reportes › Pacientes: cuándo y por dónde nos buscó cada persona, cómo nos conoció y sus controles.
const patientsHistory = await db.transaction((tx) => seedReportsPatients(tx, { orgId: ORG_A, ownerUserId: ANA_ID }))
// Fases 5 y 6 de Reportes: dos respuestas de Argos fijadas en el Resumen y las metas del mes, con la del mes anterior.
const reportsArgos = await db.transaction((tx) => seedReportsArgos(tx, { orgId: ORG_A, ownerUserId: ANA_ID, professionalUserId: LUIS_ID }))
// Examen de Argos (issue 192): el avance de lo aceptado y los materiales que usaron las atenciones de los últimos 90 días.
const reportsProgress = await db.transaction((tx) =>
  seedReportsProgress(tx, { orgId: ORG_A, ownerUserId: ANA_ID, branchIds: [miraflores.id, sanIsidro.id] }),
)
await db.transaction(async (tx) => {
  const staff = await seedAdminCore(tx)
  await seedSaasBillingDemo(tx, storage)
  // Clínicas de Ana con los avisos de cobro de la franja (ADR 0065).
  await seedClinicNoticesDemo(tx, { ownerUserId: ANA_ID, professionalUserId: LUIS_ID, acceptedVersion: LEGAL.agreement.version })
  await seedAdminOrganizations(tx)
  await seedAdminSupport(tx, { organizationId: ORG_A, userId: ANA_ID, staffUserId: staff.supportUserId })
})
// Libro de Reclamaciones de odentIA (tabla global de la plataforma): una hoja
// de ejemplo, con datos ficticios. Idempotente por su submissionId fijo; no envía correos.
await db.transaction((tx) =>
  submitConsumerComplaint(tx, {
    submissionId: "00000000-0000-4000-8000-0000000c0a01",
    kind: "reclamo",
    consumerName: "Marta Salas Vega",
    consumerAddress: "Av. Arequipa 1234, Lince, Lima",
    documentType: "DNI",
    documentNumber: "40123456",
    phone: "+51 999 111 222",
    email: "marta.salas@ejemplo.dev",
    isMinor: false,
    itemType: "servicio",
    itemDescription: "Suscripción mensual de odentIA (ejemplo)",
    amount: "199.00",
    currency: "PEN",
    detail: "Ejemplo de la semilla: el cobro del mes aparece dos veces en el estado de cuenta.",
    request: "Que se anule el cobro repetido.",
    privacyAccepted: true,
  }),
)
// Una queja ya respondida por el personal de soporte, para ver «Respondidas» y
// su respuesta en la administración. Responder otra vez la deja como estaba.
await db.transaction(async (tx) => {
  const { sheet } = await submitConsumerComplaint(tx, {
    submissionId: "00000000-0000-4000-8000-0000000c0a02",
    kind: "queja",
    consumerName: "Jorge Mendoza Salas",
    consumerAddress: "Jr. Junín 456, Cercado de Lima",
    documentType: "DNI",
    documentNumber: "41234567",
    phone: "+51 999 333 444",
    email: "jorge.mendoza@ejemplo.dev",
    isMinor: false,
    itemType: "servicio",
    itemDescription: "Soporte de odentIA (ejemplo)",
    detail: "Ejemplo de la semilla: esperé tres días una respuesta de soporte.",
    request: "Que me respondan más rápido.",
    privacyAccepted: true,
  })
  if (sheet.status === "recibido") {
    await respondConsumerComplaint(
      tx,
      { userId: SEED_STAFF_SUPPORT_ID, role: "support" },
      sheet.id,
      {
        response:
          "Ejemplo de la semilla: revisamos tu caso, te respondimos por soporte y ajustamos los turnos para responder en el día.",
      },
    )
  }
})
// Lo que hicieron los agentes este mes (ADR 0031), para ver Plan y pagos y
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
  // «Pedir revisión» (issue 77, ADR 0054): Ana, la dueña, pidió revisar dos
  // conversaciones; odentIA mantuvo una con su respuesta y la otra espera en
  // Soporte. Sus avisos a soporte quedan como enviados: la semilla no envía nada.
  const reviewed = await db
    .select({ id: saasAction.id, key: saasAction.dedupeKey })
    .from(saasAction)
    .where(and(eq(saasAction.organizationId, ORG_A), inArray(saasAction.dedupeKey, ["semilla:conversacion:2", "semilla:conversacion:4"])))
  const actionOf = (key: string) => reviewed.find((row) => row.key === key)?.id
  const ana = { userId: ANA_ID, roleLabel: "Dueño" }
  const caseIds: string[] = []
  const kept = actionOf("semilla:conversacion:2")
  if (kept) {
    const asked = await requestActionReview(db, ORG_A, ana, {
      actionId: kept,
      reason: "doble",
      note: "Ejemplo de la semilla: creo que esta conversación ya se contó el día anterior.",
    })
    if (asked.caseId) {
      caseIds.push(asked.caseId)
      await decideActionReview(db, { userId: SEED_STAFF_ADMIN_ID, role: "admin" }, {
        caseId: asked.caseId,
        accept: false,
        answer: "Ejemplo de la semilla: es una sola conversación ese día; la del día anterior fue con otra persona.",
      })
    }
  }
  const pending = actionOf("semilla:conversacion:4")
  if (pending) {
    const asked = await requestActionReview(db, ORG_A, ana, {
      actionId: pending,
      reason: "agente",
      note: "Ejemplo de la semilla: le dio un horario del sábado que no tenemos.",
    })
    if (asked.caseId) caseIds.push(asked.caseId)
  }
  if (caseIds.length) {
    await db.update(supportNotice).set({ emailState: "enviado", emailedAt: new Date() }).where(inArray(supportNotice.caseId, caseIds))
  }
}
// Uso de IA del mes para la ficha de la clínica en la administración (ADR 0031).
// Cifras de ejemplo con el costo que da la tabla de precios del agente; no
// salen de ningún proveedor. Jev queda sin costo: no tiene precio cargado.
await db.insert(aiUsage).values([
  { organizationId: ORG_A, origin: "recepcion", provider: "openai", model: "gpt-6-luna", calls: 120, inputTokens: 360_000, cachedInputTokens: 240_000, cacheWriteTokens: 12_000, outputTokens: 6_000, costMicros: 17_700 },
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
    "treatment_budget_option",
    "appointment_plan_item",
    "clinical_follow_up",
    "prescription",
    "patient_charge",
    "patient_payment",
    "patient_responsibility",
    "patient_data_request",
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
console.log(
  `historia de Reportes (dental-smile, 24 meses, Miraflores y San Isidro): ${reportsHistory.appointments} citas, ${reportsHistory.patients} pacientes nuevos, ${reportsHistory.conversations} conversaciones, ${reportsHistory.budgets} presupuestos`,
)
console.log(
  `Reportes › Finanzas y Agenda (dental-smile): ${reportsFinance.settlements} pagos de comisiones, ${reportsFinance.orders} compras, ${reportsFinance.budgets} presupuestos con promoción`,
  `historia de Pacientes (dental-smile): ${patientsHistory.moved} primeras visitas tras su mensaje, ${patientsHistory.channels} conversaciones por canal, ${patientsHistory.referrals} «cómo nos conoció», ${patientsHistory.controls} controles`,
  `Argos en Reportes (dental-smile): ${reportsArgos.pins} respuestas fijadas en el Resumen, meta de cobrado ${reportsArgos.goalText} desde este mes`,
  `avance y materiales (dental-smile): ${Object.entries(reportsProgress.progress).map(([status, count]) => `${count} ${status}`).join(", ")}; ${reportsProgress.discounted} atenciones con materiales descontados en ${reportsProgress.services} servicios; ${reportsProgress.today} atenciones cobradas hoy`,
)
console.log("credenciales (password Demo1234): ana@odentia.dev, luis@odentia.dev, cora@odentia.dev")
process.exit(0)
