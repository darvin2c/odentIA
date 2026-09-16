import {
  conditionLabel as clinicalConditionLabel,
  surfaceLabel as clinicalSurfaceLabel,
  FINDINGS,
  type FindingDetails,
  type FindingInput,
  findingAbbreviation,
  findingDefinition,
  surfacesForTooth,
  toothNameOf,
  toothTypeOf,
  validateFinding,
} from "@odentia/clinical"
import {
  Badge,
  Button,
  Checkbox,
  Field,
  FieldLabel,
  Input,
  ScrollArea,
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
import { FormDrawer } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useMemo, useState } from "react"
import { ApiError, apiFetch } from "../lib/api"
import { createTreatmentPlanApi, fetchTreatmentPlans } from "../lib/budgets"
import { timeAgo, useCanWrite } from "../lib/crm"
import {
  type OdontogramEntry,
  type PatientDocument,
  type PlanItem,
  planStatusLabel,
  statusLabel,
  toothTypeLabel,
} from "../lib/patients"
import { formatMoney, type ServiceCatalogItem } from "../lib/services"
import { Cie10Search } from "./patient/cie10-search"
import { ServicePicker } from "./patient/service-picker"
import { ToothSVG } from "./tooth-svg"

/** Las URL firmadas expiran: se consideran frescas 10 min y luego se regeneran. */
const SIGNED_URL_STALE_MS = 10 * 60 * 1000

const OPEN_PLAN_STATUSES: readonly string[] = ["pendiente", "programado"]

/** Cabecera compacta: evita un título gigante cuando se seleccionan muchas piezas. */
const MAX_HEAD_TEETH = 8

const QUALITY_LABELS: Record<string, string> = {
  good: "Buen estado",
  poor: "Mal estado",
}

const DIRECTION_LABELS: Record<string, string> = {
  clockwise: "Horaria",
  counterclockwise: "Antihoraria",
}

/** Posiciones normativas de ubicación anormal (coexisten M/D/V/P/L). */
const ABNORMAL_POSITIONS: readonly string[] = ["mesial", "distal", "buccal", "palatal", "lingual"]

/** Pistas normativas donde `specifications` lleva material o clasificación. */
const SPECIFICATION_HINTS: Record<string, string> = {
  temporary_crown: "Indica el material de la corona temporal.",
  enamel_development_defect: "Si es fluorosis, indica su clasificación.",
  pathological_mobility: "Indica la clasificación del grado de movilidad.",
}

/**
 * Etiqueta original del registro migrado, disponible en `legacyData` (objeto
 * previo completo). Solo lectura del antecedente; nunca acepta estados nuevos
 * en español.
 */
function originalLegacyText(entry: OdontogramEntry): string | null {
  if (!entry.needsReview || !entry.legacyData) return null
  const raw = entry.legacyData
  const condition = typeof raw.condition === "string" ? raw.condition : null
  if (!condition) return null
  const surface = typeof raw.surface === "string" && raw.surface !== "" ? ` (${raw.surface})` : ""
  return `Registro original: ${condition}${surface}`
}

type FormMode = "diagnosis" | "treatment"

interface PlanQueryState {
  data?: { data: PlanItem[] }
  isPending: boolean
  isError: boolean
}

interface DocsQueryState {
  data?: { data: PatientDocument[] }
  isPending: boolean
  isError: boolean
}

function entryTime(entry: OdontogramEntry): number {
  if (!entry.createdAt) return 0
  const t = new Date(entry.createdAt).getTime()
  return Number.isNaN(t) ? 0 : t
}

function mutationMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.shape.message) return err.shape.message
  }
  return err instanceof Error ? err.message : fallback
}

/** Sigla oficial del hallazgo; null si el código no es normativo vigente. */
function abbreviationOf(condition: string, details?: FindingDetails): string | null {
  try {
    if (!findingDefinition(condition)) return null
    return findingAbbreviation({ condition, details })
  } catch {
    return null
  }
}

export function ToothDrawer({
  patientId,
  teeth,
  entriesOf,
  historyOf,
  encounterId,
  readOnly = false,
  disabled = false,
  historical = false,
  open,
  onOpenChange,
  onChanged,
  inline = false,
  beforeWrite,
  onPendingChange,
}: {
  patientId: string
  teeth: number[]
  entriesOf: (tooth: number) => OdontogramEntry[]
  historyOf: (tooth: number) => OdontogramEntry[]
  encounterId?: string
  readOnly?: boolean
  /** Bloqueo externo (p. ej. guardado en curso del llamador): deshabilita el formulario. */
  disabled?: boolean
  /** El drawer muestra un estado histórico: insignia de solo lectura, nunca inferida por permisos. */
  historical?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Panel lateral embebido (escritorio): mismo cuerpo sin drawer encima. */
  inline?: boolean
  onChanged: () => void | Promise<void>
  /** Vacía ediciones pendientes del llamador antes de escribir (p. ej. atención en curso). */
  beforeWrite?: () => Promise<void>
  onPendingChange?: (pending: boolean) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const canWrite = useCanWrite()
  const canMutate = !readOnly && canWrite
  const uid = useId()
  const multi = teeth.length > 1
  const [tooth] = teeth
  const singleTooth = !multi && tooth != null ? tooth : null

  const allowedSurfaces = useMemo(
    () => (singleTooth != null ? surfacesForTooth(singleTooth).map(String) : []),
    [singleTooth],
  )

  const [mode, setMode] = useState<FormMode>("diagnosis")

  // Borrador del hallazgo: todo arranca vacío, sin valores clínicos inventados.
  const [condition, setCondition] = useState("")
  const [variant, setVariant] = useState("")
  const [quality, setQuality] = useState("")
  const [direction, setDirection] = useState("")
  const [grade, setGrade] = useState("")
  const [positions, setPositions] = useState<string[]>([])
  const [surfaces, setSurfaces] = useState<string[]>([])
  const [abutments, setAbutments] = useState<number[]>([])
  const [drawing, setDrawing] = useState<number[][][]>([])
  const [freehand, setFreehand] = useState(false)
  // Evidencia observada: solo lo marcado explícitamente por el clínico.
  const [clinicallyObserved, setClinicallyObserved] = useState(false)
  const [specifications, setSpecifications] = useState("")
  const [observations, setObservations] = useState("")
  const [diagnosisCode, setDiagnosisCode] = useState("")
  const [diagnosisDescription, setDiagnosisDescription] = useState("")
  const [note, setNote] = useState("")
  const [diagPending, setDiagPending] = useState(false)
  const [diagError, setDiagError] = useState<string | null>(null)
  const [diagErrors, setDiagErrors] = useState<string[]>([])
  // Plan clínico destino de la indicación: obligatorio, sin creación silenciosa.
  const [treatPlanId, setTreatPlanId] = useState("")
  const [treatNewPlan, setTreatNewPlan] = useState(false)
  const [treatPlanTitle, setTreatPlanTitle] = useState("Plan de tratamiento")
  const [treatPlanPending, setTreatPlanPending] = useState(false)
  const [treatPlanError, setTreatPlanError] = useState<string | null>(null)

  const [treatService, setTreatService] = useState<ServiceCatalogItem | null>(null)
  const [treatDetail, setTreatDetail] = useState("")
  const [treatCie, setTreatCie] = useState("")
  const [treatPending, setTreatPending] = useState(false)
  const [treatError, setTreatError] = useState<string | null>(null)

  const [voiding, setVoiding] = useState<{ id: string; label: string } | null>(null)
  const [voidReason, setVoidReason] = useState("")
  const [voidPending, setVoidPending] = useState(false)
  const [voidError, setVoidError] = useState<string | null>(null)

  const busy = diagPending || treatPending || voidPending || treatPlanPending
  const fieldDisabled = !canMutate || disabled || busy

  const def = condition ? findingDefinition(condition) : undefined
  const scope = def?.scope
  const isGroup = scope === "pair" || scope === "span" || scope === "arch"
  const showSurfaces = scope === "surface" && !multi && allowedSurfaces.length > 0
  const showDrawing = !!def && (!!def.requiresDrawing || scope === "surface")
  const showAbutments = condition === "fixed_partial_denture"
  const showDirection = condition === "rotation"
  const showGrade = condition === "pathological_mobility"
  const showPositions = condition === "abnormal_position"
  const showObservations = condition === "clinical_observation"

  /**
   * Detalle del borrador con solo propiedades pertinentes al hallazgo actual:
   * la misma construcción alimenta la vista previa y el POST, así lo que se
   * ve es lo que se guarda. Nada stale de otro hallazgo viaja al servidor.
   */
  const draftDetails = useMemo<FindingDetails>(() => {
    const details: FindingDetails = {}
    if (!def) return details
    if (def.variants?.length && variant) details.variant = variant
    if (def.color === "quality" && (quality === "good" || quality === "poor"))
      details.quality = quality
    if (
      condition === "rotation" &&
      (direction === "clockwise" || direction === "counterclockwise")
    ) {
      details.direction = direction
    }
    if (condition === "pathological_mobility") {
      const parsed = Number(grade)
      if (Number.isInteger(parsed) && parsed >= 1) details.grade = parsed
    }
    if (condition === "abnormal_position" && positions.length > 0)
      details.positions = [...positions]
    if (isGroup && teeth.length > 0) details.relatedTeeth = [...teeth]
    if (scope === "span" && abutments.length > 0) details.abutmentTeeth = [...abutments]
    if (clinicallyObserved) details.clinicallyObserved = true
    if (drawing.length > 0) details.drawing = drawing
    if (specifications.trim()) details.specifications = specifications.trim()
    if (observations.trim()) details.observations = observations.trim()
    return details
  }, [
    def,
    variant,
    quality,
    condition,
    direction,
    grade,
    positions,
    isGroup,
    teeth,
    scope,
    abutments,
    drawing,
    clinicallyObserved,
    specifications,
    observations,
  ])

  const draftDirty =
    condition !== "" ||
    variant !== "" ||
    quality !== "" ||
    direction !== "" ||
    grade !== "" ||
    positions.length > 0 ||
    surfaces.length > 0 ||
    abutments.length > 0 ||
    drawing.length > 0 ||
    clinicallyObserved ||
    specifications !== "" ||
    observations !== "" ||
    diagnosisCode !== "" ||
    note !== ""

  const draftAbbreviation = draftDirty && def ? abbreviationOf(condition, draftDetails) : null

  /**
   * Vista previa viva: el borrador viaja con superficies normativas en inglés
   * y `details` clínicos reales (variante, calidad, grado, dirección,
   * posiciones, tramo/pilares, evidencia, trazo, especificaciones). Sin
   * colores inventados: el Renderer colorea con `findingColor(details)` y la
   * selección solo marca el anillo, nunca el relleno.
   */
  const previewEntriesOf = (toothNumber: number): OdontogramEntry[] => {
    const base = entriesOf(toothNumber)
    if (!canMutate || !draftDirty || !def || !teeth.includes(toothNumber)) return base
    const draftSurfaces = !multi && scope === "surface" && surfaces.length > 0 ? surfaces : [null]
    const code = diagnosisCode.trim()
    const noteText = note.trim()
    const draft: OdontogramEntry = {
      id: `draft-${toothNumber}`,
      toothNumber,
      condition,
      surface: null,
      status: "recorded",
      ...(code ? { diagnosisCode: code } : {}),
      ...(noteText ? { note: noteText } : {}),
      details: draftDetails,
    }
    return [
      ...base,
      ...draftSurfaces.map((surface) => ({
        ...draft,
        id: `draft-${toothNumber}-${surface ?? "whole"}`,
        surface,
      })),
    ]
  }
  const toggleSurface = (surface: string) => {
    setSurfaces((prev) =>
      prev.includes(surface) ? prev.filter((s) => s !== surface) : [...prev, surface],
    )
  }

  const togglePosition = (position: string) => {
    setPositions((prev) =>
      prev.includes(position) ? prev.filter((p) => p !== position) : [...prev, position],
    )
  }

  const toggleAbutment = (toothNumber: number) => {
    setAbutments((prev) =>
      prev.includes(toothNumber) ? prev.filter((t) => t !== toothNumber) : [...prev, toothNumber],
    )
  }

  const resetDraft = () => {
    setCondition("")
    setVariant("")
    setQuality("")
    setDirection("")
    setGrade("")
    setPositions([])
    setSurfaces([])
    setAbutments([])
    setDrawing([])
    setClinicallyObserved(false)
    setSpecifications("")
    setObservations("")
    setDiagnosisCode("")
    setDiagnosisDescription("")
    setNote("")
    setDiagErrors([])
  }

  const selectCondition = (value: string | null | undefined) => {
    setCondition(value ?? "")
    setFreehand(false)
    // El detalle depende del hallazgo: nada de otra definición sobrevive.
    setVariant("")
    setQuality("")
    setDirection("")
    setGrade("")
    setPositions([])
    setSurfaces([])
    setAbutments([])
    setDrawing([])
    setClinicallyObserved(false)
    setSpecifications("")
    setObservations("")
    setDiagErrors([])
  }

  const planQuery = useQuery({
    queryKey: ["plan", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
  })

  const docsQuery = useQuery({
    queryKey: ["patient-documents", patientId],
    queryFn: () => apiFetch<{ data: PatientDocument[] }>(`/api/patients/${patientId}/documents`),
  })
  // Planes del paciente como destino de la indicación.
  const treatmentPlansQuery = useQuery({
    queryKey: ["treatment-plans", patientId],
    queryFn: () => fetchTreatmentPlans(patientId),
  })
  const planOptions = useMemo(
    () => treatmentPlansQuery.data?.data ?? [],
    [treatmentPlansQuery.data],
  )

  // Alta explícita del plan desde el drawer (origen: la atención abierta).
  const createTreatmentPlan = async (event: React.FormEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!canMutate || disabled || busy || treatPlanPending) return
    if (!encounterId) {
      setTreatPlanError("Abre una atención en curso para crear el plan.")
      return
    }
    const title = treatPlanTitle.trim()
    if (!title) {
      setTreatPlanError("Ingresa el título del nuevo plan.")
      return
    }
    setTreatPlanPending(true)
    onPendingChange?.(true)
    setTreatPlanError(null)
    try {
      await beforeWrite?.()
      const created = await createTreatmentPlanApi(patientId, {
        title,
        originEncounterId: encounterId,
      })
      await queryClient.invalidateQueries({ queryKey: ["treatment-plans", patientId] })
      setTreatPlanId(created.data.id)
      setTreatNewPlan(false)
      setTreatPlanTitle("Plan de tratamiento")
    } catch (err) {
      setTreatPlanError(mutationMessage(err, "No se pudo crear el plan."))
    } finally {
      setTreatPlanPending(false)
      onPendingChange?.(false)
    }
  }
  const shownTeeth = multi && teeth.length > MAX_HEAD_TEETH ? teeth.slice(0, MAX_HEAD_TEETH) : teeth
  const hiddenCount = teeth.length - shownTeeth.length
  const title =
    teeth.length === 0
      ? "Sin piezas seleccionadas"
      : !multi
        ? `Pieza ${tooth} — ${toothNameOf(tooth!)}`
        : `${teeth.length} piezas: ${shownTeeth.join(", ")}${hiddenCount > 0 ? ` +${hiddenCount} más` : ""}`
  const description = multi
    ? isGroup
      ? "El hallazgo se registrará una sola vez para el conjunto seleccionado."
      : "El registro se aplicará a cada pieza seleccionada."
    : undefined

  const submitDiagnosis = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canMutate || disabled || busy || teeth.length === 0) return
    setDiagError(null)
    setDiagErrors([])
    if (!def) {
      setDiagErrors(["Selecciona el hallazgo a registrar."])
      return
    }
    // La evidencia observada solo vale marcada explícitamente por el clínico.
    if (def.requiresEvidence && !clinicallyObserved) {
      setDiagErrors(["Confirma que observaste clínicamente este hallazgo antes de registrarlo."])
      return
    }
    const code = diagnosisCode.trim()
    const noteText = note.trim()
    const targets = isGroup ? [teeth[0]] : [...teeth]
    const inputs: FindingInput[] = targets.map((toothNumber) => {
      const input: FindingInput = { toothNumber, condition }
      // Las caras solo se registran con una sola pieza (contrato aprobado).
      if (!isGroup && !multi && scope === "surface" && surfaces.length > 0) {
        input.surfaces = [...surfaces]
      }
      if (Object.keys(draftDetails).length > 0) input.details = draftDetails
      if (code) input.diagnosisCode = code
      if (noteText) input.note = noteText
      if (encounterId) input.encounterId = encounterId
      return input
    })
    const failures: string[] = []
    for (const input of inputs) {
      let messages: string[]
      try {
        messages = validateFinding(input)
      } catch {
        failures.push(
          `Pieza ${input.toothNumber}: no se pudo validar el hallazgo. Inténtalo de nuevo.`,
        )
        continue
      }
      for (const message of messages) {
        failures.push(inputs.length > 1 ? `Pieza ${input.toothNumber}: ${message}` : message)
      }
    }
    if (failures.length > 0) {
      setDiagErrors(failures)
      return
    }
    setDiagPending(true)
    onPendingChange?.(true)
    try {
      await beforeWrite?.()
      await Promise.all(
        inputs.map((input) =>
          apiFetch(`/api/patients/${patientId}/odontogram/entries`, {
            method: "POST",
            body: JSON.stringify(input),
          }),
        ),
      )
      resetDraft()
      await onChanged()
    } catch (err) {
      setDiagError(mutationMessage(err, "No se pudo registrar el diagnóstico."))
    } finally {
      setDiagPending(false)
      onPendingChange?.(false)
    }
  }

  const submitTreatment = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canMutate || disabled || busy || teeth.length === 0) return
    if (!treatService) {
      setTreatError("Selecciona un servicio del catálogo.")
      return
    }
    if (treatService.priceCents === null) {
      setTreatError(
        "Ese tratamiento aún no tiene tarifa: configúrala en el tarifario antes de cotizar.",
      )
      return
    }
    if (!treatPlanId) {
      setTreatError("Elige el plan clínico donde se indicará el tratamiento.")
      return
    }
    if (!encounterId) {
      setTreatError("Abre una atención en curso para indicar el tratamiento.")
      return
    }
    setTreatPending(true)
    onPendingChange?.(true)
    setTreatError(null)
    try {
      await beforeWrite?.()
      const cieCode = treatCie.trim()
      await apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan/items/batch`, {
        method: "POST",
        body: JSON.stringify({
          planId: treatPlanId,
          sourceEncounterId: encounterId,
          serviceId: treatService.id,
          toothNumbers: teeth,
          detail: treatDetail.trim() === "" ? null : treatDetail.trim(),
          diagnosisCode: cieCode === "" ? null : cieCode,
        }),
      })
      setTreatService(null)
      setTreatDetail("")
      setTreatCie("")
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["plan", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["treatment-plans", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["budgets", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["budget", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] }),
      ])
    } catch (err) {
      setTreatError(mutationMessage(err, "No se pudo guardar el tratamiento."))
    } finally {
      setTreatPending(false)
      onPendingChange?.(false)
    }
  }

  const cancelVoid = () => {
    if (!voidPending) {
      setVoiding(null)
      setVoidReason("")
      setVoidError(null)
    }
  }

  const confirmVoid = async () => {
    if (!voiding || !canMutate || disabled || busy) return
    const reason = voidReason.trim()
    if (!reason) {
      setVoidError("El motivo de la anulación es obligatorio.")
      return
    }
    setVoidPending(true)
    onPendingChange?.(true)
    setVoidError(null)
    try {
      await beforeWrite?.()
      await apiFetch(`/api/patients/${patientId}/odontogram/entries/${voiding.id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      })
      setVoiding(null)
      setVoidReason("")
      await onChanged()
    } catch (err) {
      setVoidError(mutationMessage(err, "No se pudo anular la entrada."))
    } finally {
      setVoidPending(false)
      onPendingChange?.(false)
    }
  }

  const handleClose = () => {
    if (busy) return
    onOpenChange(false)
  }
  const diagDirty = draftDirty
  const treatDirty =
    treatService !== null || treatDetail !== "" || treatCie !== "" || treatPlanId !== ""
  const isDirty = canMutate && (diagDirty || treatDirty)
  const activeError = mode === "diagnosis" ? (diagError ?? diagErrors[0] ?? null) : treatError
  const faceEditing = canMutate && !disabled && !busy && !multi && scope === "surface" && !freehand
  // El trazo se dibuja sobre la vista previa con el Renderer (contrato final):
  // una sola pieza, sin puentes. El borrador lo controla este drawer.
  const drawEditing =
    canMutate && !disabled && !busy && !multi && showDrawing && (freehand || !!def?.requiresDrawing)

  const headerContent =
    teeth.length === 0 ? null : (
      <div className="flex flex-col gap-2 pt-2">
        {historical && <Badge variant="outline">Estado histórico · solo lectura</Badge>}
        {canMutate && draftDirty && def && (
          <Badge variant="outline" aria-live="polite">
            En edición · vista previa no guardada
            {draftAbbreviation ? ` · ${draftAbbreviation}` : ""}
          </Badge>
        )}
        <ScrollArea className={multi ? "h-40 sm:h-48" : "h-28 sm:h-36"}>
          <div
            className={`grid gap-4 pr-3 ${multi ? "sm:grid-cols-2" : ""}`}
            aria-label="Piezas seleccionadas"
          >
            {teeth.map((toothNumber) => (
              <figure
                key={toothNumber}
                className="flex min-w-0 items-center gap-5 rounded-lg bg-muted/40 px-4 py-2"
              >
                <ToothSVG
                  toothNumber={toothNumber}
                  entries={previewEntriesOf(toothNumber)}
                  selected
                  disabled={fieldDisabled}
                  painting={faceEditing && toothNumber === singleTooth}
                  onPaint={(surface) => {
                    if (allowedSurfaces.includes(surface)) toggleSurface(surface)
                  }}
                  drawingEnabled={drawEditing && toothNumber === singleTooth}
                  draftDrawing={drawing}
                  onDrawingChange={setDrawing}
                  size="preview"
                  showRoots={drawEditing || scope === "tooth"}
                />
                <figcaption className="min-w-0">
                  <span className="text-2xl font-semibold tabular-nums">{toothNumber}</span>
                  <p className="mt-1 text-sm text-muted-foreground">{toothNameOf(toothNumber)}</p>
                </figcaption>
              </figure>
            ))}
          </div>
        </ScrollArea>
        {!multi && showDrawing && canMutate && (
          <div className="flex flex-wrap gap-2">
            {!def?.requiresDrawing && (
              <Button
                type="button"
                size="sm"
                variant={freehand ? "default" : "outline"}
                disabled={fieldDisabled}
                onClick={() => setFreehand(!freehand)}
              >
                {freehand ? "Seleccionar superficies" : "Trazar forma observada"}
              </Button>
            )}
            {drawing.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={fieldDisabled}
                onClick={() => setDrawing([])}
              >
                Borrar trazos del borrador
              </Button>
            )}
          </div>
        )}
        {faceEditing && (
          <p className="text-xs text-muted-foreground">
            Toca una cara del diente para agregarla o quitarla del borrador.
          </p>
        )}
        {drawEditing && def?.requiresDrawing && (
          <p className="text-xs text-muted-foreground">
            Dibuja el trazo observado directamente sobre el diente (obligatorio).
          </p>
        )}
      </div>
    )

  const submitLabel =
    mode === "diagnosis"
      ? `Registrar diagnóstico${multi && !isGroup ? ` (${teeth.length})` : ""}`
      : `Agregar al plan${multi ? ` (${teeth.length})` : ""}`
  const submit = (event: React.FormEvent): void => {
    if (mode === "diagnosis") void submitDiagnosis(event)
    else void submitTreatment(event)
  }
  const body = (
    <div className="flex flex-col gap-5">
      <Tabs
        value={mode}
        onValueChange={(value) => {
          if (value === "diagnosis" || value === "treatment") setMode(value)
        }}
      >
        <TabsList className="w-full" aria-label="Tipo de registro">
          <TabsTrigger value="diagnosis" disabled={busy || disabled}>
            Diagnóstico
          </TabsTrigger>
          <TabsTrigger value="treatment" disabled={busy || disabled}>
            Tratamiento
          </TabsTrigger>
        </TabsList>

        {!canMutate ? (
          <p className="text-sm text-muted-foreground">
            {historical || readOnly
              ? "Solo lectura: no se pueden registrar cambios."
              : "No tienes permiso para registrar cambios en estas piezas."}
          </p>
        ) : mode === "diagnosis" ? (
          <TabsContent value="diagnosis" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${uid}-condition`}>Hallazgo (NTS 188)</FieldLabel>
              <Select
                value={condition}
                items={Object.fromEntries(FINDINGS.map((f) => [f.code, f.label]))}
                onValueChange={selectCondition}
              >
                <SelectTrigger
                  id={`${uid}-condition`}
                  aria-label="Hallazgo"
                  disabled={fieldDisabled}
                >
                  <SelectValue placeholder="Selecciona el hallazgo…" />
                </SelectTrigger>
                <SelectContent>
                  {FINDINGS.map((finding) => (
                    <SelectItem key={finding.code} value={finding.code}>
                      {finding.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {def?.variants?.length ? (
              <Field>
                <FieldLabel htmlFor={`${uid}-variant`}>Variante</FieldLabel>
                <Select
                  value={variant}
                  items={Object.fromEntries(def.variants.map((v) => [v.value, v.label]))}
                  onValueChange={(v) => setVariant(v ?? "")}
                >
                  <SelectTrigger
                    id={`${uid}-variant`}
                    aria-label="Variante"
                    disabled={fieldDisabled}
                  >
                    <SelectValue placeholder="Selecciona la variante…" />
                  </SelectTrigger>
                  <SelectContent>
                    {def.variants.map((v) => (
                      <SelectItem key={v.value} value={v.value}>
                        {v.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}

            {def?.color === "quality" ? (
              <Field>
                <FieldLabel htmlFor={`${uid}-quality`}>Calidad</FieldLabel>
                <Select
                  value={quality}
                  items={QUALITY_LABELS}
                  onValueChange={(v) => setQuality(v ?? "")}
                >
                  <SelectTrigger
                    id={`${uid}-quality`}
                    aria-label="Calidad"
                    disabled={fieldDisabled}
                  >
                    <SelectValue placeholder="Selecciona la calidad…" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(QUALITY_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}

            {showDirection && (
              <Field>
                <FieldLabel htmlFor={`${uid}-direction`}>Dirección de rotación</FieldLabel>
                <Select
                  value={direction}
                  items={DIRECTION_LABELS}
                  onValueChange={(v) => setDirection(v ?? "")}
                >
                  <SelectTrigger
                    id={`${uid}-direction`}
                    aria-label="Dirección de rotación"
                    disabled={fieldDisabled}
                  >
                    <SelectValue placeholder="Selecciona la dirección…" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(DIRECTION_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}

            {showGrade && (
              <Field>
                <FieldLabel htmlFor={`${uid}-grade`}>Grado de movilidad</FieldLabel>
                <Input
                  id={`${uid}-grade`}
                  value={grade}
                  onChange={(e) => setGrade(e.currentTarget.value)}
                  placeholder="1, 2, 3…"
                  inputMode="numeric"
                  disabled={fieldDisabled}
                />
                <p className="text-xs text-muted-foreground">Solo grados patológicos (nunca M0).</p>
              </Field>
            )}

            {isGroup && (
              <div className="sm:col-span-2">
                <p className="text-xs text-muted-foreground">
                  Se registrará una sola vez e incluirá las piezas: {teeth.join(", ")}.
                </p>
              </div>
            )}

            {showAbutments && (
              <fieldset className="flex flex-col gap-2 sm:col-span-2">
                <legend className="text-xs font-medium">Piezas pilar del tramo</legend>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {teeth.map((toothNumber) => (
                    <label
                      key={toothNumber}
                      htmlFor={`${uid}-abutment-${toothNumber}`}
                      className="flex items-center gap-1.5 text-sm"
                    >
                      <Checkbox
                        id={`${uid}-abutment-${toothNumber}`}
                        checked={abutments.includes(toothNumber)}
                        disabled={fieldDisabled}
                        onCheckedChange={() => toggleAbutment(toothNumber)}
                      />
                      Pieza {toothNumber}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Marca las piezas pilar del tramo (puentes sobre pilares).
                </p>
              </fieldset>
            )}

            {showPositions && (
              <fieldset className="flex flex-col gap-2 sm:col-span-2">
                <legend className="text-xs font-medium">Posiciones (coexisten M/D/V/P/L)</legend>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {ABNORMAL_POSITIONS.map((position) => (
                    <label
                      key={position}
                      htmlFor={`${uid}-position-${position}`}
                      className="flex items-center gap-1.5 text-sm"
                    >
                      <Checkbox
                        id={`${uid}-position-${position}`}
                        checked={positions.includes(position)}
                        disabled={fieldDisabled}
                        onCheckedChange={() => togglePosition(position)}
                      />
                      {clinicalSurfaceLabel(position)}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            <div className="sm:col-span-2">
              {scope === "surface" && multi ? (
                <p className="text-xs text-muted-foreground">
                  Selecciona una sola pieza para registrar por superficie. El diagnóstico sin
                  superficies se replica a las {teeth.length} piezas.
                </p>
              ) : showSurfaces ? (
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-xs font-medium">
                    Superficies comprometidas (o traza la forma observada)
                  </legend>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {allowedSurfaces.map((s) => (
                      <label
                        key={s}
                        htmlFor={`${uid}-surface-${s}`}
                        className="flex items-center gap-1.5 text-sm"
                      >
                        <Checkbox
                          id={`${uid}-surface-${s}`}
                          checked={surfaces.includes(s)}
                          disabled={fieldDisabled}
                          onCheckedChange={() => toggleSurface(s)}
                        />
                        {clinicalSurfaceLabel(s)}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
            </div>

            {showDrawing && (
              <div className="flex flex-col gap-2 sm:col-span-2">
                <span className="text-xs font-medium">
                  Registro gráfico{def?.requiresDrawing ? " (obligatorio)" : ""}
                </span>
                {multi ? (
                  <p className="text-xs text-muted-foreground">
                    Selecciona una sola pieza para dibujar el trazo sobre su vista previa.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Dibuja el trazo observado sobre el diente en la cabecera
                    {drawing.length > 0
                      ? ` (${drawing.length} ${drawing.length === 1 ? "trazo" : "trazos"}).`
                      : "."}
                  </p>
                )}
                {(def?.requiresEvidence || def?.requiresDrawing) && (
                  <p className="text-xs text-muted-foreground">
                    Este hallazgo requiere evidencia: selecciona superficies o registra el trazo
                    observado.
                  </p>
                )}
              </div>
            )}

            {def?.requiresEvidence && (
              <div className="sm:col-span-2">
                <label htmlFor={`${uid}-observed`} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    id={`${uid}-observed`}
                    checked={clinicallyObserved}
                    disabled={fieldDisabled}
                    onCheckedChange={() => setClinicallyObserved((prev) => !prev)}
                  />
                  Observé clínicamente este hallazgo (obligatorio)
                </label>
              </div>
            )}

            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${uid}-specifications`}>Especificaciones</FieldLabel>
              <Textarea
                id={`${uid}-specifications`}
                value={specifications}
                disabled={fieldDisabled}
                maxLength={2000}
                placeholder="Material, clasificación u otra especificación normativa…"
                onChange={(event) => setSpecifications(event.target.value)}
              />
              {SPECIFICATION_HINTS[condition] && (
                <p className="text-xs text-muted-foreground">{SPECIFICATION_HINTS[condition]}</p>
              )}
            </Field>

            {showObservations && (
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor={`${uid}-observations`}>Observaciones</FieldLabel>
                <Textarea
                  id={`${uid}-observations`}
                  value={observations}
                  disabled={fieldDisabled}
                  maxLength={2000}
                  placeholder="Observación clínica de la pieza…"
                  onChange={(event) => setObservations(event.target.value)}
                />
              </Field>
            )}

            <div className="sm:col-span-2">
              <Cie10Search
                value={diagnosisCode}
                label="Diagnóstico CIE-10 (opcional)"
                disabled={fieldDisabled}
                onChange={(code, description) => {
                  setDiagnosisCode(code)
                  setDiagnosisDescription(description)
                }}
              />
              {diagnosisDescription && (
                <p className="mt-1 text-xs text-muted-foreground">{diagnosisDescription}</p>
              )}
            </div>

            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${uid}-note`}>Nota (opcional)</FieldLabel>
              <Textarea
                id={`${uid}-note`}
                value={note}
                disabled={fieldDisabled}
                maxLength={500}
                placeholder="Detalle clínico del hallazgo…"
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>

            {diagErrors.length > 0 && (
              <div className="sm:col-span-2" role="alert">
                <ul className="flex flex-col gap-1 text-sm text-destructive">
                  {diagErrors.map((message, index) => (
                    <li key={`${index}-${message}`}>{message}</li>
                  ))}
                </ul>
              </div>
            )}
          </TabsContent>
        ) : (
          <TabsContent value="treatment" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${uid}-treat-plan`}>Plan clínico (obligatorio)</FieldLabel>
              <Select
                value={treatPlanId}
                onValueChange={(v) => setTreatPlanId(v ?? "")}
                disabled={fieldDisabled || treatNewPlan}
              >
                <SelectTrigger id={`${uid}-treat-plan`} aria-label="Plan clínico destino">
                  <SelectValue
                    placeholder={
                      treatmentPlansQuery.isLoading ? "Cargando planes…" : "Elige el plan clínico…"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {planOptions.map((p) => (
                    <SelectItem key={p.plan.id} value={p.plan.id}>
                      {p.plan.title} · {p.status} ({p.pendingItems} pendientes)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {planOptions.length === 0 && !treatmentPlansQuery.isLoading ? (
                <p className="text-xs text-muted-foreground">
                  Este paciente aún no tiene planes clínicos.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  La indicación nace en la atención abierta y vive en el plan, no en un presupuesto.
                </p>
              )}
              {!encounterId ? (
                <p role="note" className="text-xs text-muted-foreground">
                  Abre una atención en curso para indicar tratamientos desde aquí.
                </p>
              ) : null}
              {!treatNewPlan ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2 self-start"
                  disabled={fieldDisabled || !encounterId}
                  onClick={() => {
                    setTreatNewPlan(true)
                    setTreatPlanTitle("Plan de tratamiento")
                    setTreatPlanError(null)
                  }}
                >
                  Crear plan clínico
                </Button>
              ) : (
                <form
                  className="mt-2 flex flex-col gap-2 rounded-lg border p-3"
                  onSubmit={(e) => void createTreatmentPlan(e)}
                >
                  <Field>
                    <FieldLabel htmlFor={`${uid}-treat-plan-title`}>
                      Título del nuevo plan
                    </FieldLabel>
                    <Input
                      id={`${uid}-treat-plan-title`}
                      value={treatPlanTitle}
                      onChange={(e) => setTreatPlanTitle(e.currentTarget.value)}
                      placeholder="Plan de tratamiento"
                      maxLength={200}
                      disabled={fieldDisabled || treatPlanPending}
                    />
                  </Field>
                  {treatPlanError && (
                    <p role="alert" className="text-xs text-destructive">
                      {treatPlanError}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={fieldDisabled || treatPlanPending}>
                      {treatPlanPending ? "Creando…" : "Crear y seleccionar"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={fieldDisabled || treatPlanPending}
                      onClick={() => {
                        setTreatNewPlan(false)
                        setTreatPlanTitle("Plan de tratamiento")
                        setTreatPlanError(null)
                      }}
                    >
                      Volver
                    </Button>
                  </div>
                </form>
              )}
            </Field>
            <div className="sm:col-span-2">
              <ServicePicker
                value={treatService?.id ?? ""}
                onChange={setTreatService}
                disabled={fieldDisabled}
              />
            </div>
            {treatService && (
              <div className="rounded-lg border bg-muted/30 p-4 sm:col-span-2" aria-live="polite">
                {treatService.priceCents === null ? (
                  <p className="text-sm">
                    Sin tarifa: configúrala en el tarifario antes de cotizar.
                  </p>
                ) : (
                  <>
                    <p className="text-sm">
                      {teeth.length} pieza{multi ? "s" : ""} ×{" "}
                      {formatMoney(treatService.priceCents, treatService.currency)}
                    </p>
                    <p className="mt-1 text-xl font-semibold tabular-nums">
                      {formatMoney(treatService.priceCents * teeth.length, treatService.currency)}
                    </p>
                  </>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  Se agregará un tratamiento por pieza al presupuesto con la tarifa del catálogo
                  vigente al guardar.
                </p>
              </div>
            )}
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${uid}-treat-detail`}>Detalle</FieldLabel>
              <Textarea
                id={`${uid}-treat-detail`}
                value={treatDetail}
                onChange={(e) => setTreatDetail(e.currentTarget.value)}
                placeholder="Detalle del tratamiento propuesto"
                rows={3}
                maxLength={4000}
                disabled={fieldDisabled}
              />
            </Field>
            <div className="sm:col-span-2">
              <Cie10Search
                value={treatCie}
                onChange={(code) => setTreatCie(code)}
                label="Diagnóstico CIE-10 (opcional)"
                disabled={fieldDisabled}
              />
            </div>
          </TabsContent>
        )}
      </Tabs>

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-muted-foreground">Contexto clínico</h3>
        {teeth.map((toothNumber, index) => (
          <ToothContext
            key={toothNumber}
            patientId={patientId}
            toothNumber={toothNumber}
            entries={entriesOf(toothNumber)}
            history={historyOf(toothNumber)}
            planQuery={planQuery}
            docsQuery={docsQuery}
            canMutate={canMutate && !disabled && !busy}
            voidPending={voidPending}
            defaultOpen={index === 0}
            onVoid={(id, label) => {
              setVoiding({ id, label })
              setVoidReason("")
              setVoidError(null)
            }}
          />
        ))}
      </div>
    </div>
  )
  return (
    <>
      {inline ? (
        <div className="flex min-h-0 flex-col gap-4" aria-label="Registro de la selección">
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="text-lg font-semibold">{title}</h3>
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
            {headerContent}
          </div>
          {activeError ? (
            <p role="alert" className="text-sm text-destructive">
              {activeError}
            </p>
          ) : null}
          {body}
          {canMutate && teeth.length > 0 ? (
            <div>
              <Button type="button" disabled={fieldDisabled || busy} onClick={submit}>
                {busy ? "Guardando…" : submitLabel}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <FormDrawer
          open={open && voiding === null}
          onClose={handleClose}
          title={title}
          description={description}
          headerContent={headerContent}
          hideSubmit={!canMutate || teeth.length === 0}
          className={
            multi
              ? "data-[swipe-axis=x]:sm:[--drawer-content-width:min(56rem,calc(100vw-2rem))]"
              : "data-[swipe-axis=x]:sm:[--drawer-content-width:min(48rem,calc(100vw-2rem))]"
          }
          onSubmit={submit}
          isDirty={isDirty}
          isSubmitting={busy}
          error={activeError}
          submitLabel={submitLabel}
          cancelLabel="Cerrar"
          submitDisabled={fieldDisabled || teeth.length === 0}
        >
          {body}
        </FormDrawer>
      )}
      <FormDrawer
        open={open && voiding !== null}
        onClose={cancelVoid}
        title="Anular registro odontológico"
        description={
          voiding
            ? `Anulación de ${voiding.label}. El registro original y el motivo permanecerán en el historial.`
            : undefined
        }
        onSubmit={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void confirmVoid()
        }}
        isDirty={voidReason !== ""}
        isSubmitting={voidPending}
        error={voidError}
        submitLabel="Confirmar anulación"
        cancelLabel="Volver al registro"
        submitDisabled={!canMutate || disabled}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-void-reason`}>
            Motivo de la anulación (obligatorio)
          </FieldLabel>
          <Textarea
            id={`${uid}-void-reason`}
            value={voidReason}
            onChange={(event) => setVoidReason(event.target.value)}
            placeholder="Ej. Registro duplicado, pieza equivocada…"
            rows={4}
            maxLength={500}
            required
            disabled={voidPending}
          />
        </Field>
      </FormDrawer>
    </>
  )
}

function ToothContext({
  patientId,
  toothNumber,
  entries,
  history,
  planQuery,
  docsQuery,
  canMutate,
  voidPending,
  defaultOpen,
  onVoid,
}: {
  patientId: string
  toothNumber: number
  entries: OdontogramEntry[]
  history: OdontogramEntry[]
  planQuery: PlanQueryState
  docsQuery: DocsQueryState
  canMutate: boolean
  voidPending: boolean
  defaultOpen: boolean
  onVoid: (id: string, label: string) => void
}): React.JSX.Element {
  const sortedHistory = [...history].sort((a, b) => entryTime(b) - entryTime(a))

  const affectedSurfaces = Array.from(
    new Set(entries.map((e) => e.surface).filter((s): s is string => s != null)),
  )
  const currentDiagnoses = Array.from(
    new Set(entries.map((e) => e.diagnosisCode).filter((c): c is string => c != null && c !== "")),
  )
  const needsReview = entries.filter((e) => e.needsReview)

  const toothPlan = (planQuery.data?.data ?? []).filter((item) => item.toothNumber === toothNumber)
  const openPlan = toothPlan.filter((item) => OPEN_PLAN_STATUSES.includes(item.status))
  const donePlan = toothPlan.filter((item) => !OPEN_PLAN_STATUSES.includes(item.status))

  const toothDocs = (docsQuery.data?.data ?? []).filter((d) => d.toothNumbers.includes(toothNumber))
  const toothImages = toothDocs.filter(
    (d) => d.category === "radiografia" || d.category === "foto_clinica",
  )
  const toothOtherDocs = toothDocs.filter(
    (d) => d.category !== "radiografia" && d.category !== "foto_clinica",
  )

  return (
    <details className="flex flex-col gap-2 rounded-lg border px-4 py-3" open={defaultOpen}>
      <summary className="cursor-pointer text-sm font-semibold">
        Pieza {toothNumber} — {toothNameOf(toothNumber)}{" "}
        <span className="font-normal text-muted-foreground">
          ({toothTypeLabel(toothTypeOf(toothNumber))})
        </span>
      </summary>

      <div className="flex flex-col gap-3 pt-2">
        <section
          aria-label={`Estado actual de la pieza ${toothNumber}`}
          className="flex flex-col gap-2"
        >
          <h4 className="text-sm font-medium">Estado actual</h4>
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin hallazgos vigentes en esta pieza.</p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-1.5">
                {entries.map((entry) => {
                  const abbreviation = abbreviationOf(entry.condition, entry.details)
                  return (
                    <Badge key={entry.id} variant={entry.needsReview ? "outline" : undefined}>
                      {abbreviation ? `${abbreviation} · ` : ""}
                      {clinicalConditionLabel(entry.condition)}
                    </Badge>
                  )
                })}
              </div>
              {affectedSurfaces.length > 0 && (
                <div className="flex flex-wrap gap-1.5" aria-label="Superficies afectadas">
                  {affectedSurfaces.map((s) => (
                    <Badge key={s} variant="outline">
                      {clinicalSurfaceLabel(s)}
                    </Badge>
                  ))}
                </div>
              )}
              {currentDiagnoses.length > 0 && (
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  CIE-10:
                  {currentDiagnoses.map((code) => (
                    <Badge key={code} variant="outline">
                      {code}
                    </Badge>
                  ))}
                </p>
              )}
              {needsReview.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {needsReview.length}{" "}
                  {needsReview.length === 1
                    ? "registro anterior migrado requiere"
                    : "registros anteriores migrados requieren"}{" "}
                  revisión clínica: se muestran en el historial, fuera del dibujo normativo.
                </p>
              )}
            </div>
          )}
        </section>

        <section aria-label={`Plan de la pieza ${toothNumber}`} className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">Plan de la pieza</h4>
          {planQuery.isPending && <p className="text-sm text-muted-foreground">Cargando plan…</p>}
          {planQuery.isError && (
            <p role="alert" className="text-sm text-destructive">
              No se pudo cargar el plan de la pieza.
            </p>
          )}
          {!planQuery.isPending && !planQuery.isError && toothPlan.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin ítems del plan para esta pieza.</p>
          )}
          {!planQuery.isPending && !planQuery.isError && toothPlan.length > 0 && (
            <div className="flex flex-col gap-2">
              {openPlan.length > 0 && (
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    Pendiente / programado
                  </p>
                  <ul className="flex flex-col gap-1">
                    {openPlan.map((item) => (
                      <li
                        key={item.id}
                        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
                      >
                        <span className="font-medium">{item.title}</span>
                        <Badge variant="outline">{planStatusLabel(item.status)}</Badge>
                        {item.diagnosisCode && (
                          <Badge variant="outline">{item.diagnosisCode}</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {donePlan.length > 0 && (
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-medium text-muted-foreground">Historial del plan</p>
                  <ul className="flex flex-col gap-1">
                    {donePlan.map((item) => (
                      <li
                        key={item.id}
                        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
                      >
                        <span className="font-medium">{item.title}</span>
                        <Badge variant="outline">{planStatusLabel(item.status)}</Badge>
                        {item.diagnosisCode && (
                          <Badge variant="outline">{item.diagnosisCode}</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>

        <section aria-label={`Imágenes de la pieza ${toothNumber}`} className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">Imágenes asociadas</h4>
          {docsQuery.isPending && (
            <p className="text-sm text-muted-foreground">Cargando imágenes…</p>
          )}
          {docsQuery.isError && (
            <p role="alert" className="text-sm text-destructive">
              No se pudieron cargar los documentos de la pieza.
            </p>
          )}
          {!docsQuery.isPending && !docsQuery.isError && toothDocs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Sin imágenes ni documentos de esta pieza.
            </p>
          )}
          {!docsQuery.isPending && !docsQuery.isError && toothImages.length > 0 && (
            <ul className="grid grid-cols-2 gap-2">
              {toothImages.map((doc) => (
                <ToothImageThumb key={doc.id} patientId={patientId} doc={doc} />
              ))}
            </ul>
          )}
          {!docsQuery.isPending && !docsQuery.isError && toothOtherDocs.length > 0 && (
            <ul className="flex flex-col gap-1">
              {toothOtherDocs.map((doc) => (
                <ToothDocLink key={doc.id} patientId={patientId} doc={doc} />
              ))}
            </ul>
          )}
        </section>

        <section
          aria-label={`Historial de la pieza ${toothNumber}`}
          className="flex flex-col gap-2"
        >
          <h4 className="text-sm font-medium">Historial de la pieza</h4>
          {sortedHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin entradas registradas.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {sortedHistory.map((entry) => {
                const voided = entry.status === "voided"
                const abbreviation = abbreviationOf(entry.condition, entry.details)
                const detailBits: string[] = []
                const variantLabel = entry.details?.variant
                  ? findingDefinition(entry.condition)?.variants?.find(
                      (v) => v.value === entry.details?.variant,
                    )?.label
                  : undefined
                if (variantLabel) detailBits.push(variantLabel)
                if (entry.details?.quality && QUALITY_LABELS[entry.details.quality]) {
                  detailBits.push(QUALITY_LABELS[entry.details.quality])
                }
                if (entry.details?.grade != null) detailBits.push(`Grado ${entry.details.grade}`)
                if (entry.details?.direction && DIRECTION_LABELS[entry.details.direction]) {
                  detailBits.push(DIRECTION_LABELS[entry.details.direction])
                }
                if (entry.details?.positions?.length) {
                  detailBits.push(
                    entry.details.positions.map((p) => clinicalSurfaceLabel(p)).join("/"),
                  )
                }
                if (entry.details?.relatedTeeth?.length) {
                  detailBits.push(`Piezas ${entry.details.relatedTeeth.join(", ")}`)
                }
                if (entry.details?.abutmentTeeth?.length) {
                  detailBits.push(`Pilares ${entry.details.abutmentTeeth.join(", ")}`)
                }
                if (entry.details?.specifications) detailBits.push(entry.details.specifications)
                if (entry.details?.observations) detailBits.push(entry.details.observations)
                if (entry.details?.drawing?.length) {
                  detailBits.push(
                    `${entry.details.drawing.length} ${entry.details.drawing.length === 1 ? "trazo" : "trazos"}`,
                  )
                }
                return (
                  <li
                    key={entry.id}
                    className={`flex flex-col gap-1 rounded-md border px-2 py-1 text-sm ${
                      voided ? "text-muted-foreground" : ""
                    }`}
                  >
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className={voided ? "line-through" : ""}>
                        {abbreviation ? `${abbreviation} · ` : ""}
                        {clinicalConditionLabel(entry.condition)}
                        {entry.surface ? ` (${clinicalSurfaceLabel(entry.surface)})` : ""} ·{" "}
                        {statusLabel(entry.status)}
                      </span>
                      {entry.needsReview && <Badge variant="outline">Requiere revisión</Badge>}
                      {entry.diagnosisCode && (
                        <Badge variant="outline" className={voided ? "line-through" : ""}>
                          {entry.diagnosisCode}
                        </Badge>
                      )}
                      {entry.createdAt && (
                        <span className="text-xs text-muted-foreground">
                          {timeAgo(entry.createdAt)}
                        </span>
                      )}
                      {voided ? (
                        <span className="text-xs">
                          (anulada{entry.voidReason ? `: ${entry.voidReason}` : ""})
                        </span>
                      ) : (
                        canMutate && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="ml-auto"
                            disabled={voidPending}
                            onClick={() =>
                              onVoid(
                                entry.id,
                                `pieza ${toothNumber} (${clinicalConditionLabel(entry.condition)})`,
                              )
                            }
                          >
                            Anular
                          </Button>
                        )
                      )}
                    </span>
                    {entry.needsReview && (
                      <span className="text-xs text-muted-foreground">
                        Registro anterior migrado sin variante normativa: consérvalo como
                        antecedente y registra el hallazgo vigente con el formulario.
                        {originalLegacyText(entry) ? ` ${originalLegacyText(entry)}.` : ""}
                      </span>
                    )}
                    {entry.note && (
                      <span className={`text-muted-foreground ${voided ? "line-through" : ""}`}>
                        — {entry.note}
                      </span>
                    )}
                    {detailBits.length > 0 && (
                      <span
                        className={`text-xs text-muted-foreground ${voided ? "line-through" : ""}`}
                      >
                        {detailBits.join(" · ")}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </details>
  )
}

function useSignedDocUrl(patientId: string, documentId: string) {
  return useQuery({
    queryKey: ["patient-document-url", patientId, documentId],
    queryFn: () =>
      apiFetch<{ data: { url: string } }>(`/api/patients/${patientId}/documents/${documentId}/url`),
    staleTime: SIGNED_URL_STALE_MS,
    gcTime: 30 * 60 * 1000,
  })
}

function ToothImageThumb({ patientId, doc }: { patientId: string; doc: PatientDocument }) {
  const urlQuery = useSignedDocUrl(patientId, doc.id)
  const url = urlQuery.data?.data.url ?? null
  const isImage = doc.contentType.startsWith("image/")

  return (
    <li className="overflow-hidden rounded-md border">
      {url && isImage ? (
        <a href={url} target="_blank" rel="noreferrer" aria-label={`Ver ${doc.label}`}>
          <img
            src={url}
            alt={doc.label}
            loading="lazy"
            className="aspect-square w-full object-cover"
          />
        </a>
      ) : (
        <span className="flex aspect-square w-full flex-col items-center justify-center gap-1 bg-muted p-2 text-center">
          {urlQuery.isPending ? (
            <span className="text-xs text-muted-foreground">Cargando…</span>
          ) : url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-primary underline-offset-4 hover:underline"
            >
              Ver {doc.category === "radiografia" ? "radiografía" : "documento"}
            </a>
          ) : (
            <>
              <span className="text-xs font-medium">{doc.label}</span>
              <span className="text-xs text-destructive">Vista no disponible</span>
            </>
          )}
        </span>
      )}
      <div className="flex flex-col gap-1 p-2">
        <span className="truncate text-xs font-medium">{doc.label}</span>
        <span className="text-[11px] text-muted-foreground">{timeAgo(doc.createdAt)}</span>
      </div>
    </li>
  )
}

function ToothDocLink({ patientId, doc }: { patientId: string; doc: PatientDocument }) {
  const urlQuery = useSignedDocUrl(patientId, doc.id)
  const url = urlQuery.data?.data.url ?? null

  return (
    <li className="flex items-center justify-between gap-2 border-b py-1.5 text-sm last:border-0">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">{doc.label}</span>
        <span className="text-xs text-muted-foreground">
          {(doc.sizeBytes / 1024).toFixed(0)} KB · {timeAgo(doc.createdAt)}
        </span>
      </div>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-xs font-medium text-primary underline-offset-4 hover:underline"
        >
          Ver
        </a>
      ) : (
        <span className="text-xs text-muted-foreground">
          {urlQuery.isPending ? "Cargando…" : "No disponible"}
        </span>
      )}
    </li>
  )
}
