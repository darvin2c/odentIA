/**
 * Documentos de la atención en un solo lugar (ADR 0033): lo que pide la
 * atención en consentimientos, «Se pide para» de cada plantilla, los papeles
 * de salud que se envían a la persona y la subida de un archivo suelto (la
 * foto de una hoja firmada, el resultado de una orden). Las reglas viven en el
 * servidor; aquí solo se llaman y se dicen.
 */
import { apiFetch } from "./api"
import { API_URL } from "./auth-client"
import { orgSlugFromHostname } from "./host"

export type ConsentNeedStatus = "firmado" | "pendiente" | "sin_preparar" | "sin_publicar"

export interface ConsentNeed {
  templateKey: string
  title: string
  status: ConsentNeedStatus
  templateId: string | null
  documentId: string | null
  procedureRef: string | null
  planItemId: string | null
  diagnosisCode: string | null
  services: string[]
}

const FORMS = "/api/clinical-forms"

function post<T>(url: string, body: unknown): Promise<{ data: T }> {
  return apiFetch<{ data: T }>(url, { method: "POST", body: JSON.stringify(body ?? {}) })
}

export function fetchConsentNeeds(patientId: string, encounterId: string) {
  const search = new URLSearchParams({ patientId, encounterId })
  return apiFetch<{ data: ConsentNeed[] }>(`${FORMS}/consent-needs?${search.toString()}`)
}

/** «Preparar»: genera los que faltan (o solo esas claves), llenos con lo de la atención. */
export function prepareConsents(patientId: string, encounterId: string, templateKeys?: string[]) {
  return post<{ created: Array<{ id: string }>; needs: ConsentNeed[] }>(`${FORMS}/consent-needs/prepare`, {
    patientId,
    encounterId,
    ...(templateKeys ? { templateKeys } : {}),
  })
}

export function fetchConsentTemplateServices() {
  return apiFetch<{ data: Array<{ templateKey: string; serviceIds: string[] }> }>(
    `${FORMS}/consent-template-services`,
  )
}

export function saveConsentTemplateServices(templateId: string, serviceIds: string[]) {
  return apiFetch<{ data: { templateKey: string; serviceIds: string[] } }>(
    `${FORMS}/consent-templates/${templateId}/services`,
    { method: "PUT", body: JSON.stringify({ serviceIds }) },
  )
}

// --- Papeles de salud ------------------------------------------------------------

export type HealthDocumentType = "prescription" | "order" | "consent"

export interface HealthDocumentRecipient {
  contactId: string
  displayName: string
  relation: "paciente" | "representante_legal"
  email: string | null
  phone: string | null
  isDefault: boolean
}

export interface HealthChannelOption {
  channel: string
  connectionId: string
  connectionName: string
  provider: string
  usable: boolean
  reason: string | null
  isProposed: boolean
}

export interface HealthDocumentSendOptions {
  recipients: HealthDocumentRecipient[]
  recipient: HealthDocumentRecipient | null
  channels: HealthChannelOption[]
  proposed: HealthChannelOption | null
  document: { type: HealthDocumentType; label: string }
  message: string
  /** Sin nadie a quien enviarlo o sin canal: solo se imprime, con el porqué. */
  printOnly: string | null
}

export function fetchHealthDocumentOptions(
  patientId: string,
  input: { documentType: HealthDocumentType; documentId: string; recipientContactId?: string },
) {
  const search = new URLSearchParams({ documentType: input.documentType, documentId: input.documentId })
  if (input.recipientContactId) search.set("recipientContactId", input.recipientContactId)
  return apiFetch<{ data: HealthDocumentSendOptions }>(
    `/api/patients/${patientId}/health-document-options?${search.toString()}`,
  )
}

export function sendHealthDocument(
  patientId: string,
  body: {
    documentType: HealthDocumentType
    documentId: string
    recipientContactId?: string | null
    connectionId: string
    message?: string | null
    requestId: string
  },
) {
  return post<{ conversationId: string; status: "queued"; channel: string; recipientName: string }>(
    `/api/patients/${patientId}/health-documents/send`,
    body,
  )
}

export const CHANNEL_WORDS: Record<string, string> = {
  whatsapp: "WhatsApp",
  email: "correo",
}

/** «Enviar a Lucía» o, si es menor, «Enviar a su madre» con el nombre de quien lo recibe. */
export function sendLabel(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0]
  return first ? `Enviar a ${first}` : "Enviar"
}

// --- Subir un archivo suelto ---------------------------------------------------------

export interface UploadedDocument {
  id: string
  label: string
  category: string
}

/**
 * Sube un archivo como documento de la persona (la foto de la hoja firmada en
 * papel, el resultado de una orden) por la misma vía que la galería.
 */
export async function uploadPatientFile(
  patientId: string,
  file: File,
  input: { category: string; label: string; encounterId?: string | null; imageType?: string | null },
): Promise<UploadedDocument> {
  const form = new FormData()
  form.append("file", file)
  form.append("category", input.category)
  form.append("label", input.label.slice(0, 200))
  if (input.imageType) form.append("imageType", input.imageType)
  if (input.encounterId) form.append("encounterId", input.encounterId)
  form.append("toothNumbers", "[]")
  form.append("tags", "[]")
  const slug = typeof window === "undefined" ? null : orgSlugFromHostname(window.location.hostname)
  const response = await fetch(`${API_URL}/api/patients/${patientId}/documents`, {
    method: "POST",
    credentials: "include",
    headers: slug ? { "x-odentia-org": slug } : {},
    body: form,
  })
  if (!response.ok) {
    let message = `No se pudo subir el archivo (error ${response.status})`
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      if (body.error?.message) message = body.error.message
    } catch {
      // Cuerpo que no es JSON: queda el mensaje general.
    }
    throw new Error(message)
  }
  const body = (await response.json()) as { data: UploadedDocument }
  return body.data
}
