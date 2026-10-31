/**
 * El periodontograma dentro de la atención (lienzo, tableros 2, 9 y 10): un
 * bloque más, junto a Examen, Odontograma y Diagnóstico. «Empezar» o «Seguir»
 * abren la captura a pantalla completa; debajo, el resumen y la clasificación
 * guiada: odentIA propone con sus razones y solo se guarda lo que confirma el
 * odontólogo. El mismo «Confirmar diagnóstico» deja el código en la atención.
 */
import {
  PERI_IMPLANT_CONDITIONS,
  PERI_IMPLANT_WORDS,
  PERIODONTAL_DIAGNOSES,
  PERIODONTAL_DIAGNOSIS_WORDS,
  PERIODONTAL_EXTENT_WORDS,
  PERIODONTAL_EXTENTS,
  PERIODONTAL_SITE_WORDS,
  PERIODONTAL_SITES,
  type PeriImplantCondition,
  type PeriodontalClassification,
  periodontalClassificationIssues,
  type PeriodontalClassificationInputs,
  type PeriodontalDiagnosis,
  type PeriodontalExtent,
  type PeriodontalMissingInput,
  type PeriodontalProposal,
  periodontalClassificationShort,
  PERIODONTITIS_GRADES,
  PERIODONTITIS_STAGES,
  PERIODONTITIS_STATUS_WORDS,
  PERIODONTITIS_STATUSES,
  type PeriodontitisGrade,
  type PeriodontitisStage,
  type PeriodontitisStatus,
  proposePeriodontalClassification,
} from "@odentia/dental"
import { Badge, Button, FieldLegend, FieldSet, toast } from "@odentia/ui"
import {
  LoadingState,
  SubmitButton,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useMemo, useRef, useState } from "react"
import {
  classifyPeriodontalChart,
  fetchPeriodontalChart,
  fetchPeriodontalCharts,
  type PeriodontalChart as ChartData,
  type PeriodontalChartListItem,
  periodontalKeys,
  startPeriodontalChart,
} from "../../../lib/dental/periodontal"
import { QueryErrorState } from "@odentia/clinic-app/lib/query-error"
import { ChoiceSelect } from "@odentia/clinic-app/components/ui/choice-select"
import { lazyPart } from "../../../product/dental/lazy-part"
import { PeriodontalTiles } from "./periodontal-views"

const PeriodontalCapture = lazyPart(() => import("./periodontal-capture").then((m) => m.PeriodontalCapture))
const PeriodontalChart = lazyPart(() => import("./periodontal-chart").then((m) => m.PeriodontalChart))

const STAGE_WORDS = ["", "I", "II", "III", "IV"]
const MISSING_WORDS: Record<PeriodontalMissingInput, string> = {
  boneLossPercent: "la pérdida de hueso en la radiografía",
  teethLostToPeriodontitis: "las piezas perdidas por la enfermedad",
  smoking: "si fuma",
  diabetes: "si tiene diabetes",
}
/** «Falta si fuma» · «Faltan la pérdida de hueso en la radiografía y si fuma». */
function missingSentence(missing: readonly PeriodontalMissingInput[]): string {
  const words = missing.map((key) => MISSING_WORDS[key])
  const list = words.length > 1 ? `${words.slice(0, -1).join(", ")} y ${words.at(-1)}` : (words[0] ?? "")
  return `${words.length > 1 ? "Faltan" : "Falta"} ${list}`
}
const siteWords = (site: string) => PERIODONTAL_SITE_WORDS[PERIODONTAL_SITES.indexOf(site as (typeof PERIODONTAL_SITES)[number])] ?? site

/** El periodontograma de la atención, de la lista de la persona (la misma consulta de la ficha). */
export function useEncounterPeriodontal(patientId: string, encounterId: string) {
  const list = useQuery({
    queryKey: periodontalKeys.list(patientId),
    queryFn: () => fetchPeriodontalCharts(patientId),
  })
  const item = list.data?.data.find((chart) => chart.encounterId === encounterId) ?? null
  return { list, item }
}

/** El resumen del bloque en la atención: «Faltan 13 piezas · sangrado 31 %» o la clasificación. */
export function periodontalBlockSummary(item: PeriodontalChartListItem | null): string {
  if (!item) return "Sin periodontograma"
  const parts = [
    item.pending === "todo" ? "Sin sondear" : item.pending ? "Sin terminar" : "Sondaje completo",
    item.bleedingPercent !== null ? `sangrado ${item.bleedingPercent} %` : "",
    item.classification ? periodontalClassificationShort(item.classification as PeriodontalClassification) : "",
  ]
  return parts.filter(Boolean).join(" · ")
}

function numberOrNull(value: string): number | null {
  if (value.trim() === "") return null
  const n = Number(value.replace(",", "."))
  return Number.isFinite(n) ? n : null
}

/** Lo escrito en un dato numérico: vacío vale (no se preguntó); si no es un número, la causa. */
function numberError(text: string, integer: boolean): string | undefined {
  if (!text.trim()) return undefined
  const value = numberOrNull(text)
  if (value === null) return "Escribe un número."
  if (integer && !Number.isInteger(value)) return "Escribe un número entero, sin decimales."
  return undefined
}

/**
 * La captura a pantalla completa, montada por la atención y no por su bloque:
 * el bloque vive en la superficie lateral, que se vuelve a montar al cambiar
 * el tamaño de la ventana (girar la tableta), y la captura no debe cerrarse por eso.
 */
export function PeriodontalCaptureHost({
  patientId,
  chartId,
  onClose,
}: {
  patientId: string
  chartId: string
  onClose: () => void
}) {
  const chart = useQuery({
    queryKey: periodontalKeys.chart(patientId, chartId),
    queryFn: () => fetchPeriodontalChart(patientId, chartId),
  })
  if (!chart.data) return null
  return <PeriodontalCapture patientId={patientId} chart={chart.data.data} open onClose={onClose} />
}

export function EncounterPeriodontalBlock({
  patientId,
  encounterId,
  disabled,
  beforeWrite,
  onChanged,
  onCapture,
}: {
  patientId: string
  encounterId: string
  /** Sin permiso, firmada o la lleva otro: solo se lee. */
  disabled?: boolean
  beforeWrite: () => Promise<void>
  onChanged: () => Promise<void>
  /** Abre la captura (la monta la atención, ver `PeriodontalCaptureHost`). */
  onCapture: (chartId: string) => void
}) {
  const queryClient = useQueryClient()
  const { list, item } = useEncounterPeriodontal(patientId, encounterId)
  const chart = useQuery({
    queryKey: periodontalKeys.chart(patientId, item?.id ?? ""),
    queryFn: () => fetchPeriodontalChart(patientId, item!.id),
    enabled: item !== null,
  })
  const start = useMutation({
    mutationFn: async () => {
      await beforeWrite()
      return startPeriodontalChart(patientId, encounterId)
    },
    onSuccess: async (result) => {
      queryClient.setQueryData(periodontalKeys.chart(patientId, result.data.id), result)
      await queryClient.invalidateQueries({ queryKey: periodontalKeys.list(patientId) })
      onCapture(result.data.id)
    },
  })

  if (list.isPending) return <LoadingState message="Cargando el periodontograma…" />
  if (list.isError) return <QueryErrorState error={list.error} onRetry={() => void list.refetch()} />
  if (!item) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Una boca completa lleva entre 10 y 20 minutos. Las piezas ausentes y los implantes ya vienen del odontograma; la movilidad que anotes aparece en él.
        </p>
        {disabled ? (
          <p className="text-sm text-muted-foreground">Esta atención no tiene periodontograma.</p>
        ) : (
          <>
            <SubmitButton className="self-start" pending={start.isPending} onClick={() => start.mutate()}>
              Empezar
            </SubmitButton>
            {start.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {submitErrorMessage(start.error)}
              </p>
            ) : null}
          </>
        )}
      </div>
    )
  }
  if (chart.isPending) return <LoadingState message="Cargando el periodontograma…" />
  if (chart.isError) return <QueryErrorState error={chart.error} onRetry={() => void chart.refetch()} />
  const view = chart.data.data
  const total = view.expectedTeeth.length
  const measured = total - view.summary.pendingTeeth.length
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Avance</dt>
          <dd>
            {measured} de {total} {total === 1 ? "pieza" : "piezas"}
            {view.implantTeeth.length ? ` (con ${view.implantTeeth.length} ${view.implantTeeth.length === 1 ? "implante" : "implantes"})` : ""}
          </dd>
          {view.pending ? (
            <>
              <dt className="text-muted-foreground">Falta</dt>
              <dd>{view.pending}</dd>
            </>
          ) : null}
        </dl>
        {!disabled ? (
          <Button type="button" variant={view.pending ? "default" : "outline"} onClick={() => onCapture(view.id)}>
            {view.pending === "todo" ? "Empezar" : view.pending ? "Seguir" : "Corregir o marcar la placa"}
          </Button>
        ) : null}
      </div>
      <PeriodontalTiles summary={view.summary} />
      <div className="rounded-xl border bg-card p-2">
        <PeriodontalChart
          teeth={view.teeth}
          expectedTeeth={view.expectedTeeth}
          implantTeeth={view.implantTeeth}
          plaque={view.summary.plaque !== null}
          label="Periodontograma de esta atención"
        />
      </div>
      <PeriodontalClassify
        patientId={patientId}
        chart={view}
        disabled={disabled}
        beforeWrite={beforeWrite}
        onChanged={onChanged}
      />
    </div>
  )
}

interface ClassifyDraft {
  boneLossPercent: string
  teethLostToPeriodontitis: string
  cigarettesPerDay: string
  /** "" (sin preguntar), "yes" o "no". */
  diabetes: string
  hba1c: string
  /** Estado de cada implante que el odontólogo eligió; los demás, el que propone odentIA. */
  implants: Partial<Record<string, PeriImplantCondition>>
  /** «Cambiar»: se confirma lo elegido abajo en vez de la propuesta. */
  changing: boolean
  diagnosis: string
  stage: string
  grade: string
  extent: string
  status: string
}

function draftFrom(chart: ChartData): ClassifyDraft {
  const c = chart.classification
  return {
    boneLossPercent: c?.boneLossPercent?.toString() ?? "",
    teethLostToPeriodontitis: c?.teethLostToPeriodontitis?.toString() ?? "",
    cigarettesPerDay: c?.cigarettesPerDay?.toString() ?? "",
    diabetes: c?.diabetes === true ? "yes" : c?.diabetes === false ? "no" : "",
    hba1c: c?.hba1c?.toString() ?? "",
    implants: Object.fromEntries(chart.teeth.filter((t) => t.periImplant).map((t) => [String(t.toothNumber), t.periImplant!])),
    changing: false,
    diagnosis: "",
    stage: "",
    grade: "",
    extent: "",
    status: "",
  }
}

function inputsOf(draft: ClassifyDraft): PeriodontalClassificationInputs {
  return {
    boneLossPercent: numberOrNull(draft.boneLossPercent),
    teethLostToPeriodontitis: numberOrNull(draft.teethLostToPeriodontitis),
    cigarettesPerDay: numberOrNull(draft.cigarettesPerDay),
    diabetes: draft.diabetes === "" ? null : draft.diabetes === "yes",
    hba1c: draft.diabetes === "yes" ? numberOrNull(draft.hba1c) : null,
  }
}

interface Chosen {
  diagnosis: PeriodontalDiagnosis
  stage: PeriodontitisStage | null
  grade: PeriodontitisGrade | null
  extent: PeriodontalExtent | null
  status: PeriodontitisStatus | null
}

/** Lo que se confirma: lo elegido con «Cambiar» o, si no, la propuesta. */
function chosenOf(draft: ClassifyDraft, proposal: PeriodontalProposal): Chosen {
  if (!draft.changing) {
    return {
      diagnosis: proposal.diagnosis,
      stage: proposal.stage,
      grade: proposal.grade,
      extent: proposal.extent,
      status: proposal.status,
    }
  }
  return {
    diagnosis: draft.diagnosis as PeriodontalDiagnosis,
    stage: draft.stage ? (Number(draft.stage) as PeriodontitisStage) : null,
    grade: (draft.grade || null) as PeriodontitisGrade | null,
    extent: (draft.extent || null) as PeriodontalExtent | null,
    status: (draft.status || null) as PeriodontitisStatus | null,
  }
}

/** Lo que viaja: estadio, grado y estado solo en la periodontitis; la salud sin extensión. */
function classificationOf(choice: Chosen): Omit<PeriodontalClassification, keyof PeriodontalClassificationInputs> {
  const periodontitis = choice.diagnosis === "periodontitis"
  return {
    diagnosis: choice.diagnosis,
    stage: periodontitis ? choice.stage : null,
    grade: periodontitis ? choice.grade : null,
    extent: choice.diagnosis === "health" ? null : choice.extent,
    status: periodontitis ? choice.status : null,
  }
}

const CHOICE_FIELDS: readonly string[] = ["diagnosis", "stage", "grade", "extent", "status"]

/**
 * Resumen y clasificación (tablero 9): lo que se midió, lo que agrega el
 * odontólogo y lo que propone odentIA, recalculado con la misma regla del
 * servidor mientras escribe. «Cambiar» deja elegir otra cosa antes de confirmar.
 */
function PeriodontalClassify({
  patientId,
  chart,
  disabled,
  beforeWrite,
  onChanged,
}: {
  patientId: string
  chart: ChartData
  disabled?: boolean
  beforeWrite: () => Promise<void>
  onChanged: () => Promise<void>
}) {
  const ids = useId()
  const sectionRef = useRef<HTMLElement>(null)
  const queryClient = useQueryClient()
  // Los valores iniciales, una vez: lo que llega después no borra lo escrito.
  const [initial] = useState(() => draftFrom(chart))
  // La misma regla que el servidor, recalculada con lo que se escribe.
  const proposeFor = (value: ClassifyDraft) =>
    proposePeriodontalClassification(
      chart.teeth,
      chart.implantTeeth,
      inputsOf(value),
      chart.proposalBasis.ageYears,
      chart.proposalBasis.remainingTeeth,
      chart.proposalBasis.previous,
    )
  /**
   * Lo mismo que valida el servidor, antes de enviar. Si se confirma la
   * propuesta, lo que le falta se dice junto al botón (no hay selector a la
   * vista): se completa con lo que falta o con «Cambiar».
   */
  const validateClassify = (value: ClassifyDraft) => {
    const choice = chosenOf(value, proposeFor(value))
    const fields: Partial<Record<keyof ClassifyDraft, string>> = {}
    const general: string[] = []
    for (const issue of periodontalClassificationIssues({ ...classificationOf(choice), ...inputsOf(value) })) {
      if (CHOICE_FIELDS.includes(issue.field) && !value.changing)
        general.push(`${issue.message}: completa lo que falta o elígelo con «Cambiar».`)
      else fields[issue.field] ??= issue.message
    }
    if (general.length === 0 && Object.keys(fields).length === 0) return undefined
    return { form: general.length > 0 ? general.join(" ") : undefined, fields }
  }
  const form = useAppForm({
    defaultValues: initial,
    validators: { onSubmit: ({ value }) => validateClassify(value) },
    onSubmit: async ({ value }) => {
      const proposal = proposeFor(value)
      await beforeWrite()
      const result = await classifyPeriodontalChart(patientId, chart.id, {
        ...classificationOf(chosenOf(value, proposal)),
        ...inputsOf(value),
        implants: proposal.implants.map((implant) => ({
          toothNumber: implant.toothNumber,
          condition: value.implants[String(implant.toothNumber)] ?? implant.condition,
        })),
      })
      queryClient.setQueryData(periodontalKeys.chart(patientId, chart.id), result)
      await queryClient.invalidateQueries({ queryKey: periodontalKeys.list(patientId) })
      form.reset({ ...value, changing: false }, { keepDefaultValues: true })
      toast.success("Diagnóstico confirmado; quedó también en el diagnóstico de la atención")
      await onChanged()
    },
  })
  const draft = useStore(form.store, (state) => state.values)
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
  const submitError = useFormSubmitError(form)
  const proposal = useMemo(
    () =>
      proposePeriodontalClassification(
        chart.teeth,
        chart.implantTeeth,
        inputsOf(draft),
        chart.proposalBasis.ageYears,
        chart.proposalBasis.remainingTeeth,
        chart.proposalBasis.previous,
      ),
    [chart.teeth, chart.implantTeeth, chart.proposalBasis, draft],
  )
  // El servidor nombra cada implante por su lugar en la lista que se envía.
  const serverField = (key: string) => {
    const match = /^implants\[(\d+)\]/.exec(key)
    const implant = match ? proposal.implants[Number(match[1])] : undefined
    return implant ? `implants.${implant.toothNumber}` : undefined
  }
  const confirm = () => void submitForm(form, { root: sectionRef.current, fieldMap: serverField })
  const startChanging = () => {
    form.setFieldValue("diagnosis", proposal.diagnosis)
    form.setFieldValue("stage", proposal.stage?.toString() ?? "")
    form.setFieldValue("grade", proposal.grade ?? "")
    form.setFieldValue("extent", proposal.extent ?? "")
    form.setFieldValue("status", proposal.status ?? "")
    form.setFieldValue("changing", true)
  }
  // Lo que se escribió y no es un número se dice en su campo, no como «Falta…».
  const written: Record<PeriodontalMissingInput, string> = {
    boneLossPercent: draft.boneLossPercent,
    teethLostToPeriodontitis: draft.teethLostToPeriodontitis,
    smoking: draft.cigarettesPerDay,
    diabetes: draft.diabetes,
  }
  const missing = proposal.missing.filter((key) => !written[key].trim())
  const summary = chart.summary
  const confirmed = chart.classification

  return (
    // Mide por su contenedor: en la superficie lateral va en una columna; en ancho, en tres.
    <section ref={sectionRef} aria-labelledby={`${ids}-title`} className="@container flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${ids}-title`} className="font-heading text-base font-medium">
          Resumen y clasificación
        </h3>
        {confirmed ? (
          <Badge variant="success">Confirmado: {periodontalClassificationShort(confirmed as unknown as PeriodontalClassification)}</Badge>
        ) : null}
      </div>
      <div className="grid gap-4 @4xl:grid-cols-3">
        <div className="flex flex-col gap-2 rounded-xl border p-3">
          <span className="text-xs font-bold tracking-wider text-muted-foreground uppercase">1 · Lo que se midió</span>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Mayor pérdida de inserción entre dientes</dt>
            <dd className="text-right">
              {summary.worstInterdentalLoss
                ? `${summary.worstInterdentalLoss.value} mm · ${summary.worstInterdentalLoss.toothNumber}, ${siteWords(summary.worstInterdentalLoss.site)}`
                : "Sin datos"}
            </dd>
            <dt className="text-muted-foreground">Bolsas de 6 mm o más</dt>
            <dd className="text-right">{summary.sitesFrom6mm} sitios</dd>
            <dt className="text-muted-foreground">Furca</dt>
            <dd className="text-right">{summary.maxFurcation ? `Hasta grado ${STAGE_WORDS[summary.maxFurcation]}` : "Sin furca"}</dd>
            <dt className="text-muted-foreground">Movilidad</dt>
            <dd className="text-right">{summary.maxMobility ? `Hasta grado ${summary.maxMobility}` : "Sin movilidad"}</dd>
            {summary.implants.map((implant) => (
              <div key={implant.toothNumber} className="contents">
                <dt className="text-muted-foreground">Implante {implant.toothNumber}</dt>
                <dd className="text-right">
                  Sangra en {implant.bleedingSites} de 6{implant.suppurationSites ? `, supura en ${implant.suppurationSites}` : ""}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">Lo calcula odentIA con el periodontograma: no se escribe.</p>
        </div>

        <div className="flex flex-col gap-3 rounded-xl border p-3">
          <span className="text-xs font-bold tracking-wider text-muted-foreground uppercase">2 · Lo que agregas</span>
          <form.AppField name="boneLossPercent" validators={{ onChange: ({ value }) => numberError(value, true) }}>
            {(field) => (
              <field.TextField
                id={`${ids}-bone`}
                label="Pérdida de hueso en la radiografía, en la pieza más afectada (%)"
                inputMode="numeric"
                disabled={disabled}
                placeholder="Ej.: 40"
              />
            )}
          </form.AppField>
          <form.AppField name="teethLostToPeriodontitis" validators={{ onChange: ({ value }) => numberError(value, true) }}>
            {(field) => (
              <field.TextField
                id={`${ids}-lost`}
                label="Piezas perdidas por la enfermedad"
                inputMode="numeric"
                disabled={disabled}
                placeholder="0 si ninguna"
              />
            )}
          </form.AppField>
          <form.AppField name="cigarettesPerDay" validators={{ onChange: ({ value }) => numberError(value, true) }}>
            {(field) => (
              <field.TextField
                id={`${ids}-smoke`}
                label="Cigarrillos al día"
                inputMode="numeric"
                disabled={disabled}
                placeholder="0 si no fuma"
              />
            )}
          </form.AppField>
          <form.AppField name="diabetes">
            {(field) => (
              <field.SelectField
                id={`${ids}-diabetes`}
                label="¿Diabetes?"
                placeholder="Sin preguntar"
                disabled={disabled}
                options={[
                  { value: "no", label: "No" },
                  { value: "yes", label: "Sí" },
                ]}
              />
            )}
          </form.AppField>
          {draft.diabetes === "yes" ? (
            <form.AppField name="hba1c" validators={{ onChange: ({ value }) => numberError(value, false) }}>
              {(field) => (
                <field.TextField
                  id={`${ids}-hba1c`}
                  label="Última hemoglobina glicada (%)"
                  inputMode="decimal"
                  disabled={disabled}
                  placeholder="Ej.: 6,8"
                />
              )}
            </form.AppField>
          ) : null}
        </div>

        <div className="flex flex-col gap-3">
          <span className="text-xs font-bold tracking-wider text-muted-foreground uppercase">3 · Lo que propone odentIA</span>
          <div className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary-soft/40 p-3">
            <span className="text-lg font-bold">
              {periodontalClassificationShort({
                diagnosis: proposal.diagnosis,
                stage: proposal.stage,
                grade: proposal.grade,
                extent: proposal.extent,
                status: proposal.status,
              })}
            </span>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              {proposal.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            {missing.length ? (
              <p className="text-sm text-muted-foreground">
                {missingSentence(missing)}: la propuesta parte de lo que hay.
              </p>
            ) : null}
            {proposal.warnings.map((warning) => (
              <p key={warning} className="rounded-lg bg-warning-soft px-2.5 py-2 text-sm text-warning">
                {warning}
              </p>
            ))}
          </div>
          {proposal.implants.map((implant) => (
            <form.AppField key={implant.toothNumber} name={`implants.${implant.toothNumber}`}>
              {(field) => (
                <field.Control
                  id={`${ids}-imp-${implant.toothNumber}`}
                  label={`Implante ${implant.toothNumber}`}
                  description="La periimplantitis pide ver pérdida de hueso en la radiografía."
                >
                  {(control) => (
                    <ChoiceSelect
                      id={control.id}
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      value={field.state.value ?? implant.condition}
                      disabled={disabled}
                      onChange={(event) => field.handleChange(event.target.value as PeriImplantCondition)}
                    >
                      {PERI_IMPLANT_CONDITIONS.map((value) => (
                        <option key={value} value={value}>
                          {PERI_IMPLANT_WORDS[value]}
                        </option>
                      ))}
                    </ChoiceSelect>
                  )}
                </field.Control>
              )}
            </form.AppField>
          ))}
          {draft.changing ? (
            <FieldSet className="flex flex-col gap-2 rounded-xl border p-3">
              <FieldLegend variant="label">Lo que confirmas</FieldLegend>
              <form.AppField
                name="diagnosis"
                listeners={{
                  // La gingivitis es localizada o generalizada: nunca queda otra extensión elegida.
                  onChange: ({ value }) => {
                    if (value === "gingivitis" && form.getFieldValue("extent") !== "generalized")
                      form.setFieldValue("extent", "localized")
                  },
                }}
              >
                {(field) => (
                  <field.SelectField
                    id={`${ids}-diagnosis`}
                    label="Diagnóstico"
                    options={PERIODONTAL_DIAGNOSES.map((value) => ({ value, label: PERIODONTAL_DIAGNOSIS_WORDS[value] }))}
                  />
                )}
              </form.AppField>
              {draft.diagnosis === "periodontitis" ? (
                <div className="grid grid-cols-2 gap-2">
                  <form.AppField name="stage">
                    {(field) => (
                      <field.SelectField
                        id={`${ids}-stage`}
                        label="Estadio"
                        placeholder="Estadio"
                        options={PERIODONTITIS_STAGES.map((value) => ({ value: String(value), label: `Estadio ${STAGE_WORDS[value]}` }))}
                      />
                    )}
                  </form.AppField>
                  <form.AppField name="grade">
                    {(field) => (
                      <field.SelectField
                        id={`${ids}-grade`}
                        label="Grado"
                        placeholder="Grado"
                        options={PERIODONTITIS_GRADES.map((value) => ({ value, label: `Grado ${value}` }))}
                      />
                    )}
                  </form.AppField>
                  <form.AppField name="extent">
                    {(field) => (
                      <field.SelectField
                        id={`${ids}-extent`}
                        label="Extensión"
                        placeholder="Extensión"
                        options={PERIODONTAL_EXTENTS.map((value) => ({ value, label: PERIODONTAL_EXTENT_WORDS[value] }))}
                      />
                    )}
                  </form.AppField>
                  {chart.proposalBasis.previous ? (
                    <form.AppField name="status">
                      {(field) => (
                        <field.SelectField
                          id={`${ids}-status`}
                          label="Cómo está hoy"
                          placeholder="Cómo está hoy"
                          options={PERIODONTITIS_STATUSES.map((value) => ({ value, label: PERIODONTITIS_STATUS_WORDS[value] }))}
                        />
                      )}
                    </form.AppField>
                  ) : null}
                </div>
              ) : draft.diagnosis === "gingivitis" ? (
                <form.AppField name="extent">
                  {(field) => (
                    <field.SelectField
                      id={`${ids}-extent`}
                      label="Extensión"
                      options={[
                        { value: "localized", label: "Localizada" },
                        { value: "generalized", label: "Generalizada" },
                      ]}
                    />
                  )}
                </form.AppField>
              ) : null}
            </FieldSet>
          ) : null}
          {!disabled ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <SubmitButton pending={isSubmitting} onClick={confirm}>
                  {draft.changing ? "Confirmar lo elegido" : "Confirmar diagnóstico"}
                </SubmitButton>
                <Button
                  type="button"
                  variant="outline"
                  onClick={draft.changing ? () => form.setFieldValue("changing", false) : startChanging}
                >
                  {draft.changing ? "Volver a la propuesta" : "Cambiar"}
                </Button>
              </div>
              {submitError ? (
                <p role="alert" className="text-sm text-destructive">
                  {submitError}
                </p>
              ) : null}
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Al confirmar, la atención recibe también su diagnóstico con el código de la lista de la clínica y la clasificación como nota. No hay que buscarlo aparte.
          </p>
        </div>
      </div>
    </section>
  )
}
