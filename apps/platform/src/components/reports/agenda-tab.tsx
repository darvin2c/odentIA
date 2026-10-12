/**
 * Reportes › Agenda: si los pacientes vinieron y quién los atendió. Cada cita
 * del periodo cae en un solo grupo, así los porcentajes suman el total.
 */
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@odentia/ui"
import { EmptyState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { QueryErrorState } from "../../lib/query-error"
import {
  absoluteChange,
  fetchReport,
  POINTS,
  previousPhrase,
  rateOf,
  relativeChange,
  reportKey,
  type ReportAgenda,
  type ReportListKey,
  type ReportQuery,
  spanLabel,
} from "../../lib/reports"
import { MonthBars } from "./month-bars"
import { type BarRow, BarRows, type Better, ChangeLine, ReportCard, StackDot, StackedBar, type StackPart, WHOLE_CLINIC } from "./report-parts"

/** Quién creó la cita. `agent` y `agente` son el mismo origen escrito de dos formas. */
const SOURCE_LABELS: Record<string, string> = {
  recepcion: "Recepción",
  manual: "Recepción",
  agente: "El agente",
  agent: "El agente",
  enlace: "Enlace de reserva",
  portal: "Portal del paciente",
  web: "Sitio web",
  conversacion: "Desde una conversación",
}

function ListLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0 sm:min-h-8" onClick={onClick}>
      {label}
    </Button>
  )
}

export function AgendaTab({ query, onOpenList, advice }: { query: ReportQuery; onOpenList: (list: ReportListKey) => void; advice?: ReactNode }) {
  const navigate = useNavigate()
  const report = useQuery({ queryKey: reportKey("agenda", query), queryFn: () => fetchReport<ReportAgenda>("agenda", query), retry: false })

  if (report.isPending) return <LoadingState />
  if (report.isError)
    return <QueryErrorState error={report.error} onRetry={() => void report.refetch()} notFound="La sede elegida ya no está disponible. Elige otra sede." />

  const data = report.data.data
  const locale = data.locale
  const period = spanLabel(data.period, locale)
  const phrase = previousPhrase(data, locale)
  const { appointments: now, previousAppointments: before, controls } = data

  if (now.total === 0 && controls.due === 0) {
    return (
      <EmptyState
        title={`Sin citas en ${period}`}
        description={data.branch ? `No hubo citas en ${data.branch.name} en este periodo.` : "No hubo citas en este periodo."}
        actionLabel="Ir a la Agenda"
        onAction={() => void navigate({ to: "/agenda" })}
      />
    )
  }

  /** Un grupo de citas: su parte del total y cómo cambió esa parte en puntos. */
  const share = (count: number, previousCount: number) => ({
    percent: rateOf(count, now.total),
    change: before.total > 0 && now.total > 0 ? absoluteChange(rateOf(count, now.total) ?? 0, rateOf(previousCount, before.total), phrase, locale, POINTS) : null,
  })
  const groups: Array<StackPart & { percent: number | null; change: ReturnType<typeof share>["change"]; better: Better; list?: ReportListKey; listLabel?: string }> = [
    { key: "attended", label: "Atendidas", count: now.attended, tone: "primary", percent: rateOf(now.attended, now.total), change: relativeChange(now.attended, before.attended, phrase, locale), better: "up" },
    { key: "noShow", label: "No asistieron", count: now.noShow, tone: "attention", ...share(now.noShow, before.noShow), better: "down", list: "no_show", listLabel: "Ver quiénes" },
    { key: "cancelled", label: "Cancelaron", count: now.cancelled, tone: "muted", ...share(now.cancelled, before.cancelled), better: "down", list: "cancelled", listLabel: "Ver cuáles" },
  ]
  if (now.unmarked > 0)
    groups.push({ key: "unmarked", label: "Sin marcar", count: now.unmarked, tone: "outline", percent: rateOf(now.unmarked, now.total), change: null, better: "none", list: "unmarked", listLabel: "Ver cuáles" })

  const sources = new Map<string, number>()
  for (const row of data.bySource) {
    const label = SOURCE_LABELS[row.source] ?? row.source
    sources.set(label, (sources.get(label) ?? 0) + row.count)
  }
  const sourceRows: BarRow[] = [...sources.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ key: label, label, value: String(count), share: rateOf(count, now.total) ?? 0, percent: rateOf(count, now.total) }))

  const cameRate = rateOf(controls.came, controls.due)
  const previousCameRate = rateOf(data.previousControls.came, data.previousControls.due)

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {now.total > 0 ? (
        <ReportCard title={`De ${now.total} ${now.total === 1 ? "cita" : "citas"} de ${period}`}>
          <StackedBar parts={groups} />
          <div className="grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(0,1fr))]">
            {groups.map((group) => (
              <div key={group.key} className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground">
                  <StackDot tone={group.tone} />
                  {group.label}
                </span>
                <span className="text-[22px] leading-7 font-bold tabular-nums">
                  {group.count}
                  {group.percent !== null ? <span className="text-sm font-semibold text-muted-foreground"> · {group.percent} %</span> : null}
                </span>
                {group.key === "unmarked" ? (
                  <span className="text-[13px] text-muted-foreground">Ya pasaron y nadie las marcó</span>
                ) : (
                  <ChangeLine change={group.change} better={group.better} />
                )}
                {group.list && group.count > 0 ? <ListLink label={group.listLabel ?? "Ver"} onClick={() => onOpenList(group.list as ReportListKey)} /> : null}
              </div>
            ))}
          </div>
          {advice}
        </ReportCard>
      ) : (
        advice
      )}

      {data.series.length > 1 ? (
        <MonthBars
          title="Citas atendidas por mes"
          months={data.series}
          locale={locale}
          compact={String}
          series={[{ key: "attended", label: "Atendidas", tone: "primary", display: String, values: data.series.map((row) => row.attended) }]}
        />
      ) : null}

      {now.total > 0 ? (
        <div className="grid min-w-0 items-start gap-4 lg:grid-cols-5">
          <ReportCard title="Por profesional" className="lg:col-span-3">
            {/* En teléfono, una fila por profesional: la tabla no cabe sin desbordar. */}
            <ul className="flex min-w-0 flex-col gap-1.5 sm:hidden">
              {data.byProfessional.map((row) => (
                <li key={row.userId} className="flex min-w-0 items-baseline gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  <span className="shrink-0 font-semibold tabular-nums">
                    {row.attended} {row.attended === 1 ? "atendida" : "atendidas"}
                  </span>
                  <span className="shrink-0 text-[13px] text-muted-foreground tabular-nums">{rateOf(row.noShow, row.total) ?? 0} % no asistió</span>
                </li>
              ))}
            </ul>
            <div className="hidden sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Profesional</TableHead>
                  <TableHead scope="col" className="text-right">
                    Citas
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Atendidas
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    No asistieron
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byProfessional.map((row) => (
                  <TableRow key={row.userId}>
                    <TableCell>{row.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.total}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{row.attended}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.noShow}
                      {rateOf(row.noShow, row.total) !== null ? ` · ${rateOf(row.noShow, row.total)} %` : ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          </ReportCard>
          <ReportCard title="Cómo se reservaron" className="lg:col-span-2">
            <BarRows rows={sourceRows} />
            <p className="text-[13px] text-muted-foreground">
              Quién creó {now.total === 1 ? "la cita" : `cada una de las ${now.total} citas`}.
            </p>
          </ReportCard>
        </div>
      ) : null}

      {controls.due > 0 ? (
        <ReportCard title="Controles" note={data.wholeClinic.includes("controls") ? WHOLE_CLINIC : undefined}>
          <p className="text-sm text-muted-foreground">
            De {controls.due} {controls.due === 1 ? "control que tocaba" : "controles que tocaban"} en {period}
          </p>
          <div className="grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-semibold text-muted-foreground">Vinieron</span>
              <span className="text-[22px] leading-7 font-bold tabular-nums">
                {controls.came}
                {cameRate !== null ? <span className="text-sm font-semibold text-muted-foreground"> · {cameRate} %</span> : null}
              </span>
              <ChangeLine change={cameRate !== null ? absoluteChange(cameRate, previousCameRate, phrase, locale, POINTS) : null} better="up" />
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-semibold text-muted-foreground">Siguen pendientes</span>
              <span className="text-[22px] leading-7 font-bold tabular-nums">{controls.pending}</span>
              {controls.pending > 0 ? <ListLink label="Ver quiénes" onClick={() => onOpenList("controls_pending")} /> : null}
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-semibold text-muted-foreground">Se cancelaron</span>
              <span className="text-[22px] leading-7 font-bold tabular-nums">{controls.cancelled}</span>
            </div>
          </div>
          {controls.unknown > 0 ? (
            <p className="text-[13px] text-muted-foreground">
              {controls.unknown} {controls.unknown === 1 ? "figura como realizado" : "figuran como realizados"} sin una atención cerrada que lo respalde: no {controls.unknown === 1 ? "cuenta" : "cuentan"} como venidos.
            </p>
          ) : null}
        </ReportCard>
      ) : null}
    </div>
  )
}
