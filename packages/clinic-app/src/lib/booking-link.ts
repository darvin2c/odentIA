import type { RegistrationAnswers, RegistrationConfig } from "@odentia/clinical"
import { ApiError, saveDownload } from "./api"
import { API_URL } from "./auth-client"
import type { PortalBudget } from "./portal"

/**
 * «Su enlace» (ADR 0037): la página personal de cada persona, `/reserva`.
 * Sin sesión: lo único que identifica es el enlace, y nunca trae lo guardado.
 */
export interface BookingAppointment {
  startsAt: string
  endsAt: string
  timeZone: string
  durationMin: number
  branchId: string
  cancelled: boolean
  /** Ya está confirmada. */
  confirmed: boolean
  /** Aún se puede cambiar de horario o cancelar desde el enlace. */
  canChange: boolean
  /** Aún espera que la persona la confirme. */
  canConfirm: boolean
  branchName: string
  branchAddress: string | null
  /** «Cómo llegar» a la sede (Google Maps); null sin dirección. */
  branchDirectionsUrl: string | null
  professionalName: string
  serviceName: string | null
}

export interface BookingLinkBranch {
  id: string
  name: string
  address: string | null
  /** «Cómo llegar» a la sede (Google Maps); ausente o null sin dirección. */
  directionsUrl?: string | null
  timeZone: string
  defaultMinutes: number
}

export interface MissingDatum {
  key: string
  label: string
}

export interface PersonalLinkView {
  /** `vencido`: ya no le queda nada pendiente, o el enlace se reemplazó. */
  status: "abierto" | "vencido"
  clinicName: string
  /** Formato regional de la clínica (BCP 47). */
  locale: string
  /** País de la clínica: de él dependen los documentos que se piden. */
  countryCode: string | null
  /** Nombre de pila de quien abre: «Hola, Pedro». */
  firstName: string | null
  /** Nombre de pila del paciente, cuando no es quien abre. */
  patientFirstName: string | null
  expiresAt: string
  booking: { needsRegistration: boolean; service: { name: string; durationMin: number | null } | null; branchId: string | null } | null
  branches: BookingLinkBranch[]
  appointment: BookingAppointment | null
  /** Qué falta de sus datos y si se le pregunta su salud (opcional); `missing` vacío: solo su salud. */
  data: { missing: MissingDatum[]; health: boolean } | null
  /** Quien ya es paciente, al reservar: lo que ya sabemos, con el documento abreviado. */
  you: { name: string; document: string | null; phone: string | null } | null
  /** Lo que aún no aceptó (el aviso) o no respondió (promociones): se pide en el mismo paso. */
  pending: { privacy: boolean; promotions: boolean } | null
  budgets: PortalBudget[]
  consents: Array<{ id: string; title: string }>
  questionnaire: { title: string } | null
  /** «Tus mensajes» (ADR 0040): solo para quien recibe los mensajes. */
  messages: PersonalLinkMessages | null
  /** «Tus papeles»: la receta y el comprobante de los últimos 30 días. */
  papers: PersonalLinkPaper[]
}

export interface PersonalLinkMessages {
  recordatorio: boolean
  seguimiento: boolean
  novedades: boolean
  /** Pidió no recibir ningún mensaje de la clínica. */
  nothing: boolean
}

export type MessageChoice = "recordatorio" | "seguimiento" | "novedades" | "ninguno"

export interface PersonalLinkPaper {
  kind: "receta" | "comprobante"
  id: string
  title: string
  issuedAt: string
  availableUntil: string
}

export interface BookingSlot {
  startsAt: string
  endsAt: string
  professionalUserId: string
  professionalName: string
  roomId: string | null
}

/** Página pública: sin sesión ni cabecera de organización; lo único que identifica es el enlace. */
async function publicFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { "content-type": "application/json" },
    ...init,
  })
  if (!response.ok) {
    let shape: { code?: string; message?: string; request_id?: string } = {}
    try {
      shape = ((await response.json()) as { error?: typeof shape }).error ?? {}
    } catch {
      // respuesta no-JSON: sin detalle
    }
    throw new ApiError(response.status, shape)
  }
  return (await response.json()) as T
}

const base = (slug: string) => `${API_URL}/api/public/booking/${encodeURIComponent(slug)}`
const post = <T>(url: string, body: unknown) => publicFetch<T>(url, { method: "POST", body: JSON.stringify(body) })

export function fetchBookingLink(slug: string, token: string): Promise<{ data: PersonalLinkView }> {
  return publicFetch(`${base(slug)}?token=${encodeURIComponent(token)}`)
}

/** A dónde lleva el enlace corto para llegar a una sede (`/llegar/<sede>`). */
export function fetchBranchDirections(slug: string, branchSlug: string): Promise<{ data: { branchName: string; url: string } }> {
  return publicFetch(`${base(slug)}/directions/${encodeURIComponent(branchSlug)}`)
}

/** Cambia un interruptor de «Tus mensajes», o «ningún mensaje». */
export function chooseLinkMessages(
  slug: string,
  token: string,
  input: { tipo: MessageChoice; recibir: boolean },
): Promise<{ data: PersonalLinkMessages }> {
  return post(`${base(slug)}/messages`, { token, ...input })
}

/**
 * Descarga un papel de «Tus papeles» (PDF). Es un POST con el token en el
 * cuerpo, como lo demás del enlace: el token no queda en la dirección, ni en
 * registros de acceso ni en el Referer.
 */
export async function downloadLinkPaper(slug: string, token: string, paper: Pick<PersonalLinkPaper, "kind" | "id" | "title">): Promise<void> {
  await saveDownload(await linkPost(`${base(slug)}/papers/${encodeURIComponent(paper.id)}`, { token, kind: paper.kind }), `${paper.title}.pdf`)
}

/** «Añadir al calendario» de su cita: el `.ics` que arma el servidor (issue 46). */
export async function downloadLinkCalendar(slug: string, token: string): Promise<void> {
  await saveDownload(await linkPost(`${base(slug)}/calendar`, { token }), "cita.ics")
}

/** Un POST del enlace que devuelve un archivo: el token va en el cuerpo, nunca en la dirección. */
function linkPost(url: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

export function fetchBookingSlots(
  slug: string,
  token: string,
  range: { branchId: string; from: string; to: string; changing?: boolean },
): Promise<{ data: { slots: BookingSlot[]; timeZone: string; truncated: boolean } }> {
  const query = new URLSearchParams({ token, branchId: range.branchId, from: range.from, to: range.to, ...(range.changing ? { mode: "cambiar" } : {}) })
  return publicFetch(`${base(slug)}/slots?${query.toString()}`)
}

export interface BookingProfessional {
  id: string
  name: string
  /** Su primer horario libre en las próximas semanas; null si no tiene ninguno. */
  next: { startsAt: string; endsAt: string } | null
  /** Tiene hoy la cita que se está cambiando. */
  current: boolean
}

export interface BookingProfessionals {
  professionals: BookingProfessional[]
  /** El primer horario libre de cualquiera de ellos. */
  first: { startsAt: string; professionalUserId: string } | null
  /** Hasta cuándo se buscó. */
  until: string
  timeZone: string
}

/** Con quién se puede reservar en la sede y el próximo horario libre de cada uno: lo entrega el servidor. */
export function fetchBookingProfessionals(slug: string, token: string, branchId: string, changing = false): Promise<{ data: BookingProfessionals }> {
  const query = new URLSearchParams({ token, branchId, ...(changing ? { mode: "cambiar" } : {}) })
  return publicFetch(`${base(slug)}/professionals?${query.toString()}`)
}

export interface BookingRegistrationForm {
  /** El registro de pacientes vigente de la clínica: versión y aviso de privacidad. */
  config: RegistrationConfig
  today: string
  /** El celular de la conversación, solo si el sistema lo conoce (WhatsApp). */
  phone: string | null
  /** País de la clínica: de él dependen los documentos que se ofrecen (ADR 0036). */
  countryCode: string | null
  /** Lo que ya sabemos de quien escribe: viene escrito y se puede corregir. */
  known: {
    givenNames: string | null
    familyName: string | null
    /** De dónde salió el nombre: lo que dijo en la conversación o su perfil de WhatsApp. */
    from: "conversacion" | "perfil" | null
    email: string | null
    docType: string | null
    docNumber: string | null
    birthDate: string | null
    sex: string | null
  }
  /** Nunca respondió lo de novedades y promociones: se le pregunta al reservar. */
  asksPromotions: boolean
  /** Quien escribe ya tiene su registro: la cita es para otra persona, a quien se registra aquí. */
  ownRecord: boolean
}

/** Lo que hace falta para pedir sus datos a quien aún no es paciente. */
export function fetchBookingRegistrationForm(slug: string, token: string): Promise<{ data: BookingRegistrationForm }> {
  return publicFetch(`${base(slug)}/registration?token=${encodeURIComponent(token)}`)
}

/** Registra a la persona con los datos esenciales para reservar; la ficha la crea el registro de pacientes. */
export function submitBookingRegistration(
  slug: string,
  input: { token: string; submissionId: string; formVersion: number; answers: RegistrationAnswers },
): Promise<{ data: { registered: boolean } }> {
  return post(`${base(slug)}/registration`, input)
}

/** Lo que guarda la reserva de quien ya es paciente: lo que le faltaba y lo que acepta. */
export interface BookingYou {
  data: Partial<Record<string, string>>
  privacyAccepted?: boolean
  acceptsPromotions?: boolean
}

export function reserveBooking(
  slug: string,
  input: { token: string; branchId: string; startsAt: string; professionalUserId: string; roomId?: string; planItemIds?: string[]; you?: BookingYou },
): Promise<{ data: BookingAppointment }> {
  return post(`${base(slug)}/reserve`, input)
}

/** Cambia de horario la cita del enlace. */
export function changeBooking(
  slug: string,
  input: { token: string; startsAt: string; professionalUserId: string; roomId?: string },
): Promise<{ data: BookingAppointment }> {
  return post(`${base(slug)}/change`, input)
}

/** Cancela la cita del enlace. */
export function cancelBooking(slug: string, token: string): Promise<{ data: BookingAppointment }> {
  return post(`${base(slug)}/cancel`, { token })
}

/** Confirma la cita del enlace. */
export function confirmBooking(slug: string, token: string): Promise<{ data: BookingAppointment }> {
  return post(`${base(slug)}/confirm`, { token })
}

export interface PersonalDataForm {
  missing: MissingDatum[]
  countryCode: string | null
  today: string
  /** Ya tiene representante legal: si la fecha dice que es menor, no se le vuelve a pedir. */
  hasRepresentative: boolean
  /** El registro de la clínica: el cuestionario pregunta lo que falta con sus mismas pantallas. */
  registration: RegistrationConfig
  /** Si se le pregunta su salud (nadie la registró aún en su ficha). */
  asksHealth: boolean
  firstName: string | null
  /** Lo que aún no aceptó o respondió (registrada por teléfono, por ejemplo): va antes de enviar. */
  pending: { privacy: boolean; promotions: boolean }
}

export function fetchPersonalDataForm(slug: string, token: string): Promise<{ data: PersonalDataForm }> {
  return publicFetch(`${base(slug)}/data?token=${encodeURIComponent(token)}`)
}

export interface PersonalDataInput {
  data: Partial<Record<string, string>>
  representative?: {
    displayName: string
    docType?: string
    docNumber?: string
    docCountry?: string
    phone?: string
    relationshipDetail?: string
  } | null
  health?: RegistrationAnswers["health"] | null
  privacyAccepted?: boolean
  acceptsPromotions?: boolean
  /** Se le dijo que le escribiremos por WhatsApp al celular que dejó. */
  acceptsReminders?: boolean
}

/** «Tus datos»: solo lo que falta, una sola vez. */
export function submitPersonalData(slug: string, token: string, input: PersonalDataInput): Promise<{ data: { received: true } }> {
  return post(`${base(slug)}/data`, { token, ...input })
}

export interface BudgetAnswerInput {
  optionId?: string | null
  decisions: Array<{ planItemId: string; decision: "aceptado" | "rechazado" | "pospuesto" }>
}

/** «Ver y responder»: lo que aceptó y lo que queda por agendar. */
export function answerLinkBudget(
  slug: string,
  token: string,
  budgetId: string,
  input: BudgetAnswerInput,
): Promise<{ data: { budget: PortalBudget; toSchedule: Array<{ planItemId: string; title: string }> } }> {
  return post(`${base(slug)}/budgets/${encodeURIComponent(budgetId)}/decision`, { token, ...input })
}

export interface ConsentSection {
  procedure?: string
  benefits?: string[]
  risks?: string[]
  alternatives?: string[]
  consequences?: string
}

export interface LinkConsent {
  id: string
  title: string
  sections: ConsentSection | null
  body: string
  /** Quién firma y el tipo de documento que escribe (nunca el número guardado). */
  signer: { name: string; asRepresentative: boolean; documentLabel: string | null }
}

export function fetchLinkConsent(slug: string, token: string, consentId: string): Promise<{ data: LinkConsent }> {
  return publicFetch(`${base(slug)}/consents/${encodeURIComponent(consentId)}?token=${encodeURIComponent(token)}`)
}

export function signLinkConsent(
  slug: string,
  token: string,
  consentId: string,
  input: { docNumber: string; comprehensionConfirmed: boolean; signatureData: { strokes: number[][][] } },
): Promise<{ data: { signed: true } }> {
  return post(`${base(slug)}/consents/${encodeURIComponent(consentId)}/sign`, { token, ...input })
}

export interface LinkQuestionnaire {
  id: string
  title: string
  version: number
  schema: import("./clinical-forms").FormSchemaDef
}

export function fetchLinkQuestionnaire(slug: string, token: string): Promise<{ data: LinkQuestionnaire }> {
  return publicFetch(`${base(slug)}/questionnaire?token=${encodeURIComponent(token)}`)
}

export function submitLinkQuestionnaire(slug: string, token: string, answers: Record<string, unknown>): Promise<{ data: { submitted: true } }> {
  return post(`${base(slug)}/questionnaire`, { token, answers })
}
