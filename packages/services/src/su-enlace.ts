import {
  clinicalProfileFor,
  documentIssuerCountry,
  documentText,
  isMinor,
  isRealDate,
  type MissingPersonDatum,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment, appointmentBookingLink } from "@odentia/db/schema/agenda"
import { automationLinkToken } from "@odentia/db/schema/automation"
import { patientContact, patientResponsibility } from "@odentia/db/schema/clinical"
import { consentDocument } from "@odentia/db/schema/clinical-forms"
import { contact } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, eq, gte, isNotNull, isNull, lte, or, sql } from "drizzle-orm"
import { createHash } from "node:crypto"
import {
  PERSONAL_LINK_MESSAGE_KEY,
  PERSONAL_LINK_SUBJECT,
  renderMessage,
  replyId,
  withLinkLine,
} from "./automation-messages.js"
import { clinicName as findClinicName, firstName, previewMessageRoute, routeMessage } from "./automation-routing.js"
import { mayWriteFirst } from "./automation.js"
import {
  appointmentView,
  type BookingLinkAppointment,
  type BookingLinkBranch,
  bookingContext,
  clinicNameOf,
  issuePersonalLink,
  linkContactFirstName,
  linkExpired,
  patientFirstNameOf,
  requireLiveLink,
  resolvePersonalLink,
  type ResolvedPersonalLink,
} from "./booking-links.js"
import { listBudgets } from "./budgets.js"
import { serviceRecipient } from "./budget-send.js"
import { signConsentByLink } from "./clinical-forms.js"
import { currentCatalogMessage } from "./clinic-messages.js"
import { sendOutbound, sendTemplateOutbound } from "./conversations.js"
import { createContactNote } from "./crm-workspace.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { findOrgCountry, findOrgLocale } from "./locale.js"
import { attachLegalRepresentative, getPatientMissingData } from "./patient-registration.js"
import { patientOrganizationToday, patientPersonId, requirePatient, updatePatient } from "./patients.js"
import { decideBudgetByPerson, type DecidePortalBudgetInput, portalBudgetLocale, type PortalBudgetView, toPortalBudget } from "./portal.js"
import { pendingQuestionnaire, submitQuestionnaireFromLink } from "./portal-questionnaire.js"
import { personalLinkUrl } from "./public-links.js"
import { createTask } from "./tasks.js"

/**
 * Lo que tiene pendiente cada persona en «Su enlace» (decisión 8; ADR 0037):
 * su cita, sus datos por completar, el presupuesto que se le envió, el
 * consentimiento por firmar y el cuestionario. Cada cosa sale de su propia
 * regla y deja de servir cuando ya no hace falta; aquí no se guarda nada
 * aparte. Nunca se muestra lo guardado: de sus datos solo qué falta.
 */

export interface PersonalLinkConsent {
  id: string
  title: string
}

export interface PersonalLinkView {
  /** `vencido`: revocado, o ya no le queda nada pendiente. */
  status: "abierto" | "vencido"
  clinicName: string
  /** Formato regional de la clínica (BCP 47): la página escribe fechas y horas con él. */
  locale: string
  /** País de la clínica (ISO 3166-1): de él dependen los documentos que se piden. */
  countryCode: string | null
  /** Nombre de pila de quien abre: «Hola, Pedro». */
  firstName: string | null
  /** Nombre de pila del paciente, cuando no es quien abre (su hijo, por ejemplo). */
  patientFirstName: string | null
  expiresAt: string
  /** Reservar una cita nueva (el enlace que envía el agente). */
  booking: {
    /** Aún no es paciente: antes de reservar deja sus datos esenciales. */
    needsRegistration: boolean
    service: { name: string; durationMin: number | null } | null
    branchId: string | null
  } | null
  /** Las sedes, para reservar o para elegir el horario de lo que aceptó. */
  branches: BookingLinkBranch[]
  appointment: BookingLinkAppointment | null
  /** Tus datos: solo qué falta, nunca lo guardado. */
  data: { missing: MissingPersonDatum[] } | null
  /** Presupuestos que esperan su respuesta. */
  budgets: PortalBudgetView[]
  /** Consentimientos que la clínica le envió a firmar. */
  consents: PersonalLinkConsent[]
  /** «Antes de tu cita», si hay uno por responder. */
  questionnaire: { title: string } | null
}

async function missingOf(tx: Db, orgId: string, link: ResolvedPersonalLink): Promise<MissingPersonDatum[] | null> {
  if (!link.patientId || link.row.dataSubmittedAt || link.deadline.getTime() <= Date.now()) return null
  const missing = await getPatientMissingData(tx, orgId, link.patientId)
  return missing.length > 0 ? missing : null
}

async function budgetsOf(tx: Db, orgId: string, patientId: string | null): Promise<PortalBudgetView[]> {
  if (!patientId) return []
  const budgets = (await listBudgets(tx, orgId, patientId)).filter(
    (budget) => budget.status !== "borrador" && budget.awaitsAnswer,
  )
  if (budgets.length === 0) return []
  const locale = await portalBudgetLocale(tx, orgId)
  return budgets.map((budget) => toPortalBudget(budget, locale))
}

async function consentsOf(tx: Db, orgId: string, link: ResolvedPersonalLink): Promise<PersonalLinkConsent[]> {
  if (!link.patientId || link.deadline.getTime() <= Date.now()) return []
  const rows = await tx
    .select({ id: consentDocument.id, title: consentDocument.titleSnapshot })
    .from(consentDocument)
    .where(
      and(
        eq(consentDocument.organizationId, orgId),
        eq(consentDocument.patientId, link.patientId),
        eq(consentDocument.status, "pendiente"),
        isNotNull(consentDocument.linkSentAt),
        isNull(consentDocument.personSignedAt),
      ),
    )
    .orderBy(asc(consentDocument.createdAt))
  return rows
}

/** El cuestionario sale antes de una cita: con una por venir y mientras no lo haya enviado. */
async function questionnaireOf(tx: Db, orgId: string, link: ResolvedPersonalLink): Promise<{ title: string } | null> {
  if (!link.patientId || !link.appointment || link.appointment.status === "cancelada") return null
  const pending = await pendingQuestionnaire(tx, orgId, link.patientId)
  return pending ? { title: pending.title } : null
}

export async function getPersonalLinkView(tx: Db, orgId: string, token: string): Promise<PersonalLinkView> {
  const link = await resolvePersonalLink(tx, orgId, token)
  const region = await findOrgLocale(tx, orgId)
  const base = {
    clinicName: await clinicNameOf(tx, orgId),
    locale: region.locale,
    countryCode: await findOrgCountry(tx, orgId),
    expiresAt: link.deadline.toISOString(),
  }
  const empty = {
    ...base,
    status: "vencido" as const,
    firstName: null,
    patientFirstName: null,
    booking: null,
    branches: [],
    appointment: null,
    data: null,
    budgets: [],
    consents: [],
    questionnaire: null,
  }
  if (!link.live) return empty
  const appointment = link.appointment ? await appointmentView(tx, orgId, link.appointment.id) : null
  const missing = await missingOf(tx, orgId, link)
  const budgets = await budgetsOf(tx, orgId, link.patientId)
  const consents = await consentsOf(tx, orgId, link)
  const questionnaire = await questionnaireOf(tx, orgId, link)
  const context = link.canBook || budgets.length > 0 ? await bookingContext(tx, orgId, link.row) : null
  const nothing = !link.canBook && !appointment && !missing && budgets.length === 0 && consents.length === 0 && !questionnaire
  if (nothing) return empty
  const self = link.patientId ? (await patientPersonId(tx, orgId, link.patientId)) === link.row.contactId : true
  return {
    ...base,
    status: "abierto",
    firstName: await linkContactFirstName(tx, orgId, link.row.contactId),
    patientFirstName: link.patientId && !self ? await patientFirstNameOf(tx, orgId, link.patientId) : null,
    booking:
      link.canBook && context
        ? { needsRegistration: link.patientId === null, service: context.service, branchId: context.branchId }
        : null,
    branches: context?.branches ?? [],
    appointment,
    data: missing ? { missing } : null,
    budgets,
    consents,
    questionnaire,
  }
}

// ------------------------------------------------------------- tus datos ---

/** Lo que «Tus datos» puede completar: solo lo que falta, y lo que va con ello. */
const DATA_FIELDS = [
  "givenNames",
  "paternalSurname",
  "maternalSurname",
  "birthDate",
  "docType",
  "docNumber",
  "docCountry",
  "sex",
  "phone",
  "email",
  "address",
  "emergencyContactName",
  "emergencyContactPhone",
  "insuranceType",
] as const
type DataField = (typeof DATA_FIELDS)[number]

/** De cada dato que falta, lo que se puede escribir para completarlo. */
function fieldsFor(missing: MissingPersonDatum[]): Set<DataField> {
  const allowed = new Set<DataField>()
  for (const item of missing) {
    if (item.key === "paternalSurname") {
      allowed.add("paternalSurname")
      allowed.add("maternalSurname")
    } else if (item.key === "docType" || item.key === "docNumber") {
      allowed.add("docType")
      allowed.add("docNumber")
      allowed.add("docCountry")
    } else if (item.key === "phone") {
      allowed.add("phone")
      allowed.add("email")
    } else {
      allowed.add(item.key)
    }
  }
  return allowed
}

export interface PersonalLinkDataForm {
  missing: MissingPersonDatum[]
  countryCode: string | null
  today: string
  /** Si la fecha de nacimiento lo hace menor, pide en la misma pantalla a su representante. */
  hasRepresentative: boolean
}

/** Lo que pide «Tus datos»: solo lo que falta, con el país de la clínica para los documentos. */
export async function getPersonalLinkDataForm(tx: Db, orgId: string, token: string): Promise<PersonalLinkDataForm> {
  const link = await requireLiveLink(tx, orgId, token)
  const missing = await missingOf(tx, orgId, link)
  if (!missing || !link.patientId) throw linkExpired()
  return {
    missing,
    countryCode: await findOrgCountry(tx, orgId),
    today: await patientOrganizationToday(tx, orgId),
    hasRepresentative: await hasLegalRepresentative(tx, orgId, link.patientId),
  }
}

async function hasLegalRepresentative(tx: Db, orgId: string, patientId: string): Promise<boolean> {
  const today = await patientOrganizationToday(tx, orgId)
  const [row] = await tx
    .select({ id: patientResponsibility.id })
    .from(patientResponsibility)
    .where(
      and(
        eq(patientResponsibility.organizationId, orgId),
        eq(patientResponsibility.patientId, patientId),
        eq(patientResponsibility.kind, "representante_legal"),
        isNull(patientResponsibility.revokedAt),
        lte(patientResponsibility.startsAt, today),
        or(isNull(patientResponsibility.endsAt), gte(patientResponsibility.endsAt, today)),
      ),
    )
    .limit(1)
  return !!row
}

export interface PersonalLinkDataInput {
  data: Partial<Record<DataField, string | null>>
  /** Su madre, padre o tutor, si la fecha dice que es menor. */
  representative?: {
    displayName: string
    docType?: string
    docNumber?: string
    docCountry?: string
    phone?: string
    relationshipDetail?: string
  } | null
}

/** De quién es ya ese documento, si es de otra persona. */
async function documentOwner(
  tx: Db,
  orgId: string,
  doc: { docType: string | null; docNumber: string; docCountry: string | null },
  exceptContactId: string | null,
): Promise<{ contactId: string; name: string } | null> {
  const [owner] = await tx
    .select({ id: contact.id, name: contact.displayName })
    .from(contact)
    .where(
      and(
        eq(contact.organizationId, orgId),
        eq(contact.docNumber, doc.docNumber),
        doc.docType ? eq(contact.docType, doc.docType) : isNull(contact.docType),
        doc.docCountry ? eq(contact.docCountry, doc.docCountry) : isNull(contact.docCountry),
        ...(exceptContactId ? [sql`${contact.id} <> ${exceptContactId}`] : []),
      ),
    )
    .limit(1)
  return owner ? { contactId: owner.id, name: owner.name } : null
}

/**
 * La persona envía lo que le faltaba, una sola vez. Se guarda con las reglas
 * de la ficha (`updatePatient`, a su nombre). Si la fecha la hace menor, en
 * la misma operación se registra a su representante legal con documento. Si
 * el documento ya es de otra persona no se guarda, nunca se unen solas, y a
 * recepción le llega «Posible ficha repetida» en «Te espera»; a la persona no
 * se le dice de quién es. La identidad sigue por revisar hasta que recepción
 * la confirme, y una nota de su persona dice qué completó y qué sigue faltando.
 */
export async function submitPersonalLinkData(
  tx: Db,
  orgId: string,
  token: string,
  input: PersonalLinkDataInput,
): Promise<{ received: true }> {
  const link = await requireLiveLink(tx, orgId, token, true)
  const missing = await missingOf(tx, orgId, link)
  const patientId = link.patientId
  if (!missing || !patientId) throw new ServiceError("DATA_ALREADY_SENT", 409, "Tus datos ya están en la clínica.")
  const allowed = fieldsFor(missing)
  const patch: Record<string, string | null> = {}
  for (const [key, raw] of Object.entries(input.data ?? {})) {
    if (!(DATA_FIELDS as readonly string[]).includes(key) || !allowed.has(key as DataField)) continue
    const value = typeof raw === "string" ? raw.trim() : null
    if (value) patch[key] = value
  }
  if (Object.keys(patch).length === 0) throw validation("Completa al menos un dato")
  const actor = `contact:${link.row.contactId}`
  const today = await patientOrganizationToday(tx, orgId)
  const countryCode = await findOrgCountry(tx, orgId)
  const personId = await patientPersonId(tx, orgId, patientId)
  // Si la fecha la hace menor y no tiene representante, se registra en la misma pantalla.
  if (patch.birthDate && isRealDate(patch.birthDate) && isMinor(patch.birthDate, today) && !(await hasLegalRepresentative(tx, orgId, patientId))) {
    const rep = input.representative
    if (!rep?.displayName?.trim() || !rep.docNumber?.trim()) {
      throw new ServiceError("REPRESENTATIVE_REQUIRED", 409, "Como es menor de edad, completa los datos de su madre, padre o tutor")
    }
    await attachLegalRepresentative(tx, orgId, null, patientId, {
      representative: {
        displayName: rep.displayName.trim(),
        docType: (rep.docType ?? undefined) as never,
        docNumber: rep.docNumber.trim(),
        docCountry: rep.docCountry ?? undefined,
        phone: rep.phone?.trim() || undefined,
        relationshipDetail: rep.relationshipDetail?.trim() ?? "",
      },
      countryCode,
      today,
    })
  }
  // Un documento que ya es de otra persona no se guarda: lo revisa recepción.
  let duplicateOf: { contactId: string; name: string } | null = null
  if (patch.docNumber) {
    const issuer = documentIssuerCountry(clinicalProfileFor(countryCode), patch.docType ?? null, patch.docCountry ?? null)
    duplicateOf = await documentOwner(
      tx,
      orgId,
      { docType: patch.docType ?? null, docNumber: patch.docNumber, docCountry: issuer },
      personId,
    )
    if (duplicateOf) {
      delete patch.docType
      delete patch.docNumber
      delete patch.docCountry
    }
  }
  if (Object.keys(patch).length > 0) await updatePatient(tx, orgId, actor, patientId, patch)
  // «Tus datos» se envían una sola vez: después dice «Recibido».
  await tx
    .update(appointmentBookingLink)
    .set({ dataSubmittedAt: new Date() })
    .where(and(eq(appointmentBookingLink.organizationId, orgId), eq(appointmentBookingLink.id, link.row.id)))
  const person = await requirePatient(tx, orgId, patientId)
  const stillMissing = await getPatientMissingData(tx, orgId, patientId)
  if (personId) {
    const done = missing.filter((item) => !stillMissing.some((left) => left.key === item.key)).map((item) => item.label)
    const parts = [
      done.length > 0 ? `Completó desde su enlace: ${done.join(", ")}.` : "Envió sus datos desde su enlace.",
      stillMissing.length > 0 ? `Sigue faltando: ${stillMissing.map((item) => item.label).join(", ")}.` : null,
      duplicateOf ? "El documento que escribió ya está en otra ficha: no se guardó." : null,
    ].filter(Boolean)
    await createContactNote(tx, orgId, personId, { body: parts.join(" ") }, { userId: null })
  }
  if (duplicateOf) {
    await createTask(tx, orgId, {
      title: `Posible ficha repetida: ${person.displayName}`,
      patientId,
      area: "recepcion",
      createdBy: "sistema",
      kind: "ficha_repetida",
      reason: `El documento que escribió en su enlace ya está en la página de ${duplicateOf.name}. No se guardó: revisa si son la misma persona.`,
      idempotencyKey: `ficha-repetida:${patientId}:${duplicateOf.contactId}`,
    })
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: actor,
    action: "personal_link.data_sent",
    entity: "patient",
    entityId: patientId,
    metadata: { fields: Object.keys(patch), duplicate: !!duplicateOf, origin: "paciente" },
  })
  return { received: true }
}

// ---------------------------------------------------------- presupuesto ---

/** Quien abre el enlace puede decidir por el paciente: la propia persona o su representante legal vigente. */
async function requireDecider(tx: Db, orgId: string, patientId: string, contactId: string): Promise<void> {
  const [own] = await tx
    .select({ relationship: patientContact.relationship })
    .from(patientContact)
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.patientId, patientId),
        eq(patientContact.contactId, contactId),
      ),
    )
    .limit(1)
  if (own?.relationship === "self") return
  if (!(await isLegalRepresentative(tx, orgId, patientId, contactId))) {
    throw new ServiceError("PORTAL_FORBIDDEN", 404, "Este enlace no puede responder por esta persona")
  }
}

async function isLegalRepresentative(tx: Db, orgId: string, patientId: string, contactId: string): Promise<boolean> {
  const today = await patientOrganizationToday(tx, orgId)
  const [row] = await tx
    .select({ id: patientResponsibility.id })
    .from(patientResponsibility)
    .where(
      and(
        eq(patientResponsibility.organizationId, orgId),
        eq(patientResponsibility.patientId, patientId),
        eq(patientResponsibility.contactId, contactId),
        eq(patientResponsibility.kind, "representante_legal"),
        isNull(patientResponsibility.revokedAt),
        lte(patientResponsibility.startsAt, today),
        or(isNull(patientResponsibility.endsAt), gte(patientResponsibility.endsAt, today)),
      ),
    )
    .limit(1)
  return !!row
}

export interface PersonalLinkBudgetAnswer {
  budget: PortalBudgetView
  /** Lo que aceptó y falta agendar: «¿Reservamos tus dos resinas?». */
  toSchedule: Array<{ planItemId: string; title: string }>
}

/**
 * «Ver y responder» (decisión 5): la persona marca lo que acepta, lo que deja
 * para después o, con opciones, elige una. Es la misma decisión que en el
 * portal y que la anotada por el agente con su sí (`decideBudgetByPerson`).
 */
export async function decidePersonalLinkBudget(
  tx: Db,
  orgId: string,
  token: string,
  budgetId: string,
  input: DecidePortalBudgetInput,
): Promise<PersonalLinkBudgetAnswer> {
  const link = await requireLiveLink(tx, orgId, token, true)
  if (!link.patientId) throw linkExpired()
  await requireDecider(tx, orgId, link.patientId, link.row.contactId)
  const result = await decideBudgetByPerson(tx, orgId, {
    patientId: link.patientId,
    contactId: link.row.contactId,
    budgetId,
    decision: input,
    via: "enlace",
  })
  if (!result.replay) {
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId: `contact:${link.row.contactId}`,
      action: "personal_link.budget_decided",
      entity: "treatment_budget",
      entityId: budgetId,
      metadata: { status: result.budget.status, origin: "paciente" },
    })
  }
  const locale = await portalBudgetLocale(tx, orgId)
  return {
    budget: toPortalBudget(result.budget, locale),
    toSchedule: result.budget.items
      .filter((line) => line.decision === "aceptado" && line.itemStatus === "pendiente")
      .map((line) => ({ planItemId: line.planItemId, title: line.title })),
  }
}

// ------------------------------------------------------ consentimiento ---

export interface PersonalLinkConsentView {
  id: string
  title: string
  /** Lo que se explica, por secciones (qué se hará, beneficios, riesgos y alternativas). */
  sections: unknown
  body: string
  /** Quién firma y el tipo de documento que escribe (nunca el número guardado). */
  signer: { name: string; asRepresentative: boolean; documentLabel: string | null }
}

async function requireLinkConsent(tx: Db, orgId: string, link: ResolvedPersonalLink, consentId: string) {
  const consents = await consentsOf(tx, orgId, link)
  if (!consents.some((item) => item.id === consentId)) throw linkExpired()
  const [doc] = await tx
    .select()
    .from(consentDocument)
    .where(and(eq(consentDocument.organizationId, orgId), eq(consentDocument.id, consentId)))
    .limit(1)
  if (!doc) throw notFound("Consentimiento")
  return doc
}

/** Lo que lee antes de firmar en su enlace. */
export async function getPersonalLinkConsent(tx: Db, orgId: string, token: string, consentId: string): Promise<PersonalLinkConsentView> {
  const link = await requireLiveLink(tx, orgId, token)
  if (!link.patientId) throw linkExpired()
  const doc = await requireLinkConsent(tx, orgId, link, consentId)
  const [signer] = await tx
    .select({ name: contact.displayName, docType: contact.docType })
    .from(contact)
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, link.row.contactId)))
    .limit(1)
  const self = (await patientPersonId(tx, orgId, link.patientId)) === link.row.contactId
  return {
    id: doc.id,
    title: doc.titleSnapshot,
    sections: doc.sectionsSnapshot,
    body: doc.bodySnapshot,
    signer: {
      name: signer?.name ?? "",
      asRepresentative: !self,
      // Solo el tipo («DNI», «Pasaporte»): el número lo escribe la persona.
      documentLabel: signer?.docType ? documentText(signer.docType, "").trim() : null,
    },
  }
}

/** Firma en su enlace: escribe su documento y firma con el dedo; el profesional confirma en la cita. */
export async function signPersonalLinkConsent(
  tx: Db,
  orgId: string,
  token: string,
  consentId: string,
  input: { docNumber: string; comprehensionConfirmed: boolean; signatureData: unknown },
): Promise<{ signed: true }> {
  const link = await requireLiveLink(tx, orgId, token, true)
  if (!link.patientId) throw linkExpired()
  await requireLinkConsent(tx, orgId, link, consentId)
  await signConsentByLink(tx, orgId, link.row.contactId, consentId, input)
  return { signed: true }
}

// ---------------------------------------------------------- cuestionario ---

export async function getPersonalLinkQuestionnaire(tx: Db, orgId: string, token: string) {
  const link = await requireLiveLink(tx, orgId, token)
  if (!link.patientId || !(await questionnaireOf(tx, orgId, link))) throw linkExpired()
  const pending = await pendingQuestionnaire(tx, orgId, link.patientId)
  if (!pending) throw linkExpired()
  return pending
}

export async function submitPersonalLinkQuestionnaire(
  tx: Db,
  orgId: string,
  token: string,
  answers: unknown,
): Promise<{ submitted: true }> {
  const link = await requireLiveLink(tx, orgId, token, true)
  if (!link.patientId || !(await questionnaireOf(tx, orgId, link))) throw linkExpired()
  return submitQuestionnaireFromLink(tx, { orgId, patientId: link.patientId, contactId: link.row.contactId }, answers)
}

// ------------------------------------------------- enviarle su enlace ---

const OPTED_OUT = "Pidió no recibir recordatorios: díselo en persona o por teléfono, o envíaselo si te escribe por WhatsApp."
const NO_ADDRESS = "Falta la dirección pública de la clínica: no hay enlace que enviar."

export interface PersonalLinkSendPreview {
  recipient: { contactId: string; name: string; relation: string }
  channel: "whatsapp" | "email" | null
  via: "respuesta" | "plantilla" | "correo" | null
  /** «Enviar por WhatsApp» o «Enviar por correo». */
  label: string | null
  /** Por qué no se puede enviar. */
  blocked: string | null
  text: string
}

async function personalLinkMessage(tx: Db, orgId: string, recipientName: string) {
  const spec = await currentCatalogMessage(tx, orgId, PERSONAL_LINK_MESSAGE_KEY)
  const { params, text } = renderMessage(spec, {
    persona: firstName({ givenNames: null, displayName: recipientName }),
    clinica: await findClinicName(tx, orgId),
  })
  return { spec, params, text }
}

/** Lo que dice «Enviarle su enlace» antes de enviar: a quién y por dónde, sin abrir ni escribir nada. */
export async function previewPersonalLinkSend(tx: Db, orgId: string, patientId: string): Promise<PersonalLinkSendPreview> {
  const recipient = await serviceRecipient(tx, orgId, patientId)
  const { spec, text } = await personalLinkMessage(tx, orgId, recipient.displayName)
  const base = { recipient: { contactId: recipient.contactId, name: recipient.displayName, relation: recipient.relation }, text }
  if ((await personalLinkUrl(tx, orgId, "0".repeat(64))) === null) {
    return { ...base, channel: null, via: null, label: null, blocked: NO_ADDRESS }
  }
  const route = await previewMessageRoute(tx, orgId, recipient.contactId, spec)
  if ("cause" in route) return { ...base, channel: null, via: null, label: null, blocked: route.detail }
  if (route.via !== "respuesta" && !(await mayWriteFirst(tx, orgId, recipient.contactId, "recordatorio"))) {
    return { ...base, channel: null, via: null, label: null, blocked: OPTED_OUT }
  }
  return {
    ...base,
    channel: route.channel,
    via: route.via,
    label: route.channel === "whatsapp" ? "Enviar por WhatsApp" : "Enviar por correo",
    blocked: null,
  }
}

export interface PersonalLinkSent {
  conversationId: string
  messageId: string
  status: "queued"
  channel: "whatsapp" | "email"
  via: "respuesta" | "plantilla" | "correo"
  recipientName: string
}

/**
 * «Enviarle su enlace» (recepción, decisión 8): le llega a la persona, o a su
 * representante legal si es menor, por la regla de siempre (WhatsApp primero
 * y, si no, correo). Es parte del servicio, como el aviso de su cita: no pide
 * permiso y deja de salir solo si se dio de baja de los recordatorios. Una
 * misma `requestId` no lo envía dos veces.
 */
export async function sendPersonalLink(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { patientId: string; requestId?: string | null },
  deps: { secretsKey: Buffer },
): Promise<PersonalLinkSent> {
  if (input.requestId) {
    const lockKey = `su-enlace-envio:${orgId}:${input.requestId}`
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`)
    const [previous] = await tx
      .select({ entityId: auditEvent.entityId, metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.organizationId, orgId),
          eq(auditEvent.action, "personal_link.sent"),
          sql`${auditEvent.metadata}->>'requestId' = ${input.requestId}`,
        ),
      )
      .limit(1)
    if (previous) {
      const sent = previous.metadata as Partial<PersonalLinkSent>
      return {
        conversationId: sent.conversationId ?? "",
        messageId: previous.entityId ?? "",
        status: "queued",
        channel: sent.channel ?? "whatsapp",
        via: sent.via ?? "respuesta",
        recipientName: sent.recipientName ?? "",
      }
    }
  }
  const recipient = await serviceRecipient(tx, orgId, input.patientId)
  const { spec, params, text } = await personalLinkMessage(tx, orgId, recipient.displayName)
  const route = await routeMessage(tx, orgId, recipient.contactId, spec)
  if ("cause" in route) throw new ServiceError("LINK_NO_ROUTE", 409, `No se pudo enviar: ${route.detail}`)
  if (route.via !== "respuesta" && !(await mayWriteFirst(tx, orgId, recipient.contactId, "recordatorio"))) {
    throw new ServiceError("LINK_OPTED_OUT", 409, OPTED_OUT)
  }
  const link = await issuePersonalLink(
    tx,
    orgId,
    { contactId: recipient.contactId, patientId: input.patientId, createdBy: actorUserId },
    deps,
  )
  const url = await personalLinkUrl(tx, orgId, link.token)
  if (!url) throw new ServiceError("NO_PUBLIC_URL", 409, NO_ADDRESS)
  let sent: { id: string }
  if (route.via === "plantilla" && route.template) {
    sent = await sendTemplateOutbound(tx, orgId, deps.secretsKey, {
      conversationId: route.conversationId,
      senderKind: "user",
      senderUserId: actorUserId,
      name: route.template.name,
      language: route.template.language,
      params,
      buttons: spec.buttons.map((button) => ({ id: replyId(button.action, link.linkId), title: button.title })),
      link: link.token,
      preview: text,
    })
  } else {
    const body = withLinkLine(text, spec.link, url)
    sent = await sendOutbound(tx, orgId, {
      conversationId: route.conversationId,
      senderKind: "user",
      senderUserId: actorUserId,
      content: {
        type: "text",
        text: route.via === "correo" ? `${PERSONAL_LINK_SUBJECT} · ${await findClinicName(tx, orgId)}\n\n${body}` : body,
      },
    })
  }
  const result: PersonalLinkSent = {
    conversationId: route.conversationId,
    messageId: sent.id,
    status: "queued",
    channel: route.channel,
    via: route.via,
    recipientName: recipient.displayName,
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "personal_link.sent",
    entity: "message",
    entityId: sent.id,
    metadata: {
      patientId: input.patientId,
      recipientContactId: recipient.contactId,
      conversationId: route.conversationId,
      channel: route.channel,
      via: route.via,
      recipientName: recipient.displayName,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    },
  })
  return result
}

// ------------------------------------------- enlaces de correo: /c/:token ---

/**
 * Los enlaces de confirmar o cancelar de un correo (`/c/:token`) solo llevan a
 * «Su enlace» (ADR 0037): con el token del correo, aún vigente, se da el
 * enlace de esa persona con esa cita, donde confirma, cambia o cancela.
 */
export async function personalLinkForEmailToken(
  tx: Db,
  orgId: string,
  rawToken: string,
  deps: { secretsKey: Buffer },
): Promise<{ token: string; url: string | null }> {
  const hash = createHash("sha256").update(rawToken).digest("hex")
  const [row] = await tx
    .select()
    .from(automationLinkToken)
    .where(and(eq(automationLinkToken.organizationId, orgId), eq(automationLinkToken.tokenHash, hash)))
    .limit(1)
  if (!row || row.purpose === "baja" || !row.appointmentId || !row.contactId || row.expiresAt.getTime() <= Date.now()) {
    throw linkExpired()
  }
  const [appt] = await tx
    .select({ patientId: appointment.patientId })
    .from(appointment)
    .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, row.appointmentId)))
    .limit(1)
  if (!appt) throw linkExpired()
  const link = await issuePersonalLink(
    tx,
    orgId,
    { contactId: row.contactId, patientId: appt.patientId, appointmentId: row.appointmentId },
    deps,
  )
  return { token: link.token, url: await personalLinkUrl(tx, orgId, link.token) }
}
