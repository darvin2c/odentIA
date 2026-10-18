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
  type PeriodontalClassificationInputs,
  type PeriodontalDiagnosis,
  type PeriodontalExtent,
  type PeriodontalMissingInput,
  periodontalClassificationShort,
  PERIODONTITIS_GRADES,
  PERIODONTITIS_STAGES,
  PERIODONTITIS_STATUS_WORDS,
  PERIODONTITIS_STATUSES,
  type PeriodontitisGrade,
  type PeriodontitisStage,
  type PeriodontitisStatus,
  proposePeriodontalClassification,
} from "@odentia/clinical"
import { Badge, Button, cn, Field, FieldLabel, Input, toast } from "@odentia/ui"
import { LoadingState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useMemo, useState } from "react"
import { ApiError } from "../../lib/api"
import {
  classifyPeriodontalChart,
  fetchPeriodontalChart,
  fetchPeriodontalCharts,
  type PeriodontalChart as ChartData,
  type PeriodontalChartListItem,
  periodontalKeys,
  startPeriodontalChart,
} from "../../lib/periodontal"
import { QueryErrorState } from "../../lib/query-error"
import { ChoiceSelect } from "../ui/choice-select"
import { PeriodontalCapture } from "./periodontal-capture"
import { PeriodontalChart } from "./periodontal-chart"
import { PeriodontalTiles } from "./periodontal-views"

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

/** Un selector de la ficha con sus opciones en una lista. */
function Choice({
  options,
  onValueChange,
  ...props
}: {
  id?: string
  "aria-label"?: string
  value: string
  disabled?: boolean
  placeholder?: string
  options: Array<{ value: string; label: string }>
  onValueChange: (value: string) => void
}) {
  return (
    <ChoiceSelect {...props} onChange={(event) => onValueChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </ChoiceSelect>
  )
}

function numberOrNull(value: string): number | null {
  if (value.trim() === "") return null
  const n = Number(value.replace(",", "."))
  return Number.isFinite(n) ? n : null
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
    onError: (err) => toast.error(err instanceof ApiError && err.shape.message ? err.shape.message : "No se pudo empezar el periodontograma"),
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
          <SubmitButton className="self-start" pending={start.isPending} onClick={() => start.mutate()}>
            Empezar
          </SubmitButton>
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

interface Draft {
  boneLossPercent: string
  teethLostToPeriodontitis: string
  cigarettesPerDay: string
  diabetes: "" | "yes" | "no"
  hba1c: string
}

function draftFrom(chart: ChartData): Draft {
  const c = chart.classification
  return {
    boneLossPercent: c?.boneLossPercent?.toString() ?? "",
    teethLostToPeriodontitis: c?.teethLostToPeriodontitis?.toString() ?? "",
    cigarettesPerDay: c?.cigarettesPerDay?.toString() ?? "",
    diabetes: c?.diabetes === true ? "yes" : c?.diabetes === false ? "no" : "",
    hba1c: c?.hba1c?.toString() ?? "",
  }
}

function inputsOf(draft: Draft): PeriodontalClassificationInputs {
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
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Draft>(() => draftFrom(chart))
  const [override, setOverride] = useState<Chosen | null>(null)
  const inputs = inputsOf(draft)
  // La misma regla que el servidor, recalculada con lo que se escribe.
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
  const [implants, setImplants] = useState<Record<number, PeriImplantCondition>>(() =>
    Object.fromEntries(chart.teeth.filter((t) => t.periImplant).map((t) => [t.toothNumber, t.periImplant!])),
  )
  const choice: Chosen = override ?? {
    diagnosis: proposal.diagnosis,
    stage: proposal.stage,
    grade: proposal.grade,
    extent: proposal.extent,
    status: proposal.status,
  }
  const confirm = useMutation({
    mutationFn: async () => {
      await beforeWrite()
      const periodontitis = choice.diagnosis === "periodontitis"
      return classifyPeriodontalChart(patientId, chart.id, {
        diagnosis: choice.diagnosis,
        stage: periodontitis ? choice.stage : null,
        grade: periodontitis ? choice.grade : null,
        extent: choice.diagnosis === "health" ? null : choice.extent,
        status: periodontitis ? choice.status : null,
        ...inputs,
        implants: proposal.implants.map((implant) => ({ toothNumber: implant.toothNumber, condition: implants[implant.toothNumber] ?? implant.condition })),
      })
    },
    onSuccess: async (result) => {
      queryClient.setQueryData(periodontalKeys.chart(patientId, chart.id), result)
      await queryClient.invalidateQueries({ queryKey: periodontalKeys.list(patientId) })
      setOverride(null)
      toast.success("Diagnóstico confirmado; quedó también en el diagnóstico de la atención")
      await onChanged()
    },
    onError: (err) => toast.error(err instanceof ApiError && err.shape.message ? err.shape.message : "No se pudo confirmar el diagnóstico"),
  })
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const summary = chart.summary
  const confirmed = chart.classification
  const periodontitis = choice.diagnosis === "periodontitis"
  const valid = !periodontitis || (choice.stage !== null && choice.grade !== null && choice.extent !== null)

  return (
    // Mide por su contenedor: en la superficie lateral va en una columna; en ancho, en tres.
    <section aria-labelledby={`${ids}-title`} className="@container flex flex-col gap-4">
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
          <Field>
            <FieldLabel htmlFor={`${ids}-bone`}>Pérdida de hueso en la radiografía, en la pieza más afectada (%)</FieldLabel>
            <Input
              id={`${ids}-bone`}
              inputMode="numeric"
              value={draft.boneLossPercent}
              disabled={disabled}
              placeholder="Ej.: 40"
              onChange={(event) => set("boneLossPercent", event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-lost`}>Piezas perdidas por la enfermedad</FieldLabel>
            <Input
              id={`${ids}-lost`}
              inputMode="numeric"
              value={draft.teethLostToPeriodontitis}
              disabled={disabled}
              placeholder="0 si ninguna"
              onChange={(event) => set("teethLostToPeriodontitis", event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-smoke`}>Cigarrillos al día</FieldLabel>
            <Input
              id={`${ids}-smoke`}
              inputMode="numeric"
              value={draft.cigarettesPerDay}
              disabled={disabled}
              placeholder="0 si no fuma"
              onChange={(event) => set("cigarettesPerDay", event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-diabetes`}>¿Diabetes?</FieldLabel>
            <Choice
              id={`${ids}-diabetes`}
              value={draft.diabetes}
              disabled={disabled}
              placeholder="Sin preguntar"
              options={[
                { value: "no", label: "No" },
                { value: "yes", label: "Sí" },
              ]}
              onValueChange={(value) => set("diabetes", value === "yes" ? "yes" : value === "no" ? "no" : "")}
            />
          </Field>
          {draft.diabetes === "yes" ? (
            <Field>
              <FieldLabel htmlFor={`${ids}-hba1c`}>Última hemoglobina glicada (%)</FieldLabel>
              <Input
                id={`${ids}-hba1c`}
                inputMode="decimal"
                value={draft.hba1c}
                disabled={disabled}
                placeholder="Ej.: 6,8"
                onChange={(event) => set("hba1c", event.target.value)}
              />
            </Field>
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
            {proposal.missing.length ? (
              <p className="text-sm text-muted-foreground">
                {missingSentence(proposal.missing)}: la propuesta parte de lo que hay.
              </p>
            ) : null}
            {proposal.warnings.map((warning) => (
              <p key={warning} className="rounded-lg bg-warning-soft px-2.5 py-2 text-sm text-warning">
                {warning}
              </p>
            ))}
          </div>
          {proposal.implants.map((implant) => (
            <Field key={implant.toothNumber}>
              <FieldLabel htmlFor={`${ids}-imp-${implant.toothNumber}`}>Implante {implant.toothNumber}</FieldLabel>
              <Choice
                id={`${ids}-imp-${implant.toothNumber}`}
                value={implants[implant.toothNumber] ?? implant.condition}
                disabled={disabled}
                options={PERI_IMPLANT_CONDITIONS.map((value) => ({ value, label: PERI_IMPLANT_WORDS[value] }))}
                onValueChange={(value) => setImplants((current) => ({ ...current, [implant.toothNumber]: value as PeriImplantCondition }))}
              />
              <p className="text-xs text-muted-foreground">La periimplantitis pide ver pérdida de hueso en la radiografía.</p>
            </Field>
          ))}
          {override ? (
            <div className="flex flex-col gap-2 rounded-xl border p-3">
              <span className="text-sm font-medium">Lo que confirmas</span>
              <Choice
                aria-label="Diagnóstico"
                value={override.diagnosis}
                options={PERIODONTAL_DIAGNOSES.map((value) => ({ value, label: PERIODONTAL_DIAGNOSIS_WORDS[value] }))}
                onValueChange={(value) => setOverride({ ...override, diagnosis: value as PeriodontalDiagnosis })}
              />
              {override.diagnosis === "periodontitis" ? (
                <div className="grid grid-cols-2 gap-2">
                  <Choice
                    aria-label="Estadio"
                    value={override.stage?.toString() ?? ""}
                    placeholder="Estadio"
                    options={PERIODONTITIS_STAGES.map((value) => ({ value: String(value), label: `Estadio ${STAGE_WORDS[value]}` }))}
                    onValueChange={(value) => setOverride({ ...override, stage: Number(value) as PeriodontitisStage })}
                  />
                  <Choice
                    aria-label="Grado"
                    value={override.grade ?? ""}
                    placeholder="Grado"
                    options={PERIODONTITIS_GRADES.map((value) => ({ value, label: `Grado ${value}` }))}
                    onValueChange={(value) => setOverride({ ...override, grade: value as PeriodontitisGrade })}
                  />
                  <Choice
                    aria-label="Extensión"
                    value={override.extent ?? ""}
                    placeholder="Extensión"
                    options={PERIODONTAL_EXTENTS.map((value) => ({ value, label: PERIODONTAL_EXTENT_WORDS[value] }))}
                    onValueChange={(value) => setOverride({ ...override, extent: value as PeriodontalExtent })}
                  />
                  {chart.proposalBasis.previous ? (
                    <Choice
                      aria-label="Cómo está hoy"
                      value={override.status ?? ""}
                      placeholder="Cómo está hoy"
                      options={PERIODONTITIS_STATUSES.map((value) => ({ value, label: PERIODONTITIS_STATUS_WORDS[value] }))}
                      onValueChange={(value) => setOverride({ ...override, status: value as PeriodontitisStatus })}
                    />
                  ) : null}
                </div>
              ) : override.diagnosis === "gingivitis" ? (
                <Choice
                  aria-label="Extensión"
                  value={override.extent === "generalized" ? "generalized" : "localized"}
                  options={[
                    { value: "localized", label: "Localizada" },
                    { value: "generalized", label: "Generalizada" },
                  ]}
                  onValueChange={(value) => setOverride({ ...override, extent: value as PeriodontalExtent })}
                />
              ) : null}
            </div>
          ) : null}
          {!disabled ? (
            <div className="flex flex-wrap gap-2">
              <SubmitButton pending={confirm.isPending} disabled={!valid} onClick={() => confirm.mutate()}>
                {override ? "Confirmar lo elegido" : "Confirmar diagnóstico"}
              </SubmitButton>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOverride(override ? null : { ...choice })}
              >
                {override ? "Volver a la propuesta" : "Cambiar"}
              </Button>
            </div>
          ) : null}
          <p className={cn("text-xs text-muted-foreground")}>
            Al confirmar, la atención recibe también su diagnóstico con el código de la lista de la clínica y la clasificación como nota. No hay que buscarlo aparte.
          </p>
        </div>
      </div>
    </section>
  )
}
