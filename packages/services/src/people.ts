/**
 * Una persona, una página (ADR 0029). La persona es el contacto (ADR 0001):
 * su página existe desde que escribe por primera vez, sea o no paciente, y
 * crece con ella. Aquí viven las lecturas y operaciones que la página
 * comparte con cualquier otra vía: quién es (`getPersonPage`), la lista única
 * (`listPeople`), su identidad con las reglas de la ficha
 * (`updatePersonIdentity`), archivar entera (`setPersonArchived`), sus
 * conversaciones y sus notas. Cada bloque de la página se pide aparte con su
 * propio permiso; ninguna función de este módulo entrega todo junto.
 */
import { awaitingPatientSinceSql, conversationViewSql, testOnlyPersonSql } from "./conversation-state.js"
import {
  clinicalProfileFor,
  documentIssuerCountry,
  KINSHIP_LABELS,
  type Kinship,
  validateDemographics,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { patient, patientContact } from "@odentia/db/schema/clinical"
import { channelConnection, contact, contactIdentity, type ContactScreen, conversation } from "@odentia/db/schema/crm"
import { crmNote } from "@odentia/db/schema/crm-workspace"
import { auditEvent } from "@odentia/db/schema/org"
import { and, desc, eq, sql } from "drizzle-orm"
import {
  applyContactActive,
  cleanContactEmail,
  cleanContactPhone,
  createContact,
  notifyContactChange,
  type PhoneWhatsApp,
  phoneWhatsAppState,
  requireContact,
} from "./contacts.js"
import { type ContactScreenView, getContactScreenView } from "./contact-screen.js"
import { fieldsError, invalidField, isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import { findOrgCountry, findOrgLocale } from "./locale.js"
import { productHooks } from "./products.js"
import { personSearchCondition } from "./person-search.js"
import { type PlanNextAction, type PlanNextKind, planNextStepsOf } from "./plan-next.js"
import { inviteStatusOf, inviteStepText } from "./return-invites.js"
import {
  countPeopleShortcuts,
  missingDataAmong,
  PEOPLE_SHORTCUTS,
  type PeopleShortcut,
  patientsToInvite,
  peopleShortcutMembers,
} from "./people-shortcuts.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import {
  assertDocumentFree,
  birthDateIsMinor,
  patientOrganizationToday,
  patientPersonId,
  updatePatient,
} from "./patients.js"

/** Permisos de quien mira: el servicio no entrega lo que su rol no lee. */
export type PersonCan = (permission: string) => boolean

/** Qué es la persona para la clínica, en el orden en que se decide. */
export type PersonKind = "paciente" | "responsable" | "por_registrar"

export interface PersonResponsibleFor {
  /** Persona del paciente (su página); null solo si la ficha aún no tiene persona. */
  personId: string | null
  patientId: string
  displayName: string
  patientNumber: number
  birthDate: string | null
  relationship: string
  relationshipDetail: string | null
  /** Parentesco con HL7 v3 RoleCode, si se conoce. */
  kinship: string | null
  archived: boolean
}

export interface PersonSpokenForBy {
  personId: string
  displayName: string
  /** Su teléfono: el Resumen de quien no tiene uno propio dice «el de Martín Salas (padre)». */
  phone: string | null
  /** También es paciente: su página la abre también quien solo ve pacientes. */
  isPatient: boolean
  relationship: string
  relationshipDetail: string | null
  /** Parentesco con HL7 v3 RoleCode, si se conoce. */
  kinship: string | null
  isPreferred: boolean
  /** Su conversación más reciente; solo para quien lee conversaciones. */
  conversationId: string | null
}

export interface PersonPage {
  id: string
  displayName: string
  givenNames: string | null
  familyName: string | null
  docType: string | null
  docNumber: string | null
  docCountry: string | null
  birthDate: string | null
  /** Menor de edad hoy, con el día de la clínica (lo decide el servidor). */
  isMinor: boolean
  sex: string | null
  phone: string | null
  /** Si su teléfono es ya su WhatsApp, aún no o no tiene (decisión 23). */
  phoneWhatsApp: PhoneWhatsApp
  email: string | null
  /** Archivada entera: la persona o su ficha (lo que quedó de antes de unir los dos indicadores). */
  archived: boolean
  /** Su historia está bloqueada (ADR 0080): solo la ve Administración, que la abrió para leer. */
  recordLocked: boolean
  /** Spam o bloqueada (ADR 0054); solo para quien lee conversaciones o maneja contactos. */
  screen: ContactScreenView | null
  createdAt: string
  kind: PersonKind
  /** Su historia clínica, si ya está registrada como paciente. */
  patient: {
    id: string
    patientNumber: number
    identityNeedsReview: boolean
    avatarStorageKey: string | null
  } | null
  /** Pacientes de los que es tutor, familiar u otra persona vinculada (no ella misma). */
  responsibleFor: PersonResponsibleFor[]
  /** Quienes hablan por ella (si es paciente): tutor, familiar u otra persona vinculada. */
  spokenForBy: PersonSpokenForBy[]
  /** Canales por los que ya escribió (WhatsApp, Telegram…); vacío para quien no lee la bandeja ni el CRM. */
  channels: string[]
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null
}

/** Ficha propia de la persona (su vínculo `self`), o null si aún no es paciente. */
export async function selfPatientOf(
  tx: Db,
  orgId: string,
  contactId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ patientId: patient.id })
    .from(patient)
    .where(and(eq(patient.organizationId, orgId), eq(patient.personId, contactId)))
    .limit(1)
  return row?.patientId ?? null
}

/** La persona de un paciente: lo que necesitan los enlaces y direcciones viejas de la ficha. */
export async function personOfPatient(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<{ personId: string }> {
  const [exists] = await tx
    .select({ id: patient.id })
    .from(patient)
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId)))
    .limit(1)
  if (!exists) throw notFound("Paciente")
  const personId = await patientPersonId(tx, orgId, patientId)
  if (!personId) throw notFound("Persona")
  return { personId }
}

/**
 * Quien aún no es paciente (por registrar o solo responsable) lo ven solo
 * quienes llevan la relación con las personas: recepción y quien dirige
 * (`crm.read`). Caja y odontología ven solo pacientes; para ellos no existe.
 */
export function seesNonPatients(can: PersonCan): boolean {
  return can("crm.read")
}

/** La persona existe para quien mira: si no es paciente, solo con `crm.read` (404 si no). */
export async function assertPersonVisible(tx: Db, orgId: string, contactId: string, can: PersonCan): Promise<void> {
  await requireContact(tx, orgId, contactId)
  if (seesNonPatients(can)) return
  if (!(await selfPatientOf(tx, orgId, contactId))) throw notFound("Persona")
}

/** Lo que la página necesita para dibujarse: quién es y qué es para la clínica. */
export async function getPersonPage(
  tx: Db,
  orgId: string,
  contactId: string,
  can: PersonCan,
): Promise<PersonPage> {
  await assertPersonVisible(tx, orgId, contactId, can)
  const row = await requireContact(tx, orgId, contactId)
  const [own] = await tx
    .select({ patient })
    .from(patient)
    .where(and(eq(patient.organizationId, orgId), eq(patient.personId, contactId)))
    .limit(1)
  const responsibleRows = await tx
    .select({
      patientId: patient.id,
      displayName: patientPerson.displayName,
      patientNumber: patient.patientNumber,
      birthDate: patientPerson.birthDate,
      relationship: patientContact.relationship,
      relationshipDetail: patientContact.relationshipDetail,
      kinship: patientContact.kinship,
      personId: patient.personId,
      personActive: patientPerson.isActive,
    })
    .from(patientContact)
    .innerJoin(
      patient,
      and(eq(patient.id, patientContact.patientId), eq(patient.organizationId, orgId)),
    )
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.contactId, contactId),
        sql`${patientContact.relationship} <> 'self'`,
      ),
    )
    .orderBy(patientPerson.displayName, patient.id)
  const readsConversations = can("conversations.read")
  const spokenRows = own
    ? await tx
        .select({
          personId: contact.id,
          displayName: contact.displayName,
          phone: contact.phone,
          isPatient: sql<boolean>`exists (select 1 from patient s where s.organization_id = ${orgId} and s.person_id = ${contact.id})`,
          relationship: patientContact.relationship,
          relationshipDetail: patientContact.relationshipDetail,
          kinship: patientContact.kinship,
          isPreferred: patientContact.isPreferred,
          conversationId: sql<
            string | null
          >`(select cv.id from conversation cv where cv.organization_id = ${orgId} and cv.contact_id = ${contact.id} order by cv.last_message_at desc nulls last, cv.id desc limit 1)`,
        })
        .from(patientContact)
        .innerJoin(
          contact,
          and(eq(contact.id, patientContact.contactId), eq(contact.organizationId, orgId)),
        )
        .where(
          and(
            eq(patientContact.organizationId, orgId),
            eq(patientContact.patientId, own.patient.id),
            sql`${patientContact.relationship} <> 'self'`,
            eq(contact.isActive, true),
          ),
        )
        .orderBy(desc(patientContact.isPreferred), contact.displayName, contact.id)
    : []
  const channels =
    readsConversations || can("crm.read")
      ? [
          ...new Set(
            (
              await tx
                .select({ channel: contactIdentity.channel })
                .from(contactIdentity)
                .where(
                  and(
                    eq(contactIdentity.organizationId, orgId),
                    eq(contactIdentity.contactId, contactId),
                  ),
                )
            ).map((identity) => identity.channel),
          ),
        ]
      : []
  const responsibleFor: PersonResponsibleFor[] = responsibleRows.map((r) => ({
    personId: r.personId,
    patientId: r.patientId,
    displayName: r.displayName,
    patientNumber: r.patientNumber,
    birthDate: r.birthDate,
    relationship: r.relationship,
    relationshipDetail: r.relationshipDetail,
    kinship: r.kinship,
    archived: !r.personActive,
  }))
  const archived = !row.isActive
  return {
    id: row.id,
    displayName: row.displayName,
    givenNames: row.givenNames,
    familyName: row.familyName,
    docType: row.docType,
    docNumber: row.docNumber,
    docCountry: row.docCountry,
    birthDate: row.birthDate,
    isMinor: await birthDateIsMinor(tx, orgId, row.birthDate),
    sex: row.sex,
    phone: row.phone,
    phoneWhatsApp: await phoneWhatsAppState(tx, orgId, row.id),
    email: row.email,
    archived,
    recordLocked: row.recordLockedAt !== null,
    screen: readsConversations || can("crm.read") ? await getContactScreenView(tx, orgId, row.id) : null,
    createdAt: row.createdAt.toISOString(),
    kind: own
      ? "paciente"
      : responsibleFor.some((r) => !r.archived)
        ? "responsable"
        : "por_registrar",
    patient: own
      ? {
          id: own.patient.id,
          patientNumber: own.patient.patientNumber,
          identityNeedsReview: row.identityNeedsReview,
          avatarStorageKey: own.patient.avatarStorageKey,
        }
      : null,
    responsibleFor,
    spokenForBy: spokenRows.map((r) => ({
      personId: r.personId,
      displayName: r.displayName,
      phone: r.phone,
      isPatient: Boolean(r.isPatient),
      relationship: r.relationship,
      relationshipDetail: r.relationshipDetail,
      kinship: r.kinship,
      isPreferred: r.isPreferred,
      conversationId: readsConversations ? r.conversationId : null,
    })),
    channels,
  }
}

/* ------------------------------------------------------------------ */
/* Lista única: Pacientes, Por registrar, Responsables, Archivados.     */
/* ------------------------------------------------------------------ */

/**
 * Vistas de la lista: las cuatro de la pantalla (Pacientes, Contactos nuevos,
 * Archivados y Todos) y `activos` (todas las personas sin archivar), que usa el
 * buscador de personas al elegir a alguien.
 */
export const PEOPLE_VIEWS = [
  "pacientes",
  "por_registrar",
  "archivados",
  "todos",
  "activos",
] as const
export type PeopleView = (typeof PEOPLE_VIEWS)[number]

/** En qué está quien aún no es paciente (tablero 3): gana la primera que se cumple. */
export type PersonSituation =
  | "responder"
  | "agente"
  | "enlace"
  | "oportunidad"
  | "sin_respuesta"
  | "esperamos"
  | "sin_conversacion"
  | "sin_pendientes"

/** Quién lleva lo que sigue de una persona: el agente, una persona del equipo o nadie todavía. */
export type PersonAttention = "agente" | "persona" | "nadie"

/**
 * Quién lleva el siguiente paso del plan: el agente solo si su línea está
 * prendida; si no, una persona. Lo que no tiene línea ni paso no lo lleva nadie.
 */
export function attentionOf(kind: PlanNextKind, lines: ReadonlySet<string>): PersonAttention {
  switch (kind) {
    case "respuesta":
      return lines.has("seguimiento_presupuesto") ? "agente" : "persona"
    case "control":
      return lines.has("recordatorio_control") ? "agente" : "nadie"
    case "enviar":
    case "agendar":
    case "continuar":
      return "persona"
    case "ninguno":
      return "nadie"
  }
}

/** Las líneas del Administrador que la clínica tiene prendidas: de ellas depende quién lleva cada caso. */
async function enabledLineKinds(tx: Db, orgId: string): Promise<Set<string>> {
  const rows = await tx.execute<{ kind: string }>(
    sql`select kind from automation_rule where organization_id = ${orgId} and enabled`,
  )
  return new Set(rows.map((row) => row.kind))
}

export interface PersonListItem {
  id: string
  displayName: string
  /** Apellidos: la lista ordena por ellos (decisión 11b). */
  familyName: string | null
  kind: PersonKind
  archived: boolean
  patient: { id: string; patientNumber: number } | null
  /** Edad hoy, si la fecha de nacimiento está. */
  age: number | null
  docType: string | null
  docNumber: string | null
  sex: string | null
  phone: string | null
  /** En Spam o bloqueada (ADR 0054); solo para quien lee conversaciones. */
  screen: ContactScreen | null
  /** Vínculos con pacientes en palabras («Madre de Mateo Vargas»): hasta dos, y cuántos son (decisión 16). */
  vinculos: string[]
  vinculoCount: number
  /** Próxima cita por venir; solo para quien ve la agenda. */
  nextAppointmentAt: string | null
  /** Última visita atendida; solo para quien ve la agenda. */
  lastVisitAt: string | null
  /** Último mensaje con la persona; solo para quien lee conversaciones. */
  lastInteractionAt: string | null
  /** Cómo llegó: su primer canal (`channel` nulo si lo registró el equipo); solo para quien lee conversaciones. */
  firstContact: { channel: string | null; at: string } | null
  /** En qué está, solo para quien aún no es paciente y lee conversaciones. */
  situation: PersonSituation | null
  /** Desde cuándo espera su respuesta, si la clínica le escribió y no contesta. */
  waitingSince: string | null
  /**
   * Qué sigue del plan y su botón; solo para quien ve el plan. Trae el paso
   * entero para que el botón haga lo que dice desde la lista (reservar con lo
   * aceptado, responder el presupuesto o reservar el control).
   */
  nextStep: { text: string; actionLabel: string | null; kind: PlanNextKind | null; action: PlanNextAction | null } | null
  /** Quién lleva lo que sigue; nulo si no es paciente o no ve el plan. */
  attention: PersonAttention | null
  /** La ficha le falta algo para atenderla (`faltan_datos`). */
  missingData: boolean
}

export interface PeopleListInput {
  view?: string
  q?: string
  /** Atajo de «Pacientes» (`PEOPLE_SHORTCUTS`): solo con la vista Pacientes. */
  atajo?: string
  cursor?: string
  limit?: number
}

const PEOPLE_PAGE = 30

/** Archivada entera: la persona, con su ficha si es paciente (ADR 0044). */
const ARCHIVED_SQL = sql`(not c.is_active)`
const RESPONSIBLE_SQL = sql`exists (select 1 from patient_contact r join patient rp on rp.organization_id = r.organization_id and rp.id = r.patient_id join contact rc on rc.organization_id = rp.organization_id and rc.id = rp.person_id where r.organization_id = c.organization_id and r.contact_id = c.id and r.relationship <> 'self' and rc.is_active)`
/** Cuándo llegó: su primer mensaje por cualquier canal o, si nunca escribió, su alta en la clínica. */
const FIRST_CONTACT_SQL = sql`coalesce((select min(ci.created_at) from contact_identity ci where ci.organization_id = c.organization_id and ci.contact_id = c.id), c.created_at)`
const FIRST_CONTACT_TEXT_SQL = sql`to_char(${FIRST_CONTACT_SQL} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
/** Un enlace de registro o de cita que todavía sirve (tablero 3, decisión 2). */
const USABLE_LINK_SQL = sql`(exists (select 1 from patient_registration_link l where l.organization_id = c.organization_id and l.contact_id = c.id and l.consumed_at is null and l.revoked_at is null and l.expires_at > now()) or exists (select 1 from appointment_booking_link b where b.organization_id = c.organization_id and b.contact_id = c.id and b.used_at is null and b.revoked_at is null and b.expires_at > now()))`
const OPEN_OPPORTUNITY_SQL = sql`exists (select 1 from opportunity o where o.organization_id = c.organization_id and o.contact_id = c.id and o.status = 'open')`
/** Quien es de un paciente pero pide algo para sí mismo: aparece entre los contactos nuevos (decisión 2). */
const OWN_REQUEST_SQL = sql`(${OPEN_OPPORTUNITY_SQL} or ${USABLE_LINK_SQL})`

function viewCondition(view: PeopleView) {
  switch (view) {
    case "pacientes":
      return sql`p.id is not null and not ${ARCHIVED_SQL}`
    case "por_registrar":
      // Spam y bloqueados no son contactos nuevos (ADR 0054): se encuentran en «Todos».
      return sql`p.id is null and (not ${RESPONSIBLE_SQL} or ${OWN_REQUEST_SQL}) and not ${ARCHIVED_SQL} and c.screen is null`
    // Una historia bloqueada no sale aquí: tiene su propia lista (ADR 0080).
    case "archivados":
      return sql`${ARCHIVED_SQL} and c.record_locked_at is null`
    case "todos":
      return sql`c.record_locked_at is null`
    case "activos":
      return sql`not ${ARCHIVED_SQL}`
  }
}

/** Nombre, teléfono (por sus dígitos), documento o correo; buscar nunca identifica (`personSearchCondition`). */
function searchCondition(q: string) {
  return personSearchCondition(q, {
    displayName: sql`c.display_name`,
    docNumber: sql`c.doc_number`,
    email: sql`c.email`,
    phone: sql`c.phone`,
    contactId: sql`c.id`,
  })
}

function encodePeopleCursor(key: string, id: string, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ n: key, id, f: fingerprint }), "utf8").toString("base64url")
}

function decodePeopleCursor(cursor: string): { n: string; id: string; f: string } | null {
  try {
    const raw: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (!raw || typeof raw !== "object") return null
    const rec = raw as Record<string, unknown>
    if (typeof rec.n !== "string" || typeof rec.id !== "string" || typeof rec.f !== "string")
      return null
    if (!/^[0-9a-f-]{36}$/i.test(rec.id)) return null
    return { n: rec.n, id: rec.id, f: rec.f }
  } catch {
    return null
  }
}

/** Un vínculo de la persona con un paciente, tal como lo lee la consulta. */
interface VinculoRow {
  name: string
  kinship: string | null
  relationship: string
  detail: string | null
  emergency: boolean
}

/**
 * Cómo se dice el vínculo en la lista: «Madre de Mateo Vargas». Un contacto de
 * emergencia no es responsable ni tutor: se dice por su marca (decisión 16).
 */
function vinculoText(v: VinculoRow): string {
  if (v.emergency) return `Contacto de emergencia de ${v.name}`
  if (v.kinship && v.kinship in KINSHIP_LABELS)
    return `${KINSHIP_LABELS[v.kinship as Kinship]} de ${v.name}`
  if (v.relationship === "guardian") return `Tutor de ${v.name}`
  if (v.relationship === "family") return `Familiar de ${v.name}`
  return v.detail ? `${v.detail} de ${v.name}` : `Vinculado a ${v.name}`
}

type PeopleRow = {
  id: string
  display_name: string
  family_name: string | null
  is_active: boolean
  patient_id: string | null
  patient_number: number | null
  doc_type: string | null
  doc_number: string | null
  sex: string | null
  phone: string | null
  screen: ContactScreen | null
  age: number | null
  last_interaction_at: string | null
  sort_key: string
  vinculos: VinculoRow[] | string | null
  vinculo_count: number
  next_appointment_at: string | null
  last_visit_at: string | null
}

interface ContactExtra {
  firstChannel: string | null
  firstAt: string
  situation: PersonSituation
  waitingSince: string | null
}

/**
 * Cómo llegó y en qué está, de la última conversación y de los enlaces y
 * oportunidades de la persona. Solo para las filas de la página, no para toda
 * la clínica; quien no lee conversaciones no llama a esta consulta.
 */
async function contactExtras(tx: Db, orgId: string, ids: string[]): Promise<Map<string, ContactExtra>> {
  const out = new Map<string, ContactExtra>()
  if (ids.length === 0) return out
  const waiting = awaitingPatientSinceSql(sql.raw("cv"))
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )
  const rows = await tx.execute<{
    id: string
    first_channel: string | null
    first_at: string
    situation: PersonSituation
    waiting_since: string | null
  }>(sql`
    select c.id,
      (select ci.channel from contact_identity ci
        where ci.organization_id = c.organization_id and ci.contact_id = c.id
        order by ci.created_at asc limit 1) as first_channel,
      ${FIRST_CONTACT_TEXT_SQL} as first_at,
      case
        when cv.id is not null and ${conversationViewSql(sql.raw("cv"), "attend")} then 'responder'
        when cv.id is not null and ${conversationViewSql(sql.raw("cv"), "agent")} then 'agente'
        when ${USABLE_LINK_SQL} then 'enlace'
        when ${OPEN_OPPORTUNITY_SQL} then 'oportunidad'
        when cv.id is not null and ${conversationViewSql(sql.raw("cv"), "awaiting_patient")} then
          case when ${waiting} <= now() - interval '7 days' then 'sin_respuesta' else 'esperamos' end
        when cv.id is null then 'sin_conversacion'
        else 'sin_pendientes'
      end as situation,
      to_char(${waiting} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as waiting_since
    from contact c
    left join lateral (
      select cv.* from conversation cv
      where cv.organization_id = c.organization_id and cv.contact_id = c.id
      order by coalesce(cv.last_message_at, cv.created_at) desc limit 1
    ) cv on true
    where c.organization_id = ${orgId} and c.id in (${idList})
  `)
  for (const r of rows) {
    out.set(r.id, {
      firstChannel: r.first_channel,
      firstAt: r.first_at,
      situation: r.situation,
      waitingSince: r.waiting_since,
    })
  }
  return out
}

/**
 * La lista de personas de la clínica, una sola: los filtros son vistas de la
 * misma persona («Pacientes» por defecto). Búsqueda y páginas las hace el
 * servidor. Contactos nuevos va del que llegó más reciente al más antiguo; las
 * demás vistas, por apellido (decisión 11b). El total de «Contactos nuevos» es
 * de toda la clínica. Quien no ve a quien aún no es paciente (`seesNonPatients`)
 * recibe solo pacientes, en cualquier vista que tenga.
 */
/**
 * Cuántos hay en cada atajo de «Pacientes» que quien mira ve (nulo, el que no
 * ve). Aparte de la lista: recorre paciente por paciente y la página no lo espera.
 */
export async function listPeopleShortcuts(
  tx: Db,
  orgId: string,
  can: PersonCan,
): Promise<Record<PeopleShortcut, number | null>> {
  const { timezone } = await findOrgLocale(tx, orgId)
  return countPeopleShortcuts(tx, orgId, can, timezone, new Date())
}

export async function listPeople(
  tx: Db,
  orgId: string,
  input: PeopleListInput,
  can: PersonCan,
): Promise<{
  items: PersonListItem[]
  nextCursor: string | null
  counts: { porRegistrar: number }
}> {
  const view = (input.view ?? "pacientes") as PeopleView
  if (!PEOPLE_VIEWS.includes(view)) throw validation("Vista inválida")
  // Caja y odontología solo ven pacientes: sin la vista de quien aún no lo es.
  const everyone = seesNonPatients(can)
  if (!everyone && view === "por_registrar")
    throw new ServiceError("FORBIDDEN", 403, "Esta vista es de quien lleva la relación con las personas")
  const onlyPatients = everyone ? sql`true` : sql`p.id is not null`
  const limit = Math.min(Math.max(input.limit ?? PEOPLE_PAGE, 1), 100)
  const q = input.q?.trim() ?? ""
  if (input.atajo !== undefined && !(PEOPLE_SHORTCUTS as readonly string[]).includes(input.atajo))
    throw validation("Atajo inválido")
  if (input.atajo && view !== "pacientes") throw validation("Los atajos son de la vista Pacientes")
  const atajo = (input.atajo || null) as PeopleShortcut | null
  const fingerprint = JSON.stringify({ view, q, atajo })
  const { timezone, locale } = await findOrgLocale(tx, orgId)
  const now = new Date()
  // Los atajos se recorren paciente por paciente: solo el que se pidió, nunca para pintar la página
  // (sus cuentas, aparte en `countPeopleShortcuts`). Con 1 000 pacientes la página tardaba 12 s.
  const members = atajo ? await peopleShortcutMembers(tx, orgId, can, timezone, now, atajo) : null
  const lines = view === "pacientes" ? await enabledLineKinds(tx, orgId) : new Set<string>()
  const toInvite =
    view === "pacientes" && can("crm.read") ? await patientsToInvite(tx, orgId, timezone, now) : new Set<string>()
  // Cada cuánto vuelve a tocar invitarla: 6 meses en odentIA, 12 en latidIA.
  const { recallMonths } = await productHooks(tx, orgId)
  if (atajo && members?.[atajo] === undefined) throw new ServiceError("FORBIDDEN", 403, "Este atajo no es para quien lo pide")
  const atajoIds = atajo ? (members?.[atajo] ?? []) : []
  const inAtajo = atajo
    ? atajoIds.length > 0
      ? sql`p.id in (${sql.join(atajoIds.map((id) => sql`${id}::uuid`), sql`, `)})`
      : sql`false`
    : sql`true`
  const newest = view === "por_registrar"
  const sortKey = newest ? FIRST_CONTACT_TEXT_SQL : sql`coalesce(nullif(c.family_name, ''), c.display_name)`
  const direction = sql.raw(newest ? "desc" : "asc")
  let after = sql`true`
  if (input.cursor) {
    const decoded = decodePeopleCursor(input.cursor)
    if (!decoded) throw validation("Cursor inválido")
    if (decoded.f !== fingerprint)
      throw validation("El cursor no corresponde a los filtros actuales")
    after = sql`(${sortKey}, c.id) ${sql.raw(newest ? "<" : ">")} (${decoded.n}, ${decoded.id}::uuid)`
  }
  const agenda = can("appointments.read")
  const chats = can("conversations.read") || can("crm.read")
  const plan = ["clinical.read", "budgets.read", "appointments.read"].some((permission) => can(permission))
  const rows = await tx.execute<PeopleRow>(sql`
    select c.id, c.display_name, c.family_name, c.is_active, p.id as patient_id, p.patient_number,
      c.doc_type, c.doc_number, c.sex, c.phone, c.screen,
      extract(year from age(c.birth_date))::int as age,
      to_char(c.last_interaction_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_interaction_at,
      ${sortKey} as sort_key,
      (select coalesce(json_agg(v.j order by v.name), '[]'::json) from (
        select rc.display_name as name, json_build_object('name', rc.display_name, 'kinship', r.kinship,
          'relationship', r.relationship, 'detail', r.relationship_detail, 'emergency', r.is_emergency) as j
        from patient_contact r
          join patient rp on rp.organization_id = r.organization_id and rp.id = r.patient_id
          join contact rc on rc.organization_id = rp.organization_id and rc.id = rp.person_id
        where r.organization_id = c.organization_id and r.contact_id = c.id and r.relationship <> 'self' and rc.is_active
        order by rc.display_name limit 2) v) as vinculos,
      (select count(*)::int from patient_contact r
          join patient rp on rp.organization_id = r.organization_id and rp.id = r.patient_id
          join contact rc on rc.organization_id = rp.organization_id and rc.id = rp.person_id
          where r.organization_id = c.organization_id and r.contact_id = c.id and r.relationship <> 'self' and rc.is_active) as vinculo_count,
      ${
        agenda
          ? sql`(select to_char(min(a.starts_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from appointment a
              where a.organization_id = c.organization_id and a.patient_id = p.id and a.starts_at > now()
                and a.status in ('programada', 'confirmada'))`
          : sql`null`
      } as next_appointment_at,
      ${
        agenda
          ? sql`(select to_char(max(a.starts_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from appointment a
              where a.organization_id = c.organization_id and a.patient_id = p.id and a.status = 'atendida')`
          : sql`null`
      } as last_visit_at
    from contact c
    left join patient p on p.organization_id = c.organization_id and p.person_id = c.id
    where c.organization_id = ${orgId}
      and ${viewCondition(view)}
      and not ${testOnlyPersonSql(sql.raw("c"))}
      and ${onlyPatients}
      and ${inAtajo}
      and ${searchCondition(q)}
      and ${after}
    order by ${sortKey} ${direction}, c.id ${direction}
    limit ${limit + 1}
  `)
  const list = [...rows]
  const page = list.slice(0, limit)
  // «Faltan datos» de cada fila: solo de los pacientes activos de esta página.
  const missing =
    view === "pacientes" && can("patients.read")
      ? await missingDataAmong(
          tx,
          orgId,
          page.flatMap((r) => (r.patient_id && r.is_active ? [r.patient_id] : [])),
        )
      : new Set<string>()
  const extras = chats
    ? await contactExtras(
        tx,
        orgId,
        page.map((r) => r.id),
      )
    : new Map<string, ContactExtra>()
  // Quien ya fue invitada a volver, o no quiere invitaciones, lo dice en «Qué sigue».
  const invites =
    plan && agenda
      ? await inviteStatusOf(tx, orgId, page.flatMap((r) => (r.patient_id && !toInvite.has(r.patient_id) ? [r.patient_id] : [])))
      : new Map()
  // «Qué sigue» de los pacientes de la página, de una vez.
  const steps =
    plan
      ? await planNextStepsOf(
          tx,
          orgId,
          page.flatMap((r) => (r.patient_id ? [r.patient_id] : [])),
          can,
        )
      : new Map()
  const items: PersonListItem[] = []
  for (const r of page) {
    const isPatient = r.patient_id !== null
    const extra = extras.get(r.id)
    const vinculoCount = Number(r.vinculo_count ?? 0)
    const vinculos = (typeof r.vinculos === "string" ? JSON.parse(r.vinculos) : (r.vinculos ?? [])) as VinculoRow[]
    const situation = !isPatient && extra ? extra.situation : null
    items.push({
      id: r.id,
      displayName: r.display_name,
      familyName: r.family_name,
      kind: isPatient ? "paciente" : vinculoCount > 0 ? "responsable" : "por_registrar",
      archived: !r.is_active,
      patient:
        r.patient_id && r.patient_number !== null
          ? { id: r.patient_id, patientNumber: Number(r.patient_number) }
          : null,
      age: r.age === null ? null : Number(r.age),
      docType: r.doc_type,
      docNumber: r.doc_number,
      sex: r.sex,
      phone: r.phone,
      // Lo dicen solo a quien lee conversaciones: es lo que ve la Bandeja.
      screen: chats ? r.screen : null,
      vinculos: vinculos.slice(0, 2).map(vinculoText),
      vinculoCount,
      nextAppointmentAt: agenda ? r.next_appointment_at : null,
      lastVisitAt: agenda ? r.last_visit_at : null,
      lastInteractionAt: chats ? r.last_interaction_at : null,
      firstContact: chats && extra ? { channel: extra.firstChannel, at: extra.firstAt } : null,
      situation: chats ? situation : null,
      waitingSince:
        chats && (situation === "sin_respuesta" || situation === "esperamos") ? (extra?.waitingSince ?? null) : null,
      nextStep: null,
      attention: null,
      missingData: isPatient && missing.has(r.patient_id ?? ""),
    })
    if (isPatient && plan && r.patient_id) {
      const step = steps.get(r.patient_id)
      if (!step) continue
      const item = items[items.length - 1]!
      // Sin nada en el plan y sin volver desde hace 6 meses: lo que sigue es invitarla (decisión 15).
      const invite = toInvite.has(r.patient_id) && step.kind === "ninguno"
      const invited =
        step.kind === "ninguno"
          ? inviteStepText(invites.get(r.patient_id), { lastVisitAt: r.last_visit_at, nextAppointmentAt: r.next_appointment_at }, { locale, timezone }, now, recallMonths)
          : null
      item.nextStep = invite
        ? { text: `Toca ${r.sex === "M" ? "invitarlo" : "invitarla"} a volver`, actionLabel: null, kind: null, action: null }
        : invited
          ? { text: invited.text, actionLabel: null, kind: null, action: null }
          : { text: step.text, actionLabel: step.action?.label ?? null, kind: step.kind, action: step.action }
      // Quien tiene que volver a verla lo lleva la línea de invitar, si está prendida; ya invitada, quien la invitó.
      item.attention = toInvite.has(r.patient_id)
        ? lines.has("invitar_a_volver")
          ? "agente"
          : "persona"
        : invited
          ? invited.by
          : attentionOf(step.kind, lines)
    }
  }
  const last = page[page.length - 1]
  const [counted] = everyone
    ? await tx.execute<{ count: number }>(sql`
    select count(*)::int as count from contact c
    left join patient p on p.organization_id = c.organization_id and p.person_id = c.id
    where c.organization_id = ${orgId} and ${viewCondition("por_registrar")} and not ${testOnlyPersonSql(sql.raw("c"))}
  `)
    : [{ count: 0 }]
  return {
    items,
    nextCursor:
      list.length > limit && last ? encodePeopleCursor(last.sort_key, last.id, fingerprint) : null,
    counts: { porRegistrar: Number(counted?.count ?? 0) },
  }
}

/* ------------------------------------------------------------------ */
/* Identidad: un solo formulario, las reglas de la ficha.               */
/* ------------------------------------------------------------------ */

export const PERSON_IDENTITY_FIELDS = [
  "displayName",
  "givenNames",
  "familyName",
  "docType",
  "docNumber",
  "docCountry",
  "birthDate",
  "sex",
  "phone",
  "email",
] as const
export type PersonIdentityField = (typeof PERSON_IDENTITY_FIELDS)[number]
export type PersonIdentityPatch = Partial<Record<PersonIdentityField, string | null>>

/** Solo los campos de identidad que vienen en el cambio. */
export function identityPatchOf(input: Record<string, unknown>): PersonIdentityPatch {
  const patch: PersonIdentityPatch = {}
  for (const key of PERSON_IDENTITY_FIELDS) {
    const value = input[key]
    if (value === undefined) continue
    if (value !== null && typeof value !== "string") throw validation("Dato de identidad inválido")
    patch[key] = value
  }
  return patch
}

/**
 * Cambia la identidad de una persona con las reglas de la ficha (ADR 0004,
 * `validateDemographics`), venga de donde venga: la página, el CRM o el
 * agente. Si es paciente, el cambio es el de su ficha (`updatePatient`, con
 * la regla del menor), que lo guarda en la persona; si no, se valida igual
 * sobre lo que ya tiene y se guarda en la persona. En los dos casos vive solo
 * en la persona (ADR 0044). El agente no cambia la identidad de quien ya es
 * paciente.
 */
export async function updatePersonIdentity(
  tx: Db,
  orgId: string,
  actor: { userId: string | null; origin?: "agent" },
  contactId: string,
  patch: PersonIdentityPatch,
): Promise<void> {
  const keys = Object.keys(patch) as PersonIdentityField[]
  if (keys.length === 0) return
  const [locked] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, contactId)))
    .for("update")
    .limit(1)
  if (!locked) throw notFound("Contacto")
  const patientId = await selfPatientOf(tx, orgId, contactId)
  if (patientId) {
    if (actor.origin === "agent")
      throw new ServiceError(
        "PATIENT_IDENTITY_PROTECTED",
        409,
        "Esta persona es paciente: su identidad solo la modifica el equipo de la clínica",
      )
    const { displayName, ...rest } = patch
    if (displayName === null) throw validation("Indica el nombre de la persona")
    await updatePatient(tx, orgId, actor.userId, patientId, {
      ...rest,
      ...(displayName !== undefined ? { displayName } : {}),
    })
    return
  }
  const trimmed: PersonIdentityPatch = {}
  for (const key of keys) {
    const raw = patch[key]
    trimmed[key] = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") || null : null
  }
  if (trimmed.docCountry) trimmed.docCountry = trimmed.docCountry.toUpperCase()
  // Lo que ya tiene más lo que cambia: así un pasaporte guardado no exige
  // volver a escribir su país para cambiar el teléfono.
  const stored = {
    docType: locked.docType,
    docNumber: locked.docNumber,
    docCountry: locked.docCountry,
  }
  const merged = {
    displayName: locked.displayName,
    givenNames: locked.givenNames,
    familyName: locked.familyName,
    docType: locked.docType,
    docNumber: locked.docNumber,
    docCountry: locked.docCountry,
    birthDate: locked.birthDate,
    sex: locked.sex,
    phone: locked.phone,
    email: locked.email,
    ...trimmed,
  }
  const countryCode = await findOrgCountry(tx, orgId)
  if (!merged.docNumber) {
    merged.docType = null
    merged.docCountry = null
  } else {
    // El documento con su país emisor: el del tipo o, si cualquiera lo emite, el de la clínica.
    merged.docCountry = documentIssuerCountry(clinicalProfileFor(countryCode), merged.docType, merged.docCountry)
  }
  // El nombre visible se deriva del nombre separado; si solo cambia el nombre
  // separado, el visible provisional sale de él para validar.
  const composed = [merged.givenNames, merged.familyName]
    .filter(Boolean)
    .join(" ")
  if (composed && trimmed.displayName === undefined) merged.displayName = composed
  if (!merged.displayName) throw validation("Escribe el nombre de la persona")
  const errors = validateDemographics(
    merged,
    await patientOrganizationToday(tx, orgId),
    countryCode,
    stored,
  )
  const failed = fieldsError(errors)
  if (failed) throw failed
  const set: Partial<typeof contact.$inferInsert> = { updatedAt: new Date() }
  for (const key of keys) {
    if (key === "phone") set.phone = (await cleanContactPhone(tx, orgId, merged.phone)) ?? null
    else if (key === "email") set.email = cleanContactEmail(merged.email) ?? null
    else (set as Record<string, unknown>)[key] = merged[key]
  }
  if (keys.includes("docType") || keys.includes("docNumber") || keys.includes("docCountry")) {
    set.docType = merged.docType
    set.docNumber = merged.docNumber
    set.docCountry = merged.docCountry
    await assertDocumentFree(tx, orgId, merged, { exceptContactId: contactId })
  }
  if (!keys.includes("displayName") && composed) set.displayName = composed
  try {
    await tx
      .update(contact)
      .set(set)
      .where(and(eq(contact.organizationId, orgId), eq(contact.id, contactId)))
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ServiceError("DUPLICATE_DOCUMENT", 409, "Ese documento ya es de otra persona")
    throw error
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: actor.userId,
    action: "contact.updated",
    entity: "contact",
    entityId: contactId,
    metadata: { fields: keys, ...(actor.origin ? { origin: actor.origin } : {}) },
  })
  await notifyContactChange(tx, orgId)
}

/* ------------------------------------------------------------------ */
/* Crear y archivar.                                                    */
/* ------------------------------------------------------------------ */

export interface CreatePersonInput {
  givenNames?: string | null
  familyName?: string | null
  displayName?: string | null
  phone?: string | null
  email?: string | null
  /** Su documento, si se conoce (el representante del registro lo trae). */
  docType?: string | null
  docNumber?: string | null
  docCountry?: string | null
  /** Nacimiento y sexo: los trae el alta de un paciente, que crea su persona con ellos. */
  birthDate?: string | null
  sex?: string | null
}

/**
 * La persona que ya tiene ese documento en la clínica, o null. Quien registra
 * a alguien por segunda vez (la madre del segundo hijo) es la misma persona:
 * se la reutiliza, nunca se crea otra ficha con su documento.
 */
export async function findPersonByDocument(
  tx: Db,
  orgId: string,
  doc: { docType?: string | null; docNumber?: string | null; docCountry?: string | null },
): Promise<string | null> {
  if (!doc.docNumber) return null
  const [row] = await tx
    .select({ id: contact.id })
    .from(contact)
    .where(
      and(
        eq(contact.organizationId, orgId),
        eq(contact.docNumber, doc.docNumber),
        doc.docType ? eq(contact.docType, doc.docType) : sql`${contact.docType} is null`,
        doc.docCountry ? eq(contact.docCountry, doc.docCountry) : sql`${contact.docCountry} is null`,
      ),
    )
    .limit(1)
  return row?.id ?? null
}

/**
 * «Nueva persona»: nombre separado y cómo ubicarla, con las reglas de la
 * ficha. Registrarla como paciente es otro paso, en su página. Es la única
 * forma de crear una persona: la usan «Nueva persona», la Bandeja y el
 * representante del registro.
 */
export async function createPerson(
  tx: Db,
  orgId: string,
  actor: { userId: string | null },
  input: CreatePersonInput,
): Promise<{ id: string }> {
  const clean = (value: string | null | undefined) => value?.trim().replace(/\s+/g, " ") || null
  const givenNames = clean(input.givenNames)
  const familyName = clean(input.familyName)
  const composed = [givenNames, familyName].filter(Boolean).join(" ")
  const displayName = composed || clean(input.displayName)
  if (!displayName) throw invalidField("givenNames", "Escribe los nombres")
  const countryCode = await findOrgCountry(tx, orgId)
  const errors = validateDemographics(
    {
      displayName,
      givenNames,
      familyName,
      phone: clean(input.phone),
      email: clean(input.email),
      docType: clean(input.docType),
      docNumber: clean(input.docNumber),
      docCountry: clean(input.docCountry),
      birthDate: clean(input.birthDate),
      sex: clean(input.sex),
    },
    await patientOrganizationToday(tx, orgId),
    countryCode,
  )
  const failed = fieldsError(errors)
  if (failed) throw failed
  const docNumber = clean(input.docNumber)
  const doc = docNumber
    ? {
        docType: clean(input.docType),
        docNumber,
        // El documento con su país emisor, como el de la ficha.
        docCountry: documentIssuerCountry(clinicalProfileFor(countryCode), clean(input.docType), clean(input.docCountry)),
      }
    : null
  if (doc) await assertDocumentFree(tx, orgId, doc)
  let created: { id: string }
  try {
    created = await createContact(
      tx,
      orgId,
      {
        displayName,
        givenNames,
        familyName,
        phone: clean(input.phone),
        email: clean(input.email),
        birthDate: clean(input.birthDate),
        sex: clean(input.sex),
        ...(doc ?? {}),
      },
      actor,
    )
  } catch (error) {
    if (isUniqueViolation(error)) {
      const message = "Ese documento ya es de otra persona"
      throw new ServiceError("DUPLICATE_DOCUMENT", 409, message, { docNumber: message })
    }
    throw error
  }
  return { id: created.id }
}

/**
 * Un solo «Archivar»: la persona y su ficha se archivan y se recuperan juntas.
 * Es un solo indicador, el de la persona (`contact.is_active`; la ficha no
 * tiene otro, ADR 0044), y esta es la única operación que lo cambia; archivar
 * revoca sus enlaces de registro pendientes (`applyContactActive`).
 */
export async function setPersonArchived(
  tx: Db,
  orgId: string,
  actor: { userId: string | null },
  contactId: string,
  archived: boolean,
): Promise<void> {
  const [before] = await tx
    .select({ isActive: contact.isActive })
    .from(contact)
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, contactId)))
  await applyContactActive(tx, orgId, contactId, !archived, actor)
  const patientId = await selfPatientOf(tx, orgId, contactId)
  if (patientId) {
    // La ficha se archiva con su persona: es el mismo indicador (ADR 0044).
    if (before && before.isActive === archived)
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        actorUserId: actor.userId,
        action: "patient.updated",
        entity: "patient",
        entityId: patientId,
        metadata: { fields: ["isActive"], with: "person" },
      })
  }
  await notifyContactChange(tx, orgId)
}

/* ------------------------------------------------------------------ */
/* Conversaciones y notas de la persona.                                */
/* ------------------------------------------------------------------ */

export interface PersonConversation {
  id: string
  status: string
  channel: string
  connectionName: string
  lastMessageAt: string | null
  closure: { reason: string; at: string; byName: string | null } | null
}

/**
 * Las conversaciones de la persona, para quien lee la bandeja (no exige el
 * CRM: odontología también las ve). Solo las suyas: la de su tutor no se copia
 * en la página de cada hijo, se enlaza desde «Habla por ella».
 */
export async function listPersonConversations(
  tx: Db,
  orgId: string,
  contactId: string,
): Promise<PersonConversation[]> {
  await requireContact(tx, orgId, contactId)
  const rows = await tx
    .select({
      conversation,
      connection: channelConnection,
      closedByName: sql<
        string | null
      >`(select u.name from "user" u where u.id = "conversation"."closed_by_user_id")`,
    })
    .from(conversation)
    .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.contactId, contactId)))
    .orderBy(sql`"conversation"."last_message_at" desc nulls last`, desc(conversation.id))
    .limit(50)
  return rows.map(({ conversation: c, connection, closedByName }) => ({
    id: c.id,
    status: c.status,
    channel: connection.channel,
    connectionName: connection.displayName,
    lastMessageAt: iso(c.lastMessageAt),
    closure:
      c.status === "closed" && c.closeReason && c.closedAt
        ? { reason: c.closeReason, at: c.closedAt.toISOString(), byName: closedByName }
        : null,
  }))
}

export interface PersonNote {
  id: string
  body: string
  at: string
  /** Quién la escribió; null si la dejó el sistema (al unir persona y ficha). */
  authorName: string | null
}

/**
 * Un sitio para las notas de la persona, con quién las escribió: las notas
 * operativas (las de «Contexto») y lo que quedó escrito antes en el campo de
 * notas del contacto. La nota clínica sigue en la historia.
 */
export async function listPersonNotes(
  tx: Db,
  orgId: string,
  contactId: string,
): Promise<PersonNote[]> {
  await requireContact(tx, orgId, contactId)
  const notes = await tx
    .select({ id: crmNote.id, body: crmNote.body, at: crmNote.createdAt, authorName: user.name })
    .from(crmNote)
    .leftJoin(user, eq(user.id, crmNote.authorUserId))
    .where(and(eq(crmNote.organizationId, orgId), eq(crmNote.contactId, contactId)))
    .orderBy(desc(crmNote.createdAt), desc(crmNote.id))
    .limit(100)
  const list: PersonNote[] = notes.map((note) => ({
    id: note.id,
    body: note.body,
    at: note.at.toISOString(),
    authorName: note.authorName ?? null,
  }))
  return list
}
