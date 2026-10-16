import { formatMoney, formatMoneyAmount } from "@odentia/clinical"
import type { FormSchemaDef } from "./clinical-forms"
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser"
import { API_URL } from "./auth-client"
import { ApiError, apiFetch } from "./api"
import { activeOrgLocale, activeOrgTimeZone } from "./locale"

/** Alcance autorizado congelado en enlace/sesión (UX en español, claves estables). */
export interface PortalScope {
  appointments: boolean
  budgets: boolean
  account: boolean
  documents: string[]
}

export interface PortalLinkView {
  id: string
  patientId: string
  patientName: string
  contactId: string
  contactName: string
  scope: PortalScope
  status: string
  expiresAt: string
  usedAt: string | null
  revokedAt: string | null
  deliveryConversationId: string | null
  deliveryMessageId: string | null
  createdAt: string
}

export interface IssuedPortalLink {
  link: PortalLinkView
  delivery: { conversationId: string; messageId: string }
  replay: boolean
  pinOnce: string | null
}

export interface IssuePortalLinkDraft {
  patientId: string
  contactId: string
  conversationId: string
  scope: {
    appointments?: boolean
    budgets?: boolean
    account?: boolean
    documentIds?: string[]
  }
  ttlHours?: number
  idempotencyKey?: string
}

export async function issuePortalLinkApi(draft: IssuePortalLinkDraft): Promise<IssuedPortalLink> {
  const res = await apiFetch<{ data: IssuedPortalLink }>("/api/portal/links", {
    method: "POST",
    body: JSON.stringify(draft),
  })
  return res.data
}

export async function listPortalLinksApi(patientId?: string): Promise<PortalLinkView[]> {
  const params = patientId ? `?patientId=${encodeURIComponent(patientId)}` : ""
  const res = await apiFetch<{ data: PortalLinkView[] }>(`/api/portal/links${params}`)
  return res.data
}

export async function revokePortalLinkApi(id: string): Promise<PortalLinkView> {
  const res = await apiFetch<{ data: PortalLinkView }>(`/api/portal/links/${id}/revoke`, {
    method: "PATCH",
  })
  return res.data
}

export async function revokePortalSessionApi(id: string): Promise<{ revoked: boolean }> {
  const res = await apiFetch<{ data: { revoked: boolean } }>(`/api/portal/sessions/${id}/revoke`, {
    method: "PATCH",
  })
  return res.data
}

// ---- Lado paciente (sin sesión staff): Bearer del portal ----

export interface PortalSessionInfo {
  session: {
    id: string
    patientId: string
    contactId: string
    scope: PortalScope
    expiresAt: string
  }
  patientName: string
  /** Formato y zona de la clínica: el portal dice sus fechas como en la clínica. Ausentes en respuestas antiguas. */
  locale?: string
  timeZone?: string
}
export interface PortalSlot {
  startsAt: string
  endsAt: string
  dentistUserId: string
  dentistName: string
  chairId: string | null
  chairName: string | null
  timeZone: string
}

export interface PortalSlotsResult {
  slots: PortalSlot[]
  truncated: boolean
  timeZone: string
}

export interface PortalAppointment {
  id: string
  startsAt: string
  endsAt: string
  serviceName: string | null
  status: string
  branchName: string
  /** Zona de la sede: la hora de la cita se dice en ella. Ausente en respuestas antiguas. */
  timeZone?: string
  version: number
}

export interface PortalBudgetLine {
  planItemId: string
  title: string
  scope: string | null
  toothNumber: number | null
  /** Precio acordado: el total o, si se cobra por sesión, el de cada visita. */
  priceCents: number | null
  tariffCents: number | null
  /** 'treatment' se cobra una vez; 'session', en cada visita atendida. */
  billingMode: string
  /** Visitas previstas de lo que se cobra por sesión. */
  sessionsPlanned: number | null
  /** Total de la línea: el precio o, por sesión, precio por visita × visitas previstas. */
  lineTotalCents: number | null
  /** El mismo total a la tarifa de referencia. */
  tariffLineTotalCents: number | null
  promotionName: string | null
  currency: string
  decision: string
  itemStatus: string
}

export interface PortalBudget {
  id: string
  planId: string
  budgetNumber: number
  revisionNumber: number
  title: string
  notes: string | null
  status: string
  currency: string
  /** Formato regional de la clínica; `null` si aún no lo configuró. */
  locale: string | null
  /** Totales del servidor: el portal los muestra, no los recalcula. */
  totalCents: number | null
  acceptedCents: number | null
  tariffTotalCents: number | null
  discountCents: number | null
  presentedAt: string | null
  decidedAt: string | null
  acceptedByName: string | null
  decisionNote: string | null
  items: PortalBudgetLine[]
}

export interface PortalDocument {
  id: string
  category: string
  label: string
  contentType: string
  sizeBytes: number
  createdAt: string
}

export interface PortalAccount {
  /** Formato regional de la clínica; `null` si aún no lo configuró. */
  locale: string | null
  byCurrency: Array<{
    currency: string
    agreedCents: number
    chargedCents: number
    paidCents: number
    appliedCents: number
    refundedCents: number
    outstandingCents: number
    availableCreditCents: number
  }>
  charges: Array<{
    id: string
    description: string
    amountCents: number
    currency: string
    dueAt: string | null
    voidedAt: string | null
    createdAt: string
  }>
  payments: Array<{
    id: string
    amountCents: number
    currency: string
    method: string
    reference: string | null
    paidAt: string
    voidedAt: string | null
  }>
}

async function portalFetch<T>(sessionToken: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}/api/public/portal${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${sessionToken}`,
      ...init?.headers,
    },
  })
  if (!response.ok) {
    let shape: { message?: string; code?: string } = {}
    try {
      const body = (await response.json()) as { error?: { message?: string; code?: string } }
      shape = body.error ?? {}
    } catch {
      // respuesta no-JSON: shape vacío
    }
    throw new ApiError(response.status, shape)
  }
  return (await response.json()) as T
}

export function portalErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return "Este acceso no está disponible."
    return error.shape.message ?? "No pudimos completar la solicitud."
  }
  return "No pudimos completar la solicitud."
}

export interface PortalExchange {
  sessionToken: string
  session: PortalSessionInfo["session"]
  patientName: string
  contactName: string
}

export async function exchangePortalTokenApi(linkToken: string, pin: string): Promise<PortalExchange> {
  const res = await portalFetch<{ data: PortalExchange }>("", "/exchange", {
    method: "POST",
    body: JSON.stringify({ token: linkToken, pin }),
  })
  return res.data
}

export async function fetchPortalSession(sessionToken: string): Promise<PortalSessionInfo> {
  const res = await portalFetch<{ data: PortalSessionInfo }>(sessionToken, "/session")
  return res.data
}

export async function fetchPortalAppointments(sessionToken: string): Promise<PortalAppointment[]> {
  const res = await portalFetch<{ data: PortalAppointment[] }>(sessionToken, "/appointments")
  return res.data
}

export async function confirmPortalAppointmentApi(
  sessionToken: string,
  appointmentId: string,
): Promise<PortalAppointment> {
  const res = await portalFetch<{ data: PortalAppointment }>(
    sessionToken,
    `/appointments/${appointmentId}/confirm`,
    { method: "POST" },
  )
  return res.data
}

export async function reschedulePortalAppointmentApi(
  sessionToken: string,
  appointmentId: string,
  input: { expectedVersion: number; startsAt: string },
): Promise<PortalAppointment> {
  const res = await portalFetch<{ data: PortalAppointment }>(
    sessionToken,
    `/appointments/${appointmentId}/reschedule`,
    { method: "POST", body: JSON.stringify(input) },
  )
  return res.data
}

export async function fetchPortalRescheduleSlots(
  sessionToken: string,
  appointmentId: string,
  range: { from: string; to: string },
): Promise<PortalSlotsResult> {
  const params = new URLSearchParams({ from: range.from, to: range.to })
  const res = await portalFetch<{ data: PortalSlotsResult }>(
    sessionToken,
    `/appointments/${appointmentId}/slots?${params.toString()}`,
  )
  return res.data
}

export async function fetchPortalBudgets(sessionToken: string): Promise<PortalBudget[]> {
  const res = await portalFetch<{ data: PortalBudget[] }>(sessionToken, "/budgets")
  return res.data
}
export async function decidePortalBudgetApi(
  sessionToken: string,
  budgetId: string,
  input: { decisions: Array<{ planItemId: string; decision: "aceptado" | "rechazado" | "pospuesto" }>; decisionNote?: string | null },
): Promise<{ budget: PortalBudget; replay: boolean }> {
  const res = await portalFetch<{ data: { budget: PortalBudget; replay: boolean } }>(
    sessionToken,
    `/budgets/${budgetId}/decision`,
    { method: "POST", body: JSON.stringify(input) },
  )
  return res.data
}

export async function fetchPortalDocuments(sessionToken: string): Promise<PortalDocument[]> {
  const res = await portalFetch<{ data: PortalDocument[] }>(sessionToken, "/documents")
  return res.data
}

export async function fetchPortalDocumentUrl(
  sessionToken: string,
  documentId: string,
): Promise<{ url: string; expiresInSeconds: number }> {
  const res = await portalFetch<{ data: { url: string; expiresInSeconds: number } }>(
    sessionToken,
    `/documents/${documentId}/url`,
  )
  return res.data
}

export async function fetchPortalAccount(sessionToken: string): Promise<PortalAccount> {
  const res = await portalFetch<{ data: PortalAccount }>(sessionToken, "/account")
  return res.data
}

export interface PortalQuestionnaire {
  template: { id: string; title: string; version: number; schema: FormSchemaDef } | null
  response: {
    id: string
    answers: Record<string, unknown>
    submittedAt: string | null
    status: string
  } | null
  respondent: { name: string; relationship: string }
}

export async function fetchPortalQuestionnaire(sessionToken: string): Promise<PortalQuestionnaire> {
  const res = await portalFetch<{ data: PortalQuestionnaire }>(sessionToken, "/questionnaire")
  return res.data
}

export async function savePortalQuestionnaireApi(
  sessionToken: string,
  input: { answers: Record<string, unknown>; submit?: boolean },
): Promise<PortalQuestionnaire> {
  const res = await portalFetch<{ data: PortalQuestionnaire }>(sessionToken, "/questionnaire", {
    method: "PUT",
    body: JSON.stringify(input),
  })
  return res.data
}

export async function closePortalSessionApi(sessionToken: string): Promise<void> {
  await portalFetch(sessionToken, "/session/revoke", { method: "POST" })
}

/** Formato del dispositivo: respaldo cuando el portal no entrega el de la clínica. */
function deviceLocale(): string {
  return new Intl.NumberFormat().resolvedOptions().locale
}

/**
 * Importe entero en la unidad menor de su moneda → texto con la moneda y el
 * formato de la clínica (`locale` que entrega el portal con cada presupuesto).
 * Los decimales los pone la moneda (ISO 4217), no una división fija; sin
 * formato de la clínica se usa el del dispositivo, nunca el de un país.
 */
export function formatPortalMoney(
  amountCents: number | null,
  currency: string,
  locale?: string | null,
  /** Sin símbolo: cifras de una lista cuyo total ya dice la moneda. */
  plain = false,
): string {
  if (amountCents === null) return "Por cotizar"
  for (const candidate of [locale?.trim(), deviceLocale()]) {
    if (!candidate) continue
    try {
      return plain
        ? formatMoneyAmount(amountCents, currency, candidate)
        : formatMoney(amountCents, currency, candidate)
    } catch {
      // Formato que este dispositivo no reconoce: se prueba el siguiente.
    }
  }
  return "Importe no disponible"
}

/**
 * Fecha y hora en el formato y la zona de la clínica (la de la sede, si se da),
 * nunca en los del navegador: «vence el 20 oct, 10:00» es la hora de la clínica
 * aunque el equipo o la persona estén en otra zona. Sin clínica conocida, los
 * del dispositivo.
 */
export function formatPortalDate(
  iso: string | null,
  where: { locale?: string | null; timeZone?: string | null } = {},
): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return "—"
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: where.timeZone?.trim() || activeOrgTimeZone(),
  }
  try {
    return date.toLocaleString(where.locale?.trim() || activeOrgLocale(), options)
  } catch {
    // Formato o zona que este dispositivo no reconoce.
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
  }
}

// ---- Gobernanza del portal (contrato PortalDomain 2026-09-29) ----
// Fechas como ISO en JSON. Sin datos clínicos en ningún mensaje de canal.

export type PortalChannel = "web_publica" | "conversacion"
export type PortalRequestStatus = "pendiente" | "aprobada" | "rechazada" | "expirada"
export type PortalGrantStatus = "activo" | "revocado"
export type PortalAuthMethod = "enlace_pin" | "passkey"
export type PortalRelationship = "self" | "guardian" | "family" | "other"

export interface PortalPolicy {
  enabled: boolean
  requestsEnabled: boolean
  publicRequestsEnabled: boolean
  channelRequestsEnabled: boolean
  autoApproveVerified: boolean
  allowedConnectionIds: string[]
  linkTtlMinutes: number
  sessionTtlHours: number
  grantTtlDays: number | null
  allowedScope: { appointments: boolean; budgets: boolean; account: boolean; documents: boolean }
  passkeysEnabled: boolean
  assistedRecoveryEnabled: boolean
  updatedAt: string
}

export type PortalPolicyInput = Omit<PortalPolicy, "updatedAt">

export interface PortalAccessRequest {
  id: string
  patientName: string | null
  contactName: string
  contactText: string | null
  channel: PortalChannel
  status: PortalRequestStatus
  conversationId: string | null
  createdAt: string
  expiresAt: string
  decidedAt: string | null
}

export interface PortalGrant {
  id: string
  patientId: string
  patientName: string
  contactId: string
  contactName: string
  scope: PortalScope
  status: PortalGrantStatus
  verifiedMethod: string
  verifiedAt: string
  expiresAt: string | null
  createdAt: string
  revokedAt: string | null
}

export interface PortalSessionView {
  id: string
  patientId: string
  contactId: string
  scope: PortalScope
  expiresAt: string
  /** Cerrada antes de vencer; ausente en respuestas antiguas en caché. */
  revokedAt?: string | null
  grantId: string | null
  authMethod: PortalAuthMethod
}

/** Una sesión sirve mientras no venza ni se haya cerrado. */
export function isPortalSessionActive(session: Pick<PortalSessionView, "expiresAt" | "revokedAt">, now = Date.now()): boolean {
  return !session.revokedAt && new Date(session.expiresAt).getTime() > now
}

export interface PortalPasskeyInfo {
  id: string
  nickname: string | null
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export async function fetchPortalPolicyApi(): Promise<PortalPolicy> {
  const res = await apiFetch<{ data: PortalPolicy }>("/api/portal/policy")
  return res.data
}

export async function savePortalPolicyApi(input: PortalPolicyInput): Promise<PortalPolicy> {
  const res = await apiFetch<{ data: PortalPolicy }>("/api/portal/policy", {
    method: "PUT",
    body: JSON.stringify(input),
  })
  return res.data
}

export interface CreatePortalGrantDraft {
  patientId: string
  contactId: string
  relationship?: PortalRelationship
  scope: IssuePortalLinkDraft["scope"]
  verifiedMethod: string
  evidenceNote?: string
}

export async function listPortalGrantsApi(patientId?: string): Promise<PortalGrant[]> {
  const params = patientId ? `?patientId=${encodeURIComponent(patientId)}` : ""
  const res = await apiFetch<{ data: PortalGrant[] }>(`/api/portal/grants${params}`)
  return res.data
}

export async function createPortalGrantApi(draft: CreatePortalGrantDraft): Promise<PortalGrant> {
  const res = await apiFetch<{ data: PortalGrant }>("/api/portal/grants", {
    method: "POST",
    body: JSON.stringify(draft),
  })
  return res.data
}

export async function revokePortalGrantApi(id: string, reason?: string): Promise<PortalGrant> {
  const res = await apiFetch<{ data: PortalGrant }>(`/api/portal/grants/${id}/revoke`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
  return res.data
}

export async function listPortalSessionsApi(opts?: {
  patientId?: string
  contactId?: string
  grantId?: string
}): Promise<PortalSessionView[]> {
  const params = new URLSearchParams()
  if (opts?.patientId) params.set("patientId", opts.patientId)
  if (opts?.contactId) params.set("contactId", opts.contactId)
  if (opts?.grantId) params.set("grantId", opts.grantId)
  const suffix = params.size > 0 ? `?${params}` : ""
  const res = await apiFetch<{ data: PortalSessionView[] }>(`/api/portal/sessions${suffix}`)
  return res.data
}

export async function listPortalRequestsApi(status?: PortalRequestStatus): Promise<PortalAccessRequest[]> {
  const params = status ? `?status=${encodeURIComponent(status)}` : ""
  const res = await apiFetch<{ data: PortalAccessRequest[] }>(`/api/portal/requests${params}`)
  return res.data
}

export interface ApprovePortalRequestDraft {
  patientId: string
  contactId: string
  relationship?: PortalRelationship
  scope: IssuePortalLinkDraft["scope"]
  verifiedMethod: string
  evidenceNote?: string
  conversationId: string
}

export interface ApprovedPortalRequest {
  grant: PortalGrant
  link: IssuedPortalLink
}

export async function approvePortalRequestApi(
  id: string,
  draft: ApprovePortalRequestDraft,
): Promise<ApprovedPortalRequest> {
  const res = await apiFetch<{ data: ApprovedPortalRequest }>(
    `/api/portal/requests/${id}/approve`,
    { method: "POST", body: JSON.stringify(draft) },
  )
  return res.data
}

export async function rejectPortalRequestApi(id: string, note?: string): Promise<PortalAccessRequest> {
  const res = await apiFetch<{ data: PortalAccessRequest }>(`/api/portal/requests/${id}/reject`, {
    method: "POST",
    body: JSON.stringify({ note }),
  })
  return res.data
}

// ---- Lado público sin sesión (orgSlug explícito, sin oráculo de existencia) ----

async function publicPortalFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}/api/public/portal${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  })
  if (!response.ok) {
    let shape: { message?: string; code?: string } = {}
    try {
      const body = (await response.json()) as { error?: { message?: string; code?: string } }
      shape = body.error ?? {}
    } catch {
      // respuesta no-JSON: shape vacío
    }
    throw new ApiError(response.status, shape)
  }
  return (await response.json()) as T
}

export interface PublicPortalPolicy {
  enabled: boolean
  requestsEnabled: boolean
  passkeysEnabled: boolean
  orgName: string
}

export async function fetchPublicPortalPolicyApi(orgSlug: string): Promise<PublicPortalPolicy> {
  const res = await publicPortalFetch<{ data: PublicPortalPolicy }>(
    `/policy?orgSlug=${encodeURIComponent(orgSlug)}`,
  )
  return res.data
}

export interface PublicPortalRequestDraft {
  orgSlug: string
  contactName: string
  contactText: string
  patientHint?: string
  idempotencyKey?: string
}

export async function createPublicPortalRequestApi(
  draft: PublicPortalRequestDraft,
): Promise<{ received: boolean }> {
  const res = await publicPortalFetch<{ data: { received: boolean } }>("/requests", {
    method: "POST",
    body: JSON.stringify(draft),
  })
  return res.data
}

// ---- Passkeys (navegador con @simplewebauthn/browser; rp/origen los valida el servidor) ----

export interface PortalRegistrationChallenge {
  challengeId: string
  options: PublicKeyCredentialCreationOptionsJSON
}

export interface PortalAuthChallenge {
  challengeId: string
  options: PublicKeyCredentialRequestOptionsJSON
}

export type PortalRegistrationResponse = RegistrationResponseJSON
export type PortalAuthResponse = AuthenticationResponseJSON

export async function requestPasskeyRegistrationOptionsApi(
  sessionToken: string,
  orgSlug: string,
): Promise<PortalRegistrationChallenge> {
  const res = await portalFetch<{ data: PortalRegistrationChallenge }>(
    sessionToken,
    "/passkeys/register/options",
    { method: "POST", body: JSON.stringify({ orgSlug }) },
  )
  return res.data
}

export async function verifyPasskeyRegistrationApi(
  sessionToken: string,
  orgSlug: string,
  input: { challengeId: string; response: RegistrationResponseJSON },
): Promise<PortalPasskeyInfo> {
  const res = await portalFetch<{ data: PortalPasskeyInfo }>(sessionToken, "/passkeys/register/verify", {
    method: "POST",
    body: JSON.stringify({ orgSlug, ...input }),
  })
  return res.data
}

export async function requestPasskeyAuthOptionsApi(orgSlug: string): Promise<PortalAuthChallenge> {
  const res = await publicPortalFetch<{ data: PortalAuthChallenge }>("/passkeys/auth/options", {
    method: "POST",
    body: JSON.stringify({ orgSlug }),
  })
  return res.data
}

export async function verifyPasskeyAuthApi(
  orgSlug: string,
  input: { challengeId: string; response: AuthenticationResponseJSON },
): Promise<{ sessionToken: string; session: PortalSessionView }> {
  const res = await publicPortalFetch<{ data: { sessionToken: string; session: PortalSessionView } }>(
    "/passkeys/auth/verify",
    { method: "POST", body: JSON.stringify({ orgSlug, ...input }) },
  )
  return res.data
}

export async function listMyPortalGrantsApi(sessionToken: string): Promise<PortalGrant[]> {
  const res = await portalFetch<{ data: PortalGrant[] }>(sessionToken, "/grants")
  return res.data
}

export async function selectPortalGrantApi(
  sessionToken: string,
  grantId: string,
): Promise<{ sessionToken: string; session: PortalSessionView }> {
  const res = await portalFetch<{ data: { sessionToken: string; session: PortalSessionView } }>(
    sessionToken,
    "/grants/select",
    { method: "POST", body: JSON.stringify({ grantId }) },
  )
  return res.data
}

export async function listPortalPasskeysApi(contactId: string): Promise<PortalPasskeyInfo[]> {
  const res = await apiFetch<{ data: PortalPasskeyInfo[] }>(
    `/api/portal/passkeys?contactId=${encodeURIComponent(contactId)}`,
  )
  return res.data
}

export async function revokePortalPasskeyApi(id: string): Promise<{ revoked: boolean }> {
  const res = await apiFetch<{ data: { revoked: boolean } }>(`/api/portal/passkeys/${id}/revoke`, {
    method: "POST",
  })
  return res.data
}

export interface PortalActivationQrInput {
  patientId: string
  contactId: string
  scope: IssuePortalLinkDraft["scope"]
  ttlHours?: number
  idempotencyKey?: string
}

export interface PortalActivationQr {
  link: PortalLinkView
  activationUrlOnce: string
  pinOnce: string | null
}

export async function issuePortalActivationQrApi(
  input: PortalActivationQrInput,
): Promise<PortalActivationQr> {
  const res = await apiFetch<{ data: PortalActivationQr }>("/api/portal/activations/qr", {
    method: "POST",
    body: JSON.stringify(input),
  })
  return res.data
}
