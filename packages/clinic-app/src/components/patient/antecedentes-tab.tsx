import { CONDITION_STATUSES, FAMILY_KINSHIP_LABELS } from "@odentia/clinical"
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
import { EmptyState, ErrorState, FormDrawer, SkeletonRegion } from "@odentia/ui-patterns"
import { AntecedentesSkeleton } from "../skeletons/person-sections"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, HeartPulse } from "lucide-react"
import type { ReactNode } from "react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import {
  type AnamnesisAnswers,
  type BloodGroup,
  type Condition,
  fetchAnamnesisHistory,
  fetchPatientHealth,
  HEALTH_REVIEW_LABELS,
  type HealthReviewState,
  hasHealthInfo,
  isHealthReviewPending,
  type Medication,
  type PatientFull,
  type PatientHealth,
  savePatientHealthApi,
} from "../../lib/patients"
import { ChoiceSelect } from "../ui/choice-select"
import { AllergiesCard } from "./allergies-card"
import { AnamnesisVersionDialog } from "./anamnesis-history"
import {
  BLOOD_GROUP_LABELS,
  BloodGroupSelect,
  ConditionRows,
  type ConditionRowValue,
  DECLARATION_STATE_LABELS,
  MedicationRows,
  type MedicationRowValue,
  ReviewStateSelect,
} from "./patient-health-fields"
import { activeOrgLocale } from "../../lib/locale"
import { productUi } from "../../product/product-ui"

type Rec = Record<string, unknown>

interface ConditionDraft extends ConditionRowValue {
  id?: string
}

interface MedicationDraft extends MedicationRowValue {
  id?: string
}

interface ReviewDraft {
  allergies: HealthReviewState
  conditions: HealthReviewState
  medications: HealthReviewState
}

type DraftId = { key: string; id?: string }

function strOf(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v) : ""
}

function groupOf(value: AnamnesisAnswers, group: string): Rec {
  const g = (value as Rec)[group]
  return typeof g === "object" && g !== null ? { ...(g as Rec) } : {}
}

function sanitizeInterview(value: AnamnesisAnswers): AnamnesisAnswers {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const t = node.trim()
      return t === "" ? undefined : t
    }
    if (Array.isArray(node)) {
      const items = node.map(walk).filter((x) => x !== undefined)
      return items.length > 0 ? items : undefined
    }
    if (node !== null && typeof node === "object") {
      const out: Rec = {}
      for (const [key, child] of Object.entries(node as Rec)) {
        const cleaned = walk(child)
        if (cleaned !== undefined) out[key] = cleaned
      }
      return Object.keys(out).length > 0 ? out : undefined
    }
    return node
  }
  return (walk(value) ?? {}) as AnamnesisAnswers
}

function isValidDateStr(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split("-").map(Number)
  const date = new Date(Date.UTC(y as number, (m as number) - 1, d as number))
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === (m as number) - 1 &&
    date.getUTCDate() === d
  )
}
const STATUS_OPTIONS: readonly string[] = CONDITION_STATUSES

const LEGACY_TOP_KEYS = [
  "motivoConsulta",
  "tiempoEnfermedad",
  "examenClinico",
  "diagnosticoPresuntivo",
  "diagnosticoCie10",
]

function legacyTexts(
  answers: AnamnesisAnswers | null | undefined,
): Array<{ label: string; text: string }> {
  if (!answers) return []
  const rec = answers as Rec
  const out: Array<{ label: string; text: string }> = []
  for (const key of LEGACY_TOP_KEYS) {
    const value = rec[key]
    if (typeof value === "string" && value.trim() !== "") out.push({ label: key, text: value })
    else if (value !== undefined && key !== "examenClinico" && key !== "diagnosticoCie10") {
      out.push({ label: key, text: JSON.stringify(value) })
    }
  }
  const personales = groupOf(answers, "antecedentesPersonales")
  for (const key of ["enfermedades", "medicacionHabitual"] as const) {
    if (typeof personales[key] === "string" && (personales[key] as string).trim() !== "") {
      out.push({ label: `antecedentesPersonales.${key}`, text: personales[key] as string })
    }
  }
  return out
}

interface FamilyDraft {
  key: string
  relationship: string
  condition: string
  diagnosisCode: string
  diagnosisSystem: string | null
}

/** Parentesco con HL7 v3 RoleCode, con las palabras de siempre (decisión 28). */
const FAMILY_RELATIONSHIP_OPTIONS = Object.entries(FAMILY_KINSHIP_LABELS)

/** Clasificación ASA del estado físico. */
const ASA_OPTIONS: Array<[string, string]> = [
  ["I", "ASA I · sano"],
  ["II", "ASA II · enfermedad sistémica leve"],
  ["III", "ASA III · enfermedad sistémica grave"],
  ["IV", "ASA IV · amenaza constante para la vida"],
  ["V", "ASA V · moribundo"],
  ["VI", "ASA VI · muerte cerebral (donante)"],
]

function buildDrafts(health: PatientHealth): {
  conditions: ConditionDraft[]
  medications: MedicationDraft[]
  review: ReviewDraft
  bloodGroup: BloodGroup | null
  asaClass: string
  familyHistory: FamilyDraft[]
  interview: AnamnesisAnswers
} {
  return {
    asaClass: health.asaClass ?? "",
    familyHistory: (health.familyHistory ?? []).map((row) => ({
      key: row.id,
      relationship: row.relationship,
      condition: row.condition,
      diagnosisCode: row.diagnosisCode ?? "",
      diagnosisSystem: row.diagnosisSystem ?? null,
    })),
    conditions: health.conditions.map((c: Condition) => ({
      key: c.id,
      id: c.id,
      name: c.name,
      diagnosisCode: c.diagnosisCode ?? "",
      diagnosisSystem: c.diagnosisSystem ?? null,
      status: c.status,
      startDate: c.startDate ?? "",
      endDate: c.endDate ?? "",
      notes: c.notes ?? "",
      persisted: true,
    })),
    medications: health.medications.map((m: Medication) => ({
      key: m.id,
      id: m.id,
      name: m.name,
      genericName: m.genericName ?? "",
      // Con número y unidad, lo escrito lo arma el servidor: no se muestra como «escrita antes».
      dose: m.doseValue ? "" : (m.dose ?? ""),
      doseValue: m.doseValue ? String(Number(m.doseValue)) : "",
      doseUnit: m.doseUnit ?? "",
      frequency: m.frequencyCode ? "" : (m.frequency ?? ""),
      frequencyCode: m.frequencyCode ?? "",
      startDate: m.startDate ?? "",
      endDate: m.endDate ?? "",
      notes: m.notes ?? "",
      persisted: true,
    })),
    review: { ...health.reviewStatus },
    bloodGroup: health.bloodGroup ?? null,
    interview: (health.latestAnamnesis?.answers ?? {}) as AnamnesisAnswers,
  }
}

export function AntecedentesTab({ patientId }: { patientId: string }): React.JSX.Element {
  const queryClient = useQueryClient()
  const canWrite = usePermission("clinical.write")
  const canRead = usePermission("clinical.read")
  const uid = useId()

  const healthQuery = useQuery({
    queryKey: ["patient-health", patientId],
    queryFn: () => fetchPatientHealth(patientId),
    enabled: canRead,
  })
  const historyQuery = useQuery({
    queryKey: ["anamnesis-history", patientId],
    queryFn: () => fetchAnamnesisHistory(patientId),
    enabled: canRead,
  })
  // Con lo clínico (condiciones, medicación y salud declarada): es una lectura clínica y deja su traza.
  const patientQuery = useQuery({
    queryKey: ["patient", patientId, "clinical"],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}?clinical=1`),
    enabled: canRead,
  })

  const [conditions, setConditions] = useState<ConditionDraft[]>([])
  const [medications, setMedications] = useState<MedicationDraft[]>([])
  const [review, setReview] = useState<ReviewDraft>({
    allergies: "unknown",
    conditions: "unknown",
    medications: "unknown",
  })
  const [bloodGroup, setBloodGroup] = useState<BloodGroup | null>(null)
  const [asaClass, setAsaClass] = useState("")
  const [familyHistory, setFamilyHistory] = useState<FamilyDraft[]>([])
  const [interview, setInterview] = useState<AnamnesisAnswers>({})
  const [interviewDirty, setInterviewDirty] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [versionId, setVersionId] = useState<string | null>(null)
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [openPersonales, setOpenPersonales] = useState(true)
  const [openFamiliares, setOpenFamiliares] = useState(true)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty || interviewDirty

  const health = healthQuery.data?.data ?? null
  // Lo del producto en la entrevista (issue 229).
  const productHealth = productUi().health
  const versions = useMemo(() => historyQuery.data?.data ?? [], [historyQuery.data])
  const latestVersion = health?.latestAnamnesis?.version ?? 0

  useEffect(() => {
    if (health && !dirtyRef.current) {
      const drafts = buildDrafts(health)
      setConditions(drafts.conditions)
      setMedications(drafts.medications)
      setReview(drafts.review)
      setBloodGroup(drafts.bloodGroup)
      setAsaClass(drafts.asaClass)
      setFamilyHistory(drafts.familyHistory)
      setInterview(drafts.interview)
      setInterviewDirty(false)
      setFieldErrors({})
      setFormError(null)
      setStale(false)
    }
  }, [health])

  const markDirty = (): void => setDirty(true)

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!health) throw new Error("Sin datos de salud para guardar")
      return savePatientHealthApi(patientId, {
        expectedRevision: health.revision,
        // Las alergias no viajan: se agregan y quitan una por una en su tarjeta (tablero 7).
        reviewStatus: { ...review, allergies: health.reviewStatus.allergies },
        bloodGroup,
        familyHistory: familyHistory
          .filter((row) => row.condition.trim() !== "")
          .map((row) => ({
            relationship: row.relationship,
            condition: row.condition.trim(),
            diagnosisCode: row.diagnosisCode || null,
            diagnosisSystem: row.diagnosisCode ? row.diagnosisSystem : null,
          })),
        asaClass: asaClass || null,
        conditions: conditions.map((c) => ({
          ...(c.id ? { id: c.id } : {}),
          name: c.name.trim(),
          diagnosisCode: c.diagnosisCode ? c.diagnosisCode : null,
          diagnosisSystem: c.diagnosisCode ? (c.diagnosisSystem ?? null) : null,
          status: c.status,
          startDate: c.startDate === "" ? null : c.startDate,
          endDate: c.endDate === "" ? null : c.endDate,
          notes: c.notes.trim() === "" ? null : c.notes.trim(),
        })),
        medications: medications.map((m) => ({
          ...(m.id ? { id: m.id } : {}),
          name: m.name.trim(),
          genericName: m.genericName?.trim() ? m.genericName.trim() : null,
          dose: m.dose.trim() === "" ? null : m.dose.trim(),
          // Con número y unidad, el servidor escribe la dosis («500 mg»); igual la frecuencia de la lista.
          doseValue: m.doseValue ? Number(m.doseValue.replace(",", ".")) : null,
          doseUnit: m.doseValue ? m.doseUnit || null : null,
          frequency: m.frequency.trim() === "" ? null : m.frequency.trim(),
          frequencyCode: m.frequencyCode || null,
          startDate: m.startDate === "" ? null : m.startDate,
          endDate: m.endDate === "" ? null : m.endDate,
          notes: m.notes.trim() === "" ? null : m.notes.trim(),
        })),
        ...(interviewDirty
          ? { anamnesis: { expectedVersion: latestVersion, answers: sanitizeInterview(interview) } }
          : {}),
      })
    },
    onSuccess: async () => {
      setDirty(false)
      setInterviewDirty(false)
      setFieldErrors({})
      setFormError(null)
      setStale(false)
      setDrawerOpen(false)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["patient-health", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["anamnesis-history", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["patient", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] }),
      ])
    },
    onError: (error) => {
      if (error instanceof ApiError && error.shape.code === "STALE_HEALTH_REVISION") {
        setStale(true)
        setFormError(null)
        return
      }
      setFormError(
        error instanceof ApiError ? (error.shape.message ?? error.message) : error.message,
      )
    },
  })

  function validateLocal(): { errors: Record<string, string>; firstId: string | null } {
    const errors: Record<string, string> = {}
    let firstId: string | null = null
    const take = (id: string, message: string): void => {
      errors[id] = message
      firstId ??= id
    }
    const fid = (name: string): string => `${uid}-${name}`
    for (const row of conditions) {
      if (row.name.trim() === "") take(fid(`con-nom-${row.key}`), "El nombre es obligatorio.")
      if (!STATUS_OPTIONS.includes(row.status)) take(fid(`con-est-${row.key}`), "Elige el estado.")
      if (row.startDate !== "" && !isValidDateStr(row.startDate))
        take(fid(`con-ini-${row.key}`), "Fecha YYYY-MM-DD válida.")
      if (row.endDate !== "" && !isValidDateStr(row.endDate))
        take(fid(`con-fin-${row.key}`), "Fecha YYYY-MM-DD válida.")
      if (row.startDate !== "" && row.endDate !== "" && row.startDate > row.endDate) {
        take(fid(`con-fin-${row.key}`), "El fin no puede ser anterior al inicio.")
      }
    }
    for (const row of medications) {
      if (row.name.trim() === "") take(fid(`med-nom-${row.key}`), "El nombre es obligatorio.")
      if (row.doseValue) {
        const value = Number(row.doseValue.replace(",", "."))
        if (!Number.isFinite(value) || value <= 0) take(fid(`med-dos-${row.key}`), "Escribe la dosis con un número mayor que cero.")
        else if (!row.doseUnit) take(fid(`med-uni-${row.key}`), "Elige la unidad.")
      }
      if (row.startDate !== "" && !isValidDateStr(row.startDate))
        take(fid(`med-ini-${row.key}`), "Fecha YYYY-MM-DD válida.")
      if (row.endDate !== "" && !isValidDateStr(row.endDate))
        take(fid(`med-fin-${row.key}`), "Fecha YYYY-MM-DD válida.")
      if (row.startDate !== "" && row.endDate !== "" && row.startDate > row.endDate) {
        take(fid(`med-fin-${row.key}`), "El fin no puede ser anterior al inicio.")
      }
    }
    const activeCon = conditions.filter((r) => r.status === "activa").length
    const activeMed = medications.filter((r) => r.endDate === "").length
    if (review.conditions === "none" && activeCon > 0)
      take(fid("rev-con"), "Hay condiciones activas: no puede marcarse ausencia.")
    if (activeCon > 0 && review.conditions !== "recorded")
      take(fid("rev-con"), "Con condiciones activas la revisión debe quedar registrada.")
    if (review.medications === "none" && activeMed > 0)
      take(fid("rev-med"), "Hay medicamentos vigentes: no puede marcarse ausencia.")
    if (activeMed > 0 && review.medications !== "recorded")
      take(fid("rev-med"), "Con medicamentos vigentes la revisión debe quedar registrada.")
    const personales = groupOf(interview, "antecedentesPersonales")
    if (personales["embarazo"] === true) {
      const sem = personales["semanasEmbarazo"]
      if (
        sem !== undefined &&
        (!Number.isInteger(sem) || (sem as number) < 0 || (sem as number) > 42)
      ) {
        take(fid("emb-sem"), "Semanas de 0 a 42.")
      }
    }
    return { errors, firstId }
  }

  function handleSubmit(event: React.FormEvent): void {
    event.preventDefault()
    if (!canWrite || saveMutation.isPending) return
    const { errors, firstId } = validateLocal()
    setFieldErrors(errors)
    if (firstId) {
      if (firstId.endsWith("emb-sem")) setOpenPersonales(true)
      document.getElementById(firstId)?.focus()
      return
    }
    setFormError(null)
    saveMutation.mutate()
  }

  function updateInterview(group: string, key: string, next: unknown): void {
    setInterview((prev) => {
      const g = groupOf(prev, group)
      if (next === undefined) delete g[key]
      else g[key] = next
      const out = { ...(prev as Rec) }
      if (Object.keys(g).length > 0) out[group] = g
      else delete out[group]
      return out as AnamnesisAnswers
    })
    setInterviewDirty(true)
    markDirty()
  }

  function setTopInterview(key: string, next: unknown): void {
    setInterview((prev) => {
      const out = { ...(prev as Rec) }
      if (next === undefined) delete out[key]
      else out[key] = next
      return out as AnamnesisAnswers
    })
    setInterviewDirty(true)
    markDirty()
  }

  if (healthQuery.isPending)
    return (
      <SkeletonRegion message="Cargando antecedentes…">
        <AntecedentesSkeleton canWrite={canWrite} />
      </SkeletonRegion>
    )
  if (healthQuery.isError || !health) {
    return (
      <ErrorState
        error={healthQuery.error instanceof ApiError ? healthQuery.error.shape : null}
        onRetry={() => void healthQuery.refetch()}
      />
    )
  }

  const personales = groupOf(interview, "antecedentesPersonales")
  const legacy = legacyTexts(health.latestAnamnesis?.answers as AnamnesisAnswers | undefined)
  const fid = (name: string): string => `${uid}-${name}`
  const registration = patientQuery.data?.data.registration ?? null
  const pendingReview = isHealthReviewPending(health)
  const canSubmit = dirty || interviewDirty || pendingReview
  const submitLabel =
    pendingReview && !dirty && !interviewDirty ? "Revisar y guardar" : "Guardar antecedentes"
  const saving = !canWrite || saveMutation.isPending
  // Nunca se preguntó: el vacío lo dice y lleva a registrarlo (ADR 0035).
  const unasked = !hasHealthInfo(health) && !dirty && !interviewDirty
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">
            Revisión {health.revision} ·{" "}
            {health.latestAnamnesis
              ? `entrevista v${health.latestAnamnesis.version}`
              : "sin entrevista registrada"}
          </p>
          {health.reviewedAt ? (
            <Badge variant="secondary">Revisado por personal autorizado</Badge>
          ) : pendingReview ? (
            <Badge variant="outline">
              Declarado por el paciente/responsable · pendiente de revisión
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {versions.length > 0 ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => setVersionId(versions[0]!.id)}
            >
              Ver historial ({versions.length})
            </Button>
          ) : null}
          {registration ? (
            <Button type="button" variant="link" size="sm" onClick={() => setSnapshotOpen(true)}>
              Ver declaración original
            </Button>
          ) : null}
          {canWrite && !unasked ? (
            <Button type="button" onClick={() => setDrawerOpen(true)}>
              {submitLabel === "Revisar y guardar"
                ? "Revisar antecedentes"
                : conditions.length + medications.length > 0
                  ? "Editar antecedentes"
                  : "Registrar antecedentes"}
            </Button>
          ) : null}
        </div>
      </div>

      {stale ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-xl border border-destructive/50 p-3"
        >
          <p className="text-sm">
            Otra sesión guardó antecedentes mientras editabas (revisión {health.revision}). Tus
            valores se conservan: recarga para ver lo nuevo y vuelve a guardar.
          </p>
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setDirty(false)
                setInterviewDirty(false)
                void healthQuery.refetch()
              }}
            >
              Recargar
            </Button>
          </div>
        </div>
      ) : null}
      {formError && !drawerOpen ? (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      ) : null}

      <AllergiesCard
        patientId={patientId}
        patientName={patientQuery.data?.data.patient.displayName ?? "el paciente"}
        health={health}
      />

      {unasked ? (
        <EmptyState
          icon={HeartPulse}
          title="Aún no se le preguntó por sus enfermedades ni su medicación"
          description="Enfermedades, medicación y la entrevista se registran juntas; «no preguntado» no es lo mismo que «niega»."
          actionLabel={canWrite ? "Registrar antecedentes" : undefined}
          onAction={canWrite ? () => setDrawerOpen(true) : undefined}
        />
      ) : (
        <AntecedentesSummary
          conditions={conditions}
          medications={medications}
          review={review}
          bloodGroup={bloodGroup}
          pendingReview={pendingReview}
        />
      )}
      <productHealth.Summary answers={(health.latestAnamnesis?.answers ?? {}) as Rec} />

      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Registrar antecedentes"
        description="Completa por secciones. En móvil avanza en una columna; en tablet y web el formulario usa dos columnas."
        headerContent={
          <p className="text-xs text-muted-foreground">
            Revisión {health.revision} ·{" "}
            {health.latestAnamnesis
              ? `entrevista v${health.latestAnamnesis.version}`
              : "sin entrevista registrada"}
          </p>
        }
        onSubmit={handleSubmit}
        isDirty={dirty || interviewDirty}
        isSubmitting={saveMutation.isPending}
        isLoading={healthQuery.isPending}
        error={formError}
        fieldErrors={fieldErrors}
        submitLabel={submitLabel}
        submitDisabled={!canWrite || !canSubmit}
        className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(48rem,calc(100vw-2rem))]"
      >
        <div className="flex flex-col gap-4">
          <section
            aria-label="Grupo sanguíneo"
            className="flex flex-col gap-4 elevated rounded-xl border bg-card p-4 sm:p-6"
          >
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-heading text-base font-medium">Grupo sanguíneo</div>
                {bloodGroup != null && pendingReview ? (
                  <Badge variant="outline">Declarado · pendiente de revisión</Badge>
                ) : null}
              </div>
            </div>
            <div>
              <BloodGroupSelect
                id={fid("blood")}
                value={bloodGroup}
                onChange={(next) => {
                  setBloodGroup(next)
                  markDirty()
                }}
                readOnly={saving}
                declared={bloodGroup != null}
              />
            </div>
            <Field>
              <FieldLabel htmlFor={fid("asa")}>Clasificación ASA</FieldLabel>
              <ChoiceSelect
                id={fid("asa")}
                className="max-w-md"
                value={asaClass}
                disabled={saving}
                onChange={(e) => {
                  setAsaClass(e.target.value)
                  markDirty()
                }}
              >
                <option value="">Sin clasificar</option>
                {ASA_OPTIONS.map(([value, optionLabel]) => (
                  <option key={value} value={value}>
                    {optionLabel}
                  </option>
                ))}
              </ChoiceSelect>
            </Field>
          </section>

          {/* Las alergias se agregan y quitan una por una en su tarjeta, fuera de este formulario (tablero 7). */}
          <ClinicalGroupCard
            title="Condiciones"
            review={review.conditions}
            reviewId={fid("rev-con")}
            reviewError={fieldErrors[fid("rev-con")]}
            readOnly={saving}
            onReview={(next) => {
              setReview((r) => ({ ...r, conditions: next }))
              markDirty()
            }}
            empty={
              conditions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {review.conditions === "none"
                    ? "Ausencia confirmada en este grupo."
                    : "Sin registros. Agrega filas o confirma la ausencia."}
                </p>
              ) : null
            }
          >
            <ConditionRows
              mode="clinical"
              rows={conditions}
              onChange={(next) => {
                setConditions(restoreIds(conditions, next))
                markDirty()
              }}
              readOnly={saving}
              errors={fieldErrors}
              idPrefix={uid}
            />
          </ClinicalGroupCard>

          <ClinicalGroupCard
            title="Medicación vigente"
            review={review.medications}
            reviewId={fid("rev-med")}
            reviewError={fieldErrors[fid("rev-med")]}
            readOnly={saving}
            onReview={(next) => {
              setReview((r) => ({ ...r, medications: next }))
              markDirty()
            }}
            empty={
              medications.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {review.medications === "none"
                    ? "Ausencia confirmada en este grupo."
                    : "Sin registros. Agrega filas o confirma la ausencia."}
                </p>
              ) : null
            }
          >
            <MedicationRows
              mode="clinical"
              rows={medications}
              onChange={(next) => {
                setMedications(restoreIds(medications, next))
                markDirty()
              }}
              readOnly={saving}
              errors={fieldErrors}
              idPrefix={uid}
            />
          </ClinicalGroupCard>

          <section
            aria-label="Entrevista de salud"
            className="flex flex-col gap-4 elevated rounded-xl border bg-card p-4 sm:p-6"
          >
            <div className="flex flex-col gap-1.5">
              <h3 className="font-heading text-base font-medium">Entrevista de salud</h3>
              <p className="text-xs text-muted-foreground">
                Una columna en móvil, dos en tablet y web.
              </p>
            </div>
            <div className="flex flex-col gap-4">
              <Collapsible open={openPersonales} onOpenChange={setOpenPersonales}>
                <CollapsibleTrigger className="text-sm font-medium">
                  <span className="flex items-center gap-1">
                    Personales <ChevronDown aria-hidden className="size-4" />
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="grid gap-4 pt-2 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor={fid("ap-hosp")}>Hospitalizaciones</FieldLabel>
                      <Input
                        id={fid("ap-hosp")}
                        value={strOf(personales["hospitalizaciones"])}
                        disabled={!canWrite}
                        onChange={(e) =>
                          updateInterview(
                            "antecedentesPersonales",
                            "hospitalizaciones",
                            e.target.value === "" ? undefined : e.target.value,
                          )
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={fid("ap-cir")}>Cirugías</FieldLabel>
                      <Input
                        id={fid("ap-cir")}
                        value={strOf(personales["cirugias"])}
                        disabled={!canWrite}
                        onChange={(e) =>
                          updateInterview(
                            "antecedentesPersonales",
                            "cirugias",
                            e.target.value === "" ? undefined : e.target.value,
                          )
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={fid("ap-tra")}>Transfusiones</FieldLabel>
                      <Input
                        id={fid("ap-tra")}
                        value={strOf(personales["transfusiones"])}
                        disabled={!canWrite}
                        onChange={(e) =>
                          updateInterview(
                            "antecedentesPersonales",
                            "transfusiones",
                            e.target.value === "" ? undefined : e.target.value,
                          )
                        }
                      />
                    </Field>
                    {productHealth.asksPregnancy ? (
                    <Field>
                      <FieldLabel htmlFor={fid("emb-estado")}>Embarazo</FieldLabel>
                      <Select
                        value={
                          personales["embarazo"] === true
                            ? "si"
                            : personales["embarazo"] === false
                              ? "no"
                              : "sin-responder"
                        }
                        onValueChange={(v) =>
                          updateInterview(
                            "antecedentesPersonales",
                            "embarazo",
                            v === "si" ? true : v === "no" ? false : undefined,
                          )
                        }
                        disabled={!canWrite}
                      >
                        <SelectTrigger id={fid("emb-estado")}>
                          <SelectValue placeholder="Sin responder" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="sin-responder">Sin responder</SelectItem>
                          <SelectItem value="si">Sí</SelectItem>
                          <SelectItem value="no">No</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    ) : null}
                    {productHealth.asksPregnancy && personales["embarazo"] === true ? (
                      <Field>
                        <FieldLabel htmlFor={fid("emb-sem")}>Semanas de embarazo (0–42)</FieldLabel>
                        <Input
                          id={fid("emb-sem")}
                          type="number"
                          min={0}
                          max={42}
                          value={strOf(personales["semanasEmbarazo"])}
                          disabled={!canWrite}
                          onChange={(e) => {
                            const t = e.target.value.trim()
                            updateInterview(
                              "antecedentesPersonales",
                              "semanasEmbarazo",
                              t === "" ? undefined : Number(t),
                            )
                          }}
                        />
                        {fieldErrors[fid("emb-sem")] ? (
                          <p className="text-sm text-destructive">{fieldErrors[fid("emb-sem")]}</p>
                        ) : null}
                      </Field>
                    ) : null}
                  </div>
                </CollapsibleContent>
              </Collapsible>

              <Collapsible open={openFamiliares} onOpenChange={setOpenFamiliares}>
                <CollapsibleTrigger className="text-sm font-medium">
                  <span className="flex items-center gap-1">
                    Familiares <ChevronDown aria-hidden className="size-4" />
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="flex flex-col gap-3 pt-2">
                    {familyHistory.map((row, index) => (
                      <div
                        key={row.key}
                        className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[10rem_1fr_auto]"
                      >
                        <Field>
                          <FieldLabel htmlFor={fid(`fam-rel-${row.key}`)}>Parentesco</FieldLabel>
                          <ChoiceSelect
                            id={fid(`fam-rel-${row.key}`)}
                            
                            value={row.relationship}
                            disabled={!canWrite}
                            onChange={(e) => {
                              setFamilyHistory((prev) =>
                                prev.map((r, i) =>
                                  i === index ? { ...r, relationship: e.target.value } : r,
                                ),
                              )
                              markDirty()
                            }}
                          >
                            {FAMILY_RELATIONSHIP_OPTIONS.map(([value, optionLabel]) => (
                              <option key={value} value={value}>
                                {optionLabel}
                              </option>
                            ))}
                          </ChoiceSelect>
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={fid(`fam-con-${row.key}`)}>Condición</FieldLabel>
                          <Input
                            id={fid(`fam-con-${row.key}`)}
                            value={row.condition}
                            maxLength={200}
                            disabled={!canWrite}
                            placeholder="Ej.: diabetes, hipertensión, cardiopatía"
                            onChange={(e) => {
                              setFamilyHistory((prev) =>
                                prev.map((r, i) =>
                                  i === index ? { ...r, condition: e.target.value } : r,
                                ),
                              )
                              markDirty()
                            }}
                          />
                        </Field>
                        {canWrite ? (
                          <div className="flex items-end">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setFamilyHistory((prev) => prev.filter((_, i) => i !== index))
                                markDirty()
                              }}
                            >
                              Quitar
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                    {canWrite ? (
                      <div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setFamilyHistory((prev) => [
                              ...prev,
                              {
                                key: `fam-${Date.now()}`,
                                relationship: "MTH",
                                condition: "",
                                diagnosisCode: "",
                                diagnosisSystem: null,
                              },
                            ])
                            markDirty()
                          }}
                        >
                          Agregar antecedente familiar
                        </Button>
                      </div>
                    ) : null}
                    {strOf((interview as Rec)["antecedentesFamiliares"]) ? (
                      <p className="text-xs text-muted-foreground">
                        Registro anterior en texto:{" "}
                        {strOf((interview as Rec)["antecedentesFamiliares"])}
                      </p>
                    ) : null}
                  </div>
                </CollapsibleContent>
              </Collapsible>

              {/* Lo del producto (odentIA: «Odontológicos y hábitos»; latidIA: embarazo, hábitos y vacunas). */}
              <productHealth.InterviewSections
                answers={interview as Rec}
                update={updateInterview}
                setGroup={setTopInterview}
                disabled={!canWrite}
                idPrefix={uid}
                sex={patientQuery.data?.data.patient.sex ?? null}
              />

              {legacy.length > 0 ? (
                <div
                  className="flex flex-col gap-2 rounded-lg border border-dashed p-3"
                  role="note"
                  aria-label="Información previa por conciliar"
                >
                  <p className="text-sm font-medium">Información previa por conciliar</p>
                  <p className="text-xs text-muted-foreground">
                    Textos de entrevistas anteriores (motivo, examen, diagnóstico o listas libres).
                    Se muestran tal cual; no se convierten automáticamente en registros.
                  </p>
                  <dl className="grid gap-2 text-sm">
                    {legacy.map((entry) => (
                      <div
                        key={entry.label}
                        className="grid gap-0.5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-2"
                      >
                        <dt className="text-muted-foreground">{entry.label}</dt>
                        <dd className="whitespace-pre-wrap">{entry.text}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </FormDrawer>

      <AnamnesisVersionDialog
        patientId={patientId}
        versionId={versionId}
        onClose={() => setVersionId(null)}
      />
      <RegistrationSnapshotDialog
        open={snapshotOpen}
        onClose={() => setSnapshotOpen(false)}
        registration={registration}
      />
    </div>
  )
}

/**
 * Resumen de lectura: conteos por grupo + estado de revisión. Sin formularios.
 * Las alergias tienen su propia tarjeta arriba (`AllergiesCard`).
 */
function AntecedentesSummary({
  conditions,
  medications,
  review,
  bloodGroup,
  pendingReview,
}: {
  conditions: ConditionDraft[]
  medications: MedicationDraft[]
  review: ReviewDraft
  bloodGroup: BloodGroup | null
  pendingReview: boolean
}): React.JSX.Element {
  const activeCon = conditions.filter((r) => r.status === "activa").length
  const activeMed = medications.filter((r) => r.endDate === "").length
  const rows: Array<{ title: string; state: HealthReviewState; detail: string }> = [
    {
      title: "Condiciones",
      state: review.conditions,
      detail:
        conditions.length === 0
          ? "Sin registros"
          : `${conditions.length} registro(s) · ${activeCon} activa(s)`,
    },
    {
      title: "Medicación vigente",
      state: review.medications,
      detail:
        medications.length === 0
          ? "Sin registros"
          : `${medications.length} registro(s) · ${activeMed} vigente(s)`,
    },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div className="flex flex-col gap-1 elevated rounded-xl border bg-card p-4">
        <span className="font-heading text-sm font-medium">Grupo sanguíneo</span>
        <span className="text-sm text-muted-foreground">
          {bloodGroup != null && bloodGroup in BLOOD_GROUP_LABELS
            ? BLOOD_GROUP_LABELS[bloodGroup as keyof typeof BLOOD_GROUP_LABELS]
            : "Sin registrar"}
        </span>
        {pendingReview && bloodGroup != null ? (
          <Badge variant="outline" className="mt-1 w-fit">
            Declarado · pendiente
          </Badge>
        ) : null}
      </div>
      {rows.map((row) => (
        <div key={row.title} className="flex flex-col gap-1 elevated rounded-xl border bg-card p-4">
          <span className="font-heading text-sm font-medium">{row.title}</span>
          <span className="text-sm text-muted-foreground">{row.detail}</span>
          <Badge
            variant={
              row.state === "recorded" ? "default" : row.state === "none" ? "secondary" : "outline"
            }
            className="mt-1 w-fit"
          >
            {HEALTH_REVIEW_LABELS[row.state]}
          </Badge>
        </div>
      ))}
    </div>
  )
}

/** Conserva el id persistido al editar filas compartidas (clave estable por fila). */
function restoreIds<T extends DraftId>(prev: Array<T & DraftId>, next: T[]): Array<T & DraftId> {
  const ids: Record<string, string | undefined> = {}
  for (const row of prev) ids[row.key] = row.id
  return next.map((row) => {
    const id = ids[row.key]
    return id ? { ...row, id } : row
  })
}

function ClinicalGroupCard({
  title,
  review,
  reviewId,
  reviewError,
  readOnly,
  onReview,
  empty,
  children,
}: {
  title: string
  review: HealthReviewState
  reviewId: string
  reviewError?: string
  readOnly: boolean
  onReview: (next: HealthReviewState) => void
  empty: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-4 elevated rounded-xl border bg-card p-4 sm:p-6"
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-heading text-base font-medium">{title}</div>
          <Badge
            variant={
              review === "recorded" ? "default" : review === "none" ? "secondary" : "outline"
            }
          >
            {HEALTH_REVIEW_LABELS[review]}
          </Badge>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <ReviewStateSelect
          id={reviewId}
          value={review}
          onChange={onReview}
          readOnly={readOnly}
          error={reviewError}
        />
        {children}
        {empty}
      </div>
    </section>
  )
}

const ENTRY_POINT_LABELS: Record<string, string> = {
  platform: "Plataforma (personal)",
  public_link: "Enlace público",
  qr: "Código QR",
  conversation: "Conversación",
  legacy: "Registro anterior: origen no disponible",
}

const RESPONDENT_LABELS: Record<string, string> = {
  patient: "Paciente",
  representative: "Responsable / representante",
  staff: "Personal",
}

function SnapshotGroup({
  title,
  group,
  nameKey,
}: {
  title: string
  group: unknown
  nameKey: "substance" | "name"
}): React.JSX.Element | null {
  if (!group || typeof group !== "object") return null
  const state = (group as Rec)["state"]
  const items = Array.isArray((group as Rec)["items"])
    ? ((group as Rec)["items"] as Array<Rec>)
    : []
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-sm font-medium">
        {title} ·{" "}
        {typeof state === "string" && state in DECLARATION_STATE_LABELS
          ? DECLARATION_STATE_LABELS[state as keyof typeof DECLARATION_STATE_LABELS]
          : "Sin responder"}
      </h4>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin entradas declaradas.</p>
      ) : (
        <ul className="list-inside list-disc text-sm">
          {items.map((item, index) => (
            <li key={index}>
              {typeof item[nameKey] === "string" ? (item[nameKey] as string) : "Entrada"}
              {typeof item["reaction"] === "string" && item["reaction"] !== ""
                ? ` · ${item["reaction"] as string}`
                : ""}
              {typeof item["severity"] === "string" ? ` (${item["severity"] as string})` : ""}
              {typeof item["notes"] === "string" && item["notes"] !== ""
                ? ` · ${item["notes"] as string}`
                : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Declaración original del registro (snapshot append-only): solo lectura, nunca
 * se edita desde aquí. Los datos vigentes se corrigen con el editor clínico.
 */
function RegistrationSnapshotDialog({
  open,
  onClose,
  registration,
}: {
  open: boolean
  onClose: () => void
  registration: PatientFull["registration"]
}): React.JSX.Element {
  const answers = (registration?.answers ?? {}) as Rec
  const health = (answers["health"] ?? {}) as Rec
  const representative = (answers["representative"] ?? null) as Rec | null
  const dental = (health["dental"] ?? null) as Rec | null
  const blood = health["bloodGroup"]
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent scrollable className="max-h-[85vh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Declaración original del registro</DialogTitle>
          <DialogDescription>
            Snapshot inmutable de lo declarado al crear la ficha. No se edita: los datos vigentes se
            corrigen con el editor clínico.
          </DialogDescription>
        </DialogHeader>
        {registration ? (
          <div className="flex flex-col gap-4 text-sm">
            <dl className="grid gap-1">
              <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">Entrada</dt>
                <dd>{ENTRY_POINT_LABELS[registration.entryPoint] ?? registration.entryPoint}</dd>
              </div>
              <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">Declarante</dt>
                <dd>
                  {registration.respondent
                    ? (RESPONDENT_LABELS[registration.respondent] ?? registration.respondent)
                    : "No disponible"}
                </dd>
              </div>
              <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">Fecha</dt>
                <dd>{new Date(registration.createdAt).toLocaleString(activeOrgLocale())}</dd>
              </div>
              <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">Registrado por</dt>
                <dd>{registration.actor?.name ?? "No registrado (envío público o legado)"}</dd>
              </div>
              {representative && typeof representative["displayName"] === "string" ? (
                <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-2">
                  <dt className="text-muted-foreground">Responsable declarado</dt>
                  <dd>
                    {representative["displayName"] as string}
                    {typeof representative["relationshipDetail"] === "string" &&
                    (representative["relationshipDetail"] as string) !== ""
                      ? ` (${representative["relationshipDetail"] as string})`
                      : ""}
                    {typeof representative["phone"] === "string"
                      ? ` · ${representative["phone"] as string}`
                      : ""}
                    {typeof representative["email"] === "string"
                      ? ` · ${representative["email"] as string}`
                      : ""}
                  </dd>
                </div>
              ) : null}
              <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">Grupo sanguíneo declarado</dt>
                <dd>
                  {typeof blood === "string" && blood in BLOOD_GROUP_LABELS
                    ? BLOOD_GROUP_LABELS[blood as keyof typeof BLOOD_GROUP_LABELS]
                    : "Sin responder"}
                </dd>
              </div>
            </dl>
            <SnapshotGroup title="Alergias" group={health["allergies"]} nameKey="substance" />
            <SnapshotGroup title="Enfermedades" group={health["conditions"]} nameKey="name" />
            <SnapshotGroup title="Medicación" group={health["medications"]} nameKey="name" />
            {dental ? (
              <section className="flex flex-col gap-1">
                <h4 className="text-sm font-medium">Odontológicos</h4>
                <dl className="grid gap-1">
                  {typeof dental["ultimaVisita"] === "string" ? (
                    <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-2">
                      <dt className="text-muted-foreground">Última visita</dt>
                      <dd>{dental["ultimaVisita"] as string}</dd>
                    </div>
                  ) : null}
                  {typeof dental["experienciaPrevia"] === "string" ? (
                    <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-2">
                      <dt className="text-muted-foreground">Experiencia previa</dt>
                      <dd>{dental["experienciaPrevia"] as string}</dd>
                    </div>
                  ) : null}
                  {typeof dental["ansiedadDental"] === "string" ? (
                    <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-2">
                      <dt className="text-muted-foreground">Ansiedad dental</dt>
                      <dd>{dental["ansiedadDental"] as string}</dd>
                    </div>
                  ) : null}
                </dl>
              </section>
            ) : null}
            {typeof registration.privacyNotice === "string" && registration.privacyNotice !== "" ? (
              <section className="flex flex-col gap-1">
                <h4 className="text-sm font-medium">Aviso de privacidad aceptado</h4>
                <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                  {registration.privacyNotice}
                </p>
              </section>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Sin snapshot de registro.</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
