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
} from "@odentia/ui"
import {
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, HeartPulse } from "lucide-react"
import type { ReactNode } from "react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { clinicToday } from "../../lib/inventory"
import {
  type AnamnesisAnswers,
  fetchAnamnesisHistory,
  fetchPatientHealth,
  HEALTH_REVIEW_LABELS,
  type HealthReviewState,
  hasHealthInfo,
  isHealthReviewPending,
  type PatientFull,
  type PatientHealth,
  type SaveHealthInput,
  savePatientHealthApi,
} from "../../lib/patients"
import { ChoiceSelect } from "../ui/choice-select"
import { AllergiesCard } from "./allergies-card"
import { AnamnesisVersionDialog } from "./anamnesis-history"
import {
  BLOOD_GROUP_LABELS,
  BloodGroupField,
  ConditionRows,
  DECLARATION_STATE_LABELS,
  HEALTH_NAME_MAX,
  HEALTH_NOTES_MAX,
  type HealthFormValues,
  healthFormOptions,
  MedicationRows,
  ReviewStateField,
} from "./patient-health-fields"
import { activeOrgLocale } from "../../lib/locale"
import { productUi, type SubFieldErrors } from "../../product/product-ui"

type Rec = Record<string, unknown>

function strOf(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v) : ""
}

function groupOf(value: Rec, group: string): Rec {
  const g = value[group]
  return typeof g === "object" && g !== null ? { ...(g as Rec) } : {}
}

function sanitizeInterview(value: Rec): AnamnesisAnswers {
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

/** La entrevista como texto estable (claves ordenadas): para saber si cambió. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? ""
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.entries(value as Rec)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`
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
  const personales = groupOf(rec, "antecedentesPersonales")
  for (const key of ["enfermedades", "medicacionHabitual"] as const) {
    if (typeof personales[key] === "string" && (personales[key] as string).trim() !== "") {
      out.push({ label: `antecedentesPersonales.${key}`, text: personales[key] as string })
    }
  }
  return out
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

/** Lo guardado, como lo edita el formulario. */
function buildDrafts(health: PatientHealth): HealthFormValues {
  const interview = (health.latestAnamnesis?.answers ?? {}) as Rec
  const weeks = groupOf(interview, "antecedentesPersonales")["semanasEmbarazo"]
  return {
    asaClass: health.asaClass ?? "",
    familyHistory: (health.familyHistory ?? []).map((row) => ({
      key: row.id,
      relationship: row.relationship,
      condition: row.condition,
      diagnosisCode: row.diagnosisCode ?? "",
      diagnosisSystem: row.diagnosisSystem ?? null,
    })),
    conditions: health.conditions.map((c) => ({
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
    medications: health.medications.map((m) => ({
      key: m.id,
      id: m.id,
      name: m.name,
      genericName: m.genericName ?? "",
      // Con número y unidad, lo escrito lo arma el servidor: no se muestra como «escrita antes».
      dose: m.doseValue ? "" : (m.dose ?? ""),
      doseValue: m.doseValue ? String(Number(m.doseValue)) : "",
      doseUnit: m.doseUnit ?? "",
      // Lo escrito sin frecuencia de la lista es «Otra».
      frequency: m.frequencyCode ? "" : (m.frequency ?? ""),
      frequencyCode: m.frequencyCode ?? (m.frequency?.trim() ? "otra" : ""),
      startDate: m.startDate ?? "",
      endDate: m.endDate ?? "",
      notes: m.notes ?? "",
      persisted: true,
    })),
    reviewStatus: {
      conditions: health.reviewStatus.conditions,
      medications: health.reviewStatus.medications,
    },
    bloodGroup: health.bloodGroup ?? "",
    interview,
    pregnancyWeeks: typeof weeks === "number" ? String(weeks) : "",
  }
}

/** Desde dónde se editó: revisión del agregado, versión de la entrevista y cómo era. */
interface HealthBase {
  revision: number
  version: number
  interview: string
}

/** La entrevista con las semanas de embarazo (odentIA las pregunta en «Personales»). */
function interviewOf(value: HealthFormValues, asksPregnancy: boolean): Rec {
  if (!asksPregnancy) return value.interview
  const personales = groupOf(value.interview, "antecedentesPersonales")
  const weeks = value.pregnancyWeeks.trim()
  if (personales["embarazo"] === true && weeks !== "") personales["semanasEmbarazo"] = Number(weeks)
  else delete personales["semanasEmbarazo"]
  const out = { ...value.interview }
  if (Object.keys(personales).length > 0) out["antecedentesPersonales"] = personales
  else delete out["antecedentesPersonales"]
  return out
}

const INTERVIEW_PREFIX = "anamnesis.answers."

/** Lo que el servidor dijo de la entrevista, con las claves de `InterviewSections` («habitos.tabaco»). */
function interviewErrorsOf(fields: Record<string, string> | undefined): SubFieldErrors {
  const out: SubFieldErrors = {}
  for (const [key, message] of Object.entries(fields ?? {})) {
    if (!key.startsWith(INTERVIEW_PREFIX)) continue
    out[key.slice(INTERVIEW_PREFIX.length).replace(/\[(\d+)\]/g, ".$1")] = message
  }
  return out
}

const tooLong = (max: number) => `Escribe como mucho ${max} caracteres.`
const dateText = z.string().refine((v) => v === "" || isValidDateStr(v), "Escribe la fecha completa.")
const endAfterStart = (row: { startDate: string; endDate: string }, ctx: z.core.$RefinementCtx) => {
  if (row.startDate !== "" && row.endDate !== "" && row.startDate > row.endDate)
    ctx.addIssue({ code: "custom", path: ["endDate"], message: "El fin no puede ser anterior al inicio." })
}
const nameText = z
  .string()
  .trim()
  .min(1, "Escribe el nombre.")
  .max(HEALTH_NAME_MAX, tooLong(HEALTH_NAME_MAX))
const notesText = z.string().max(HEALTH_NOTES_MAX, tooLong(HEALTH_NOTES_MAX))

/** Los mismos límites y reglas que `PUT /api/patients/:id/health` y su servicio. */
function healthSchema(
  asksPregnancy: boolean,
  validateInterview: (interview: Rec) => SubFieldErrors,
) {
  const reviewState = z.enum(["unknown", "none", "recorded"])
  return z
    .object({
      bloodGroup: z.string(),
      asaClass: z.string(),
      conditions: z.array(
        z
          .object({
            key: z.string(),
            id: z.string().optional(),
            name: nameText,
            diagnosisCode: z.string(),
            diagnosisSystem: z.string().nullable(),
            persisted: z.boolean(),
            status: z
              .string()
              .refine((v) => (CONDITION_STATUSES as readonly string[]).includes(v), "Elige el estado."),
            startDate: dateText,
            endDate: dateText,
            notes: notesText,
          })
          .superRefine(endAfterStart),
      ),
      medications: z.array(
        z
          .object({
            key: z.string(),
            id: z.string().optional(),
            name: nameText,
            genericName: z.string(),
            dose: z.string(),
            frequencyCode: z.string(),
            persisted: z.boolean(),
            doseValue: z.string(),
            doseUnit: z.string(),
            frequency: z.string().max(HEALTH_NAME_MAX, tooLong(HEALTH_NAME_MAX)),
            startDate: dateText,
            endDate: dateText,
            notes: notesText,
          })
          .superRefine((row, ctx) => {
            if (row.doseValue) {
              const value = Number(row.doseValue.replace(",", "."))
              if (!Number.isFinite(value) || value <= 0)
                ctx.addIssue({
                  code: "custom",
                  path: ["doseValue"],
                  message: "Escribe la dosis con un número mayor que cero.",
                })
              else if (!row.doseUnit)
                ctx.addIssue({ code: "custom", path: ["doseUnit"], message: "Elige la unidad." })
            }
            endAfterStart(row, ctx)
          }),
      ),
      familyHistory: z.array(
        z.object({
          key: z.string(),
          relationship: z.string(),
          condition: z.string().max(HEALTH_NAME_MAX, tooLong(HEALTH_NAME_MAX)),
          diagnosisCode: z.string(),
          diagnosisSystem: z.string().nullable(),
        }),
      ),
      reviewStatus: z.object({ conditions: reviewState, medications: reviewState }),
      pregnancyWeeks: z.string(),
      interview: z.record(z.string(), z.unknown()),
    })
    .superRefine((value, ctx) => {
      const activeCon = value.conditions.filter((r) => r.status === "activa").length
      const activeMed = value.medications.filter((r) => r.endDate === "").length
      const review = (group: "conditions" | "medications", message: string) =>
        ctx.addIssue({ code: "custom", path: ["reviewStatus", group], message })
      if (value.reviewStatus.conditions === "none" && activeCon > 0)
        review("conditions", "Hay condiciones activas: no puede marcarse ausencia.")
      else if (activeCon > 0 && value.reviewStatus.conditions !== "recorded")
        review("conditions", "Con condiciones activas la revisión debe quedar registrada.")
      if (value.reviewStatus.medications === "none" && activeMed > 0)
        review("medications", "Hay medicamentos vigentes: no puede marcarse ausencia.")
      else if (activeMed > 0 && value.reviewStatus.medications !== "recorded")
        review("medications", "Con medicamentos vigentes la revisión debe quedar registrada.")
      const weeks = value.pregnancyWeeks.trim()
      if (
        asksPregnancy &&
        groupOf(value.interview, "antecedentesPersonales")["embarazo"] === true &&
        weeks !== "" &&
        !(/^\d{1,2}$/.test(weeks) && Number(weeks) <= 42)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["pregnancyWeeks"],
          message: "Escribe las semanas con un número entero de 0 a 42.",
        })
      }
      // Lo del producto: cada error se dice bajo su dato (`InterviewSections`).
      if (Object.keys(validateInterview(value.interview)).length > 0)
        ctx.addIssue({ code: "custom", path: ["interview"], message: "Revisa los datos marcados de la entrevista." })
    })
}

/** El cuerpo de `PUT /health` y, de cada antecedente familiar enviado, su fila en pantalla. */
function healthBody(
  value: HealthFormValues,
  base: HealthBase,
  asksPregnancy: boolean,
  allergiesReview: HealthReviewState,
): { body: SaveHealthInput; familyRows: number[] } {
  const familyRows = value.familyHistory.flatMap((row, index) => (row.condition.trim() !== "" ? [index] : []))
  const answers = sanitizeInterview(interviewOf(value, asksPregnancy))
  return {
    familyRows,
    body: {
      expectedRevision: base.revision,
      // Las alergias no viajan: se agregan y quitan una por una en su tarjeta (tablero 7).
      reviewStatus: { ...value.reviewStatus, allergies: allergiesReview },
      bloodGroup: (value.bloodGroup || null) as SaveHealthInput["bloodGroup"],
      // Las mismas filas de `familyRows`, en el mismo orden: las que tienen condición escrita.
      familyHistory: value.familyHistory.filter((row) => row.condition.trim() !== "").map((row) => {
        return {
          relationship: row.relationship,
          condition: row.condition.trim(),
          diagnosisCode: row.diagnosisCode || null,
          diagnosisSystem: row.diagnosisCode ? row.diagnosisSystem : null,
        }
      }),
      asaClass: value.asaClass || null,
      conditions: value.conditions.map((c) => ({
        ...(c.id ? { id: c.id } : {}),
        name: c.name.trim(),
        diagnosisCode: c.diagnosisCode ? c.diagnosisCode : null,
        diagnosisSystem: c.diagnosisCode ? c.diagnosisSystem : null,
        status: c.status,
        startDate: c.startDate === "" ? null : c.startDate,
        endDate: c.endDate === "" ? null : c.endDate,
        notes: c.notes.trim() === "" ? null : c.notes.trim(),
      })),
      medications: value.medications.map((m) => {
        const other = m.frequencyCode === "otra"
        return {
          ...(m.id ? { id: m.id } : {}),
          name: m.name.trim(),
          genericName: m.genericName.trim() ? m.genericName.trim() : null,
          dose: m.dose.trim() === "" ? null : m.dose.trim(),
          // Con número y unidad, el servidor escribe la dosis («500 mg»); igual la frecuencia de la lista.
          doseValue: m.doseValue ? Number(m.doseValue.replace(",", ".")) : null,
          doseUnit: m.doseValue ? m.doseUnit || null : null,
          frequency: other && m.frequency.trim() !== "" ? m.frequency.trim() : null,
          frequencyCode: m.frequencyCode && !other ? m.frequencyCode : null,
          startDate: m.startDate === "" ? null : m.startDate,
          endDate: m.endDate === "" ? null : m.endDate,
          notes: m.notes.trim() === "" ? null : m.notes.trim(),
        }
      }),
      ...(canonicalJson(answers) !== base.interview
        ? { anamnesis: { expectedVersion: base.version, answers } }
        : {}),
    },
  }
}

function baseOf(health: PatientHealth): HealthBase {
  return {
    revision: health.revision,
    version: health.latestAnamnesis?.version ?? 0,
    interview: canonicalJson(sanitizeInterview((health.latestAnamnesis?.answers ?? {}) as Rec)),
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

  const [stale, setStale] = useState(false)
  const [serverInterviewErrors, setServerInterviewErrors] = useState<SubFieldErrors>({})
  const [versionId, setVersionId] = useState<string | null>(null)
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [openPersonales, setOpenPersonales] = useState(true)
  const [openFamiliares, setOpenFamiliares] = useState(true)
  const base = useRef<HealthBase>({ revision: 0, version: 0, interview: "{}" })
  // De cada antecedente familiar enviado, su fila en pantalla (las vacías no viajan).
  const sentFamilyRows = useRef<number[]>([])

  const health = healthQuery.data?.data ?? null
  // Lo del producto en la entrevista (issue 229).
  const productHealth = productUi().health
  const versions = useMemo(() => historyQuery.data?.data ?? [], [historyQuery.data])
  const saved = useMemo(() => (health ? buildDrafts(health) : null), [health])
  const today = clinicToday()

  const form = useAppForm({
    ...healthFormOptions,
    validators: {
      onSubmit: healthSchema(productHealth.asksPregnancy, (interview) =>
        productHealth.validate(interview, today),
      ),
    },
    onSubmitInvalid: () => {
      setOpenPersonales(true)
      setOpenFamiliares(true)
    },
    onSubmit: async ({ value }) => {
      if (!health) return
      const { body, familyRows } = healthBody(
        value,
        base.current,
        productHealth.asksPregnancy,
        health.reviewStatus.allergies,
      )
      sentFamilyRows.current = familyRows
      try {
        await savePatientHealthApi(patientId, body)
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.shape.code === "STALE_HEALTH_REVISION") setStale(true)
          setServerInterviewErrors(interviewErrorsOf(error.shape.fields))
        }
        setOpenPersonales(true)
        setOpenFamiliares(true)
        throw error
      }
      setStale(false)
      setDrawerOpen(false)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["patient-health", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["anamnesis-history", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["patient", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] }),
      ])
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: (key) => {
      if (key === `${INTERVIEW_PREFIX}antecedentesPersonales.semanasEmbarazo`) return "pregnancyWeeks"
      // Lo de la entrevista lo dice cada sección bajo su dato (`serverInterviewErrors`).
      if (key.startsWith(INTERVIEW_PREFIX)) return "interview"
      const family = /^familyHistory\[(\d+)\](.*)$/.exec(key)
      if (!family) return undefined
      const row = sentFamilyRows.current[Number(family[1])]
      return row === undefined ? undefined : `familyHistory[${row}]${family[2]}`
    },
    // El aviso de otra sesión va arriba del cajón, con «Recargar»: no se repite junto a los botones.
    formMessage: (error) =>
      error instanceof ApiError && error.shape.code === "STALE_HEALTH_REVISION" ? "" : null,
  })
  const interview = useStore(form.store, (state) => state.values.interview)
  const reviewStatus = useStore(form.store, (state) => state.values.reviewStatus)
  const submitted = useStore(form.store, (state) => state.submissionAttempts > 0)
  const isDirty = useStore(form.store, (state) => state.isDirty)
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
  const interviewErrors = useMemo<SubFieldErrors>(
    () => ({ ...(submitted ? productHealth.validate(interview, today) : {}), ...serverInterviewErrors }),
    [submitted, productHealth, interview, today, serverInterviewErrors],
  )

  /** El borrador vuelve a lo guardado: al abrir, al recargar y si llega otra revisión sin cambios escritos. */
  function resetTo(next: PatientHealth): void {
    base.current = baseOf(next)
    form.reset(buildDrafts(next))
    setServerInterviewErrors({})
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: solo cuando llega otra revisión; abrir ya reinicia el borrador.
  useEffect(() => {
    if (health && drawerOpen && !form.state.isDirty && !form.state.isSubmitting) resetTo(health)
  }, [health])

  function openDrawer(): void {
    if (!health) return
    resetTo(health)
    setStale(false)
    setDrawerOpen(true)
  }

  async function reload(): Promise<void> {
    const fresh = await healthQuery.refetch()
    if (fresh.data) resetTo(fresh.data.data)
    setStale(false)
  }

  function updateInterview(group: string, key: string, next: unknown): void {
    form.setFieldValue("interview", (prev) => {
      const g = groupOf(prev, group)
      if (next === undefined) delete g[key]
      else g[key] = next
      const out = { ...prev }
      if (Object.keys(g).length > 0) out[group] = g
      else delete out[group]
      return out
    })
    if (Object.keys(serverInterviewErrors).length > 0) setServerInterviewErrors({})
  }

  function setTopInterview(key: string, next: unknown): void {
    form.setFieldValue("interview", (prev) => {
      const out = { ...prev }
      if (next === undefined) delete out[key]
      else out[key] = next
      return out
    })
    if (Object.keys(serverInterviewErrors).length > 0) setServerInterviewErrors({})
  }

  if (healthQuery.isPending) return <LoadingState />
  if (healthQuery.isError || !health || !saved) {
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
  const submitLabel = pendingReview && !isDirty ? "Revisar y guardar" : "Guardar antecedentes"
  const readOnly = !canWrite || isSubmitting
  // Nunca se preguntó: el vacío lo dice y lleva a registrarlo (ADR 0035).
  const unasked = !hasHealthInfo(health)
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
            <Button type="button" onClick={openDrawer}>
              {pendingReview
                ? "Revisar antecedentes"
                : saved.conditions.length + saved.medications.length > 0
                  ? "Editar antecedentes"
                  : "Registrar antecedentes"}
            </Button>
          ) : null}
        </div>
      </div>

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
          onAction={canWrite ? openDrawer : undefined}
        />
      ) : (
        <AntecedentesSummary saved={saved} pendingReview={pendingReview} />
      )}
      <productHealth.Summary answers={(health.latestAnamnesis?.answers ?? {}) as Rec} />

      <FormDrawer
        {...surface}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Registrar antecedentes"
        description="Completa por secciones. En móvil avanza en una columna; en tablet y web el formulario usa dos columnas."
        headerContent={
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Revisión {base.current.revision} ·{" "}
              {base.current.version > 0
                ? `entrevista v${base.current.version}`
                : "sin entrevista registrada"}
            </p>
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
                  <Button type="button" size="sm" variant="outline" onClick={() => void reload()}>
                    Recargar
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        }
        isLoading={healthQuery.isPending}
        submitLabel={submitLabel}
        submitDisabled={!canWrite}
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
                {saved.bloodGroup !== "" && pendingReview ? (
                  <Badge variant="outline">Declarado · pendiente de revisión</Badge>
                ) : null}
              </div>
            </div>
            <div>
              <BloodGroupField
                form={form}
                id={fid("blood")}
                readOnly={readOnly}
                declared={saved.bloodGroup !== "" && pendingReview}
              />
            </div>
            <form.AppField name="asaClass">
              {(field) => (
                <field.Control id={fid("asa")} label="Clasificación ASA">
                  {(control) => (
                    <ChoiceSelect
                      id={control.id}
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      className="max-w-md"
                      value={field.state.value}
                      disabled={readOnly}
                      onChange={(e) => field.handleChange(e.target.value)}
                    >
                      <option value="">Sin clasificar</option>
                      {ASA_OPTIONS.map(([value, optionLabel]) => (
                        <option key={value} value={value}>
                          {optionLabel}
                        </option>
                      ))}
                    </ChoiceSelect>
                  )}
                </field.Control>
              )}
            </form.AppField>
          </section>

          {/* Las alergias se agregan y quitan una por una en su tarjeta, fuera de este formulario (tablero 7). */}
          <ClinicalGroupCard
            title="Condiciones"
            review={reviewStatus.conditions}
            reviewField={<ReviewStateField form={form} id={fid("rev-con")} group="conditions" readOnly={readOnly} />}
          >
            <ConditionRows form={form} idPrefix={uid} readOnly={readOnly} />
            <form.Subscribe selector={(state) => state.values.conditions.length === 0}>
              {(empty) =>
                empty ? (
                  <p className="text-sm text-muted-foreground">
                    {reviewStatus.conditions === "none"
                      ? "Ausencia confirmada en este grupo."
                      : "Sin registros. Agrega filas o confirma la ausencia."}
                  </p>
                ) : null
              }
            </form.Subscribe>
          </ClinicalGroupCard>

          <ClinicalGroupCard
            title="Medicación vigente"
            review={reviewStatus.medications}
            reviewField={<ReviewStateField form={form} id={fid("rev-med")} group="medications" readOnly={readOnly} />}
          >
            <MedicationRows form={form} idPrefix={uid} readOnly={readOnly} />
            <form.Subscribe selector={(state) => state.values.medications.length === 0}>
              {(empty) =>
                empty ? (
                  <p className="text-sm text-muted-foreground">
                    {reviewStatus.medications === "none"
                      ? "Ausencia confirmada en este grupo."
                      : "Sin registros. Agrega filas o confirma la ausencia."}
                  </p>
                ) : null
              }
            </form.Subscribe>
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
                    {(
                      [
                        ["hospitalizaciones", "ap-hosp", "Hospitalizaciones"],
                        ["cirugias", "ap-cir", "Cirugías"],
                        ["transfusiones", "ap-tra", "Transfusiones"],
                      ] as const
                    ).map(([key, id, label]) => (
                      <Field key={key}>
                        <FieldLabel htmlFor={fid(id)}>{label}</FieldLabel>
                        <Input
                          id={fid(id)}
                          value={strOf(personales[key])}
                          disabled={readOnly}
                          onChange={(e) =>
                            updateInterview(
                              "antecedentesPersonales",
                              key,
                              e.target.value === "" ? undefined : e.target.value,
                            )
                          }
                        />
                      </Field>
                    ))}
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
                          disabled={readOnly}
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
                      <form.AppField name="pregnancyWeeks">
                        {(field) => (
                          <field.TextField
                            id={fid("emb-sem")}
                            label="Semanas de embarazo (0–42)"
                            inputMode="numeric"
                            maxLength={2}
                            disabled={readOnly}
                          />
                        )}
                      </form.AppField>
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
                  <form.AppField name="familyHistory" mode="array">
                    {(rowsField) => (
                      <div className="flex flex-col gap-3 pt-2">
                        {rowsField.state.value.map((row, index) => (
                          <div
                            key={row.key}
                            className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[10rem_1fr_auto]"
                          >
                            <form.AppField name={`familyHistory[${index}].relationship`}>
                              {(field) => (
                                <field.Control id={fid(`fam-rel-${row.key}`)} label="Parentesco">
                                  {(control) => (
                                    <ChoiceSelect
                                      id={control.id}
                                      aria-invalid={control.invalid || undefined}
                                      aria-describedby={control.describedBy}
                                      onBlur={control.onBlur}
                                      value={field.state.value}
                                      disabled={readOnly}
                                      onChange={(e) => field.handleChange(e.target.value)}
                                    >
                                      {FAMILY_RELATIONSHIP_OPTIONS.map(([value, optionLabel]) => (
                                        <option key={value} value={value}>
                                          {optionLabel}
                                        </option>
                                      ))}
                                    </ChoiceSelect>
                                  )}
                                </field.Control>
                              )}
                            </form.AppField>
                            <form.AppField name={`familyHistory[${index}].condition`}>
                              {(field) => (
                                <field.TextField
                                  id={fid(`fam-con-${row.key}`)}
                                  label="Condición"
                                  maxLength={HEALTH_NAME_MAX}
                                  disabled={readOnly}
                                  placeholder="Ej.: diabetes, hipertensión, cardiopatía"
                                />
                              )}
                            </form.AppField>
                            {canWrite ? (
                              <div className="flex items-end">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={readOnly}
                                  onClick={() => rowsField.removeValue(index)}
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
                              disabled={readOnly}
                              onClick={() =>
                                rowsField.pushValue({
                                  key: `fam-${Date.now()}`,
                                  relationship: "MTH",
                                  condition: "",
                                  diagnosisCode: "",
                                  diagnosisSystem: null,
                                })
                              }
                            >
                              Agregar antecedente familiar
                            </Button>
                          </div>
                        ) : null}
                        {strOf(interview["antecedentesFamiliares"]) ? (
                          <p className="text-xs text-muted-foreground">
                            Registro anterior en texto: {strOf(interview["antecedentesFamiliares"])}
                          </p>
                        ) : null}
                      </div>
                    )}
                  </form.AppField>
                </CollapsibleContent>
              </Collapsible>

              {/* Lo del producto (odentIA: «Odontológicos y hábitos»; latidIA: embarazo, hábitos y vacunas). */}
              <form.Field name="interview">
                {() => (
                  <productHealth.InterviewSections
                    answers={interview}
                    update={updateInterview}
                    setGroup={setTopInterview}
                    disabled={readOnly}
                    idPrefix={uid}
                    sex={patientQuery.data?.data.patient.sex ?? null}
                    errors={interviewErrors}
                  />
                )}
              </form.Field>

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
 * Resumen de lectura de lo guardado: conteos por grupo + estado de revisión.
 * Sin formularios. Las alergias tienen su propia tarjeta arriba (`AllergiesCard`).
 */
function AntecedentesSummary({
  saved,
  pendingReview,
}: {
  saved: HealthFormValues
  pendingReview: boolean
}): React.JSX.Element {
  const { conditions, medications, reviewStatus: review, bloodGroup } = saved
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
          {bloodGroup in BLOOD_GROUP_LABELS
            ? BLOOD_GROUP_LABELS[bloodGroup as keyof typeof BLOOD_GROUP_LABELS]
            : "Sin registrar"}
        </span>
        {pendingReview && bloodGroup !== "" ? (
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

function ClinicalGroupCard({
  title,
  review,
  reviewField,
  children,
}: {
  title: string
  review: HealthReviewState
  reviewField: ReactNode
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
        {reviewField}
        {children}
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
