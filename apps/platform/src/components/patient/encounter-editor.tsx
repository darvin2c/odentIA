import { formatVitals, parseVitals, VITAL_SIGNS, type Vitals } from "@odentia/clinical"
import {
  Badge,
  Button,
  ButtonGroup,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import {
  ConfirmDialog,
  DetailDrawer,
  DetailPanel,
  FormDrawer,
  FormPanel,
  MasterDetail,
  useDetailMode,
} from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { fetchFollowUps, fetchPatientAccount, fetchPrescriptions } from "../../lib/clinical-journey"
import { useMemberName, useMyUserId, usePermission } from "../../lib/crm"
import {
  CLOSING_REQUIREMENT_LABELS,
  type ClosingRequirement,
  fetchEncounterClosing,
  fetchMyProfessionalProfile,
  registrationLabel,
  takeOverEncounterApi,
  voidEncounterApi,
} from "../../lib/encounters"
import {
  type Encounter,
  type EncounterDetail,
  encounterStatusLabel,
  hcLabel,
  type OdontogramState,
  type PatientFull,
} from "../../lib/patients"
import { formatMoney } from "../../lib/services"
import { OdontogramStudio } from "../odontogram-studio"
import { ProfessionalProfileDrawer } from "../professional-profile-drawer"
import { ChoiceSelect } from "../ui/choice-select"
import { ControlesPanel, RecetasPanel } from "./clinical-panels"
import { EncounterDiagnoses } from "./encounter-diagnoses"
import { EncounterPlanPanel } from "./encounter-plan-panel"
import { EncounterProcedures } from "./encounter-procedures"
import { EncounterTreatments } from "./encounter-treatments"
import { ImagenesTab } from "./imagenes-tab"
import { PatientClinicalStrip } from "./patient-header"

export interface EncounterEditorProps {
  patientId: string
  detail: EncounterDetail
  patient: PatientFull
  /** Refresca el query del encounter (lo implementa la ruta). */
  onChanged: () => Promise<void>
  /** Invalida resumen/plan/timeline y navega (cuenta si hubo cargos, historia si no). */
  onFinalized: (hasCharges: boolean) => Promise<void>
  /** Solo navega: el editor hace flush antes de llamarla. */
  onBack: () => void | Promise<void>
}
type DraftKey =
  | NoteKey
  | "vitals"
  | "reason"
  | "evolution"
  | "indications"
  | "nextStep"
  | "nextAppointmentAt"
  | "teeth"
  | "examination"

type SaveState = "saved" | "pending" | "saving" | "error"

/** Campos de texto de la nota normativa que se guardan tal cual (vacío = null). */
type NoteKey = "presentIllness" | "illnessDuration" | "prognosis" | "auxiliaryExams"

/**
 * Bloques que la atención puede llegar a tener. No son pasos: la consulta nace
 * solo con `consulta` y cada bloque se agrega cuando ocurre. Los que ya tienen
 * contenido registrado se siguen mostrando al recargar; los agregados vacíos se
 * descartan sin tocar datos.
 */
type SectionKey =
  | "consulta"
  | "hallazgos"
  | "examen"
  | "odontograma"
  | "procedimientos"
  | "plan"
  | "recetas"
  | "controles"
  | "documentos"
  | "evolucion"

/** Secciones cuyos campos son del propio borrador: se editan en un `FormPanel`. */
const FORM_SECTIONS: readonly SectionKey[] = ["consulta", "examen", "evolucion"]

interface ExaminationDraft {
  extraoral: { atm: string; ganglios: string; labios: string }
  intraoral: {
    encias: string
    lengua: string
    paladar: string
    pisoBoca: string
    carrillos: string
    orofaringe: string
  }
  higieneOral: string
}

interface DraftValues extends Record<NoteKey, string> {
  /** Signos vitales tal como se escriben; el servidor valida rango y unidad. */
  vitals: Record<string, string>
  reason: string
  evolution: string
  indications: string
  nextStep: string
  apptDate: string
  apptTime: string
  teeth: number[]
  examination: ExaminationDraft | null
}

interface DraftPatch extends Partial<Record<NoteKey, string | null>> {
  vitals?: Record<string, string> | null
  reason?: string | null
  evolution?: string | null
  indications?: string | null
  nextStep?: string | null
  nextAppointmentAt?: string | null
  teeth?: number[]
  examination?: {
    extraoral?: Record<string, string>
    intraoral?: Record<string, string>
    higieneOral?: string
  } | null
}

const AUTOSAVE_MS = 800
const MAX_REASON = 2000
const MAX_EVOLUTION = 10000
const MAX_INDICATIONS = 4000
const MAX_NEXT_STEP = 2000
const APPT_INCOMPLETE = "Completa fecha y hora de la revisión sugerida, o limpia ambas."

const SAVE_LABEL: Record<SaveState, string> = {
  saved: "Guardado",
  pending: "Cambios pendientes…",
  saving: "Guardando…",
  error: "Error al guardar",
}

function toLocalDate(iso: string | null): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function toLocalTime(iso: string | null): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

/** La cita solo se serializa con fecha+hora válidas, o null si ambas están vacías. */
function serializeAppt(
  date: string,
  time: string,
): { ok: true; value: string | null } | { ok: false } {
  if (!date && !time) return { ok: true, value: null }
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time)
  if (!dateMatch || !timeMatch) return { ok: false }
  const year = Number(dateMatch[1])
  const month = Number(dateMatch[2])
  const day = Number(dateMatch[3])
  const hour = Number(timeMatch[1])
  const minute = Number(timeMatch[2])
  const local = new Date(year, month - 1, day, hour, minute, 0, 0)
  if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) {
    return { ok: false }
  }
  return { ok: true, value: local.toISOString() }
}

function sortTeeth(teeth: number[]): number[] {
  return [...teeth].sort((a, b) => a - b)
}
function strMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string" && raw.trim() !== "") out[key] = raw
  }
  return out
}

/** Examen persistido a borrador editable (sin copiar exámenes antiguos a consultas nuevas: cada atención parte en null). */
/** Signos vitales guardados como texto editable. */
function vitalsDraft(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {}
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => typeof value === "number")
      .map(([key, value]) => [key, String(value)]),
  )
}

function toExaminationDraft(examination: Encounter["examination"]): ExaminationDraft | null {
  if (!examination || typeof examination !== "object") return null
  const extraoral = strMap((examination as Record<string, unknown>).extraoral)
  const intraoral = strMap((examination as Record<string, unknown>).intraoral)
  const higiene = (examination as Record<string, unknown>).higieneOral
  const draft: ExaminationDraft = {
    extraoral: {
      atm: extraoral.atm ?? "",
      ganglios: extraoral.ganglios ?? "",
      labios: extraoral.labios ?? "",
    },
    intraoral: {
      encias: intraoral.encias ?? "",
      lengua: intraoral.lengua ?? "",
      paladar: intraoral.paladar ?? "",
      pisoBoca: intraoral.pisoBoca ?? "",
      carrillos: intraoral.carrillos ?? "",
      orofaringe: intraoral.orofaringe ?? "",
    },
    higieneOral: typeof higiene === "string" ? higiene : "",
  }
  const empty =
    Object.values(draft.extraoral).every((v) => v === "") &&
    Object.values(draft.intraoral).every((v) => v === "") &&
    draft.higieneOral === ""
  return empty ? null : draft
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
function formatClock(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" })
}

export function EncounterEditor({
  patientId,
  detail,
  patient,
  onChanged,
  onFinalized,
  onBack,
}: EncounterEditorProps): React.JSX.Element {
  const encounter = detail.encounter
  const encounterId = encounter.id
  const queryClient = useQueryClient()
  const canWrite = usePermission("clinical.write")
  const canRead = usePermission("clinical.read")
  const canReadFinance = usePermission("finance.read")
  const memberName = useMemberName()
  const uid = useId()
  const accountQuery = useQuery({
    queryKey: ["patient-account", patientId],
    queryFn: () => fetchPatientAccount(patientId),
    enabled: canReadFinance,
  })

  const [reason, setReason] = useState(encounter.reason ?? "")
  const [notes, setNotes] = useState<Record<NoteKey, string>>(() => ({
    presentIllness: encounter.presentIllness ?? "",
    illnessDuration: encounter.illnessDuration ?? "",
    prognosis: encounter.prognosis ?? "",
    auxiliaryExams: encounter.auxiliaryExams ?? "",
  }))
  const [vitals, setVitals] = useState<Record<string, string>>(() => vitalsDraft(encounter.vitals))
  const parsed = parseVitals(vitals)
  const parsedVitals: Vitals | null = parsed.ok ? parsed.value : null
  const [evolution, setEvolution] = useState(encounter.evolution ?? "")
  const [indications, setIndications] = useState(encounter.indications ?? "")
  const [nextStep, setNextStep] = useState(encounter.nextStep ?? "")
  const [teeth, setTeeth] = useState<number[]>(() => sortTeeth(detail.teeth))
  const [apptDate, setApptDate] = useState(() => toLocalDate(encounter.nextAppointmentAt))
  const [apptTime, setApptTime] = useState(() => toLocalTime(encounter.nextAppointmentAt))
  const [examination, setExamination] = useState<ExaminationDraft | null>(() =>
    toExaminationDraft(encounter.examination),
  )
  // Bloque en edición; `null` colapsa el detalle y deja la lista a todo el ancho.
  const [openSection, setOpenSection] = useState<SectionKey | null>("consulta")
  const [addedSections, setAddedSections] = useState<ReadonlySet<SectionKey>>(() => new Set())

  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [saveError, setSaveError] = useState<string | null>(null)
  const [apptError, setApptError] = useState<string | null>(null)
  const [childCount, setChildCount] = useState(0)
  const [explicitSaving, setExplicitSaving] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [backing, setBacking] = useState(false)
  // Hora de fin declarada al cerrar (HH:MM local); vacía = ahora.
  const [endTime, setEndTime] = useState("")
  const [voidOpen, setVoidOpen] = useState(false)
  const [voidReason, setVoidReason] = useState("")
  const [voiding, setVoiding] = useState(false)
  const [takingOver, setTakingOver] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const myUserId = useMyUserId()
  // Quien lleva la atención es quien la edita y la firma; otro profesional la
  // lee y, para continuarla, toma el relevo.
  const attending = encounter.dentistUserId === myUserId
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
    auxiliaryExams: encounter.auxiliaryExams ?? "",
    vitals: vitalsDraft(encounter.vitals),
    reason: encounter.reason ?? "",
    evolution: encounter.evolution ?? "",
    indications: encounter.indications ?? "",
    nextStep: encounter.nextStep ?? "",
    apptDate: toLocalDate(encounter.nextAppointmentAt),
    apptTime: toLocalTime(encounter.nextAppointmentAt),
    teeth: sortTeeth(detail.teeth),
    examination: toExaminationDraft(encounter.examination),
  })
  const dirtyRef = useRef<Set<DraftKey>>(new Set())
  const inflightRef = useRef<Set<DraftKey>>(new Set())
  const drainRef = useRef<Promise<void> | null>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const mountedRef = useRef(true)
  const childCountRef = useRef(0)
  const latestWriteAtRef = useRef(new Date(encounter.updatedAt).getTime())

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      window.clearTimeout(timerRef.current)
    }
  }, [])

  const dentalQuery = useQuery({
    queryKey: ["odontogram", patientId],
    queryFn: () => apiFetch<{ data: OdontogramState }>(`/api/patients/${patientId}/odontogram`),
    enabled: canRead,
  })
  const branchesQuery = useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Array<{ id: string; name: string }> }>("/api/branches"),
    enabled: canRead,
  })
  // Recetas y controles no vienen en el detalle: se cuentan por atención para
  // saber si el bloque ya tiene contenido y debe seguir visible.
  const prescriptionsQuery = useQuery({
    queryKey: ["prescriptions", patientId],
    queryFn: () => fetchPrescriptions(patientId),
    enabled: canRead,
  })
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
        case "auxiliaryExams":
          body[key] = values[key].trim() === "" ? null : values[key]
          break
        case "vitals": {
          const filled = Object.fromEntries(
            Object.entries(values.vitals).filter(([, raw]) => raw.trim() !== ""),
          )
          // Incompletos o fuera de rango no se envían: el error se muestra en línea
          // y se guardan al corregirlos.
          if (!parseVitals(filled).ok) break
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
        case "nextStep":
          body.nextStep = values.nextStep === "" ? null : values.nextStep
          break
        case "teeth":
          body.teeth = [...values.teeth]
          break
        case "examination": {
          const exam = values.examination
          if (!exam) {
            body.examination = null
            break
          }
          const pick = (group: Record<string, string>): Record<string, string> | undefined => {
            const cleaned: Record<string, string> = {}
            for (const [key, raw] of Object.entries(group)) {
              const trimmed = raw.trim()
              if (trimmed) cleaned[key] = trimmed
            }
            return Object.keys(cleaned).length > 0 ? cleaned : undefined
          }
          const extraoral = pick(exam.extraoral)
          const intraoral = pick(exam.intraoral)
          const higieneOral = exam.higieneOral === "" ? undefined : exam.higieneOral
          body.examination =
            extraoral || intraoral || higieneOral ? { extraoral, intraoral, higieneOral } : null
          break
        }
        case "nextAppointmentAt": {
          const serialized = serializeAppt(values.apptDate, values.apptTime)
          if (serialized.ok) body.nextAppointmentAt = serialized.value
          break
        }
      }
    }
    return body
  }

  /** Un solo drenado serializado: toma los dirty, los envía y repite si llegaron más. */
  const drain = (): Promise<void> => {
    if (drainRef.current) return drainRef.current
    const run = (async () => {
      try {
        if (mountedRef.current) setSaveState("saving")
        for (;;) {
          if (dirtyRef.current.size === 0) break
          const keys = [...dirtyRef.current]
          dirtyRef.current.clear()
          const sendable = keys.filter((key) => {
            if (
              key === "nextAppointmentAt" &&
              !serializeAppt(valuesRef.current.apptDate, valuesRef.current.apptTime).ok
            ) {
              dirtyRef.current.add(key)
              return false
            }
            return true
          })
          if (sendable.length === 0) break
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
        }
      } catch (err) {
        if (mountedRef.current) {
          setSaveError(saveMessage(err, "No se pudo guardar el borrador."))
          setSaveState("error")
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

  const hasSendableDirty = (): boolean => {
    for (const key of dirtyRef.current) {
      if (key !== "nextAppointmentAt") return true
      if (serializeAppt(valuesRef.current.apptDate, valuesRef.current.apptTime).ok) return true
    }
    return false
  }

  /** Barrera de escritura: la consumen hijos, guardado, finalizar y volver. */
  const flush = async (): Promise<void> => {
    clearTimer()
    for (;;) {
      await drain()
      if (!hasSendableDirty()) {
        if (dirtyRef.current.has("nextAppointmentAt")) {
          if (mountedRef.current) setApptError(APPT_INCOMPLETE)
          throw new Error(APPT_INCOMPLETE)
        }
        return
      }
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

  const blankExamination = (): ExaminationDraft => ({
    extraoral: { atm: "", ganglios: "", labios: "" },
    intraoral: { encias: "", lengua: "", paladar: "", pisoBoca: "", carrillos: "", orofaringe: "" },
    higieneOral: "",
  })

  const editExamination = (group: "extraoral" | "intraoral", key: string, value: string) => {
    const prev = valuesRef.current.examination ?? blankExamination()
    const next: ExaminationDraft = { ...prev, [group]: { ...prev[group], [key]: value } }
    valuesRef.current.examination = next
    setExamination(next)
    markEdited("examination")
  }

  const editHigieneOral = (value: string) => {
    const prev = valuesRef.current.examination ?? blankExamination()
    const next: ExaminationDraft = { ...prev, higieneOral: value }
    valuesRef.current.examination = next
    setExamination(next)
    markEdited("examination")
  }
  const editNextStep = (value: string) => {
    valuesRef.current.nextStep = value
    setNextStep(value)
    markEdited("nextStep")
  }
  const editApptDate = (value: string) => {
    valuesRef.current.apptDate = value
    setApptDate(value)
    setApptError(null)
    markEdited("nextAppointmentAt")
  }

  const editApptTime = (value: string) => {
    valuesRef.current.apptTime = value
    setApptTime(value)
    setApptError(null)
    markEdited("nextAppointmentAt")
  }

  const apptBlocked = (): boolean => {
    const values = valuesRef.current
    if (!values.apptDate && !values.apptTime) return false
    return !serializeAppt(values.apptDate, values.apptTime).ok
  }

  /** Control de página: guarda el borrador (flush + refresh) sin formulario. */
  const handleSaveDraft = async () => {
    if (explicitSaving || finalizing || backing || childCountRef.current > 0) return
    if (apptBlocked()) {
      setApptError(APPT_INCOMPLETE)
      setOpenSection("evolucion")
      return
    }
    setApptError(null)
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

  /** Hora de fin declarada: hoy a la hora indicada, en la zona del navegador. */
  const endedAtIso = (): string | null => {
    if (!endTime) return null
    const [hours, minutes] = endTime.split(":").map(Number)
    const at = new Date()
    at.setHours(hours ?? 0, minutes ?? 0, 0, 0)
    return at.toISOString()
  }

  const handleVoid = async () => {
    if (voiding || !voidReason.trim()) return
    setVoiding(true)
    clearTimer()
    try {
      await voidEncounterApi(patientId, encounterId, voidReason.trim())
      setVoidOpen(false)
      await queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
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
      await onChanged()
      await refreshClosing()
    } catch (err) {
      setSaveError(saveMessage(err, "No se pudo tomar el relevo."))
    } finally {
      if (mountedRef.current) setTakingOver(false)
    }
  }

  const handleConfirmFinalize = async () => {
    if (finalizing || childCountRef.current > 0) return
    if (apptBlocked()) {
      setApptError(APPT_INCOMPLETE)
      setConfirmOpen(false)
      setOpenSection("evolucion")
      return
    }
    setApptError(null)
    setFinalizing(true)
    try {
      // Congela: primero todo PATCH pendiente y último dirty, recién después finalize.
      await flush()
      const endedAt = endedAtIso()
      const result = await apiFetch<{
        data: { charges: Array<{ id: string }> }
      }>(`/api/patients/${patientId}/encounters/${encounterId}/finalize`, {
        method: "POST",
        body: JSON.stringify(endedAt ? { endedAt } : {}),
      })
      await onFinalized(result.data.charges.length > 0)
    } catch (err) {
      // Falla: se conserva el borrador intacto y se muestra el error real.
      if (mountedRef.current) {
        setSaveError(saveMessage(err, "No se pudo finalizar la atención."))
        setSaveState("error")
        setConfirmOpen(false)
        void refreshClosing()
      }
    } finally {
      if (mountedRef.current) setFinalizing(false)
    }
  }

  const handleBack = async () => {
    if (backing || finalizing || childCountRef.current > 0) return
    setBacking(true)
    try {
      await flush()
      await onBack()
    } catch (err) {
      if (mountedRef.current) {
        setSaveError(saveMessage(err, "No se pudo guardar el borrador."))
        setSaveState("error")
      }
    } finally {
      if (mountedRef.current) setBacking(false)
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
      refreshClosing(),
    ])
  }

  // Una sola tarifa por tratamiento; los cargos activos ya emitidos lo cubren.
  const coveredItems = new Set(
    (accountQuery.data?.data.charges ?? [])
      .filter((charge) => !charge.voidedAt && charge.planItemId)
      .map((charge) => charge.planItemId),
  )
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
    .map(([currency, cents]) => formatMoney(cents, currency))
    .join(" · ")

  const mode = useDetailMode()

  const locked = !canWrite || !attending || childCount > 0 || finalizing || backing || voiding

  const prescriptions = (prescriptionsQuery.data?.data ?? []).filter(
    (row) => row.encounterId === encounterId,
  )
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
  const activeDiagnoses = (detail.diagnoses ?? []).filter((dx) => !dx.voidedAt).length
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
      description: "Motivo, enfermedad actual, sucursal y piezas evaluadas.",
      summary: reason.trim() === "" ? "Sin motivo registrado" : reason.trim(),
      empty: reason.trim() === "",
    },
    {
      key: "examen",
      title: "Examen clínico",
      description: "Signos vitales, examen extraoral, intraoral e higiene oral.",
      summary:
        [formatVitals(parsedVitals), examination ? "Examen registrado" : ""]
          .filter(Boolean)
          .join(" · ") || "Sin examen registrado",
      empty: examination === null && Object.values(vitals).every((v) => v.trim() === ""),
    },
    {
      key: "odontograma",
      title: "Odontograma",
      description: "Hallazgos por pieza sobre el odontograma del paciente.",
      summary:
        detail.odontogramEntries.length === 0
          ? "Sin hallazgos en esta atención"
          : `${detail.odontogramEntries.length} hallazgo(s) de esta atención`,
      empty: detail.odontogramEntries.length === 0,
    },
    {
      key: "hallazgos",
      title: "Diagnóstico",
      description: "Diagnósticos CIE-10 con su tipo y pieza. Al menos uno para cerrar.",
      summary:
        activeDiagnoses === 0
          ? "Sin diagnósticos registrados"
          : `${activeDiagnoses} diagnóstico(s) registrado(s)`,
      empty: activeDiagnoses === 0,
    },
    {
      key: "procedimientos",
      title: "Procedimientos",
      description: "Actos ejecutados hoy, con su prestación y tarifa. Se anulan con motivo.",
      summary:
        activeProcedures === 0
          ? "Sin procedimientos registrados"
          : `${activeProcedures} procedimiento(s) registrado(s)`,
      empty: detail.procedures.length === 0,
    },
    {
      key: "plan",
      title: "Plan de tratamiento",
      description:
        "Indicaciones propuestas y tratamientos vinculados. Indicar no ejecuta ni cobra.",
      summary:
        detail.indicatedItems.length === 0 && detail.plannedItems.length === 0
          ? "Sin indicaciones"
          : `${detail.indicatedItems.length} indicación(es) · ${pendingTreatments} por ejecutar`,
      empty: detail.indicatedItems.length === 0 && detail.plannedItems.length === 0,
    },
    {
      key: "recetas",
      title: "Recetas",
      description: "Prescripciones emitidas en esta atención.",
      summary: prescriptions.length === 0 ? "Sin recetas" : `${prescriptions.length} receta(s)`,
      empty: prescriptions.length === 0,
    },
    {
      key: "controles",
      title: "Controles",
      description: "Controles y mantenimientos indicados desde esta atención.",
      summary: followUps.length === 0 ? "Sin controles" : `${followUps.length} control(es)`,
      empty: followUps.length === 0,
    },
    {
      key: "documentos",
      title: "Documentos",
      description: "Radiografías, imágenes y documentos de la atención.",
      summary:
        detail.documents.length === 0
          ? "Sin documentos"
          : `${detail.documents.length} documento(s)`,
      empty: detail.documents.length === 0,
    },
    {
      key: "evolucion",
      title: "Evolución, pronóstico e indicaciones",
      description:
        "Exámenes auxiliares, pronóstico, evolución (obligatoria para cerrar), indicaciones y seguimiento.",
      summary:
        evolution.trim() === "" && indications.trim() === "" && nextStep.trim() === ""
          ? "Sin evolución registrada"
          : "Evolución registrada",
      empty: evolution.trim() === "" && indications.trim() === "" && nextStep.trim() === "",
    },
  ]

  // Antes de cerrar: qué queda registrado y qué no, con los mismos resúmenes
  // que ve el clínico en cada bloque.
  const missing = closingQuery.data?.data.missing ?? []
  const closingReady = closingQuery.data?.data.ready === true
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

  const includedSections = sections.filter(
    (section) => section.key === "consulta" || !section.empty || addedSections.has(section.key),
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
    // Los campos escalares son del editor: cerrar no descarta nada y el
    // autosave sigue vivo. El flush evita dejar un cambio a medias.
    void flush().catch(() => {})
  }

  const submitSection = (event: React.FormEvent) => {
    event.preventDefault()
    void handleSaveDraft()
  }

  const consultaBody = (
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor={`${uid}-branch`}>Sucursal de la atención</FieldLabel>
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
              setSaveError(saveMessage(err, "No se pudo guardar la sucursal."))
            } finally {
              handlePendingChange(false)
            }
          }}
        >
          <option value="">Sin sucursal asignada</option>
          {(branchesQuery.data?.data ?? []).map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </ChoiceSelect>
        {branchesQuery.isError && <p role="alert">No se pudieron cargar las sucursales.</p>}
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-reason`}>Motivo (máx. {MAX_REASON})</FieldLabel>
        <Textarea
          id={`${uid}-reason`}
          rows={2}
          value={reason}
          disabled={locked}
          maxLength={MAX_REASON}
          placeholder="Motivo de la consulta…"
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
    </div>
  )

  const examenBody = (
    <div className="grid gap-3 sm:grid-cols-2">
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0 sm:col-span-2">
        <legend className="mb-1 text-sm font-medium">Signos vitales</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {VITAL_SIGNS.map((sign) => (
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
      </fieldset>
      <Field>
        <FieldLabel htmlFor={`${uid}-ex-atm`}>ATM</FieldLabel>
        <Input
          id={`${uid}-ex-atm`}
          value={examination?.extraoral.atm ?? ""}
          disabled={locked}
          onChange={(e) => editExamination("extraoral", "atm", e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-ex-ganglios`}>Ganglios</FieldLabel>
        <Input
          id={`${uid}-ex-ganglios`}
          value={examination?.extraoral.ganglios ?? ""}
          disabled={locked}
          onChange={(e) => editExamination("extraoral", "ganglios", e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-ex-labios`}>Labios</FieldLabel>
        <Input
          id={`${uid}-ex-labios`}
          value={examination?.extraoral.labios ?? ""}
          disabled={locked}
          onChange={(e) => editExamination("extraoral", "labios", e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-ex-higiene`}>Higiene oral</FieldLabel>
        <Select
          value={examination?.higieneOral ?? ""}
          onValueChange={(v) => editHigieneOral(v ?? "")}
          disabled={locked}
        >
          <SelectTrigger id={`${uid}-ex-higiene`}>
            <SelectValue placeholder="Sin indicar" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Sin indicar</SelectItem>
            <SelectItem value="buena">Buena</SelectItem>
            <SelectItem value="regular">Regular</SelectItem>
            <SelectItem value="mala">Mala</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-ex-encias`}>Encías</FieldLabel>
        <Input
          id={`${uid}-ex-encias`}
          value={examination?.intraoral.encias ?? ""}
          disabled={locked}
          onChange={(e) => editExamination("intraoral", "encias", e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-ex-lengua`}>Lengua</FieldLabel>
        <Input
          id={`${uid}-ex-lengua`}
          value={examination?.intraoral.lengua ?? ""}
          disabled={locked}
          onChange={(e) => editExamination("intraoral", "lengua", e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-ex-paladar`}>Paladar</FieldLabel>
        <Input
          id={`${uid}-ex-paladar`}
          value={examination?.intraoral.paladar ?? ""}
          disabled={locked}
          onChange={(e) => editExamination("intraoral", "paladar", e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-ex-piso`}>Piso de boca</FieldLabel>
        <Input
          id={`${uid}-ex-piso`}
          value={examination?.intraoral.pisoBoca ?? ""}
          disabled={locked}
          onChange={(e) => editExamination("intraoral", "pisoBoca", e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-ex-carrillos`}>Carrillos</FieldLabel>
        <Input
          id={`${uid}-ex-carrillos`}
          value={examination?.intraoral.carrillos ?? ""}
          disabled={locked}
          onChange={(e) => editExamination("intraoral", "carrillos", e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-ex-oro`}>Orofaringe</FieldLabel>
        <Input
          id={`${uid}-ex-oro`}
          value={examination?.intraoral.orofaringe ?? ""}
          disabled={locked}
          onChange={(e) => editExamination("intraoral", "orofaringe", e.target.value)}
        />
      </Field>
    </div>
  )

  const evolucionBody = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <Field>
          <FieldLabel htmlFor={`${uid}-aux-exams`}>Exámenes auxiliares</FieldLabel>
          <Textarea
            id={`${uid}-aux-exams`}
            rows={2}
            value={notes.auxiliaryExams}
            disabled={locked}
            maxLength={4000}
            placeholder="Solicitados o con resultado (radiografías, laboratorio…)"
            onChange={(event) => editNote("auxiliaryExams", event.target.value)}
          />
        </Field>
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
          <FieldLabel htmlFor={`${uid}-evolution`}>Evolución (máx. {MAX_EVOLUTION})</FieldLabel>
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
          <FieldLabel htmlFor={`${uid}-indications`}>
            Indicaciones (máx. {MAX_INDICATIONS})
          </FieldLabel>
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
        <Field>
          <FieldLabel htmlFor={`${uid}-next-step`}>
            Paso siguiente (máx. {MAX_NEXT_STEP})
          </FieldLabel>
          <Textarea
            id={`${uid}-next-step`}
            rows={2}
            value={nextStep}
            disabled={locked}
            maxLength={MAX_NEXT_STEP}
            placeholder="Paso siguiente del tratamiento…"
            onChange={(event) => editNextStep(event.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-3">
          <Field className="min-w-40 flex-1">
            <FieldLabel htmlFor={`${uid}-appt-date`}>Fecha de revisión sugerida</FieldLabel>
            <Input
              id={`${uid}-appt-date`}
              type="date"
              value={apptDate}
              disabled={locked}
              onChange={(event) => editApptDate(event.target.value)}
            />
          </Field>
          <Field className="min-w-40 flex-1">
            <FieldLabel htmlFor={`${uid}-appt-time`}>Hora de revisión sugerida</FieldLabel>
            <Input
              id={`${uid}-appt-time`}
              type="time"
              value={apptTime}
              disabled={locked}
              onChange={(event) => editApptTime(event.target.value)}
            />
          </Field>
        </div>
        {apptError ? (
          <p role="alert" className="text-sm text-destructive">
            {apptError}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Seguimiento recomendado; no reserva una cita. Guarda fecha y hora juntas o limpia ambas.
        </p>
      </div>
    </div>
  )

  const sectionBody: Record<SectionKey, React.ReactNode> = {
    consulta: consultaBody,
    hallazgos: (
      <EncounterDiagnoses
        patientId={patientId}
        detail={detail}
        disabled={locked}
        beforeWrite={flush}
        onChanged={handleChildChanged}
        onPendingChange={handlePendingChange}
      />
    ),
    examen: examenBody,
    odontograma: (
      <div className="flex min-w-0 flex-col gap-3">
        {dentalQuery.isLoading && (
          <p className="text-sm text-muted-foreground">Cargando odontograma…</p>
        )}
        {dentalQuery.isError && (
          <p role="alert" className="text-sm text-destructive">
            {dentalQuery.error instanceof ApiError && dentalQuery.error.shape.message
              ? dentalQuery.error.shape.message
              : "No se pudo cargar el odontograma."}
          </p>
        )}
        {dentalQuery.data && (
          <OdontogramStudio
            patientId={patientId}
            state={dentalQuery.data.data}
            compact
            birthDate={patient.patient.birthDate}
            encounterId={encounterId}
            onChanged={handleChildChanged}
            beforeWrite={flush}
            onPendingChange={handlePendingChange}
            disabled={locked}
            readOnly={!canWrite}
          />
        )}
      </div>
    ),
    procedimientos: (
      <div className="flex flex-col gap-4">
        <EncounterProcedures
          patientId={patientId}
          detail={detail}
          disabled={locked}
          beforeWrite={flush}
          onChanged={handleChildChanged}
          onPendingChange={handlePendingChange}
        />
        <EncounterTreatments
          patientId={patientId}
          encounterId={encounterId}
          items={detail.plannedItems}
          disabled={locked}
          beforeWrite={flush}
          onChanged={handleChildChanged}
        />
      </div>
    ),
    plan: (
      <EncounterPlanPanel
        patientId={patientId}
        encounterId={encounterId}
        disabled={locked}
        beforeWrite={flush}
        onChanged={handleChildChanged}
        onPendingChange={handlePendingChange}
      />
    ),
    recetas: (
      <RecetasPanel
        patientId={patientId}
        encounterId={encounterId}
        encounterOnly
        items={attentionItems}
      />
    ),
    controles: (
      <ControlesPanel
        patientId={patientId}
        encounterId={encounterId}
        encounterOnly
        items={attentionItems}
      />
    ),
    documentos: (
      <ImagenesTab
        patientId={patientId}
        encounterId={encounterId}
        beforeWrite={flush}
        onPendingChange={handlePendingChange}
        disabled={locked}
        readOnly={!canWrite}
        onUploaded={handleChildChanged}
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
    const body = sectionBody[openSection]
    if (FORM_SECTIONS.includes(openSection)) {
      const form = {
        ...surface,
        children: body,
        onSubmit: submitSection,
        isSubmitting: explicitSaving,
        error: saveError,
        submitLabel: "Guardar",
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

  return (
    <div className="flex flex-col gap-4">
      <PatientClinicalStrip detail={patient} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{patient.patient.displayName}</h1>
          <p className="text-sm text-muted-foreground">
            {hcLabel(patient.patient.patientNumber)} · Atiende {memberName(encounter.dentistUserId)}
            {encounter.startedAt ? ` · Inicio ${formatClock(encounter.startedAt)}` : ""}
            {encounter.appointmentId ? " · Desde la cita de agenda" : ""}
          </p>
        </div>
        <Badge variant="outline">{encounterStatusLabel(encounter.status)}</Badge>
      </div>

      {canWrite && !attending ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4"
        >
          <p className="text-sm">
            Esta atención la lleva {memberName(encounter.dentistUserId)}. Puedes leerla; para
            continuarla y firmarla, toma el relevo (queda registrado).
          </p>
          <Button type="button" disabled={takingOver} onClick={() => void handleTakeOver()}>
            {takingOver ? "Tomando el relevo…" : "Tomar el relevo"}
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          Borrador: {SAVE_LABEL[saveState]}
        </p>
        {childCount > 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            Registrando dato vinculado…
          </p>
        )}
      </div>
      {saveError && (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      )}
      {!canWrite && (
        <p className="text-sm text-muted-foreground">
          Solo lectura: no tienes permiso para editar este borrador.
        </p>
      )}

      <MasterDetail panelSize="xl" panel={mode === "panel" ? sectionDetail("panel") : null}>
        <div className="flex flex-col gap-4">
          {includedSections.map((section) => (
            <section
              key={section.key}
              aria-label={section.title}
              className="flex flex-wrap items-start justify-between gap-3 rounded-sm bg-card p-6"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <h2 className="font-heading text-base font-medium">{section.title}</h2>
                <p className="text-sm text-muted-foreground">{section.summary}</p>
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
                {section.key !== "consulta" && section.empty ? (
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
            </section>
          ))}
        </div>

        {availableSections.length > 0 ? (
          <section
            aria-label="Agregar a la atención"
            className="flex flex-col gap-3 rounded-sm bg-card p-6"
          >
            <div className="flex flex-col gap-1">
              <h2 className="font-heading text-base font-medium">Agregar según lo que ocurrió</h2>
              <p className="text-sm text-muted-foreground">
                Para cerrar bastan el motivo, un diagnóstico y la evolución; el resto se agrega
                cuando ocurre, en el orden de la historia clínica.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {availableSections.map((section) => (
                <Button
                  key={section.key}
                  type="button"
                  size="sm"
                  variant="outline"
                  title={section.description}
                  onClick={() => addSection(section.key)}
                >
                  Agregar {section.title}
                </Button>
              ))}
            </div>
          </section>
        ) : null}

        <section
          aria-label="Cierre de la atención"
          className="flex flex-col gap-4 rounded-sm bg-card p-6"
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
                      {CLOSING_REQUIREMENT_LABELS[requirement]}
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
          {closingQuery.isError ? (
            <p role="alert" className="text-sm text-destructive">
              No se pudo comprobar lo que falta para cerrar.
            </p>
          ) : null}
          <div className="flex flex-col gap-2 text-sm">
            <p className="text-muted-foreground">
              {activeProcedures} procedimiento(s) · {activeDiagnoses} diagnóstico(s) ·{" "}
              {detail.odontogramEntries.length} hallazgo(s) de odontograma ·{" "}
              {detail.documents.length} documento(s) · {pendingTreatments} tratamiento(s) por
              ejecutar
            </p>
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
                Los actos con tarifa generan sus cargos al cerrar; caja los gestiona.
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
              Anular borrador…
            </Button>
            <ButtonGroup aria-label="Acciones de la atención">
              <Button
                type="button"
                variant="outline"
                disabled={locked || explicitSaving}
                onClick={() => void handleSaveDraft()}
              >
                {explicitSaving ? "Guardando…" : "Guardar borrador"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={backing || finalizing || explicitSaving || childCount > 0}
                onClick={() => void handleBack()}
              >
                {backing ? "Guardando…" : "Volver"}
              </Button>
              <Button
                type="button"
                disabled={locked || explicitSaving || backing || !closingReady}
                onClick={() => {
                  setEndTime("")
                  setConfirmOpen(true)
                }}
              >
                Finalizar atención
              </Button>
            </ButtonGroup>
          </div>
          {!closingReady && closingQuery.isSuccess ? (
            <p className="text-xs text-muted-foreground">
              Completa lo pendiente para poder cerrar.
            </p>
          ) : null}
        </section>
      </MasterDetail>

      {mode === "drawer" ? sectionDetail("drawer") : null}

      <ConfirmDialog
        open={confirmOpen}
        title="Finalizar y firmar la atención"
        description={finalizeDescription}
        confirmLabel="Finalizar y firmar"
        variant="default"
        pending={finalizing}
        onConfirm={() => void handleConfirmFinalize()}
        onClose={() => {
          if (!finalizing) setConfirmOpen(false)
        }}
      >
        <p className="text-sm">
          Firmarás como{" "}
          <strong>
            {profileQuery.data?.data.signatureName ?? profileQuery.data?.data.accountName ?? "—"}
          </strong>
          {profileQuery.data ? ` · ${profileQuery.data.data.professionalTitle}` : ""}
          {profileQuery.data && registrationLabel(profileQuery.data.data)
            ? ` · ${registrationLabel(profileQuery.data.data)}`
            : ""}
        </p>
        <Field>
          <FieldLabel htmlFor={`${uid}-ended`}>Hora de fin</FieldLabel>
          <Input
            id={`${uid}-ended`}
            type="time"
            className="w-36"
            value={endTime}
            onChange={(event) => setEndTime(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">Vacía: se registra la hora actual.</p>
        </Field>
      </ConfirmDialog>

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
