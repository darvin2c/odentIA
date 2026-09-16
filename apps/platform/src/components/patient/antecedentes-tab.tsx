import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
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
  Textarea,
} from "@odentia/ui"
import { EmptyState, ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { useCanWrite } from "../../lib/crm"
import {
  ALLERGY_SEVERITY_LABELS,
  type Allergy,
  type AnamnesisAnswers,
  CONDITION_STATUS_LABELS,
  type Condition,
  fetchAnamnesisHistory,
  fetchPatientHealth,
  HEALTH_REVIEW_LABELS,
  type HealthReviewState,
  type Medication,
  type PatientHealth,
  savePatientHealthApi,
} from "../../lib/patients"
import { AnamnesisVersionDialog } from "./anamnesis-history"

type Rec = Record<string, unknown>

interface AllergyDraft {
  key: string
  id?: string
  substance: string
  reaction: string
  severity: string
  isActive: boolean
}

interface ConditionDraft {
  key: string
  id?: string
  name: string
  status: string
  startDate: string
  endDate: string
  notes: string
}

interface MedicationDraft {
  key: string
  id?: string
  name: string
  dose: string
  frequency: string
  startDate: string
  endDate: string
  notes: string
}

interface ReviewDraft {
  allergies: HealthReviewState
  conditions: HealthReviewState
  medications: HealthReviewState
}

let keySeq = 0
function nextKey(): string {
  keySeq += 1
  return `ant-${keySeq}`
}

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

const REVIEW_OPTIONS: HealthReviewState[] = ["unknown", "recorded", "none"]
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
    })),
    conditions: health.conditions.map((c: Condition) => ({
      key: c.id,
      id: c.id,
      name: c.name,
      status: c.status,
      startDate: c.startDate ?? "",
      endDate: c.endDate ?? "",
      notes: c.notes ?? "",
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
    })),
    review: { ...health.reviewStatus },
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
    queryFn: () =>
      apiFetch<{ data: { dataConsentAt: string | null } }>(`/api/patients/${patientId}`),
  })

  const [allergies, setAllergies] = useState<AllergyDraft[]>([])
  const [conditions, setConditions] = useState<ConditionDraft[]>([])
  const [medications, setMedications] = useState<MedicationDraft[]>([])
  const [review, setReview] = useState<ReviewDraft>({
    allergies: "unknown",
    conditions: "unknown",
    medications: "unknown",
  })
  const [interview, setInterview] = useState<AnamnesisAnswers>({})
  const [interviewDirty, setInterviewDirty] = useState(false)
  const [consent, setConsent] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [versionId, setVersionId] = useState<string | null>(null)
  const [openPersonales, setOpenPersonales] = useState(true)
  const [openFamiliares, setOpenFamiliares] = useState(true)
  const [openOdonto, setOpenOdonto] = useState(true)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  const health = healthQuery.data?.data ?? null
  const versions = useMemo(() => historyQuery.data?.data ?? [], [historyQuery.data])
  const latestVersion = health?.latestAnamnesis?.version ?? 0
  const consentedAt = patientQuery.data?.data.dataConsentAt ?? null

  useEffect(() => {
    if (health && !dirtyRef.current) {
      const drafts = buildDrafts(health)
      setAllergies(drafts.allergies)
      setConditions(drafts.conditions)
      setMedications(drafts.medications)
      setReview(drafts.review)
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
      setFieldErrors({})
      setFormError(null)
      setStale(false)
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

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Revisión {health.revision} ·{" "}
          {health.latestAnamnesis
            ? `entrevista v${health.latestAnamnesis.version}`
            : "sin entrevista registrada"}
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
        </p>
        <Button
          type="submit"
          disabled={!canWrite || saveMutation.isPending || (!dirty && !interviewDirty)}
        >
          {saveMutation.isPending ? "Guardando…" : "Guardar antecedentes"}
        </Button>
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
                void healthQuery.refetch()
              }}
            >
              Recargar
            </Button>
          </div>
        </div>
      ) : null}
      {formError ? (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      ) : null}

      <AllergyGroup
        uid={uid}
        rows={allergies}
        review={review.allergies}
        disabled={!canWrite || saveMutation.isPending}
        errors={fieldErrors}
        onChange={(next) => {
          setAllergies(next)
          markDirty()
        }}
        onReview={(next) => {
          setReview((r) => ({ ...r, allergies: next }))
          markDirty()
        }}
      />

      <ConditionGroup
        uid={uid}
        rows={conditions}
        review={review.conditions}
        disabled={!canWrite || saveMutation.isPending}
        errors={fieldErrors}
        onChange={(next) => {
          setConditions(next)
          markDirty()
        }}
        onReview={(next) => {
          setReview((r) => ({ ...r, conditions: next }))
          markDirty()
        }}
      />

      <MedicationGroup
        uid={uid}
        rows={medications}
        review={review.medications}
        disabled={!canWrite || saveMutation.isPending}
        errors={fieldErrors}
        onChange={(next) => {
          setMedications(next)
          markDirty()
        }}
        onReview={(next) => {
          setReview((r) => ({ ...r, medications: next }))
          markDirty()
        }}
      />

      <Card>
        <CardHeader>
          <CardTitle>Entrevista de salud</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Collapsible open={openPersonales} onOpenChange={setOpenPersonales}>
            <CollapsibleTrigger className="text-sm font-medium">
              <span className="flex items-center gap-1">
                Personales <ChevronDown aria-hidden className="size-4" />
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="grid gap-3 pt-2 sm:grid-cols-2">
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
              <div className="grid gap-3 pt-2 sm:grid-cols-2">
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
              <dl className="grid gap-1 text-sm">
                {legacy.map((entry) => (
                  <div key={entry.label} className="grid grid-cols-[12rem_minmax(0,1fr)] gap-2">
                    <dt className="text-muted-foreground">{entry.label}</dt>
                    <dd className="whitespace-pre-wrap">{entry.text}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Consentimiento de datos</CardTitle>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button
          type="submit"
          disabled={!canWrite || saveMutation.isPending || (!dirty && !interviewDirty)}
        >
          {saveMutation.isPending ? "Guardando…" : "Guardar antecedentes"}
        </Button>
      </div>

      <AnamnesisVersionDialog
        patientId={patientId}
        versionId={versionId}
        onClose={() => setVersionId(null)}
      />
    </form>
  )
}

function ReviewSelect({
  id,
  value,
  disabled,
  error,
  onChange,
}: {
  id: string
  value: HealthReviewState
  disabled: boolean
  error?: string
  onChange: (next: HealthReviewState) => void
}): React.JSX.Element {
  return (
    <Field>
      <FieldLabel htmlFor={id}>Revisión del grupo</FieldLabel>
      <Select
        value={value}
        onValueChange={(v) => onChange(v as HealthReviewState)}
        disabled={disabled}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {REVIEW_OPTIONS.map((option) => (
            <SelectItem key={option} value={option}>
              {HEALTH_REVIEW_LABELS[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </Field>
  )
}

function AllergyGroup({
  uid,
  rows,
  review,
  disabled,
  errors,
  onChange,
  onReview,
}: {
  uid: string
  rows: AllergyDraft[]
  review: HealthReviewState
  disabled: boolean
  errors: Record<string, string>
  onChange: (next: AllergyDraft[]) => void
  onReview: (next: HealthReviewState) => void
}): React.JSX.Element {
  const fid = (name: string): string => `${uid}-${name}`
  const patch = (key: string, next: Partial<AllergyDraft>): void => {
    onChange(rows.map((r) => (r.key === key ? { ...r, ...next } : r)))
  }
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Alergias</CardTitle>
          <Badge
            variant={
              review === "recorded" ? "default" : review === "none" ? "secondary" : "outline"
            }
          >
            {HEALTH_REVIEW_LABELS[review]}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ReviewSelect
          id={fid("rev-alg")}
          value={review}
          disabled={disabled}
          error={errors[fid("rev-alg")]}
          onChange={onReview}
        />
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {review === "none"
              ? "Ausencia confirmada en este grupo."
              : "Sin registros. Agrega filas o confirma la ausencia."}
          </p>
        ) : null}
        {rows.map((row) => (
          <div key={row.key} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={fid(`alg-sus-${row.key}`)}>Sustancia</FieldLabel>
              <Input
                id={fid(`alg-sus-${row.key}`)}
                value={row.substance}
                disabled={disabled}
                onChange={(e) => patch(row.key, { substance: e.target.value })}
              />
              {errors[fid(`alg-sus-${row.key}`)] ? (
                <p className="text-sm text-destructive">{errors[fid(`alg-sus-${row.key}`)]}</p>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor={fid(`alg-rea-${row.key}`)}>Reacción</FieldLabel>
              <Input
                id={fid(`alg-rea-${row.key}`)}
                value={row.reaction}
                disabled={disabled}
                onChange={(e) => patch(row.key, { reaction: e.target.value })}
              />
              {errors[fid(`alg-rea-${row.key}`)] ? (
                <p className="text-sm text-destructive">{errors[fid(`alg-rea-${row.key}`)]}</p>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor={fid(`alg-sev-${row.key}`)}>Gravedad</FieldLabel>
              <Select
                value={row.severity === "" ? "__elegir__" : row.severity}
                onValueChange={(v) =>
                  patch(row.key, { severity: !v || v === "__elegir__" ? "" : v })
                }
                disabled={disabled}
              >
                <SelectTrigger id={fid(`alg-sev-${row.key}`)}>
                  <SelectValue placeholder="Elige la gravedad" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__elegir__">Elige la gravedad</SelectItem>
                  {SEVERITY_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {ALLERGY_SEVERITY_LABELS[s] ?? s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors[fid(`alg-sev-${row.key}`)] ? (
                <p className="text-sm text-destructive">{errors[fid(`alg-sev-${row.key}`)]}</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Si se desconoce, márcala como desconocida: sigue siendo alerta.
              </p>
            </Field>
            <div className="flex items-end gap-2">
              {row.id ? (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={fid(`alg-vig-${row.key}`)}
                    checked={row.isActive}
                    disabled={disabled}
                    onCheckedChange={(c: boolean) => patch(row.key, { isActive: c === true })}
                  />
                  <label htmlFor={fid(`alg-vig-${row.key}`)} className="text-sm">
                    Vigente (quitar para archivar)
                  </label>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
                >
                  Quitar fila
                </Button>
              )}
            </div>
          </div>
        ))}
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              onChange([
                ...rows,
                { key: nextKey(), substance: "", reaction: "", severity: "", isActive: true },
              ])
            }
          >
            Agregar otra
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function ConditionGroup({
  uid,
  rows,
  review,
  disabled,
  errors,
  onChange,
  onReview,
}: {
  uid: string
  rows: ConditionDraft[]
  review: HealthReviewState
  disabled: boolean
  errors: Record<string, string>
  onChange: (next: ConditionDraft[]) => void
  onReview: (next: HealthReviewState) => void
}): React.JSX.Element {
  const fid = (name: string): string => `${uid}-${name}`
  const patch = (key: string, next: Partial<ConditionDraft>): void => {
    onChange(rows.map((r) => (r.key === key ? { ...r, ...next } : r)))
  }
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Condiciones</CardTitle>
          <Badge
            variant={
              review === "recorded" ? "default" : review === "none" ? "secondary" : "outline"
            }
          >
            {HEALTH_REVIEW_LABELS[review]}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ReviewSelect
          id={fid("rev-con")}
          value={review}
          disabled={disabled}
          error={errors[fid("rev-con")]}
          onChange={onReview}
        />
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {review === "none"
              ? "Ausencia confirmada en este grupo."
              : "Sin registros. Agrega filas o confirma la ausencia."}
          </p>
        ) : null}
        {rows.map((row) => (
          <div key={row.key} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={fid(`con-nom-${row.key}`)}>Nombre</FieldLabel>
              <Input
                id={fid(`con-nom-${row.key}`)}
                value={row.name}
                disabled={disabled}
                onChange={(e) => patch(row.key, { name: e.target.value })}
              />
              {errors[fid(`con-nom-${row.key}`)] ? (
                <p className="text-sm text-destructive">{errors[fid(`con-nom-${row.key}`)]}</p>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor={fid(`con-est-${row.key}`)}>Estado</FieldLabel>
              <Select
                value={row.status}
                onValueChange={(v) => patch(row.key, { status: v ?? "activa" })}
                disabled={disabled}
              >
                <SelectTrigger id={fid(`con-est-${row.key}`)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {CONDITION_STATUS_LABELS[s] ?? s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors[fid(`con-est-${row.key}`)] ? (
                <p className="text-sm text-destructive">{errors[fid(`con-est-${row.key}`)]}</p>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor={fid(`con-ini-${row.key}`)}>Inicio</FieldLabel>
              <Input
                id={fid(`con-ini-${row.key}`)}
                type="date"
                value={row.startDate}
                disabled={disabled}
                onChange={(e) => patch(row.key, { startDate: e.target.value })}
              />
              {errors[fid(`con-ini-${row.key}`)] ? (
                <p className="text-sm text-destructive">{errors[fid(`con-ini-${row.key}`)]}</p>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor={fid(`con-fin-${row.key}`)}>Fin (vacío = activa)</FieldLabel>
              <Input
                id={fid(`con-fin-${row.key}`)}
                type="date"
                value={row.endDate}
                disabled={disabled}
                onChange={(e) => patch(row.key, { endDate: e.target.value })}
              />
              {errors[fid(`con-fin-${row.key}`)] ? (
                <p className="text-sm text-destructive">{errors[fid(`con-fin-${row.key}`)]}</p>
              ) : null}
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={fid(`con-not-${row.key}`)}>Notas</FieldLabel>
              <Textarea
                id={fid(`con-not-${row.key}`)}
                rows={2}
                value={row.notes}
                disabled={disabled}
                onChange={(e) => patch(row.key, { notes: e.target.value })}
              />
            </Field>
            {!row.id ? (
              <div className="sm:col-span-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
                >
                  Quitar fila
                </Button>
              </div>
            ) : null}
          </div>
        ))}
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              onChange([
                ...rows,
                {
                  key: nextKey(),
                  name: "",
                  status: "activa",
                  startDate: "",
                  endDate: "",
                  notes: "",
                },
              ])
            }
          >
            Agregar otra
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function MedicationGroup({
  uid,
  rows,
  review,
  disabled,
  errors,
  onChange,
  onReview,
}: {
  uid: string
  rows: MedicationDraft[]
  review: HealthReviewState
  disabled: boolean
  errors: Record<string, string>
  onChange: (next: MedicationDraft[]) => void
  onReview: (next: HealthReviewState) => void
}): React.JSX.Element {
  const fid = (name: string): string => `${uid}-${name}`
  const patch = (key: string, next: Partial<MedicationDraft>): void => {
    onChange(rows.map((r) => (r.key === key ? { ...r, ...next } : r)))
  }
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Medicación vigente</CardTitle>
          <Badge
            variant={
              review === "recorded" ? "default" : review === "none" ? "secondary" : "outline"
            }
          >
            {HEALTH_REVIEW_LABELS[review]}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ReviewSelect
          id={fid("rev-med")}
          value={review}
          disabled={disabled}
          error={errors[fid("rev-med")]}
          onChange={onReview}
        />
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {review === "none"
              ? "Ausencia confirmada en este grupo."
              : "Sin registros. Agrega filas o confirma la ausencia."}
          </p>
        ) : null}
        {rows.map((row) => (
          <div key={row.key} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={fid(`med-nom-${row.key}`)}>Nombre</FieldLabel>
              <Input
                id={fid(`med-nom-${row.key}`)}
                value={row.name}
                disabled={disabled}
                onChange={(e) => patch(row.key, { name: e.target.value })}
              />
              {errors[fid(`med-nom-${row.key}`)] ? (
                <p className="text-sm text-destructive">{errors[fid(`med-nom-${row.key}`)]}</p>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor={fid(`med-dos-${row.key}`)}>Dosis</FieldLabel>
              <Input
                id={fid(`med-dos-${row.key}`)}
                value={row.dose}
                disabled={disabled}
                placeholder="Se deja vacío si se desconoce, no se inventa"
                onChange={(e) => patch(row.key, { dose: e.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={fid(`med-fre-${row.key}`)}>Frecuencia</FieldLabel>
              <Input
                id={fid(`med-fre-${row.key}`)}
                value={row.frequency}
                disabled={disabled}
                onChange={(e) => patch(row.key, { frequency: e.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={fid(`med-ini-${row.key}`)}>Inicio</FieldLabel>
              <Input
                id={fid(`med-ini-${row.key}`)}
                type="date"
                value={row.startDate}
                disabled={disabled}
                onChange={(e) => patch(row.key, { startDate: e.target.value })}
              />
              {errors[fid(`med-ini-${row.key}`)] ? (
                <p className="text-sm text-destructive">{errors[fid(`med-ini-${row.key}`)]}</p>
              ) : null}
            </Field>
            {row.id ? (
              <Field>
                <FieldLabel htmlFor={fid(`med-fin-${row.key}`)}>Fin (suspender)</FieldLabel>
                <Input
                  id={fid(`med-fin-${row.key}`)}
                  type="date"
                  value={row.endDate}
                  disabled={disabled}
                  onChange={(e) => patch(row.key, { endDate: e.target.value })}
                />
                {errors[fid(`med-fin-${row.key}`)] ? (
                  <p className="text-sm text-destructive">{errors[fid(`med-fin-${row.key}`)]}</p>
                ) : null}
              </Field>
            ) : null}
            <Field className={row.id ? "" : "sm:col-span-2"}>
              <FieldLabel htmlFor={fid(`med-not-${row.key}`)}>Notas</FieldLabel>
              <Textarea
                id={fid(`med-not-${row.key}`)}
                rows={2}
                value={row.notes}
                disabled={disabled}
                onChange={(e) => patch(row.key, { notes: e.target.value })}
              />
            </Field>
            {!row.id ? (
              <div className="sm:col-span-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
                >
                  Quitar fila
                </Button>
              </div>
            ) : null}
          </div>
        ))}
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              onChange([
                ...rows,
                {
                  key: nextKey(),
                  name: "",
                  dose: "",
                  frequency: "",
                  startDate: "",
                  endDate: "",
                  notes: "",
                },
              ])
            }
          >
            Agregar otra
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
