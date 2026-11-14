import { CONDITION_STATUSES, FAMILY_KINSHIP_LABELS, pregnancyRecordOf, type PregnancyToday } from "@odentia/clinical"
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
  useAppForm,
  useFormSurface,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, HeartPulse } from "lucide-react"
import type { ReactNode } from "react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../../lib/api"
import { useMemberName, usePermission } from "../../lib/crm"
import {
  declaredGroupOf,
  declaredMarkWords,
  pregnancyGroupOf,
  pregnancyWords,
  saidByWords,
  saidNoGroupOf,
  saidNoWords,
  shortDay,
} from "../../lib/declared-health"
import { clinicToday } from "../../lib/inventory"
import {
  ASA_OPTIONS,
  asaLabel,
  type AnamnesisAnswers,
  fetchAnamnesisHistory,
  fetchPatientHealth,
  HEALTH_REVIEW_LABELS,
  type HealthReviewState,
  hasHealthInfo,
  isHealthReviewPending,
  type HealthDeclarationView,
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
import { AntecedentesSkeleton } from "../skeletons/person-sections"

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

/** Embarazo con su nombre; sin `items`, Base UI mostraría la clave («sin-responder»). */
const PREGNANCY_ITEMS: Record<string, string> = { "sin-responder": "Sin responder", si: "Sí", no: "No" }

/**
 * Lo guardado, como lo edita el formulario. El «No» que marcó la persona (o
 * quien habla por ella) y nadie revisó no llega elegido como «Niega»: queda
 * sin marcar hasta que el profesional se lo pregunte (QA del 14 nov, H4a).
 */
export function buildDrafts(health: PatientHealth): HealthFormValues {
  const asked = (topic: "conditions" | "medications"): HealthReviewState =>
    saidNoGroupOf(health.declared, topic) && health.reviewStatus[topic] === "none" ? "unknown" : health.reviewStatus[topic]
  const interview = (health.latestAnamnesis?.answers ?? {}) as Rec
  const weeks = pregnancyRecordOf(interview)?.semanas
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
      conditions: asked("conditions"),
      medications: asked("medications"),
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

/**
 * El embarazo de la entrevista con su fecha (`embarazoLactancia.embarazo`): sí o no, dicho hoy.
 * Lo de antes (`antecedentesPersonales.embarazo`, sin fecha) sale: queda una sola forma.
 * `estado` nulo lo quita («Sin responder»).
 */
function withPregnancy(interview: Rec, estado: "si" | "no" | null, today: string): Rec {
  const out = { ...interview }
  const personales = groupOf(interview, "antecedentesPersonales")
  delete personales["embarazo"]
  delete personales["semanasEmbarazo"]
  if (Object.keys(personales).length > 0) out["antecedentesPersonales"] = personales
  else delete out["antecedentesPersonales"]
  const group = groupOf(interview, "embarazoLactancia")
  if (estado) group["embarazo"] = { estado, fecha: today }
  else delete group["embarazo"]
  if (Object.keys(group).length > 0) out["embarazoLactancia"] = group
  else delete out["embarazoLactancia"]
  return out
}

/**
 * La entrevista con las semanas de embarazo (odentIA las pregunta en «Personales»). La fecha del
 * embarazo es la del día en que se dijo: solo cambia al cambiar la respuesta o las semanas
 * (`withPregnancy`), nunca por guardar otro dato. Lo guardado antes sin fecha queda como está
 * hasta que alguien lo responde de nuevo.
 */
function interviewOf(value: HealthFormValues, asksPregnancy: boolean): Rec {
  if (!asksPregnancy) return value.interview
  const group = groupOf(value.interview, "embarazoLactancia")
  const stated = group["embarazo"]
  if (!stated || typeof stated !== "object") return value.interview
  const { semanas: _semanas, ...statement } = stated as Rec
  const weeks = value.pregnancyWeeks.trim()
  group["embarazo"] = statement["estado"] === "si" && weeks !== "" ? { ...statement, semanas: Number(weeks) } : statement
  return { ...value.interview, embarazoLactancia: group }
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
      // Con algo activo escrito, la revisión queda «Registrada» sola al guardar (`healthBody`):
      // no se pide marcarla a mano. Solo se avisa si se marcó «No tiene» y hay algo escrito.
      const review = (group: "conditions" | "medications", message: string) =>
        ctx.addIssue({ code: "custom", path: ["reviewStatus", group], message })
      if (value.reviewStatus.conditions === "none" && activeCon > 0)
        review("conditions", "Marcaste que no tiene, pero hay condiciones activas: quítalas o cambia la respuesta.")
      if (value.reviewStatus.medications === "none" && activeMed > 0)
        review("medications", "Marcaste que no toma, pero hay medicamentos vigentes: quítalos o cambia la respuesta.")
      const weeks = value.pregnancyWeeks.trim()
      if (
        asksPregnancy &&
        pregnancyRecordOf(value.interview)?.estado === "si" &&
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
      reviewStatus: {
        // Lo escrito y activo ya es lo registrado: no hace falta marcarlo.
        conditions: value.conditions.some((r) => r.status === "activa") ? "recorded" : value.reviewStatus.conditions,
        medications: value.medications.some((r) => r.endDate === "") ? "recorded" : value.reviewStatus.medications,
        allergies: allergiesReview,
      },
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

export function AntecedentesTab({
  patientId,
  startEditing = false,
}: {
  patientId: string
  /** «Revisar» de Pendientes: se abre con el formulario listo, sin otro clic. */
  startEditing?: boolean
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const canWrite = usePermission("clinical.write")
  const canRead = usePermission("clinical.read")
  const memberName = useMemberName()
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
        // Lo que falta saber de su salud lo dice también el cierre de una atención abierta.
        queryClient.invalidateQueries({ queryKey: ["encounter-closing", patientId] }),
      ])
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: (key) => {
      if (key === `${INTERVIEW_PREFIX}embarazoLactancia.embarazo.semanas`) return "pregnancyWeeks"
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

  // «Revisar» de Pendientes: una sola vez, en cuanto hay qué mostrar.
  const startedEditing = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `openDrawer` cambia en cada render; corre una vez al llegar.
  useEffect(() => {
    if (!startEditing || !canWrite || !health || startedEditing.current) return
    startedEditing.current = true
    openDrawer()
  }, [startEditing, canWrite, health])

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

  if (healthQuery.isPending)
    return (
      <SkeletonRegion message="Cargando antecedentes…">
        <AntecedentesSkeleton canWrite={canWrite} />
      </SkeletonRegion>
    )
  if (healthQuery.isError || !health || !saved) {
    return (
      <ErrorState
        error={healthQuery.error instanceof ApiError ? healthQuery.error.shape : null}
        onRetry={() => void healthQuery.refetch()}
      />
    )
  }

  const personales = groupOf(interview, "antecedentesPersonales")
  const pregnancyRecord = pregnancyRecordOf(interview)
  const legacy = legacyTexts(health.latestAnamnesis?.answers as AnamnesisAnswers | undefined)
  const fid = (name: string): string => `${uid}-${name}`
  const registration = patientQuery.data?.data.registration ?? null
  const sex = patientQuery.data?.data.patient.sex
  // Lo que declaró después del registro con que se creó su ficha (ese ya se muestra entero): lo de su
  // enlace y un registro en línea posterior. Las alergias de un cuestionario están en el cuestionario.
  const laterDeclarations = (health.declarations ?? []).filter(
    (declaration) =>
      declaration.via === "enlace" || (declaration.via === "registro" && declaration.enteredAt !== registration?.createdAt),
  )
  const pendingReview = isHealthReviewPending(health)
  // «Dijo que no · 13 nov», junto al grupo donde se decide: es de quien declaró, no del equipo.
  const saidNoOf = (topic: "conditions" | "medications"): string | undefined => {
    const group = saidNoGroupOf(health.declared, topic)
    if (!group) return undefined
    const day = group.at ? shortDay(group.at) : ""
    return `${saidNoWords(group.by, sex)}${day ? ` · ${day}` : ""} · sin revisar`
  }
  const submitLabel = pendingReview && !isDirty ? "Revisar y guardar" : "Guardar antecedentes"
  const readOnly = !canWrite || isSubmitting
  // Nunca se preguntó: el vacío lo dice y lleva a registrarlo (ADR 0035).
  const unasked = !hasHealthInfo(health)
  // El botón y el cajón se llaman igual: se revisa lo declarado, se edita lo que hay o se registra por primera vez.
  const editingVerb = pendingReview
    ? "Revisar antecedentes"
    : saved.conditions.length + saved.medications.length > 0
      ? "Editar antecedentes"
      : "Registrar antecedentes"
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
            <Badge variant="secondary">{healthReviewedWords(health.reviewedAt, health.reviewedBy, memberName)}</Badge>
          ) : pendingReview ? (
            // Una marca por declaración sin revisar: quién lo dijo y cuándo, como arriba de la ficha.
            (health.declared?.length ? health.declared : [null]).map((group) => (
              <Badge
                key={group ? `${group.by.kind}-${group.by.name ?? ""}-${group.at ?? ""}` : "sin-revisar"}
                variant="outline"
                className="h-auto max-w-full border-dashed py-px text-left whitespace-normal"
              >
                {group ? declaredMarkWords(group.by, group.at, sex) : "Declarado, sin revisar"}
              </Badge>
            ))
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
          {hasOriginalDeclaration(registration, laterDeclarations) ? (
            <Button type="button" variant="link" size="sm" onClick={() => setSnapshotOpen(true)}>
              Ver declaración original
            </Button>
          ) : null}
          {canWrite && !unasked ? (
            <Button type="button" onClick={openDrawer}>
              {editingVerb}
            </Button>
          ) : null}
        </div>
      </div>

      <AllergiesCard
        patientId={patientId}
        patientName={patientQuery.data?.data.patient.displayName ?? "el paciente"}
        health={health}
        sex={sex}
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
        <AntecedentesSummary
          saved={saved}
          pendingReview={pendingReview}
          groups={health.declared}
          // latidIA dice el embarazo en su propia sección, debajo: aquí no se repite.
          pregnancy={productHealth.asksPregnancy ? (health.pregnancy ?? null) : null}
          sex={sex}
        />
      )}
      <productHealth.Summary answers={(health.latestAnamnesis?.answers ?? {}) as Rec} />

      <FormDrawer
        {...surface}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={editingVerb}
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
          </section>

          {/* Las alergias se agregan y quitan una por una en su tarjeta, fuera de este formulario (tablero 7). */}
          <ClinicalGroupCard
            title="Condiciones"
            review={reviewStatus.conditions}
            saidNo={saidNoOf("conditions")}
            reviewField={<ReviewStateField form={form} id={fid("rev-con")} group="conditions" readOnly={readOnly} />}
          >
            <ConditionRows form={form} idPrefix={uid} readOnly={readOnly} />
            <form.Subscribe selector={(state) => state.values.conditions.length === 0}>
              {(empty) =>
                empty ? (
                  <p className="text-sm text-muted-foreground">
                    {reviewStatus.conditions === "none"
                      ? "Ausencia confirmada en este grupo."
                      : saidNoOf("conditions")
                        ? "Pregúntale y, si lo confirma, elige «Niega antecedentes de este tipo»."
                        : "Sin registros. Agrega filas o confirma la ausencia."}
                  </p>
                ) : null
              }
            </form.Subscribe>
          </ClinicalGroupCard>

          <ClinicalGroupCard
            title="Medicación vigente"
            review={reviewStatus.medications}
            saidNo={saidNoOf("medications")}
            reviewField={<ReviewStateField form={form} id={fid("rev-med")} group="medications" readOnly={readOnly} />}
          >
            <MedicationRows form={form} idPrefix={uid} readOnly={readOnly} />
            <form.Subscribe selector={(state) => state.values.medications.length === 0}>
              {(empty) =>
                empty ? (
                  <p className="text-sm text-muted-foreground">
                    {reviewStatus.medications === "none"
                      ? "Ausencia confirmada en este grupo."
                      : saidNoOf("medications")
                        ? "Pregúntale y, si lo confirma, elige «Niega antecedentes de este tipo»."
                        : "Sin registros. Agrega filas o confirma la ausencia."}
                  </p>
                ) : null
              }
            </form.Subscribe>
          </ClinicalGroupCard>

          <section
            aria-label="Riesgo anestésico (ASA)"
            className="flex flex-col gap-4 elevated rounded-xl border bg-card p-4 sm:p-6"
          >
            <div className="font-heading text-base font-medium">Riesgo anestésico (ASA)</div>
            <form.AppField name="asaClass">
              {(field) => (
                <field.Control id={fid("asa")} label="Clasificación ASA" description="Su riesgo ante la anestesia, según sus enfermedades y su medicación.">
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

          <section
            aria-label="Entrevista de salud"
            className="flex flex-col gap-4 elevated rounded-xl border bg-card p-4 sm:p-6"
          >
            <div className="flex flex-col gap-1.5">
              <h3 className="font-heading text-base font-medium">Entrevista de salud</h3>
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
                          // Con sus nombres: sin ellos, el campo muestra la clave («sin-responder», QA del 6 nov).
                          items={PREGNANCY_ITEMS}
                          value={pregnancyRecord?.estado ?? "sin-responder"}
                          onValueChange={(v) => {
                            // Responderlo es decirlo hoy: queda con la fecha de hoy, que ya no se mueve.
                            form.setFieldValue("interview", (prev) =>
                              withPregnancy(prev, v === "si" || v === "no" ? v : null, clinicToday()),
                            )
                            if (v !== "si") form.setFieldValue("pregnancyWeeks", "")
                            if (Object.keys(serverInterviewErrors).length > 0) setServerInterviewErrors({})
                          }}
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
                        {pregnancyRecord ? (
                          <p className="text-xs text-muted-foreground">
                            {(pregnancyRecord.fecha ?? health.pregnancy?.saidOn)
                              ? `Anotado el ${shortDay(pregnancyRecord.fecha ?? health.pregnancy?.saidOn ?? "")}. Si cambias la respuesta o las semanas, queda con la fecha de hoy.`
                              : "Está anotado sin fecha: al responderlo de nuevo queda con la de hoy."}
                          </p>
                        ) : null}
                      </Field>
                    ) : null}
                    {productHealth.asksPregnancy && pregnancyRecord?.estado === "si" ? (
                      <form.AppField
                        name="pregnancyWeeks"
                        listeners={{
                          // Las semanas son las de hoy: decirlas pone la fecha de hoy. Solo si sigue en «Sí»:
                          // al pasar a «No» el campo se vacía y eso no es decir las semanas.
                          onChange: () =>
                            form.setFieldValue("interview", (prev) =>
                              pregnancyRecordOf(prev)?.estado === "si" ? withPregnancy(prev, "si", clinicToday()) : prev,
                            ),
                        }}
                      >
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
        later={laterDeclarations}
        sex={sex}
      />
    </div>
  )
}

/**
 * Resumen de lectura de lo guardado: qué tiene, por nombre, y el estado de
 * revisión. Sin formularios. Las alergias tienen su propia tarjeta arriba
 * (`AllergiesCard`).
 */
function AntecedentesSummary({
  saved,
  pendingReview,
  groups,
  pregnancy,
  sex,
}: {
  saved: HealthFormValues
  pendingReview: boolean
  /** Lo que se dijo y nadie revisó, por declaración (lo decide el servidor). */
  groups?: PatientHealth["declared"]
  pregnancy: PregnancyToday | null
  /** El sexo registrado del paciente, para decir «ella» o «él» de quien declaró. */
  sex?: string | null
}): React.JSX.Element {
  const { conditions, medications, reviewStatus: review, bloodGroup, asaClass } = saved
  const activeCon = conditions.filter((r) => r.status === "activa")
  // La que toma: sin fin o con fin desde hoy, como en la receta y en la atención.
  const today = clinicToday()
  const activeMed = medications.filter((r) => r.endDate === "" || r.endDate >= today)
  // La ASA va con sus enfermedades, de donde sale (QA del 8 nov: estaba bajo el grupo sanguíneo),
  // primero y con el nombre de su tarjeta en el formulario: quien va a anestesiar la busca así
  // (QA del 8 nov, noche: al final de «Condiciones» se leía como una cola de «Sin registros»).
  const asa = asaLabel(asaClass)
  // Lo que dijo y nadie revisó se dice igual que en la franja: «lo dijo ella · sin revisar», y su
  // «No» como «dijo que no», nunca como el «niega» que anota quien se lo pregunta.
  const capital = (text: string) => text.replace(/^./, (letter) => letter.toLocaleUpperCase("es"))
  const saidWord = (topic: "conditions" | "medications", ids: string[]): string | undefined => {
    const no = saidNoGroupOf(groups, topic)
    if (no) return `${saidNoWords(no.by, sex)} · sin revisar`
    // Quien dijo cada fila lo trae su declaración; con dos personas, se nombran las dos.
    const who = [
      ...new Set(ids.flatMap((id) => {
        const group = declaredGroupOf(groups, topic, id)
        return group ? [saidByWords(group.by, sex)] : []
      })),
    ]
    return who.length > 0 ? `${capital(who.join(" y "))} · sin revisar` : undefined
  }
  const pregnancyGroup = pregnancyGroupOf(groups)
  const pregnancyText = pregnancy ? pregnancyWords(pregnancy) : null
  const rows: Array<{ title: string; state: HealthReviewState; detail: string; lead?: string; said?: string }> = [
    {
      title: "Condiciones",
      state: review.conditions,
      said: saidWord("conditions", activeCon.flatMap((row) => (row.id ? [row.id] : []))),
      lead:
        asa || productUi().health.showsAsa ? `Riesgo anestésico (ASA): ${asa ?? "sin clasificar"}` : undefined,
      detail:
        activeCon.length > 0
          ? activeCon.map((row) => row.name).join(", ")
          : conditions.length > 0
            ? "Ninguna activa"
            : "Sin registros",
    },
    {
      title: "Medicación vigente",
      state: review.medications,
      said: saidWord("medications", activeMed.flatMap((row) => (row.id ? [row.id] : []))),
      detail:
        activeMed.length > 0
          ? activeMed
              .map((row) => [row.name, row.doseValue ? `${row.doseValue} ${row.doseUnit}`.trim() : row.dose].filter(Boolean).join(" "))
              .join(", ")
          : medications.length > 0
            ? "Ninguna vigente"
            : "Sin registros",
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
      {pregnancyText ? (
        <div className="flex flex-col gap-1 elevated rounded-xl border bg-card p-4">
          <span className="font-heading text-sm font-medium">{pregnancyText.title}</span>
          <span className="text-sm text-muted-foreground">
            {pregnancyText.confirm
              ? `${pregnancyText.detail.replace(/^./, (letter) => letter.toLocaleUpperCase("es"))}. Pregúntale si sigue embarazada.`
              : pregnancy?.weeksToday === null
                ? pregnancyText.detail.replace(/^./, (letter) => letter.toLocaleUpperCase("es"))
                : `Dijo ${pregnancyText.detail}`}
          </span>
          {pregnancyGroup ? (
            <Badge variant="outline" className="mt-1 h-auto w-fit max-w-full border-dashed py-px text-left whitespace-normal">
              {capital(saidByWords(pregnancyGroup.by, sex))} · sin revisar
            </Badge>
          ) : null}
        </div>
      ) : null}
      {rows.map((row) => (
        <div key={row.title} className="flex flex-col gap-1 elevated rounded-xl border bg-card p-4">
          <span className="font-heading text-sm font-medium">{row.title}</span>
          {row.lead ? <span className="text-sm">{row.lead}</span> : null}
          <span className="text-sm text-muted-foreground">{row.detail}</span>
          {row.said ? (
            <Badge variant="outline" className="mt-1 h-auto w-fit max-w-full border-dashed py-px text-left whitespace-normal">
              {row.said}
            </Badge>
          ) : (
            <Badge
              variant={
                row.state === "recorded" ? "default" : row.state === "none" ? "secondary" : "outline"
              }
              className="mt-1 w-fit"
            >
              {HEALTH_REVIEW_LABELS[row.state]}
            </Badge>
          )}
        </div>
      ))}
    </div>
  )
}

export function ClinicalGroupCard({
  title,
  review,
  saidNo,
  reviewField,
  children,
}: {
  title: string
  review: HealthReviewState
  /** El «No» de quien declaró, con su día: se muestra al lado, sin elegir «Niega» por el profesional. */
  saidNo?: string
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
          <div className="flex flex-wrap items-center gap-2">
            {saidNo ? (
              <Badge variant="outline" className="h-auto max-w-full border-dashed py-px text-left whitespace-normal">
                {saidNo}
              </Badge>
            ) : null}
            <Badge
              variant={
                review === "recorded" ? "default" : review === "none" ? "secondary" : "outline"
              }
            >
              {HEALTH_REVIEW_LABELS[review]}
            </Badge>
          </div>
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

/** El embarazo de una declaración, como lo dijo: «Sí · 30 semanas». */
function declaredPregnancyText(health: Rec): string | null {
  const personal = (health["personal"] ?? null) as Rec | null
  if (!personal || typeof personal["embarazo"] !== "boolean") return null
  if (!personal["embarazo"]) return "No"
  return typeof personal["semanasEmbarazo"] === "number" ? `Sí · ${personal["semanasEmbarazo"]} semanas` : "Sí"
}

/**
 * Lo que dijo de su salud en una declaración, tal como llegó: alergias,
 * enfermedades, medicación y el embarazo (QA del 14 nov, H2 de desarrollo: el
 * del registro no salía), igual para el registro y para lo que envió después.
 */
export function DeclaredHealthSnapshot({ health }: { health: Rec }): React.JSX.Element {
  const pregnancy = declaredPregnancyText(health)
  return (
    <>
      <SnapshotGroup title="Alergias" group={health["allergies"]} nameKey="substance" />
      <SnapshotGroup title="Enfermedades" group={health["conditions"]} nameKey="name" />
      <SnapshotGroup title="Medicación" group={health["medications"]} nameKey="name" />
      {pregnancy ? (
        <p>
          <span className="font-medium">Embarazo · </span>
          {pregnancy}
        </p>
      ) : null}
    </>
  )
}

/**
 * Si hay algo que mostrar como «declaración original»: lo que envió después o
 * un registro que no hizo el equipo sin su salud (H6: con Sofía, registrada por
 * el equipo sin salud, el diálogo salía vacío).
 */
/**
 * Quién revisó los antecedentes y cuándo: «Antecedentes revisados por Dra. Ana
 * Torres · 14 nov». Antes decía «Revisado por personal autorizado», sin nadie,
 * al lado de una alergia que nadie había revisado (auditor, 14 nov). Las
 * alergias tienen su propia revisión, que dice su tarjeta.
 */
export function healthReviewedWords(
  reviewedAt: string,
  reviewedBy: string | null,
  memberName: (userId: string) => string,
): string {
  const day = shortDay(reviewedAt)
  return `Antecedentes revisados${reviewedBy ? ` por ${memberName(reviewedBy)}` : ""}${day ? ` · ${day}` : ""}`
}

export function hasOriginalDeclaration(
  registration: Pick<NonNullable<PatientFull["registration"]>, "respondent" | "answers"> | null,
  later: readonly unknown[],
): boolean {
  if (later.length > 0) return true
  if (!registration) return false
  if (registration.respondent !== "staff") return true
  const health = ((registration.answers ?? {}) as Rec)["health"]
  return !!health && typeof health === "object" && Object.keys(health as Rec).length > 0
}

/**
 * La declaración original, solo para leer: lo que la persona (o quien habla
 * por ella) envió después, desde su enlace o en otro registro en línea, tal
 * como llegó y con quién lo dijo, y el registro con que se creó la ficha. Nunca se edita desde aquí: lo vigente se corrige en sus
 * antecedentes, y esto sigue diciendo lo que se declaró.
 */
function RegistrationSnapshotDialog({
  open,
  onClose,
  registration,
  later,
  sex,
}: {
  open: boolean
  onClose: () => void
  registration: PatientFull["registration"]
  /** Lo que declaró después de crearse su ficha (su enlace, un registro en línea posterior), de lo más nuevo a lo más antiguo. */
  later: HealthDeclarationView[]
  sex?: string | null
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
          <DialogTitle>Declaración original</DialogTitle>
          <DialogDescription>
            Lo que se declaró, tal como llegó. No se edita: lo vigente se corrige en sus antecedentes.
          </DialogDescription>
        </DialogHeader>
        {later.map((declaration) => {
          const sent = declaration.health as Rec
          const blood = sent["bloodGroup"]
          const title = declaration.via === "enlace" ? "Lo que envió desde su enlace" : "Lo que envió en su registro en línea"
          return (
            <section key={declaration.enteredAt} aria-label={title} className="flex flex-col gap-3 text-sm">
              <div className="flex flex-col gap-0.5">
                <h3 className="font-medium">{title}</h3>
                <p className="text-muted-foreground">
                  {saidByWords(declaration.by, sex).replace(/^./, (letter) => letter.toLocaleUpperCase("es"))} el{" "}
                  {new Date(declaration.at).toLocaleString(activeOrgLocale(), { dateStyle: "long", timeStyle: "short" })}.
                </p>
              </div>
              <DeclaredHealthSnapshot health={sent} />
              {typeof blood === "string" && blood in BLOOD_GROUP_LABELS ? (
                <p>
                  <span className="font-medium">Grupo sanguíneo · </span>
                  {BLOOD_GROUP_LABELS[blood as keyof typeof BLOOD_GROUP_LABELS]}
                </p>
              ) : null}
            </section>
          )
        })}
        {registration ? (
          <div className="flex flex-col gap-4 text-sm">
            {later.length > 0 ? <h3 className="border-t pt-4 font-medium">El registro con que se creó su ficha</h3> : null}
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
            <DeclaredHealthSnapshot health={health} />
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
        ) : later.length > 0 ? null : (
          <p className="text-sm text-muted-foreground">Sin declaración guardada.</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
