import type { ConsentSections } from "@odentia/clinical"
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
  | "pieza"
  | "escala"
  | "adjunto"

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
  /** Mostrar solo si otro campo anterior tiene ese valor. */
  showIf?: { field: string; equals: string | boolean } | null
  /**
   * Solo en texto: al finalizar, la respuesta pasa a los antecedentes
   * («AllergyIntolerance.code»: alergias declaradas, sin confirmar).
   */
  definition?: "AllergyIntolerance.code" | null
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
  respondent: "staff" | "portal"
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
  status: "borrador" | "finalizado" | "descartado"
  answers: Record<string, unknown>
  finalizedAt: string | null
  /** Título congelado de la plantilla (nulo solo en capturas muy antiguas). */
  templateTitle: string | null
  source: "staff" | "portal"
  submittedAt: string | null
  discardedAt: string | null
  discardReason: string | null
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
  /** Secciones fijas; nulo en plantillas antiguas de solo texto. */
  sections: ConsentSections | null
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
  status: "pendiente" | "firmado" | "revocado" | "anulado"
  signedAt: string | null
  revokedAt: string | null
  revokeReason: string | null
  sectionsSnapshot: ConsentSections | null
  diagnosisCode: string | null
  informedAt: string | null
  informerName: string | null
  informerTitle: string | null
  informerRegistration: string | null
  professionalSignature: { strokes?: number[][][] } | null
  comprehensionConfirmed: boolean
  witnessName: string | null
  witnessDoc: string | null
  cancelledAt: string | null
  cancelReason: string | null
  revokerName: string | null
  revokeSignature: { strokes?: number[][][] } | null
  pdfDocumentId: string | null
  pdfSha256: string | null
  /** Cómo se firmó; nulo en un pendiente y en lo firmado antes (se lee «en la clínica»). */
  signatureMethod: "clinica" | "papel" | "enlace" | null
  signatureLevel: "simple" | null
  /** Foto de la hoja firmada en papel. */
  paperDocumentId: string | null
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

/** `interconsulta` se dice «Derivación». */
export type ClinicalOrderKind = "imagen" | "laboratorio" | "interconsulta"

export interface ClinicalOrder {
  id: string
  organizationId: string
  kind: ClinicalOrderKind
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
  /** CIE-10 de la atención que la motiva. */
  diagnosisCode: string | null
  /** Resultado subido a la propia orden. */
  resultDocumentId: string | null
  /** Derivación a un colega de la clínica. */
  recipientUserId: string | null
  cancelledAt: string | null
  cancelReason: string | null
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

export function fetchFormTemplates(
  query: {
    specialtyId?: string
    status?: string
    q?: string
    /** «me»: primero los de las especialidades de quien atiende. */
    forUser?: string
  } = {},
) {
  return apiFetch<{ data: FormTemplate[] }>(`${BASE}/form-templates${toSearch(query)}`)
}

export function createFormTemplate(body: {
  key?: string
  title: string
  description?: string | null
  specialtyId?: string | null
  respondent?: "staff" | "portal"
  schema: FormSchemaDef
}) {
  return post<FormTemplate>(`${BASE}/form-templates`, body)
}

export function updateFormTemplate(
  id: string,
  body: {
    title?: string
    description?: string | null
    specialtyId?: string | null
    respondent?: "staff" | "portal"
    schema?: FormSchemaDef
  },
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

export function discardFormResponse(id: string, reason: string) {
  return post<FormResponse>(`${BASE}/form-responses/${id}/discard`, { reason })
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
  sections?: ConsentSections
  body?: string
  specialtyId?: string | null
}) {
  return post<ConsentTemplate>(`${BASE}/consent-templates`, body)
}

export function updateConsentTemplate(
  id: string,
  body: { title?: string; sections?: ConsentSections; body?: string; specialtyId?: string | null },
) {
  return patch<ConsentTemplate>(`${BASE}/consent-templates/${id}`, body)
}

export function publishConsentTemplate(id: string) {
  return post<ConsentTemplate>(`${BASE}/consent-templates/${id}/publish`, {})
}

export function archiveConsentTemplate(id: string) {
  return post<ConsentTemplate>(`${BASE}/consent-templates/${id}/archive`, {})
}

export function createSuggestedConsentTemplates() {
  return post<ConsentTemplate[]>(`${BASE}/consent-templates/suggested`, {})
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
  diagnosisCode?: string | null
}) {
  return post<ConsentDocument>(`${BASE}/consents`, body)
}

export function signConsent(
  id: string,
  body: {
    signerKind: "paciente" | "representante"
    /** Persona vinculada que firma; el servidor verifica su facultad y toma su nombre. */
    signerContactId: string
    signerDoc?: string | null
    representativeRelation?: string | null
    /** En la clínica: el trazo de la persona. En papel no va. */
    signatureData?: { strokes: number[][][] }
    comprehensionConfirmed: true
    /** Opcional: el profesional confirma con su perfil, sin dibujar. */
    professionalSignature?: { strokes: number[][][] }
    witness?: { name: string; doc?: string | null } | null
    method?: "clinica" | "papel"
    /** En papel: la foto de la hoja firmada, ya en Documentos. */
    paperDocumentId?: string | null
  },
) {
  return post<ConsentDocument>(`${BASE}/consents/${id}/sign`, body)
}

export function revokeConsent(
  id: string,
  body: { reason: string; revokerContactId: string; signatureData: { strokes: number[][][] } },
) {
  return post<ConsentDocument>(`${BASE}/consents/${id}/revoke`, body)
}

export function cancelConsent(id: string, reason: string) {
  return post<ConsentDocument>(`${BASE}/consents/${id}/cancel`, { reason })
}

export function generateConsentPdf(id: string) {
  return post<ConsentDocument>(`${BASE}/consents/${id}/pdf`, {})
}

export interface ConsentPrint {
  document: ConsentDocument
  diagnosisDescription: string | null
  patient: {
    displayName: string
    patientNumber: number
    docType: string | null
    docNumber: string | null
    birthDate: string | null
    minor: boolean
  }
  establishment: {
    legalName: string | null
    tradeName: string | null
    fiscalDocType: string | null
    fiscalDocNumber: string | null
    address: string | null
  } | null
}

export function fetchConsentPrint(id: string) {
  return apiFetch<{ data: ConsentPrint }>(`${BASE}/consents/${id}/print`)
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
  /** Solo las de esta atención. */
  encounterId?: string
} = {}) {
  return apiFetch<{ data: ClinicalOrder[] }>(`${BASE}/orders${toSearch(query)}`)
}

export function createOrder(body: {
  kind: ClinicalOrderKind
  specialtyId?: string | null
  patientId: string
  encounterId?: string | null
  recipient?: string | null
  recipientUserId?: string | null
  title: string
  detail?: string | null
  diagnosisCode?: string | null
}) {
  return post<ClinicalOrder>(`${BASE}/orders`, body)
}

export function advanceOrder(
  id: string,
  body: {
    toStatus: "en_proceso" | "completado" | "cancelado"
    resultText?: string | null
    /** El resultado subido a la propia orden. */
    resultDocumentId?: string | null
    /** Cancelar pide el motivo. */
    reason?: string | null
  },
) {
  return post<ClinicalOrder>(`${BASE}/orders/${id}/status`, body)
}

export interface OrderPrint {
  order: ClinicalOrder
  diagnosisDescription: string | null
  patient: {
    displayName: string
    patientNumber: number
    docType: string | null
    docNumber: string | null
    birthDate: string | null
  }
  establishment: {
    legalName: string | null
    tradeName: string | null
    fiscalDocType: string | null
    fiscalDocNumber: string | null
    address: string | null
  } | null
  requestedBy: { name: string; title: string | null; registration: string | null } | null
}

export function fetchOrderPrint(id: string) {
  return apiFetch<{ data: OrderPrint }>(`${BASE}/orders/${id}/print`)
}

/** Nombre de cada tipo de orden en pantalla. */
export const ORDER_KIND_LABELS: Record<ClinicalOrderKind, string> = {
  imagen: "Imagen",
  laboratorio: "Laboratorio",
  interconsulta: "Derivación",
}

/** Cómo se titula la orden en su fila: «Orden de imagen · Radiografía panorámica». */
export const ORDER_KIND_TITLES: Record<ClinicalOrderKind, string> = {
  imagen: "Orden de imagen",
  laboratorio: "Orden de laboratorio",
  interconsulta: "Derivación",
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
  pieza: "Pieza dentaria (FDI)",
  escala: "Escala numérica",
  adjunto: "Archivo del paciente",
}

export const FORM_RESPONSE_STATUS_LABELS: Record<FormResponse["status"], string> = {
  borrador: "Borrador",
  finalizado: "Finalizado",
  descartado: "Descartado",
}

export const ORDER_STATUS_LABELS: Record<ClinicalOrder["status"], string> = {
  solicitado: "Pedida",
  en_proceso: "En proceso",
  completado: "Con resultado",
  cancelado: "Cancelada",
}

/** Nivel real de la firma, siempre a la vista. */
export const CONSENT_SIGNATURE_WORDS: Record<"clinica" | "papel" | "enlace", string> = {
  clinica: "Firma simple · en la clínica",
  papel: "Firma simple · en papel",
  enlace: "Firma simple · por enlace",
}

export function consentSignatureWords(document: Pick<ConsentDocument, "status" | "signatureMethod">): string | null {
  if (document.status !== "firmado" && document.status !== "revocado") return null
  return CONSENT_SIGNATURE_WORDS[document.signatureMethod ?? "clinica"]
}

export const CONSENT_STATUS_LABELS: Record<ConsentDocument["status"], string> = {
  pendiente: "Pendiente",
  firmado: "Firmado",
  revocado: "Revocado",
  anulado: "Anulado",
}
