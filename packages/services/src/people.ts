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
import { clinicalProfileFor, documentIssuerCountry, validateDemographics } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { patient, patientContact } from "@odentia/db/schema/clinical"
import { channelConnection, contact, contactIdentity, conversation } from "@odentia/db/schema/crm"
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
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import { findOrgCountry } from "./locale.js"
import { personSearchCondition } from "./person-search.js"
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
  paternalSurname: string | null
  maternalSurname: string | null
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
    .select({ patientId: patientContact.patientId })
    .from(patientContact)
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.contactId, contactId),
        eq(patientContact.relationship, "self"),
      ),
    )
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
    .from(patientContact)
    .innerJoin(
      patient,
      and(eq(patient.id, patientContact.patientId), eq(patient.organizationId, orgId)),
    )
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.contactId, contactId),
        eq(patientContact.relationship, "self"),
      ),
    )
    .limit(1)
  const responsibleRows = await tx
    .select({
      patientId: patient.id,
      displayName: patient.displayName,
      patientNumber: patient.patientNumber,
      birthDate: patient.birthDate,
      patientActive: patient.isActive,
      relationship: patientContact.relationship,
      relationshipDetail: patientContact.relationshipDetail,
      kinship: patientContact.kinship,
      personId: sql<
        string | null
      >`(select s.contact_id from patient_contact s where s.organization_id = ${orgId} and s.patient_id = ${patient.id} and s.relationship = 'self' limit 1)`,
      personActive: sql<
        boolean | null
      >`(select c2.is_active from patient_contact s join contact c2 on c2.organization_id = s.organization_id and c2.id = s.contact_id where s.organization_id = ${orgId} and s.patient_id = ${patient.id} and s.relationship = 'self' limit 1)`,
    })
    .from(patientContact)
    .innerJoin(
      patient,
      and(eq(patient.id, patientContact.patientId), eq(patient.organizationId, orgId)),
    )
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.contactId, contactId),
        sql`${patientContact.relationship} <> 'self'`,
      ),
    )
    .orderBy(patient.displayName, patient.id)
  const readsConversations = can("conversations.read")
  const spokenRows = own
    ? await tx
        .select({
          personId: contact.id,
          displayName: contact.displayName,
          phone: contact.phone,
          isPatient: sql<boolean>`exists (select 1 from patient_contact s where s.organization_id = ${orgId} and s.contact_id = ${contact.id} and s.relationship = 'self')`,
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
    archived: !r.patientActive || r.personActive === false,
  }))
  const archived = !row.isActive || (own ? !own.patient.isActive : false)
  return {
    id: row.id,
    displayName: row.displayName,
    givenNames: row.givenNames,
    paternalSurname: row.paternalSurname,
    maternalSurname: row.maternalSurname,
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
          identityNeedsReview: own.patient.identityNeedsReview,
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
 * Vistas de la lista: las cinco de la pantalla y `activos` (todas las personas
 * sin archivar), que usa el buscador de personas al elegir a alguien.
 */
export const PEOPLE_VIEWS = [
  "pacientes",
  "por_registrar",
  "responsables",
  "archivados",
  "todos",
  "activos",
] as const
export type PeopleView = (typeof PEOPLE_VIEWS)[number]

export interface PersonListItem {
  id: string
  displayName: string
  kind: PersonKind
  archived: boolean
  patient: { id: string; patientNumber: number } | null
  docType: string | null
  docNumber: string | null
  sex: string | null
  phone: string | null
  /** Hasta dos nombres de los pacientes de los que es responsable, y cuántos son. */
  responsibleFor: string[]
  responsibleCount: number
  /** Próxima cita por venir; solo para quien ve la agenda. */
  nextAppointmentAt: string | null
  /** Último mensaje con la persona; solo para quien lee conversaciones. */
  lastInteractionAt: string | null
}

export interface PeopleListInput {
  view?: string
  q?: string
  cursor?: string
  limit?: number
}

const PEOPLE_PAGE = 30

/** Archivada entera: la persona o su ficha (lo que quedó de antes de unir los dos indicadores). */
const ARCHIVED_SQL = sql`(not c.is_active or coalesce(not p.is_active, false))`
const RESPONSIBLE_SQL = sql`exists (select 1 from patient_contact r join patient rp on rp.organization_id = r.organization_id and rp.id = r.patient_id where r.organization_id = c.organization_id and r.contact_id = c.id and r.relationship <> 'self' and rp.is_active)`

function viewCondition(view: PeopleView) {
  switch (view) {
    case "pacientes":
      return sql`p.id is not null and not ${ARCHIVED_SQL}`
    case "por_registrar":
      return sql`p.id is null and not ${RESPONSIBLE_SQL} and not ${ARCHIVED_SQL}`
    case "responsables":
      return sql`${RESPONSIBLE_SQL} and not ${ARCHIVED_SQL}`
    case "archivados":
      return ARCHIVED_SQL
    case "todos":
      return sql`true`
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
  })
}

function encodePeopleCursor(name: string, id: string, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ n: name, id, f: fingerprint }), "utf8").toString("base64url")
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

/**
 * La lista de personas de la clínica, una sola: los filtros son vistas de la
 * misma persona («Pacientes» por defecto). Búsqueda, orden por nombre y
 * páginas los hace el servidor; el total de «Por registrar» es de toda la
 * clínica, no de la página cargada. Quien no ve a quien aún no es paciente
 * (`seesNonPatients`) recibe solo pacientes, en cualquier vista que tenga.
 */
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
  // Caja y odontología solo ven pacientes: sin las vistas de quien aún no lo es.
  const everyone = seesNonPatients(can)
  if (!everyone && (view === "por_registrar" || view === "responsables"))
    throw new ServiceError("FORBIDDEN", 403, "Esta vista es de quien lleva la relación con las personas")
  const onlyPatients = everyone ? sql`true` : sql`p.id is not null`
  const limit = Math.min(Math.max(input.limit ?? PEOPLE_PAGE, 1), 100)
  const q = input.q?.trim() ?? ""
  const fingerprint = JSON.stringify({ view, q })
  let after = sql`true`
  if (input.cursor) {
    const decoded = decodePeopleCursor(input.cursor)
    if (!decoded) throw validation("Cursor inválido")
    if (decoded.f !== fingerprint)
      throw validation("El cursor no corresponde a los filtros actuales")
    after = sql`(c.display_name, c.id) > (${decoded.n}, ${decoded.id}::uuid)`
  }
  const agenda = can("appointments.read")
  const chats = can("conversations.read") || can("crm.read")
  const rows = await tx.execute<{
    id: string
    display_name: string
    is_active: boolean
    patient_id: string | null
    patient_number: number | null
    patient_active: boolean | null
    doc_type: string | null
    doc_number: string | null
    sex: string | null
    phone: string | null
    last_interaction_at: string | null
    responsible_names: string[] | null
    responsible_count: number
    next_appointment_at: string | null
  }>(sql`
    select c.id, c.display_name, c.is_active, p.id as patient_id, p.patient_number, p.is_active as patient_active,
      c.doc_type, c.doc_number, c.sex, c.phone,
      to_char(c.last_interaction_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_interaction_at,
      (select array_agg(n order by n) from (
        select rp.display_name as n from patient_contact r
          join patient rp on rp.organization_id = r.organization_id and rp.id = r.patient_id
          where r.organization_id = c.organization_id and r.contact_id = c.id and r.relationship <> 'self' and rp.is_active
          order by rp.display_name limit 2) names) as responsible_names,
      (select count(*)::int from patient_contact r
          join patient rp on rp.organization_id = r.organization_id and rp.id = r.patient_id
          where r.organization_id = c.organization_id and r.contact_id = c.id and r.relationship <> 'self' and rp.is_active) as responsible_count,
      ${
        agenda
          ? sql`(select to_char(min(a.starts_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from appointment a
              where a.organization_id = c.organization_id and a.patient_id = p.id and a.starts_at > now()
                and a.status in ('programada', 'confirmada'))`
          : sql`null`
      } as next_appointment_at
    from contact c
    left join patient_contact pc on pc.organization_id = c.organization_id and pc.contact_id = c.id and pc.relationship = 'self'
    left join patient p on p.organization_id = pc.organization_id and p.id = pc.patient_id
    where c.organization_id = ${orgId}
      and ${viewCondition(view)}
      and ${onlyPatients}
      and ${searchCondition(q)}
      and ${after}
    order by c.display_name asc, c.id asc
    limit ${limit + 1}
  `)
  const list = [...rows]
  const page = list.slice(0, limit)
  const [counted] = everyone
    ? await tx.execute<{ count: number }>(sql`
    select count(*)::int as count from contact c
    left join patient_contact pc on pc.organization_id = c.organization_id and pc.contact_id = c.id and pc.relationship = 'self'
    left join patient p on p.organization_id = pc.organization_id and p.id = pc.patient_id
    where c.organization_id = ${orgId} and ${viewCondition("por_registrar")}
  `)
    : [{ count: 0 }]
  const items: PersonListItem[] = page.map((r) => {
    const responsibleCount = Number(r.responsible_count ?? 0)
    const archived = !r.is_active || r.patient_active === false
    return {
      id: r.id,
      displayName: r.display_name,
      kind: r.patient_id ? "paciente" : responsibleCount > 0 ? "responsable" : "por_registrar",
      archived,
      patient:
        r.patient_id && r.patient_number !== null
          ? { id: r.patient_id, patientNumber: Number(r.patient_number) }
          : null,
      docType: r.doc_type,
      docNumber: r.doc_number,
      sex: r.sex,
      phone: r.phone,
      responsibleFor: r.responsible_names ?? [],
      responsibleCount,
      nextAppointmentAt: agenda ? r.next_appointment_at : null,
      lastInteractionAt: chats ? r.last_interaction_at : null,
    }
  })
  const last = page[page.length - 1]
  return {
    items,
    nextCursor:
      list.length > limit && last
        ? encodePeopleCursor(last.display_name, last.id, fingerprint)
        : null,
    counts: { porRegistrar: Number(counted?.count ?? 0) },
  }
}

/* ------------------------------------------------------------------ */
/* Identidad: un solo formulario, las reglas de la ficha.               */
/* ------------------------------------------------------------------ */

export const PERSON_IDENTITY_FIELDS = [
  "displayName",
  "givenNames",
  "paternalSurname",
  "maternalSurname",
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
 * la regla del menor) y la base lo copia a la persona; si no, se valida igual
 * sobre lo que ya tiene y se guarda en la persona. El agente no cambia la
 * identidad de quien ya es paciente.
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
    paternalSurname: locked.paternalSurname,
    maternalSurname: locked.maternalSurname,
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
  const composed = [merged.givenNames, merged.paternalSurname, merged.maternalSurname]
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
  const first = Object.values(errors)[0]
  if (first) throw validation(first)
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
  paternalSurname?: string | null
  maternalSurname?: string | null
  displayName?: string | null
  phone?: string | null
  email?: string | null
  /** Su documento, si se conoce (el representante del registro lo trae). */
  docType?: string | null
  docNumber?: string | null
  docCountry?: string | null
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
  const paternalSurname = clean(input.paternalSurname)
  const maternalSurname = clean(input.maternalSurname)
  const composed = [givenNames, paternalSurname, maternalSurname].filter(Boolean).join(" ")
  const displayName = composed || clean(input.displayName)
  if (!displayName) throw validation("Indica el nombre de la persona")
  const countryCode = await findOrgCountry(tx, orgId)
  const errors = validateDemographics(
    {
      displayName,
      givenNames,
      paternalSurname,
      maternalSurname,
      phone: clean(input.phone),
      email: clean(input.email),
      docType: clean(input.docType),
      docNumber: clean(input.docNumber),
      docCountry: clean(input.docCountry),
    },
    await patientOrganizationToday(tx, orgId),
    countryCode,
  )
  const first = Object.values(errors)[0]
  if (first) throw validation(first)
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
        paternalSurname,
        maternalSurname,
        phone: clean(input.phone),
        email: clean(input.email),
        ...(doc ?? {}),
      },
      actor,
    )
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ServiceError("DUPLICATE_DOCUMENT", 409, "Ese documento ya es de otra persona")
    throw error
  }
  return { id: created.id }
}

/**
 * Un solo «Archivar»: la persona y su ficha se archivan y se recuperan juntas.
 * Los dos indicadores (`contact.is_active`, `patient.is_active`) siguen
 * existiendo, pero esta es la única operación que los cambia; archivar revoca
 * sus enlaces de registro pendientes (`applyContactActive`).
 */
export async function setPersonArchived(
  tx: Db,
  orgId: string,
  actor: { userId: string | null },
  contactId: string,
  archived: boolean,
): Promise<void> {
  await applyContactActive(tx, orgId, contactId, !archived, actor)
  const patientId = await selfPatientOf(tx, orgId, contactId)
  if (patientId) {
    const [changed] = await tx
      .update(patient)
      .set({ isActive: !archived, updatedAt: new Date() })
      .where(
        and(
          eq(patient.organizationId, orgId),
          eq(patient.id, patientId),
          eq(patient.isActive, archived),
        ),
      )
      .returning({ id: patient.id })
    if (changed)
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
