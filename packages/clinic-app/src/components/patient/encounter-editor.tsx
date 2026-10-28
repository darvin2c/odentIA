import { formatVitals, parseVitals, VITAL_SIGNS, type Vitals } from "@odentia/clinical"
import {
  Button,
  cn,
  Field,
  FieldLabel,
  Input,
  Textarea,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@odentia/ui"
import {
  ConfirmDialog,
  DetailDrawer,
  DetailPanel,
  FormDrawer,
  FormPanel,
  MasterDetail,
  useDetailMode,
  PageHeader,
  addDays,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useId, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { DictationMobileBar, dictationMobileBarVisible, DictationPanel, DictationTranscript } from "./dictation-panel"
import { type DictationKind, type DictationSuggestion, useDictationSession } from "./dictation-session"
import { DictationSignDialog } from "./dictation-sign-dialog"
import { PLAN_QUERY_KEYS } from "../../lib/budgets"
import { DictationBlockSuggestions, DictationEditDrawer } from "./dictation-suggestions"
import {
  clinicDateTimeValue,
  fetchFollowUps,
  instantFromClinicValue,
} from "../../lib/clinical-journey"
import { fetchPatientAccount3 } from "../../lib/finance-collect"
import { useMemberName, useMyUserId, usePermission } from "../../lib/crm"
import {
  CLOSING_REQUIREMENT_LABELS,
  type ClosingRequirement,
  fetchEncounterClosing,
  fetchMyProfessionalProfile,
  type FinalizedMaterials,
  saveProfessionalProfileApi,
  type SignatureRegistration,
  signatureRegistrationError,
  takeOverEncounterApi,
  voidEncounterApi,
} from "../../lib/encounters"
import { type Encounter, type EncounterDetail, hcLabel, type PatientFull } from "../../lib/patients"
import { formatMoney } from "@odentia/clinical"
import { useOrgProfile } from "../../lib/org"
import { ProfessionalProfileDrawer } from "../professional-profile-drawer"
import { ChoiceSelect } from "../ui/choice-select"
import { useAgentPanelDockBlocker } from "../agent-panel"
import { EncounterBreadcrumb } from "./encounter-breadcrumb"
import { AttendingForNotice } from "../agenda/attending-for-notice"
import { prepareConsents, type ConsentNeed } from "../../lib/encounter-documents"
import { fetchConsents, type ConsentDocument } from "../../lib/clinical-forms"
import { ageFrom } from "../../lib/patients"
import { ConsentSigningScreen, useSignAs } from "./consent-signing"
import { EncounterClosingDialog, SignatureRegistrationFields } from "./encounter-closing"
import { DeclaredQuestionnaireNotice, EncounterAllergyReview, EncounterContextBody } from "./encounter-context"
import { EncounterDocumentsBlock, useEncounterDocuments } from "./encounter-documents"
import { EncounterDiagnoses } from "./encounter-diagnoses"
import { EncounterBudgetSend, EncounterPlanPanel } from "./encounter-plan-panel"
import { BudgetSendButton } from "./plan/budget-send"
import { EncounterProcedures } from "./encounter-procedures"
import { PatientClinicalStrip } from "./patient-header"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { productUi } from "../../product/product-ui"

export interface EncounterEditorProps {
  patientId: string
  detail: EncounterDetail
  patient: PatientFull
  /** Refresca el query del encounter (lo implementa la ruta). */
  onChanged: () => Promise<void>
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
  procedimientos: { kinds: ["procedimiento"], onlySuggested: "Sin procedimientos registrados" },
  // Los signos vitales y el examen por sistemas que dicta latidIA (issue 229).
  examen: { kinds: ["signos", "examen"], onlySuggested: "Sin examen registrado" },
  // «Plan y controles» es un solo bloque (ADR 0034): ahí se revisan indicaciones y controles.
  plan: { kinds: ["plan", "control", "cita", "presupuesto"], onlySuggested: "Sin indicaciones confirmadas" },
  // La receta dictada se emite desde su bloque, con «Emitir receta» (issue 109, fase 2); el descanso, con «Emitir descanso».
  documentos: { kinds: ["receta", "descanso"], onlySuggested: "Sin documentos" },
}

/** Secciones cuyos campos son del propio borrador: se editan en un `FormPanel`. */
const FORM_SECTIONS: readonly SectionKey[] = ["consulta", "examen", "evolucion"]
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

/** Lo que exige el cierre: siempre a la vista. */
const REQUIRED_SECTIONS: readonly SectionKey[] = ["consulta", "hallazgos", "evolucion"]

interface DraftValues extends Record<NoteKey, string> {
  /** Signos vitales tal como se escriben; el servidor valida rango y unidad. */
  vitals: Record<string, string>
  reason: string
  evolution: string
  indications: string
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
}

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

function saveMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.shape.message) return err.shape.message
  return err instanceof Error ? err.message : fallback
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
  totalCents: number | null
  currency: string
  added: number
}

export interface FinalizeBilling {
  chargedCents: number
  currency: string | null
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
      return "ya estaba incluido en lo cobrado del tratamiento"
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

export function EncounterEditor({
  patientId,
  detail,
  patient,
  onChanged,
  onFinalized,
}: EncounterEditorProps): React.JSX.Element {
  const encounter = detail.encounter
  const encounterId = encounter.id
  const queryClient = useQueryClient()
  const canWrite = usePermission("clinical.write")
  const canRead = usePermission("clinical.read")
  const canReadFinance = usePermission("finance.read")
  const memberName = useMemberName()
  const orgProfile = useOrgProfile().data
  const orgLocale = orgProfile?.locale
  const uid = useId()
  const accountQuery = useQuery({
    queryKey: ["patient-account", patientId],
    queryFn: () => fetchPatientAccount3(patientId),
    enabled: canReadFinance,
  })

  const [reason, setReason] = useState(encounter.reason ?? "")
  const [notes, setNotes] = useState<Record<NoteKey, string>>(() => ({
    presentIllness: encounter.presentIllness ?? "",
    illnessDuration: encounter.illnessDuration ?? "",
    prognosis: encounter.prognosis ?? "",
  }))
  // El examen y los signos vitales son los del producto (issue 229).
  const exam = productUi().encounter.examination
  const [vitals, setVitals] = useState<Record<string, string>>(() => vitalsDraft(encounter.vitals))
  const parsed = parseVitals(vitals, exam.vitals)
  const parsedVitals: Vitals | null = parsed.ok ? parsed.value : null
  const [evolution, setEvolution] = useState(encounter.evolution ?? "")
  const [indications, setIndications] = useState(encounter.indications ?? "")
  const [teeth, setTeeth] = useState<number[]>(() => sortTeeth(detail.teeth))
  const [examination, setExamination] = useState<unknown>(() => exam.draft(encounter.examination))
  // Bloque en edición; `null` colapsa el detalle y deja la lista a todo el ancho.
  // «Consulta» se abre sola solo si falta el motivo: volver a una atención ya
  // empezada no tapa la pantalla con lo que ya está escrito.
  const [openSection, setOpenSection] = useState<SectionKey | null>(encounter.reason?.trim() ? null : "consulta")
  const [addedSections, setAddedSections] = useState<ReadonlySet<SectionKey>>(() => new Set())

  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [saveError, setSaveError] = useState<string | null>(null)
  const [childCount, setChildCount] = useState(0)
  const [explicitSaving, setExplicitSaving] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [finalizedBilling, setFinalizedBilling] = useState<FinalizeBilling | null>(null)
  // El presupuesto que quedó armado al firmar (decisión 12): el cierre pregunta si enviarlo ya.
  const [finalizedBudget, setFinalizedBudget] = useState<FinalizedBudget | null>(null)
  // Lo que descontó el cierre (ADR 0067): solo se dice si no se pudo descontar.
  const [finalizedMaterials, setFinalizedMaterials] = useState<FinalizedMaterials | null>(null)
  const [budgetSent, setBudgetSent] = useState(false)
  // El aviso de firma se elige al abrirlo: firmar descarta las sugerencias y no debe cambiar de diálogo a mitad.
  const [confirmWithDictation, setConfirmWithDictation] = useState(false)
  // «Lo dictado», el respaldo del odontólogo: columna lateral si cabe, cajón si no.
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  // Hora de fin declarada al cerrar (HH:MM local); vacía = ahora.
  const [endTime, setEndTime] = useState("")
  const [voidOpen, setVoidOpen] = useState(false)
  const [voidReason, setVoidReason] = useState("")
  const [voiding, setVoiding] = useState(false)
  const [takingOver, setTakingOver] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  // Hora del último guardado, para «Guardado HH:MM».
  const [savedAt, setSavedAt] = useState<string>(encounter.updatedAt)
  // Antecedentes y última atención, al lado y sin salir.
  const [contextOpen, setContextOpen] = useState(false)
  // Bloque recién agregado: abre su formulario sin un clic de más.
  const [justAdded, setJustAdded] = useState<SectionKey | null>(null)
  // «Seguir sin él»: por qué se cierra con un consentimiento sin firmar.
  const [skipReason, setSkipReason] = useState("")
  // Sin colegiatura en el perfil, el cierre la pide y la guarda antes de firmar.
  const [registration, setRegistration] = useState<SignatureRegistration>({
    professionalTitle: "",
    registrationBody: "",
    registrationNumber: "",
  })
  const [registrationError, setRegistrationError] = useState<string | null>(null)
  const registrationNumberRef = useRef<HTMLInputElement>(null)
  // Consentimientos que se firman en la unidad dental desde el cierre.
  const [signingDocs, setSigningDocs] = useState<ConsentDocument[] | null>(null)
  const myUserId = useMyUserId()
  // El borrador ocupa la página: el agente se abre como cajón, sin desmontarlo.
  useAgentPanelDockBlocker(true)
  const signAs = useSignAs()
  // Quien lleva la atención es quien la edita y la firma; otro profesional la
  // lee y, para continuarla, toma el relevo.
  const attending = encounter.professionalUserId === myUserId
  const closingQuery = useQuery({
    queryKey: ["encounter-closing", patientId, encounterId],
    queryFn: () => fetchEncounterClosing(patientId, encounterId),
    enabled: canWrite,
  })
  const profileQuery = useQuery({
    queryKey: ["professional-profile", "me"],
    queryFn: fetchMyProfessionalProfile,
    enabled: canWrite,
  })

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
    return body
  }

  /** Un solo drenado serializado: toma los dirty, los envía y repite si llegaron más. */
  const drain = (): Promise<void> => {
    if (drainRef.current) return drainRef.current
    const run = (async () => {
      // Sin nada enviado, «Guardado» conserva su hora: cerrar un bloque sin cambios no es guardar.
      let sentAny = false
      try {
        if (mountedRef.current) setSaveState("saving")
        for (;;) {
          if (dirtyRef.current.size === 0) break
          sentAny = true
          const sendable = [...dirtyRef.current]
          dirtyRef.current.clear()
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
            // La sección «Signos vitales» y la medición anterior se leen de nuevo.
            if (sendable.includes("vitals"))
              void queryClient.invalidateQueries({ queryKey: ["patient-vitals", patientId] })
          } catch (err) {
            for (const key of sendable) dirtyRef.current.add(key)
            throw err
          } finally {
            for (const key of sendable) inflightRef.current.delete(key)
          }
        }
        if (mountedRef.current) {
          setSaveError(null)
          setSaveState(dirtyRef.current.size > 0 ? "pending" : "saved")
          if (sentAny) setSavedAt(new Date().toISOString())
        }
      } catch (err) {
        if (mountedRef.current) {
          // Sin conexión lo escrito se queda en la pantalla y se guarda al volver.
          if (isOffline(err)) {
            setSaveError(null)
            setSaveState("offline")
          } else {
            setSaveError(saveMessage(err, "No se pudo guardar el borrador."))
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
    for (;;) {
      await drain()
      if (dirtyRef.current.size === 0) return
    }
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

  const editNote = (key: NoteKey, value: string) => {
    valuesRef.current[key] = value
    setNotes((prev) => ({ ...prev, [key]: value }))
    markEdited(key)
  }
  const editVital = (key: string, value: string) => {
    const next = { ...valuesRef.current.vitals, [key]: value }
    valuesRef.current.vitals = next
    setVitals(next)
    markEdited("vitals")
  }

  const editReason = (value: string) => {
    valuesRef.current.reason = value
    setReason(value)
    markEdited("reason")
  }

  const editEvolution = (value: string) => {
    valuesRef.current.evolution = value
    setEvolution(value)
    markEdited("evolution")
  }

  const editIndications = (value: string) => {
    valuesRef.current.indications = value
    setIndications(value)
    markEdited("indications")
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
      const text = (key: string) => (typeof item.payload[key] === "string" ? (item.payload[key] as string) : null)
      const reasonText = text("reason")
      if (reasonText !== null) editReason(reasonText)
      const evolutionText = text("evolution")
      if (evolutionText !== null) editEvolution(evolutionText)
      const indicationsText = text("indications")
      if (indicationsText !== null) editIndications(indicationsText)
      for (const key of ["presentIllness", "illnessDuration", "prognosis"] as NoteKey[]) {
        const value = text(key)
        if (value !== null) editNote(key, value)
      }
    }
    // Los signos y el examen confirmados pasan por los mismos editores, para que el borrador local no los pise.
    if (item.kind === "signos") {
      for (const [key, value] of Object.entries(item.payload)) if (typeof value === "number") editVital(key, String(value))
      void queryClient.invalidateQueries({ queryKey: ["patient-vitals", patientId] })
    }
    if (item.kind === "examen" && exam.withDictated) editExamination(exam.withDictated(valuesRef.current.examination, item.payload))
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
  })
  // Sugerencias que el odontólogo aún no confirmó ni descartó.
  const dictationPending = dictation.enabled ? dictation.pending : 0
  /** Lo que se dicta en un bloque: en los comunes, lo de arriba; en los del producto, lo que declara el bloque. */
  const dictationOf = (key: SectionKey) =>
    SECTION_DICTATION[key as CommonSectionKey] ?? product.blocks.find((block) => block.key === key)?.dictation
  const dictationCount = (key: SectionKey): number => {
    const kinds = dictationOf(key)?.kinds ?? []
    return dictation.enabled ? dictation.suggestions.filter((item) => kinds.includes(item.kind)).length : 0
  }
  /** ¿Tiene el bloque algo quitado por voz que aún se puede deshacer? Entonces se muestra. */
  const dictationRemoved = (key: SectionKey): boolean => {
    const kinds = dictationOf(key)?.kinds ?? []
    return dictation.enabled && dictation.removedByVoice.some((item) => kinds.includes(item.kind))
  }

  /** Control de página: guarda el borrador (flush + refresh) sin formulario. */
  const handleSaveDraft = async () => {
    if (explicitSaving || finalizing || childCountRef.current > 0) return
    setExplicitSaving(true)
    try {
      await flush()
      await onChanged()
    } catch (err) {
      if (mountedRef.current) {
        setSaveError(saveMessage(err, "No se pudo guardar el borrador."))
        setSaveState("error")
      }
    } finally {
      if (mountedRef.current) setExplicitSaving(false)
    }
  }

  const refreshClosing = () =>
    queryClient.invalidateQueries({ queryKey: ["encounter-closing", patientId, encounterId] })

  /** Hora de fin declarada: hoy a la hora indicada, en la zona de la clínica. */
  const endedAtIso = (): string | null => {
    if (!endTime) return null
    const today = clinicDateTimeValue(new Date().toISOString()).slice(0, 10)
    return instantFromClinicValue(`${today}T${endTime}`)
  }

  const handleVoid = async () => {
    if (voiding || !voidReason.trim()) return
    setVoiding(true)
    clearTimer()
    try {
      await voidEncounterApi(patientId, encounterId, voidReason.trim())
      setVoidOpen(false)
      await queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
      await queryClient.invalidateQueries({ queryKey: ["open-encounter", patientId] })
      await queryClient.invalidateQueries({ queryKey: ["encounters", patientId] })
      await onChanged()
    } catch (err) {
      if (mountedRef.current) {
        setSaveError(saveMessage(err, "No se pudo anular la atención."))
        setVoidOpen(false)
      }
    } finally {
      if (mountedRef.current) setVoiding(false)
    }
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
      setSaveError(saveMessage(err, "No se pudo tomar el relevo."))
    } finally {
      if (mountedRef.current) setTakingOver(false)
    }
  }

  const chargedLines = finalizedBilling?.lines.filter((line) => line.status === "charged") ?? []
  const skippedLines = finalizedBilling?.lines.filter((line) => line.status !== "charged") ?? []
  const closeFinalized = () => {
    if (!finalizedBilling) return
    const hadCharges = finalizedBilling.lines.some((line) => line.status === "charged")
    setFinalizedBilling(null)
    setFinalizedBudget(null)
    setFinalizedMaterials(null)
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
   * Lo que quedó sugerido sin confirmar no entra a la historia: se descarta y
   * se sigue al cierre, con lo que falta y la hora de fin.
   */
  const discardDictationAndContinue = async () => {
    try {
      await apiFetch(`/api/patients/${patientId}/encounters/${encounterId}/dictation/discard-pending`, { method: "POST" })
      await dictation.refresh()
      // Sin consentimientos por firmar, «Firmar con N marcadas» firma; si falta
      // alguno, sigue al cierre para firmarlo o decir por qué se sigue sin él.
      if ((closingQuery.data?.data.consents ?? []).length === 0) await handleConfirmFinalize()
      else setConfirmWithDictation(false)
    } catch (err) {
      setSaveError(saveMessage(err, "No se pudieron descartar las sugerencias."))
      setConfirmOpen(false)
    }
  }

  /**
   * Guarda la colegiatura escrita en el cierre (si faltaba) en el perfil
   * profesional; si no se pudo, el cierre queda abierto con el aviso y lo escrito.
   */
  const saveRegistration = async (): Promise<boolean> => {
    if (!needsRegistration) return true
    const invalid = signatureRegistrationError(registration)
    if (invalid) {
      setRegistrationError(invalid)
      return false
    }
    setFinalizing(true)
    try {
      await saveProfessionalProfileApi("me", {
        professionalTitle: registration.professionalTitle.trim(),
        registrationBody: registration.registrationBody.trim(),
        registrationNumber: registration.registrationNumber.trim(),
      })
      await queryClient.invalidateQueries({ queryKey: ["professional-profile"] })
      return true
    } catch (err) {
      if (mountedRef.current) setRegistrationError(saveMessage(err, "No se pudo guardar tu colegiatura."))
      return false
    } finally {
      if (mountedRef.current) setFinalizing(false)
    }
  }

  const handleConfirmFinalize = async () => {
    if (finalizing || childCountRef.current > 0) return
    if (!(await saveRegistration())) return
    setFinalizing(true)
    try {
      // Congela: primero todo PATCH pendiente y último dirty, recién después finalize.
      await flush()
      const endedAt = endedAtIso()
      const unsigned = closingQuery.data?.data.consents ?? []
      const result = await apiFetch<{
        data: {
          charges: Array<{ id: string }>
          skippedCharges: Array<{ procedureId: string; reason: string }>
          billing: FinalizeBilling
          budget: FinalizedBudget | null
          materials?: FinalizedMaterials | null
        }
      }>(`/api/patients/${patientId}/encounters/${encounterId}/finalize`, {
        method: "POST",
        body: JSON.stringify({
          ...(endedAt ? { endedAt } : {}),
          // «Seguir sin él»: solo si falta algún consentimiento.
          ...(unsigned.length > 0 ? { consentSkipReason: skipReason.trim() } : {}),
        }),
      })
      setConfirmOpen(false)
      setBudgetSent(false)
      setFinalizedBudget(result.data.budget ?? null)
      setFinalizedMaterials(result.data.materials ?? null)
      setFinalizedBilling(result.data.billing)
      // En Perú, el cierre que cambió el gráfico firmó el odontograma.
      void queryClient.invalidateQueries({ queryKey: ["odontogram-assessments", patientId] })
      // Lo que salió de la sede cambia lo que hay en Inventario.
      if (result.data.materials) void queryClient.invalidateQueries({ queryKey: ["inventory"] })
    } catch (err) {
      // Falla: se conserva el borrador intacto y se muestra el error real. El
      // estado del guardado lo deja `drain` si lo que falló fue guardar.
      if (mountedRef.current) {
        setSaveError(saveMessage(err, "No se pudo finalizar la atención."))
        setConfirmOpen(false)
        void refreshClosing()
      }
    } finally {
      if (mountedRef.current) setFinalizing(false)
    }
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

  const locked = !canWrite || !attending || childCount > 0 || finalizing || voiding
  // Los bloques del producto (odentIA: Odontograma y Periodontograma), después del examen.
  const product = productUi().encounter.useBlocks({
    patientId,
    encounterId,
    detail,
    birthDate: patient.patient.birthDate,
    canRead,
    canWrite,
    locked,
    writable: canWrite && attending && !finalizing && !voiding,
    flush,
    onChanged: handleChildChanged,
    onPendingChange: handlePendingChange,
  })

  const followUps = (followUpsQuery.data?.data ?? []).filter(
    (row) => row.originEncounterId === encounterId,
  )
  // Tratamientos que esta atención deja por ejecutar: los indicados aquí y los
  // vinculados que siguen abiertos. No basta `plannedItems`: el vínculo nace
  // cuando la sesión arranca, así que una indicación recién propuesta solo
  // aparece en `indicatedItems`.
  const pendingTreatments = attentionItems.filter((item) =>
    ["pendiente", "programado", "en_curso"].includes(item.status),
  ).length

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
        ? "Motivo, enfermedad actual, sede y piezas evaluadas."
        : "Motivo, enfermedad actual y sede.",
      summary: reason.trim() === "" ? "Sin motivo registrado" : reason.trim(),
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
          detail.indicatedItems.length > 0 ? `${counted(detail.indicatedItems.length, "indicado", "indicados")} hoy` : "",
          pendingTreatments > 0 ? `${pendingTreatments} por ejecutar` : "",
          followUps.length > 0 ? counted(followUps.length, "control", "controles") : "",
        ]
          .filter(Boolean)
          .join(" · ") || "Sin indicaciones ni controles",
      empty:
        detail.indicatedItems.length === 0 &&
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
          docs.pendingSignatures.length > 0
            ? `${docs.pendingSignatures.length} sin firmar`
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
      description: "Pronóstico, evolución (obligatoria para cerrar) e indicaciones.",
      summary:
        evolution.trim() === ""
          ? "Falta · necesaria para cerrar"
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
  const needsRegistration = closingQuery.isSuccess && missing.includes("signature")
  const onlyRegistrationMissing = needsRegistration && missing.every((requirement) => requirement === "signature")
  const closingSections = sections.filter((section) => section.key !== "consulta")
  const recorded = closingSections.filter((section) => !section.empty).map((s) => s.summary)
  const unrecorded = closingSections
    .filter((section) => section.empty)
    .map((section) => section.title.toLowerCase())
  const finalizeDescription = [
    recorded.length > 0 ? `Registrado: ${recorded.join("; ")}.` : "",
    unrecorded.length > 0 ? `Sin registrar: ${unrecorded.join(", ")}.` : "",
    "Después del cierre solo se agregan adendas. Si vino de una cita, la cita queda atendida.",
  ]
    .filter(Boolean)
    .join(" ")

  // Un bloque con sugerencias del dictado se muestra aunque no tenga nada registrado: ahí se revisan.
  // Lo que exige el cierre (motivo, diagnóstico y evolución) siempre está a la vista, no entre lo opcional.
  const includedSections = sections.filter(
    (section) =>
      REQUIRED_SECTIONS.includes(section.key) ||
      !section.empty ||
      addedSections.has(section.key) ||
      dictationCount(section.key) > 0 ||
      dictationRemoved(section.key),
  )
  const availableSections = sections.filter((section) => !includedSections.includes(section))
  const openMeta = sections.find((section) => section.key === openSection) ?? null

  const addSection = (key: SectionKey) => {
    setAddedSections((current) => {
      if (current.has(key)) return current
      const next = new Set(current)
      next.add(key)
      return next
    })
    // Un bloque nuevo abre su formulario al agregarlo, sin un clic de más.
    setJustAdded(key)
    setContextOpen(false)
    setOpenSection(key)
  }

  /** Solo se quita lo que no tiene nada registrado: nunca se oculta un dato. */
  const removeSection = (key: SectionKey) => {
    setAddedSections((current) => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
    if (openSection === key) setOpenSection(null)
  }

  const closeSection = () => {
    setOpenSection(null)
    setJustAdded(null)
    // Los campos escalares son del editor: cerrar no descarta nada y el
    // autosave sigue vivo. El flush evita dejar un cambio a medias.
    void flush().catch(() => {})
  }

  const submitSection = (event: React.FormEvent) => {
    event.preventDefault()
    void handleSaveDraft()
  }

  /** Al dictar, la atención queda a la vista: se cierra el bloque abierto y, si cabe, se muestra el respaldo al lado. */
  const startDictation = () => {
    if (openSection) closeSection()
    if (mode === "panel") setTranscriptOpen(true)
  }
  const finishDictation = () => {
    dictation.finish()
    setTranscriptOpen(false)
  }
  const showTranscript = () => {
    if (mode === "panel" && openSection) closeSection()
    setTranscriptOpen(true)
  }
  const contextSurface = {
    title: "Antecedentes y última atención",
    description: "Solo lectura: se editan en Clínica.",
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
  const canSign = !(locked || explicitSaving || !(closingReady || onlyRegistrationMissing) || dictation.busy || unsaved)
  const signBlockedReason =
    saveState === "offline"
      ? "Sin conexión: lo escrito se guarda al volver y recién entonces se puede firmar."
      : saveState === "pending" || saveState === "saving"
        ? "Guardando lo último que escribiste…"
        : saveState === "error"
          ? "No se pudo guardar lo último: revisa el aviso y vuelve a intentarlo."
          : null
  const openSign = () => {
    setEndTime("")
    setSkipReason("")
    if (needsRegistration) {
      // Lo que ya tiene el perfil y, si falta, lo que propone el país del producto (COP, CMP).
      const profile = profileQuery.data?.data
      const suggested = productUi().country.professional(orgProfile?.countryCode)
      setRegistration({
        professionalTitle: profile?.professionalTitle || suggested?.title || "",
        registrationBody: profile?.registrationBody || suggested?.registrationBody || "",
        registrationNumber: profile?.registrationNumber ?? "",
      })
      setRegistrationError(null)
    }
    setConfirmWithDictation(dictationPending > 0)
    setConfirmOpen(true)
  }
  const unsignedConsents: ConsentNeed[] = closingQuery.data?.data.consents ?? []
  const [preparing, setPreparing] = useState(false)
  /** «Preparar» desde la fila del bloque: genera los consentimientos que pide la atención. */
  const prepareFromRow = async () => {
    if (preparing) return
    setPreparing(true)
    try {
      await flush()
      await prepareConsents(patientId, encounterId)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["consent-needs", patientId, encounterId] }),
        queryClient.invalidateQueries({ queryKey: ["consents", patientId] }),
        refreshClosing(),
      ])
    } catch (err) {
      setSaveError(saveMessage(err, "No se pudo preparar el consentimiento."))
    } finally {
      if (mountedRef.current) setPreparing(false)
    }
  }
  const signer = firstNameOf(patient)
  /** «Firmar ahora» desde el cierre: prepara lo que falta y abre la firma en la unidad dental. */
  const signConsentsNow = async (need: ConsentNeed) => {
    try {
      if (need.status === "sin_preparar") {
        await flush()
        await prepareConsents(patientId, encounterId, [need.templateKey])
      }
      const list = await queryClient.fetchQuery({
        queryKey: ["consents", patientId],
        queryFn: () => fetchConsents({ patientId }),
        staleTime: 0,
      })
      const pending = list.data.filter((doc) => doc.encounterId === encounterId && doc.status === "pendiente")
      if (pending.length > 0) setSigningDocs(pending)
    } catch (err) {
      setSaveError(saveMessage(err, "No se pudo preparar el consentimiento."))
    }
  }
  /** «Firmar» desde la barra del teléfono: firma si se puede; si no, lleva a lo que falta para cerrar. */
  const signFromBar = () => {
    if (canSign) openSign()
    else document.getElementById(closingId)?.scrollIntoView({ block: "start" })
  }
  const pendingDiagnoses = dictationCount("hallazgos")

  const consultaBody = (
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor={`${uid}-branch`}>Sede de la atención</FieldLabel>
        <ChoiceSelect
          id={`${uid}-branch`}
          
          disabled={locked || branchesQuery.isPending}
          value={encounter.branchId ?? ""}
          onChange={async (event) => {
            const branchId = event.target.value || null
            handlePendingChange(true)
            try {
              await flush()
              await apiFetch(`/api/patients/${patientId}/encounters/${encounterId}`, {
                method: "PATCH",
                body: JSON.stringify({ branchId }),
              })
              await onChanged()
            } catch (err) {
              setSaveError(saveMessage(err, "No se pudo guardar la sede."))
            } finally {
              handlePendingChange(false)
            }
          }}
        >
          <option value="">Sin sede asignada</option>
          {(branchesQuery.data?.data ?? []).map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </ChoiceSelect>
        {branchesQuery.isError && <p role="alert">No se pudieron cargar las sedes.</p>}
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-reason`}>Motivo</FieldLabel>
        <Textarea
          id={`${uid}-reason`}
          rows={2}
          value={reason}
          disabled={locked}
          maxLength={MAX_REASON}
          placeholder="Motivo de la consulta…"
          // Al entrar sin motivo, el cursor ya está aquí: es lo primero que se escribe.
          autoFocus={!encounter.reason?.trim()}
          onChange={(event) => editReason(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-present-illness`}>Enfermedad actual (relato)</FieldLabel>
        <Textarea
          id={`${uid}-present-illness`}
          rows={3}
          value={notes.presentIllness}
          disabled={locked}
          maxLength={4000}
          placeholder="Inicio, curso, síntomas y lo que lo alivia o empeora…"
          onChange={(event) => editNote("presentIllness", event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-illness-duration`}>Tiempo de enfermedad</FieldLabel>
        <Input
          id={`${uid}-illness-duration`}
          className="sm:w-60"
          value={notes.illnessDuration}
          disabled={locked}
          maxLength={200}
          placeholder="Ej.: 3 días"
          onChange={(event) => editNote("illnessDuration", event.target.value)}
        />
      </Field>
      {productUi().site ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            Piezas vinculadas ({teeth.length})
          </p>
          <div className="flex flex-wrap gap-2">
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
            {teeth.length === 0 && (
              <span className="text-xs text-muted-foreground">
                Evaluación general o localizada en el odontograma.
              </span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )

  const examenBody = (
    <div className="grid gap-3 sm:grid-cols-2">
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0 sm:col-span-2">
        <legend className="mb-1 text-sm font-medium">Signos vitales</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {VITAL_SIGNS.filter((sign) => exam.vitals.includes(sign.key)).map((sign) => (
            <Field key={sign.key}>
              <FieldLabel htmlFor={`${uid}-vital-${sign.key}`} className="text-xs">
                {sign.label} ({sign.suffix})
              </FieldLabel>
              <Input
                id={`${uid}-vital-${sign.key}`}
                inputMode="decimal"
                value={vitals[sign.key] ?? ""}
                disabled={locked}
                onChange={(event) => editVital(sign.key, event.target.value.replace(",", "."))}
              />
            </Field>
          ))}
        </div>
        {parsed.ok ? (
          <p className="text-xs text-muted-foreground">
            La presión se registra completa (sistólica y diastólica).
          </p>
        ) : (
          <p role="alert" className="text-xs text-destructive">
            {parsed.error}. No se guarda hasta corregirlo.
          </p>
        )}
        <exam.VitalsNote patientId={patientId} encounterId={encounterId} vitals={parsedVitals} />
      </fieldset>
      <exam.Fields
        idPrefix={uid}
        draft={examination}
        onChange={editExamination}
        disabled={locked}
      />
    </div>
  )

  const evolucionBody = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <Field>
          <FieldLabel htmlFor={`${uid}-prognosis`}>Pronóstico</FieldLabel>
          <Textarea
            id={`${uid}-prognosis`}
            rows={2}
            value={notes.prognosis}
            disabled={locked}
            maxLength={2000}
            onChange={(event) => editNote("prognosis", event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${uid}-evolution`}>Evolución</FieldLabel>
          <Textarea
            id={`${uid}-evolution`}
            rows={3}
            value={evolution}
            disabled={locked}
            maxLength={MAX_EVOLUTION}
            placeholder="Evolución clínica…"
            onChange={(event) => editEvolution(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${uid}-indications`}>Indicaciones</FieldLabel>
          <Textarea
            id={`${uid}-indications`}
            rows={2}
            value={indications}
            disabled={locked}
            maxLength={MAX_INDICATIONS}
            placeholder="Indicaciones para el paciente…"
            onChange={(event) => editIndications(event.target.value)}
          />
        </Field>
      </div>
    </div>
  )

  const sectionBody: Record<CommonSectionKey, React.ReactNode> = {
    consulta: consultaBody,
    hallazgos: (
      <EncounterDiagnoses
        patientId={patientId}
        detail={detail}
        disabled={locked}
        beforeWrite={flush}
        onChanged={handleChildChanged}
        onPendingChange={handlePendingChange}
        autoOpen={justAdded === "hallazgos"}
      />
    ),
    examen: examenBody,
    procedimientos: (
      <EncounterProcedures
        patientId={patientId}
        detail={detail}
        disabled={locked}
        beforeWrite={flush}
        onChanged={handleChildChanged}
        onPendingChange={handlePendingChange}
        autoOpen={justAdded === "procedimientos"}
      />
    ),
    plan: (
      <EncounterPlanPanel
        patientId={patientId}
        encounterId={encounterId}
        plannedItems={detail.plannedItems}
        indicatedItems={detail.indicatedItems}
        attentionItems={attentionItems}
        disabled={locked}
        autoOpen={justAdded === "plan"}
        patientName={patient.patient.displayName}
        beforeWrite={flush}
        onChanged={handleChildChanged}
        onPendingChange={handlePendingChange}
      />
    ),
    documentos: (
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
        openMenu={justAdded === "documentos"}
      />
    ),
    evolucion: evolucionBody,
  }

  /**
   * Detalle del bloque abierto. Un solo contenedor montado a la vez: `FormPanel`
   * en ancho de panel y su equivalente en drawer por debajo del corte; montar
   * ambos duplicaría los `id`/`htmlFor` de los campos. Los bloques que alojan
   * registros con formulario propio usan el detalle de lectura, para no anidar
   * formularios.
   */
  const sectionDetail = (target: "panel" | "drawer"): React.ReactNode => {
    if (!openSection || !openMeta) return null
    const surface = {
      title: openMeta.title,
      description: openMeta.description,
      onClose: closeSection,
    }
    const body =
      sectionBody[openSection as CommonSectionKey] ?? product.blocks.find((block) => block.key === openSection)?.content
    if (FORM_SECTIONS.includes(openSection)) {
      // Solo guardado automático: el bloque no lleva botón de guardar.
      const form = {
        ...surface,
        children: body,
        onSubmit: submitSection,
        isSubmitting: explicitSaving,
        error: saveError,
        hideSubmit: true,
      }
      return target === "panel" ? <FormPanel {...form} /> : <FormDrawer open {...form} />
    }
    const detailSurface = { ...surface, children: body }
    return target === "panel" ? (
      <DetailPanel {...detailSurface} />
    ) : (
      <DetailDrawer open {...detailSurface} />
    )
  }

  const registrationFields = needsRegistration ? (
    <SignatureRegistrationFields
      signAs={profileQuery.data?.data.signatureName ?? profileQuery.data?.data.accountName ?? null}
      values={registration}
      askTitle={!profileQuery.data?.data.professionalTitle}
      error={registrationError}
      disabled={finalizing}
      numberRef={registrationNumberRef}
      onChange={(values) => {
        setRegistration(values)
        setRegistrationError(null)
      }}
    />
  ) : null
  // Con quién se firma: lo mismo con o sin sugerencias pendientes (la hora de fin va en el cierre).
  const signFields = registrationFields ?? (
    <p className="text-sm">
      Firmarás como <strong>{signAs.text ?? "—"}</strong>
    </p>
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
  // Pie fijo: lo que falta y «Finalizar y firmar», también en la tablet y el teléfono.
  const footerText = dictation.busy
    ? "Termina el dictado para poder firmar"
    : !closingQuery.isSuccess
      ? "Comprobando lo que falta…"
      : onlyRegistrationMissing
        ? "Listo para firmar · falta tu colegiatura, se pide al firmar"
        : !closingReady
          ? `${missing.length === 1 ? "Falta 1" : `Faltan ${missing.length}`} para cerrar: ${listWords(missing.map((m) => CLOSING_SHORT[m]))}`
        : unsignedConsents.length > 0
          ? `Listo para firmar · falta${unsignedConsents.length === 1 ? "" : "n"} ${unsignedConsents.length} firma${unsignedConsents.length === 1 ? "" : "s"} de ${signer}`
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
                age !== "" ? `${age} años` : null,
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
            <Button type="button" size="sm" variant="outline" onClick={() => {
              if (mode === "panel" && openSection) closeSection()
              setContextOpen(true)
            }}>
              Antecedentes y última atención
            </Button>
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

      {attending ? <EncounterAllergyReview patientId={patientId} patient={patient} disabled={locked} /> : null}
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
      />

      <MasterDetail
        panelSize="xl"
        panel={
          mode === "panel"
            ? (sectionDetail("panel") ??
              (contextOpen ? <DetailPanel {...contextSurface} /> : null) ??
              (transcriptOpen && dictation.enabled ? <DetailPanel {...transcriptSurface} /> : null))
            : null
        }
      >
        <div className="flex flex-col gap-4">
          {includedSections.map((section) => (
            <section
              key={section.key}
              aria-label={section.title}
              className="flex flex-wrap items-start justify-between gap-3 rounded-sm bg-card p-6"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <h2 className="font-heading text-base font-medium">{section.title}</h2>
                <p className="text-sm text-muted-foreground">
                  {dictationCount(section.key) > 0
                    ? `${(section.empty && dictationOf(section.key)?.onlySuggested) || section.summary} · ${dictationCount(section.key)} ${dictationCount(section.key) === 1 ? "sugerencia" : "sugerencias"}`
                    : section.summary}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={openSection === section.key ? "secondary" : "outline"}
                  aria-expanded={openSection === section.key}
                  onClick={() => setOpenSection(section.key)}
                >
                  {openSection === section.key ? "En edición" : "Abrir"}
                </Button>
                {!REQUIRED_SECTIONS.includes(section.key) && section.empty && dictationCount(section.key) === 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => removeSection(section.key)}
                  >
                    Quitar
                  </Button>
                ) : null}
              </div>
              {(dictationOf(section.key)?.kinds ?? []).map((kind) => (
                <DictationBlockSuggestions key={kind} session={dictation} kind={kind} patientName={patient.patient.displayName} />
              ))}
              {/* El presupuesto en borrador (también el que armó Clío) se muestra, imprime o envía sin abrir el bloque. */}
              {section.key === "plan" && openSection !== "plan" ? (
                <EncounterBudgetSend patientId={patientId} patientName={patient.patient.displayName} beforeWrite={flush} compact />
              ) : null}
              {/* Al registrar o indicar un servicio que lo pide, se propone sin abrir el bloque. */}
              {section.key === "documentos" && docs.toPrepare.length > 0 ? (
                <div className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2">
                  <span className="text-sm">
                    Necesita consentimiento · {docs.toPrepare.map((need) => need.title).join(" y ")}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={locked || preparing}
                    onClick={() => void prepareFromRow()}
                  >
                    {preparing ? "Preparando…" : "Preparar"}
                  </Button>
                </div>
              ) : null}
            </section>
          ))}
        </div>

        {availableSections.length > 0 ? (
          <section
            aria-label="Agregar a la atención"
            className="flex flex-col gap-3 rounded-sm bg-card p-6"
          >
            <div className="flex flex-col gap-1">
              <h2 className="font-heading text-base font-medium">Agregar si ocurrió</h2>
            </div>
            <div className="flex flex-wrap gap-2">
              {availableSections.map((section) => (
                // Dentro de «Agregar si ocurrió» basta el nombre; el lector de pantalla oye «Agregar …».
                <Button
                  key={section.key}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-auto min-h-11 max-w-full shrink py-1 text-left whitespace-normal sm:min-h-8"
                  title={section.description}
                  aria-label={`Agregar ${section.title}`}
                  onClick={() => addSection(section.key)}
                >
                  {section.title}
                </Button>
              ))}
            </div>
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
          <ul className="flex flex-col gap-1.5 text-sm" aria-label="Requisitos para cerrar">
            {(["reason", "diagnosis", "evolution", "signature"] as ClosingRequirement[]).map(
              (requirement) => {
                const done = closingQuery.isSuccess && !missing.includes(requirement)
                return (
                  <li key={requirement} className="flex flex-wrap items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={
                        done
                          ? "inline-flex size-5 items-center justify-center rounded-full bg-success-soft text-xs font-bold text-success"
                          : "inline-flex size-5 items-center justify-center rounded-full bg-warning-soft text-xs font-bold text-warning"
                      }
                    >
                      {done ? "✓" : "!"}
                    </span>
                    <span>
                      {requirement === "diagnosis" && !done && pendingDiagnoses > 0
                        ? pendingDiagnoses === 1
                          ? "Diagnóstico: hay uno sugerido, sin confirmar"
                          : `Diagnóstico: hay ${pendingDiagnoses} sugeridos, sin confirmar`
                        : CLOSING_REQUIREMENT_LABELS[requirement]}
                      <span className="sr-only">{done ? ": listo" : ": pendiente"}</span>
                    </span>
                    {!done && closingQuery.isSuccess ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="link"
                        className="h-auto p-0"
                        disabled={!attending}
                        onClick={() => {
                          if (requirement === "signature") setProfileOpen(true)
                          else
                            addSection(
                              requirement === "reason"
                                ? "consulta"
                                : requirement === "diagnosis"
                                  ? "hallazgos"
                                  : "evolucion",
                            )
                        }}
                      >
                        {requirement === "signature" ? "Completar perfil" : "Registrar"}
                      </Button>
                    ) : null}
                  </li>
                )
              },
            )}
          </ul>
          {unsignedConsents.length > 0 ? (
            <ul className="flex flex-col gap-1.5 text-sm" aria-label="Consentimientos sin firmar">
              {unsignedConsents.map((need) => (
                <li key={`${need.templateKey}-${need.documentId ?? ""}`} className="flex flex-wrap items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="inline-flex size-5 items-center justify-center rounded-full bg-warning-soft text-xs font-bold text-warning"
                  >
                    !
                  </span>
                  <span>
                    {need.status === "sin_publicar"
                      ? `Esta clínica aún no publicó el consentimiento de «${need.title}»`
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
                      Firmar ahora
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
                activeProcedures > 0 ? counted(activeProcedures, "procedimiento", "procedimientos") : "",
                activeDiagnoses > 0 ? counted(activeDiagnoses, "diagnóstico", "diagnósticos") : "",
                detail.odontogramEntries?.length
                  ? counted(detail.odontogramEntries.length, "hallazgo en el odontograma", "hallazgos en el odontograma")
                  : "",
                detail.documents.length > 0 ? counted(detail.documents.length, "documento", "documentos") : "",
                pendingTreatments > 0 ? `${counted(pendingTreatments, "tratamiento", "tratamientos")} por ejecutar` : "",
              ].filter(Boolean)
              return done.length > 0 ? <p className="text-muted-foreground">{done.join(" · ")}</p> : null
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
              disabled={locked || explicitSaving}
              onClick={() => {
                setVoidReason("")
                setVoidOpen(true)
              }}
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
          <span className="text-sm text-muted-foreground">{footerText}</span>
          <Button type="button" disabled={!canSign} onClick={openSign}>
            Finalizar y firmar
          </Button>
        </div>
      ) : null}

      {mode === "drawer" ? sectionDetail("drawer") : null}
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
        signAs={signAs.text}
        who={signer}
        consents={unsignedConsents}
        closing={closingQuery.data?.data ?? null}
        materials={closingQuery.data?.data.materials ?? null}
        onOpenBlock={(key) => {
          setConfirmOpen(false)
          setContextOpen(false)
          setOpenSection(key)
        }}
        startedAt={encounter.startedAt}
        endTime={endTime}
        onEndTime={setEndTime}
        skipReason={skipReason}
        onSkipReason={setSkipReason}
        pending={finalizing}
        canSign={canSign}
        blockedReason={signBlockedReason}
        registration={registrationFields}
        confirmLabel={needsRegistration ? "Guardar y firmar" : null}
        initialFocus={needsRegistration ? registrationNumberRef : undefined}
        onSignNow={(need) => void signConsentsNow(need)}
        onConfirm={() => void handleConfirmFinalize()}
        onClose={() => {
          if (!finalizing) setConfirmOpen(false)
        }}
      >
        <p className="text-xs text-muted-foreground">{finalizeDescription}</p>
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
        onClose={() => setConfirmOpen(false)}
        onComplete={(id) => {
          setConfirmOpen(false)
          // Lo que no se puede confirmar tal cual se abre para completarlo.
          const item = dictation.suggestions.find((candidate) => candidate.id === id)
          if (item) dictation.openEdit(item)
        }}
        onSign={(ids) => {
          // Sin colegiatura válida no se confirma nada: el aviso queda junto al campo.
          const invalid = needsRegistration ? signatureRegistrationError(registration) : null
          if (invalid) {
            setRegistrationError(invalid)
            return
          }
          void dictation.confirmMany
            .mutateAsync(ids)
            .then(() => discardDictationAndContinue())
            .catch(() => undefined)
        }}
      >
        {signFields}
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
              {chargedLines.length > 0
                ? "Caja ya lo ve en su lista de por cobrar."
                : "Esta atención no dejó nada que cobrar."}
            </DialogDescription>
          </DialogHeader>
          {chargedLines.length > 0 ? (
            <section className="flex flex-col gap-2" aria-label="Quedó por cobrar">
              <h3 className="text-sm font-semibold">Quedó por cobrar</h3>
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
              {finalizedBilling?.currency && orgLocale ? (
                <p className="flex items-baseline justify-between gap-3 border-t pt-2 text-sm font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">
                    {formatMoney(finalizedBilling.chargedCents, finalizedBilling.currency, orgLocale)}
                  </span>
                </p>
              ) : null}
            </section>
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
          {/* La atención se firmó igual: lo usado se registra después desde ella. */}
          {finalizedMaterials?.failed ? (
            <p role="alert" className="rounded-lg border border-warning/50 p-3 text-sm">
              No se pudieron descontar los materiales de {finalizedMaterials.branch.name}. Regístralos con
              «Corregir» en «Materiales usados» de esta atención, en Historia.
            </p>
          ) : null}
          {/* Mismo paso de cierre: casi siempre la persona sigue ahí y conviene que se lo lleve. */}
          {finalizedBudget && finalizedBudget.itemCount > 0 && canSendBudget ? (
            <section
              aria-label="Presupuesto listo"
              className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3"
            >
              <p className="text-sm">
                Presupuesto listo:{" "}
                {finalizedBudget.itemCount === 1
                  ? "1 tratamiento"
                  : `${finalizedBudget.itemCount} tratamientos`}
                {finalizedBudget.totalCents != null && orgLocale
                  ? ` por ${formatMoney(finalizedBudget.totalCents, finalizedBudget.currency, orgLocale)}`
                  : ""}
              </p>
              {budgetSent ? (
                <p role="status" className="text-sm font-medium">
                  Enviado. Queda «Enviado · espera respuesta» en su Plan.
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
                    <Button type="button" variant="ghost" onClick={closeFinalized}>
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
            <Button type="button" onClick={closeFinalized}>
              Listo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={voidOpen}
        title="Anular este borrador"
        description="Queda en la historia como «anulada» con tu nombre, la hora y el motivo. Se anulan sus diagnósticos, procedimientos, hallazgos, recetas y controles; no genera cargos. La cita, si la hay, puede volver a atenderse."
        confirmLabel="Anular borrador"
        pending={voiding}
        confirmDisabled={!voidReason.trim()}
        onConfirm={() => void handleVoid()}
        onClose={() => {
          if (!voiding) setVoidOpen(false)
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-void`}>Motivo</FieldLabel>
          <Textarea
            id={`${uid}-void`}
            rows={2}
            maxLength={2000}
            placeholder="Ej.: se abrió para el paciente equivocado"
            value={voidReason}
            onChange={(event) => setVoidReason(event.target.value)}
          />
        </Field>
      </ConfirmDialog>

      {profileOpen ? (
        <ProfessionalProfileDrawer
          open
          target="me"
          profile={profileQuery.data?.data ?? null}
          onClose={() => setProfileOpen(false)}
          onSaved={() => void refreshClosing()}
        />
      ) : null}
    </div>
  )
}
