/**
 * Periodontograma en la ficha (lienzo, tableros 2, 4 y 11): va debajo de
 * Odontograma, dentro de Clínica. Lista las visitas, abre el gráfico completo
 * con el cambio de visita animado y compara dos. Se escribe dentro de una
 * atención: aquí solo se lee, y abrirlo cuenta como consulta a la historia.
 */
import { periodontalClassificationShort, type PeriodontalClassification } from "@odentia/dental"
import {
  Badge,
  Button,
  Checkbox,
  FieldLabel,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@odentia/ui"
import { EmptyState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeft, Activity } from "lucide-react"
import { useEffect, useId, useMemo, useState } from "react"
import {
  fetchPeriodontalChart,
  fetchPeriodontalCharts,
  type PeriodontalChart as ChartData,
  type PeriodontalChartListItem,
  periodontalKeys,
  visitDate,
  visitDay,
  visitName,
} from "../../../lib/dental/periodontal"
import { QueryErrorState } from "@odentia/clinic-app/lib/query-error"
import { NewEncounterButton } from "@odentia/clinic-app/components/patient/new-encounter-button"
import { PeriodontalChart, PeriodontalLegend } from "./periodontal-chart"
import { PeriodontalCompare } from "./periodontal-compare"
import { BleedingSparkline, PeriodontalTiles, PeriodontalToothDetail } from "./periodontal-views"

function classificationText(item: Pick<PeriodontalChartListItem, "classification">): string | null {
  if (!item.classification) return null
  return periodontalClassificationShort(item.classification as PeriodontalClassification)
}

type View = { mode: "list" } | { mode: "chart"; chartId: string } | { mode: "compare"; before: string; after: string }

export function PeriodontogramaTab({
  patientId,
  initialChartId,
  onToothHistory,
}: {
  patientId: string
  initialChartId?: string
  onToothHistory?: (tooth: number) => void
}) {
  const list = useQuery({
    queryKey: periodontalKeys.list(patientId),
    queryFn: () => fetchPeriodontalCharts(patientId),
  })
  const [view, setView] = useState<View>(initialChartId ? { mode: "chart", chartId: initialChartId } : { mode: "list" })
  // Un enlace nuevo (Historia, Resumen) manda sobre la vista local.
  useEffect(() => {
    if (initialChartId) setView({ mode: "chart", chartId: initialChartId })
  }, [initialChartId])

  if (list.isPending) return <LoadingState message="Cargando el periodontograma…" />
  if (list.isError) return <QueryErrorState error={list.error} onRetry={() => void list.refetch()} />
  // Del más antiguo al más reciente: así se nombran «Inicial» y «Reevaluación».
  const visits = [...list.data.data].reverse()
  if (visits.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <EmptyState
          icon={Activity}
          title="Todavía no tiene periodontograma"
          description="Se hace dentro de una atención: las piezas ausentes y los implantes vienen del odontograma."
        />
        <NewEncounterButton patientId={patientId} variant="outline" size="sm" />
      </div>
    )
  }
  if (view.mode === "chart" && visits.some((visit) => visit.id === view.chartId)) {
    return (
      <PeriodontalViewer
        patientId={patientId}
        visits={visits}
        chartId={view.chartId}
        onChart={(chartId) => setView({ mode: "chart", chartId })}
        onBack={() => setView({ mode: "list" })}
        onToothHistory={onToothHistory}
      />
    )
  }
  if (view.mode === "compare" && visits.length >= 2) {
    return (
      <PeriodontalCompare
        patientId={patientId}
        visits={visits}
        before={view.before}
        after={view.after}
        onPick={(before, after) => setView({ mode: "compare", before, after })}
        onBack={() => setView({ mode: "list" })}
        onToothHistory={onToothHistory}
      />
    )
  }
  const first = visits[0]!
  const last = visits.at(-1)!
  return (
    <section aria-labelledby="perio-list-title" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="perio-list-title" className="font-heading text-base font-medium">
            Periodontograma
          </h2>
          {visits.length >= 2 ? <BleedingSparkline first={first.bleedingPercent} last={last.bleedingPercent} /> : null}
        </div>
        {visits.length >= 2 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setView({ mode: "compare", before: visits.at(-2)!.id, after: last.id })}
          >
            Comparar
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-col gap-2">
        {[...visits].reverse().map((visit) => {
          const index = visits.indexOf(visit)
          const draft = visit.encounterStatus === "borrador"
          const classification = classificationText(visit)
          return (
            <li key={visit.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
              <div className="flex min-w-0 flex-col gap-1.5">
                <div>
                  <b>{visitName(index)}</b>
                  <p className="text-sm text-muted-foreground">
                    {[visitDate(visit.date), visit.professionalName, draft ? "en la atención en curso" : "cerrado con la atención"]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline">
                    Sangrado {visit.bleedingPercent === null ? "sin datos" : `${visit.bleedingPercent} %`}
                  </Badge>
                  <Badge variant="outline">Bolsas de 6 mm o más: {visit.sitesFrom6mm}</Badge>
                  {visit.plaquePercent !== null ? <Badge variant="outline">Placa {visit.plaquePercent} %</Badge> : null}
                  {classification ? <Badge variant="soft">{classification}</Badge> : null}
                  {visit.pending ? <Badge variant="warning">{draft ? "Sin terminar" : "Parcial"}</Badge> : null}
                </div>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => setView({ mode: "chart", chartId: visit.id })}>
                Abrir
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** La pieza que se muestra al abrir: la de mayor pérdida, o la primera que se sondea. */
function defaultTooth(chart: ChartData): number {
  return chart.summary.worstInterdentalLoss?.toothNumber ?? chart.expectedTeeth[0] ?? 11
}

/** El gráfico completo de una visita (tablero 4), con el cambio de visita y la anterior punteada. */
function PeriodontalViewer({
  patientId,
  visits,
  chartId,
  onChart,
  onBack,
  onToothHistory,
}: {
  patientId: string
  visits: PeriodontalChartListItem[]
  chartId: string
  onChart: (chartId: string) => void
  onBack: () => void
  onToothHistory?: (tooth: number) => void
}) {
  const ghostId = useId()
  const index = visits.findIndex((visit) => visit.id === chartId)
  const previousId = index > 0 ? visits[index - 1]!.id : null
  const chart = useQuery({
    queryKey: periodontalKeys.chart(patientId, chartId),
    queryFn: () => fetchPeriodontalChart(patientId, chartId),
    placeholderData: (previous) => previous,
  })
  const previous = useQuery({
    queryKey: periodontalKeys.chart(patientId, previousId ?? ""),
    queryFn: () => fetchPeriodontalChart(patientId, previousId!),
    enabled: previousId !== null,
  })
  const [selected, setSelected] = useState<number | null>(null)
  // La visita anterior punteada se enciende sola la primera vez que se pasa a una reevaluación.
  const [ghost, setGhost] = useState<boolean | null>(null)
  const data = chart.data?.data
  const tooth = selected ?? (data ? defaultTooth(data) : null)
  const before = previousId && previous.data?.data.id === previousId ? previous.data.data : null
  const showGhost = previousId !== null && (ghost ?? true)
  const ghostLabel = previousId ? `El ${visitDay(visits[index - 1]!.date)}` : undefined
  const record = useMemo(() => data?.teeth.find((t) => t.toothNumber === tooth) ?? null, [data, tooth])

  if (chart.isPending) return <LoadingState message="Cargando el periodontograma…" />
  if (chart.isError) return <QueryErrorState error={chart.error} onRetry={() => void chart.refetch()} />
  const view = chart.data.data
  const classification = view.classification
    ? periodontalClassificationShort(view.classification as unknown as PeriodontalClassification)
    : null
  return (
    <section aria-label="Periodontograma" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          Todos los periodontogramas
        </Button>
        {view.encounterStatus === "borrador" ? <Badge variant="warning">En la atención en curso</Badge> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {visits.length > 1 ? (
          <Tabs value={chartId} onValueChange={(value) => onChart(String(value))}>
            <TabsList aria-label="Visita">
              {visits.map((visit, i) => (
                <TabsTrigger key={visit.id} value={visit.id}>
                  {visitName(i)} · {visitDay(visit.date)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : (
          <p className="font-medium">
            {visitName(index)} · {visitDate(view.date)}
          </p>
        )}
        {previousId ? (
          <FieldLabel htmlFor={ghostId} className="flex cursor-pointer items-center gap-2 font-normal">
            <Checkbox id={ghostId} checked={showGhost} onCheckedChange={(checked) => setGhost(checked === true)} />
            Ver la visita anterior punteada
          </FieldLabel>
        ) : null}
      </div>
      {classification || view.pending ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {classification ? <Badge variant="soft">{classification}</Badge> : null}
          {view.pending ? (
            <span className="text-muted-foreground">
              {view.encounterStatus === "borrador" ? "Sin terminar" : "Parcial"}: falta {view.pending}.
            </span>
          ) : null}
        </div>
      ) : null}
      <PeriodontalTiles summary={view.summary} previous={before?.summary ?? null} />
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3">
          <PeriodontalChart
            teeth={view.teeth}
            expectedTeeth={view.expectedTeeth}
            implantTeeth={view.implantTeeth}
            ghost={showGhost ? (before?.teeth ?? null) : null}
            ghostLabel={ghostLabel}
            plaque={view.summary.plaque !== null}
            selected={tooth}
            onSelect={setSelected}
            animate
            label={`Periodontograma del ${visitDate(view.date)}`}
          />
          <PeriodontalLegend plaque={view.summary.plaque !== null} />
          <p className="text-xs text-muted-foreground">
            Pasa sobre un sitio para ver sus medidas. Elige una pieza (o recórrelas con Tab y las flechas) para ver su detalle.
          </p>
        </div>
        <aside className="rounded-xl border bg-card p-4">
          {tooth !== null ? (
            <PeriodontalToothDetail
              toothNumber={tooth}
              record={record}
              implant={view.implantTeeth.includes(tooth)}
              present={view.expectedTeeth.includes(tooth)}
              before={showGhost ? (before?.teeth.find((t) => t.toothNumber === tooth) ?? null) : null}
              onToothHistory={onToothHistory}
            />
          ) : null}
        </aside>
      </div>
    </section>
  )
}
