import {
  appendDictated,
  formatMoney,
  formatVitals,
  moneyTotalsText,
  parseVitals,
  VITAL_SIGNS,
  type Vitals,
  vitalsErrors,
} from "@odentia/clinical"
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Textarea,
} from "@odentia/ui"
import {
  addDays,
  clearSubmitErrors,
  DetailDrawer,
  DetailPanel,
  MasterDetail,
  PageHeader,
  setSubmitErrors,
  submitErrorMessage,
  submitErrorOf,
  submitForm,
  useAppForm,
  useDetailMode,
  useFormSubmitError,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useId, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { fetchBudgetDetail, PLAN_QUERY_KEYS, totalsOf } from "../../lib/budgets"
import { type ConsentDocument, confirmLinkSignedConsent, fetchConsents } from "../../lib/clinical-forms"
import {
  clinicDateTimeValue,
  fetchFollowUps,
  instantFromClinicValue,
} from "../../lib/clinical-journey"
import { useMemberName, useMyUserId, useOrgMembers, usePermission } from "../../lib/crm"
import { type ConsentNeed, prepareConsents } from "../../lib/encounter-documents"
import {
  CLOSING_REQUIREMENT_LABELS,
  type ClosingRequirement,
  type ClosingResolvable,
  type ClosingSession,
  type FinalizedControls,
  type FinalizedMaterials,
  type NextSession,
  fetchEncounterClosing,
  controlDaySaid,
  finalizedControlsWords,
  fetchMyProfessionalProfile,
  saveProfessionalProfileApi,
  takeOverEncounterApi,
} from "../../lib/encounters"
import { fetchPatientAccount3 } from "../../lib/finance-collect"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { useOrgProfile } from "../../lib/org"
import { usePageDraftGuard } from "../../lib/page-draft-guard"
import { untilWritten } from "../../lib/write-barrier"
import {
  ageFrom,
  type Encounter,
  type EncounterDetail,
  hcLabel,
  type PatientFull,
} from "../../lib/patients"
import type { HealthGap } from "../../lib/encounters"
import { groupFindings } from "../../lib/site-findings"
import { productUi } from "../../product/product-ui"
import { AttendingForNotice } from "../agenda/attending-for-notice"
import { BookingHere } from "../agenda/schedule-host"
import { useNoticesColumnDockBlocker } from "../notices-column"
import { ProfessionalProfileDrawer } from "../professional-profile-drawer"
import { ChoiceSelect } from "../ui/choice-select"
import { ConsentSigningScreen, useSignAs } from "./consent-signing"
import {
  DictationHeaderButton,
  DictationMobileBar,
  DictationPanel,
  DictationTranscript,
  dictationMobileBarVisible,
} from "./dictation-panel"
import {
  type DictationKind,
  type DictationSuggestion,
  useDictationSession,
} from "./dictation-session"
import { DictationSignDialog } from "./dictation-sign-dialog"
import { DictationBlockSuggestions, DictationEditDrawer } from "./dictation-suggestions"
import { EncounterBreadcrumb } from "./encounter-breadcrumb"
import {
  CLOSING_FIELD_MAP,
  ClosingNextVisit,
  ClosingSessions,
  ClosingSignatureHint,
  FinalizedNextSessions,
  type ClosingValues,
  closingControlsBody,
  continuingAfterSign,
  type DictatedControl,
  EncounterClosingDialog,
  healthGapWords,
  type SessionAnswers,
  needsNextControlDay,
  resolvingOnSign,
  SignatureRegistrationFields,
  useClosingForm,
} from "./encounter-closing"
import { DeclaredQuestionnaireNotice, EncounterContextBody, EncounterHealthReview } from "./encounter-context"
import { LinkSignedNotice } from "./link-signed-notice"
import { useOpenWide } from "./wide-section"
import type { ProposedDiagnosis } from "./diagnosis-picker"
import { EncounterDiagnoses } from "./encounter-diagnoses"
import { EncounterDocumentsBlock, useEncounterDocuments } from "./encounter-documents"
import { EncounterMaterialsCorrection, FinalizedMaterialsNote } from "./encounter-materials"
import { EncounterPlanPanel } from "./encounter-plan-panel"
import { EncounterProcedures } from "./encounter-procedures"
import { EncounterTreatments } from "./encounter-treatments"
import { EncounterVisitStrip } from "./encounter-visit"
import { CollectButton } from "./collect-flow"
import { EncounterVoidDialog } from "./encounter-void-dialog"
import { PatientClinicalStrip } from "./patient-header"
import { BudgetSendButton } from "./plan/budget-send"

export interface EncounterEditorProps {
  patientId: string
  detail: EncounterDetail
  patient: PatientFull
  /** Refresca el query del encounter (lo implementa la ruta). */
  onChanged: () => Promise<void>
  /**
   * Se firmó aquí: «Atención finalizada» se abre en este editor, así que la ruta
   * lo mantiene montado hasta cerrarlo (`onFinalized`), aunque la atención ya
   * se relea firmada.
   */
  onSigned?: () => void
  /** Invalida resumen/plan/timeline y navega (cuenta si hubo cargos, historia si no). */
  onFinalized: (hasCharges: boolean) => Promise<void>
}
type DraftKey =
  | NoteKey
  | "vitals"
  | "reason"
  | "evolution"
  | "indications"
  | "teeth"
  | "examination"

/** Solo guardado automático: «Guardado HH:MM», «Guardando…» o «Sin conexión». */
type SaveState = "saved" | "pending" | "saving" | "error" | "offline"

/** Campos de texto de la nota normativa que se guardan tal cual (vacío = null). */
type NoteKey = "presentIllness" | "illnessDuration" | "prognosis"

/**
 * Bloques que la atención puede llegar a tener. No son pasos: la consulta nace
 * solo con `consulta` y cada bloque se agrega cuando ocurre. Los que ya tienen
 * contenido registrado se siguen mostrando al recargar; los agregados vacíos se
 * descartan sin tocar datos.
 */
type CommonSectionKey =
  | "consulta"
  | "hallazgos"
  | "examen"
  | "procedimientos"
  | "plan"
  | "documentos"
  | "evolucion"
/** Un bloque común o uno del producto (odentIA: «odontograma» y «periodontograma»), que van después del examen. */
type SectionKey = CommonSectionKey | (string & {})

/**
 * Bloque donde vive cada clase de sugerencia del dictado, y cómo se resume el
 * bloque cuando solo tiene sugerencias: sugerido no es registrado.
 */
const SECTION_DICTATION: Partial<Record<CommonSectionKey, { kinds: DictationKind[]; onlySuggested?: string }>> = {
  consulta: { kinds: ["nota"] },
  // Lo dictado en un bloque del producto lo declara el bloque (odentIA: lo de una pieza, issue 109).
  hallazgos: { kinds: ["diagnostico"], onlySuggested: "Sin diagnósticos confirmados" },
  // Lo que se dijo hecho hoy (issue 109): sale del plan, de los servicios o como acto libre.
  // Con lo hecho, el material que se dijo usar (ADR 0106): sale de la sede al firmar.
  procedimientos: { kinds: ["procedimiento", "material"], onlySuggested: "Sin procedimientos registrados" },
  // Los signos vitales y el examen por sistemas que dicta latidIA (issue 229).
  examen: { kinds: ["signos", "examen"], onlySuggested: "Sin examen registrado" },
  // «Plan y controles» es un solo bloque (ADR 0034): ahí se revisan indicaciones y controles.
  plan: { kinds: ["plan", "control", "cita", "presupuesto"], onlySuggested: "Sin indicaciones confirmadas" },
  // La receta dictada se emite desde su bloque, con «Emitir receta» (issue 109, fase 2); el descanso, con «Emitir descanso».
  documentos: { kinds: ["receta", "descanso"], onlySuggested: "Sin documentos" },
}

/** Lo que falta para cerrar, dicho corto en el pie. */
const CLOSING_SHORT: Record<keyof typeof CLOSING_REQUIREMENT_LABELS, string> = {
  reason: "motivo",
  diagnosis: "diagnóstico",
  evolution: "evolución",
  signature: "tu colegiatura",
}

/** «a, b y c». */
function listWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} y ${items.at(-1)}`
}

/** Lo que pide el cierre, en el orden de la historia clínica. */
const CLOSING_ORDER: readonly ClosingRequirement[] = ["reason", "diagnosis", "evolution", "signature"]

/** Lo que se escribe a mano en el borrador: el autoguardado los envía por clave. */
type DraftTextKey = NoteKey | "reason" | "evolution" | "indications"
const DRAFT_TEXT_KEYS: readonly DraftTextKey[] = [
  "presentIllness",
  "illnessDuration",
  "prognosis",
  "reason",
  "evolution",
  "indications",
]

/** El formulario del borrador: lo que se ve y se marca; el autoguardado lee `valuesRef`. */
interface DraftFormValues extends Record<DraftTextKey, string> {
  /** Signos vitales tal como se escriben; cada uno se marca si no pasa. */
  vitals: Record<string, string>
}

interface DraftValues extends DraftFormValues {
  teeth: number[]
  /** El borrador del examen, con la forma del producto (`ProductExaminationUi`). */
  examination: unknown
}

interface DraftPatch extends Partial<Record<NoteKey, string | null>> {
  vitals?: Record<string, string> | null
  reason?: string | null
  evolution?: string | null
  indications?: string | null
  teeth?: number[]
  examination?: Record<string, unknown> | null
  /** Lo último guardado que conoce el editor de cada texto que envía: otra pestaña no se pisa. */
  base?: Partial<Record<TextKey, string | null>>
}

/** Los textos que se cuidan de otra pestaña: el servidor avisa si cambiaron (`STALE_DRAFT`). */
const TEXT_KEYS = ["reason", "evolution", "indications", "presentIllness", "illnessDuration", "prognosis"] as const
type TextKey = (typeof TEXT_KEYS)[number]
const isTextKey = (key: string): key is TextKey => (TEXT_KEYS as readonly string[]).includes(key)

const AUTOSAVE_MS = 800
const MAX_REASON = 2000
const MAX_EVOLUTION = 10000
const MAX_INDICATIONS = 4000

/** Sin red: el navegador lo dice o la petición ni siquiera llegó. */
function isOffline(err: unknown): boolean {
  return (typeof navigator !== "undefined" && navigator.onLine === false) || err instanceof TypeError
}

function sortTeeth(teeth: number[]): number[] {
  return [...teeth].sort((a, b) => a - b)
}
/** Signos vitales guardados como texto editable. */
function vitalsDraft(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {}
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => typeof value === "number")
      .map(([key, value]) => [key, String(value)]),
  )
}

/** Primer nombre de la persona, como lo dice la pantalla: «falta 1 firma de Lucía». */
function firstNameOf(patient: PatientFull): string {
  return (patient.patient.givenNames ?? patient.patient.displayName).trim().split(/\s+/)[0] ?? ""
}

/** Los errores de los signos vitales con el nombre de su campo (`vitals.peso`). */
function vitalsFieldErrors(vitals: Record<string, string>, allowed: Parameters<typeof vitalsErrors>[1]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(vitalsErrors(vitals, allowed)).map(([key, message]) => [`vitals.${key}`, `${message}. No se guarda hasta corregirlo.`]),
  )
}

/**
 * Borrador de la atención (solo borradores; la rama finalizada la posee la ruta).
 * Autosave con debounce + drenado serializado por campos dirty: nunca envía el
 * objeto completo para no pisar vínculos clínicos (piezas implícitas de
 * procedimientos, diagnósticos, imágenes u odontograma).
 * La atención se construye: nace con el motivo y cada bloque (servicios
 * realizados, odontograma, diagnósticos, plan, recetas, controles, documentos,
 * evolución) se agrega solo cuando ocurre. `MasterDetail` mantiene el resumen
 * de lo registrado a la vista y el bloque abierto se edita al costado; por
 * debajo del corte de panel, ese mismo bloque se monta como drawer. Los campos
 * escalares usan `FormPanel`/`FormDrawer`; los bloques que alojan registros con
 * formulario propio usan el detalle de lectura, para no anidar formularios.
 * Finalizar y volver viven en la revisión de cierre, no en un footer suelto.
 */
/** «1 diagnóstico», «2 diagnósticos»: sin «(s)». */
function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** Desde cuándo está abierta, dicho para que se note si es de otro día. */
function openSinceWords(iso: string): string {
  const timeZone = activeOrgTimeZone()
  const clock = formatClock(iso)
  const day = zonedDateOf(iso, timeZone)
  const today = zonedDateOf(new Date().toISOString(), timeZone)
  if (day === today) return `en curso desde las ${clock}`
  if (day === addDays(today, -1)) return `en curso desde ayer, ${clock}`
  const date = new Date(iso).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short", timeZone })
  return `en curso desde el ${date.replace(".", "")}, ${clock}`
}

function formatClock(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(activeOrgLocale(), {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: activeOrgTimeZone(),
      })
}

/** Resumen económico del cierre: qué quedó por cobrar y qué no. */
/** El presupuesto que quedó armado al firmar, con lo indicado en esta atención. */
interface FinalizedBudget {
  id: string
  budgetNumber: number
  itemCount: number
  /** Un total por moneda; con dos, `totalCents` es nulo. */
  totals?: Array<{ currency: string; totalCents: number | null }>
  totalCents: number | null
  currency: string
  added: number
}

/**
 * «Presupuesto listo: …» del cierre. Con caminos (varias opciones), cada uno
 * con su total y unidos con «o»: las opciones nunca se suman. El cierre no
 * trae las opciones; se leen del presupuesto. Mientras tanto no se dice un
 * total, para no mostrar una suma de caminos.
 */
function FinalizedBudgetSummary({
  patientId,
  budget,
  locale,
}: {
  patientId: string
  budget: FinalizedBudget
  locale: string | undefined
}): React.JSX.Element {
  const detailQuery = useQuery({
    queryKey: ["budget", patientId, budget.id],
    queryFn: () => fetchBudgetDetail(patientId, budget.id),
  })
  const detail = detailQuery.data?.data
  const money = (cents: number, currency: string) => (locale ? formatMoney(cents, currency, locale) : "…")
  const options = detail?.options ?? []
  if (detail && options.length > 1) {
    const count = options.length === 2 ? "dos" : options.length === 3 ? "tres" : String(options.length)
    const words = [...options]
      .sort((a, b) => a.position - b.position)
      .map(
        (option) =>
          `${option.name?.trim() || option.label} ${moneyTotalsText(totalsOf(option, detail.currency), money, "con un precio por definir")}`,
      )
    return (
      <p className="text-sm">
        Presupuesto listo con {count} opciones: {words.join(" o ")}. Nunca se suman.
      </p>
    )
  }
  const treatments = budget.itemCount === 1 ? "1 tratamiento" : `${budget.itemCount} tratamientos`
  return (
    <p className="text-sm">
      Presupuesto listo: {treatments}
      {detail && locale && (budget.totalCents != null || budget.totals?.length)
        ? ` por ${moneyTotalsText(
            budget.totals?.length ? budget.totals : [{ currency: budget.currency, totalCents: budget.totalCents }],
            money,
            "un precio por definir",
          )}`
        : ""}
    </p>
  )
}

/** Lo aceptado que va después de lo que sigue en curso y ya tiene su cita. */
interface FinalizedBookedAfter {
  planItemId: string
  title: string
  beforeTitle: string
  startsAt: string
  professionalName: string | null
}

export interface FinalizeBilling {
  /** El total de su única moneda; con dos, nulo: lo dice `totals`. */
  chargedCents: number | null
  currency: string | null
  totals?: Array<{ currency: string; totalCents: number }>
  lines: Array<{
    procedureId: string
    description: string
    amountCents: number | null
    currency: string | null
    status: "charged" | "skipped"
    reason: string | null
  }>
}

function skippedReasonLabel(reason: string | null): string {
  switch (reason) {
    case "covered":
      // «Cobrado» se leía como pagado mientras aún debía (repaso del 9 nov, N4): se carga una vez.
      return "el tratamiento se carga una sola vez y ya se cargó en una sesión anterior"
    case "free_act":
      return "se registró sin servicio de la lista"
    case "zero_price":
      return "su servicio no tiene precio"
    case "sessions_complete":
      return "ya se cobraron todas las visitas previstas"
    default:
      return "no genera cobro"
  }
}

/**
 * Los diagnósticos que el cierre mostró marcados para resolver (los de lo que termina,
 * sin lo desmarcado): solo esos se resuelven al firmar.
 */
function resolveDiagnosesBody(
  resolvable: ClosingResolvable[] | undefined,
  sessions: { finishing: ClosingSession[]; continuing: ClosingSession[] } | undefined,
  answers: SessionAnswers,
  keep: ReadonlySet<string>,
): { resolveDiagnosisIds?: string[] } {
  const ids = resolvingOnSign(resolvable ?? [], sessions, answers)
    .filter((found) => !found.diagnosisIds.some((id) => keep.has(id)))
    .flatMap((found) => found.diagnosisIds)
  return ids.length ? { resolveDiagnosisIds: ids } : {}
}

/**
 * Lo respondido a «¿Terminaste?» en el cuerpo de `/finalize`: solo «Falta otra
 * sesión», de lo que el cierre pregunta hoy (lo que ya no está, porque se anuló
 * su sesión, no se manda). Lo demás que llega a sus previstas lo termina el
 * servidor al firmar: «Sí, terminar» es lo que viene elegido (ADR 0161).
 */
function sessionAnswerBody(
  answers: SessionAnswers,
  sessions: { finishing: Array<{ planItemId: string }> } | undefined,
): { addSessionPlanItemIds?: string[] } {
  const asked = new Set((sessions?.finishing ?? []).map((session) => session.planItemId))
  const addSession = Object.entries(answers).flatMap(([id, chosen]) => (chosen === "otra" && asked.has(id) ? [id] : []))
  return addSession.length ? { addSessionPlanItemIds: addSession } : {}
}

export function EncounterEditor({
  patientId,
  detail,
  patient,
  onChanged,
  onSigned,
  onFinalized,
}: EncounterEditorProps): React.JSX.Element {
  const encounter = detail.encounter
  const encounterId = encounter.id
  const queryClient = useQueryClient()
  const canWrite = usePermission("clinical.write")
  const canRead = usePermission("clinical.read")
  const canReadFinance = usePermission("finance.read")
  const memberName = useMemberName()
  const members = useOrgMembers()
  const orgProfile = useOrgProfile().data
  const orgLocale = orgProfile?.locale
  const uid = useId()
  const accountQuery = useQuery({
    queryKey: ["patient-account", patientId],
    queryFn: () => fetchPatientAccount3(patientId),
    enabled: canReadFinance,
  })
  /** Lo que debe en total, por moneda, para «Atención finalizada» (solo quien ve la caja). */
  const finalizedOwed = (accountQuery.data?.data.byCurrency ?? []).filter((row) => row.saldo > 0)

  // El examen y los signos vitales son los del producto (issue 229).
  const exam = productUi().encounter.examination
  // Lo escrito en el borrador: el formulario lo muestra y marca cada campo; el
  // autoguardado envía lo de `valuesRef`, que se actualiza a la vez.
  const draftForm = useAppForm({
    defaultValues: {
      presentIllness: encounter.presentIllness ?? "",
      illnessDuration: encounter.illnessDuration ?? "",
      prognosis: encounter.prognosis ?? "",
      reason: encounter.reason ?? "",
      evolution: encounter.evolution ?? "",
      indications: encounter.indications ?? "",
      vitals: vitalsDraft(encounter.vitals),
    } as DraftFormValues,
    validators: {
      onChange: ({ value }) => {
        const fields = vitalsFieldErrors(value.vitals, exam.vitals)
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
      // «Enviar» el borrador es comprobar lo que exige el cierre, cada falta en su campo.
      onSubmit: ({ value }) => {
        const fields = vitalsFieldErrors(value.vitals, exam.vitals)
        if (!value.reason.trim()) fields.reason = "Escribe el motivo: es obligatorio para cerrar"
        if (!value.evolution.trim()) fields.evolution = "Escribe la evolución: es obligatoria para cerrar"
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: () => flush(),
  })
  const draftValues = useStore(draftForm.store, (state) => state.values)
  const { reason, evolution, indications, vitals } = draftValues
  const parsed = parseVitals(vitals, exam.vitals)
  const parsedVitals: Vitals | null = parsed.ok ? parsed.value : null
  // Lo que el servidor rechazó del examen, por la ruta de cada dato («extraoral.atm»).
  const [examErrors, setExamErrors] = useState<Record<string, string>>({})
  const [teeth, setTeeth] = useState<number[]>(() => sortTeeth(detail.teeth))
  const [examination, setExamination] = useState<unknown>(() => exam.draft(encounter.examination))
  // Una sola página (QA de la atención del 8 nov; ADR 0165): todo lo de todos los días se
  // edita en su sitio. Lo opcional que no tiene nada («También»: examen, pronóstico,
  // periodontograma) se abre ahí mismo y, con algo escrito, queda abierto.
  const [extras, setExtras] = useState<ReadonlySet<string>>(() => new Set())
  const openExtra = (key: string) =>
    setExtras((current) => (current.has(key) ? current : new Set(current).add(key)))
  /** «Registrar» el diagnóstico desde lo que falta: el formulario se abre (se vuelve a montar con la clave). */
  const [diagnosisAsk, setDiagnosisAsk] = useState(0)
  /** «Escribir en vez de dictar», también desde «¿Qué puedo decir?» de la cabecera. */
  const [dictationTyping, setDictationTyping] = useState(false)

  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [saveError, setSaveError] = useState<string | null>(null)
  // Sin conexión o con el guardado fallido, lo escrito vive solo en esta pantalla:
  // salir por la miga, recargar o cerrar pregunta antes (QA del 6 nov: se perdía
  // la evolución sin aviso). Mientras guarda normalmente no pregunta nada.
  const unsavedGuard = usePageDraftGuard(saveState === "offline" || saveState === "error")
  const [childCount, setChildCount] = useState(0)
  const [finalizing, setFinalizing] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [finalizedBilling, setFinalizedBilling] = useState<FinalizeBilling | null>(null)
  // El presupuesto que quedó armado al firmar (decisión 12): el cierre pregunta si enviarlo ya.
  const [finalizedBudget, setFinalizedBudget] = useState<FinalizedBudget | null>(null)
  // Lo que descontó el cierre (ADR 0067): «Atención finalizada» lo dice, con lo que no había.
  const [finalizedMaterials, setFinalizedMaterials] = useState<FinalizedMaterials | null>(null)
  // Lo que el cierre hizo con sus controles: «Atención finalizada» dice qué verá recepción.
  const [finalizedControls, setFinalizedControls] = useState<FinalizedControls | null>(null)
  /** Lo que la firma iba a terminar y no pudo: sigue en curso, con su motivo. */
  const [finalizedKeptOpen, setFinalizedKeptOpen] = useState<
    Array<{ planItemId: string; title: string; reason: string }>
  >([])
  /** Lo que va después de lo que sigue en curso y ya tiene su cita (la corona reservada): se avisa. */
  const [finalizedBookedAfter, setFinalizedBookedAfter] = useState<FinalizedBookedAfter[]>([])
  /** Lo que sigue en curso tras firmar, con su próxima sesión: «Reservar la sesión 2» ahí mismo. */
  const [finalizedNext, setFinalizedNext] = useState<NextSession[]>([])
  /** Los tratamientos con que se abrió «Nueva cita» desde «Atención finalizada». */
  const [bookingNext, setBookingNext] = useState<string[] | null>(null)
  /** Lo reservado ahí mismo: recibe el foco para que el lector y el teclado lo sepan. */
  const nextSessionsRef = useRef<HTMLUListElement>(null)
  /** «Después» del presupuesto con una sesión por reservar: solo pliega el presupuesto. */
  const [budgetLater, setBudgetLater] = useState(false)
  // «Corregir» desde «Atención finalizada»: el formulario se abre encima del aviso, que queda abierto debajo.
  const [correctingMaterials, setCorrectingMaterials] = useState(false)
  const [materialsCorrected, setMaterialsCorrected] = useState(false)
  const [budgetSent, setBudgetSent] = useState(false)
  // El aviso de firma se elige al abrirlo: firmar descarta las sugerencias y no debe cambiar de diálogo a mitad.
  const [confirmWithDictation, setConfirmWithDictation] = useState(false)
  // «Lo dictado», el respaldo del odontólogo: columna lateral si cabe, cajón si no.
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [voidOpen, setVoidOpen] = useState(false)
  const [takingOver, setTakingOver] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [profileForSignature, setProfileForSignature] = useState(false)
  // Hora del último guardado, para «Guardado HH:MM».
  const [savedAt, setSavedAt] = useState<string>(encounter.updatedAt)
  // Antecedentes y última atención, al lado y sin salir.
  const [contextOpen, setContextOpen] = useState(false)
  /** Una propuesta de diagnóstico sin tipo, usada desde la tarjeta: el bloque abre su formulario con ella. */
  const [diagnosisPrefill, setDiagnosisPrefill] = useState<ProposedDiagnosis | null>(null)
  /** «Registrar la sesión» desde «Realizado hoy» o «Hoy viene a…»: el tratamiento con que se abre el registro. */
  const [sessionPrefill, setSessionPrefill] = useState<string | null>(null)
  /** «¿Terminaste?» del cierre: lo que se cambió de cada tratamiento de hoy (sin cambiar, se termina). */
  const [sessionAnswers, setSessionAnswers] = useState<SessionAnswers>({})
  /** Los diagnósticos que el cierre proponía resolver y quien firma desmarcó. */
  const [keepDiagnoses, setKeepDiagnoses] = useState<ReadonlySet<string>>(() => new Set())
  const keepDiagnosis = (diagnosisIds: string[], keep: boolean) =>
    setKeepDiagnoses((current) => {
      const next = new Set(current)
      for (const id of diagnosisIds) {
        if (keep) next.add(id)
        else next.delete(id)
      }
      return next
    })
  // Sede de la atención: se guarda al elegirla; si no, el error va en su campo.
  const [branchError, setBranchError] = useState<string | null>(null)
  const registrationNumberRef = useRef<HTMLInputElement>(null)
  // Consentimientos que se firman en la unidad dental desde el cierre.
  const [signingDocs, setSigningDocs] = useState<ConsentDocument[] | null>(null)
  const myUserId = useMyUserId()
  // El borrador ocupa la página: el agente se abre como cajón, sin desmontarlo.
  useNoticesColumnDockBlocker(true)
  const signAs = useSignAs()
  // Quien lleva la atención es quien la edita y la firma; otro profesional la
  // lee y, para continuarla, toma el relevo.
  const attending = encounter.professionalUserId === myUserId
  // «Falta otra sesión» cambia lo que el cierre anuncia (el odontograma que se firma): se vuelve a pedir.
  const keepOpen = Object.entries(sessionAnswers)
    .flatMap(([id, answer]) => (answer === "otra" ? [id] : []))
    .sort()
  const closingQuery = useQuery({
    queryKey: ["encounter-closing", patientId, encounterId, keepOpen],
    queryFn: () => fetchEncounterClosing(patientId, encounterId, keepOpen),
    enabled: canWrite,
    placeholderData: keepPreviousData,
  })
  const profileQuery = useQuery({
    queryKey: ["professional-profile", "me"],
    queryFn: fetchMyProfessionalProfile,
    enabled: canWrite,
  })
  // Lo que falta saber de su salud, como lo dice el servidor (la misma regla que guarda la firma;
  // odentIA también cuenta la ASA). Guardar Antecedentes o responder el aviso refresca el cierre.
  const healthGaps: HealthGap[] = closingQuery.data?.data.health?.gaps ?? []
  const openWide = useOpenWide()
  const needsRegistration = closingQuery.isSuccess && closingQuery.data.data.missing.includes("signature")
  const unsignedConsents: ConsentNeed[] = closingQuery.data?.data.consents ?? []
  const missingConsentSignatures = unsignedConsents.filter((need) => !need.personSigned).length
  // Firmar con lo dictado: las sugerencias marcadas se confirman dentro del mismo envío del cierre.
  const signIdsRef = useRef<string[] | null>(null)
  const closingControls = closingQuery.data?.data.controls ?? null
  /** El control que dictó Clío y entra con la firma: ya dice cuándo vuelve. */
  const dictatedControl = (marked: readonly string[] | null): DictatedControl | null => {
    const item = marked
      ? dictation.suggestions.find((candidate) => candidate.kind === "control" && marked.includes(candidate.id))
      : undefined
    const dueAt = item?.payload["dueAt"]
    return item && typeof dueAt === "string" ? { id: item.id, day: clinicDateTimeValue(dueAt).slice(0, 10) } : null
  }
  const closingForm = useClosingForm({
    // Firmar con lo dictado no lo pide: con consentimientos por firmar, sigue al cierre (`finalizeWith`).
    needsReason: () => unsignedConsents.length > 0 && signIdsRef.current === null,
    needsRegistration,
    needsNextDay: (value) =>
      needsNextControlDay(
        value,
        closingControls,
        dictatedControl(signIdsRef.current),
        continuingAfterSign(closingQuery.data?.data.sessions, sessionAnswers).length > 0,
      ),
    onSubmit: (value) => finalizeWith(value),
  })
  const closingError = useFormSubmitError(closingForm)
  const afterVoid = async () => {
    setVoidOpen(false)
    await queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
    await queryClient.invalidateQueries({ queryKey: ["open-encounter", patientId] })
    await queryClient.invalidateQueries({ queryKey: ["encounters", patientId] })
    // Pudo anularse su presupuesto: el Plan y la atención lo vuelven a leer.
    for (const key of PLAN_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [key, patientId] })
    await onChanged()
  }

  // Tratamientos a los que se puede ligar una receta o un control desde esta
  // atención: los vinculados y los indicados aquí, sin repetir.
  const attentionItems = (() => {
    const seen = new Set<string>()
    return [...detail.plannedItems, ...detail.indicatedItems].filter((item) => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
  })()
  /** «Resina… · 36»: el tratamiento de «¿Terminaste?» con su pieza, si la tiene. */
  const sessionLabelOf = (session: ClosingSession) => {
    const tooth = attentionItems.find((item) => item.id === session.planItemId)?.toothNumber
    if (tooth != null) return `${session.title} · ${tooth}`
    // Lo aceptado sin empezar no está en la atención: su sitio lo dice el cierre («Corona · pieza 46»).
    const place =
      session.place ?? closingQuery.data?.data.sessions?.accepted?.find((row) => row.planItemId === session.planItemId)?.place
    return place ? `${session.title} · ${place}` : session.title
  }
  const answerSession = (planItemId: string, answer: "terminar" | "otra") =>
    setSessionAnswers((current) => ({ ...current, [planItemId]: answer }))
  // Lo que sigue en curso si se firma así: «¿Cuándo vuelve?» es su próxima sesión.
  const continuingVisits = continuingAfterSign(closingQuery.data?.data.sessions, sessionAnswers, sessionLabelOf)
  const canBook = usePermission("appointments.write")

  const valuesRef = useRef<DraftValues>({
    presentIllness: encounter.presentIllness ?? "",
    illnessDuration: encounter.illnessDuration ?? "",
    prognosis: encounter.prognosis ?? "",
    vitals: vitalsDraft(encounter.vitals),
    reason: encounter.reason ?? "",
    evolution: encounter.evolution ?? "",
    indications: encounter.indications ?? "",
    teeth: sortTeeth(detail.teeth),
    examination: exam.draft(encounter.examination),
  })
  const dirtyRef = useRef<Set<DraftKey>>(new Set())
  const inflightRef = useRef<Set<DraftKey>>(new Set())
  const drainRef = useRef<Promise<void> | null>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const mountedRef = useRef(true)
  const childCountRef = useRef(0)
  const latestWriteAtRef = useRef(new Date(encounter.updatedAt).getTime())
  // Los textos que otra pestaña cambió: no se vuelven a enviar hasta recargar, y lo demás sigue guardándose.
  const conflictRef = useRef<Set<DraftKey>>(new Set())
  /** El último aviso de otra pestaña: con él corta la barrera si solo queda lo en conflicto. */
  const staleRef = useRef<unknown>(null)
  // Lo último guardado de cada texto, como lo devolvió el servidor: viaja como `base`.
  const savedTextRef = useRef<Record<TextKey, string | null>>({
    reason: encounter.reason ?? null,
    evolution: encounter.evolution ?? null,
    indications: encounter.indications ?? null,
    presentIllness: encounter.presentIllness ?? null,
    illnessDuration: encounter.illnessDuration ?? null,
    prognosis: encounter.prognosis ?? null,
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: se monta una vez; `drain` solo lee refs
  useEffect(() => {
    mountedRef.current = true
    // Al volver la conexión, lo escrito se guarda solo.
    const retry = () => {
      if (dirtyRef.current.size > 0) void drain().catch(() => {})
    }
    window.addEventListener("online", retry)
    return () => {
      mountedRef.current = false
      window.removeEventListener("online", retry)
      window.clearTimeout(timerRef.current)
      // Salir por la miga o el menú no pierde lo último escrito.
      if (dirtyRef.current.size > 0) void drain().catch(() => {})
    }
  }, [])

  const branchesQuery = useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Array<{ id: string; name: string }> }>("/api/branches"),
    enabled: canRead,
  })
  // Los documentos de la atención (consentimientos, órdenes, recetas,
  // formularios, imágenes) y lo que pide en consentimientos: una sola lectura
  // para el bloque, su resumen y el cierre.
  const docs = useEncounterDocuments(patientId, encounterId, detail)
  // Las atenciones de la persona, para subir un archivo unido a esta.
  const encountersQuery = useQuery({
    queryKey: ["encounters", patientId, "lista"],
    queryFn: () => apiFetch<{ data: Encounter[] }>(`/api/patients/${patientId}/encounters?limit=50`),
    enabled: canRead,
  })
  // Los controles no vienen en el detalle: se cuentan por atención para saber
  // si el bloque ya tiene contenido y debe seguir visible.
  const followUpsQuery = useQuery({
    queryKey: ["follow-ups", patientId],
    queryFn: () => fetchFollowUps(patientId),
    enabled: canRead,
  })

  // Los textos pertenecen al editor. Solo los registros vinculados pueden
  // añadir piezas; una respuesta anterior al último PATCH no debe borrarlas.
  useEffect(() => {
    const updatedAt = new Date(encounter.updatedAt).getTime()
    if (updatedAt < latestWriteAtRef.current) return
    latestWriteAtRef.current = updatedAt
    if (dirtyRef.current.has("teeth") || inflightRef.current.has("teeth")) return
    const next = sortTeeth(detail.teeth)
    if (next.join(",") !== valuesRef.current.teeth.join(",")) {
      valuesRef.current.teeth = next
      setTeeth(next)
    }
  }, [detail.teeth, encounter.updatedAt])

  // El motivo que puso el servidor al elegir en «Hoy viene a…» (o que quitó «Hoy no») se ve en su
  // campo y pasa a ser lo guardado: si no, escribir después daría un falso «otra pestaña lo cambió».
  // Lo que se está escribiendo manda: no se pisa.
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo cuando cambia el motivo guardado en el servidor
  useEffect(() => {
    const stored = encounter.reason ?? null
    if (stored === savedTextRef.current.reason) return
    if (dirtyRef.current.has("reason") || inflightRef.current.has("reason")) return
    savedTextRef.current.reason = stored
    valuesRef.current.reason = stored ?? ""
    draftForm.setFieldValue("reason", stored ?? "")
  }, [encounter.reason])

  const clearTimer = () => {
    window.clearTimeout(timerRef.current)
    timerRef.current = undefined
  }

  const buildBody = (keys: DraftKey[]): DraftPatch => {
    const values = valuesRef.current
    const body: DraftPatch = {}
    for (const key of keys) {
      switch (key) {
        case "presentIllness":
        case "illnessDuration":
        case "prognosis":
          body[key] = values[key].trim() === "" ? null : values[key]
          break
        case "vitals": {
          const filled = Object.fromEntries(
            Object.entries(values.vitals).filter(([, raw]) => raw.trim() !== ""),
          )
          // Incompletos o fuera de rango no se envían: el error se muestra en línea
          // y se guardan al corregirlos.
          if (!parseVitals(filled, exam.vitals).ok) break
          body.vitals = Object.keys(filled).length > 0 ? filled : null
          break
        }
        case "reason":
          body.reason = values.reason === "" ? null : values.reason
          break
        case "evolution":
          body.evolution = values.evolution === "" ? null : values.evolution
          break
        case "indications":
          body.indications = values.indications === "" ? null : values.indications
          break
        case "teeth":
          body.teeth = [...values.teeth]
          break
        case "examination":
          body.examination = exam.body(values.examination)
          break
      }
    }
    // Cada texto que viaja dice de qué versión partió.
    const base: Partial<Record<TextKey, string | null>> = {}
    for (const key of keys) if (isTextKey(key) && key in body) base[key] = savedTextRef.current[key]
    if (Object.keys(base).length > 0) body.base = base
    return body
  }

  /** Lo que falta para cerrar se vuelve a pedir al servidor (el pie, «Cierre de la atención» y el cierre). */
  const refreshClosing = () =>
    queryClient.invalidateQueries({ queryKey: ["encounter-closing", patientId, encounterId] })

  /** Un solo drenado serializado: toma los dirty, los envía y repite si llegaron más. */
  const drain = (): Promise<void> => {
    if (drainRef.current) return drainRef.current
    const run = (async () => {
      // Sin nada enviado, «Guardado» conserva su hora: cerrar un bloque sin cambios no es guardar.
      let sentAny = false
      // Lo que se envió: al guardar bien solo eso deja de tener algo que corregir.
      const sent = new Set<string>()
      // Alguna tanda llegó al servidor: lo que falta para cerrar puede haber cambiado.
      let savedAny = false
      // El aviso de otra pestaña: lo demás se guardó; ese campo queda con lo escrito, sin enviarse.
      let stale: unknown = null
      try {
        if (mountedRef.current) setSaveState("saving")
        for (;;) {
          const sendable = [...dirtyRef.current].filter((key) => !conflictRef.current.has(key))
          if (sendable.length === 0) break
          sentAny = true
          for (const key of sendable) dirtyRef.current.delete(key)
          for (const key of sendable) sent.add(key)
          for (const key of sendable) inflightRef.current.add(key)
          try {
            const saved = await apiFetch<{ data: Encounter }>(
              `/api/patients/${patientId}/encounters/${encounterId}`,
              {
                method: "PATCH",
                body: JSON.stringify(buildBody(sendable)),
              },
            )
            latestWriteAtRef.current = Math.max(
              latestWriteAtRef.current,
              new Date(saved.data.updatedAt).getTime(),
            )
            // Lo que quedó guardado es la nueva base de cada texto enviado, también en la caché:
            // al volver a la atención se parte de lo guardado, no de una copia vieja.
            for (const key of sendable) if (isTextKey(key)) savedTextRef.current[key] = saved.data[key] ?? null
            queryClient.setQueryData<{ data: EncounterDetail }>(["encounter", patientId, encounterId], (old) =>
              old ? { ...old, data: { ...old.data, encounter: { ...old.data.encounter, ...saved.data } } } : old,
            )
            savedAny = true
            // La sección «Signos vitales» y la medición anterior se leen de nuevo.
            if (sendable.includes("vitals"))
              void queryClient.invalidateQueries({ queryKey: ["patient-vitals", patientId] })
            // El examen guardado ya no tiene nada que corregir.
            if (sendable.includes("examination") && mountedRef.current) setExamErrors({})
          } catch (err) {
            // Otra pestaña guardó otro texto en un campo: ese se aparta y lo demás se vuelve a enviar.
            const fields = err instanceof ApiError && err.shape.code === "STALE_DRAFT" ? Object.keys(err.shape.fields ?? {}) : []
            if (fields.length > 0) {
              for (const key of sendable) if (fields.includes(key)) conflictRef.current.add(key)
              for (const key of sendable) dirtyRef.current.add(key)
              stale = err
              staleRef.current = err
              continue
            }
            for (const key of sendable) dirtyRef.current.add(key)
            throw err
          } finally {
            for (const key of sendable) inflightRef.current.delete(key)
          }
        }
        if (mountedRef.current) {
          setSaveError(null)
          // Lo guardado ya no tiene nada que corregir; lo que falta para cerrar sigue marcado.
          clearSubmitErrors(draftForm, (name) => [...sent].some((key) => name === key && !conflictRef.current.has(key as DraftKey) || name.startsWith(`${key}.`)))
          setSaveState(dirtyRef.current.size > 0 ? "pending" : "saved")
          if (sentAny) setSavedAt(new Date().toISOString())
          // Un campo que cambió otra pestaña se dice junto a él, y el estado no dice «Guardado».
          if (stale || [...dirtyRef.current].some((key) => conflictRef.current.has(key))) {
            // El aviso se vuelve a decir aunque se haya seguido escribiendo después del conflicto.
            const shown = stale ?? staleRef.current
            if (shown) setSaveError(placeAutosaveError(shown))
            setSaveState("error")
          }
        }
        // Lo guardado (el motivo, la evolución, los signos) se vuelve a comprobar en el cierre.
        if (savedAny) void refreshClosing()
      } catch (err) {
        // Aunque una tanda posterior falle, lo que sí se guardó ya cuenta para cerrar.
        if (savedAny) void refreshClosing()
        if (mountedRef.current) {
          // Sin conexión lo escrito se queda en la pantalla y se guarda al volver.
          if (isOffline(err)) {
            setSaveError(null)
            setSaveState("offline")
          } else {
            setSaveError(placeAutosaveError(err))
            setSaveState("error")
          }
        }
        throw err
      }
    })().finally(() => {
      // También se libera cuando no hubo ningún await (borrador sin cambios).
      drainRef.current = null
    })
    drainRef.current = run
    return run
  }

  /** Barrera de escritura: la consumen hijos, guardado, finalizar y volver. */
  const flush = async (): Promise<void> => {
    clearTimer()
    await untilWritten({
      drain,
      pending: () => [...dirtyRef.current],
      inConflict: (key) => conflictRef.current.has(key),
      conflictError: () =>
        staleRef.current ?? new Error("Otra pestaña o persona cambió lo marcado: copia lo tuyo si lo necesitas y recarga para ver lo último."),
    })
  }

  const markEdited = (key: DraftKey) => {
    dirtyRef.current.add(key)
    if (mountedRef.current) {
      setSaveError(null)
      setSaveState(drainRef.current ? "saving" : "pending")
    }
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined
      void drain().catch(() => {})
    }, AUTOSAVE_MS)
  }

  /**
   * Un rechazo del autoguardado: lo que es de un campo del borrador se marca en
   * él (aunque se siga escribiendo ahí), lo del examen en su dato y lo demás
   * queda para el aviso, que es lo que devuelve.
   */
  const placeAutosaveError = (err: unknown): string => {
    const { form, fields } = submitErrorOf(err)
    const own: Record<string, string> = {}
    const examFields: Record<string, string> = {}
    const rest: string[] = []
    for (const [key, message] of Object.entries(fields)) {
      if (key.startsWith("examination.")) examFields[key.slice("examination.".length)] = message
      else if (DRAFT_TEXT_KEYS.includes(key as DraftTextKey) || key.startsWith("vitals.")) own[key] = message
      else rest.push(message)
    }
    setExamErrors(examFields)
    setSubmitErrors(draftForm, { fields: own })
    if (form) return form
    if (rest.length > 0) return rest.join(" ")
    // Otra pestaña cambió un texto: no se guarda solo; lo demás sí se guardó.
    if (err instanceof ApiError && err.shape.code === "STALE_DRAFT")
      return "Otra pestaña o persona cambió lo marcado: lo demás se guardó. Copia lo tuyo si lo necesitas y recarga para ver lo último."
    return "No se guardó lo último: corrige lo marcado y se guarda solo."
  }

  /** Lo escrito en un campo del borrador (el campo ya lo tiene): lo guarda el autoguardado. */
  const rememberText = (key: DraftTextKey, value: string) => {
    valuesRef.current[key] = value
    markEdited(key)
  }
  /** Lo que llega sin teclear (el dictado confirmado): también se ve en su campo. */
  const editText = (key: DraftTextKey, value: string) => {
    draftForm.setFieldValue(key, value)
    rememberText(key, value)
  }
  const rememberVital = (key: string, value: string) => {
    valuesRef.current.vitals = { ...valuesRef.current.vitals, [key]: value }
    markEdited("vitals")
  }
  const editVital = (key: string, value: string) => {
    draftForm.setFieldValue(`vitals.${key}`, value)
    rememberVital(key, value)
  }
  /** El ToothSelector entrega el set completo: se ordena, se publica y el autosave lo persiste. */
  const editTeeth = (value: number[]) => {
    const next = sortTeeth(value)
    valuesRef.current.teeth = next
    setTeeth(next)
    markEdited("teeth")
  }

  /** El examen lo arma el producto: el borrador entero cambia de una vez. */
  const editExamination = (next: unknown) => {
    valuesRef.current.examination = next
    setExamination(next)
    markEdited("examination")
  }
  /**
   * Una sugerencia del dictado ya confirmada: el servidor la guardó con la
   * operación de siempre y aquí se refleja. Los textos de la nota pasan por los
   * mismos editores que al escribir, para que el borrador local no los pise.
   */
  const applyDictation = (item: DictationSuggestion) => {
    if (item.kind === "nota") {
      for (const key of DRAFT_TEXT_KEYS) {
        const value = item.payload[key]
        if (typeof value !== "string") continue
        const stored = item.joined?.[key]
        // Lo unido quedó guardado en el servidor: es la nueva base de ese texto.
        if (stored !== undefined) savedTextRef.current[key] = stored.trim() ? stored : null
        if (stored !== undefined && !dirtyRef.current.has(key) && !inflightRef.current.has(key)) {
          // Sin nada por guardar manda lo que quedó en el servidor: este borrador puede ir por detrás
          // (al volver a la atención, en otra pestaña) y guardarlo borraría lo que había.
          draftForm.setFieldValue(key, stored)
          valuesRef.current[key] = stored
        } else {
          // Hay algo escrito que aún no se guardó: se une a eso, porque su guardado es el que queda.
          editText(key, appendDictated(valuesRef.current[key], value, key))
        }
      }
    }
    // Los signos y el examen confirmados pasan por los mismos editores, para que el borrador local no los pise.
    if (item.kind === "signos") {
      for (const [key, value] of Object.entries(item.payload)) if (typeof value === "number") editVital(key, String(value))
      void queryClient.invalidateQueries({ queryKey: ["patient-vitals", patientId] })
    }
    if (item.kind === "examen" && exam.withDictated) editExamination(exam.withDictated(valuesRef.current.examination, item.payload))
    // Un diagnóstico confirmado (o quitado) cambia la lista de problemas y lo que se propone.
    if (item.kind === "diagnostico") {
      void queryClient.invalidateQueries({ queryKey: ["patient-diagnoses", patientId] })
      void queryClient.invalidateQueries({ queryKey: ["diagnosis-suggestions", patientId] })
    }
    // La alergia confirmada se ve al momento en la franja de alertas, como al agregarla a mano.
    if (item.kind === "alergia") {
      void queryClient.invalidateQueries({ queryKey: ["patient-health", patientId] })
      void queryClient.invalidateQueries({ queryKey: ["patient", patientId] })
      void queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
    }
    // La cita reservada y el presupuesto armado se ven al momento: en «Qué sigue» y en «Presupuesto por enviar».
    if (item.kind === "cita" || item.kind === "presupuesto") {
      for (const key of PLAN_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [key, patientId] })
      void queryClient.invalidateQueries({ queryKey: ["plan-next", patientId] })
    }
    void queryClient.invalidateQueries({ queryKey: ["plan-items", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["follow-ups", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["odontogram", patientId] })
    void refreshClosing()
    void onChanged()
  }
  // El dictado del asistente clínico, solo para quien lleva la atención.
  const dictation = useDictationSession({
    patientId,
    encounterId,
    active: canWrite && attending,
    onApplied: applyDictation,
    noteText: (key) => String(draftForm.getFieldValue(key as DraftTextKey) ?? ""),
  })
  // Sugerencias que el odontólogo aún no confirmó ni descartó.
  const dictationPending = dictation.enabled ? dictation.pending : 0
  /** Lo que se dicta en un bloque: en los comunes, lo de arriba; en los del producto, lo que declara el bloque. */
  const dictationOf = (key: SectionKey) =>
    SECTION_DICTATION[key as CommonSectionKey] ?? product.blocks.find((block) => block.key === key)?.dictation
  /** ¿Tiene la parte algo quitado por voz que aún se puede deshacer? Entonces se muestra. */
  const dictationRemoved = (key: SectionKey): boolean => {
    const kinds = dictationOf(key)?.kinds ?? []
    return dictation.enabled && dictation.removedByVoice.some((item) => kinds.includes(item.kind))
  }
  const dictationCount = (key: SectionKey): number => {
    const kinds = dictationOf(key)?.kinds ?? []
    return dictation.enabled ? dictation.suggestions.filter((item) => kinds.includes(item.kind)).length : 0
  }

  /**
   * Hora de fin declarada: hoy a la hora indicada, en la zona de la clínica. El
   * minuto de inicio (con sus segundos en 0) queda antes del inicio: se toma
   * el inicio mismo.
   */
  const endedAtIso = (endTime: string): string | null => {
    if (!endTime) return null
    const today = clinicDateTimeValue(new Date().toISOString()).slice(0, 10)
    const iso = instantFromClinicValue(`${today}T${endTime}`)
    const startedAt = encounter.startedAt
    if (iso && startedAt) {
      const early = new Date(startedAt).getTime() - new Date(iso).getTime()
      if (early > 0 && early < 60_000) return startedAt
    }
    return iso
  }

  const handleTakeOver = async () => {
    if (takingOver) return
    setTakingOver(true)
    try {
      await takeOverEncounterApi(patientId, encounterId)
      await queryClient.invalidateQueries({ queryKey: ["open-encounter", patientId] })
      await onChanged()
      await refreshClosing()
    } catch (err) {
      setSaveError(submitErrorMessage(err))
    } finally {
      if (mountedRef.current) setTakingOver(false)
    }
  }

  // Si debe justo lo que se cargó hoy, se dice que es eso: el mismo importe en dos renglones se
  // leía como que debía el doble (segunda mesa del 9 nov).
  const owedSameAsToday =
    finalizedOwed.length === 1 &&
    finalizedBilling?.currency === finalizedOwed[0]?.currency &&
    finalizedBilling?.chargedCents === finalizedOwed[0]?.saldo
  // La cuenta ya leída (con lo que se acaba de cobrar) y sin saldo: pagó todo.
  const finalizedPaidUp =
    canReadFinance &&
    accountQuery.isSuccess &&
    !accountQuery.isFetching &&
    finalizedOwed.length === 0
  const chargedLines = finalizedBilling?.lines.filter((line) => line.status === "charged") ?? []
  const skippedLines = finalizedBilling?.lines.filter((line) => line.status !== "charged") ?? []
  const closeFinalized = () => {
    if (!finalizedBilling) return
    const hadCharges = finalizedBilling.lines.some((line) => line.status === "charged")
    setFinalizedBilling(null)
    setFinalizedBudget(null)
    setFinalizedMaterials(null)
    setFinalizedControls(null)
    setFinalizedKeptOpen([])
    setFinalizedBookedAfter([])
    setFinalizedNext([])
    setBookingNext(null)
    setBudgetLater(false)
    setCorrectingMaterials(false)
    setMaterialsCorrected(false)
    setBudgetSent(false)
    void onFinalized(hadCharges)
  }
  const navigate = useNavigate()
  const canSendBudget = usePermission("budgets.send")
  /** «Revisar antes»: el presupuesto en el Plan de la persona, abierto. */
  const reviewBudget = (budgetId: string) => {
    closeFinalized()
    void navigate({ to: "/patients/$patientId", params: { patientId }, search: { tab: "plan", budgetId } })
  }

  /**
   * El cierre (el envío de `closingForm`): guarda la colegiatura si faltaba,
   * confirma lo dictado que se marcó y descarta lo demás, y firma. Si algo
   * falla, lanza: el diálogo sigue abierto con lo escrito y cada rechazo en su
   * campo (la colegiatura, el motivo para seguir sin consentimiento, la hora de
   * fin); lo que falta registrar lo lista el diálogo con su «Registrar».
   */
  const finalizeWith = async (value: ClosingValues): Promise<void> => {
    if (childCountRef.current > 0) return
    const signIds = signIdsRef.current
    // Lo que el cierre pregunta hoy; con lo dictado, el cierre ya confirmado.
    let askedSessions = closingQuery.data?.data.sessions
    signIdsRef.current = null
    setFinalizing(true)
    try {
      if (needsRegistration) {
        await saveProfessionalProfileApi("me", {
          professionalTitle: value.professionalTitle.trim(),
          registrationBody: value.registrationBody.trim(),
          registrationNumber: value.registrationNumber.trim(),
        })
        await queryClient.invalidateQueries({ queryKey: ["professional-profile"] })
      }
      if (signIds) {
        // Si una no se pudo confirmar, el aviso del dictado dice cuál; no se firma.
        const confirmed = await dictation.confirmMany.mutateAsync(signIds).then(
          () => true,
          () => false,
        )
        if (!confirmed) return
        // Lo que quedó sugerido sin confirmar no entra a la historia: se descarta.
        await apiFetch(`/api/patients/${patientId}/encounters/${encounterId}/dictation/discard-pending`, { method: "POST" })
        await dictation.refresh()
        // Lo confirmado cambia el cierre: el control dictado ya es suyo y un tratamiento
        // dictado puede llegar hoy a sus sesiones previstas.
        const shown = new Set((closingQuery.data?.data.sessions?.finishing ?? []).map((session) => session.planItemId))
        const fresh = await queryClient.fetchQuery({
          queryKey: ["encounter-closing", patientId, encounterId, keepOpen],
          queryFn: () => fetchEncounterClosing(patientId, encounterId, keepOpen),
          staleTime: 0,
        })
        askedSessions = fresh.data.sessions
        const newlyFinishing = (fresh.data.sessions?.finishing ?? []).some((session) => !shown.has(session.planItemId))
        // Con consentimientos por firmar, o algo que la firma terminaría sin haberlo
        // mostrado, sigue al cierre: ahí se firman o se dice por qué no, y «¿Terminaste?»
        // viene en «Sí, terminar» con «Falta otra sesión» a un toque.
        if (unsignedConsents.length > 0 || newlyFinishing) {
          setConfirmWithDictation(false)
          return
        }
      }
      // Congela: primero todo PATCH pendiente y último dirty, recién después finalize.
      await flush()
      const endedAt = endedAtIso(value.endTime)
      const result = await apiFetch<{
        data: {
          charges: Array<{ id: string }>
          skippedCharges: Array<{ procedureId: string; reason: string }>
          billing: FinalizeBilling
          budget: FinalizedBudget | null
          materials?: FinalizedMaterials | null
          controls?: FinalizedControls
          keptOpen?: Array<{ planItemId: string; title: string; reason: string }>
          bookedAfter?: FinalizedBookedAfter[]
          nextSessions?: NextSession[]
        }
      }>(`/api/patients/${patientId}/encounters/${encounterId}/finalize`, {
        method: "POST",
        body: JSON.stringify({
          ...(endedAt ? { endedAt } : {}),
          // «Seguir sin él»: solo si falta algún consentimiento.
          ...(unsignedConsents.length > 0 ? { consentSkipReason: value.consentSkipReason.trim() } : {}),
          // «¿Terminaste?»: «Falta otra sesión»; lo demás que llega a sus previstas se termina.
          ...sessionAnswerBody(sessionAnswers, askedSessions),
          // Lo que lo de hoy resuelve y la pantalla mostró marcado queda resuelto; lo demás, no.
          ...resolveDiagnosesBody(closingQuery.data?.data.resolvable, askedSessions, sessionAnswers, keepDiagnoses),
          // «¿Cuándo vuelve?» y los controles que cumple esta visita (ADR 0152).
          ...closingControlsBody(
            value,
            closingControls,
            dictatedControl(signIds),
            continuingAfterSign(askedSessions, sessionAnswers).length > 0,
          ),
        }),
      })
      onSigned?.()
      setConfirmOpen(false)
      setSessionAnswers({})
      setKeepDiagnoses(new Set())
      closingForm.reset()
      setBudgetSent(false)
      setFinalizedBudget(result.data.budget ?? null)
      setFinalizedMaterials(result.data.materials ?? null)
      setFinalizedControls(result.data.controls ?? null)
      setFinalizedKeptOpen(result.data.keptOpen ?? [])
      setFinalizedBookedAfter(result.data.bookedAfter ?? [])
      setFinalizedNext(result.data.nextSessions ?? [])
      setFinalizedBilling(result.data.billing)
      // «Debe en total» cuenta lo que este cierre acaba de cargar.
      if (canReadFinance) void queryClient.invalidateQueries({ queryKey: ["patient-account", patientId] })
      // El control nuevo o cumplido cambia su Plan y lo que falta agendar.
      if (result.data.controls?.next || result.data.controls?.fulfilled.length)
        void queryClient.invalidateQueries({ queryKey: ["follow-ups", patientId] })
      // En Perú, el cierre que cambió el gráfico firmó el odontograma.
      void queryClient.invalidateQueries({ queryKey: ["odontogram-assessments", patientId] })
      // Lo que salió de la sede cambia lo que hay en Inventario.
      if (result.data.materials) void queryClient.invalidateQueries({ queryKey: ["inventory"] })
    } catch (err) {
      // Se conserva el borrador y lo escrito en el cierre; lo que falta se vuelve a comprobar.
      void refreshClosing()
      // Sin colegiatura en el perfil: el rechazo va en el número, si el cierre lo pide.
      if (err instanceof ApiError && err.shape.code === "PROFILE_INCOMPLETE" && err.shape.message)
        throw new ApiError(err.status, { ...err.shape, fields: { registrationNumber: err.shape.message } })
      throw err
    } finally {
      if (mountedRef.current) setFinalizing(false)
    }
  }

  /** Lleva a una parte de la página. */
  const goTo = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" })

  /**
   * Lleva a lo que falta para cerrar: el motivo, la evolución o un signo vital
   * se marcan en su campo con el foco en él; el diagnóstico abre su formulario.
   */
  const requireBlock = (requirement: ClosingRequirement | "vitals") => {
    if (requirement === "signature") {
      setProfileOpen(true)
      return
    }
    setContextOpen(false)
    if (requirement === "diagnosis") {
      goTo(`${uid}-diagnostico`)
      if (pendingDiagnoses === 0) setDiagnosisAsk((count) => count + 1)
      return
    }
    if (requirement === "vitals") openExtra("examen")
    // Con el motivo de la cita a la vista («Su cita: … · Usar como motivo»), el campo no se marca en
    // rojo: lo primero que se ve es cómo usarlo en un toque.
    if (requirement === "reason" && offeredReason) {
      goTo(`${uid}-visita`)
      return
    }
    void submitForm(draftForm)
  }

  /**
   * «Finalizar y firmar»: lo que falta del borrador se dice en su campo, con su
   * bloque abierto; si no falta nada, se abre el cierre.
   */
  const requestSign = async () => {
    const values = draftForm.state.values
    const first: ClosingRequirement | "vitals" | null = !values.reason.trim()
      ? "reason"
      : Object.keys(vitalsErrors(values.vitals, exam.vitals)).length > 0
        ? "vitals"
        : !values.evolution.trim()
          ? "evolution"
          : missing.includes("diagnosis")
            ? "diagnosis"
            : null
    if (first) {
      requireBlock(first)
      return
    }
    // Lo recién escrito se guarda, y lo que falta se vuelve a comprobar, antes de abrir el cierre:
    // si no, diría «Falta…» de lo que ya está. También si la comprobación de un guardado aún no vuelve.
    if (dirtyRef.current.size > 0 || drainRef.current || closingQuery.isFetching) {
      try {
        await flush()
      } catch {
        // El aviso del guardado ya dice qué pasó, en su sitio.
        return
      }
      await refreshClosing()
    }
    openSign()
  }

  const handlePendingChange = (pending: boolean) => {
    childCountRef.current = Math.max(0, childCountRef.current + (pending ? 1 : -1))
    if (mountedRef.current) setChildCount(childCountRef.current)
  }

  const handleChildChanged = async (): Promise<void> => {
    await onChanged()
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["odontogram", patientId] }),
      queryClient.invalidateQueries({ queryKey: ["plan-items", patientId] }),
      // Registrar o indicar un servicio puede pedir un consentimiento.
      queryClient.invalidateQueries({ queryKey: ["consent-needs", patientId, encounterId] }),
      refreshClosing(),
    ])
  }

  // Una sola tarifa por tratamiento; los cargos vivos ya emitidos lo cubren.
  const coveredItems = new Set(accountQuery.data?.data.conCargo ?? [])
  const chargeableByCurrency = new Map<string, number>()
  for (const proc of detail.procedures) {
    if (proc.voidedAt) continue
    if (!proc.serviceId || proc.priceCents === null || proc.priceCents <= 0 || !proc.currency)
      continue
    if (proc.planItemId && coveredItems.has(proc.planItemId)) continue
    if (proc.planItemId) coveredItems.add(proc.planItemId)
    chargeableByCurrency.set(
      proc.currency,
      (chargeableByCurrency.get(proc.currency) ?? 0) + proc.priceCents,
    )
  }
  const chargeableText = [...chargeableByCurrency.entries()]
    .map(([currency, cents]) => (orgLocale ? formatMoney(cents, currency, orgLocale) : "…"))
    .join(" · ")

  const mode = useDetailMode()

  const locked = !canWrite || !attending || childCount > 0 || finalizing
  // El motivo de la reserva se ofrece solo a quien puede usarlo y mientras no haya otro. No
  // depende de `locked`: durante una escritura en curso sigue a la vista (con «Usar» apagado),
  // sin parpadear a «Sin motivo».
  const offeredReason =
    canWrite && attending && !finalizing && reason.trim() === "" ? detail.bookedReason : null
  const takeOfferedReason = () => {
    if (offeredReason && !locked) editText("reason", offeredReason)
  }
  // Los bloques del producto (odentIA: Odontograma y Periodontograma), después del examen.
  const product = productUi().encounter.useBlocks({
    patientId,
    encounterId,
    detail,
    birthDate: patient.patient.birthDate,
    canRead,
    canWrite,
    locked,
    writable: canWrite && attending && !finalizing,
    flush,
    onChanged: handleChildChanged,
    onPendingChange: handlePendingChange,
  })

  const followUps = (followUpsQuery.data?.data ?? []).filter(
    (row) => row.originEncounterId === encounterId,
  )
  // Tratamientos que esta atención deja por ejecutar: los cuenta el servidor, sin
  // lo que la persona no aceptó ni el camino que no eligió.
  const pendingTreatments = detail.pendingTreatments

  /**
   * Bloques disponibles con su resumen real. `empty` significa «no hay nada
   * registrado»: sin contenido y sin agregar explícitamente, el bloque no se
   * muestra; nunca se pinta un bloque vacío por existir en el sistema.
   */
  const activeDiagnosisRows = (detail.diagnoses ?? []).filter((dx) => !dx.voidedAt)
  const activeDiagnoses = activeDiagnosisRows.length
  // «Caries dental · 26 oclusal», como se lee en la historia; sin nombre en la lista, el conteo.
  const diagnosisNames = activeDiagnosisRows.every((dx) => dx.diagnosisTitle)
    ? activeDiagnosisRows
        .map((dx) => [dx.diagnosisTitle, dx.toothNumber != null ? String(dx.toothNumber) : null].filter(Boolean).join(" · "))
        .join("; ")
    : ""
  const activeProcedures = detail.procedures.filter((proc) => !proc.voidedAt).length
  const findingGroups = groupFindings(
    (detail.odontogramEntries ?? []).filter((entry) => !entry.voidedAt),
  ).length
  // Los tratamientos con la sesión de hoy: un procedimiento vigente suyo en esta atención.
  const sessionItemIds = new Set(
    detail.procedures.flatMap((proc) => (!proc.voidedAt && proc.planItemId ? [proc.planItemId] : [])),
  )
  // Lo indicado hoy que sigue en pie (lo quitado queda cancelado y no cuenta).
  const liveIndicated = detail.indicatedItems.filter((item) => item.status !== "cancelado")
  const sections: Array<{
    key: SectionKey
    title: string
    description: string
    summary: string
    empty: boolean
  }> = [
    {
      key: "consulta",
      title: "Consulta",
      // Sin «dónde» (latidIA), la parte del cuerpo se escribe en el texto (decisión 4 del issue 229).
      description: productUi().site
        ? "Motivo de consulta, tiempo y relato de la enfermedad, sede y piezas evaluadas."
        : "Motivo de consulta, tiempo y relato de la enfermedad, y sede.",
      // La tarjeta dice lo que tiene; lo que falta para firmar se dice en «Cierre de la atención» y en el pie.
      // Sin motivo propio dice «Sin motivo», aunque la cita traiga uno: ese se ofrece debajo, con «Usar».
      summary: reason.trim() !== "" ? reason.trim() : "Sin motivo",
      empty: reason.trim() === "",
    },
    {
      key: "examen",
      title: exam.title,
      description: exam.description,
      summary:
        [formatVitals(parsedVitals), exam.summary(examination)]
          .filter(Boolean)
          .join(" · ") || "Sin examen registrado",
      empty: examination === null && Object.values(vitals).every((v) => v.trim() === ""),
    },
    ...product.blocks.map(({ key, title, description, summary, empty }) => ({ key, title, description, summary, empty })),
    {
      key: "hallazgos",
      title: "Diagnóstico",
      description: productUi().site
        ? "Diagnósticos de la lista de la clínica con su tipo y pieza. Al menos uno para cerrar."
        : "Diagnósticos de la lista de la clínica con su tipo. Al menos uno para cerrar.",
      summary:
        activeDiagnoses === 0
          ? "Sin diagnósticos registrados"
          : diagnosisNames || counted(activeDiagnoses, "diagnóstico", "diagnósticos"),
      empty: activeDiagnoses === 0,
    },
    {
      key: "procedimientos",
      title: "Procedimientos",
      description: "Actos ejecutados hoy, con su prestación y precio. Se anulan con motivo.",
      summary:
        activeProcedures === 0
          ? "Sin procedimientos registrados"
          : counted(activeProcedures, "procedimiento", "procedimientos"),
      empty: detail.procedures.length === 0,
    },
    {
      key: "plan",
      title: "Plan y controles",
      description:
        "El plan en corto, lo hecho hoy y el próximo control. Indicar no ejecuta ni cobra.",
      summary:
        [
          // Sin lo quitado: el contador dice lo que sigue indicado (QA del 9 nov).
          liveIndicated.length > 0 ? `${counted(liveIndicated.length, "indicado", "indicados")} hoy` : "",
          pendingTreatments > 0 ? `${pendingTreatments} por ejecutar` : "",
          followUps.length > 0 ? counted(followUps.length, "control", "controles") : "",
        ]
          .filter(Boolean)
          .join(" · ") || "Sin indicaciones ni controles",
      empty:
        liveIndicated.length === 0 &&
        detail.plannedItems.length === 0 &&
        followUps.length === 0,
    },
    {
      key: "documentos",
      title: "Documentos",
      description: "Receta, consentimiento, orden, formulario, imagen o archivo de esta atención.",
      summary:
        [
          docs.total === 0 ? "Sin documentos" : counted(docs.total, "documento", "documentos"),
          docs.toSign.length > 0 ? `${docs.toSign.length} sin firmar` : "",
          docs.pendingSignatures.length > docs.toSign.length
            ? `falta confirmar ${docs.pendingSignatures.length - docs.toSign.length}`
            : "",
          docs.toPrepare.length > 0 ? "necesita consentimiento" : "",
        ]
          .filter(Boolean)
          .join(" · "),
      // Lo que la atención pide en consentimientos también deja el bloque a la vista.
      empty: docs.total === 0 && docs.needs.length === 0,
    },
    {
      key: "evolucion",
      title: "Evolución, pronóstico e indicaciones",
      description: "Evolución (obligatoria para cerrar), indicaciones y pronóstico.",
      summary:
        evolution.trim() === ""
          ? indications.trim() === ""
            ? "Sin evolución"
            : "Sin evolución · indicaciones registradas"
          : indications.trim() === ""
            ? "Evolución registrada"
            : "Evolución e indicaciones registradas",
      empty: evolution.trim() === "" && indications.trim() === "",
    },
  ]

  // Antes de cerrar: qué queda registrado y qué no, con los mismos resúmenes
  // que ve el clínico en cada bloque.
  const missing = closingQuery.data?.data.missing ?? []
  const closingReady = closingQuery.data?.data.ready === true
  // Solo falta la colegiatura: se puede abrir el cierre, que la pide ahí mismo.
  const onlyRegistrationMissing = needsRegistration && missing.every((requirement) => requirement === "signature")
  const closingSections = sections.filter((section) => section.key !== "consulta")
  const recorded = closingSections.filter((section) => !section.empty).map((s) => s.summary)
  // Con «¿Cuándo vuelve?» en el mismo cierre, «plan y controles» no se dice como algo sin registrar.
  // El odontograma que el cierre firma por lo que hoy queda tratado (la sesión 2 de la endodoncia)
  // tampoco: decía a la vez «queda firmado» y «Sin registrar: odontograma» (QA del 9 nov).
  const signsOdontogram = Boolean(closingQuery.data?.data.odontogram)
  const unrecorded = closingSections
    .filter(
      (section) =>
        section.empty && !(section.key === "plan" && closingControls) && !(section.key === "odontograma" && signsOdontogram),
    )
    .map((section) => section.title.toLowerCase())
  // Lo que nunca se le preguntó de su salud también es algo sin registrar; con anestesia lo dice
  // aparte, junto a los materiales, y no se repite aquí. La ASA solo cuenta con anestesia.
  const withAnesthesia = (closingQuery.data?.data.health?.anesthetics.length ?? 0) > 0
  const unaskedHealth = healthGaps.filter((gap) => gap !== "asa")
  const unrecordedAll =
    !withAnesthesia && unaskedHealth.length > 0 ? [...unrecorded, healthGapWords(unaskedHealth)] : unrecorded
  // Lo de las adendas ya lo dice el subtítulo del cierre: una sola vez.
  const finalizeDescription = [
    recorded.length > 0 ? `Registrado: ${recorded.join("; ")}.` : "",
    unrecordedAll.length > 0 ? `Sin registrar: ${unrecordedAll.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ")

  /** Al dictar, si cabe, el respaldo se muestra al lado. */
  const startDictation = () => {
    setDictationTyping(false)
    if (mode === "panel") setTranscriptOpen(true)
  }
  const finishDictation = () => {
    dictation.finish()
    setTranscriptOpen(false)
  }
  const showTranscript = () => setTranscriptOpen(true)
  const contextSurface = {
    title: "Antecedentes y última atención",
    description: "Solo lectura: se editan en Antecedentes de su ficha.",
    onClose: () => setContextOpen(false),
    children: <EncounterContextBody patientId={patientId} encounterId={encounterId} />,
  }
  const transcriptSurface = {
    title: "Lo dictado",
    description: "Tu respaldo: lo resaltado generó una sugerencia.",
    onClose: () => setTranscriptOpen(false),
    children: <DictationTranscript session={dictation} />,
  }
  const closingId = `${uid}-cierre`
  // No se firma lo que no se guardó: sin conexión o con cambios por guardar, espera.
  const unsaved = saveState !== "saved"
  // Lo que falta registrar no apaga «Finalizar y firmar»: lleva a su bloque y lo marca (`requestSign`).
  const canSign = !(locked || !closingQuery.isSuccess || dictation.busy || unsaved)
  const signBlockedReason =
    saveState === "offline"
      ? "Sin conexión: lo escrito se guarda al volver y recién entonces se puede firmar."
      : saveState === "pending" || saveState === "saving"
        ? "Guardando lo último que escribiste…"
        : saveState === "error"
          ? "No se pudo guardar lo último: revisa el aviso y vuelve a intentarlo."
          : childCount > 0
            ? "Guardando lo último que registraste…"
            : null
  const openSign = () => {
    signIdsRef.current = null
    // Lo escrito en un cierre que falló se conserva; la primera vez, la colegiatura
    // viene con lo que ya tiene el perfil y, si falta, lo que propone el país (COP, CMP).
    const current = closingForm.state.values
    if (needsRegistration && !current.professionalTitle && !current.registrationBody && !current.registrationNumber) {
      const profile = profileQuery.data?.data
      const suggested = productUi().country.professional(orgProfile?.countryCode)
      closingForm.reset({
        ...current,
        professionalTitle: profile?.professionalTitle || suggested?.title || "",
        registrationBody: profile?.registrationBody || suggested?.registrationBody || "",
        registrationNumber: profile?.registrationNumber ?? "",
      })
    }
    setConfirmWithDictation(dictationPending > 0)
    setConfirmOpen(true)
  }
  const signer = firstNameOf(patient)
  const confirmingRef = useRef(false)
  /** «Firmar ahora» desde el cierre: prepara lo que falta y abre la firma en la unidad dental. */
  const signConsentsNow = async (need: ConsentNeed) => {
    try {
      // Ya lo firmó en su enlace: solo falta que quien atiende lo confirme.
      if (need.personSigned && need.documentId) {
        // Un segundo toque recibiría «no espera tu confirmación» aunque el primero sí la dejó.
        if (confirmingRef.current) return
        confirmingRef.current = true
        try {
          await confirmLinkSignedConsent(need.documentId, encounterId)
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["consent-needs", patientId, encounterId] }),
            queryClient.invalidateQueries({ queryKey: ["consents", patientId] }),
            queryClient.invalidateQueries({ queryKey: ["consents-to-confirm", patientId] }),
            refreshClosing(),
          ])
          await onChanged()
        } finally {
          confirmingRef.current = false
        }
        return
      }
      if (need.status === "sin_preparar") {
        await flush()
        await prepareConsents(patientId, encounterId, [need.templateKey])
      }
      const list = await queryClient.fetchQuery({
        queryKey: ["consents", patientId],
        queryFn: () => fetchConsents({ patientId }),
        staleTime: 0,
      })
      const pending = list.data.filter(
        (doc) => doc.encounterId === encounterId && doc.status === "pendiente" && !doc.personSignedAt,
      )
      // Primero el que se pulsó (QA del 8 nov: «Firmar ahora» de la endodoncia abría la prótesis).
      const pressed = (doc: ConsentDocument) =>
        doc.id === need.documentId ||
        (need.planItemId != null && doc.planItemId === need.planItemId) ||
        doc.titleSnapshot === need.title
      const ordered = [...pending.filter(pressed), ...pending.filter((doc) => !pressed(doc))]
      if (ordered.length > 0) setSigningDocs(ordered)
    } catch (err) {
      // Desde el cierre, el aviso va en el cierre (el diálogo tapa la página).
      if (confirmOpen) setSubmitErrors(closingForm, { form: submitErrorMessage(err) })
      else setSaveError(submitErrorMessage(err))
    }
  }
  /** «Firmar» desde la barra del teléfono: firma si se puede; si no, lleva a lo que falta para cerrar. */
  const signFromBar = () => {
    if (canSign) void requestSign()
    else document.getElementById(closingId)?.scrollIntoView({ block: "start" })
  }
  /** Desde el cierre, una sugerencia de Clío que se completa o se corrige: se abre para eso. */
  const openSuggestion = (id: string) => {
    setConfirmOpen(false)
    const item = dictation.suggestions.find((candidate) => candidate.id === id)
    if (item) dictation.openEdit(item)
  }
  const pendingDiagnoses = dictationCount("hallazgos")

  /** El relato de la enfermedad se abre en la página; con algo escrito queda abierto. */
  const [illnessOpen, setIllnessOpen] = useState(false)
  const showIllness = illnessOpen || draftValues.presentIllness.trim() !== ""
  const branches = branchesQuery.data?.data ?? []
  const consultaBody = (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <draftForm.AppField name="reason">
          {(field) => (
            <field.Control label="Motivo de consulta" id={`${uid}-reason`}>
              {(control) => (
                <Textarea
                  {...control.props}
                  aria-required
                  rows={2}
                  value={field.state.value}
                  disabled={locked}
                  maxLength={MAX_REASON}
                  placeholder="Motivo de la consulta…"
                  onChange={(event) => {
                    field.handleChange(event.target.value)
                    rememberText("reason", event.target.value)
                  }}
                />
              )}
            </field.Control>
          )}
        </draftForm.AppField>
        {/* Tiempo y relato no traban el cierre: en un control no hay enfermedad y exigirlos
            obligaría a inventar (ADR 0003). El tiempo va con el motivo, como se escribe la anamnesis. */}
        <draftForm.AppField name="illnessDuration">
          {(field) => (
            <field.Control label="Tiempo de enfermedad (opcional)" id={`${uid}-illness-duration`}>
              {(control) => (
                <Input
                  {...control.props}
                  value={field.state.value}
                  disabled={locked}
                  maxLength={200}
                  placeholder="Ej.: 3 días"
                  onChange={(event) => {
                    field.handleChange(event.target.value)
                    rememberText("illnessDuration", event.target.value)
                  }}
                />
              )}
            </field.Control>
          )}
        </draftForm.AppField>
      </div>
      {showIllness ? (
        <draftForm.AppField name="presentIllness">
          {(field) => (
            <field.Control label="Relato de la enfermedad (opcional)" id={`${uid}-present-illness`}>
              {(control) => (
                <Textarea
                  {...control.props}
                  rows={3}
                  value={field.state.value}
                  disabled={locked}
                  maxLength={4000}
                  placeholder="Cómo empezó y siguió, qué lo alivia o empeora, qué tomó…"
                  onChange={(event) => {
                    field.handleChange(event.target.value)
                    rememberText("presentIllness", event.target.value)
                  }}
                />
              )}
            </field.Control>
          )}
        </draftForm.AppField>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="self-start"
          disabled={locked}
          onClick={() => {
            setIllnessOpen(true)
            requestAnimationFrame(() => document.getElementById(`${uid}-present-illness`)?.focus())
          }}
        >
          + Relato de la enfermedad
        </Button>
      )}
      {/* La sede solo se elige si hay más de una o la atención no tiene ninguna. */}
      {branches.length > 1 || !encounter.branchId || branchError || branchesQuery.isError ? (
        <Field
          data-invalid={branchError || branchesQuery.isError ? true : undefined}
          className="sm:max-w-sm"
        >
          <FieldLabel htmlFor={`${uid}-branch`}>Sede de la atención</FieldLabel>
          <ChoiceSelect
            id={`${uid}-branch`}
            disabled={locked || branchesQuery.isPending}
            aria-invalid={branchError || branchesQuery.isError ? true : undefined}
            aria-describedby={
              branchError || branchesQuery.isError ? `${uid}-branch-error` : undefined
            }
            value={encounter.branchId ?? ""}
            onChange={async (event) => {
              const branchId = event.target.value || null
              setBranchError(null)
              handlePendingChange(true)
              try {
                await flush()
                await apiFetch(`/api/patients/${patientId}/encounters/${encounterId}`, {
                  method: "PATCH",
                  body: JSON.stringify({ branchId }),
                })
                await onChanged()
              } catch (err) {
                setBranchError(submitErrorMessage(err))
              } finally {
                handlePendingChange(false)
              }
            }}
          >
            <option value="">Sin sede asignada</option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </ChoiceSelect>
          {branchError || branchesQuery.isError ? (
            <FieldError id={`${uid}-branch-error`}>
              {branchError ?? "No se pudieron cargar las sedes."}
            </FieldError>
          ) : null}
        </Field>
      ) : null}
      {productUi().site && teeth.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Piezas de esta atención</span>
          {teeth.map((tooth) => (
            <Button
              key={tooth}
              type="button"
              size="sm"
              variant="outline"
              disabled={locked}
              aria-label={`Quitar pieza ${tooth} de la atención`}
              onClick={() => editTeeth(teeth.filter((value) => value !== tooth))}
            >
              {tooth} ×
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )

  const examenBody = (
    <div className="grid gap-3 sm:grid-cols-2">
      {/* Sin signos vitales en el producto (vistIA), sin su apartado. */}
      {exam.vitals.length > 0 ? (
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0 sm:col-span-2">
        <legend className="mb-1 text-sm font-medium">Signos vitales</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {VITAL_SIGNS.filter((sign) => exam.vitals.includes(sign.key)).map((sign) => (
            <draftForm.AppField key={sign.key} name={`vitals.${sign.key}`}>
              {(field) => (
                <field.Control
                  label={
                    <span className="text-xs">
                      {sign.label} ({sign.suffix})
                    </span>
                  }
                  id={`${uid}-vital-${sign.key}`}
                >
                  {(control) => (
                    <Input
                      {...control.props}
                      inputMode="decimal"
                      value={field.state.value ?? ""}
                      disabled={locked}
                      onChange={(event) => {
                        const value = event.target.value.replace(",", ".")
                        field.handleChange(value)
                        rememberVital(sign.key, value)
                      }}
                    />
                  )}
                </field.Control>
              )}
            </draftForm.AppField>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          La presión se registra completa (sistólica y diastólica).
        </p>
        <exam.VitalsNote patientId={patientId} encounterId={encounterId} vitals={parsedVitals} />
      </fieldset>
      ) : null}
      <exam.Fields
        idPrefix={uid}
        draft={examination}
        onChange={editExamination}
        disabled={locked}
        errors={examErrors}
      />
    </div>
  )

  const evolucionBody = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        {/* Primero la evolución, que es lo que pide el cierre; después lo que se le indica y, al final, el pronóstico. */}
        <draftForm.AppField name="evolution">
          {(field) => (
            <field.Control
              label="Evolución"
              description="Lo que se hizo hoy y cómo respondió; en una primera consulta, el plan y lo que se le explicó."
              id={`${uid}-evolution`}
            >
              {(control) => (
                <Textarea
                  {...control.props}
                  aria-required
                  rows={3}
                  value={field.state.value}
                  disabled={locked}
                  maxLength={MAX_EVOLUTION}
                  placeholder="Evolución clínica…"
                  onChange={(event) => {
                    field.handleChange(event.target.value)
                    rememberText("evolution", event.target.value)
                  }}
                />
              )}
            </field.Control>
          )}
        </draftForm.AppField>
        <draftForm.AppField name="indications">
          {(field) => (
            <field.Control label="Indicaciones" id={`${uid}-indications`}>
              {(control) => (
                <Textarea
                  {...control.props}
                  rows={2}
                  value={field.state.value}
                  disabled={locked}
                  maxLength={MAX_INDICATIONS}
                  placeholder="Indicaciones para el paciente…"
                  onChange={(event) => {
                    field.handleChange(event.target.value)
                    rememberText("indications", event.target.value)
                  }}
                />
              )}
            </field.Control>
          )}
        </draftForm.AppField>
      </div>
    </div>
  )

  const prognosisBody = (
    <draftForm.AppField name="prognosis">
      {(field) => (
        <field.Control label="Pronóstico" id={`${uid}-prognosis`}>
          {(control) => (
            <Textarea
              {...control.props}
              rows={2}
              value={field.state.value}
              disabled={locked}
              maxLength={2000}
              onChange={(event) => {
                field.handleChange(event.target.value)
                rememberText("prognosis", event.target.value)
              }}
            />
          )}
        </field.Control>
      )}
    </draftForm.AppField>
  )

  /** El último diagnóstico de hoy con pieza: indicar empieza con esa pieza, su hallazgo y su diagnóstico. */
  const lastDiagnosis = [...activeDiagnosisRows].reverse().find((dx) => dx.toothNumber != null)
  // El hallazgo de esa pieza como uno solo (sus caras juntas): se vincula por su primera fila, como el panel de la pieza.
  const lastFinding = lastDiagnosis
    ? groupFindings((detail.odontogramEntries ?? []).filter((entry) => !entry.voidedAt))
        .reverse()
        .find((group) => group.first.toothNumber === lastDiagnosis.toothNumber)?.first
    : undefined
  // Su diagnóstico ya lleva su tratamiento hoy (la pulpitis, su endodoncia): lo que se indique
  // después en esa pieza (la corona) no lo hereda; lo elige quien indica (QA del 9 nov).
  const diagnosisUsed =
    !!lastDiagnosis &&
    liveIndicated.some(
      (item) => item.toothNumber === lastDiagnosis.toothNumber && item.diagnosisCode === lastDiagnosis.diagnosisCode,
    )
  const indicationDefaults =
    lastDiagnosis?.toothNumber != null
      ? {
          scope: "tooth",
          teeth: [lastDiagnosis.toothNumber],
          odontogramEntryId: lastFinding?.id ?? "",
          diagnosisCode: diagnosisUsed ? "" : lastDiagnosis.diagnosisCode,
        }
      : undefined
  const removableIds = new Set(
    detail.indicatedItems.filter((item) => item.removable).map((item) => item.id),
  )

  /** Las sugerencias del dictado de una parte, debajo de lo suyo. */
  const suggestionsOf = (key: SectionKey) =>
    (dictationOf(key)?.kinds ?? []).map((kind) => (
      <DictationBlockSuggestions
        key={kind}
        session={dictation}
        kind={kind}
        patientName={patient.patient.displayName}
      />
    ))
  const sectionClass = "flex scroll-mt-4 flex-col gap-3 rounded-sm bg-card p-6 max-sm:px-4"
  /** Una parte de la atención con su título; el contenido se edita en su sitio. */
  const block = (
    key: string,
    title: string,
    children: React.ReactNode,
    aside?: React.ReactNode,
  ) => (
    <section
      key={key}
      id={`${uid}-${key}`}
      aria-labelledby={`${uid}-${key}-titulo`}
      className={sectionClass}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${uid}-${key}-titulo`} className="font-heading text-base font-medium">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  )
  // latidIA no tiene «dónde»: su examen físico y signos vitales son de todos los días y van siempre a la vista.
  const examAlways = !productUi().site
  const examHasData =
    examination !== null || Object.values(vitals).some((value) => value.trim() !== "")
  const showExam =
    examAlways || examHasData || extras.has("examen") || dictationCount("examen") > 0 || dictationRemoved("examen")
  const showPrognosis = draftValues.prognosis.trim() !== "" || extras.has("pronostico")
  // Los bloques del producto: el odontograma, siempre; lo demás (el periodontograma), en «También» hasta que tenga algo.
  const everyday = product.blocks.filter((item) => item.key === "odontograma")
  const optional = product.blocks.filter((item) => item.key !== "odontograma")
  const shownOptional = optional.filter(
    (item) =>
      !item.empty || extras.has(item.key) || dictationCount(item.key) > 0 || dictationRemoved(item.key),
  )
  const also = [
    ...(showExam ? [] : [{ key: "examen", title: exam.title }]),
    ...(showPrognosis ? [] : [{ key: "pronostico", title: "Pronóstico" }]),
    ...optional
      .filter((item) => !shownOptional.includes(item))
      .map((item) => ({ key: item.key, title: item.title })),
  ]

  const registrationFields = needsRegistration ? (
    <SignatureRegistrationFields
      form={closingForm}
      signAs={profileQuery.data?.data.signatureName ?? profileQuery.data?.data.accountName ?? null}
      askTitle={!profileQuery.data?.data.professionalTitle}
      disabled={finalizing}
      numberRef={registrationNumberRef}
    />
  ) : null
  const signatureHint = profileQuery.isSuccess ? (
    <ClosingSignatureHint
      saved={Boolean(profileQuery.data.data.signatureStrokes)}
      onEdit={() => {
        setConfirmOpen(false)
        setProfileForSignature(true)
        setProfileOpen(true)
      }}
    />
  ) : null
  // Con quién se firma: lo mismo con o sin sugerencias pendientes (la hora de fin va en el cierre).
  const signFields = registrationFields ?? (
    <div className="text-sm">
      <p>
        Firmarás como <strong>{signAs.text ?? "—"}</strong>
      </p>
      {signatureHint}
    </div>
  )
  const age = ageFrom(patient.patient.birthDate)
  // «Guardado 10:21» / «Guardando…» / «Sin conexión»: siempre a la vista.
  const saveChip =
    saveState === "offline"
      ? { text: "Sin conexión", tone: "border-warning/40 bg-warning-soft text-warning" }
      : saveState === "saving" || saveState === "pending"
        ? { text: "Guardando…", tone: "" }
        : saveState === "error"
          ? { text: "No se guardó", tone: "border-destructive/40 text-destructive" }
          : { text: `Guardado ${formatClock(savedAt)}`, tone: "border-success/40 bg-success-soft text-success" }
  // Pie fijo: lo que falta y «Finalizar y firmar», también en la tablet y el teléfono. Mientras
  // se guarda o se comprueba, dice por qué aún no se firma: la lista de faltantes podría estar vieja.
  const footerWait =
    signBlockedReason ?? (closingQuery.isSuccess && closingQuery.isFetching ? "Comprobando lo que falta…" : null)
  const footerMissing =
    !dictation.busy && !footerWait && closingQuery.isSuccess && !onlyRegistrationMissing && !closingReady
      ? CLOSING_ORDER.filter((requirement) => missing.includes(requirement))
      : []
  const footerText = dictation.busy
    ? "Termina el dictado para poder firmar"
    : footerWait
      ? footerWait
      : !closingQuery.isSuccess
      ? "Comprobando lo que falta…"
      : onlyRegistrationMissing
        ? "Listo para firmar · falta tu colegiatura, se pide al firmar"
        : !closingReady
          ? `${missing.length === 1 ? "Falta 1" : `Faltan ${missing.length}`} para cerrar: ${listWords(missing.map((m) => CLOSING_SHORT[m]))}`
        : missingConsentSignatures > 0
          ? `Listo para firmar · falta${missingConsentSignatures === 1 ? "" : "n"} ${missingConsentSignatures} firma${missingConsentSignatures === 1 ? "" : "s"} de ${signer}`
          : unsignedConsents.length > 0
            ? "Listo para firmar · falta confirmar lo que firmó en su enlace"
            : "Listo para firmar"

  return (
    <div
      className={cn(
        "flex flex-col gap-4 pb-20",
        dictationMobileBarVisible(dictation) && "max-sm:pb-20",
      )}
    >
      <PatientClinicalStrip detail={patient} onAntecedentes={() => setContextOpen(true)} />
      {/* Encabezado estándar: el disparador en el teléfono, el nombre, las utilidades y ⋯. Lo demás va en la fila de contexto. */}
      <PageHeader
        title={patient.patient.displayName}
        subtitle={
          <>
            <EncounterBreadcrumb patientId={patientId} patientName={patient.patient.displayName} />
            <span>
              {[
                age !== "" ? `${age} ${Number(age) === 1 ? "año" : "años"}` : null,
                hcLabel(patient.patient.patientNumber),
                // La hora de la cita no viaja en la atención: se dice que viene de ella y cuándo empezó.
                encounter.appointmentId ? "desde su cita" : null,
                encounter.startedAt ? openSinceWords(encounter.startedAt) : null,
                memberName(encounter.professionalUserId),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span
              role="status"
              aria-live="polite"
              className={cn("rounded-full border px-3 py-1 text-xs font-medium", saveChip.tone)}
            >
              {saveChip.text}
            </span>
            <Button type="button" size="sm" variant="outline" onClick={() => setContextOpen(true)}>
              Antecedentes y última atención
            </Button>
            {attending ? (
              <DictationHeaderButton
                session={dictation}
                onStart={startDictation}
                onType={() => setDictationTyping(true)}
              />
            ) : null}
          </>
        }
      />
      {saveState === "offline" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Sin conexión: lo escrito se queda en la pantalla y se guarda al volver. Mientras tanto no se puede firmar.
        </p>
      ) : null}

      {/* Quien cubre a otro lo lee en la atención: «Atiendes la cita de la Dra. Ana Torres». */}
      <AttendingForNotice
        appointmentId={encounter.appointmentId ?? null}
        encounterProfessionalUserId={encounter.professionalUserId}
      />

      <DeclaredQuestionnaireNotice patientId={patientId} patient={patient} disabled={locked} />

      {/* Lo que firmó en su enlace se confirma aquí, delante de la persona: arriba al abrir, sin frenar nada. */}
      <LinkSignedNotice
        patientId={patientId}
        encounterId={encounterId}
        disabled={locked}
        onChanged={async () => {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["consent-needs", patientId, encounterId] }),
            refreshClosing(),
          ])
          await onChanged()
        }}
      />

      {attending ? <EncounterHealthReview patientId={patientId} patient={patient} disabled={locked} /> : null}
      {/* La alergia dictada (o «niega alergias») va donde se pide revisarlas, junto a las alertas (issue 109). */}
      {attending ? <DictationBlockSuggestions session={dictation} kind="alergia" /> : null}

      {canWrite && !attending ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4"
        >
          <p className="text-sm">
            Esta atención la lleva {memberName(encounter.professionalUserId)}. Puedes leerla; para
            continuarla y firmarla, toma el relevo (queda registrado).
          </p>
          <Button type="button" disabled={takingOver} onClick={() => void handleTakeOver()}>
            {takingOver ? "Tomando el relevo…" : "Tomar el relevo"}
          </Button>
        </div>
      ) : null}

      {childCount > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          Registrando dato vinculado…
        </p>
      )}
      {saveError && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span>{saveError}</span>
          {saveState === "error" ? (
            <Button type="button" size="sm" variant="outline" onClick={() => void drain().catch(() => {})}>
              Reintentar
            </Button>
          ) : null}
        </div>
      )}
      {!canWrite && (
        <p className="text-sm text-muted-foreground">
          Solo lectura: no tienes permiso para editar este borrador.
        </p>
      )}

      <DictationPanel
        session={dictation}
        onStart={startDictation}
        onFinish={finishDictation}
        onShowTranscript={showTranscript}
        typing={dictationTyping}
        onTypingChange={setDictationTyping}
      />

      <MasterDetail
        panelSize="xl"
        // El pie fijo no tapa el último bloque: abajo queda reservado su alto.
        className={canWrite && attending ? "pb-28 sm:pb-20" : undefined}
        panel={
          mode === "panel"
            ? ((contextOpen ? <DetailPanel {...contextSurface} /> : null) ??
              (transcriptOpen && dictation.enabled ? <DetailPanel {...transcriptSurface} /> : null))
            : null
        }
      >
        <div className="flex flex-col gap-4">
          {canWrite && attending ? (
            <div id={`${uid}-visita`} className="scroll-mt-4">
              <EncounterVisitStrip
                patientId={patientId}
                encounterId={encounterId}
                visit={detail.visit}
                offeredReason={offeredReason}
                onUseReason={takeOfferedReason}
                reasonEmpty={reason.trim() === ""}
                onUrgency={() => {
                  if (reason.trim() === "") editText("reason", "Urgencia: ")
                  requestAnimationFrame(() => {
                    const field = document.getElementById(
                      `${uid}-reason`,
                    ) as HTMLTextAreaElement | null
                    field?.focus()
                    field?.setSelectionRange(field.value.length, field.value.length)
                  })
                }}
                disabled={locked}
                beforeWrite={flush}
                onChanged={handleChildChanged}
                onPendingChange={handlePendingChange}
              />
            </div>
          ) : null}

          {block(
            "consulta",
            "Consulta",
            <>
              {consultaBody}
              {suggestionsOf("consulta")}
            </>,
          )}

          {showExam
            ? block(
                "examen",
                exam.title,
                <>
                  {examenBody}
                  {suggestionsOf("examen")}
                </>,
              )
            : null}

          {everyday.map((item) =>
            block(
              item.key,
              item.title,
              <>
                {item.content}
                {suggestionsOf(item.key)}
              </>,
            ),
          )}

          <div id={`${uid}-diagnostico`} className="flex scroll-mt-4 flex-col gap-3">
            <EncounterDiagnoses
              patientId={patientId}
              detail={detail}
              disabled={locked}
              beforeWrite={flush}
              onChanged={handleChildChanged}
              onPendingChange={handlePendingChange}
              openSignal={diagnosisAsk}
              prefill={diagnosisPrefill}
              onPrefillUsed={() => setDiagnosisPrefill(null)}
            />
            {suggestionsOf("hallazgos")}
          </div>

          {block(
            "realizado",
            "Realizado hoy",
            <>
              <EncounterTreatments
                patientId={patientId}
                encounterId={encounterId}
                items={detail.plannedItems}
                sessionItemIds={sessionItemIds}
                onRegisterSession={(itemId) => setSessionPrefill(itemId)}
                disabled={locked}
                beforeWrite={flush}
                onChanged={() => void handleChildChanged()}
              />
              <EncounterProcedures
                patientId={patientId}
                detail={detail}
                disabled={locked}
                beforeWrite={flush}
                onChanged={handleChildChanged}
                onPendingChange={handlePendingChange}
                prefillPlanItemId={sessionPrefill}
                onPrefillUsed={() => setSessionPrefill(null)}
              />
              {suggestionsOf("procedimientos")}
            </>,
          )}

          {block(
            "plan",
            "Plan",
            <>
              <EncounterPlanPanel
                patientId={patientId}
                encounterId={encounterId}
                indicatedItems={detail.indicatedItems}
                attentionItems={attentionItems}
                disabled={locked}
                patientName={patient.patient.displayName}
                beforeWrite={flush}
                onChanged={handleChildChanged}
                onPendingChange={handlePendingChange}
                removableIds={removableIds}
                indicationDefaults={indicationDefaults}
                showControls={followUps.length > 0}
              />
              {suggestionsOf("plan")}
            </>,
          )}

          {block(
            "documentos",
            "Documentos",
            <>
              <EncounterDocumentsBlock
                patientId={patientId}
                encounterId={encounterId}
                patient={patient}
                detail={detail}
                encounters={encountersQuery.data?.data ?? []}
                attentionItems={attentionItems}
                disabled={locked}
                beforeWrite={flush}
                onChanged={handleChildChanged}
                onPendingChange={handlePendingChange}
                openMenu={false}
              />
              {suggestionsOf("documentos")}
            </>,
          )}

          {block("evolucion", "Evolución e indicaciones", evolucionBody)}

          {showPrognosis ? block("pronostico", "Pronóstico", prognosisBody) : null}

          {shownOptional.map((item) =>
            block(
              item.key,
              item.title,
              <>
                {item.content}
                {suggestionsOf(item.key)}
              </>,
            ),
          )}

          {also.length > 0 && canWrite && attending ? (
            <section
              aria-label="También"
              className="flex flex-wrap items-center gap-2 px-1 text-sm"
            >
              <span className="text-muted-foreground">También:</span>
              {also.map((item) => (
                <Button
                  key={item.key}
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Agregar ${item.title}`}
                  onClick={() => {
                    openExtra(item.key)
                    requestAnimationFrame(() => goTo(`${uid}-${item.key}`))
                  }}
                >
                  + {item.title}
                </Button>
              ))}
            </section>
          ) : null}

          <section
            id={closingId}
            aria-label="Cierre de la atención"
            className="flex scroll-mt-4 flex-col gap-4 rounded-sm bg-card p-6"
          >
            <div className="flex flex-col gap-1">
              <h2 className="font-heading text-base font-medium">Cierre de la atención</h2>
              <p className="text-sm text-muted-foreground">
                Al cerrar se firma con tu colegiatura y la atención queda inmutable: después solo se
                agregan adendas.
              </p>
            </div>
            {/* Solo lo que falta, cada cosa con su «Registrar»; sin nada pendiente, «Lista para firmar». */}
            {closingQuery.isSuccess ? (
              missing.length > 0 ? (
                <ul className="flex flex-col gap-1.5 text-sm" aria-label="Lo que falta para firmar">
                  {CLOSING_ORDER.filter((requirement) => missing.includes(requirement)).map(
                    (requirement) => (
                      // El «!» va con su texto: en un teléfono angosto el texto envuelve a su lado, no debajo.
                      <li key={requirement} className="flex items-start gap-2">
                        <span
                          aria-hidden="true"
                          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-warning-soft text-xs font-bold text-warning"
                        >
                          !
                        </span>
                        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="min-w-0">
                            {requirement === "diagnosis" && pendingDiagnoses > 0
                              ? pendingDiagnoses === 1
                                ? "Diagnóstico: hay uno sugerido, sin confirmar"
                                : `Diagnóstico: hay ${pendingDiagnoses} sugeridos, sin confirmar`
                              : CLOSING_REQUIREMENT_LABELS[requirement]}
                            {/* El motivo que trae la cita se usa aquí mismo, en un toque. */}
                            {requirement === "reason" && offeredReason ? (
                              <span className="text-muted-foreground">
                                {" "}
                                · de la cita: «{offeredReason}»
                              </span>
                            ) : null}
                          </span>
                          {requirement === "reason" && offeredReason ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="link"
                              className="h-auto p-0"
                              disabled={locked}
                              aria-label={`Usar «${offeredReason}» como motivo`}
                              onClick={takeOfferedReason}
                            >
                              Usar
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="sm"
                            variant="link"
                            className="h-auto p-0"
                            disabled={!attending}
                            onClick={() => requireBlock(requirement)}
                          >
                            {requirement === "signature"
                              ? "Completar perfil"
                              : requirement === "reason" && offeredReason
                                ? "Escribir otro"
                                : "Registrar"}
                          </Button>
                        </span>
                      </li>
                    ),
                  )}
                </ul>
              ) : (
                <p className="flex items-center gap-2 text-sm">
                  <span
                    aria-hidden="true"
                    className="inline-flex size-5 items-center justify-center rounded-full bg-success-soft text-xs font-bold text-success"
                  >
                    ✓
                  </span>
                  Lista para firmar
                </p>
              )
            ) : null}
            {unsignedConsents.length > 0 ? (
              <ul className="flex flex-col gap-1.5 text-sm" aria-label="Consentimientos sin firmar">
                {unsignedConsents.map((need) => (
                  <li
                    key={`${need.templateKey}-${need.documentId ?? ""}`}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex size-5 items-center justify-center rounded-full bg-warning-soft text-xs font-bold text-warning"
                    >
                      !
                    </span>
                    <span>
                      {need.status === "sin_publicar"
                        ? `Esta clínica aún no activó el consentimiento de «${need.title}»`
                        : need.personSigned
                          ? `Lo firmó desde su enlace, falta confirmarlo: «${need.title}»`
                          : `Consentimiento sin firmar: «${need.title}»`}
                      <span className="sr-only">: no impide cerrar; el cierre pide el motivo</span>
                    </span>
                    {need.status !== "sin_publicar" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="link"
                        className="h-auto p-0"
                        disabled={!attending || locked}
                        onClick={() => void signConsentsNow(need)}
                      >
                        {need.personSigned ? "Confirmar" : "Firmar ahora"}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {closingQuery.isError ? (
              <p role="alert" className="text-sm text-destructive">
                No se pudo comprobar lo que falta para cerrar.
              </p>
            ) : null}
            <div className="flex flex-col gap-2 text-sm">
              {/* Solo lo que hay: «1 diagnóstico · 2 hallazgos», sin «0 …» ni «(s)». */}
              {(() => {
                const done = [
                  activeProcedures > 0
                    ? counted(activeProcedures, "procedimiento", "procedimientos")
                    : "",
                  activeDiagnoses > 0
                    ? counted(activeDiagnoses, "diagnóstico", "diagnósticos")
                    : "",
                  // Una caries de varias caras es un hallazgo.
                  findingGroups > 0
                    ? counted(
                        findingGroups,
                        "hallazgo en el odontograma",
                        "hallazgos en el odontograma",
                      )
                    : "",
                  detail.documents.length > 0
                    ? counted(detail.documents.length, "documento", "documentos")
                    : "",
                  pendingTreatments > 0
                    ? `${counted(pendingTreatments, "tratamiento", "tratamientos")} por ejecutar`
                    : "",
                ].filter(Boolean)
                return done.length > 0 ? (
                  <p className="text-muted-foreground">{done.join(" · ")}</p>
                ) : null
              })()}
              {canReadFinance ? (
                accountQuery.isSuccess ? (
                  <p className="font-medium">
                    {chargeableText
                      ? `Cargos nuevos al cerrar: ${chargeableText}. El cierre vuelve a comprobar lo ya cobrado.`
                      : "Sin cargos nuevos: actos sin costo o tratamientos ya cargados."}
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    {accountQuery.isError
                      ? "No se pudo consultar la cuenta para estimar los cargos."
                      : "Consultando cargos existentes…"}
                  </p>
                )
              ) : (
                <p className="text-muted-foreground">
                  Los actos con precio generan sus cargos al cerrar; caja los gestiona.
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
              <Button
                type="button"
                variant="ghost"
                className="text-destructive"
                disabled={locked}
                onClick={() => setVoidOpen(true)}
              >
                Anular esta atención…
              </Button>
            </div>
            {dictation.busy ? (
              <p className="text-xs text-muted-foreground">
                Termina el dictado y revisa las sugerencias para poder firmar.
              </p>
            ) : dictationPending > 0 ? (
              <p className="text-xs text-muted-foreground">
                Si quedan sugerencias sin revisar, te lo pregunta antes de firmar.
              </p>
            ) : null}
          </section>
        </div>
      </MasterDetail>

      {/* Pie fijo: lo que falta y «Finalizar y firmar», en escritorio, tablet y teléfono. */}
      {canWrite && attending ? (
        <div
          className={cn(
            "sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border",
            // En el teléfono, mientras se dicta, el pie es la barra del dictado (que también firma).
            dictationMobileBarVisible(dictation) && "max-sm:hidden",
          )}
        >
          <span id={`${uid}-footer`} className="text-sm text-muted-foreground">
            {footerMissing.length > 0 ? (
              // Cada cosa que falta lleva a su bloque, como «Registrar» en el cierre.
              <>
                {footerMissing.length === 1 ? "Falta 1" : `Faltan ${footerMissing.length}`} para cerrar:{" "}
                {footerMissing.map((requirement, index) => (
                  <span key={requirement}>
                    {index === 0 ? "" : index === footerMissing.length - 1 ? " y " : ", "}
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 align-baseline text-sm"
                      disabled={!attending}
                      onClick={() => requireBlock(requirement)}
                    >
                      {CLOSING_SHORT[requirement]}
                    </Button>
                  </span>
                ))}
              </>
            ) : (
              footerText
            )}
          </span>
          <Button type="button" disabled={!canSign} aria-describedby={`${uid}-footer`} onClick={requestSign}>
            Finalizar y firmar
          </Button>
        </div>
      ) : null}

      {mode === "drawer" ? <DetailDrawer open={contextOpen} {...contextSurface} /> : null}

      {mode === "drawer" && dictation.enabled ? (
        <DetailDrawer open={transcriptOpen} {...transcriptSurface} />
      ) : null}
      <DictationEditDrawer session={dictation} />
      <DictationMobileBar
        session={dictation}
        onShowTranscript={showTranscript}
        onFinish={finishDictation}
        onSign={signFromBar}
      />

      <EncounterClosingDialog
        open={confirmOpen && !confirmWithDictation && signingDocs === null}
        form={closingForm}
        signAs={signAs.text}
        who={signer}
        consents={unsignedConsents}
        closing={closingQuery.data?.data ?? null}
        materials={closingQuery.data?.data.materials ?? null}
        healthGaps={healthGaps}
        onCompleteHealth={
          openWide
            ? () => {
                setConfirmOpen(false)
                openWide({ id: "antecedentes", review: true })
              }
            : undefined
        }
        missing={missing}
        onRegister={(requirement) => {
          setConfirmOpen(false)
          requireBlock(requirement)
        }}
        onOpenBlock={(key) => {
          setConfirmOpen(false)
          setContextOpen(false)
          openExtra(key)
          requestAnimationFrame(() => goTo(`${uid}-${key}`))
        }}
        startedAt={encounter.startedAt}
        pending={finalizing}
        canSign={canSign}
        blockedReason={signBlockedReason}
        registration={registrationFields}
        confirmLabel={needsRegistration ? "Guardar y firmar" : null}
        initialFocus={needsRegistration ? registrationNumberRef : undefined}
        onSignNow={(need) => void signConsentsNow(need)}
        onClose={() => {
          if (!finalizing) setConfirmOpen(false)
        }}
        signatureHint={signatureHint}
        sessionLabel={sessionLabelOf}
        sessionAnswers={sessionAnswers}
        onSessionAnswer={answerSession}
        keepDiagnoses={keepDiagnoses}
        onKeepDiagnosis={keepDiagnosis}
        nextVisit={
          <ClosingNextVisit
            form={closingForm}
            controls={closingControls}
            busy={finalizing}
            continuing={continuingVisits}
            canBook={canBook}
          />
        }
      >
        {finalizeDescription ? <p className="text-xs text-muted-foreground">{finalizeDescription}</p> : null}
      </EncounterClosingDialog>
      {product.overlay}
      <ConsentSigningScreen
        open={signingDocs !== null}
        documents={signingDocs ?? []}
        patientId={patientId}
        onClose={() => setSigningDocs(null)}
        onSigned={async () => {
          await refreshClosing()
          await onChanged()
        }}
      />
      <DictationSignDialog
        open={confirmOpen && confirmWithDictation}
        session={dictation}
        signing={finalizing}
        error={closingError}
        onClose={() => setConfirmOpen(false)}
        onComplete={(id) => openSuggestion(id)}
        nextVisit={(marked) => (
          <ClosingNextVisit
            form={closingForm}
            controls={closingControls}
            dictated={dictatedControl(marked)}
            busy={finalizing}
            continuing={continuingVisits}
            canBook={canBook}
          />
        )}
        onSign={(ids) => {
          // Un solo envío: la colegiatura se valida en su campo, luego se confirma lo marcado y se firma.
          signIdsRef.current = ids
          void submitForm(closingForm, {
            fieldMap: CLOSING_FIELD_MAP,
            root: document.querySelector('[role="alertdialog"]'),
          })
        }}
      >
        {signFields}
        {closingQuery.data?.data.sessions ? (
          <ClosingSessions
            sessions={closingQuery.data.data.sessions}
            labelOf={sessionLabelOf}
            answers={sessionAnswers}
            onAnswer={answerSession}
            disabled={finalizing}
            resolvable={closingQuery.data.data.resolvable}
            keepDiagnoses={keepDiagnoses}
            onKeepDiagnosis={keepDiagnosis}
          />
        ) : null}
      </DictationSignDialog>

      {/* Cierre de la atención: qué quedó por cobrar y qué no, con su porqué. */}
      <Dialog
        open={finalizedBilling !== null}
        onOpenChange={(next) => {
          if (!next) closeFinalized()
        }}
      >
        <DialogContent showCloseButton={false} aria-label="Atención finalizada">
          <DialogHeader>
            <DialogTitle>Atención finalizada</DialogTitle>
            <DialogDescription>
              {/* «No dejó nada que cobrar» se leía como que no debía nada (QA del 9 nov). */}
              {/* Lo que dice tiene que seguir siendo cierto después de cobrar aquí mismo (entrega 8). */}
              {chargedLines.length === 0
                ? "Hoy no se carga nada."
                : finalizedPaidUp
                  ? "Pagado: no debe nada."
                  : "Caja ya lo ve en su lista de por cobrar."}
            </DialogDescription>
          </DialogHeader>
          {finalizedNext.length > 0 ? (
            <FinalizedNextSessions
              sessions={finalizedNext}
              labelOf={(session) => sessionLabelOf({ planItemId: session.planItemId, title: session.title, n: 0, m: 0 })}
              listRef={nextSessionsRef}
              canBook={canBook}
              onBook={(ids) => setBookingNext(ids)}
              nameOf={(userId) => members.find((item) => item.userId === userId)?.user.name}
            />
          ) : null}
          {/* Encima del aviso, dentro de él: al cerrarlo el foco vuelve a «Reservar la sesión 2». */}
          {bookingNext ? (
            <BookingHere
              seed={{
                patient: { id: patientId, name: patient.patient.displayName },
                lockedPatient: true,
                planItemIds: bookingNext,
                ...(finalizedNext.find((session) => session.planItemId === bookingNext[0])?.serviceId
                  ? { serviceId: finalizedNext.find((session) => session.planItemId === bookingNext[0])?.serviceId ?? undefined }
                  : {}),
                // La sesión siguiente suele hacerla quien atendió hoy: su columna, que se puede cambiar.
                professionalUserId: encounter.professionalUserId,
                professionalLabel: memberName(encounter.professionalUserId),
                keepProfessional: true,
                // La sesión que sigue no es hoy: el buscador empieza mañana (QA del 9 nov
                // proponía «Reservar hoy a las 11:30»); hoy queda a una flecha. Con el control de lo
                // que terminó hoy en la misma cita (la corona y el control de su endodoncia, como en
                // «Qué sigue»), desde que ese control se puede hacer (repaso del 9 nov, N6).
                date: [
                  addDays(zonedDateOf(new Date().toISOString(), activeOrgTimeZone()), 1),
                  finalizedControls?.next?.joinsNext?.from ?? "",
                ].sort()[1]!,
                ...(finalizedControls?.next?.joinsNext
                  ? {
                      followUpIds: [finalizedControls.next.id],
                      // Por qué empieza ese día, como en «Qué sigue» (QA antes de entregar).
                      note: `${finalizedControls.next.title} toca el ${controlDaySaid(
                        new Intl.DateTimeFormat("en-CA", { timeZone: activeOrgTimeZone() }).format(new Date(finalizedControls.next.dueAt)),
                      )}; se puede hacer desde el ${controlDaySaid(finalizedControls.next.joinsNext.from)}.`,
                      notBefore: finalizedControls.next.joinsNext.from,
                    }
                  : {}),
              }}
              onClose={() => setBookingNext(null)}
              onSaved={(appointment) => {
                // Lo que la cita de verdad lleva (lo que el servidor devolvió), no lo que se pidió.
                const carried = new Map((appointment.sessions ?? []).map((session) => [session.planItemId, session]))
                setFinalizedNext((current) =>
                  current.map((session) => {
                    const booked = carried.get(session.planItemId)
                    return booked
                      ? {
                          ...session,
                          booked: {
                            appointmentId: appointment.id,
                            startsAt: appointment.startsAt,
                            professionalUserId: appointment.professionalUserId,
                            professionalName: appointment.professionalName,
                            n: booked.n,
                            m: booked.m,
                          },
                          toBook: null,
                        }
                      : session
                  }),
                )
                // El foco va a lo reservado: el botón que lo abrió ya no está.
                requestAnimationFrame(() => nextSessionsRef.current?.focus())
              }}
            />
          ) : null}
          {chargedLines.length > 0 ? (
            // Lo que se cargó hoy no cambia al cobrar; lo que debe sí: por eso «Se cargó hoy» y no
            // «Quedó por cobrar», que tras un pago parcial decía S/ 450 junto a «Debe S/ 200»
            // (repaso del 9 nov, N2). El único total es «Debe en total», de la cuenta.
            <section className="flex flex-col gap-2" aria-label="Se cargó hoy a su cuenta">
              <h3 className="text-sm font-semibold">Se cargó hoy a su cuenta</h3>
              <ul className="flex flex-col gap-1">
                {chargedLines.map((line) => (
                  <li key={line.procedureId} className="flex items-baseline justify-between gap-3 text-sm">
                    <span>{line.description}</span>
                    <span className="tabular-nums">
                      {line.currency && orgLocale && line.amountCents != null
                        ? formatMoney(line.amountCents, line.currency, orgLocale)
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
              {finalizedBilling?.currency && orgLocale && chargedLines.length > 1 ? (
                <p className="flex items-baseline justify-between gap-3 border-t pt-2 text-sm font-semibold">
                  <span>Total de hoy</span>
                  <span className="tabular-nums">
                    {moneyTotalsText(
                      finalizedBilling.totals?.length
                        ? finalizedBilling.totals
                        : [{ currency: finalizedBilling.currency, totalCents: finalizedBilling.chargedCents }],
                      (cents, currency) => formatMoney(cents, currency, orgLocale),
                      "",
                    )}
                  </span>
                </p>
              ) : null}
            </section>
          ) : null}
          {/* Lo que debe en total, con lo de antes (la sesión 1 de la endodoncia), y «Cobrar» a
              quien cobra: solo quien ve la caja (QA del 9 nov; el odontólogo no la ve). */}
          {canReadFinance && !accountQuery.isFetching && finalizedOwed.length > 0 && orgLocale ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
              <span>
                Debe en total{" "}
                <span className="font-semibold tabular-nums">
                  {finalizedOwed
                    .map((row) => formatMoney(row.saldo, row.currency, orgLocale))
                    .join(" y ")}
                </span>
                {owedSameAsToday ? " · lo de hoy" : null}
              </span>
              {/* Secundario: la acción de quien atiende es reservar lo que sigue. */}
              <CollectButton patientId={patientId} patientName={patient.patient.displayName} size="sm" variant="outline" />
            </div>
          ) : null}
          {finalizedControls && (finalizedControls.next || finalizedControls.fulfilled.length > 0) ? (
            <p className="text-sm">{finalizedControlsWords(finalizedControls)}</p>
          ) : null}
          {/* La corona ya reservada mientras la endodoncia pide otra sesión: revisar esa cita (repaso
              del 9 nov). Avisa sin frenar; quien atiende decide si esa cita sirve para la sesión. */}
          {finalizedBookedAfter.length > 0 ? (
            <ul role="status" className="flex flex-col gap-1 text-sm text-warning">
              {finalizedBookedAfter.map((row) => (
                <li key={row.planItemId}>
                  {`«${row.title}» ya tiene cita el ${new Date(row.startsAt)
                    .toLocaleDateString(activeOrgLocale(), {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                      timeZone: activeOrgTimeZone(),
                    })
                    .replace(/[.,]/g, "")}, ${new Date(row.startsAt).toLocaleTimeString(
                    activeOrgLocale(),
                    {
                      hour: "numeric",
                      minute: "2-digit",
                      timeZone: activeOrgTimeZone(),
                    },
                  )}${row.professionalName ? ` con ${row.professionalName}` : ""}, y «${row.beforeTitle}» aún no termina: revisa esa cita; puede servir para su próxima sesión.`}
                </li>
              ))}
            </ul>
          ) : null}
          {/* Lo que se iba a terminar al firmar y no se pudo: sigue en curso, y se dice por qué. */}
          {finalizedKeptOpen.length > 0 ? (
            <ul role="status" className="flex flex-col gap-1 text-sm text-warning">
              {finalizedKeptOpen.map((item) => (
                <li key={item.planItemId}>
                  «{item.title}» sigue en curso: {item.reason}.
                </li>
              ))}
            </ul>
          ) : null}
          {skippedLines.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {skippedLines.map((line) => (
                <li key={line.procedureId}>
                  No se cobra «{line.description}»: {skippedReasonLabel(line.reason)}.
                </li>
              ))}
            </ul>
          ) : null}
          {/* Lo que salió de la sede y lo que no había; se corrige aquí mismo. Nunca frena «Listo». */}
          {finalizedMaterials ? (
            <FinalizedMaterialsNote
              patientId={patientId}
              encounterId={encounterId}
              materials={finalizedMaterials}
              corrected={materialsCorrected}
              onCorrect={() => setCorrectingMaterials(true)}
            />
          ) : null}
          {/* Encima del aviso, dentro de él: al cerrarlo el foco vuelve a «Corregir». */}
          <EncounterMaterialsCorrection
            open={correctingMaterials}
            patientId={patientId}
            encounterId={encounterId}
            onClose={() => setCorrectingMaterials(false)}
            onSaved={() => setMaterialsCorrected(true)}
          />
          {/* Mismo paso de cierre: casi siempre la persona sigue ahí y conviene que se lo lleve. */}
          {finalizedBudget && finalizedBudget.itemCount > 0 && canSendBudget && !budgetLater ? (
            <section
              aria-label="Presupuesto listo"
              className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3"
            >
              <FinalizedBudgetSummary patientId={patientId} budget={finalizedBudget} locale={orgLocale} />
              {budgetSent ? (
                <p role="status" className="text-sm font-medium">
                  Enviado. Queda «Entregado · espera respuesta» en su Plan.
                </p>
              ) : (
                <>
                  <h3 className="text-sm font-semibold">¿Enviárselo a {firstNameOf(patient)} ahora?</h3>
                  <div className="flex flex-wrap items-start gap-2">
                    <BudgetSendButton
                      patientId={patientId}
                      budgetId={finalizedBudget.id}
                      onSent={() => setBudgetSent(true)}
                    />
                    <Button type="button" variant="outline" onClick={() => reviewBudget(finalizedBudget.id)}>
                      Revisar antes
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        // Con una sesión por reservar, «Después» es del presupuesto: el aviso sigue abierto.
                        if (canBook && finalizedNext.some((session) => session.toBook)) setBudgetLater(true)
                        else closeFinalized()
                      }}
                    >
                      Después
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Si nadie lo envía, mañana aparece en «Te espera» de recepción.
                  </p>
                </>
              )}
            </section>
          ) : null}
          <DialogFooter>
            {/* Mientras falta reservar la sesión, «Listo» no compite con «Reservar la sesión 2». */}
            <Button
              type="button"
              variant={canBook && finalizedNext.some((session) => session.toBook) ? "outline" : "default"}
              onClick={closeFinalized}
            >
              Listo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Montado solo al abrirse: cada vez lee de nuevo qué se anula. */}
      {voidOpen ? (
        <EncounterVoidDialog
          open
          patientId={patientId}
          encounterId={encounterId}
          onClose={() => setVoidOpen(false)}
          onBeforeVoid={clearTimer}
          onVoided={afterVoid}
        />
      ) : null}

      {profileOpen ? (
        <ProfessionalProfileDrawer
          open
          target="me"
          profile={profileQuery.data?.data ?? null}
          startAtSignature={profileForSignature}
          onClose={() => {
            setProfileOpen(false)
            setProfileForSignature(false)
          }}
          onSaved={() => void refreshClosing()}
        />
      ) : null}
      {unsavedGuard.dialog}
    </div>
  )
}
