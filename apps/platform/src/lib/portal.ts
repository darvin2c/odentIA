import { API_URL } from "./auth-client"
import { ApiError, apiFetch } from "./api"

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
  version: number
}

export interface PortalBudgetLine {
  planItemId: string
  title: string
  scope: string | null
  toothNumber: number | null
  priceCents: number | null
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
  totalCents: number | null
  acceptedCents: number | null
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

export async function closePortalSessionApi(sessionToken: string): Promise<void> {
  await portalFetch(sessionToken, "/session/revoke", { method: "POST" })
}

/** Centavos enteros → texto es-PE (nunca floats en dinero). */
export function formatPortalMoney(amountCents: number | null, currency: string): string {
  if (amountCents === null) return "Por cotizar"
  try {
    return new Intl.NumberFormat("es-PE", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(amountCents / 100)
  } catch {
    return `${amountCents / 100} ${currency}`
  }
}

export function formatPortalDate(iso: string | null): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return "—"
  return date.toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" })
}
