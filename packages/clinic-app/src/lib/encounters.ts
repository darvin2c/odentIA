/**
 * Cliente del ciclo de la atención (ADR 0002 y 0003): cierre guiado por
 * requisitos, anulación con motivo, relevo, diagnósticos CIE-10 como entidad
 * y perfil profesional con el que se firma.
 */
import { apiFetch } from "./api"
import type { ConsentNeed } from "./encounter-documents"
import { activeOrgLocale, activeOrgTimeZone } from "./locale"
import type { Encounter, ProcedureItem } from "./patients"

export type ClosingRequirement = "reason" | "diagnosis" | "evolution" | "signature"

/** Lo que falta saber de su salud: alergias, enfermedades o medicación nunca preguntadas, o la ASA. */
export type HealthGap = "allergies" | "conditions" | "medications" | "asa"

export interface ClosingCheck {
  ready: boolean
  missing: ClosingRequirement[]
  /**
   * Consentimientos que pide la atención y no están firmados. No bloquean:
   * cerrar sin ellos pide decir por qué (`consentSkipReason`).
   */
  consents: ConsentNeed[]
  /**
   * En clínicas de Perú, el odontograma que firmará este cierre (su momento y
   * lo que cambió en la atención); null si no cambió el gráfico o la clínica
   * no firma odontogramas.
   */
  odontogram: ClosingOdontogram | null
  /** El periodontograma de la atención, que queda fijo al firmar; null si no tiene. */
  periodontal: ClosingPeriodontal | null
  /**
   * Lo que se descontará al firmar (los materiales de sus servicios), con la
   * sede de la que sale. Informa, no pide confirmar; null si la atención no
   * tiene sede o no hay nada que descontar (ADR 0067).
   */
  materials: ClosingMaterials | null
  /**
   * Lo que falta saber de su salud (enfermedades o medicación sin preguntar,
   * ASA sin clasificar) y los anestésicos locales de esos materiales: con
   * anestesia y algo por saber, el cierre lo avisa. No bloquea.
   */
  health?: { gaps: HealthGap[]; anesthetics: string[] }
  /** «¿Cuándo vuelve?» y los controles que esta visita cumple al firmar. */
  controls: ClosingControls
  /**
   * Lo trabajado hoy de un tratamiento abierto: `finishing` llega con esta
   * atención a sus sesiones previstas (el cierre pregunta «¿Terminaste?» con
   * «Sí, terminar» elegido y firmar lo termina, ADR 0161); `continuing` queda
   * en curso. `n` cuenta esta.
   * `notRegistered`: lo que traía la cita y hoy no tiene sesión registrada.
   */
  sessions?: {
    finishing: ClosingSession[]
    continuing: ClosingSession[]
    notRegistered?: ClosingSession[]
    /** Lo aceptado sin empezar, a lo que vuelve si nada sigue en curso (la corona tras la endodoncia). */
    accepted?: ClosingSession[]
  }
  /**
   * Los diagnósticos activos que resuelve un tratamiento de hoy si queda
   * realizado: el cierre los propone marcados y manda en `resolveDiagnosisIds` los que siguen marcados.
   */
  resolvable?: ClosingResolvable[]
}

/** Un diagnóstico que un tratamiento de hoy resuelve: «Pulpitis (CIE-11 DA09.0) · pieza 46». */
export interface ClosingResolvable {
  diagnosisIds: string[]
  /** Los tratamientos de hoy que lo resuelven si terminan (basta uno). */
  planItemIds: string[]
  label: string
  site: string | null
}

/** Un tratamiento trabajado en la atención, con su sesión. */
export interface ClosingSession {
  planItemId: string
  title: string
  n: number
  m: number
  /** Dónde, si no se hizo hoy («pieza 46»): lo aceptado sin empezar no está en la atención. */
  place?: string
  /** La cita por venir que ya lleva su próxima sesión; sin cita, no viene. */
  booked?: BookedSession
}

/** Una cita por venir que lleva la próxima sesión de un tratamiento, con la sesión que será. */
export interface BookedSession {
  appointmentId: string
  startsAt: string
  /** Con quién es la cita. */
  professionalUserId: string
  /** Su nombre, cuando lo dio el servidor al reservarla aquí mismo. */
  professionalName?: string
  n: number
  m: number
}

/**
 * Lo trabajado hoy que sigue en curso al firmar, con su próxima sesión: la cita
 * que ya la lleva o la que falta reservar (`toBook`). Lo dice el servidor al firmar.
 */
export interface NextSession {
  planItemId: string
  title: string
  serviceId: string | null
  booked: BookedSession | null
  toBook: { n: number; m: number } | null
}

/** Un control pendiente que ya toca: esta visita lo cumple si queda marcado. */
export interface ClosingDueControl {
  id: string
  title: string
  kind: string
  dueAt: string
  /** Quien firma atendió la atención donde se indicó: viene marcado. */
  mine: boolean
  /** Se eligió al empezar («Viene a su control»): también viene marcado. */
  chosen?: boolean
  repeatEveryMonths: number | null
}

/** El próximo control que ya tiene la persona: en vez de preguntar, se dice cuándo vuelve. */
export interface ClosingNextControl {
  id: string
  title: string
  dueAt: string
  status: string
  scheduledAt: string | null
  /** Se indicó en esta atención. */
  own: boolean
}

export interface ClosingControls {
  /** Los meses de «En N meses» del producto. */
  recallMonths: number
  /** Los controles reservados en la cita de esta atención: se cumplen al firmarla. */
  byAppointment: Array<{ id: string; title: string; repeatEveryMonths: number | null }>
  /** El día de cada atajo («2026-11-14»), en la zona de la clínica. */
  shortcuts: { week: string; month: string; recall: string }
  due: ClosingDueControl[]
  next: ClosingNextControl | null
}

/** Cuánto de un producto, en su unidad de uso («2 guantes»). */
export interface MaterialQuantity {
  productId: string
  name: string
  /** Unidad de uso, en singular. */
  unit: string
  quantity: number
  quantityText: string
}

/** Lo que el cierre anuncia que se descontará. */
export interface ClosingMaterials {
  branch: { id: string; name: string }
  items: MaterialQuantity[]
}

/** Lo que descontó el cierre: lo que no había quedó como faltante. */
export interface FinalizedMaterials {
  branch: { id: string; name: string }
  items: Array<MaterialQuantity & { shortage: number }>
  /** No se pudo descontar: la atención se firmó igual y lo usado se registra con «Corregir». */
  failed: boolean
}

/** Lo que el cierre hizo con los controles: el que indicó «¿Cuándo vuelve?» y los que cumplió. */
export interface FinalizedControls {
  /** `joinsNext`: va en la misma cita que lo aceptado que «Reservar» ofrece, desde `from` (`YYYY-MM-DD`). */
  next: { id: string; title: string; dueAt: string; joinsNext?: { from: string } } | null
  fulfilled: Array<{ id: string; title: string }>
}

/** «6 may 2027», o «3 may» si es de este año: un día civil (`yyyy-MM-dd`), sin corrimiento de zona. */
export function controlDaySaid(day: string, now = new Date()): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  const thisYear = new Intl.DateTimeFormat("en-CA", { timeZone: activeOrgTimeZone(), year: "numeric" }).format(now) === day.slice(0, 4)
  return new Intl.DateTimeFormat(activeOrgLocale() ?? "es", {
    day: "numeric",
    month: "short",
    ...(thisYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  })
    .format(new Date(Date.UTC(year, month - 1, date, 12)))
    .replace(".", "")
}

/**
 * «Vuelve hacia el 7 may 2027 · recepción lo verá para reservarlo.» (la misma
 * forma que el cierre) y lo que quedó cumplido, para «Atención finalizada».
 */
export function finalizedControlsWords(controls: FinalizedControls, now = new Date()): string {
  const words: string[] = []
  if (controls.next) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: activeOrgTimeZone() }).format(new Date(controls.next.dueAt))
    words.push(`Vuelve hacia el ${controlDaySaid(day, now)} · recepción lo verá para reservarlo.`)
  }
  if (controls.fulfilled.length > 0) {
    const titles = controls.fulfilled.map((control) => `«${control.title}»`).join(", ")
    words.push(`${controls.fulfilled.length === 1 ? "Quedó cumplido" : "Quedaron cumplidos"}: ${titles}.`)
  }
  return words.join(" ")
}

/** «Materiales usados» de una atención firmada. */
export interface EncounterMaterials {
  /** La sede de la atención; null sin sede (no salió nada de ningún almacén). */
  branch: { id: string; name: string } | null
  /** Lo usado, neto de lo devuelto, por producto. */
  items: MaterialQuantity[]
  /** Quien atendió, el dueño o la administración, con la atención firmada y con sede. */
  canCorrect: boolean
  /** Puede corregir y la clínica tiene productos que se usan en las atenciones: «Agregar otro producto». */
  canAddProducts: boolean
}

export function fetchEncounterMaterials(patientId: string, encounterId: string) {
  return apiFetch<{ data: EncounterMaterials }>(`${base(patientId)}/encounters/${encounterId}/materials`)
}

/**
 * «Fueron 4, no 2»: deja lo usado de un producto en la cantidad real. La clave
 * es la del formulario abierto: reintentar lo mismo no descuenta dos veces.
 */
export function correctEncounterMaterialApi(
  patientId: string,
  encounterId: string,
  body: { productId: string; quantity: number; idempotencyKey: string },
) {
  return post<EncounterMaterials & { changed: number; replayed: boolean }>(
    `${base(patientId)}/encounters/${encounterId}/materials`,
    body,
  )
}

/** El periodontograma en el cierre: cuántas piezas y, a medias, qué falta (se firma como parcial). */
export interface ClosingPeriodontal {
  teeth: number
  implants: number
  /** «abajo por fuera, de la 43 a la 47»; null si está completo. */
  pending: string | null
}

/** El odontograma firmado que deja el cierre (solo en clínicas de Perú, NTS 188). */
export interface ClosingOdontogram {
  purpose: "initial" | "new_findings" | "completion"
  standard: string
  shortName: string
  findings: Array<{ condition: string; teeth: number[] }>
}

/** Texto de cada requisito pendiente, en el orden de la historia clínica. */
export const CLOSING_REQUIREMENT_LABELS: Record<ClosingRequirement, string> = {
  reason: "Motivo de consulta",
  diagnosis: "Al menos un diagnóstico con su tipo (presuntivo basta)",
  evolution: "Evolución",
  signature: "Tu colegiatura en el perfil profesional",
}

export interface EncounterDiagnosis {
  id: string
  patientId: string
  encounterId: string | null
  /** Lista del código: «ICD-10» o «ICD-11». */
  diagnosisSystem: string
  diagnosisCode: string
  /** El nombre en el catálogo («Caries dental»); null si el código ya no está en la lista. */
  diagnosisTitle?: string | null
  /** HL7 FHIR verificationStatus: provisional («Presuntivo») o confirmed («Definitivo»). */
  diagnosisType: "provisional" | "confirmed" | null
  /** «Ya diagnosticado antes»: lo marca el sistema (decisión 11). */
  previouslyDiagnosed: boolean
  toothNumber: number | null
  surfaces: string[]
  /** Un área en vez de una pieza (odentIA: el cuadrante o la arcada); no viene donde no hay «dónde». */
  quadrant?: number | null
  arch?: string | null
  note: string | null
  status: "activo" | "resuelto"
  resolvedAt: string | null
  legacyNoteId: string | null
  createdBy: string | null
  createdAt: string
  voidedAt: string | null
  voidedBy: string | null
  voidReason: string | null
}

/** Diagnóstico de la lista de problemas del paciente. */
export interface PatientDiagnosis extends EncounterDiagnosis {
  description: string
  encounterStartedAt: string | null
  authorName: string | null
}

export const DIAGNOSIS_STATUS_LABELS: Record<string, string> = {
  activo: "Activo",
  resuelto: "Resuelto",
}

export interface ProfessionalProfile {
  userId: string
  accountName: string
  signatureName: string | null
  /** Vacíos mientras la persona no los escriba: no hay título ni colegio por defecto. */
  professionalTitle: string
  registrationBody: string
  registrationNumber: string | null
  specialtyRegistration: string | null
  complete: boolean
  updatedAt: string | null
  /** Su firma dibujada: el servidor solo se la entrega a la propia persona. */
  signatureStrokes?: number[][][] | null
}

export interface ProfessionalProfileInput {
  signatureName?: string | null
  professionalTitle?: string
  registrationBody?: string
  registrationNumber?: string | null
  specialtyRegistration?: string | null
  /** Solo la propia persona. Sin el dato no cambia; nulo es que la quita. */
  signatureStrokes?: number[][][] | null
}

const base = (patientId: string) => `/api/patients/${patientId}`

function post<T>(url: string, body?: unknown): Promise<{ data: T }> {
  return apiFetch<{ data: T }>(url, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** `addSession`: lo marcado «Falta otra sesión», para que lo anunciado (el odontograma) no lo dé por terminado. */
export function fetchEncounterClosing(patientId: string, encounterId: string, addSession: readonly string[] = []) {
  const query = addSession.length ? `?addSession=${addSession.map(encodeURIComponent).join(",")}` : ""
  return apiFetch<{ data: ClosingCheck }>(`${base(patientId)}/encounters/${encounterId}/closing${query}`)
}

/** Lo que no se deshace al anular la atención (`EncounterVoidBlock` del servicio). */
export type EncounterVoidBlock =
  | { kind: "cobro"; treatments: string[] }
  | { kind: "hecho"; treatments: string[] }
  | { kind: "firma"; signedAt: string; signerName: string | null }
  | { kind: "otros"; others: number }
  | { kind: "ajeno"; others: number }
  | { kind: "revision" }

/** Un presupuesto que anular la atención anula, deja sin lo de ella o frena. */
export interface EncounterVoidBudget {
  id: string
  budgetNumber: number
  status: string
  delivered: boolean
  presentedAt: string | null
  decidedAt: string | null
  effect: "anula" | "quita" | "frena"
  treatments: string[]
  others: number
  blocks: EncounterVoidBlock[]
  appointments: Array<{ id: string; startsAt: string }>
}

export interface EncounterVoidPreview {
  budgets: EncounterVoidBudget[]
  blocked: boolean
  /** Lo entregado que se anula con ella: va tal cual al anular. */
  confirm: Array<{ id: string; status: string }>
}

/** Qué se lleva anular la atención, antes de confirmar (la misma regla del servidor al anular). */
export function fetchEncounterVoidPreview(patientId: string, encounterId: string) {
  return apiFetch<{ data: EncounterVoidPreview }>(`${base(patientId)}/encounters/${encounterId}/void-preview`)
}

export function voidEncounterApi(
  patientId: string,
  encounterId: string,
  reason: string,
  budgets: ReadonlyArray<{ id: string; status: string }> = [],
) {
  return post<Encounter>(`${base(patientId)}/encounters/${encounterId}/void`, { reason, budgets })
}

export function takeOverEncounterApi(patientId: string, encounterId: string) {
  return post<Encounter>(`${base(patientId)}/encounters/${encounterId}/take-over`)
}

export function voidProcedureApi(
  patientId: string,
  encounterId: string,
  procedureId: string,
  reason: string,
) {
  return post<ProcedureItem>(
    `${base(patientId)}/encounters/${encounterId}/procedures/${procedureId}/void`,
    { reason },
  )
}

export function addDiagnosisApi(
  patientId: string,
  encounterId: string,
  body: {
    diagnosisCode: string
    diagnosisSystem?: string | null
    diagnosisType: string
    toothNumber?: number | null
    surfaces?: string[]
    quadrant?: number | null
    arch?: string | null
    note?: string | null
  },
) {
  return post<EncounterDiagnosis>(`${base(patientId)}/encounters/${encounterId}/diagnoses`, body)
}

export function voidDiagnosisApi(
  patientId: string,
  encounterId: string,
  diagnosisId: string,
  reason: string,
) {
  return post<EncounterDiagnosis>(
    `${base(patientId)}/encounters/${encounterId}/diagnoses/${diagnosisId}/void`,
    { reason },
  )
}

export function fetchPatientDiagnoses(patientId: string, status?: "activo" | "resuelto") {
  const query = status ? `?status=${status}` : ""
  return apiFetch<{ data: PatientDiagnosis[] }>(`${base(patientId)}/diagnoses${query}`)
}

export function setDiagnosisStatusApi(
  patientId: string,
  diagnosisId: string,
  status: "activo" | "resuelto",
) {
  return apiFetch<{ data: EncounterDiagnosis }>(`${base(patientId)}/diagnoses/${diagnosisId}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  })
}

export function fetchMyProfessionalProfile() {
  return apiFetch<{ data: ProfessionalProfile }>("/api/clinical-forms/professionals/me/profile")
}

export function fetchProfessionalProfiles() {
  return apiFetch<{ data: ProfessionalProfile[] }>("/api/clinical-forms/professionals/profiles")
}

export function saveProfessionalProfileApi(userId: string | "me", body: ProfessionalProfileInput) {
  return apiFetch<{ data: ProfessionalProfile }>(
    `/api/clinical-forms/professionals/${userId}/profile`,
    { method: "PUT", body: JSON.stringify(body) },
  )
}

export interface SignatureRegistration {
  professionalTitle: string
  registrationBody: string
  registrationNumber: string
}

/**
 * Lo que pide el servidor para firmar (`requireProfessionalSignature`): título,
 * colegio y número. Cada falta va en su campo; vacío: se puede firmar.
 */
export function signatureRegistrationErrors(
  values: SignatureRegistration,
): Partial<Record<keyof SignatureRegistration, string>> {
  const errors: Partial<Record<keyof SignatureRegistration, string>> = {}
  if (!values.professionalTitle.trim()) errors.professionalTitle = "Escribe tu título profesional"
  const body = values.registrationBody.trim()
  if (!body) errors.registrationBody = "Escribe tu colegio profesional"
  else if (body.length > 40) errors.registrationBody = "El colegio profesional admite hasta 40 caracteres"
  const number = values.registrationNumber.trim()
  if (!number) errors.registrationNumber = "Escribe tu número de colegiatura"
  else if (!/^[A-Za-z0-9-]{1,20}$/.test(number))
    errors.registrationNumber = "La colegiatura lleva solo letras, números y guiones (hasta 20)"
  return errors
}

/** Colegio y número («<colegio> <número>») o null si falta la colegiatura. */
export function registrationLabel(
  profile: Pick<ProfessionalProfile, "registrationBody" | "registrationNumber">,
): string | null {
  return profile.registrationNumber
    ? `${profile.registrationBody} ${profile.registrationNumber}`
    : null
}

/** «Hacerla hoy»: trae a la atención un tratamiento aceptado por hacer (motivo y diagnóstico si faltan). */
export function bringTreatmentApi(patientId: string, encounterId: string, planItemId: string) {
  return apiFetch<{ data: { reasonSet: boolean; diagnosisAdded: boolean } }>(
    `${base(patientId)}/encounters/${encounterId}/visit/treatments`,
    { method: "POST", body: JSON.stringify({ planItemId }) },
  )
}

/** Deshace «Hacerla hoy» mientras no tenga su sesión registrada. */
export function leaveTreatmentApi(patientId: string, encounterId: string, planItemId: string) {
  return apiFetch(`${base(patientId)}/encounters/${encounterId}/visit/treatments/${planItemId}`, {
    method: "DELETE",
  })
}

/** «Viene a su control» (o `null`: ninguno): se cumple al firmar. */
export function chooseVisitControlApi(
  patientId: string,
  encounterId: string,
  followUpId: string | null,
) {
  return apiFetch<{ data: { reasonSet: boolean } }>(
    `${base(patientId)}/encounters/${encounterId}/visit/control`,
    {
      method: "PUT",
      body: JSON.stringify({ followUpId }),
    },
  )
}

/** «Quitar» un renglón indicado en esta misma atención, antes de que responda. */
export function removeIndicatedApi(patientId: string, encounterId: string, planItemId: string) {
  return apiFetch(`${base(patientId)}/encounters/${encounterId}/indicated/${planItemId}`, {
    method: "DELETE",
  })
}
