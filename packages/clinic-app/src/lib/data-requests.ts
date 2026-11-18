import { apiFetch, saveDownload } from "./api"
import { API_URL } from "./auth-client"
import { orgSlugFromHostname, requestHostname } from "./host"

/**
 * Pedidos de la persona sobre sus datos (ADR 0080): una copia, corregir, no
 * recibir mensajes o borrar sus datos, cada uno con 10 días para responder, en cualquier país.
 */
export type DataRequestKind = "copia" | "corregir" | "mensajes" | "borrar"
export type DataRequestChannel = "clinica" | "whatsapp" | "correo" | "portal"
export type DataRequestVerification = "documento" | "portal" | "representante"
export type DataRequestStatus = "pendiente" | "respondida" | "denegada"

export interface DataRequest {
  id: string
  patientId: string
  kind: DataRequestKind
  requesterContactId: string
  requesterName: string
  requesterRelation: "paciente" | "representante_legal" | null
  channel: DataRequestChannel
  requestedOn: string
  dueOn: string
  said: string | null
  status: DataRequestStatus
  verifiedHow: DataRequestVerification | null
  verifiedAt: string | null
  verifiedByName: string | null
  resolution: string | null
  resolvedAt: string | null
  resolvedByName: string | null
  createdAt: string
  /** La copia que se le envió con su enlace: hasta cuándo sirve y si ya la bajó. */
  copy: DataRequestCopy | null
}

export interface DataRequestCopy {
  until: string
  downloads: number
  lastDownloadAt: string | null
}

export const DATA_REQUEST_KIND_TEXT: Record<DataRequestKind, { title: string; detail: string }> = {
  copia: {
    title: "Una copia de sus datos",
    detail: "Su historia en PDF y en un archivo que otra clínica puede cargar.",
  },
  corregir: { title: "Corregir un dato", detail: "Su dirección, su documento o algo de su historia." },
  mensajes: {
    title: "No recibir mensajes",
    detail: "Se apagan al registrarlo; los avisos de sus citas y papeles siguen.",
  },
  borrar: {
    title: "Borrar sus datos",
    detail: "Se borra lo que no es clínico; su historia y sus cobros se guardan bloqueados. Lo hace Administración.",
  },
}

/** El título corto de un pedido en una lista: «Copia de su historia». */
export const DATA_REQUEST_ROW_TITLE: Record<DataRequestKind, string> = {
  copia: "Copia de su historia",
  corregir: "Corregir un dato",
  mensajes: "No recibir mensajes",
  borrar: "Borrar sus datos",
}

export const DATA_REQUEST_CHANNEL_TEXT: Record<DataRequestChannel, string> = {
  clinica: "En la clínica",
  whatsapp: "WhatsApp",
  correo: "Correo",
  portal: "Su portal",
}

/** Cómo llegó, dicho en una frase: «Lo pidió Rosa Quispe por WhatsApp». */
export const DATA_REQUEST_CHANNEL_PHRASE: Record<DataRequestChannel, string> = {
  clinica: "en la clínica",
  whatsapp: "por WhatsApp",
  correo: "por correo",
  portal: "desde su portal",
}

export const DATA_REQUEST_VERIFICATION_TEXT: Record<DataRequestVerification, string> = {
  documento: "En la clínica, con su documento",
  portal: "Lo pidió desde su portal",
  representante: "Su representante legal, con su documento",
}

export const DATA_REQUEST_STATUS_TEXT: Record<DataRequestStatus, string> = {
  pendiente: "Pendiente",
  respondida: "Respondida",
  denegada: "Denegada",
}

/** Días corridos para responder, desde el día siguiente (los mismos del servidor). */
export const DATA_REQUEST_DAYS = 10

export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** Días que faltan hasta `dueOn` desde `today` (negativo si ya venció). */
export function daysLeft(today: string, dueOn: string): number {
  return Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
}

/** «jueves 1 nov»: el día del plazo, en palabras. */
export function dayWords(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(`${day}T00:00:00Z`))
    .replaceAll(".", "")
    .replaceAll(",", "")
}

/** «quedan 3 días», «vence hoy», «venció hace 2 días». */
export function dueWords(today: string, dueOn: string): string {
  const left = daysLeft(today, dueOn)
  if (left > 1) return `quedan ${left} días`
  if (left === 1) return "vence mañana"
  if (left === 0) return "vence hoy"
  return left === -1 ? "venció ayer" : `venció hace ${-left} días`
}

export const dataRequestsKey = (patientId: string) => ["data-requests", patientId] as const

const base = (patientId: string) => `/api/patients/${patientId}/data-requests`

export interface DataRequestsView {
  requests: DataRequest[]
  /** La propia persona si es mayor de edad y su representante legal vigente. */
  requesters: Array<{ contactId: string; displayName: string; relation: "paciente" | "representante_legal" }>
  /** Hoy en la clínica (AAAA-MM-DD). */
  today: string
}

export async function fetchDataRequests(patientId: string): Promise<DataRequestsView> {
  return (await apiFetch<{ data: DataRequestsView }>(base(patientId))).data
}

export async function createDataRequestApi(
  patientId: string,
  input: { kind: DataRequestKind; requesterContactId: string; channel: DataRequestChannel; requestedOn?: string; said?: string },
): Promise<DataRequest> {
  return (await apiFetch<{ data: DataRequest }>(base(patientId), { method: "POST", body: JSON.stringify(input) })).data
}

export async function verifyDataRequestApi(patientId: string, id: string, how: DataRequestVerification): Promise<DataRequest> {
  return (await apiFetch<{ data: DataRequest }>(`${base(patientId)}/${id}/verify`, { method: "POST", body: JSON.stringify({ how }) })).data
}

export async function respondDataRequestApi(patientId: string, id: string, resolution: string): Promise<DataRequest> {
  return (
    await apiFetch<{ data: DataRequest }>(`${base(patientId)}/${id}/respond`, { method: "POST", body: JSON.stringify({ resolution }) })
  ).data
}

export async function denyDataRequestApi(patientId: string, id: string, reason: string): Promise<DataRequest> {
  return (await apiFetch<{ data: DataRequest }>(`${base(patientId)}/${id}/deny`, { method: "POST", body: JSON.stringify({ reason }) })).data
}

export interface RecordSendChannel {
  channel: string
  connectionId: string
  connectionName: string
  usable: boolean
  reason: string | null
  /** Qué le llega por aquí («…le llega el PDF con el mensaje aprobado para documentos»). */
  note?: string | null
  /** Pasaron 24 horas: sale con el mensaje aprobado para documentos. */
  viaTemplate?: boolean
  isProposed: boolean
}

export async function fetchRecordSendOptions(
  patientId: string,
  id: string,
): Promise<{ recipient: { contactId: string; displayName: string } | null; channels: RecordSendChannel[] }> {
  return (await apiFetch<{ data: { recipient: { contactId: string; displayName: string } | null; channels: RecordSendChannel[] } }>(
    `${base(patientId)}/${id}/send-options`,
  )).data
}

export async function sendRecordCopyApi(patientId: string, id: string, connectionId: string): Promise<{ request: DataRequest; channel: string }> {
  return (
    await apiFetch<{ data: { request: DataRequest; channel: string } }>(`${base(patientId)}/${id}/send`, {
      method: "POST",
      body: JSON.stringify({ connectionId }),
    })
  ).data
}

/**
 * Lo que trae la copia de esta persona, contado de la misma lista que arma el ZIP
 * (`/record/summary`, solo para quien lee la historia). Lo que es 0 no se nombra.
 */
export interface PatientRecordSummary {
  signedOdontograms: number
  prescriptions: number
  orders: number
  medicalLeaves: number
  consentsSigned: number
  images: number
  tomographies: number
  otherFiles: number
  approxBytes: number | null
}

export const recordSummaryKey = (patientId: string) => ["patient-record-summary", patientId] as const

export async function fetchRecordSummary(patientId: string): Promise<PatientRecordSummary> {
  return (await apiFetch<{ data: PatientRecordSummary }>(`/api/patients/${patientId}/record/summary`)).data
}

/** «Descargar copia»: baja el ZIP con la sesión; si el servidor lo rechaza, lanza su error. */
export async function downloadPatientRecord(patientId: string): Promise<void> {
  const response = await fetch(patientRecordDownloadUrl(patientId), { credentials: "include" })
  await saveDownload(response, "Copia de su historia.zip")
}

/** «unos 90 MB», «unos 800 KB»: lo que pesa, redondeado, para decidir si bajarla con wifi. */
export function sizeWords(bytes: number | null): string | null {
  if (!bytes || bytes <= 0) return null
  if (bytes < 1024 * 1024) return `unos ${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `unos ${Math.round(bytes / (1024 * 1024))} MB`
  return `unos ${(bytes / (1024 * 1024 * 1024)).toFixed(1).replace(".", ",")} GB`
}

/** «19 nov»: un instante en el día de la clínica, corto, para la fila de un pedido. */
export function shortDayWords(at: string, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", ...(timeZone ? { timeZone } : {}) })
    .format(new Date(at))
    .replaceAll(".", "")
}

/** Enlace del ZIP con la historia; `?org=` porque un enlace no envía la cabecera de la clínica. */
export function patientRecordDownloadUrl(patientId: string): string {
  const slug = orgSlugFromHostname(requestHostname()) ?? ""
  return `${API_URL}/api/patients/${patientId}/record?org=${encodeURIComponent(slug)}`
}

/** Lo que se borra y lo que hay que saber antes de confirmar (tablero 6). */
export interface ErasurePreview {
  conversations: number
  messages: number
  opportunities: number
  tasks: number
  notes: number
  linkedPeople: number
  futureAppointments: Array<{ id: string; startsAt: string }>
  balances: Array<{ currency: string; cents: number }>
}

export async function fetchErasurePreview(patientId: string, id: string): Promise<ErasurePreview> {
  return (await apiFetch<{ data: ErasurePreview }>(`${base(patientId)}/${id}/erase-preview`)).data
}

export async function eraseDataApi(patientId: string, id: string): Promise<DataRequest> {
  return (await apiFetch<{ data: DataRequest }>(`${base(patientId)}/${id}/erase`, { method: "POST" })).data
}
