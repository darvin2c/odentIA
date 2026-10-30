import {
  diagnosisCodeLabel,
  formatMoney,
} from "@odentia/clinical"
import {
  surfaceLabel as clinicalSurfaceLabel,
  type FindingDetails,
  type FindingField,
  type FindingDefinition,
  type FindingInput,
  type FindingScope,
  findingDefinition,
  findingIssues,
  surfacesForTooth,
  toothNameOf,
  toothTypeOf,
} from "@odentia/dental"
import {
  Badge,
  Button,
  Checkbox,
  Field,
  FieldLabel,
} from "@odentia/ui"
import { FormDrawer, FormPanel, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { apiFetch } from "@odentia/clinic-app/lib/api"
import { fetchTreatmentPlans, planDecisionLabel } from "@odentia/clinic-app/lib/budgets"
import { timeAgo, usePermission } from "@odentia/clinic-app/lib/crm"
import { useOrgProfile } from "@odentia/clinic-app/lib/org"
import { DIAGNOSIS_TYPE_LABELS, type PatientDocument, type PlanItem, planStatusLabel, toothTypeLabel } from "@odentia/clinic-app/lib/patients"
import { type OdontogramEntry } from "../../lib/dental/odontogram"
import type { ServiceCatalogItem } from "@odentia/clinic-app/lib/services"
import { FindingPicker } from "./finding-picker"
import { findingWords, useOdontogramNotation, variantFieldLabel } from "./odontogram-notation"
import { DiagnosisPicker } from "@odentia/clinic-app/components/patient/diagnosis-picker"
import { NewEncounterButton } from "@odentia/clinic-app/components/patient/new-encounter-button"
import { ServicePicker } from "@odentia/clinic-app/components/patient/service-picker"
import { ToothHistory } from "./tooth-history"
import { ToothSVG } from "./tooth-svg"

/** Las URL firmadas expiran: se consideran frescas 10 min y luego se regeneran. */
const SIGNED_URL_STALE_MS = 10 * 60 * 1000

const OPEN_PLAN_STATUSES: readonly string[] = ["pendiente", "programado", "en_curso", "suspendido"]

/** Cabecera compacta: evita un título gigante cuando se seleccionan muchas piezas. */
const MAX_HEAD_TEETH = 8

const QUALITY_OPTIONS = [
  { value: "good", label: "Buen estado" },
  { value: "poor", label: "Mal estado" },
]

const DIRECTION_OPTIONS = [
  { value: "clockwise", label: "Horaria" },
  { value: "counterclockwise", label: "Antihoraria" },
]

const DIAGNOSIS_TYPE_OPTIONS = Object.entries(DIAGNOSIS_TYPE_LABELS).map(([value, label]) => ({ value, label }))

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

/** El borrador del hallazgo: todo arranca vacío, sin valores clínicos inventados. */
interface FindingDraft {
  condition: string
  variant: string
  quality: string
  direction: string
  /** Lo escrito: se valida al registrar y se dice la causa (0, 2,5, «abc»). */
  grade: string
  positions: string[]
  surfaces: string[]
  abutments: number[]
  drawing: number[][][]
  /** Evidencia observada: solo lo marcado explícitamente por el clínico. */
  clinicallyObserved: boolean
  specifications: string
  observations: string
  note: string
  /** Diagnóstico de la atención: el que propone el hallazgo (o se elige) con su tipo. */
  diagnosisCode: string
  diagnosisSystem: string | null
  diagnosisDescription: string
  diagnosisType: string
  /** Tratamiento: va al plan abierto de la persona, que nace con el primero (ADR 0034). */
  treatService: ServiceCatalogItem | null
  treatDetail: string
}

/** Lo que depende del hallazgo elegido: se vacía al cambiarlo. */
const EMPTY_DETAILS = {
  variant: "",
  quality: "",
  direction: "",
  grade: "",
  positions: [],
  surfaces: [],
  abutments: [],
  drawing: [],
  clinicallyObserved: false,
  specifications: "",
  observations: "",
} satisfies Partial<FindingDraft>

const EMPTY_DRAFT: FindingDraft = {
  ...EMPTY_DETAILS,
  condition: "",
  note: "",
  diagnosisCode: "",
  diagnosisSystem: null,
  diagnosisDescription: "",
  diagnosisType: "",
  treatService: null,
  treatDetail: "",
}

/** Qué pide el hallazgo elegido: la misma regla decide qué campos se ven y en cuál se dice cada error. */
interface FindingLayout {
  def: FindingDefinition | undefined
  scope: FindingScope | undefined
  isGroup: boolean
  showVariant: boolean
  showQuality: boolean
  showSurfaces: boolean
  showDrawing: boolean
  showAbutments: boolean
  showDirection: boolean
  showGrade: boolean
  showPositions: boolean
  showObservations: boolean
  showEvidence: boolean
  showSpecifications: boolean
}

function findingLayout(
  draft: Pick<FindingDraft, "condition" | "specifications">,
  multi: boolean,
  hasSurfaces: boolean,
): FindingLayout {
  const { condition } = draft
  const def = condition ? findingDefinition(condition) : undefined
  const scope = def?.scope
  return {
    def,
    scope,
    isGroup: scope === "pair" || scope === "span" || scope === "arch",
    showVariant: !!def?.variants?.length,
    showQuality: def?.color === "quality",
    showSurfaces: scope === "surface" && !multi && hasSurfaces,
    showDrawing: !!def && (!!def.requiresDrawing || scope === "surface"),
    showAbutments: condition === "fixed_partial_denture",
    showDirection: condition === "rotation",
    showGrade: condition === "pathological_mobility",
    showPositions: condition === "abnormal_position",
    showObservations: condition === "clinical_observation",
    showEvidence: !!def?.requiresEvidence,
    showSpecifications: !!(SPECIFICATION_HINTS[condition] || def?.code === "temporary_crown" || draft.specifications),
  }
}

/** La lista con `item` puesto o quitado (caras, posiciones, pilares). */
function toggled<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((value) => value !== item) : [...list, item]
}

/** Lo escrito en «Grado de movilidad» como número («2,5» también), o null si no es un número. */
function writtenGrade(text: string): number | null {
  const trimmed = text.trim().replace(",", ".")
  if (!trimmed) return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

/**
 * Detalle del borrador con solo propiedades pertinentes al hallazgo actual:
 * la misma construcción alimenta la vista previa, la validación y el POST,
 * así lo que se ve es lo que se guarda. Nada stale de otro hallazgo viaja.
 */
function draftDetailsOf(draft: FindingDraft, layout: FindingLayout, teeth: readonly number[]): FindingDetails {
  const { def, scope, isGroup } = layout
  const details: FindingDetails = {}
  if (!def) return details
  if (def.variants?.length && draft.variant) details.variant = draft.variant
  if (def.color === "quality" && (draft.quality === "good" || draft.quality === "poor")) details.quality = draft.quality
  if (draft.condition === "rotation" && (draft.direction === "clockwise" || draft.direction === "counterclockwise"))
    details.direction = draft.direction
  if (draft.condition === "pathological_mobility") {
    const grade = writtenGrade(draft.grade)
    if (grade !== null) details.grade = grade
  }
  if (draft.condition === "abnormal_position" && draft.positions.length > 0) details.positions = [...draft.positions]
  if (isGroup && teeth.length > 0) details.relatedTeeth = [...teeth]
  if (scope === "span" && draft.abutments.length > 0) details.abutmentTeeth = [...draft.abutments]
  if (draft.clinicallyObserved) details.clinicallyObserved = true
  if (draft.drawing.length > 0) details.drawing = draft.drawing
  if (draft.specifications.trim()) details.specifications = draft.specifications.trim()
  if (draft.observations.trim()) details.observations = draft.observations.trim()
  return details
}

/** El campo de la pantalla donde se dice un error del hallazgo; null si no está a la vista. */
function draftFieldOf(field: FindingField, layout: FindingLayout): keyof FindingDraft | null {
  switch (field) {
    case "details.variant":
      return layout.showVariant ? "variant" : null
    case "details.quality":
      return layout.showQuality ? "quality" : null
    case "details.direction":
      return layout.showDirection ? "direction" : null
    case "details.grade":
      return layout.showGrade ? "grade" : null
    case "details.positions":
      return layout.showPositions ? "positions" : null
    case "details.abutmentTeeth":
      return layout.showAbutments ? "abutments" : null
    case "details.clinicallyObserved":
      return layout.showEvidence ? "clinicallyObserved" : null
    case "details.drawing":
      return layout.showDrawing ? "drawing" : null
    case "surfaces":
      return layout.showSurfaces ? "surfaces" : layout.showDrawing ? "drawing" : null
    case "details.specifications":
      return layout.showSpecifications ? "specifications" : null
    case "details.observations":
      return layout.showObservations ? "observations" : "note"
    case "note":
      return "note"
    default:
      return null
  }
}

/** Cómo se llama en la pantalla cada dato que el servidor señala en `/odontogram/findings`. */
const SERVER_FIELDS: Record<string, string> = {
  "details.variant": "variant",
  "details.quality": "quality",
  "details.grade": "grade",
  "details.direction": "direction",
  "details.positions": "positions",
  "details.abutmentTeeth": "abutments",
  "details.clinicallyObserved": "clinicallyObserved",
  "details.drawing": "drawing",
  "details.specifications": "specifications",
  "details.observations": "observations",
  "diagnosis.diagnosisCode": "diagnosisCode",
  "diagnosis.diagnosisType": "diagnosisType",
  "treatment.serviceId": "treatService",
  "treatment.detail": "treatDetail",
}

const voidSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Escribe el motivo de la anulación.")
    .max(500, "Escribe el motivo en 500 caracteres como mucho."),
})

const EMPTY_VOID = { reason: "" }

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

/** Una casilla de un grupo (pilares, posiciones, caras), unida al error del grupo. */
function GroupCheckbox({
  id,
  label,
  checked,
  disabled,
  invalid,
  describedBy,
  onToggle,
}: {
  id: string
  label: string
  checked: boolean
  disabled: boolean
  invalid: boolean
  describedBy: string | undefined
  onToggle: () => void
}) {
  return (
    <Field orientation="horizontal" className="min-h-11 rounded-md border p-2">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onCheckedChange={onToggle}
      />
      <FieldLabel htmlFor={id} className="font-normal">
        {label}
      </FieldLabel>
    </Field>
  )
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
  const [freehand, setFreehand] = useState(false)
  const [voiding, setVoiding] = useState<{ id: string; label: string } | null>(null)

  /**
   * La misma regla del país que aplica el servidor, antes de enviar: cada
   * error en su campo y, si no tiene campo a la vista, junto a los botones
   * con su pieza.
   */
  const validateDraft = (value: FindingDraft) => {
    const layout = findingLayout(value, multi, allowedSurfaces.length > 0)
    if (!layout.def) return { form: "Selecciona el hallazgo a registrar.", fields: {} }
    const fields: Partial<Record<keyof FindingDraft, string>> = {}
    // La evidencia observada solo vale marcada explícitamente por el clínico.
    if (layout.def.requiresEvidence && !value.clinicallyObserved)
      fields.clinicallyObserved = "Confirma que observaste clínicamente este hallazgo antes de registrarlo."
    if (layout.showGrade && value.grade.trim() && writtenGrade(value.grade) === null)
      fields.grade = "Escribe el grado con un número entero: 1, 2, 3…"
    if (value.diagnosisCode.trim() && !value.diagnosisType)
      fields.diagnosisType = "Elige el tipo del diagnóstico: presuntivo o definitivo."
    if (value.treatService && !TOOTH_SCOPES.includes(value.treatService.scope ?? ""))
      fields.treatService = `«${value.treatService.name}» no es un tratamiento de una pieza: indícalo en «Plan y controles».`
    const own = new Set(Object.keys(fields))
    const general = new Set<string>()
    const details = draftDetailsOf(value, layout, teeth)
    const targets = layout.isGroup ? teeth.slice(0, 1) : [...teeth]
    for (const toothNumber of targets) {
      const input: FindingInput = { toothNumber, condition: value.condition, details, note: value.note.trim() || null }
      if (layout.showSurfaces && value.surfaces.length > 0) input.surfaces = [...value.surfaces]
      for (const issue of findingIssues(input, { strictVariants: official?.strictVariants ?? false })) {
        const name = draftFieldOf(issue.field, layout)
        if (!name) {
          general.add(`Pieza ${toothNumber}: ${issue.message}`)
          continue
        }
        if (own.has(name)) continue
        const message = targets.length > 1 ? `Pieza ${toothNumber}: ${issue.message}` : issue.message
        const said = fields[name]
        fields[name] = !said ? message : said.includes(message) ? said : `${said} ${message}`
      }
    }
    if (general.size === 0 && Object.keys(fields).length === 0) return undefined
    return { form: general.size > 0 ? [...general].join(" ") : undefined, fields }
  }

  const form = useAppForm({
    defaultValues: EMPTY_DRAFT,
    validators: { onSubmit: ({ value }) => validateDraft(value) },
    onSubmit: async ({ value }) => {
      const layout = findingLayout(value, multi, allowedSurfaces.length > 0)
      const details = draftDetailsOf(value, layout, teeth)
      const code = value.diagnosisCode.trim()
      onPendingChange?.(true)
      try {
        await beforeWrite?.()
        await apiFetch(`/api/patients/${patientId}/odontogram/findings`, {
          method: "POST",
          body: JSON.stringify({
            encounterId,
            toothNumbers: teeth,
            condition: value.condition,
            // Las caras solo se registran con una sola pieza.
            surfaces: !layout.isGroup && !multi && layout.scope === "surface" ? value.surfaces : [],
            ...(Object.keys(details).length > 0 ? { details } : {}),
            note: value.note.trim() || null,
            diagnosis: code
              ? { diagnosisCode: code, diagnosisSystem: value.diagnosisSystem, diagnosisType: value.diagnosisType }
              : null,
            treatment: value.treatService
              ? { serviceId: value.treatService.id, detail: value.treatDetail.trim() || null }
              : null,
          }),
        })
        const planned = value.treatService !== null
        form.reset(EMPTY_DRAFT)
        setFreehand(false)
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
      } finally {
        onPendingChange?.(false)
      }
    },
  })
  const surface = useFormSurface(form, { fieldMap: SERVER_FIELDS })
  const draft = useStore(form.store, (state) => state.values)

  const voidForm = useAppForm({
    defaultValues: EMPTY_VOID,
    validators: { onSubmit: voidSchema },
    onSubmit: async ({ value }) => {
      if (!voiding) return
      onPendingChange?.(true)
      try {
        await beforeWrite?.()
        await apiFetch(`/api/patients/${patientId}/odontogram/entries/${voiding.id}/void`, {
          method: "POST",
          body: JSON.stringify({ reason: value.reason.trim() }),
        })
        setVoiding(null)
        voidForm.reset(EMPTY_VOID)
        await onChanged()
      } finally {
        onPendingChange?.(false)
      }
    },
  })
  const voidSurface = useFormSurface(voidForm)

  const busy = surface.isSubmitting || voidSurface.isSubmitting
  const fieldDisabled = !canMutate || disabled || busy

  const { condition, drawing, surfaces } = draft
  const layout = findingLayout(draft, multi, allowedSurfaces.length > 0)
  const { def, scope, isGroup, showSurfaces, showDrawing, showAbutments, showDirection, showGrade, showPositions } =
    layout
  const draftDetails = draftDetailsOf(draft, layout, teeth)
  // La vista previa no dibuja un grado que no vale (0, 2,5): ese se dice en su campo.
  const { grade: draftGrade, ...detailsWithoutGrade } = draftDetails
  const previewDetails =
    draftGrade === undefined || (Number.isInteger(draftGrade) && draftGrade >= 1) ? draftDetails : detailsWithoutGrade

  const draftDirty = (Object.keys(EMPTY_DRAFT) as Array<keyof FindingDraft>).some((key) => {
    const value = draft[key]
    return Array.isArray(value) ? value.length > 0 : value !== EMPTY_DRAFT[key]
  })

  const draftWords = draftDirty && def ? findingWords(official, { condition, details: previewDetails }) : null

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
    const entry: OdontogramEntry = {
      id: `draft-${toothNumber}`,
      toothNumber,
      condition,
      surface: null,
      status: "recorded",
      details: previewDetails,
    }
    return [
      ...base,
      ...draftSurfaces.map((surface) => ({
        ...entry,
        id: `draft-${toothNumber}-${surface ?? "whole"}`,
        surface,
      })),
    ]
  }
  const toggleSurface = (surface: string) => {
    form.setFieldValue("surfaces", (prev) => toggled(prev, surface))
  }
  const setDrawing = (next: number[][][]) => {
    form.setFieldValue("drawing", next)
  }

  const selectCondition = (value: string | null | undefined) => {
    if (value === condition) {
      setChoosingFinding(false)
      return
    }
    // El detalle depende del hallazgo: nada de otra definición sobrevive, ni sus errores.
    setFreehand(false)
    form.reset({ ...form.state.values, ...EMPTY_DETAILS, condition: value ?? "" }, { keepDefaultValues: true })
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

  const cancelVoid = () => {
    if (!voidSurface.isSubmitting) {
      setVoiding(null)
      voidForm.reset(EMPTY_VOID)
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

  const submitLabel = draft.treatService
    ? "Registrar y agregar al plan"
    : `Registrar hallazgo${multi && !isGroup ? ` (${teeth.length})` : ""}`
  // Mientras se elige el hallazgo no hay nada que registrar: Enter en el buscador no envía.
  const submit = (event: React.FormEvent): void => {
    if (choosingFinding || !canMutate || disabled || busy || teeth.length === 0) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    surface.onSubmit(event)
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
          voidPending={voidSurface.isSubmitting}
          defaultOpen
          onVoid={(id, label) => {
            voidForm.reset(EMPTY_VOID)
            setVoiding({ id, label })
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
            <form.AppField name="variant">
              {(field) => (
                <field.SelectField
                  id={`${uid}-variant`}
                  label={variantFieldLabel(official, condition)}
                  options={(def.variants ?? []).map((v) => ({
                    value: v.value,
                    label: official && v.abbreviation ? `${v.label} · ${v.abbreviation}` : v.label,
                  }))}
                  placeholder="Elige…"
                  disabled={fieldDisabled}
                  triggerClassName="min-h-11"
                />
              )}
            </form.AppField>
          ) : null}

          {def?.color === "quality" ? (
            <form.AppField name="quality">
              {(field) => (
                <field.SelectField
                  id={`${uid}-quality`}
                  label="Estado"
                  options={QUALITY_OPTIONS}
                  placeholder="Elige el estado…"
                  disabled={fieldDisabled}
                  triggerClassName="min-h-11"
                />
              )}
            </form.AppField>
          ) : null}

          {showDirection && (
            <form.AppField name="direction">
              {(field) => (
                <field.SelectField
                  id={`${uid}-direction`}
                  label="Dirección de rotación"
                  options={DIRECTION_OPTIONS}
                  placeholder="Selecciona la dirección…"
                  disabled={fieldDisabled}
                  triggerClassName="min-h-11"
                />
              )}
            </form.AppField>
          )}

          {showGrade && (
            <form.AppField name="grade">
              {(field) => (
                <field.TextField
                  id={`${uid}-grade`}
                  label="Grado de movilidad"
                  description="Solo grados patológicos (nunca M0)."
                  placeholder="1, 2, 3…"
                  inputMode="numeric"
                  disabled={fieldDisabled}
                />
              )}
            </form.AppField>
          )}

          {isGroup && (
            <div className="sm:col-span-2">
              <p className="text-xs text-muted-foreground">
                Se registrará una sola vez e incluirá las piezas: {teeth.join(", ")}.
              </p>
            </div>
          )}

          {showAbutments && (
            <form.AppField name="abutments">
              {(field) => (
                <field.Group
                  legend="Piezas pilar del tramo"
                  description="Marca las piezas pilar del tramo (puentes sobre pilares)."
                  className="flex flex-col gap-2 sm:col-span-2"
                >
                  {(control) => (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {teeth.map((toothNumber) => (
                        <GroupCheckbox
                          key={toothNumber}
                          id={`${uid}-abutment-${toothNumber}`}
                          label={`Pieza ${toothNumber}`}
                          checked={field.state.value.includes(toothNumber)}
                          disabled={fieldDisabled}
                          invalid={control.invalid}
                          describedBy={control.describedBy}
                          onToggle={() => {
                            field.handleChange(toggled(field.state.value, toothNumber))
                            field.handleBlur()
                          }}
                        />
                      ))}
                    </div>
                  )}
                </field.Group>
              )}
            </form.AppField>
          )}

          {showPositions && (
            <form.AppField name="positions">
              {(field) => (
                <field.Group legend="Posiciones (coexisten M/D/V/P/L)" className="flex flex-col gap-2 sm:col-span-2">
                  {(control) => (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {ABNORMAL_POSITIONS.map((position) => (
                        <GroupCheckbox
                          key={position}
                          id={`${uid}-position-${position}`}
                          label={clinicalSurfaceLabel(position)}
                          checked={field.state.value.includes(position)}
                          disabled={fieldDisabled}
                          invalid={control.invalid}
                          describedBy={control.describedBy}
                          onToggle={() => {
                            field.handleChange(toggled(field.state.value, position))
                            field.handleBlur()
                          }}
                        />
                      ))}
                    </div>
                  )}
                </field.Group>
              )}
            </form.AppField>
          )}

          <div className="sm:col-span-2">
            {scope === "surface" && multi ? (
              <p className="text-xs text-muted-foreground">
                Selecciona una sola pieza para registrar por superficie. El hallazgo sin
                superficies se replica a las {teeth.length} piezas.
              </p>
            ) : showSurfaces ? (
              <form.AppField name="surfaces">
                {(field) => (
                  <field.Group legend="Superficies comprometidas (o traza la forma observada)" className="flex flex-col gap-2">
                    {(control) => (
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {allowedSurfaces.map((s) => (
                          <GroupCheckbox
                            key={s}
                            id={`${uid}-surface-${s}`}
                            label={clinicalSurfaceLabel(s)}
                            checked={field.state.value.includes(s)}
                            disabled={fieldDisabled}
                            invalid={control.invalid}
                            describedBy={control.describedBy}
                            onToggle={() => {
                              field.handleChange(toggled(field.state.value, s))
                              field.handleBlur()
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </field.Group>
                )}
              </form.AppField>
            ) : null}
          </div>

          {showDrawing && (
            <form.AppField name="drawing">
              {(field) => (
                <field.Group
                  legend={`Registro gráfico${def?.requiresDrawing ? " (obligatorio)" : ""}`}
                  description={
                    multi
                      ? "Selecciona una sola pieza para dibujar el trazo sobre su vista previa."
                      : `Dibuja el trazo observado sobre la vista previa de la pieza${
                          field.state.value.length > 0
                            ? ` (${field.state.value.length} ${field.state.value.length === 1 ? "trazo" : "trazos"}).`
                            : "."
                        }`
                  }
                  className="flex flex-col gap-2 sm:col-span-2"
                >
                  {() => null}
                </field.Group>
              )}
            </form.AppField>
          )}

          {def?.requiresEvidence && (
            <form.AppField name="clinicallyObserved">
              {(field) => (
                <field.CheckboxField
                  id={`${uid}-observed`}
                  label="Observé clínicamente este hallazgo (obligatorio)"
                  disabled={fieldDisabled}
                  className="min-h-11 rounded-md border p-2 sm:col-span-2"
                />
              )}
            </form.AppField>
          )}

          {layout.showSpecifications && (
            <form.AppField name="specifications">
              {(field) => (
                <field.TextareaField
                  id={`${uid}-specifications`}
                  label="Especificaciones"
                  description={SPECIFICATION_HINTS[condition] || undefined}
                  disabled={fieldDisabled}
                  maxLength={2000}
                  placeholder="Material, clasificación u otra especificación…"
                  className="sm:col-span-2"
                />
              )}
            </form.AppField>
          )}

          {layout.showObservations && (
            <form.AppField name="observations">
              {(field) => (
                <field.TextareaField
                  id={`${uid}-observations`}
                  label="Observaciones"
                  disabled={fieldDisabled}
                  maxLength={2000}
                  placeholder="Observación clínica de la pieza…"
                  className="sm:col-span-2"
                />
              )}
            </form.AppField>
          )}

          <section
            aria-label="Diagnóstico"
            className="flex flex-col gap-3 border-t pt-4 sm:col-span-2"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
              <form.AppField name="diagnosisCode">
                {(field) => (
                  <field.Group legend="Diagnóstico" className="min-w-0 gap-1">
                    {(control) => (
                      <>
                        <DiagnosisPicker
                          id={control.id}
                          invalid={control.invalid}
                          aria-describedby={control.describedBy}
                          onBlur={control.onBlur}
                          patientId={patientId}
                          encounterId={null}
                          finding={
                            condition ? { condition, variant: draft.variant || null, toothNumber: tooth ?? null } : null
                          }
                          value={field.state.value}
                          system={draft.diagnosisSystem}
                          disabled={fieldDisabled}
                          onChange={(choice) => {
                            field.handleChange(choice.code)
                            form.setFieldValue("diagnosisSystem", choice.code ? choice.system : null)
                            form.setFieldValue("diagnosisDescription", choice.code ? choice.description : "")
                          }}
                        />
                        {draft.diagnosisDescription && (
                          <p className="mt-1 text-xs text-muted-foreground">{draft.diagnosisDescription}</p>
                        )}
                      </>
                    )}
                  </field.Group>
                )}
              </form.AppField>
              <form.AppField name="diagnosisType">
                {(field) => (
                  <field.SelectField
                    id={`${uid}-dx-type`}
                    label="Tipo"
                    options={DIAGNOSIS_TYPE_OPTIONS}
                    placeholder="Elige…"
                    disabled={fieldDisabled || !draft.diagnosisCode}
                    triggerClassName="min-h-11"
                  />
                )}
              </form.AppField>
            </div>
            <p className="text-xs text-muted-foreground">Cuenta como diagnóstico de esta atención</p>
          </section>

          <section aria-label="Tratamiento" className="flex flex-col gap-3 border-t pt-4 sm:col-span-2">
            <form.AppField name="treatService">
              {(field) => (
                <field.Control id={`${uid}-treat-service`} label="Tratamiento">
                  {(control) => (
                    <ServicePicker
                      id={control.id}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      value={field.state.value?.id ?? ""}
                      onChange={(service) => field.handleChange(service)}
                      disabled={fieldDisabled}
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
            {draft.treatService ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm" aria-live="polite">
                <span>
                  {draft.treatService.name}
                  {orgLocale
                    ? ` · ${formatMoney(draft.treatService.priceCents, draft.treatService.currency, orgLocale)}`
                    : ""}
                  {multi && !isGroup ? ` × ${teeth.length} piezas` : ""}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={fieldDisabled}
                  onClick={() => {
                    form.setFieldValue("treatService", null)
                    form.setFieldValue("treatDetail", "")
                  }}
                >
                  Quitar
                </Button>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {draft.treatService
                ? hasOpenPlan
                  ? "Se agrega a su plan, que ya está abierto"
                  : "Abre su plan con este tratamiento"
                : "Opcional: lo que propones hacer va al plan, aparte de lo observado"}
            </p>
            {draft.treatService ? (
              <form.AppField name="treatDetail">
                {(field) => (
                  <field.TextareaField
                    id={`${uid}-treat-detail`}
                    label="Detalle (opcional)"
                    rows={2}
                    maxLength={4000}
                    disabled={fieldDisabled}
                  />
                )}
              </form.AppField>
            ) : null}
          </section>

          <form.AppField name="note">
            {(field) => (
              <field.TextareaField
                id={`${uid}-note`}
                label="Nota (opcional)"
                disabled={fieldDisabled}
                maxLength={500}
                rows={2}
                placeholder="Detalle clínico del hallazgo…"
                className="sm:col-span-2"
              />
            )}
          </form.AppField>
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
          {...surface}
          onClose={handleClose}
          title={title}
          description={description}
          headerContent={headerContent}
          hideSubmit={hideSubmit}
          onSubmit={submit}
          isDirty={isDirty}
          isSubmitting={busy}
          submitLabel={submitLabel}
          cancelLabel="Cerrar"
          submitDisabled={fieldDisabled || teeth.length === 0}
        >
          {body}
        </FormPanel>
      ) : (
        <FormDrawer
          {...surface}
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
          submitLabel={submitLabel}
          cancelLabel="Cerrar"
          submitDisabled={fieldDisabled || teeth.length === 0}
        >
          {body}
        </FormDrawer>
      )}
      <FormDrawer
        {...voidSurface}
        dock={false}
        open={open && voiding !== null}
        onClose={cancelVoid}
        title="Anular registro odontológico"
        description={
          voiding
            ? `Anulación de ${voiding.label}. El registro original y el motivo permanecerán en el historial.`
            : undefined
        }
        submitLabel="Confirmar anulación"
        cancelLabel="Volver al registro"
        submitDisabled={!canMutate || disabled}
      >
        <voidForm.AppField name="reason">
          {(field) => (
            <field.TextareaField
              id={`${uid}-void-reason`}
              label="Motivo de la anulación (obligatorio)"
              placeholder="Ej. Registro duplicado, pieza equivocada…"
              rows={4}
              maxLength={500}
              disabled={voidSurface.isSubmitting}
            />
          )}
        </voidForm.AppField>
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
