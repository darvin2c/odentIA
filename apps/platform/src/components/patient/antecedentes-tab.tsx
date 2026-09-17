import {
  Badge,
  Button,
  Checkbox,
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
import { ErrorState, FormDrawer, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { useCanWrite } from "../../lib/crm"
import {
  type Allergy,
  type AnamnesisAnswers,
  type BloodGroup,
  type Condition,
  fetchAnamnesisHistory,
  fetchPatientHealth,
  HEALTH_REVIEW_LABELS,
  type HealthReviewState,
  isHealthReviewPending,
  type Medication,
  type PatientFull,
  type PatientHealth,
  savePatientHealthApi,
} from "../../lib/patients"
import { AnamnesisVersionDialog } from "./anamnesis-history"
import {
  AllergyRows,
  type AllergyRowValue,
  BLOOD_GROUP_LABELS,
  BloodGroupSelect,
  ConditionRows,
  type ConditionRowValue,
  DECLARATION_STATE_LABELS,
  MedicationRows,
  type MedicationRowValue,
  ReviewStateSelect,
} from "./patient-health-fields"

type Rec = Record<string, unknown>

interface AllergyDraft extends AllergyRowValue {
  id?: string
}

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
const SEVERITY_OPTIONS = ["leve", "moderada", "severa", "desconocida"]
const STATUS_OPTIONS = ["activa", "resuelta", "inactiva"]

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

function buildDrafts(health: PatientHealth): {
  allergies: AllergyDraft[]
  conditions: ConditionDraft[]
  medications: MedicationDraft[]
  review: ReviewDraft
  bloodGroup: BloodGroup | null
  interview: AnamnesisAnswers
} {
  return {
    allergies: health.allergies.map((a: Allergy) => ({
      key: a.id,
      id: a.id,
      substance: a.substance,
      reaction: a.reaction ?? "",
      severity: a.severity,
      isActive: a.isActive,
      persisted: true,
    })),
    conditions: health.conditions.map((c: Condition) => ({
      key: c.id,
      id: c.id,
      name: c.name,
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
      dose: m.dose ?? "",
      frequency: m.frequency ?? "",
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
  const canWrite = useCanWrite()
  const uid = useId()

  const healthQuery = useQuery({
    queryKey: ["patient-health", patientId],
    queryFn: () => fetchPatientHealth(patientId),
  })
  const historyQuery = useQuery({
    queryKey: ["anamnesis-history", patientId],
    queryFn: () => fetchAnamnesisHistory(patientId),
  })
  const patientQuery = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
  })

  const [allergies, setAllergies] = useState<AllergyDraft[]>([])
  const [conditions, setConditions] = useState<ConditionDraft[]>([])
  const [medications, setMedications] = useState<MedicationDraft[]>([])
  const [review, setReview] = useState<ReviewDraft>({
    allergies: "unknown",
    conditions: "unknown",
    medications: "unknown",
  })
  const [bloodGroup, setBloodGroup] = useState<BloodGroup | null>(null)
  const [interview, setInterview] = useState<AnamnesisAnswers>({})
  const [interviewDirty, setInterviewDirty] = useState(false)
  const [consent, setConsent] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [versionId, setVersionId] = useState<string | null>(null)
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [openPersonales, setOpenPersonales] = useState(true)
  const [openFamiliares, setOpenFamiliares] = useState(true)
  const [openOdonto, setOpenOdonto] = useState(true)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty || interviewDirty

  const health = healthQuery.data?.data ?? null
  const versions = useMemo(() => historyQuery.data?.data ?? [], [historyQuery.data])
  const latestVersion = health?.latestAnamnesis?.version ?? 0
  const consentedAt = patientQuery.data?.data.patient.dataConsentAt ?? null

  useEffect(() => {
    if (health && !dirtyRef.current) {
      const drafts = buildDrafts(health)
      setAllergies(drafts.allergies)
      setConditions(drafts.conditions)
      setMedications(drafts.medications)
      setReview(drafts.review)
      setBloodGroup(drafts.bloodGroup)
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
        reviewStatus: review,
        bloodGroup,
        allergies: allergies.map((a) => ({
          ...(a.id ? { id: a.id } : {}),
          substance: a.substance.trim(),
          reaction: a.reaction.trim() === "" ? null : a.reaction.trim(),
          severity: a.severity,
          isActive: a.isActive,
        })),
        conditions: conditions.map((c) => ({
          ...(c.id ? { id: c.id } : {}),
          name: c.name.trim(),
          status: c.status,
          startDate: c.startDate === "" ? null : c.startDate,
          endDate: c.endDate === "" ? null : c.endDate,
          notes: c.notes.trim() === "" ? null : c.notes.trim(),
        })),
        medications: medications.map((m) => ({
          ...(m.id ? { id: m.id } : {}),
          name: m.name.trim(),
          dose: m.dose.trim() === "" ? null : m.dose.trim(),
          frequency: m.frequency.trim() === "" ? null : m.frequency.trim(),
          startDate: m.startDate === "" ? null : m.startDate,
          endDate: m.endDate === "" ? null : m.endDate,
          notes: m.notes.trim() === "" ? null : m.notes.trim(),
        })),
        ...(interviewDirty
          ? { anamnesis: { expectedVersion: latestVersion, answers: sanitizeInterview(interview) } }
          : {}),
        ...(consent && !consentedAt ? { dataConsent: true as const } : {}),
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
    for (const row of allergies) {
      if (row.substance.trim() === "")
        take(fid(`alg-sus-${row.key}`), "La sustancia es obligatoria.")
      if (!SEVERITY_OPTIONS.includes(row.severity))
        take(
          fid(`alg-sev-${row.key}`),
          "Elige la gravedad: si se desconoce, márcala como desconocida.",
        )
      if (row.reaction.trim().length > 2000)
        take(fid(`alg-rea-${row.key}`), "Máximo 2000 caracteres.")
    }
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
      if (row.startDate !== "" && !isValidDateStr(row.startDate))
        take(fid(`med-ini-${row.key}`), "Fecha YYYY-MM-DD válida.")
      if (row.endDate !== "" && !isValidDateStr(row.endDate))
        take(fid(`med-fin-${row.key}`), "Fecha YYYY-MM-DD válida.")
      if (row.startDate !== "" && row.endDate !== "" && row.startDate > row.endDate) {
        take(fid(`med-fin-${row.key}`), "El fin no puede ser anterior al inicio.")
      }
    }
    const activeAlg = allergies.filter((r) => r.isActive).length
    const activeCon = conditions.filter((r) => r.status === "activa").length
    const activeMed = medications.filter((r) => r.endDate === "").length
    if (review.allergies === "none" && activeAlg > 0)
      take(fid("rev-alg"), "Hay alergias vigentes: no puede marcarse ausencia.")
    if (activeAlg > 0 && review.allergies !== "recorded")
      take(fid("rev-alg"), "Con alergias vigentes la revisión debe quedar registrada.")
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

  if (healthQuery.isPending) return <LoadingState />
  if (healthQuery.isError || !health) {
    return (
      <ErrorState
        error={healthQuery.error instanceof ApiError ? healthQuery.error.shape : null}
        onRetry={() => void healthQuery.refetch()}
      />
    )
  }

  const personales = groupOf(interview, "antecedentesPersonales")
  const odontologicos = groupOf(interview, "antecedentesOdontologicos")
  const legacy = legacyTexts(health.latestAnamnesis?.answers as AnamnesisAnswers | undefined)
  const fid = (name: string): string => `${uid}-${name}`
  const registration = patientQuery.data?.data.registration ?? null
  const pendingReview = isHealthReviewPending(health)
  const canSubmit = dirty || interviewDirty || pendingReview
  const submitLabel =
    pendingReview && !dirty && !interviewDirty ? "Revisar y guardar" : "Guardar antecedentes"
  const saving = !canWrite || saveMutation.isPending
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
          {canWrite ? (
            <Button type="button" onClick={() => setDrawerOpen(true)}>
              {submitLabel === "Revisar y guardar"
                ? "Revisar antecedentes"
                : allergies.length + conditions.length + medications.length > 0
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

      <AntecedentesSummary
        allergies={allergies}
        conditions={conditions}
        medications={medications}
        review={review}
        bloodGroup={bloodGroup}
        pendingReview={pendingReview}
      />

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
      <section aria-label="Grupo sanguíneo" className="flex flex-col gap-4 rounded-md bg-card p-4 sm:p-6">
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
      </section>

      <ClinicalGroupCard
        title="Alergias"
        review={review.allergies}
        reviewId={fid("rev-alg")}
        reviewError={fieldErrors[fid("rev-alg")]}
        readOnly={saving}
        onReview={(next) => {
          setReview((r) => ({ ...r, allergies: next }))
          markDirty()
        }}
        empty={
          allergies.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {review.allergies === "none"
                ? "Ausencia confirmada en este grupo."
                : "Sin registros. Agrega filas o confirma la ausencia."}
            </p>
          ) : null
        }
      >
        <AllergyRows
          mode="clinical"
          rows={allergies}
          onChange={(next) => {
            setAllergies(restoreIds(allergies, next))
            markDirty()
          }}
          readOnly={saving}
          errors={fieldErrors}
          idPrefix={uid}
        />
      </ClinicalGroupCard>

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

      <section aria-label="Entrevista de salud" className="flex flex-col gap-4 rounded-md bg-card p-4 sm:p-6">
        <div className="flex flex-col gap-1.5">
          <h3 className="font-heading text-base font-medium">Entrevista de salud</h3>
          <p className="text-xs text-muted-foreground">Una columna en móvil, dos en tablet y web.</p>
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
                {personales["embarazo"] === true ? (
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
              <Field>
                <FieldLabel htmlFor={fid("fam")}>Antecedentes familiares</FieldLabel>
                <Textarea
                  id={fid("fam")}
                  rows={2}
                  value={strOf((interview as Rec)["antecedentesFamiliares"])}
                  disabled={!canWrite}
                  onChange={(e) =>
                    setTopInterview(
                      "antecedentesFamiliares",
                      e.target.value === "" ? undefined : e.target.value,
                    )
                  }
                />
              </Field>
            </CollapsibleContent>
          </Collapsible>
        
          <Collapsible open={openOdonto} onOpenChange={setOpenOdonto}>
            <CollapsibleTrigger className="text-sm font-medium">
              <span className="flex items-center gap-1">
                Odontológicos y hábitos <ChevronDown aria-hidden className="size-4" />
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="grid gap-4 pt-2 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={fid("od-ult")}>Última visita</FieldLabel>
                  <Input
                    id={fid("od-ult")}
                    value={strOf(odontologicos["ultimaVisita"])}
                    disabled={!canWrite}
                    onChange={(e) =>
                      updateInterview(
                        "antecedentesOdontologicos",
                        "ultimaVisita",
                        e.target.value === "" ? undefined : e.target.value,
                      )
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={fid("od-cep")}>Cepillados al día (0–10)</FieldLabel>
                  <Input
                    id={fid("od-cep")}
                    type="number"
                    min={0}
                    max={10}
                    value={strOf(odontologicos["cepilladosAlDia"])}
                    disabled={!canWrite}
                    onChange={(e) => {
                      const t = e.target.value.trim()
                      updateInterview(
                        "antecedentesOdontologicos",
                        "cepilladosAlDia",
                        t === "" ? undefined : Number(t),
                      )
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={fid("od-exp")}>Experiencia previa</FieldLabel>
                  <Select
                    value={
                      strOf(odontologicos["experienciaPrevia"]) === ""
                        ? "sin-indicar"
                        : strOf(odontologicos["experienciaPrevia"])
                    }
                    onValueChange={(v) =>
                      updateInterview(
                        "antecedentesOdontologicos",
                        "experienciaPrevia",
                        !v || v === "sin-indicar" ? undefined : v,
                      )
                    }
                    disabled={!canWrite}
                  >
                    <SelectTrigger id={fid("od-exp")}>
                      <SelectValue placeholder="Sin indicar" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sin-indicar">Sin indicar</SelectItem>
                      <SelectItem value="positiva">Positiva</SelectItem>
                      <SelectItem value="regular">Regular</SelectItem>
                      <SelectItem value="traumatica">Traumática</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={fid("od-ans")}>Ansiedad dental</FieldLabel>
                  <Select
                    value={
                      strOf(odontologicos["ansiedadDental"]) === ""
                        ? "sin-indicar"
                        : strOf(odontologicos["ansiedadDental"])
                    }
                    onValueChange={(v) =>
                      updateInterview(
                        "antecedentesOdontologicos",
                        "ansiedadDental",
                        !v || v === "sin-indicar" ? undefined : v,
                      )
                    }
                    disabled={!canWrite}
                  >
                    <SelectTrigger id={fid("od-ans")}>
                      <SelectValue placeholder="Sin indicar" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sin-indicar">Sin indicar</SelectItem>
                      <SelectItem value="ninguna">Ninguna</SelectItem>
                      <SelectItem value="leve">Leve</SelectItem>
                      <SelectItem value="moderada">Moderada</SelectItem>
                      <SelectItem value="alta">Alta</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={fid("od-hilo")}
                      checked={odontologicos["hiloDental"] === true}
                      disabled={!canWrite}
                      onCheckedChange={(c: boolean) =>
                        updateInterview(
                          "antecedentesOdontologicos",
                          "hiloDental",
                          c === true ? true : undefined,
                        )
                      }
                    />
                    <label htmlFor={fid("od-hilo")} className="text-sm">
                      Hilo dental
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={fid("od-brux")}
                      checked={odontologicos["bruxismo"] === true}
                      disabled={!canWrite}
                      onCheckedChange={(c: boolean) =>
                        updateInterview(
                          "antecedentesOdontologicos",
                          "bruxismo",
                          c === true ? true : undefined,
                        )
                      }
                    />
                    <label htmlFor={fid("od-brux")} className="text-sm">
                      Bruxismo
                    </label>
                  </div>
                </div>
                <Field>
                  <FieldLabel htmlFor={fid("od-hab")}>
                    Hábitos (separados por coma, máx. 10)
                  </FieldLabel>
                  <Input
                    id={fid("od-hab")}
                    placeholder="tabaquismo, onicofagia"
                    value={
                      Array.isArray(odontologicos["habitos"])
                        ? (odontologicos["habitos"] as string[]).join(", ")
                        : ""
                    }
                    disabled={!canWrite}
                    onChange={(e) => {
                      const items = e.target.value
                        .split(",")
                        .map((x) => x.trim())
                        .filter((x) => x !== "")
                        .slice(0, 10)
                      updateInterview(
                        "antecedentesOdontologicos",
                        "habitos",
                        items.length > 0 ? items : undefined,
                      )
                    }}
                  />
                </Field>
              </div>
            </CollapsibleContent>
          </Collapsible>
        
          {legacy.length > 0 ? (
            <div
              className="flex flex-col gap-2 rounded-lg border border-dashed p-3"
              role="note"
              aria-label="Información previa por conciliar"
            >
              <p className="text-sm font-medium">Información previa por conciliar</p>
              <p className="text-xs text-muted-foreground">
                Textos de entrevistas anteriores (motivo, examen, diagnóstico o listas libres). Se
                muestran tal cual; no se convierten automáticamente en registros.
              </p>
              <dl className="grid gap-2 text-sm">
                {legacy.map((entry) => (
                  <div key={entry.label} className="grid gap-0.5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-2">
                    <dt className="text-muted-foreground">{entry.label}</dt>
                    <dd className="whitespace-pre-wrap">{entry.text}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </div>
      </section>

      <section aria-label="Consentimiento de datos" className="flex flex-col gap-4 rounded-md bg-card p-4 sm:p-6">
        <div className="flex flex-col gap-1.5">
          <h3 className="font-heading text-base font-medium">Consentimiento de datos</h3>
        </div>
        <div>
          {consentedAt ? (
            <p className="text-sm text-muted-foreground">
              Consentimiento de datos registrado
              {consentedAt ? ` el ${new Date(consentedAt).toLocaleDateString("es-PE")}` : ""}. No se
              modifica al completar salud.
            </p>
          ) : (
            <div className="flex items-start gap-2">
              <Checkbox
                id={fid("consent")}
                checked={consent}
                disabled={!canWrite}
                onCheckedChange={(c: boolean) => {
                  setConsent(c === true)
                  markDirty()
                }}
              />
              <label htmlFor={fid("consent")} className="text-sm">
                El paciente autoriza el tratamiento de sus datos clínicos. Se registra una sola vez.
              </label>
            </div>
          )}
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

/** Resumen de lectura: conteos por grupo + estado de revisión. Sin formularios. */
function AntecedentesSummary({
  allergies,
  conditions,
  medications,
  review,
  bloodGroup,
  pendingReview,
}: {
  allergies: AllergyDraft[]
  conditions: ConditionDraft[]
  medications: MedicationDraft[]
  review: ReviewDraft
  bloodGroup: BloodGroup | null
  pendingReview: boolean
}): React.JSX.Element {
  const activeAlg = allergies.filter((r) => r.isActive).length
  const activeCon = conditions.filter((r) => r.status === "activa").length
  const activeMed = medications.filter((r) => r.endDate === "").length
  const rows: Array<{ title: string; state: HealthReviewState; detail: string }> = [
    {
      title: "Alergias",
      state: review.allergies,
      detail:
        allergies.length === 0
          ? "Sin registros"
          : `${allergies.length} registro(s) · ${activeAlg} vigente(s)`,
    },
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
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="flex flex-col gap-1 rounded-md bg-card p-4">
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
        <div key={row.title} className="flex flex-col gap-1 rounded-md bg-card p-4">
          <span className="font-heading text-sm font-medium">{row.title}</span>
          <span className="text-sm text-muted-foreground">{row.detail}</span>
          <Badge
            variant={row.state === "recorded" ? "default" : row.state === "none" ? "secondary" : "outline"}
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
    <section aria-label={title} className="flex flex-col gap-4 rounded-md bg-card p-4 sm:p-6">
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Declaración original del registro</DialogTitle>
          <DialogDescription>
            Snapshot inmutable de lo declarado al crear la ficha. No se edita: los datos vigentes
            se corrigen con el editor clínico.
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
                <dd>{new Date(registration.createdAt).toLocaleString("es-PE")}</dd>
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
            {typeof registration.privacyNotice === "string" &&
            registration.privacyNotice !== "" ? (
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
