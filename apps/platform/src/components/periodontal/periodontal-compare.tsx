/**
 * Comparar dos visitas (lienzo, tablero 11). Un sitio cuenta como mejorado o
 * empeorado cuando la bolsa cambia 2 mm o más (`comparePeriodontal`); menos
 * que eso puede ser cómo se apoyó la sonda. El mapa se toca para ver el antes
 * y el después de la pieza.
 */
import {
  PERIODONTAL_SITE_WORDS,
  PERIODONTAL_SITES,
  PERIODONTITIS_STATUS_WORDS,
  type PeriodontalSummary,
  type PeriodontalToothRecord,
  SITE_CHANGE_THRESHOLD_MM,
} from "@odentia/clinical"
import {
  Button,
  cn,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@odentia/ui"
import { LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeft } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import {
  fetchPeriodontalChart,
  fetchPeriodontalComparison,
  type PeriodontalChartListItem,
  periodontalKeys,
  visitDay,
  visitName,
} from "../../lib/periodontal"
import { QueryErrorState } from "../../lib/query-error"
import { isUpper } from "./anatomy"
import { displaySites, LOWER_ROW, PeriodontalChart, UPPER_ROW } from "./periodontal-chart"
import { PeriodontalToothDetail } from "./periodontal-views"

const siteIndex = (site: string) => PERIODONTAL_SITES.indexOf(site as (typeof PERIODONTAL_SITES)[number])

/** «menos 21 puntos»: el cambio de una cifra en palabras; menos es mejor en todas. */
function changeWords(before: number | null | undefined, after: number | null | undefined, unit: string): { text: string; tone: "good" | "bad" | "same" } {
  if (before == null || after == null) return { text: "Sin datos", tone: "same" }
  const d = after - before
  if (d === 0) return { text: "Igual", tone: "same" }
  return { text: `${d < 0 ? "Bajó" : "Subió"} ${Math.abs(d)}${unit}`, tone: d < 0 ? "good" : "bad" }
}

function SummaryTable({ before, after, beforeLabel, afterLabel }: { before: PeriodontalSummary; after: PeriodontalSummary; beforeLabel: string; afterLabel: string }) {
  const pct = (value: number | null | undefined) => (value == null ? "Sin datos" : `${value} %`)
  const rows: Array<{ label: string; before: string; after: string; change: ReturnType<typeof changeWords> }> = [
    { label: "Sangrado al sondaje", before: pct(before.bleedingPercent), after: pct(after.bleedingPercent), change: changeWords(before.bleedingPercent, after.bleedingPercent, " pts") },
    { label: "Placa (O'Leary)", before: pct(before.plaque?.percent), after: pct(after.plaque?.percent), change: changeWords(before.plaque?.percent, after.plaque?.percent, " pts") },
    { label: "Bolsas de 4 mm o más", before: String(before.sitesFrom4mm), after: String(after.sitesFrom4mm), change: changeWords(before.sitesFrom4mm, after.sitesFrom4mm, "") },
    { label: "Bolsas de 6 mm o más", before: String(before.sitesFrom6mm), after: String(after.sitesFrom6mm), change: changeWords(before.sitesFrom6mm, after.sitesFrom6mm, "") },
    {
      label: "Mayor pérdida de inserción entre dientes",
      before: before.worstInterdentalLoss ? `${before.worstInterdentalLoss.value} mm` : "Sin datos",
      after: after.worstInterdentalLoss ? `${after.worstInterdentalLoss.value} mm` : "Sin datos",
      change: changeWords(before.worstInterdentalLoss?.value, after.worstInterdentalLoss?.value, " mm"),
    },
  ]
  return (
    <Table className="min-w-[560px]">
      <TableHeader>
        <TableRow>
          <TableHead />
          <TableHead>{beforeLabel}</TableHead>
          <TableHead>{afterLabel}</TableHead>
          <TableHead>Cambio</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.label}>
            <TableCell className="font-medium">{row.label}</TableCell>
            <TableCell className="tabular-nums">{row.before}</TableCell>
            <TableCell className="tabular-nums">{row.after}</TableCell>
            <TableCell>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-semibold",
                  row.change.tone === "good" ? "bg-success-soft text-success" : row.change.tone === "bad" ? "bg-danger-soft text-danger" : "bg-muted text-muted-foreground",
                )}
              >
                {row.change.text}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

const MAP_W = 34

/** Mapa de cambios: cada pieza con sus seis sitios, verde si mejoró y rojo si empeoró 2 mm o más. */
function ChangeMap({
  before,
  after,
  implants,
  expected,
  selected,
  onSelect,
}: {
  before: Map<number, PeriodontalToothRecord>
  after: Map<number, PeriodontalToothRecord>
  implants: Set<number>
  expected: Set<number>
  selected: number | null
  onSelect: (tooth: number) => void
}) {
  const refs = useRef<Array<SVGRectElement | null>>([])
  const rows = [UPPER_ROW, LOWER_ROW]
  const width = 16 * MAP_W + 8
  const height = 2 * 64 + 12
  const change = (tooth: number, site: number): "good" | "bad" | "same" | "none" => {
    const a = after.get(tooth)?.probingDepth[site] ?? null
    const b = before.get(tooth)?.probingDepth[site] ?? null
    if (a === null || b === null) return "none"
    const d = a - b
    return d <= -SITE_CHANGE_THRESHOLD_MM ? "good" : d >= SITE_CHANGE_THRESHOLD_MM ? "bad" : "same"
  }
  const words = (tooth: number): string => {
    if (!expected.has(tooth)) return `Pieza ${tooth}: ausente`
    if (implants.has(tooth)) return `Pieza ${tooth}: implante, se compara aparte`
    const all = [0, 1, 2, 3, 4, 5].map((site) => change(tooth, site))
    const worse = all.filter((c) => c === "bad").length
    const better = all.filter((c) => c === "good").length
    if (all.every((c) => c === "none")) return `Pieza ${tooth}: sin medir en las dos visitas`
    return `Pieza ${tooth}: ${better} ${better === 1 ? "sitio mejoró" : "sitios mejoraron"}, ${worse} ${worse === 1 ? "empeoró" : "empeoraron"}`
  }
  let idx = 0
  return (
    <ScrollArea horizontal className="perio max-w-full">
      {/* biome-ignore lint/a11y/useSemanticElements: un SVG no puede ser un fieldset; el grupo nombra el mapa. */}
      <svg role="group" aria-label="Mapa de cambios por pieza" width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block max-w-none">
        {rows.map((row, r) => {
          const y0 = 4 + r * 70
          return (
            <g key={row[0]}>
              {row.map((tooth, c) => {
                const x0 = 4 + c * MAP_W
                const i = idx++
                const present = expected.has(tooth)
                // Por fuera hacia el borde de la boca: arriba en el maxilar, abajo en la mandíbula.
                const faceRows: Array<"out" | "in"> = isUpper(tooth) ? ["out", "in"] : ["in", "out"]
                const numberY = isUpper(tooth) ? y0 + 58 : y0 + 10
                const squaresY = isUpper(tooth) ? y0 : y0 + 16
                return (
                  <g key={tooth}>
                    <rect className={cn("colhl", selected === tooth && "sel")} x={x0} y={y0 - 2} width={MAP_W - 2} height={64} rx={6} />
                    <text className={cn("tn", !present && "dim")} x={x0 + MAP_W / 2 - 1} y={numberY} textAnchor="middle">
                      {tooth}
                    </text>
                    {present
                      ? faceRows.map((face, fr) =>
                          displaySites(tooth, face).map((site, k) => {
                            const kind = implants.has(tooth) ? "implant" : change(tooth, site)
                            return (
                              <rect
                                key={`${face}-${site}`}
                                className={kind === "none" ? "site-empty" : `chg-${kind}`}
                                x={x0 + 2 + k * 9.5}
                                y={squaresY + fr * 19}
                                width={8}
                                height={16}
                                rx={2}
                              />
                            )
                          }),
                        )
                      : null}
                    {/* biome-ignore lint/a11y/useSemanticElements: la zona es la pieza en el dibujo; en un SVG no hay botón nativo. */}
                    <rect
                      ref={(node) => {
                        refs.current[i] = node
                      }}
                      className="hit"
                      x={x0}
                      y={y0 - 2}
                      width={MAP_W - 2}
                      height={64}
                      tabIndex={present ? 0 : -1}
                      role="button"
                      aria-pressed={selected === tooth}
                      aria-label={words(tooth)}
                      onClick={() => present && onSelect(tooth)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault()
                          if (present) onSelect(tooth)
                        } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                          const step = event.key === "ArrowRight" ? 1 : -1
                          for (let j = i + step; j >= 0 && j < refs.current.length; j += step) {
                            const next = refs.current[j]
                            if (next && next.tabIndex === 0) {
                              event.preventDefault()
                              next.focus()
                              break
                            }
                          }
                        }
                      }}
                    />
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
    </ScrollArea>
  )
}

export function PeriodontalCompare({
  patientId,
  visits,
  before,
  after,
  onPick,
  onBack,
  onToothHistory,
}: {
  patientId: string
  visits: PeriodontalChartListItem[]
  before: string
  after: string
  onPick: (before: string, after: string) => void
  onBack: () => void
  onToothHistory?: (tooth: number) => void
}) {
  const comparison = useQuery({
    queryKey: periodontalKeys.compare(patientId, before, after),
    queryFn: () => fetchPeriodontalComparison(patientId, before, after),
  })
  const beforeChart = useQuery({ queryKey: periodontalKeys.chart(patientId, before), queryFn: () => fetchPeriodontalChart(patientId, before) })
  const afterChart = useQuery({ queryKey: periodontalKeys.chart(patientId, after), queryFn: () => fetchPeriodontalChart(patientId, after) })
  const [selected, setSelected] = useState<number | null>(null)
  const labelOf = (id: string) => {
    const i = visits.findIndex((visit) => visit.id === id)
    return i < 0 ? "" : `${visitName(i)} · ${visitDay(visits[i]!.date)}`
  }
  const maps = useMemo(() => {
    if (!beforeChart.data || !afterChart.data) return null
    return {
      before: new Map(beforeChart.data.data.teeth.map((t) => [t.toothNumber, t])),
      after: new Map(afterChart.data.data.teeth.map((t) => [t.toothNumber, t])),
    }
  }, [beforeChart.data, afterChart.data])

  const picker = (value: string, onChange: (id: string) => void, label: string, exclude: string) => (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Select
        items={Object.fromEntries(visits.filter((visit) => visit.id !== exclude).map((visit) => [visit.id, labelOf(visit.id)]))}
        value={value}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next)
        }}
      >
        <SelectTrigger className="w-56" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {visits
            .filter((visit) => visit.id !== exclude)
            .map((visit) => (
              <SelectItem key={visit.id} value={visit.id}>
                {labelOf(visit.id)}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  )

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Button type="button" size="sm" variant="ghost" onClick={onBack}>
        <ArrowLeft aria-hidden="true" />
        Todos los periodontogramas
      </Button>
      {visits.length > 2 ? (
        <div className="flex flex-wrap gap-3">
          {picker(before, (id) => onPick(id, after), "Antes", after)}
          {picker(after, (id) => onPick(before, id), "Después", before)}
        </div>
      ) : null}
    </div>
  )
  if (comparison.isPending || beforeChart.isPending || afterChart.isPending || !maps) {
    return (
      <section aria-label="Comparar dos visitas" className="flex flex-col gap-4">
        {header}
        <LoadingState message="Comparando las dos visitas…" />
      </section>
    )
  }
  const failed = comparison.error ?? beforeChart.error ?? afterChart.error
  if (failed || !comparison.data) {
    return (
      <section aria-label="Comparar dos visitas" className="flex flex-col gap-4">
        {header}
        <QueryErrorState
          error={failed}
          onRetry={() => {
            void comparison.refetch()
            void beforeChart.refetch()
            void afterChart.refetch()
          }}
        />
      </section>
    )
  }
  const result = comparison.data.data
  const afterView = afterChart.data!.data
  const beforeView = beforeChart.data!.data
  const status = afterView.classification?.status ?? afterView.proposal.status
  const worse = result.worsened
  const tooth = selected ?? worse[0]?.toothNumber ?? result.improved[0]?.toothNumber ?? afterView.expectedTeeth[0] ?? null
  const siteText = (change: (typeof worse)[number]) => `${change.toothNumber}, ${PERIODONTAL_SITE_WORDS[siteIndex(change.site)]}`
  const stillBleeds = (change: (typeof worse)[number]) => maps.after.get(change.toothNumber)?.bleeding[siteIndex(change.site)] === true
  return (
    <section aria-label="Comparar dos visitas" className="flex min-w-0 flex-col gap-4">
      {header}
      <ScrollArea horizontal className="max-w-full rounded-xl border bg-card">
        <SummaryTable before={result.before.summary} after={result.after.summary} beforeLabel={labelOf(before)} afterLabel={labelOf(after)} />
      </ScrollArea>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-3">
          <p className="text-sm text-muted-foreground">
            {result.compared} sitios medidos en las dos visitas: {result.improved.length}{" "}
            {result.improved.length === 1 ? "mejoró" : "mejoraron"} y {worse.length} {worse.length === 1 ? "empeoró" : "empeoraron"} {SITE_CHANGE_THRESHOLD_MM} mm o más. Toca una pieza para ver su antes y después.
          </p>
          <ChangeMap
            before={maps.before}
            after={maps.after}
            implants={new Set(afterView.implantTeeth)}
            expected={new Set(afterView.expectedTeeth)}
            selected={tooth}
            onSelect={setSelected}
          />
          <div className="perio flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              <span aria-hidden="true" className="legend-swatch bg-success" />
              Mejoró {SITE_CHANGE_THRESHOLD_MM} mm o más
            </span>
            <span>
              <span aria-hidden="true" className="legend-swatch bg-danger" />
              Empeoró {SITE_CHANGE_THRESHOLD_MM} mm o más
            </span>
            <span>
              <span aria-hidden="true" className="legend-swatch border bg-muted" />
              Igual
            </span>
            <span>
              <span aria-hidden="true" className="legend-swatch" style={{ background: "var(--perio-grid)" }} />
              Implante
            </span>
          </div>
          {worse.length > 0 ? (
            <div role="status" className="flex flex-col gap-1 rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning">
              <strong>
                {worse.length === 1 ? `Un sitio empeoró: ${siteText(worse[0]!)}` : `${worse.length} sitios empeoraron`}
                {status ? ` · Está ${PERIODONTITIS_STATUS_WORDS[status]}` : ""}
              </strong>
              <span>
                {worse
                  .slice(0, 3)
                  .map((change) => `${worse.length === 1 ? "Pasó" : siteText(change)}: de ${change.before} a ${change.after} mm${stillBleeds(change) ? " y sangra" : ""}`)
                  .join(". ")}
                {worse.length > 3 ? `. Y ${worse.length - 3} más.` : "."}
              </span>
            </div>
          ) : (
            <p role="status" className="rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
              Ningún sitio empeoró {SITE_CHANGE_THRESHOLD_MM} mm o más.
            </p>
          )}
        </div>
        <aside className="flex flex-col gap-3 rounded-xl border bg-card p-4">
          {tooth !== null ? (
            <>
              <PeriodontalToothDetail
                toothNumber={tooth}
                record={maps.after.get(tooth) ?? null}
                implant={afterView.implantTeeth.includes(tooth)}
                present={afterView.expectedTeeth.includes(tooth)}
                before={maps.before.get(tooth) ?? null}
                onToothHistory={onToothHistory}
              />
              {afterView.expectedTeeth.includes(tooth) ? (
                <PeriodontalChart
                  teeth={afterView.teeth.filter((t) => t.toothNumber === tooth)}
                  expectedTeeth={[tooth]}
                  implantTeeth={afterView.implantTeeth}
                  ghost={beforeView.teeth.filter((t) => t.toothNumber === tooth)}
                  ghostLabel={labelOf(before)}
                  arches={[{ teeth: [tooth], top: isUpper(tooth) ? "out" : "in", bottom: isUpper(tooth) ? "in" : "out", gap: 0 }]}
                  label={`Pieza ${tooth}: antes punteado y después`}
                />
              ) : null}
            </>
          ) : null}
        </aside>
      </div>
    </section>
  )
}
