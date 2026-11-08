import {
  formatMoney,
  formatMoneyAmount,
  moneyTotalsText,
  type PatientGuide,
} from "@odentia/clinical"
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser"
import { ApiError, apiFetch, saveDownload } from "./api"
import { API_URL } from "./auth-client"
import type { FormSchemaDef } from "./clinical-forms"
import { activeOrgLocale, activeOrgTimeZone } from "./locale"

/**
 * Lo que ve una sesión: lo que deja ver la clínica (ADR 0155), no lo que eligió
 * quien dio el acceso. `documents` es de antes y ya no se lee.
 */
export interface PortalScope {
  appointments: boolean
  budgets: boolean
  account: boolean
  documents: string[]
  /** Ve todos sus documentos terminados. */
  papers?: boolean
}

// ---- Lado paciente (sin sesión staff): Bearer del portal ----

export interface PortalSessionInfo {
  session: {
    id: string
    patientId: string
    contactId: string
    scope: PortalScope
    /** Cuándo termina esta sesión en este teléfono (no el acceso, que no vence). */
    expiresAt: string
    authMethod?: PortalAuthMethod
  }
  patientName: string
  /** Ya guardó su acceso (llave) en algún teléfono. */
  accessSaved?: boolean
  /** Esta sesión ya se recuerda 30 días en este teléfono. */
  remembered?: boolean
  /** Formato y zona de la clínica: el portal dice sus fechas como en la clínica. Ausentes en respuestas antiguas. */
  locale?: string
  timeZone?: string
}
/** Un horario de la semana: el mismo de «Su enlace». */
export interface PortalSlot {
  startsAt: string
  endsAt: string
  professionalUserId: string
  professionalName: string
  roomId: string | null
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
  branchId: string
  branchName: string
  /** La dirección de la sede y «Cómo llegar», como en «Su enlace». Ausentes en respuestas antiguas. */
  branchAddress?: string | null
  branchDirectionsUrl?: string | null
  /** Quién la atiende: el bloque de la cita es el mismo de «Su enlace». */
  professionalName: string
  /** Zona de la sede: la hora de la cita se dice en ella. Ausente en respuestas antiguas. */
  timeZone?: string
  version: number
}

export interface PortalBudgetLine {
  planItemId: string
  /** La opción del presupuesto a la que pertenece la línea. */
  optionId: string
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
  /** Cómo se hace, qué incluye y qué sigue, congelado al entregar; null: sale solo con nombre y precio. */
  patientGuide?: PatientGuide | null
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
  /** Totales del servidor: el portal los muestra, no los recalcula. Con dos monedas, las cifras de abajo son nulas. */
  totals?: PortalCurrencyTotal[]
  totalCents: number | null
  acceptedCents: number | null
  tariffTotalCents: number | null
  discountCents: number | null
  presentedAt: string | null
  decidedAt: string | null
  acceptedByName: string | null
  decisionNote: string | null
  /** El estado con el nombre de siempre, del servidor. */
  stateText: string
  /** AAAA-MM-DD. Vencido no impide aceptar. */
  validUntil?: string | null
  /** «Lo que encontramos»: solo para la propia persona o su representante. */
  findings?: string | null
  proposal?: string | null
  /** Las condiciones de la clínica; vacías, esa parte no sale. */
  terms?: { payment: string | null; change: string | null }
  /** Con más de una, la persona elige una (decisión 13); cada una con su total. */
  options: Array<{
    id: string
    label: string
    name?: string | null
    pros?: string | null
    cons?: string | null
    isRecommended: boolean
    decision: string
    totals?: PortalCurrencyTotal[]
    totalCents: number | null
  }>
  items: PortalBudgetLine[]
}

/** El total de una moneda: entre monedas nunca se suma ni se convierte. */
export interface PortalCurrencyTotal {
  currency: string
  totalCents: number | null
}

export type PortalPaperKind = "receta" | "orden" | "descanso" | "hoja" | "consentimiento" | "comprobante" | "archivo"

/** Un papel de «Tus documentos», dicho con palabras por el servidor. */
export interface PortalPaper {
  kind: PortalPaperKind
  id: string
  /** «Receta», «Radiografía», «Comprobante». */
  type: string
  title: string
  at: string
  /** «Anulada», «Vencida», «Revocado»; nulo si vale. */
  stateWord: string | null
  /** Apareció desde su visita anterior. */
  isNew: boolean
  image: boolean
}

export interface PortalAccount {
  /** Formato regional de la clínica; `null` si aún no lo configuró. */
  locale: string | null
  /** Los mismos montos que Caja: debe, pagado, a favor y saldo (lo que debe menos lo que tiene a favor). */
  byCurrency: Array<{
    currency: string
    agreedCents: number
    porCobrar: number
    pagado: number
    aFavor: number
    saldo: number
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

export async function exchangePortalTokenApi(
  linkToken: string,
  pin: string,
): Promise<PortalExchange> {
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

/** «Añadir al calendario» de una cita: el `.ics` que arma el servidor (issue 46). */
export async function downloadPortalCalendar(
  sessionToken: string,
  appointmentId: string,
): Promise<void> {
  const response = await fetch(
    `${API_URL}/api/public/portal/appointments/${encodeURIComponent(appointmentId)}/calendar`,
    {
      headers: { authorization: `Bearer ${sessionToken}` },
    },
  )
  await saveDownload(response, "cita.ics")
}

export async function cancelPortalAppointmentApi(
  sessionToken: string,
  appointmentId: string,
): Promise<PortalAppointment> {
  const res = await portalFetch<{ data: PortalAppointment }>(
    sessionToken,
    `/appointments/${appointmentId}/cancel`,
    { method: "POST" },
  )
  return res.data
}

export async function reschedulePortalAppointmentApi(
  sessionToken: string,
  appointmentId: string,
  input: { expectedVersion: number; startsAt: string; professionalUserId: string; roomId?: string },
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
  input: {
    optionId?: string | null
    decisions: Array<{ planItemId: string; decision: "aceptado" | "rechazado" | "pospuesto" }>
    decisionNote?: string | null
  },
): Promise<{ budget: PortalBudget; replay: boolean }> {
  const res = await portalFetch<{ data: { budget: PortalBudget; replay: boolean } }>(
    sessionToken,
    `/budgets/${budgetId}/decision`,
    { method: "POST", body: JSON.stringify(input) },
  )
  return res.data
}

/** «Lo vio en el portal el …»: al abrir «Ver y responder». */
export async function markPortalBudgetSeenApi(
  sessionToken: string,
  budgetId: string,
): Promise<void> {
  await portalFetch(sessionToken, `/budgets/${budgetId}/seen`, { method: "POST" })
}

export async function fetchPortalPapers(sessionToken: string): Promise<PortalPaper[]> {
  const res = await portalFetch<{ data: PortalPaper[] }>(sessionToken, "/papers")
  return res.data
}

/** Un archivo o una imagen: una dirección firmada que vale 5 minutos. */
export async function fetchPortalPaperFileUrl(
  sessionToken: string,
  id: string,
): Promise<{ url: string; expiresInSeconds: number }> {
  const res = await portalFetch<{ data: { url: string; expiresInSeconds: number } }>(
    sessionToken,
    `/papers/archivo/${id}/url`,
  )
  return res.data
}

/** El PDF de un papel que emite la clínica, para abrirlo en el teléfono. */
export async function fetchPortalPaperPdf(
  sessionToken: string,
  paper: Pick<PortalPaper, "kind" | "id">,
): Promise<Blob> {
  const response = await fetch(`${API_URL}/api/public/portal/papers/${paper.kind}/${paper.id}/pdf`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  })
  if (!response.ok) {
    let shape: { message?: string; code?: string } = {}
    try {
      shape = ((await response.json()) as { error?: { message?: string; code?: string } }).error ?? {}
    } catch {
      // respuesta no-JSON: shape vacío
    }
    throw new ApiError(response.status, shape)
  }
  return response.blob()
}

/** «… termina el 8 nov 2026, 11:27 p. m.»: una frase que ya acaba en punto no lleva otro. */
export function sentenceEnd(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`
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

/** Si el teléfono no puede guardar la llave: esta sesión se recuerda 30 días. */
export async function rememberPortalSessionApi(
  sessionToken: string,
): Promise<{ expiresAt: string }> {
  const res = await portalFetch<{ data: { expiresAt: string } }>(
    sessionToken,
    "/session/remember",
    { method: "POST" },
  )
  return res.data
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

/** «S/ 300.00 + USD 1,000.00»: el total de un presupuesto o de una opción, por moneda. */
export function portalTotalsText(
  of: { totals?: PortalCurrencyTotal[]; totalCents: number | null },
  budget: Pick<PortalBudget, "currency" | "locale">,
): string {
  const totals = of.totals?.length
    ? of.totals
    : [{ currency: budget.currency, totalCents: of.totalCents }]
  return moneyTotalsText(
    totals,
    (cents, currency) => formatPortalMoney(cents, currency, budget.locale),
    "Por cotizar",
  )
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

// ---- El portal desde la clínica (ADR 0037): configuración y acceso en un paso ----

export type PortalGrantStatus = "activo" | "revocado"
export type PortalAuthMethod = "enlace_pin" | "passkey"

/** Lo único que se configura: encendido y lo que el paciente puede ver. Lo demás son valores fijos. */
export interface PortalPolicy {
  enabled: boolean
  allowedScope: { appointments: boolean; budgets: boolean; account: boolean; documents: boolean }
  updatedAt: string
}

export type PortalPolicyInput = Omit<PortalPolicy, "updatedAt">

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
export function isPortalSessionActive(
  session: Pick<PortalSessionView, "expiresAt" | "revokedAt">,
  now = Date.now(),
): boolean {
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

/** A quién se le puede dar acceso: la persona si es mayor de edad, o su representante legal. */
export interface PortalAccessCandidate {
  contactId: string
  name: string
  relation: "self" | "representante"
  /** «DNI 47120836»: el tipo y el número entero, para compararlo con el que tiene en la mano; nulo sin documento. */
  document: string | null
  /** Escribió por WhatsApp en las últimas 24 horas: el enlace puede ir por ahí. */
  whatsappReady: boolean
}

/** La fila de acceso al portal de la persona. */
export interface PortalAccessRow {
  grantId: string
  contactId: string
  name: string
  relation: "self" | "representante"
  scope: PortalScope
  /** Guardó su acceso (llave) en algún teléfono. */
  saved: boolean
  lastEntryAt: string | null
  /** Pidió volver a entrar y espera un enlace nuevo. */
  reentryRequested: boolean
}

export interface PortalAccessSummary {
  enabled: boolean
  allowedScope: PortalPolicy["allowedScope"]
  access: PortalAccessRow[]
  candidates: PortalAccessCandidate[]
}

/**
 * Lo que verá quien entra, dicho en una línea: lo que deja ver la clínica
 * (ADR 0155). Nunca la historia: las notas de cada atención no van al portal.
 */
export function portalSeesText(allowed: PortalPolicy["allowedScope"]): string {
  const parts = [
    allowed.appointments ? "sus citas" : null,
    allowed.budgets ? "sus presupuestos" : null,
    allowed.account ? "su cuenta" : null,
    allowed.documents ? "sus documentos e imágenes" : null,
  ].filter((part): part is string => part !== null)
  if (parts.length === 0) return "Por ahora la clínica no muestra nada en el portal."
  const list = parts.length === 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`
  return `Verá ${list}. No ve las notas de sus atenciones.`
}

export interface PortalAccessGiven {
  grantId: string
  /** Para mostrar el QR, una sola vez. */
  activationUrlOnce: string | null
  /** El código que se le dice en persona o por teléfono: nunca va con el enlace. */
  /** Nulo si lo envió recepción: el código le llegó a la persona en otro mensaje. */
  pinOnce: string | null
  /** A quién se le envió el enlace por WhatsApp. */
  sentTo: string | null
}

export async function fetchPortalAccessApi(patientId: string): Promise<PortalAccessSummary> {
  const res = await apiFetch<{ data: PortalAccessSummary }>(
    `/api/portal/access?patientId=${encodeURIComponent(patientId)}`,
  )
  return res.data
}

export async function givePortalAccessApi(input: {
  patientId: string
  contactId: string
  identityChecked: boolean
  delivery: "qr" | "whatsapp"
}): Promise<PortalAccessGiven> {
  const res = await apiFetch<{ data: PortalAccessGiven }>("/api/portal/access", {
    method: "POST",
    body: JSON.stringify(input),
  })
  return res.data
}

export async function resendPortalAccessApi(
  grantId: string,
  delivery: "qr" | "whatsapp",
): Promise<PortalAccessGiven> {
  const res = await apiFetch<{ data: PortalAccessGiven }>(`/api/portal/access/${grantId}/resend`, {
    method: "POST",
    body: JSON.stringify({ delivery }),
  })
  return res.data
}

export async function revokePortalAccessApi(grantId: string): Promise<PortalGrant> {
  const res = await apiFetch<{ data: PortalGrant }>(`/api/portal/access/${grantId}/revoke`, {
    method: "POST",
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
  orgName?: string
}

export async function fetchPublicPortalPolicyApi(orgSlug: string): Promise<PublicPortalPolicy> {
  const res = await publicPortalFetch<{ data: PublicPortalPolicy }>(
    `/policy?orgSlug=${encodeURIComponent(orgSlug)}`,
  )
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
  const res = await portalFetch<{ data: PortalPasskeyInfo }>(
    sessionToken,
    "/passkeys/register/verify",
    {
      method: "POST",
      body: JSON.stringify({ orgSlug, ...input }),
    },
  )
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
  const res = await publicPortalFetch<{
    data: { sessionToken: string; session: PortalSessionView }
  }>("/passkeys/auth/verify", { method: "POST", body: JSON.stringify({ orgSlug, ...input }) })
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
