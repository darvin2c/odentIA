import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "./api"

/**
 * La persona y su página (ADR 0029). La dirección es `/people/:personId`,
 * con el id de su contacto: es la misma antes y después de registrarla como
 * paciente. Lo que solo conoce la ficha (`patientId`) llega por
 * `/patients/:patientId`, que redirige.
 */

export type PersonKind = "paciente" | "responsable" | "por_registrar"

export const PERSON_KIND_LABELS: Record<PersonKind, string> = {
  paciente: "Paciente",
  responsable: "Responsable",
  por_registrar: "Por registrar",
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
  paternalSurname: string | null
  maternalSurname: string | null
  docType: string | null
  docNumber: string | null
  docCountry: string | null
  birthDate: string | null
  sex: string | null
  phone: string | null
  email: string | null
  archived: boolean
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
  responsibleFor: string[]
  responsibleCount: number
  nextAppointmentAt: string | null
  lastInteractionAt: string | null
}

export const PEOPLE_VIEWS = [
  { id: "pacientes", label: "Pacientes" },
  { id: "por_registrar", label: "Por registrar" },
  { id: "responsables", label: "Responsables" },
  { id: "archivados", label: "Archivados" },
  { id: "todos", label: "Todos" },
] as const
export type PeopleView = (typeof PEOPLE_VIEWS)[number]["id"]

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
  authorName: string | null
  legacy: boolean
}

export function personQueryKey(personId: string) {
  return ["person", personId] as const
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
