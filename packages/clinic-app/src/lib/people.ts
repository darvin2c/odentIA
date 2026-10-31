import type { ContactScreenView } from "./crm"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "./api"
import type { PlanNextStep } from "./budgets"
import type { PageOf } from "./patient-areas"
import type { PhoneWhatsApp } from "./phone-whatsapp"

/**
 * La persona y su página (ADR 0029). La dirección es `/people/:personId`,
 * con el id de su contacto: es la misma antes y después de registrarla como
 * paciente. Lo que solo conoce la ficha (`patientId`) llega por
 * `/patients/:patientId`, que redirige.
 */

export type PersonKind = "paciente" | "responsable" | "por_registrar"

export const PERSON_KIND_LABELS: Record<PersonKind, string> = {
  paciente: "Paciente",
  responsable: "Vinculada a un paciente",
  por_registrar: "Contacto nuevo",
}

export interface PersonResponsibleFor {
  personId: string | null
  patientId: string
  displayName: string
  patientNumber: number
  birthDate: string | null
  relationship: string
  relationshipDetail: string | null
  /** Parentesco con HL7 v3 RoleCode, si se conoce. */
  kinship?: string | null
  archived: boolean
}

export interface PersonSpokenForBy {
  personId: string
  displayName: string
  /** Su teléfono, para quien no tiene uno propio. */
  phone?: string | null
  /** También es paciente: su página la abre también quien solo ve pacientes. */
  isPatient?: boolean
  relationship: string
  relationshipDetail: string | null
  /** Parentesco con HL7 v3 RoleCode, si se conoce. */
  kinship?: string | null
  isPreferred: boolean
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
  /** Menor de edad hoy, con el día de la clínica: lo decide el servidor. */
  isMinor: boolean
  sex: string | null
  phone: string | null
  /** Si su teléfono es ya su WhatsApp, aún no o no tiene (decisión 23). */
  phoneWhatsApp: PhoneWhatsApp
  email: string | null
  archived: boolean
  /** Su historia está bloqueada (ADR 0080): solo llega aquí si Administración la abrió para leer. */
  recordLocked?: boolean
  /** Spam o bloqueada (ADR 0054); nulo si no la ve quien mira. Ausente en respuestas antiguas en caché. */
  screen?: ContactScreenView | null
  createdAt: string
  kind: PersonKind
  patient: {
    id: string
    patientNumber: number
    identityNeedsReview: boolean
    avatarStorageKey: string | null
  } | null
  responsibleFor: PersonResponsibleFor[]
  spokenForBy: PersonSpokenForBy[]
  channels: string[]
}

export type { PhoneWhatsApp } from "./phone-whatsapp"

/** En qué está quien aún no es paciente (tablero 3 del lienzo). */
export type PersonSituation =
  | "responder"
  | "agente"
  | "enlace"
  | "oportunidad"
  | "sin_respuesta"
  | "esperamos"
  | "sin_conversacion"
  | "sin_pendientes"

export interface PersonListItem {
  id: string
  displayName: string
  familyName: string | null
  kind: PersonKind
  archived: boolean
  /** En Spam o bloqueada (ADR 0054); solo llega a quien lee conversaciones. */
  screen?: "spam" | "blocked" | null
  patient: { id: string; patientNumber: number } | null
  age: number | null
  docType: string | null
  docNumber: string | null
  sex: string | null
  phone: string | null
  /** Vínculos con pacientes en palabras («Madre de Mateo Vargas»), hasta dos. */
  vinculos: string[]
  vinculoCount: number
  nextAppointmentAt: string | null
  lastVisitAt: string | null
  lastInteractionAt: string | null
  /** Cómo llegó: su primer canal (nulo si lo registró el equipo). */
  firstContact: { channel: string | null; at: string } | null
  situation: PersonSituation | null
  waitingSince: string | null
  /** El paso entero de «Qué sigue»: su botón hace lo que dice desde la lista. */
  nextStep: { text: string; actionLabel: string | null; kind: PlanNextStep["kind"] | null; action: PlanNextStep["action"] } | null
  attention: "agente" | "persona" | "nadie" | null
  missingData: boolean
}

export const PEOPLE_VIEWS = [
  { id: "pacientes", label: "Pacientes" },
  { id: "por_registrar", label: "Contactos nuevos" },
  { id: "archivados", label: "Archivados" },
  { id: "todos", label: "Todos" },
] as const
export type PeopleView = (typeof PEOPLE_VIEWS)[number]["id"]

/** Los atajos de Pacientes, con las palabras de la pantalla (decisión 6). */
export const PEOPLE_SHORTCUTS = [
  { id: "por_agendar", label: "Por agendar" },
  { id: "presupuesto_sin_enviar", label: "Presupuesto sin enviar" },
  { id: "presupuesto_sin_respuesta", label: "Presupuesto sin respuesta" },
  { id: "control_por_reservar", label: "Control por reservar" },
  { id: "faltan_datos", label: "Faltan datos" },
  { id: "por_invitar_a_volver", label: "Por invitar a volver" },
  { id: "deben", label: "Deben" },
] as const
export type PeopleShortcut = (typeof PEOPLE_SHORTCUTS)[number]["id"]

/** Cuántos hay en cada atajo que quien mira ve; nulo si no lo ve. */
export type PeopleShortcutCounts = Record<PeopleShortcut, number | null>

export function isPeopleShortcut(value: unknown): value is PeopleShortcut {
  return PEOPLE_SHORTCUTS.some((shortcut) => shortcut.id === value)
}

export function isPeopleView(value: unknown): value is PeopleView {
  return PEOPLE_VIEWS.some((view) => view.id === value)
}

export interface PersonConversation {
  id: string
  status: string
  channel: string
  connectionName: string
  lastMessageAt: string | null
  closure: {
    reason: "resuelta" | "sin_respuesta" | "equipo" | "manual"
    at: string
    byName: string | null
  } | null
}

export interface PersonNote {
  id: string
  body: string
  at: string
  /** null si la dejó el sistema (al unir persona y ficha). */
  authorName: string | null
}

export function personQueryKey(personId: string) {
  return ["person", personId] as const
}

/**
 * Lo que decide las pestañas y los botones de su página. La lista lo deja en la
 * caché, así la página que se abre desde ella los muestra desde el primer pintado.
 */
export interface PersonShape {
  pageOf: PageOf
  archived: boolean
}

export function personShapeKey(personId: string) {
  return ["person-shape", personId] as const
}

export function personShapeOf(person: { kind: PersonKind; archived: boolean; patient: { id: string } | null }): PersonShape {
  return { pageOf: person.patient ? true : person.kind === "responsable" ? "responsable" : false, archived: person.archived }
}

export function fetchPerson(personId: string): Promise<{ data: PersonPage }> {
  return apiFetch<{ data: PersonPage }>(`/api/people/${encodeURIComponent(personId)}`)
}

/** Cabecera de la página: quién es y qué es para la clínica (`patients.read`). */
export function usePerson(personId: string, enabled = true) {
  return useQuery({
    queryKey: personQueryKey(personId),
    queryFn: () => fetchPerson(personId),
    enabled,
    retry: false,
  })
}

/**
 * La persona de un paciente, para quien solo conoce la ficha. La página de la
 * persona deja este dato en caché al abrirse, así los enlaces internos de la
 * ficha llegan sin otra petición.
 */
export function personOfPatientKey(patientId: string) {
  return ["person-of-patient", patientId] as const
}

export function fetchPersonOfPatient(patientId: string): Promise<{ data: { personId: string } }> {
  return apiFetch<{ data: { personId: string } }>(
    `/api/people/by-patient/${encodeURIComponent(patientId)}`,
  )
}

/**
 * En el navegador, la persona de cada paciente ya buscada (5 minutos): la ficha
 * vieja (`/patients/…`) salta a la de la persona sin otro viaje, y al acercar el
 * puntero a un enlace la búsqueda ya queda hecha. En SSR no se guarda nada.
 */
const PERSON_OF_PATIENT_MS = 5 * 60_000
const personOfPatient = new Map<string, { at: number; personId: Promise<string> }>()

export function personIdOfPatient(patientId: string): Promise<string> {
  const read = () => fetchPersonOfPatient(patientId).then(({ data }) => data.personId)
  if (typeof window === "undefined") return read()
  const known = personOfPatient.get(patientId)
  if (known && Date.now() - known.at < PERSON_OF_PATIENT_MS) return known.personId
  const personId = read()
  personOfPatient.set(patientId, { at: Date.now(), personId })
  personId.catch(() => personOfPatient.delete(patientId))
  return personId
}

/** La página de la persona ya sabe quién es su paciente: lo deja anotado. */
export function rememberPersonOfPatient(patientId: string, personId: string): void {
  if (typeof window !== "undefined") personOfPatient.set(patientId, { at: Date.now(), personId: Promise.resolve(personId) })
}

/** Palabras de la relación con la que una persona está vinculada a un paciente. */
export const RELATIONSHIP_WORDS: Record<string, string> = {
  self: "la propia persona",
  guardian: "tutor o responsable",
  family: "familiar",
  other: "otra persona",
}

/** El parentesco como lo escribió la clínica («Padre») o, si no, el tipo de vínculo. */
export function relationshipText(relationship: string, detail: string | null): string {
  return detail?.trim() || RELATIONSHIP_WORDS[relationship] || relationship
}

const SECTION_KEY = (patientId: string) => `odentia:seccion-de-la-persona:${patientId}`

/** La pestaña de su página donde estaba quien trabaja con este paciente (solo en esta pestaña del navegador). */
export function rememberPatientSection(patientId: string, section: string): void {
  try {
    sessionStorage.setItem(SECTION_KEY(patientId), section)
  } catch {
    // Sin almacenamiento la miga vuelve a la pestaña de siempre.
  }
}

/** La pestaña a la que vuelve la miga de una atención; nula si no se sabe. */
export function lastPatientSection(patientId: string): string | null {
  try {
    return sessionStorage.getItem(SECTION_KEY(patientId))
  } catch {
    return null
  }
}

/** Lo que dice «En qué está», con las mismas palabras de la Bandeja (tablero 3). */
export function situationText(item: Pick<PersonListItem, "situation" | "waitingSince">, now = Date.now()): string {
  switch (item.situation) {
    case "responder":
      return "Espera al equipo"
    case "agente":
      return "Habla con el agente"
    case "enlace":
      return "Le enviamos su enlace"
    case "oportunidad":
      return "Tiene una oportunidad abierta"
    case "sin_respuesta": {
      const days = daysSince(item.waitingSince, now)
      return days === null ? "Sin respuesta" : `Sin respuesta hace ${days} ${days === 1 ? "día" : "días"}`
    }
    case "esperamos":
      return "Esperamos su respuesta"
    case "sin_conversacion":
      return "Sin conversación"
    case "sin_pendientes":
      return "Sin pendientes"
    default:
      return ""
  }
}

/** El botón de la fila según lo que está pasando: abre donde se resuelve. */
export function situationAction(situation: PersonSituation | null): string {
  switch (situation) {
    case "responder":
      return "Responder"
    case "enlace":
      return "Reenviar enlace"
    case "oportunidad":
      return "Ver oportunidad"
    case "sin_respuesta":
      return "Escribirle"
    case "sin_conversacion":
      return "Registrar"
    case "sin_pendientes":
      return "Ver ficha"
    default:
      return "Ver conversación"
  }
}

/** Quién lleva lo que sigue, con las palabras de la fila. */
export function attentionWords(attention: PersonListItem["attention"]): string | null {
  if (attention === "agente") return "Lo lleva el agente"
  if (attention === "persona") return "Lo lleva una persona del equipo"
  if (attention === "nadie") return "Nadie lo lleva todavía"
  return null
}

/** Días enteros desde una fecha ISO; nulo si no hay fecha. */
export function daysSince(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return null
  return Math.max(0, Math.floor((now - time) / 86_400_000))
}
