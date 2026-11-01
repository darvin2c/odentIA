import { createHash } from "node:crypto"
import {
  clinicalProfileFor,
  documentIssuerCountry,
  documentText,
  documentTypeProfile,
  identityDocumentError,
  isMinor,
  isRealDate,
  type MissingPersonDatum,
  normalizePhone,
  phoneFormatError,
  productWords,
  type RegistrationConfig,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment, appointmentBookingLink } from "@odentia/db/schema/agenda"
import { automationLinkToken } from "@odentia/db/schema/automation"
import {
  patientDataConsent,
  patientResponsibility,
  paymentTicket,
  prescription,
} from "@odentia/db/schema/clinical"
import { consentDocument } from "@odentia/db/schema/clinical-forms"
import { contact } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, or, sql } from "drizzle-orm"
import { getMessagePermissions, setConsent, setMessageChoice } from "./automation.js"
import {
  NOTICE_PURPOSE,
  PERSONAL_LINK_MESSAGE_KEY,
  PERSONAL_LINK_SUBJECT,
  renderMessage,
  replyButtons,
  withLinkLine,
} from "./automation-messages.js"
import { clinicName as findClinicName, firstName } from "./automation-routing.js"
import {
  appointmentView,
  type BookingLinkAppointment,
  type BookingLinkBranch,
  bookingContext,
  clinicNameOf,
  hasSchedulableItems,
  issuePersonalLink,
  linkContactFirstName,
  linkExpired,
  patientFirstNameOf,
  type ResolvedPersonalLink,
  requireLinkDecider,
  requireLiveLink,
  reserveBookingLink,
  resolvePersonalLink,
  tellConversation,
} from "./booking-links.js"
import { serviceRecipient } from "./budget-send.js"
import { listBudgets } from "./budgets.js"
import { currentCatalogMessage } from "./clinic-messages.js"
import {
  type DeclaredPatientHealthInput,
  getPatientHealth,
  initializeDeclaredPatientHealth,
} from "./clinical.js"
import { type SignatureEvidence, signConsentByLink } from "./clinical-forms.js"
import { sendOutbound, sendTemplateOutbound } from "./conversations.js"
import { createContactNote } from "./crm-workspace.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { buildTicketSnapshot, renderTicketPdf } from "./financial-document-pdf.js"
import { renderHealthDocumentPdf } from "./health-documents.js"
import { findOrgCountry, findOrgLocale, orgProduct } from "./locale.js"
import { openRoute, previewRoute } from "./message-gate.js"
import { consentStatusOf } from "./message-permission.js"
import { clinicAsksHealth, getPatientMissingData, getPatientRegistrationConfig } from "./patient-registration.js"
import {
  patientOrganizationToday,
  patientPersonId,
  requirePatient,
  updatePatient,
} from "./patients.js"
import { personalLinkRef } from "./personal-link-token.js"
import {
  type DecidePortalBudgetInput,
  decideBudgetByPerson,
  type PortalBudgetView,
  portalBudgetContext,
  toPortalBudget,
} from "./portal.js"
import { pendingQuestionnaire, submitQuestionnaireFromLink } from "./portal-questionnaire.js"
import { personalLinkMessageUrl, personalLinkUrl } from "./public-links.js"
import { contactDecides } from "./responsibilities.js"
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

/**
 * «Tus mensajes» (ADR 0040): los tres interruptores de quien abre su enlace y
 * si pidió no recibir ningún mensaje. Los avisos de su cita y sus papeles no
 * son un interruptor: siempre llegan, salvo con «ningún mensaje».
 */
export interface PersonalLinkMessages {
  recordatorio: boolean
  seguimiento: boolean
  novedades: boolean
  /** Pidió «No quiero ningún mensaje de la clínica»: los interruptores se ven apagados. */
  nothing: boolean
}

/** Un papel en «Tus papeles» (decisión 8): la receta o el comprobante, para descargar 30 días. */
export interface PersonalLinkPaper {
  kind: "receta" | "comprobante"
  id: string
  title: string
  issuedAt: string
  /** Hasta cuándo se descarga desde aquí; después se le pide a la clínica. */
  availableUntil: string
}

/** Cuánto queda un papel en «Tus papeles»: después se le pide a la clínica. */
export const PAPER_DAYS = 30

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
  /**
   * Tus datos: qué falta y si se le pregunta su salud (opcional). Con `missing`
   * vacío solo queda su salud por contar.
   */
  data: {
    missing: MissingPersonDatum[] /** Si también se le pregunta su salud. */
    health: boolean
  } | null
  /**
   * Quien ya es paciente y decide por él, al reservar: lo que ya sabemos, para
   * que no lo vuelva a escribir. El documento va abreviado: el enlace prueba
   * que tiene su chat, no quién es. Sus nombres y apellidos, para que corrija
   * el que no es suyo (`PersonalLinkDataInput.name`).
   */
  you: { name: string; givenNames: string | null; familyName: string | null; document: string | null; phone: string | null } | null
  /**
   * Lo que aún no aceptó o no respondió: se le pide en el mismo paso en que
   * reserva. `promotionsOffer`: dijo que no a novedades y promociones; se le
   * ofrece una casilla sin marcar para recibirlas, sin pedirle respuesta.
   */
  pending: { privacy: boolean; promotions: boolean; promotionsOffer: boolean } | null
  /** Presupuestos que esperan su respuesta. */
  budgets: PortalBudgetView[]
  /** Consentimientos que la clínica le envió a firmar. */
  consents: PersonalLinkConsent[]
  /** «Antes de tu cita», si hay uno por responder. */
  questionnaire: { title: string } | null
  /** «Tus mensajes»: solo para quien recibe los mensajes de este paciente (quien decide por él). */
  messages: PersonalLinkMessages | null
  /** «Tus papeles»: la receta y el comprobante de los últimos 30 días, solo para quien decide. */
  papers: PersonalLinkPaper[]
}

/*
 * Todo lo que no es su cita es de quien decide por el paciente (`link.decides`):
 * la propia persona mayor de edad o su representante legal vigente. Un
 * familiar o un autorizado que abre el enlace ve solo su cita.
 */

async function missingOf(
  tx: Db,
  orgId: string,
  link: ResolvedPersonalLink,
): Promise<MissingPersonDatum[] | null> {
  if (!link.patientId || !link.decides || link.row.dataSubmittedAt || link.expired) return null
  const missing = await getPatientMissingData(tx, orgId, link.patientId)
  return missing.length > 0 ? missing : null
}

/**
 * Su salud se le pregunta (opcional) solo si la clínica la pregunta y nadie la
 * registró en su ficha, y solo a quien decide por el paciente.
 */
async function healthPendingOf(
  tx: Db,
  orgId: string,
  link: ResolvedPersonalLink,
): Promise<boolean> {
  if (!link.patientId || !link.decides || link.row.dataSubmittedAt || link.expired) return false
  if (!(await clinicAsksHealth(tx, orgId))) return false
  return healthNeverRecorded(tx, orgId, link.patientId)
}

/** «DNI ••••8912»: el documento abreviado, para que reconozca el suyo sin mostrarlo entero. */
function shortDocument(docType: string | null, docNumber: string | null): string | null {
  if (!docNumber) return null
  return `${docType ?? "Documento"} ••••${docNumber.slice(-4)}`
}

/**
 * Lo que la página muestra a quien ya es paciente al reservar: su nombre, su
 * documento abreviado y su celular, y lo que aún le falta aceptar o responder.
 */
async function youOf(
  tx: Db,
  orgId: string,
  link: ResolvedPersonalLink,
): Promise<Pick<PersonalLinkView, "you" | "pending">> {
  if (!link.patientId || !link.decides || link.expired) return { you: null, pending: null }
  const person = link.canBook ? await requirePatient(tx, orgId, link.patientId) : null
  return {
    you: person
      ? {
          name: person.displayName,
          givenNames: person.givenNames ?? null,
          familyName: person.familyName ?? null,
          document: shortDocument(person.docType, person.docNumber),
          phone: person.phone ?? null,
        }
      : null,
    // También al cambiar su cita o agendar lo aceptado: lo que no respondió se le pregunta ahí.
    pending: await pendingOf(tx, orgId, link.row.contactId, link.patientId),
  }
}

/**
 * Si aún no aceptó el aviso de privacidad, si nunca respondió lo de novedades
 * y promociones y si les dijo que no (menos a quien no quiere ningún mensaje).
 */
async function pendingOf(
  tx: Db,
  orgId: string,
  contactId: string,
  patientId: string,
): Promise<{ privacy: boolean; promotions: boolean; promotionsOffer: boolean }> {
  const config = await getPatientRegistrationConfig(tx, orgId)
  const [accepted] = await tx
    .select({ id: patientDataConsent.id })
    .from(patientDataConsent)
    .where(
      and(
        eq(patientDataConsent.organizationId, orgId),
        eq(patientDataConsent.patientId, patientId),
        isNull(patientDataConsent.revokedAt),
      ),
    )
    .limit(1)
  const promotions = config.askMessages ? await consentStatusOf(tx, orgId, contactId, "novedades") : "granted"
  return {
    privacy: !accepted && !!config.privacyNotice,
    promotions: promotions === null,
    promotionsOffer: promotions !== null && promotions !== "granted" && (await consentStatusOf(tx, orgId, contactId, "avisos")) !== "revoked",
  }
}

async function budgetsOf(
  tx: Db,
  orgId: string,
  link: ResolvedPersonalLink,
): Promise<PortalBudgetView[]> {
  if (!link.patientId || !link.decides || link.expired) return []
  const budgets = (await listBudgets(tx, orgId, link.patientId)).filter(
    (budget) => budget.status !== "borrador" && budget.awaitsAnswer,
  )
  if (budgets.length === 0) return []
  // `link.decides` ya dijo que es la propia persona o su representante.
  const context = await portalBudgetContext(
    tx,
    orgId,
    budgets.map((budget) => budget.id),
    true,
  )
  return budgets.map((budget) => toPortalBudget(budget, context))
}

async function consentsOf(
  tx: Db,
  orgId: string,
  link: ResolvedPersonalLink,
): Promise<PersonalLinkConsent[]> {
  if (!link.patientId || !link.decides || link.expired) return []
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

/**
 * Quien elige sus mensajes en su enlace: la persona que lo recibe, si decide
 * por el paciente (la propia persona mayor de edad o su representante legal;
 * en un menor, quien recibe sus mensajes, ADR 0040) o si aún no es paciente.
 * Un familiar o un autorizado ve solo su cita.
 */
function choosesMessages(link: ResolvedPersonalLink): boolean {
  return link.live && !link.expired && (link.patientId === null || link.decides)
}

async function messagesOf(
  tx: Db,
  orgId: string,
  link: ResolvedPersonalLink,
): Promise<PersonalLinkMessages | null> {
  if (!choosesMessages(link)) return null
  const permissions = await getMessagePermissions(tx, orgId, link.row.contactId)
  const of = (purpose: string) =>
    permissions.find((item) => item.purpose === purpose)?.granted ?? null
  const nothing = of("avisos") === false
  return {
    // Recordatorios y seguimiento llegan salvo que los haya apagado; novedades, solo con su sí.
    recordatorio: !nothing && of("recordatorio") !== false,
    seguimiento: !nothing && of("seguimiento") !== false,
    novedades: !nothing && of("novedades") === true,
    nothing,
  }
}

/**
 * «Tus papeles» (decisión 8): la receta emitida y el comprobante (el ticket del
 * cobro, sin anular) de los últimos 30 días, del paciente de quien decide por
 * él (la regla de `requireDecisionContact`). Después se le piden a la clínica.
 */
async function papersOf(
  tx: Db,
  orgId: string,
  link: ResolvedPersonalLink,
): Promise<PersonalLinkPaper[]> {
  if (!link.patientId || !link.decides || link.expired) return []
  const since = new Date(Date.now() - PAPER_DAYS * 86_400_000)
  const until = (at: Date) => new Date(at.getTime() + PAPER_DAYS * 86_400_000).toISOString()
  const recipes = await tx
    .select({
      id: prescription.id,
      number: prescription.prescriptionNumber,
      at: prescription.issuedAt,
    })
    .from(prescription)
    .where(
      and(
        eq(prescription.organizationId, orgId),
        eq(prescription.patientId, link.patientId),
        eq(prescription.status, "emitida"),
        gte(prescription.issuedAt, since),
      ),
    )
    .orderBy(desc(prescription.issuedAt))
  const tickets = await tx
    .select({
      id: paymentTicket.id,
      number: paymentTicket.ticketNumber,
      at: paymentTicket.createdAt,
    })
    .from(paymentTicket)
    .where(
      and(
        eq(paymentTicket.organizationId, orgId),
        eq(paymentTicket.patientId, link.patientId),
        isNull(paymentTicket.voidedAt),
        gte(paymentTicket.createdAt, since),
      ),
    )
    .orderBy(desc(paymentTicket.createdAt))
  return [
    ...recipes.map((row) => ({
      kind: "receta" as const,
      id: row.id,
      title: `Receta N.º ${row.number}`,
      issuedAt: row.at.toISOString(),
      availableUntil: until(row.at),
    })),
    ...tickets.map((row) => ({
      kind: "comprobante" as const,
      id: row.id,
      title: `Comprobante N.º ${String(row.number).padStart(6, "0")}`,
      issuedAt: row.at.toISOString(),
      availableUntil: until(row.at),
    })),
  ].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
}

/** El cuestionario sale antes de una cita: con una por venir y mientras no lo haya enviado. */
async function questionnaireOf(
  tx: Db,
  orgId: string,
  link: ResolvedPersonalLink,
): Promise<{ title: string } | null> {
  if (
    !link.patientId ||
    !link.decides ||
    link.expired ||
    !link.appointment ||
    link.appointment.status === "cancelada"
  )
    return null
  const pending = await pendingQuestionnaire(tx, orgId, link.patientId)
  return pending ? { title: pending.title } : null
}

export async function getPersonalLinkView(
  tx: Db,
  orgId: string,
  token: string,
): Promise<PersonalLinkView> {
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
    you: null,
    pending: null,
    budgets: [],
    consents: [],
    questionnaire: null,
    messages: null,
    papers: [],
  }
  if (!link.live) return empty
  const appointment = link.appointment
    ? await appointmentView(tx, orgId, link.appointment.id)
    : null
  const missing = await missingOf(tx, orgId, link)
  const health = await healthPendingOf(tx, orgId, link)
  const budgets = await budgetsOf(tx, orgId, link)
  const consents = await consentsOf(tx, orgId, link)
  const questionnaire = await questionnaireOf(tx, orgId, link)
  const messages = await messagesOf(tx, orgId, link)
  const papers = await papersOf(tx, orgId, link)
  // Las sedes, para reservar o para agendar lo aceptado de su presupuesto (también después de responderlo).
  const schedulable =
    !link.canBook &&
    budgets.length === 0 &&
    link.patientId !== null &&
    link.decides &&
    !link.expired &&
    (await hasSchedulableItems(tx, orgId, link.patientId))
  const context =
    link.canBook || budgets.length > 0 || schedulable
      ? await bookingContext(tx, orgId, link.row)
      : null
  // «Tus mensajes» siempre sirve a quien los recibe: el enlace no vence por no tener otra cosa pendiente.
  const nothing =
    !link.canBook &&
    !appointment &&
    !missing &&
    !health &&
    budgets.length === 0 &&
    consents.length === 0 &&
    !questionnaire &&
    !messages &&
    papers.length === 0
  if (nothing) return empty
  const self = link.patientId
    ? (await patientPersonId(tx, orgId, link.patientId)) === link.row.contactId
    : true
  return {
    ...base,
    status: "abierto",
    firstName: await linkContactFirstName(tx, orgId, link.row.contactId),
    patientFirstName:
      link.patientId && !self ? await patientFirstNameOf(tx, orgId, link.patientId) : null,
    booking:
      link.canBook && context
        ? {
            needsRegistration: link.patientId === null,
            service: context.service,
            branchId: context.branchId,
          }
        : null,
    branches: context?.branches ?? [],
    appointment,
    data: missing || health ? { missing: missing ?? [], health } : null,
    ...(await youOf(tx, orgId, link)),
    budgets,
    consents,
    questionnaire,
    messages,
    papers,
  }
}

// --------------------------------------------------------- tus mensajes ---

/**
 * La persona cambia un interruptor de «Tus mensajes», o pide no recibir
 * ningún mensaje (`ninguno`). Es la misma operación que el botón «No más
 * recordatorios», recepción y el agente (`setMessageChoice`), con origen
 * «enlace» y a nombre de la persona.
 */
export async function setPersonalLinkMessages(
  tx: Db,
  orgId: string,
  token: string,
  input: { tipo: string; recibir: boolean },
): Promise<PersonalLinkMessages> {
  const link = await requireLiveLink(tx, orgId, token, true)
  if (!choosesMessages(link))
    throw new ServiceError(
      "PORTAL_FORBIDDEN",
      404,
      "Este enlace no puede elegir los mensajes de esta persona",
    )
  const { purposes } = await setMessageChoice(tx, orgId, null, link.row.contactId, {
    choice: input.tipo,
    receive: input.recibir,
    source: "enlace",
  })
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: `contact:${link.row.contactId}`,
    action: "personal_link.messages_chosen",
    entity: "contact",
    entityId: link.row.contactId,
    metadata: { choice: input.tipo, receive: input.recibir, purposes, origin: "paciente" },
  })
  const messages = await messagesOf(tx, orgId, link)
  if (!messages) throw linkExpired()
  return messages
}

// ----------------------------------------------------------- tus papeles ---

/**
 * Descarga un papel de «Tus papeles»: solo uno de la lista de quien decide
 * por el paciente y de los últimos 30 días. Es el mismo PDF que se imprime.
 */
export async function getPersonalLinkPaper(
  tx: Db,
  orgId: string,
  token: string,
  input: { kind: string; id: string },
): Promise<{ bytes: Uint8Array; filename: string }> {
  const link = await requireLiveLink(tx, orgId, token)
  const patientId = requireLinkDecider(link)
  const paper = (await papersOf(tx, orgId, link)).find(
    (item) => item.kind === input.kind && item.id === input.id,
  )
  if (!paper) {
    throw new ServiceError(
      "PAPER_UNAVAILABLE",
      409,
      `Este papel ya no está aquí: pasados ${PAPER_DAYS} días, pídeselo a la clínica.`,
    )
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: `contact:${link.row.contactId}`,
    action: "personal_link.paper_downloaded",
    entity: paper.kind === "receta" ? "prescription" : "payment_ticket",
    entityId: paper.id,
    metadata: { patientId, origin: "paciente" },
  })
  if (paper.kind === "receta") {
    const rendered = await renderHealthDocumentPdf(tx, orgId, patientId, "prescription", paper.id)
    return { bytes: rendered.bytes, filename: rendered.filename }
  }
  const snap = await buildTicketSnapshot(tx, orgId, patientId, paper.id)
  return {
    bytes: await renderTicketPdf(snap, null),
    filename: `Comprobante-${snap.numberLabel}.pdf`,
  }
}

// ------------------------------------------------------------- tus datos ---

/** Lo que «Tus datos» puede completar: solo lo que falta, y lo que va con ello. */
const DATA_FIELDS = [
  "givenNames",
  "familyName",
  "birthDate",
  "docType",
  "docNumber",
  "docCountry",
  "sex",
  "nationality",
  "birthPlace",
  "phone",
  "email",
  "address",
  "addressCity",
  "addressReference",
  "emergencyContactName",
  "emergencyContactPhone",
  "emergencyContactRelationship",
  "insuranceType",
  "insuranceScheme",
  "insurerName",
  "affiliationNumber",
] as const
type DataField = (typeof DATA_FIELDS)[number]

/** De cada dato que falta, lo que se puede escribir para completarlo. */
function fieldsFor(missing: MissingPersonDatum[]): Set<DataField> {
  const allowed = new Set<DataField>()
  for (const item of missing) {
    if (item.key === "docType" || item.key === "docNumber") {
      allowed.add("docType")
      allowed.add("docNumber")
      allowed.add("docCountry")
    } else if (item.key === "phone") {
      allowed.add("phone")
      allowed.add("email")
    } else if (item.key === "address") {
      allowed.add("address")
      allowed.add("addressCity")
      allowed.add("addressReference")
    } else if (item.key === "emergencyContactName") {
      allowed.add("emergencyContactName")
      allowed.add("emergencyContactPhone")
      allowed.add("emergencyContactRelationship")
    } else if (item.key === "insuranceType") {
      allowed.add("insuranceType")
      allowed.add("insuranceScheme")
      allowed.add("insurerName")
      allowed.add("affiliationNumber")
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
  /** El registro de la clínica: qué pide, qué es obligatorio y las preguntas de salud. */
  registration: RegistrationConfig
  /**
   * Si se le pregunta su salud: solo mientras nadie la registró en su ficha
   * (lo declarado entra a revisión; lo que ya registró la clínica no se pisa).
   */
  asksHealth: boolean
  /** Su primer nombre, para saludarla; nulo si no se sabe. */
  firstName: string | null
  /** Lo que aún no aceptó o respondió (registrada por teléfono, por ejemplo): va al final, antes de enviar. */
  pending: { privacy: boolean; promotions: boolean }
}

/** Lo que pide «Tus datos»: solo lo que falta, con el país de la clínica para los documentos. */
export async function getPersonalLinkDataForm(
  tx: Db,
  orgId: string,
  token: string,
): Promise<PersonalLinkDataForm> {
  const link = await requireLiveLink(tx, orgId, token)
  const missing = await missingOf(tx, orgId, link)
  const health = await healthPendingOf(tx, orgId, link)
  if ((!missing && !health) || !link.patientId) throw linkExpired()
  return {
    missing: missing ?? [],
    countryCode: await findOrgCountry(tx, orgId),
    today: await patientOrganizationToday(tx, orgId),
    hasRepresentative: await hasLegalRepresentative(tx, orgId, link.patientId),
    registration: await getPatientRegistrationConfig(tx, orgId),
    asksHealth: health,
    firstName: firstName(await requirePatient(tx, orgId, link.patientId)) || null,
    pending: await pendingOf(tx, orgId, link.row.contactId, link.patientId),
  }
}

/** Nadie registró aún su salud: se le puede preguntar desde su enlace. */
async function healthNeverRecorded(tx: Db, orgId: string, patientId: string): Promise<boolean> {
  return (await getPatientHealth(tx, orgId, patientId)).revision === 0
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
  /** Su salud, como en el registro; solo se guarda si nadie la registró antes. */
  health?: DeclaredPatientHealthInput | null
  /** Acepta el aviso de privacidad que aún no había aceptado (registrada por teléfono, por ejemplo). */
  privacyAccepted?: boolean
  /** Su respuesta a novedades y promociones, si nunca la había dado, o su sí si antes dijo que no. */
  acceptsPromotions?: boolean
  /**
   * Su nombre, si el de su ficha no es el suyo. Con un documento guardado se
   * le pide entero (`docNumber`) y debe ser el mismo (`correctLinkName`).
   */
  name?: { givenNames: string; familyName: string; docNumber?: string } | null
  /** Dejó su celular y se le dijo que le escribiremos por WhatsApp sobre sus citas. */
  acceptsReminders?: true
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

/** Los datos de su representante, revisados con las reglas del país; el error dice qué arreglar. */
function representativeOf(
  input: PersonalLinkDataInput["representative"],
  countryCode: string | null,
): { name: string; document: string | null; phone: string | null; relation: string | null } {
  const name = input?.displayName?.trim() ?? ""
  if (!name)
    throw new ServiceError(
      "REPRESENTATIVE_REQUIRED",
      409,
      "Como es menor de edad, completa los datos de su madre, padre o tutor",
    )
  if (name.length > 200) throw validation("El nombre de su madre, padre o tutor es muy largo")
  const docNumber = input?.docNumber?.trim() || null
  const docType = input?.docType?.trim() || null
  let document: string | null = null
  if (docNumber) {
    const profile = clinicalProfileFor(countryCode)
    if (!docType || !documentTypeProfile(profile, docType))
      throw validation("Elige el tipo de documento de su madre, padre o tutor")
    const problem = identityDocumentError(docType, docNumber)
    if (problem) throw validation(problem)
    document = documentText(docType, docNumber)
  }
  const phone = input?.phone?.trim() ? normalizePhone(input.phone, countryCode) : null
  if (input?.phone?.trim() && !phone) throw validation(phoneFormatError(countryCode))
  return { name, document, phone, relation: input?.relationshipDetail?.trim() || null }
}

/**
 * La persona envía lo que le faltaba, una sola vez. Se guarda con las reglas
 * de la ficha (`updatePatient`, a su nombre). Si la fecha la hace menor y no
 * tiene representante legal, desde el enlace no se registra a nadie: la fecha
 * no se guarda (la ficha sigue con «Faltan datos»), lo que escribió de su
 * madre, padre o tutor queda en una nota y a recepción le llega la tarea de
 * registrarlo con su documento. Si el documento ya es de otra persona no se
 * guarda, nunca se unen solas, y a recepción le llega «Posible ficha
 * repetida» en «Te espera»; a la persona no se le dice de quién es. Una nota
 * de su persona dice qué completó y qué sigue faltando.
 */
export async function submitPersonalLinkData(
  tx: Db,
  orgId: string,
  token: string,
  input: PersonalLinkDataInput,
  deps: { secretsKey?: Buffer } = {},
): Promise<{ received: true }> {
  const link = await requireLiveLink(tx, orgId, token, true)
  const missing = await missingOf(tx, orgId, link)
  const health = await healthPendingOf(tx, orgId, link)
  const patientId = link.patientId
  if ((!missing && !health) || !patientId) {
    if (patientId && !link.decides) requireLinkDecider(link)
    throw new ServiceError("DATA_ALREADY_SENT", 409, "Tus datos ya están en la clínica.")
  }
  await saveLinkData(tx, orgId, link, patientId, missing ?? [], input, {
    // Si solo quedaba su salud, que es opcional, enviarla en blanco también es responder.
    requireSomething: Boolean(missing),
    toldWhatsApp: input.acceptsReminders === true && !!input.data.phone?.trim(),
  })
  // «Tus datos» se envían una sola vez: después dice «Recibido».
  await tx
    .update(appointmentBookingLink)
    .set({ dataSubmittedAt: new Date() })
    .where(
      and(
        eq(appointmentBookingLink.organizationId, orgId),
        eq(appointmentBookingLink.id, link.row.id),
      ),
    )
  await thankInChat(
    tx,
    orgId,
    link,
    {
      note: "Completó sus datos desde su enlace.",
      message: "Gracias, ya recibimos los datos.",
      key: `enlace-datos:${link.row.id}`,
      reason: "La persona completó sus datos desde su enlace",
      kind: "datos",
      title: "recibió sus datos",
    },
    deps,
  )
  return { received: true }
}

/**
 * Lo que escribió en su enlace (al enviar «Tus datos» o al reservar): solo lo
 * que falta, con las reglas de la ficha, y lo que aceptó o respondió. Una sola
 * operación para las dos pantallas.
 */
async function saveLinkData(
  tx: Db,
  orgId: string,
  link: ResolvedPersonalLink,
  patientId: string,
  missing: MissingPersonDatum[],
  input: PersonalLinkDataInput,
  options: {
    requireSomething: boolean /** La pantalla le dijo «Te escribiremos por WhatsApp sobre tu cita». */
    toldWhatsApp: boolean
  },
): Promise<void> {
  const allowed = fieldsFor(missing)
  const patch: Record<string, string | null> = {}
  for (const [key, raw] of Object.entries(input.data ?? {})) {
    if (!(DATA_FIELDS as readonly string[]).includes(key) || !allowed.has(key as DataField))
      continue
    const value = typeof raw === "string" ? raw.trim() : null
    if (value) patch[key] = value
  }
  const withHealth = !!input.health && (await healthNeverRecorded(tx, orgId, patientId))
  const renamed = input.name ? await correctLinkName(tx, orgId, link, patientId, input.name) : null
  const consented = await saveLinkConsents(tx, orgId, link, patientId, input, options.toldWhatsApp)
  if (Object.keys(patch).length === 0 && !withHealth && !renamed) {
    if (options.requireSomething && !consented) throw validation("Completa al menos un dato")
    return
  }
  const actor = `contact:${link.row.contactId}`
  const today = await patientOrganizationToday(tx, orgId)
  const countryCode = await findOrgCountry(tx, orgId)
  const personId = await patientPersonId(tx, orgId, patientId)
  // Menor sin representante: no se registra a nadie desde aquí; lo hace recepción con su documento.
  let pendingRepresentative: ReturnType<typeof representativeOf> | null = null
  if (
    patch.birthDate &&
    isRealDate(patch.birthDate) &&
    isMinor(patch.birthDate, today) &&
    !(await hasLegalRepresentative(tx, orgId, patientId))
  ) {
    pendingRepresentative = representativeOf(input.representative, countryCode)
    delete patch.birthDate
  }
  // Un documento que ya es de otra persona no se guarda: lo revisa recepción.
  let duplicateOf: { contactId: string; name: string } | null = null
  if (patch.docNumber) {
    const issuer = documentIssuerCountry(
      clinicalProfileFor(countryCode),
      patch.docType ?? null,
      patch.docCountry ?? null,
    )
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
  // Su salud entra como declarada por la persona: la revisa quien atiende.
  if (withHealth && input.health)
    await initializeDeclaredPatientHealth(tx, orgId, patientId, input.health, null)
  const person = await requirePatient(tx, orgId, patientId)
  const stillMissing = await getPatientMissingData(tx, orgId, patientId)
  if (personId) {
    const done = missing
      .filter((item) => !stillMissing.some((left) => left.key === item.key))
      .map((item) => item.label)
    const parts = [
      renamed ? `Corrigió su nombre desde su enlace: antes figuraba como ${renamed}.` : null,
      done.length > 0 ? `Completó desde su enlace: ${done.join(", ")}.` : renamed ? null : "Envió sus datos desde su enlace.",
      withHealth ? "Declaró su salud: queda por revisar en sus antecedentes." : null,
      stillMissing.length > 0
        ? `Sigue faltando: ${stillMissing.map((item) => item.label).join(", ")}.`
        : null,
      duplicateOf ? "El documento que escribió ya está en otra ficha: no se guardó." : null,
      pendingRepresentative
        ? `Dijo que es menor de edad (nació el ${input.data?.birthDate?.trim()}): la fecha no se guardó hasta registrar a su representante legal. Su madre, padre o tutor: ${[
            pendingRepresentative.name,
            pendingRepresentative.relation,
            pendingRepresentative.document,
            pendingRepresentative.phone,
          ]
            .filter(Boolean)
            .join(", ")}.`
        : null,
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
  if (pendingRepresentative) {
    await createTask(tx, orgId, {
      title: `Registrar a su representante legal: ${person.displayName}`,
      patientId,
      area: "recepcion",
      createdBy: "sistema",
      reason:
        "Dijo en su enlace que es menor de edad. Registra a su madre, padre o tutor con su documento y guarda su fecha de nacimiento: en sus notas está lo que escribió.",
      idempotencyKey: `registrar-representante:${patientId}`,
    })
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: actor,
    action: "personal_link.data_sent",
    entity: "patient",
    entityId: patientId,
    metadata: {
      fields: Object.keys(patch),
      health: withHealth,
      renamed: !!renamed,
      duplicate: !!duplicateOf,
      minorWithoutRepresentative: !!pendingRepresentative,
      origin: "paciente",
    },
  })
}

/** Sin espacios, puntos ni guiones y en mayúsculas: el mismo documento escrito de otra forma. */
const documentKey = (value: string) => value.replace(/[\s.-]/g, "").toUpperCase()

/**
 * Corrige su nombre desde su enlace, cuando el de su ficha no es el suyo (una
 * ficha de prueba, un nombre mal escrito o el de su perfil de WhatsApp). El
 * enlace prueba que tiene su chat, no quién es: si la ficha tiene documento,
 * se le pide entero y debe ser el mismo; sin documento manda el nombre que
 * escribe, como al registrarse (ADR 0108). Devuelve el nombre de antes, que
 * queda en sus notas, o null si no cambió nada.
 */
async function correctLinkName(
  tx: Db,
  orgId: string,
  link: ResolvedPersonalLink,
  patientId: string,
  input: NonNullable<PersonalLinkDataInput["name"]>,
): Promise<string | null> {
  if (!link.decides) return null
  const givenNames = input.givenNames.trim().replace(/\s+/g, " ")
  const familyName = input.familyName.trim().replace(/\s+/g, " ")
  if (!givenNames) throw validation("Escribe tus nombres")
  if (!familyName) throw validation("Escribe tus apellidos")
  const person = await requirePatient(tx, orgId, patientId)
  if (person.givenNames === givenNames && person.familyName === familyName) return null
  if (person.docNumber && documentKey(input.docNumber ?? "") !== documentKey(person.docNumber)) {
    throw validation(`Ese ${person.docType ?? "documento"} no es el de esta ficha. Si no es la tuya, escríbenos por el chat.`)
  }
  await updatePatient(tx, orgId, `contact:${link.row.contactId}`, patientId, { givenNames, familyName })
  return person.displayName
}

/**
 * Lo que acepta o responde en su enlace quien decide por el paciente: el aviso
 * de privacidad que aún no tenía (con la versión vigente, por el formulario
 * público) y novedades y promociones si nunca respondió. Si la pantalla le dijo
 * «Te escribiremos por WhatsApp sobre tu cita» (al reservar), queda el permiso de
 * sus recordatorios si no había ninguno. Nada de lo ya respondido se pisa, salvo un «no» a novedades que ahora es sí. Devuelve si guardó algo.
 */
async function saveLinkConsents(
  tx: Db,
  orgId: string,
  link: ResolvedPersonalLink,
  patientId: string,
  input: PersonalLinkDataInput,
  toldWhatsApp: boolean,
): Promise<boolean> {
  if (!link.decides) return false
  let saved = false
  if (input.privacyAccepted) {
    const [accepted] = await tx
      .select({ id: patientDataConsent.id })
      .from(patientDataConsent)
      .where(
        and(
          eq(patientDataConsent.organizationId, orgId),
          eq(patientDataConsent.patientId, patientId),
          isNull(patientDataConsent.revokedAt),
        ),
      )
      .limit(1)
    const config = await getPatientRegistrationConfig(tx, orgId)
    if (!accepted && config.privacyNotice) {
      const [grantor] = await tx
        .select({ name: contact.displayName })
        .from(contact)
        .where(and(eq(contact.organizationId, orgId), eq(contact.id, link.row.contactId)))
        .limit(1)
      await tx.insert(patientDataConsent).values({
        organizationId: orgId,
        patientId,
        noticeVersion: config.version,
        noticeText: config.privacyNotice,
        purposes: ["atencion", "recordatorios"],
        grantedByContactId: link.row.contactId,
        grantedByName: grantor?.name ?? "",
        channel: "formulario_publico",
        recordedBy: null,
      })
      saved = true
    }
  }
  if (
    toldWhatsApp &&
    (await consentStatusOf(tx, orgId, link.row.contactId, "recordatorio")) === null
  ) {
    await setConsent(tx, orgId, null, link.row.contactId, {
      purpose: "recordatorio",
      granted: true,
      source: "enlace",
    })
  }
  if (input.acceptsPromotions !== undefined) {
    // Un «no» de antes solo cambia por su sí: la casilla que se le ofrece al reservar (`promotionsOffer`).
    const status = await consentStatusOf(tx, orgId, link.row.contactId, "novedades")
    if (status === null || (input.acceptsPromotions && status !== "granted")) {
      await setConsent(tx, orgId, null, link.row.contactId, { purpose: "novedades", granted: input.acceptsPromotions, source: "enlace" })
      saved = true
    }
  }
  return saved
}

export interface PersonalLinkReservation {
  branchId: string
  startsAt: string
  professionalUserId: string
  roomId?: string
  planItemIds?: string[]
  /** Quien ya es paciente: lo que faltaba y lo que acepta, guardado en el mismo paso. */
  you?: PersonalLinkDataInput
}

/**
 * Reserva desde su enlace. Si ya es paciente, en el mismo paso se guarda lo
 * que faltaba de sus datos y lo que acepta (`saveLinkData`, la misma operación
 * de «Tus datos»); si la hora se ocupó, no se guarda nada y la página conserva
 * lo escrito. La cita la crea `reserveBookingLink`.
 */
export async function reservePersonalLink(
  tx: Db,
  orgId: string,
  token: string,
  input: PersonalLinkReservation,
  deps: { secretsKey?: Buffer } = {},
): Promise<BookingLinkAppointment> {
  const { you, ...choice } = input
  if (you) {
    const link = await requireLiveLink(tx, orgId, token, true)
    if (link.patientId && link.decides) {
      const missing = (await missingOf(tx, orgId, link)) ?? []
      await saveLinkData(tx, orgId, link, link.patientId, missing, you, {
        requireSomething: false,
        toldWhatsApp: true,
      }).catch((error: unknown) => {
        // Un dato mal escrito no es una hora ocupada: la página lo dice junto a sus datos, sin volver a elegir la hora.
        if (error instanceof ServiceError && error.code === "VALIDATION")
          throw new ServiceError("LINK_DATA_INVALID", 400, error.message)
        throw error
      })
    }
  }
  return reserveBookingLink(tx, orgId, token, choice, deps)
}

/**
 * Lo que a la clínica aún le falta de un paciente para reservarle con su sí en
 * el chat (ADR 0109): sus datos obligatorios (`getPatientMissingData`) y el
 * aviso de privacidad, si la clínica lo escribió y no lo aceptó. Con algo de
 * eso, el agente le da su enlace con la hora que eligió y ahí lo confirma al
 * reservar (`reservePersonalLink`). Vacío si no falta nada o si quien escribe
 * no decide por el paciente: a otro, su enlace solo le mostraría la cita.
 */
export async function chatBookingMissing(
  tx: Db,
  orgId: string,
  input: { contactId: string; patientId: string },
): Promise<string[]> {
  if (!(await contactDecides(tx, orgId, input.patientId, input.contactId))) return []
  const missing = (await getPatientMissingData(tx, orgId, input.patientId)).map((item) =>
    item.label.toLowerCase(),
  )
  const { privacy } = await pendingOf(tx, orgId, input.contactId, input.patientId)
  return privacy ? [...missing, "aceptar el aviso de privacidad"] : missing
}

/**
 * Al confirmar en la conversación la cita que reservó el agente (fase 3 del
 * lienzo «Su enlace y el código QR»): si al paciente le faltan datos y quien
 * escribe decide por él, su enlace con esa cita, para completarlos («Antes de
 * venir, completa tus datos aquí»), con el token escrito (lo redacta el
 * agente). Nulo si no falta nada, si quien escribe no decide por el paciente o
 * si la clínica no tiene dirección pública. Desde el ADR 0109, a quien le
 * falta algo el agente ya le da su enlace con la hora en vez de reservar por
 * el chat: esto queda para quien ya tenía una cita por venir.
 */
export async function bookedDataLink(
  tx: Db,
  orgId: string,
  input: {
    contactId: string
    patientId: string
    appointmentId: string | null
    /**
     * Recién registrado por el chat (ADR 0101): el enlace va siempre. Desde el ADR 0109 el agente
     * ya no registra por el chat; solo lo trae una cita propuesta antes de ese cambio.
     */
    always?: boolean
  },
  deps: { secretsKey: Buffer },
): Promise<{ missing: string[]; url: string } | null> {
  const missing = await getPatientMissingData(tx, orgId, input.patientId)
  if (missing.length === 0 && !input.always) return null
  if (!(await contactDecides(tx, orgId, input.patientId, input.contactId))) return null
  if ((await personalLinkUrl(tx, orgId, "0".repeat(64))) === null) return null
  const link = await issuePersonalLink(
    tx,
    orgId,
    // Se da para completar sus datos: una reserva sin usar no se impone a ese mensaje.
    {
      contactId: input.contactId,
      patientId: input.patientId,
      booking: false,
      ...(input.appointmentId ? { appointmentId: input.appointmentId } : {}),
    },
    deps,
  )
  const url = await personalLinkUrl(tx, orgId, link.token)
  return url ? { missing: missing.map((item) => item.label.toLowerCase()), url } : null
}

// ---------------------------------------------------------- presupuesto ---

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
  deps: { secretsKey?: Buffer } = {},
): Promise<PersonalLinkBudgetAnswer> {
  const link = await requireLiveLink(tx, orgId, token, true)
  const patientId = requireLinkDecider(link)
  const result = await decideBudgetByPerson(tx, orgId, {
    patientId,
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
    await thankInChat(
      tx,
      orgId,
      link,
      {
        note: `Respondió su presupuesto desde su enlace: ${result.budget.status}.`,
        message: "Gracias, ya recibimos la respuesta al presupuesto.",
        key: `enlace-presupuesto:${budgetId}:${result.budget.status}`,
        reason: "La persona respondió su presupuesto desde su enlace",
        kind: "presupuesto",
        title: "recibió su respuesta al presupuesto",
      },
      deps,
    )
  }
  const context = await portalBudgetContext(tx, orgId, [budgetId], true)
  return {
    budget: toPortalBudget(result.budget, context),
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

async function requireLinkConsent(
  tx: Db,
  orgId: string,
  link: ResolvedPersonalLink,
  consentId: string,
) {
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
export async function getPersonalLinkConsent(
  tx: Db,
  orgId: string,
  token: string,
  consentId: string,
): Promise<PersonalLinkConsentView> {
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

/**
 * Lo que hizo en su enlace se le agradece por su conversación, sin decir qué
 * procedimiento es: recepción lee la conversación y no la historia. Las palabras
 * sirven igual a quien se trata de tú o de usted. Pasadas las 24 horas de WhatsApp
 * sale «Recibido desde su enlace» en su lugar (ADR 0129).
 */
async function thankInChat(
  tx: Db,
  orgId: string,
  link: ResolvedPersonalLink,
  input: { note: string; message: string; key: string; reason: string; kind: string; title: string },
  deps: { secretsKey?: Buffer },
): Promise<void> {
  const { kind, title, ...said } = input
  const { timezone } = await findOrgLocale(tx, orgId)
  await tellConversation(
    tx,
    orgId,
    link.row,
    { ...said, done: { kind, title, at: new Date().toISOString(), timeZone: timezone } },
    deps,
  )
}

/** Firma en su enlace: escribe su documento y firma con el dedo; el profesional confirma en la cita. */
export async function signPersonalLinkConsent(
  tx: Db,
  orgId: string,
  token: string,
  consentId: string,
  input: { docNumber: string; comprehensionConfirmed: boolean; signatureData: unknown },
  evidence: SignatureEvidence = {},
  deps: { secretsKey?: Buffer } = {},
): Promise<{ signed: true }> {
  const link = await requireLiveLink(tx, orgId, token, true)
  if (!link.patientId) throw linkExpired()
  await requireLinkConsent(tx, orgId, link, consentId)
  await signConsentByLink(tx, orgId, link.row.contactId, consentId, input, evidence)
  const { clinician } = productWords(await orgProduct(tx, orgId))
  await thankInChat(
    tx,
    orgId,
    link,
    {
      note: "Firmó un consentimiento desde su enlace: falta que el profesional lo confirme en su cita.",
      message: `Gracias por firmar el consentimiento. El ${clinician.one} lo revisará antes de empezar.`,
      key: `enlace-firma:${consentId}`,
      reason: "La persona firmó un consentimiento desde su enlace",
      kind: "enlace",
      title: "recibió la firma de un consentimiento",
    },
    deps,
  )
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
  deps: { secretsKey?: Buffer } = {},
): Promise<{ submitted: true }> {
  const link = await requireLiveLink(tx, orgId, token, true)
  if (!link.patientId || !(await questionnaireOf(tx, orgId, link))) throw linkExpired()
  const submitted = await submitQuestionnaireFromLink(
    tx,
    { orgId, patientId: link.patientId, contactId: link.row.contactId },
    answers,
  )
  const { clinician } = productWords(await orgProduct(tx, orgId))
  await thankInChat(
    tx,
    orgId,
    link,
    {
      note: "Envió su cuestionario desde su enlace.",
      message: `Gracias, ya recibimos el cuestionario. El ${clinician.one} lo revisará antes de la cita.`,
      key: `enlace-cuestionario:${link.row.id}`,
      reason: "La persona envió su cuestionario desde su enlace",
      kind: "enlace",
      title: "recibió su cuestionario",
    },
    deps,
  )
  return submitted
}

// ------------------------------------------------- enviarle su enlace ---

const OPTED_OUT =
  "Pidió no recibir ningún mensaje de la clínica: díselo en persona o por teléfono, o envíaselo si te escribe por WhatsApp."
const NO_ADDRESS = "Falta la dirección pública de la clínica: no hay enlace que enviar."

export interface PersonalLinkSendPreview {
  recipient: { contactId: string; name: string; relation: string }
  channel: "whatsapp" | "email" | null
  via: "respuesta" | "plantilla" | "correo" | null
  /** «Enviar por WhatsApp» o «Enviar por correo». */
  label: string | null
  /** Por qué no se puede enviar. */
  blocked: string | null
  /**
   * Si se puede copiar o mostrar en un código aunque no se pueda enviar
   * (fuera de las 24 horas, sin mensaje aprobado o sin permiso para escribirle):
   * solo falta cuando la clínica no tiene dirección pública.
   */
  canShow: boolean
  text: string
  /** Hasta cuándo sirve el enlace que ya tiene, si tiene uno: «Quitar enlace» lo deja sin efecto. */
  liveUntil: string | null
}

/** Hasta cuándo sirve el enlace vivo de un paciente, de quien sea; nulo si no tiene. */
async function liveLinkUntil(tx: Db, orgId: string, patientId: string): Promise<string | null> {
  const [row] = await tx
    .select({ until: sql<Date | string | null>`max(${appointmentBookingLink.expiresAt})` })
    .from(appointmentBookingLink)
    .where(
      and(
        eq(appointmentBookingLink.organizationId, orgId),
        eq(appointmentBookingLink.patientId, patientId),
        isNull(appointmentBookingLink.revokedAt),
        gte(appointmentBookingLink.expiresAt, new Date()),
      ),
    )
  return row?.until ? new Date(row.until).toISOString() : null
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
export async function previewPersonalLinkSend(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<PersonalLinkSendPreview> {
  const recipient = await serviceRecipient(tx, orgId, patientId)
  const { spec, text } = await personalLinkMessage(tx, orgId, recipient.displayName)
  const base = {
    recipient: {
      contactId: recipient.contactId,
      name: recipient.displayName,
      relation: recipient.relation,
    },
    text,
    liveUntil: await liveLinkUntil(tx, orgId, patientId),
    canShow: true,
  }
  if ((await personalLinkUrl(tx, orgId, "0".repeat(64))) === null) {
    return { ...base, channel: null, via: null, label: null, blocked: NO_ADDRESS, canShow: false }
  }
  // La puerta para escribirle a alguien (ADR 0042): un aviso que manda el equipo.
  const route = await previewRoute(tx, orgId, recipient.contactId, spec, {
    purpose: NOTICE_PURPOSE,
    initiative: "equipo",
  })
  if ("cause" in route) {
    return {
      ...base,
      channel: null,
      via: null,
      label: null,
      blocked: route.cause === "sin_permiso" ? OPTED_OUT : route.detail,
    }
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
 * y, si no, correo). Es un aviso, como el de su cita (ADR 0040): no pide
 * permiso y solo deja de salir con «No quiero ningún mensaje». Una
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
  const route = await openRoute(tx, orgId, recipient.contactId, spec, {
    purpose: NOTICE_PURPOSE,
    initiative: "equipo",
  })
  if ("cause" in route) {
    if (route.cause === "sin_permiso") throw new ServiceError("LINK_OPTED_OUT", 409, OPTED_OUT)
    throw new ServiceError("LINK_NO_ROUTE", 409, `No se pudo enviar: ${route.detail}`)
  }
  const link = await issuePersonalLink(
    tx,
    orgId,
    // «Ver lo pendiente»: abre lo que tiene pendiente, no una reserva sin usar.
    // Con su conversación: lo que haga en el enlace se le responde por ese chat.
    {
      contactId: recipient.contactId,
      patientId: input.patientId,
      conversationId: route.conversationId,
      createdBy: actorUserId,
      booking: false,
    },
    deps,
  )
  // En el mensaje no queda el token: lo pone el worker al enviarlo.
  const url = await personalLinkMessageUrl(tx, orgId, link.linkId)
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
      category: spec.category,
      buttons: replyButtons(spec.buttons, link.linkId),
      link: personalLinkRef(link.linkId),
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
        text:
          route.via === "correo"
            ? `${PERSONAL_LINK_SUBJECT} · ${await findClinicName(tx, orgId)}\n\n${body}`
            : body,
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

export interface PersonalLinkShown {
  url: string
  expiresAt: string
  recipientName: string
}

/**
 * «Su enlace» para mostrarlo en la clínica como código QR: quien decide por el
 * paciente lo escanea con su celular delante de recepción y completa sus datos
 * mientras espera. No se envía nada: el enlace es el mismo que se le enviaría
 * (uno por persona y paciente) y queda la traza de quién lo mostró.
 */
export async function showPersonalLink(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  deps: { secretsKey: Buffer },
): Promise<PersonalLinkShown> {
  const recipient = await serviceRecipient(tx, orgId, patientId)
  const link = await issuePersonalLink(
    tx,
    orgId,
    // El código QR para que complete sus datos: no abre una reserva sin usar.
    { contactId: recipient.contactId, patientId, createdBy: actorUserId, booking: false },
    deps,
  )
  const url = await personalLinkUrl(tx, orgId, link.token)
  if (!url) throw new ServiceError("NO_PUBLIC_URL", 409, NO_ADDRESS)
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "personal_link.shown",
    entity: "patient",
    entityId: patientId,
    metadata: {
      patientId,
      recipientContactId: recipient.contactId,
      recipientName: recipient.displayName,
    },
  })
  return { url, expiresAt: link.expiresAt.toISOString(), recipientName: recipient.displayName }
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
    .where(
      and(eq(automationLinkToken.organizationId, orgId), eq(automationLinkToken.tokenHash, hash)),
    )
    .limit(1)
  if (
    !row ||
    row.purpose === "baja" ||
    !row.appointmentId ||
    !row.contactId ||
    row.expiresAt.getTime() <= Date.now()
  ) {
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
