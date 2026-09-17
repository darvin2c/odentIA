import {
  Badge,
  Button,
  ButtonGroup,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@odentia/ui"
import { ConfirmDialog } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { useCanWrite } from "../../lib/crm"
import {
  type Encounter,
  type EncounterDetail,
  encounterStatusLabel,
  hcLabel,
  type OdontogramState,
  type PatientFull,
} from "../../lib/patients"
import { OdontogramStudio } from "../odontogram-studio"
import { EncounterDiagnoses } from "./encounter-diagnoses"
import { EncounterPlanPanel } from "./encounter-plan-panel"
import { EncounterProcedures } from "./encounter-procedures"
import { ImagenesTab } from "./imagenes-tab"
import { PatientClinicalStrip } from "./patient-header"
import { ToothSelector } from "./tooth-selector"

export interface EncounterEditorProps {
  patientId: string
  detail: EncounterDetail
  patient: PatientFull
  /** Refresca el query del encounter (lo implementa la ruta). */
  onChanged: () => Promise<void>
  /** Invalida resumen/plan/timeline y navega a Historia (lo implementa la ruta). */
  onFinalized: () => Promise<void>
  /** Solo navega: el editor hace flush antes de llamarla. */
  onBack: () => void | Promise<void>
}
type DraftKey =
  | "reason"
  | "evolution"
  | "indications"
  | "nextStep"
  | "nextAppointmentAt"
  | "teeth"
  | "examination"

type SaveState = "saved" | "pending" | "saving" | "error"

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

interface DraftValues {
  reason: string
  evolution: string
  indications: string
  nextStep: string
  apptDate: string
  apptTime: string
  teeth: number[]
  examination: ExaminationDraft | null
}

interface DraftPatch {
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

function formatDateTime(iso: string | null): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" })
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

/** Identificador corto del odontólogo tratante (primeros 8 caracteres). */
export function dentistShortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
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
 * Editor guiado en 3 pasos (evaluación/diagnósticos, tratamientos-documentos,
 * evolución/cierre) con WizardSteps: los campos escalares se editan en un
 * FormDrawer hermano y cada registro vinculado vive en su propio drawer. Sin
 * inputs inline ni footer de formulario propio: guardar/volver/finalizar son
 * controles del paso de cierre, con revisión del trabajo registrado.
 */
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
  const canWrite = useCanWrite()
  const uid = useId()

  const [reason, setReason] = useState(encounter.reason ?? "")
  const [evolution, setEvolution] = useState(encounter.evolution ?? "")
  const [indications, setIndications] = useState(encounter.indications ?? "")
  const [nextStep, setNextStep] = useState(encounter.nextStep ?? "")
  const [teeth, setTeeth] = useState<number[]>(() => sortTeeth(detail.teeth))
  const [apptDate, setApptDate] = useState(() => toLocalDate(encounter.nextAppointmentAt))
  const [apptTime, setApptTime] = useState(() => toLocalTime(encounter.nextAppointmentAt))
  const [examination, setExamination] = useState<ExaminationDraft | null>(() =>
    toExaminationDraft(encounter.examination),
  )
  const [tab, setTab] = useState<"evaluacion" | "plan" | "realizado" | "evolucion">("evaluacion")

  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [saveError, setSaveError] = useState<string | null>(null)
  const [apptError, setApptError] = useState<string | null>(null)
  const [childCount, setChildCount] = useState(0)
  const [explicitSaving, setExplicitSaving] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [backing, setBacking] = useState(false)
  const [examOpen, setExamOpen] = useState(false)

  const valuesRef = useRef<DraftValues>({
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
      setTab("evolucion")
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

  const handleConfirmFinalize = async () => {
    if (finalizing || childCountRef.current > 0) return
    if (apptBlocked()) {
      setApptError(APPT_INCOMPLETE)
      setConfirmOpen(false)
      setTab("evolucion")
      return
    }
    setApptError(null)
    setFinalizing(true)
    try {
      // Congela: primero todo PATCH pendiente y último dirty, recién después finalize.
      await flush()
      await apiFetch<{ data: unknown }>(
        `/api/patients/${patientId}/encounters/${encounterId}/finalize`,
        {
          method: "POST",
          body: "{}",
        },
      )
      await onFinalized()
    } catch (err) {
      // Falla: se conserva el borrador intacto y se muestra el error real.
      if (mountedRef.current) {
        setSaveError(saveMessage(err, "No se pudo finalizar la atención."))
        setSaveState("error")
        setConfirmOpen(false)
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
      queryClient.invalidateQueries({ queryKey: ["plan", patientId] }),
    ])
  }

  const locked = !canWrite || childCount > 0 || finalizing || backing
  return (
    <div className="flex flex-col gap-4">
      <PatientClinicalStrip detail={patient} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{patient.patient.displayName}</h1>
          <p className="text-sm text-muted-foreground">
            {hcLabel(patient.patient.patientNumber)} · Odontólogo{" "}
            {dentistShortId(encounter.dentistUserId)}
          </p>
        </div>
        <Badge variant="outline">{encounterStatusLabel(encounter.status)}</Badge>
      </div>

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

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(24rem,32rem)]">
        <div className="min-w-0">
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
              encounterId={encounterId}
              onChanged={handleChildChanged}
              beforeWrite={flush}
              onPendingChange={handlePendingChange}
              disabled={locked}
              readOnly={!canWrite}
            />
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Motivo de la atención</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
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
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Piezas vinculadas ({teeth.length})
                </p>
                <ToothSelector value={teeth} onChange={editTeeth} disabled={locked} />
              </div>
            </CardContent>
          </Card>

          <Tabs
            value={tab}
            onValueChange={(v) => {
              if (v === "evaluacion" || v === "plan" || v === "realizado" || v === "evolucion")
                setTab(v)
            }}
          >
            <TabsList className="w-full" aria-label="Secciones de la atención">
              <TabsTrigger value="evaluacion">Evaluación</TabsTrigger>
              <TabsTrigger value="plan">Plan</TabsTrigger>
              <TabsTrigger value="realizado">Realizado</TabsTrigger>
              <TabsTrigger value="evolucion">Evolución</TabsTrigger>
            </TabsList>
            <TabsContent value="evaluacion" className="flex flex-col gap-4">
              <EncounterDiagnoses
                patientId={patientId}
                detail={detail}
                disabled={locked}
                beforeWrite={flush}
                onChanged={handleChildChanged}
                onPendingChange={handlePendingChange}
              />
              <Collapsible open={examOpen} onOpenChange={setExamOpen}>
                <Card>
                  <CardHeader className="pb-3">
                    <CollapsibleTrigger className="text-base font-semibold">
                      <span className="flex items-center gap-1">
                        Examen clínico <ChevronDown aria-hidden className="size-4" />
                      </span>
                    </CollapsibleTrigger>
                  </CardHeader>
                  <CollapsibleContent>
                    <CardContent className="grid gap-3 sm:grid-cols-2">
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
                          onChange={(e) =>
                            editExamination("intraoral", "carrillos", e.target.value)
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={`${uid}-ex-oro`}>Orofaringe</FieldLabel>
                        <Input
                          id={`${uid}-ex-oro`}
                          value={examination?.intraoral.orofaringe ?? ""}
                          disabled={locked}
                          onChange={(e) =>
                            editExamination("intraoral", "orofaringe", e.target.value)
                          }
                        />
                      </Field>
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
              <ImagenesTab
                patientId={patientId}
                encounterId={encounterId}
                beforeWrite={flush}
                onPendingChange={handlePendingChange}
                disabled={locked}
                readOnly={!canWrite}
                onUploaded={handleChildChanged}
              />
            </TabsContent>
            <TabsContent value="plan" className="flex flex-col gap-4">
              <EncounterPlanPanel
                patientId={patientId}
                encounterId={encounterId}
                disabled={locked}
                beforeWrite={flush}
                onChanged={handleChildChanged}
                onPendingChange={handlePendingChange}
              />
            </TabsContent>
            <TabsContent value="realizado" className="flex flex-col gap-4">
              <EncounterProcedures
                patientId={patientId}
                detail={detail}
                disabled={locked}
                beforeWrite={flush}
                onChanged={handleChildChanged}
                onPendingChange={handlePendingChange}
              />
            </TabsContent>
            <TabsContent value="evolucion" className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>Evolución e indicaciones</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <Field>
                    <FieldLabel htmlFor={`${uid}-evolution`}>
                      Evolución (máx. {MAX_EVOLUTION})
                    </FieldLabel>
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
                      <FieldLabel htmlFor={`${uid}-appt-date`}>
                        Fecha de revisión sugerida
                      </FieldLabel>
                      <Input
                        id={`${uid}-appt-date`}
                        type="date"
                        value={apptDate}
                        disabled={locked}
                        onChange={(event) => editApptDate(event.target.value)}
                      />
                    </Field>
                    <Field className="min-w-40 flex-1">
                      <FieldLabel htmlFor={`${uid}-appt-time`}>
                        Hora de revisión sugerida
                      </FieldLabel>
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
                    Seguimiento recomendado; no reserva una cita. Guarda fecha y hora juntas o
                    limpia ambas.
                  </p>
                </CardContent>
              </Card>
              {detail.addenda.length > 0 ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Adendas</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2">
                    {detail.addenda.map((note) => (
                      <p key={note.id} className="whitespace-pre-wrap text-sm">
                        {note.note}
                      </p>
                    ))}
                  </CardContent>
                </Card>
              ) : null}
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          Borrador: {SAVE_LABEL[saveState]}
          {childCount > 0 ? " · esperando registros vinculados…" : ""}
        </p>
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
            disabled={locked || explicitSaving}
            onClick={() => void handleBack()}
          >
            {backing ? "Guardando…" : "Volver"}
          </Button>
          <Button
            type="button"
            disabled={locked || explicitSaving || backing}
            onClick={() => setConfirmOpen(true)}
          >
            Finalizar atención
          </Button>
        </ButtonGroup>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Revisión para el cierre</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p>
            {detail.procedures.length} procedimiento(s) · {detail.notes.length} diagnóstico(s) ·{" "}
            {detail.odontogramEntries.length} hallazgo(s) de odontograma · {detail.documents.length}{" "}
            documento(s) ·{" "}
            {
              detail.plannedItems.filter(
                (item) => item.status === "pendiente" || item.status === "programado",
              ).length
            }{" "}
            tratamiento(s) vinculado(s) pendiente(s)
          </p>
          {!reason.trim() && (
            <p role="alert" className="text-destructive">
              Falta el motivo de la atención.
            </p>
          )}
          {!evolution.trim() &&
            detail.procedures.length === 0 &&
            detail.notes.length === 0 &&
            detail.odontogramEntries.length === 0 && (
              <p role="alert" className="text-destructive">
                Para cerrar registra evolución, un procedimiento, un diagnóstico o un hallazgo de
                odontograma.
              </p>
            )}
          <p className="text-xs text-muted-foreground">
            El cierre deja la atención inmutable y nunca acepta presupuestos automáticamente: los
            vinculados pendientes siguen su flujo en el presupuesto.
          </p>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        title="Finalizar atención"
        description="La atención quedará inmutable y ya no se podrá editar el borrador. Después solo se podrán agregar adendas. Esta acción no se puede deshacer."
        confirmLabel="Finalizar atención"
        variant="default"
        pending={finalizing}
        onConfirm={() => void handleConfirmFinalize()}
        onClose={() => {
          if (!finalizing) setConfirmOpen(false)
        }}
      />
    </div>
  )
}
