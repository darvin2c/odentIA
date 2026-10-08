import { apiFetch } from "./api"

/** Especialidad creada por la organización (sin catálogo fijo). */
export interface Specialty {
  id: string
  organizationId: string
  key: string
  name: string
  description: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type FormFieldType =
  | "texto"
  | "texto_largo"
  | "numero"
  | "booleano"
  | "opcion_unica"
  | "opcion_multiple"
  | "fecha"
  | "firma"

export interface FormFieldDef {
  id: string
  label: string
  type: FormFieldType
  required?: boolean
  options?: string[]
  unit?: string | null
  min?: number | null
  max?: number | null
  help?: string | null
}

export interface FormSectionDef {
  id: string
  title: string
  fields: FormFieldDef[]
}

export interface FormSchemaDef {
  sections: FormSectionDef[]
}

export interface FormTemplate {
  id: string
  organizationId: string
  specialtyId: string | null
  key: string
  title: string
  description: string | null
  version: number
  status: "borrador" | "publicado" | "archivado"
  schema: FormSchemaDef
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface FormResponse {
  id: string
  organizationId: string
  templateId: string
  templateVersion: number
  templateSnapshot: FormSchemaDef
  patientId: string
  encounterId: string | null
  professionalUserId: string | null
  status: "borrador" | "finalizado"
  answers: Record<string, unknown>
  finalizedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface FormAddendum {
  id: string
  responseId: string
  text: string
  createdBy: string | null
  createdAt: string
}

export interface ConsentTemplate {
  id: string
  organizationId: string
  specialtyId: string | null
  key: string
  title: string
  body: string
  version: number
  status: "borrador" | "publicado" | "archivado"
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ConsentDocument {
  id: string
  organizationId: string
  templateId: string
  templateVersion: number
  bodySnapshot: string
  titleSnapshot: string
  patientId: string
  encounterId: string | null
  planItemId: string | null
  procedureRef: string | null
  signerKind: "paciente" | "representante"
  signerContactId?: string | null
  signerName: string
  signerDoc: string | null
  representativeRelation: string | null
  signatureData: { strokes?: number[][][]; image?: string } | null
  status: "pendiente" | "firmado" | "revocado"
  signedAt: string | null
  revokedAt: string | null
  revokeReason: string | null
  createdAt: string
  updatedAt: string
}

export interface ConsentEvent {
  id: string
  documentId: string
  fromStatus: string | null
  toStatus: string
  actorUserId: string | null
  reason: string | null
  createdAt: string
}

export interface ClinicalOrder {
  id: string
  organizationId: string
  kind: "laboratorio" | "interconsulta"
  specialtyId: string | null
  patientId: string
  encounterId: string | null
  fromUserId: string | null
  recipient: string
  title: string
  detail: string | null
  status: "solicitado" | "en_proceso" | "completado" | "cancelado"
  resultText: string | null
  resultAt: string | null
  createdAt: string
  updatedAt: string
}

const BASE = "/api/clinical-forms"

function toSearch(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  const text = search.toString()
  return text ? `?${text}` : ""
}

async function post<T>(path: string, body: unknown): Promise<{ data: T }> {
  return apiFetch<{ data: T }>(path, { method: "POST", body: JSON.stringify(body ?? {}) })
}

async function patch<T>(path: string, body: unknown): Promise<{ data: T }> {
  return apiFetch<{ data: T }>(path, { method: "PATCH", body: JSON.stringify(body) })
}

async function put<T>(path: string, body: unknown): Promise<{ data: T }> {
  return apiFetch<{ data: T }>(path, { method: "PUT", body: JSON.stringify(body) })
}

// --- Especialidades ---

export function fetchSpecialties(query: { q?: string; activeOnly?: boolean } = {}) {
  return apiFetch<{ data: Specialty[] }>(
    `${BASE}/specialties${toSearch({ q: query.q, activeOnly: query.activeOnly ? "true" : undefined })}`,
  )
}

export function createSpecialty(body: { key?: string; name: string; description?: string | null }) {
  return post<Specialty>(`${BASE}/specialties`, body)
}

export function updateSpecialty(
  id: string,
  body: { name?: string; description?: string | null; isActive?: boolean },
) {
  return patch<Specialty>(`${BASE}/specialties/${id}`, body)
}

export function archiveSpecialty(id: string) {
  return post<Specialty>(`${BASE}/specialties/${id}/archive`, {})
}

export function fetchSpecialtyProfessionals(specialtyId: string) {
  return apiFetch<{ data: Array<{ userId: string }> }>(
    `${BASE}/specialties/${specialtyId}/professionals`,
  )
}

export function fetchProfessionalSpecialties(userId: string) {
  return apiFetch<{ data: Specialty[] }>(`${BASE}/professionals/${userId}/specialties`)
}

export function saveProfessionalSpecialties(userId: string, specialtyIds: string[]) {
  return put<{ userId: string; specialtyIds: string[] }>(
    `${BASE}/professionals/${userId}/specialties`,
    { specialtyIds },
  )
}

export function fetchServiceSpecialties(serviceId: string) {
  return apiFetch<{ data: Specialty[] }>(`${BASE}/services/${serviceId}/specialties`)
}

export function saveServiceSpecialties(serviceId: string, specialtyIds: string[]) {
  return put<{ serviceId: string; specialtyIds: string[] }>(
    `${BASE}/services/${serviceId}/specialties`,
    { specialtyIds },
  )
}

// --- Plantillas de formulario ---

export function fetchFormTemplates(query: { specialtyId?: string; status?: string; q?: string } = {}) {
  return apiFetch<{ data: FormTemplate[] }>(`${BASE}/form-templates${toSearch(query)}`)
}

export function createFormTemplate(body: {
  key?: string
  title: string
  description?: string | null
  specialtyId?: string | null
  schema: FormSchemaDef
}) {
  return post<FormTemplate>(`${BASE}/form-templates`, body)
}

export function updateFormTemplate(
  id: string,
  body: { title?: string; description?: string | null; specialtyId?: string | null; schema?: FormSchemaDef },
) {
  return patch<FormTemplate>(`${BASE}/form-templates/${id}`, body)
}

export function publishFormTemplate(id: string) {
  return post<FormTemplate>(`${BASE}/form-templates/${id}/publish`, {})
}

export function archiveFormTemplate(id: string) {
  return post<FormTemplate>(`${BASE}/form-templates/${id}/archive`, {})
}

// --- Capturas ---

export function fetchFormResponses(query: { patientId: string; encounterId?: string; templateId?: string }) {
  return apiFetch<{ data: FormResponse[] }>(`${BASE}/form-responses${toSearch(query)}`)
}

export function createFormResponse(body: {
  templateId: string
  patientId: string
  encounterId?: string | null
  professionalUserId?: string | null
  answers?: Record<string, unknown>
}) {
  return post<FormResponse>(`${BASE}/form-responses`, body)
}

export function updateFormResponse(
  id: string,
  body: { answers: Record<string, unknown>; professionalUserId?: string | null },
) {
  return patch<FormResponse>(`${BASE}/form-responses/${id}`, body)
}

export function finalizeFormResponse(id: string) {
  return post<FormResponse>(`${BASE}/form-responses/${id}/finalize`, {})
}

export function fetchFormAddenda(responseId: string) {
  return apiFetch<{ data: FormAddendum[] }>(`${BASE}/form-responses/${responseId}/addenda`)
}

export function addFormAddendum(responseId: string, text: string) {
  return post<FormAddendum>(`${BASE}/form-responses/${responseId}/addenda`, { text })
}

// --- Consentimientos ---

export function fetchConsentTemplates(query: { specialtyId?: string; status?: string; q?: string } = {}) {
  return apiFetch<{ data: ConsentTemplate[] }>(`${BASE}/consent-templates${toSearch(query)}`)
}

export function createConsentTemplate(body: {
  key?: string
  title: string
  body: string
  specialtyId?: string | null
}) {
  return post<ConsentTemplate>(`${BASE}/consent-templates`, body)
}

export function updateConsentTemplate(
  id: string,
  body: { title?: string; body?: string; specialtyId?: string | null },
) {
  return patch<ConsentTemplate>(`${BASE}/consent-templates/${id}`, body)
}

export function publishConsentTemplate(id: string) {
  return post<ConsentTemplate>(`${BASE}/consent-templates/${id}/publish`, {})
}

export function fetchConsents(query: { patientId: string; status?: string }) {
  return apiFetch<{ data: ConsentDocument[] }>(`${BASE}/consents${toSearch(query)}`)
}

export function createConsent(body: {
  templateId: string
  patientId: string
  encounterId?: string | null
  planItemId?: string | null
  procedureRef?: string | null
}) {
  return post<ConsentDocument>(`${BASE}/consents`, body)
}

export function signConsent(
  id: string,
  body: {
    signerKind: "paciente" | "representante"
    /** Persona vinculada que firma; el servidor verifica su facultad y toma su nombre. */
    signerContactId?: string | null
    signerName: string
    signerDoc?: string | null
    representativeRelation?: string | null
    signatureData: { strokes: number[][][] } | { image: string }
  },
) {
  return post<ConsentDocument>(`${BASE}/consents/${id}/sign`, body)
}

export function revokeConsent(id: string, reason: string) {
  return post<ConsentDocument>(`${BASE}/consents/${id}/revoke`, { reason })
}

export function fetchConsentHistory(id: string) {
  return apiFetch<{ data: ConsentEvent[] }>(`${BASE}/consents/${id}/history`)
}

// --- Órdenes ---

export function fetchOrders(query: {
  patientId?: string
  status?: string
  kind?: string
  specialtyId?: string
} = {}) {
  return apiFetch<{ data: ClinicalOrder[] }>(`${BASE}/orders${toSearch(query)}`)
}

export function createOrder(body: {
  kind: "laboratorio" | "interconsulta"
  specialtyId?: string | null
  patientId: string
  encounterId?: string | null
  recipient: string
  title: string
  detail?: string | null
}) {
  return post<ClinicalOrder>(`${BASE}/orders`, body)
}

export function advanceOrder(
  id: string,
  body: { toStatus: "en_proceso" | "completado" | "cancelado"; resultText?: string | null },
) {
  return post<ClinicalOrder>(`${BASE}/orders/${id}/status`, body)
}

export const FIELD_TYPE_LABELS: Record<FormFieldType, string> = {
  texto: "Texto corto",
  texto_largo: "Texto largo",
  numero: "Número",
  booleano: "Sí / No",
  opcion_unica: "Opción única",
  opcion_multiple: "Opción múltiple",
  fecha: "Fecha",
  firma: "Firma manuscrita",
}

export const ORDER_STATUS_LABELS: Record<ClinicalOrder["status"], string> = {
  solicitado: "Solicitado",
  en_proceso: "En proceso",
  completado: "Completado",
  cancelado: "Cancelado",
}

export const CONSENT_STATUS_LABELS: Record<ConsentDocument["status"], string> = {
  pendiente: "Pendiente",
  firmado: "Firmado",
  revocado: "Revocado",
}
