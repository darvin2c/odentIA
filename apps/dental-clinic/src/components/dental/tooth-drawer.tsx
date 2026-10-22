import {
  diagnosisCodeLabel,
  formatMoney,
} from "@odentia/clinical"
import {
  surfaceLabel as clinicalSurfaceLabel,
  type FindingDetails,
  type FindingInput,
  findingDefinition,
  surfacesForTooth,
  toothNameOf,
  toothTypeOf,
  validateFinding,
} from "@odentia/dental"
import {
  Badge,
  Button,
  Checkbox,
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
import { FormDrawer, FormPanel } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { fetchTreatmentPlans, planDecisionLabel } from "../../lib/budgets"
import { timeAgo, usePermission } from "../../lib/crm"
import { useOrgProfile } from "../../lib/org"
import {
  DIAGNOSIS_TYPE_LABELS,
  type OdontogramEntry,
  type PatientDocument,
  type PlanItem,
  planStatusLabel,
  toothTypeLabel,
} from "../../lib/patients"
import type { ServiceCatalogItem } from "../../lib/services"
import { FindingPicker } from "./finding-picker"
import { findingWords, useOdontogramNotation, variantFieldLabel } from "./odontogram-notation"
import { DiagnosisPicker } from "../patient/diagnosis-picker"
import { NewEncounterButton } from "../patient/new-encounter-button"
import { ServicePicker } from "../patient/service-picker"
import { ToothHistory } from "./tooth-history"
import { ToothSVG } from "./tooth-svg"

/** Las URL firmadas expiran: se consideran frescas 10 min y luego se regeneran. */
const SIGNED_URL_STALE_MS = 10 * 60 * 1000

const OPEN_PLAN_STATUSES: readonly string[] = ["pendiente", "programado", "en_curso", "suspendido"]

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

/** Pistas donde `specifications` lleva material o clasificación. */
const SPECIFICATION_HINTS: Record<string, string> = {
  temporary_crown: "Indica el material de la corona temporal.",
  enamel_development_defect: "Si es fluorosis, indica su clasificación.",
  pathological_mobility: "Indica la clasificación del grado de movilidad.",
}

/** Lo que se planifica desde la pieza es de la pieza o de sus caras. */
const TOOTH_SCOPES: readonly string[] = ["tooth", "surfaces"]

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

function mutationMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.shape.message) return err.shape.message
  }
  return err instanceof Error ? err.message : fallback
}

/**
 * El panel de la pieza (fase 3, tablero 4): su estado y, dentro de una
 * atención, un solo formulario con el hallazgo, su diagnóstico (lista de la clínica) con el
 * tipo (que es el diagnóstico de la atención) y el tratamiento, que va al plan
 * abierto de la persona. «Registrar y agregar al plan» lo deja todo junto, o
 * nada (`registerToothFinding`). Fuera de una atención el odontograma se
 * consulta y «Atender» está a un clic.
 */
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
  onDirtyChange,
}: {
  patientId: string
  teeth: number[]
  entriesOf: (tooth: number) => OdontogramEntry[]
  historyOf: (tooth: number) => OdontogramEntry[]
  /** Atención en borrador: sin ella el panel solo consulta. */
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
  onDirtyChange?: (dirty: boolean) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const canWrite = usePermission("clinical.write")
  const canRead = usePermission("clinical.read")
  const official = useOdontogramNotation()
  // Formato de la clínica para la tarifa vigente (moneda del catálogo).
  const orgLocale = useOrgProfile().data?.locale
  // Los hallazgos se registran dentro de una atención (fase 3, paso 5).
  const canMutate = !readOnly && canWrite && Boolean(encounterId)
  const uid = useId()
  const multi = teeth.length > 1
  const [tooth] = teeth
  const singleTooth = !multi && tooth != null ? tooth : null

  const allowedSurfaces = useMemo(
    () => (singleTooth != null ? surfacesForTooth(singleTooth).map(String) : []),
    [singleTooth],
  )

  const [choosingFinding, setChoosingFinding] = useState(true)
  const [savedMessage, setSavedMessage] = useState("")

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
  const [note, setNote] = useState("")
  // Diagnóstico de la atención: el que propone el hallazgo (o se elige) con su tipo.
  const [diagnosisCode, setDiagnosisCode] = useState("")
  const [diagnosisSystem, setDiagnosisSystem] = useState<string | null>(null)
  const [diagnosisDescription, setDiagnosisDescription] = useState("")
  const [diagnosisType, setDiagnosisType] = useState("")
  // Tratamiento: va al plan abierto de la persona, que nace con el primero (ADR 0034).
  const [treatService, setTreatService] = useState<ServiceCatalogItem | null>(null)
  const [treatDetail, setTreatDetail] = useState("")
  const [pending, setPending] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [formErrors, setFormErrors] = useState<string[]>([])

  const [voiding, setVoiding] = useState<{ id: string; label: string } | null>(null)
  const [voidReason, setVoidReason] = useState("")
  const [voidPending, setVoidPending] = useState(false)
  const [voidError, setVoidError] = useState<string | null>(null)

  const busy = pending || voidPending
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
    diagnosisType !== "" ||
    note !== "" ||
    treatService !== null ||
    treatDetail !== ""

  const draftWords = draftDirty && def ? findingWords(official, { condition, details: draftDetails }) : null

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
    const draft: OdontogramEntry = {
      id: `draft-${toothNumber}`,
      toothNumber,
      condition,
      surface: null,
      status: "recorded",
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

  const resetDetails = () => {
    setFreehand(false)
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
    setFormErrors([])
    setFormError(null)
  }

  const resetDraft = () => {
    resetDetails()
    setCondition("")
    setDiagnosisCode("")
    setDiagnosisSystem(null)
    setDiagnosisDescription("")
    setDiagnosisType("")
    setNote("")
    setTreatService(null)
    setTreatDetail("")
  }

  const selectCondition = (value: string | null | undefined) => {
    if (value === condition) {
      setChoosingFinding(false)
      return
    }
    // El detalle depende del hallazgo: nada de otra definición sobrevive.
    resetDetails()
    setCondition(value ?? "")
    setChoosingFinding(false)
    setSavedMessage("")
  }

  const planQuery = useQuery({
    queryKey: ["plan-items", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
    enabled: canRead,
  })
  const plansQuery = useQuery({
    queryKey: ["treatment-plans", patientId],
    queryFn: () => fetchTreatmentPlans(patientId),
    enabled: canRead && canMutate,
  })
  const hasOpenPlan = (plansQuery.data?.data ?? []).some((row) => row.isOpen)

  const docsQuery = useQuery({
    queryKey: ["patient-documents", patientId],
    queryFn: () => apiFetch<{ data: PatientDocument[] }>(`/api/patients/${patientId}/documents`),
    enabled: canRead,
  })
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

  const submitFinding = async () => {
    if (!canMutate || disabled || busy || teeth.length === 0 || !encounterId) return
    setFormError(null)
    setFormErrors([])
    if (!def) {
      setFormErrors(["Selecciona el hallazgo a registrar."])
      return
    }
    // La evidencia observada solo vale marcada explícitamente por el clínico.
    if (def.requiresEvidence && !clinicallyObserved) {
      setFormErrors(["Confirma que observaste clínicamente este hallazgo antes de registrarlo."])
      return
    }
    const code = diagnosisCode.trim()
    if (code && !diagnosisType) {
      setFormErrors(["Elige el tipo del diagnóstico: presuntivo o definitivo."])
      return
    }
    if (treatService && !TOOTH_SCOPES.includes(treatService.scope ?? "")) {
      setFormErrors([
        `«${treatService.name}» no es un tratamiento de una pieza: indícalo en «Plan y controles».`,
      ])
      return
    }
    // La misma regla del país que aplica el servidor, antes de enviar.
    const targets = isGroup ? [teeth[0]!] : [...teeth]
    const failures: string[] = []
    for (const toothNumber of targets) {
      const input: FindingInput = { toothNumber, condition, details: draftDetails }
      if (!isGroup && !multi && scope === "surface" && surfaces.length > 0) input.surfaces = [...surfaces]
      for (const message of validateFinding(input, { strictVariants: official?.strictVariants ?? false })) {
        failures.push(targets.length > 1 ? `Pieza ${toothNumber}: ${message}` : message)
      }
    }
    if (failures.length > 0) {
      setFormErrors(failures)
      return
    }
    setPending(true)
    onPendingChange?.(true)
    try {
      await beforeWrite?.()
      await apiFetch(`/api/patients/${patientId}/odontogram/findings`, {
        method: "POST",
        body: JSON.stringify({
          encounterId,
          toothNumbers: teeth,
          condition,
          // Las caras solo se registran con una sola pieza.
          surfaces: !isGroup && !multi && scope === "surface" ? surfaces : [],
          ...(Object.keys(draftDetails).length > 0 ? { details: draftDetails } : {}),
          note: note.trim() || null,
          diagnosis: code ? { diagnosisCode: code, diagnosisSystem, diagnosisType } : null,
          treatment: treatService ? { serviceId: treatService.id, detail: treatDetail.trim() || null } : null,
        }),
      })
      const planned = treatService !== null
      resetDraft()
      await onChanged()
      await Promise.all(
        [
          "plan-items",
          "treatment-plans",
          "treatment-plan",
          "budgets",
          "budget",
          "patient-summary",
          "plan-next",
          "encounter",
          "encounter-closing",
        ].map((key) => queryClient.invalidateQueries({ queryKey: [key, patientId] })),
      )
      setChoosingFinding(true)
      setSavedMessage(
        planned ? "Hallazgo registrado y tratamiento agregado al plan." : "Hallazgo registrado en el odontograma.",
      )
    } catch (err) {
      setFormError(mutationMessage(err, "No se pudo registrar el hallazgo."))
    } finally {
      setPending(false)
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
  const isDirty = canMutate && draftDirty
  useEffect(() => {
    onDirtyChange?.(isDirty)
    return () => onDirtyChange?.(false)
  }, [isDirty, onDirtyChange])
  const detailHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (!choosingFinding) detailHeading.current?.focus()
  }, [choosingFinding, condition])
  const activeError = formError ?? (formErrors.length ? formErrors.join(" ") : null)
  const faceEditing = canMutate && !disabled && !busy && !multi && scope === "surface" && !freehand
  // El trazo se dibuja sobre la vista previa con el Renderer (contrato final):
  // una sola pieza, sin puentes. El borrador lo controla este drawer.
  const drawEditing =
    canMutate && !disabled && !busy && !multi && showDrawing && (freehand || !!def?.requiresDrawing)

  const previewContent =
    teeth.length === 0 ? null : (
      <div className="flex flex-col gap-2 pt-2">
        {historical && <Badge variant="outline">Estado histórico · solo lectura</Badge>}
        {canMutate && draftDirty && def && (
          <Badge variant="outline" aria-live="polite">
            En edición · vista previa no guardada
            {draftWords ? ` · ${draftWords}` : ""}
          </Badge>
        )}
        <div>
          <div
            className={`grid gap-4 pr-3 ${multi ? "sm:grid-cols-2" : ""}`}
            aria-label="Piezas seleccionadas"
          >
            {(multi ? [] : teeth).map((toothNumber) => (
              <figure
                key={toothNumber}
                className="flex min-w-0 items-center gap-4 rounded-lg bg-muted/40 p-3 [&_svg]:max-h-32"
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
        </div>
        {!multi && showDrawing && canMutate && (
          <div className="flex flex-wrap gap-2">
            {!def?.requiresDrawing && (
              <Button
                type="button"
                size="sm"
                className="min-h-11"
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
                className="min-h-11"
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

  const submitLabel = treatService
    ? "Registrar y agregar al plan"
    : `Registrar hallazgo${multi && !isGroup ? ` (${teeth.length})` : ""}`
  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    if (!choosingFinding) void submitFinding()
  }
  const headerContent = historical ? (
    <div className="flex flex-wrap items-center gap-2 pt-2">
      <Badge variant="outline">Solo lectura · estado histórico</Badge>
    </div>
  ) : null
  const toothContexts = (
    <div className="flex flex-col gap-3 pt-2">
      {teeth.map((toothNumber) => (
        <ToothContext
          key={toothNumber}
          patientId={patientId}
          toothNumber={toothNumber}
          entries={entriesOf(toothNumber)}
          history={historyOf(toothNumber)}
          planQuery={planQuery}
          docsQuery={docsQuery}
          encounterId={encounterId}
          canMutate={canMutate && !disabled && !busy}
          voidPending={voidPending}
          defaultOpen
          onVoid={(id, label) => {
            setVoiding({ id, label })
            setVoidReason("")
            setVoidError(null)
          }}
        />
      ))}
    </div>
  )
  // Al elegir una sola pieza, primero su estado (hallazgos, plan, imágenes,
  // historial) y después el registro. Mientras se edita, el contexto baja y se
  // pliega para no competir con el formulario.
  const contextFirst = !multi && !draftDirty && (!canMutate || choosingFinding)
  const body = (
    <div className="flex flex-col gap-5">
      {savedMessage && (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {savedMessage}
        </p>
      )}
      {contextFirst ? toothContexts : null}

      {!canMutate ? (
        historical || readOnly || !canWrite ? (
          <p className="text-sm text-muted-foreground">
            {historical || readOnly
              ? "Solo lectura: no se pueden registrar cambios."
              : "No tienes permiso para registrar cambios en estas piezas."}
          </p>
        ) : (
          // Desde la ficha el odontograma se consulta: lo nuevo se registra atendiendo.
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed p-4">
            <p className="text-sm">Los hallazgos se registran dentro de una atención</p>
            <NewEncounterButton patientId={patientId} variant="outline" size="sm" />
          </div>
        )
      ) : choosingFinding ? (
        <FindingPicker value={condition} onChange={selectCondition} disabled={fieldDisabled} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <section aria-labelledby={`${uid}-hallazgo`} className="flex flex-col gap-4 sm:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <h3
                id={`${uid}-hallazgo`}
                tabIndex={-1}
                ref={detailHeading}
                className="text-base font-semibold outline-none"
              >
                Hallazgo · {def?.label}
              </h3>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={fieldDisabled}
                onClick={() => setChoosingFinding(true)}
              >
                Cambiar hallazgo
              </Button>
            </div>
            {previewContent}
          </section>

          {def?.variants?.length ? (
            <Field>
              <FieldLabel htmlFor={`${uid}-variant`}>{variantFieldLabel(official, condition)}</FieldLabel>
              <Select
                value={variant}
                items={Object.fromEntries(
                  def.variants.map((v) => [
                    v.value,
                    official && v.abbreviation ? `${v.label} · ${v.abbreviation}` : v.label,
                  ]),
                )}
                onValueChange={(v) => setVariant(v ?? "")}
              >
                <SelectTrigger
                  className="min-h-11"
                  id={`${uid}-variant`}
                  aria-label={variantFieldLabel(official, condition)}
                  disabled={fieldDisabled}
                >
                  <SelectValue placeholder="Elige…" />
                </SelectTrigger>
                <SelectContent>
                  {def.variants.map((v) => (
                    <SelectItem key={v.value} value={v.value}>
                      {official && v.abbreviation ? `${v.label} · ${v.abbreviation}` : v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          {def?.color === "quality" ? (
            <Field>
              <FieldLabel htmlFor={`${uid}-quality`}>Estado</FieldLabel>
              <Select
                value={quality}
                items={QUALITY_LABELS}
                onValueChange={(v) => setQuality(v ?? "")}
              >
                <SelectTrigger
                  className="min-h-11"
                  id={`${uid}-quality`}
                  aria-label="Estado"
                  disabled={fieldDisabled}
                >
                  <SelectValue placeholder="Elige el estado…" />
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
                  className="min-h-11"
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
                    className="flex min-h-11 items-center gap-2 rounded-md border p-2 text-sm"
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
                    className="flex min-h-11 items-center gap-2 rounded-md border p-2 text-sm"
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
                Selecciona una sola pieza para registrar por superficie. El hallazgo sin
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
                      className="flex min-h-11 items-center gap-2 rounded-md border p-2 text-sm"
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
                  Dibuja el trazo observado sobre la vista previa de la pieza
                  {drawing.length > 0
                    ? ` (${drawing.length} ${drawing.length === 1 ? "trazo" : "trazos"}).`
                    : "."}
                </p>
              )}
            </div>
          )}

          {def?.requiresEvidence && (
            <div className="sm:col-span-2">
              <label
                htmlFor={`${uid}-observed`}
                className="flex min-h-11 items-center gap-2 rounded-md border p-2 text-sm"
              >
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

          {(SPECIFICATION_HINTS[condition] || def?.code === "temporary_crown" || specifications) && (
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${uid}-specifications`}>Especificaciones</FieldLabel>
              <Textarea
                id={`${uid}-specifications`}
                value={specifications}
                disabled={fieldDisabled}
                maxLength={2000}
                placeholder="Material, clasificación u otra especificación…"
                onChange={(event) => setSpecifications(event.target.value)}
              />
              {SPECIFICATION_HINTS[condition] && (
                <p className="text-xs text-muted-foreground">{SPECIFICATION_HINTS[condition]}</p>
              )}
            </Field>
          )}

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

          <section
            aria-label="Diagnóstico"
            className="flex flex-col gap-3 border-t pt-4 sm:col-span-2"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
              <div>
                <DiagnosisPicker
                  patientId={patientId}
                  encounterId={null}
                  finding={condition ? { condition, variant: variant || null, toothNumber: tooth ?? null } : null}
                  value={diagnosisCode}
                  system={diagnosisSystem}
                  disabled={fieldDisabled}
                  onChange={(choice) => {
                    setDiagnosisCode(choice.code)
                    setDiagnosisSystem(choice.code ? choice.system : null)
                    setDiagnosisDescription(choice.code ? choice.description : "")
                  }}
                />
                {diagnosisDescription && (
                  <p className="mt-1 text-xs text-muted-foreground">{diagnosisDescription}</p>
                )}
              </div>
              <Field>
                <FieldLabel htmlFor={`${uid}-dx-type`}>Tipo</FieldLabel>
                <Select
                  value={diagnosisType}
                  items={DIAGNOSIS_TYPE_LABELS}
                  onValueChange={(v) => setDiagnosisType(v ?? "")}
                >
                  <SelectTrigger
                    className="min-h-11"
                    id={`${uid}-dx-type`}
                    disabled={fieldDisabled || !diagnosisCode}
                  >
                    <SelectValue placeholder="Elige…" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(DIAGNOSIS_TYPE_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">Cuenta como diagnóstico de esta atención</p>
          </section>

          <section aria-label="Tratamiento" className="flex flex-col gap-3 border-t pt-4 sm:col-span-2">
            <ServicePicker
              value={treatService?.id ?? ""}
              label="Tratamiento"
              onChange={(service) => setTreatService(service)}
              disabled={fieldDisabled}
            />
            {treatService ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm" aria-live="polite">
                <span>
                  {treatService.name}
                  {orgLocale
                    ? ` · ${formatMoney(treatService.priceCents, treatService.currency, orgLocale)}`
                    : ""}
                  {multi && !isGroup ? ` × ${teeth.length} piezas` : ""}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={fieldDisabled}
                  onClick={() => {
                    setTreatService(null)
                    setTreatDetail("")
                  }}
                >
                  Quitar
                </Button>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {treatService
                ? hasOpenPlan
                  ? "Se agrega a su plan, que ya está abierto"
                  : "Abre su plan con este tratamiento"
                : "Opcional: lo que propones hacer va al plan, aparte de lo observado"}
            </p>
            {treatService ? (
              <Field>
                <FieldLabel htmlFor={`${uid}-treat-detail`}>Detalle (opcional)</FieldLabel>
                <Textarea
                  id={`${uid}-treat-detail`}
                  value={treatDetail}
                  onChange={(e) => setTreatDetail(e.currentTarget.value)}
                  rows={2}
                  maxLength={4000}
                  disabled={fieldDisabled}
                />
              </Field>
            ) : null}
          </section>

          <Field className="sm:col-span-2">
            <FieldLabel htmlFor={`${uid}-note`}>Nota (opcional)</FieldLabel>
            <Textarea
              id={`${uid}-note`}
              value={note}
              disabled={fieldDisabled}
              maxLength={500}
              rows={2}
              placeholder="Detalle clínico del hallazgo…"
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
        </div>
      )}
      {contextFirst ? null : (
        <details>
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
            Estado y contexto de las piezas
          </summary>
          {toothContexts}
        </details>
      )}
    </div>
  )
  const hideSubmit = !canMutate || teeth.length === 0 || choosingFinding
  return (
    <>
      {inline ? (
        <FormPanel
          onClose={handleClose}
          title={title}
          description={description}
          headerContent={headerContent}
          hideSubmit={hideSubmit}
          onSubmit={submit}
          isDirty={isDirty}
          isSubmitting={busy}
          error={activeError}
          submitLabel={submitLabel}
          cancelLabel="Cerrar"
          submitDisabled={fieldDisabled || teeth.length === 0}
        >
          {body}
        </FormPanel>
      ) : (
        <FormDrawer
          open={open && voiding === null}
          onClose={handleClose}
          title={title}
          description={description}
          headerContent={headerContent}
          hideSubmit={hideSubmit}
          className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(42rem,calc(100vw-2rem))] data-[swipe-axis=y]:[--drawer-content-height:calc(100dvh-1rem)] data-[swipe-axis=y]:[--drawer-content-max-height:calc(100dvh-1rem)]"
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
        dock={false}
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

/**
 * Lo que tiene la pieza: su estado actual (lo registrado en esta atención se
 * anula aquí con motivo), su plan, su historia y sus imágenes. La evolución del
 * odontograma, con lo anulado, es una sola y vive junto al gráfico.
 */
function ToothContext({
  patientId,
  toothNumber,
  entries,
  history,
  planQuery,
  docsQuery,
  encounterId,
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
  encounterId?: string
  canMutate: boolean
  voidPending: boolean
  defaultOpen: boolean
  onVoid: (id: string, label: string) => void
}): React.JSX.Element {
  const official = useOdontogramNotation()
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
            <ul className="flex flex-col gap-1.5">
              {entries.map((entry) => {
                const words = findingWords(official, entry)
                // Solo lo registrado en la atención en curso se corrige aquí.
                const ownedHere = canMutate && !!encounterId && entry.encounterId === encounterId
                return (
                  <li
                    key={entry.id}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2 py-1.5 text-sm"
                  >
                    <span className="min-w-0 flex-1">
                      {words}
                      {entry.surface ? ` · ${clinicalSurfaceLabel(entry.surface)}` : ""}
                      {entry.diagnosisCode ? ` · ${diagnosisCodeLabel(entry.diagnosisSystem, entry.diagnosisCode)}` : ""}
                    </span>
                    {entry.needsReview ? <Badge variant="outline">Requiere revisión</Badge> : null}
                    {entry.leftByPlanItemId ? <Badge variant="outline">Lo dejó un tratamiento</Badge> : null}
                    {entry.createdAt ? (
                      <span className="text-xs text-muted-foreground">{timeAgo(entry.createdAt)}</span>
                    ) : null}
                    {ownedHere ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={voidPending}
                        onClick={() => onVoid(entry.id, `pieza ${toothNumber} (${findingWords(official, entry)})`)}
                      >
                        Anular
                      </Button>
                    ) : null}
                    {entry.note ? <p className="w-full text-muted-foreground">{entry.note}</p> : null}
                    {entry.needsReview && originalLegacyText(entry) ? (
                      <p className="w-full text-xs text-muted-foreground">{originalLegacyText(entry)}.</p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
          {needsReview.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {needsReview.length}{" "}
              {needsReview.length === 1
                ? "registro anterior migrado requiere"
                : "registros anteriores migrados requieren"}{" "}
              revisión clínica: se muestran en la evolución, fuera del dibujo.
            </p>
          )}
          {history.some((entry) => entry.status === "voided") ? (
            <p className="text-xs text-muted-foreground">
              Lo anulado de esta pieza sigue en la evolución, con su motivo.
            </p>
          ) : null}
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
                  <p className="text-xs font-medium text-muted-foreground">Tratamientos activos</p>
                  <ul className="flex flex-col gap-1">
                    {openPlan.map((item) => (
                      <li
                        key={item.id}
                        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
                      >
                        <span className="font-medium">{item.title}</span>
                        <Badge variant="outline">{planStatusLabel(item.status)}</Badge>
                        <span>Decisión: {planDecisionLabel(item.decisionStatus)}</span>
                        {item.detail && (
                          <p className="w-full text-muted-foreground">{item.detail}</p>
                        )}
                        {item.statusReason && <p className="w-full">{item.statusReason}</p>}
                        {item.odontogramEntryId && (
                          <p className="w-full text-xs">
                            Hallazgo de origen:{" "}
                            {(() => {
                              const origin = history.find((entry) => entry.id === item.odontogramEntryId)
                              return origin ? findingWords(official, origin) : "Consultar registro de origen"
                            })()}
                          </p>
                        )}
                        {item.sourceEncounterId && (
                          <a
                            className="text-xs underline"
                            href={`/patients/${patientId}/encounters/${item.sourceEncounterId}`}
                          >
                            Atención donde se indicó
                          </a>
                        )}
                        {item.diagnosisCode && (
                          <Badge variant="outline">{diagnosisCodeLabel(item.diagnosisSystem, item.diagnosisCode)}</Badge>
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
                          <Badge variant="outline">{diagnosisCodeLabel(item.diagnosisSystem, item.diagnosisCode)}</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>

        <ToothHistory patientId={patientId} toothNumber={toothNumber} />

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
      </div>
    </details>
  )
}

function useSignedDocUrl(
  patientId: string,
  documentId: string,
  variant: "original" | "thumb" = "original",
) {
  const canRead = usePermission("clinical.read")
  return useQuery({
    queryKey: ["patient-document-url", patientId, documentId, variant],
    queryFn: () =>
      apiFetch<{ data: { url: string } }>(
        `/api/patients/${patientId}/documents/${documentId}/url${variant === "thumb" ? "?variant=thumb" : ""}`,
      ),
    enabled: canRead,
    staleTime: SIGNED_URL_STALE_MS,
    gcTime: 30 * 60 * 1000,
  })
}

function ToothImageThumb({ patientId, doc }: { patientId: string; doc: PatientDocument }) {
  const urlQuery = useSignedDocUrl(patientId, doc.id)
  const url = urlQuery.data?.data.url ?? null
  const isImage = doc.contentType.startsWith("image/")
  const thumbQuery = useSignedDocUrl(patientId, doc.id, "thumb")
  const thumbUrl = thumbQuery.data?.data.url ?? url

  return (
    <li className="overflow-hidden rounded-md border">
      {url && isImage ? (
        <a href={url} target="_blank" rel="noreferrer" aria-label={`Ver ${doc.label}`}>
          <img
            src={thumbUrl ?? url}
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
