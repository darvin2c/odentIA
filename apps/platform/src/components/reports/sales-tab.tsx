/**
 * Reportes › Pacientes y ventas: el trabajo nuevo que entró (pacientes,
 * presupuestos, oportunidades) y el que se hizo (tratamientos realizados).
 */
import { formatMoney } from "@odentia/clinical"
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@odentia/ui"
import { EmptyState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { type ReactNode, useState } from "react"
import { plainAmount } from "../../lib/commissions"
import { CLOSE_REASON_LABEL, type CloseReason } from "../../lib/crm"
import { QueryErrorState } from "../../lib/query-error"
import {
  absoluteChange,
  type BudgetTotals,
  fetchReport,
  POINTS,
  previousPhrase,
  rateOf,
  relativeChange,
  reportKey,
  type ReportListKey,
  type ReportQuery,
  type ReportSales,
  spanLabel,
} from "../../lib/reports"
import { MonthBars } from "./month-bars"
import { BarRows, EmptyLine, Figure, ReportCard, unlessEmpty, WHOLE_CLINIC } from "./report-parts"

/** Tratamientos a la vista antes de agrupar el resto. */
const TOP_PROCEDURES = 5

function budgetCount(rows: BudgetTotals[], group?: "accepted" | "waiting" | "rejected"): number {
  return rows.reduce((sum, row) => sum + (group ? row[group].count : row.accepted.count + row.waiting.count + row.rejected.count), 0)
}

export function SalesTab({ query, onOpenList, advice }: { query: ReportQuery; onOpenList: (list: ReportListKey) => void; advice?: ReactNode }) {
  const navigate = useNavigate()
  const [allProcedures, setAllProcedures] = useState(false)
  const report = useQuery({ queryKey: reportKey("sales", query), queryFn: () => fetchReport<ReportSales>("sales", query), retry: false })

  if (report.isPending) return <LoadingState />
  if (report.isError)
    return <QueryErrorState error={report.error} onRetry={() => void report.refetch()} notFound="La sede elegida ya no está disponible. Elige otra sede." />

  const data = report.data.data
  const locale = data.locale
  const period = spanLabel(data.period, locale)
  const phrase = previousPhrase(data, locale)

  const presented = budgetCount(data.budgets)
  const accepted = budgetCount(data.budgets, "accepted")
  const acceptedRate = rateOf(accepted, presented)
  const previousRate = rateOf(budgetCount(data.previousBudgets, "accepted"), budgetCount(data.previousBudgets))
  // Los importes se leen en la moneda de la clínica; las demás van en su propia tarjeta.
  const mainBudget = data.budgets.find((row) => row.currency === data.currency) ?? data.budgets[0] ?? null
  const previousMain = mainBudget ? (data.previousBudgets.find((row) => row.currency === mainBudget.currency) ?? null) : null
  const procedureCount = data.procedures.reduce((sum, row) => sum + row.count, 0)
  const opportunities = data.opportunities.reduce((sum, row) => sum + row.count, 0)
  const opportunity = (status: string): number => data.opportunities.find((row) => row.status === status)?.count ?? 0

  if (data.newPatients === 0 && presented === 0 && procedureCount === 0 && opportunities === 0) {
    return (
      <EmptyState
        title={`Sin pacientes nuevos ni ventas en ${period}`}
        description="No se atendió a nadie por primera vez, no se presentó ningún presupuesto y no se cerró ninguna atención."
        actionLabel="Ir a Pacientes"
        onAction={() => void navigate({ to: "/people" })}
      />
    )
  }

  // Una tabla por moneda: nunca se suman importes de monedas distintas.
  const procedureCurrencies = [...new Set(data.procedures.map((row) => row.currency))].sort(
    (a, b) => Number(b === data.currency) - Number(a === data.currency) || String(a).localeCompare(String(b)),
  )

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {data.newPatients > 0 ? (
        <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0 sm:min-h-8" onClick={() => onOpenList("new_patients")}>
          {data.newPatients === 1 ? "Ver el paciente nuevo" : `Ver los ${data.newPatients} pacientes nuevos`}
        </Button>
      ) : null}

      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <Figure
          title="Presupuestos aceptados"
          value={acceptedRate === null ? "Sin datos" : `${acceptedRate} %`}
          detail={acceptedRate === null ? undefined : `· ${accepted} de ${presented}`}
          change={acceptedRate === null ? undefined : absoluteChange(acceptedRate, previousRate, phrase, locale, POINTS)}
          better="up"
          note={acceptedRate === null ? `No se presentó ningún presupuesto en ${period}.` : undefined}
        />
        <Figure
          title="Valor de lo aceptado"
          value={mainBudget ? formatMoney(mainBudget.accepted.cents, mainBudget.currency, locale) : "Sin datos"}
          change={mainBudget ? relativeChange(mainBudget.accepted.cents, previousMain?.accepted.cents, phrase, locale) : undefined}
          better="up"
        />
        <Figure title="Tratamientos realizados" value={procedureCount} change={unlessEmpty(procedureCount, relativeChange(procedureCount, data.previousProcedureCount, phrase, locale))} better="up" />
      </div>

      {advice}

      {data.series.length > 1 ? (
        <MonthBars
          title="Pacientes nuevos por mes"
          months={data.series}
          locale={locale}
          compact={String}
          series={[{ key: "new", label: "Pacientes nuevos", tone: "primary", display: String, values: data.series.map((row) => row.newPatients) }]}
        />
      ) : null}

      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          {data.budgets.length === 0 ? (
            <ReportCard title={`Presupuestos presentados en ${period}`}>
              <EmptyLine>No se presentó ningún presupuesto en este periodo.</EmptyLine>
            </ReportCard>
          ) : (
            data.budgets.map((row) => {
              const total = row.accepted.count + row.waiting.count + row.rejected.count
              const amount = (cents: number): string => plainAmount(cents, row.currency, locale)
              return (
                <ReportCard
                  key={row.currency}
                  title={`Presupuestos presentados en ${period}${data.budgets.length > 1 ? ` · ${row.currency}` : ""}`}
                  note={data.wholeClinic.includes("budgets") ? WHOLE_CLINIC : undefined}
                >
                  <BarRows
                    rows={[
                      { key: "accepted", label: `Aceptados · ${row.accepted.count}`, value: amount(row.accepted.cents), share: rateOf(row.accepted.count, total) ?? 0 },
                      {
                        key: "waiting",
                        label: `Esperan respuesta · ${row.waiting.count}`,
                        value: amount(row.waiting.cents),
                        share: rateOf(row.waiting.count, total) ?? 0,
                        tone: "attention",
                        action:
                          row.waiting.count > 0 ? (
                            <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0 sm:min-h-8" onClick={() => onOpenList("budgets_waiting")}>
                              Ver cuáles
                            </Button>
                          ) : undefined,
                      },
                      { key: "rejected", label: `Rechazados · ${row.rejected.count}`, value: amount(row.rejected.cents), share: rateOf(row.rejected.count, total) ?? 0, tone: "muted" },
                    ]}
                  />
                  <div className="flex items-baseline gap-3 border-t pt-2.5 text-sm font-bold">
                    <span className="flex-1">Total · {total}</span>
                    <span className="tabular-nums">{amount(row.accepted.cents + row.waiting.cents + row.rejected.cents)}</span>
                  </div>
                  <p className="text-[13px] text-muted-foreground">Según su respuesta a hoy. Uno aceptado en parte cuenta por lo aceptado.</p>
                </ReportCard>
              )
            })
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {procedureCurrencies.length === 0 ? (
            <ReportCard title="Tratamientos más realizados">
              <EmptyLine>No se cerró ninguna atención con tratamientos en este periodo.</EmptyLine>
            </ReportCard>
          ) : (
            procedureCurrencies.map((currency) => {
              const rows = data.procedures.filter((row) => row.currency === currency)
              const visible = allProcedures ? rows : rows.slice(0, TOP_PROCEDURES)
              const rest = rows.slice(TOP_PROCEDURES)
              const amount = (cents: number): string => (currency ? plainAmount(cents, currency, locale) : "Sin precio")
              return (
                <ReportCard key={currency ?? "sin-precio"} title={`Tratamientos más realizados${procedureCurrencies.length > 1 ? ` · ${currency ?? "sin precio"}` : ""}`}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">Tratamiento</TableHead>
                        <TableHead scope="col" className="text-right">
                          Veces
                        </TableHead>
                        <TableHead scope="col" className="text-right">
                          Valor
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visible.map((row) => (
                        <TableRow key={row.name}>
                          <TableCell>{row.name}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.count}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">{amount(row.cents)}</TableCell>
                        </TableRow>
                      ))}
                      {!allProcedures && rest.length > 0 ? (
                        <TableRow>
                          <TableCell>
                            <Button type="button" variant="link" className="h-auto min-h-11 p-0 sm:min-h-8" onClick={() => setAllProcedures(true)}>
                              {rest.length === 1 ? "Otro tratamiento" : `Otros ${rest.length} tratamientos`}
                            </Button>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{rest.reduce((sum, row) => sum + row.count, 0)}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">{amount(rest.reduce((sum, row) => sum + row.cents, 0))}</TableCell>
                        </TableRow>
                      ) : null}
                      <TableRow>
                        <TableCell className="font-bold">Total</TableCell>
                        <TableCell className="text-right font-bold tabular-nums">{rows.reduce((sum, row) => sum + row.count, 0)}</TableCell>
                        <TableCell className="text-right font-bold tabular-nums">{amount(rows.reduce((sum, row) => sum + row.cents, 0))}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                  <p className="text-[13px] text-muted-foreground">A su precio. Es lo trabajado, no lo cobrado.</p>
                </ReportCard>
              )
            })
          )}
        </div>
      </div>

      {opportunities > 0 ? (
        <ReportCard title="Oportunidades" note={data.wholeClinic.includes("opportunities") ? WHOLE_CLINIC : undefined}>
          <p className="text-sm text-muted-foreground">
            De {opportunities === 1 ? "la que se abrió" : `las ${opportunities} que se abrieron`} en {period}
          </p>
          <div className="grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-semibold text-muted-foreground">Ganadas</span>
              <span className="text-[22px] leading-7 font-bold tabular-nums">
                {opportunity("won")}
                <span className="text-sm font-semibold text-muted-foreground"> · {rateOf(opportunity("won"), opportunities)} %</span>
              </span>
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-semibold text-muted-foreground">Perdidas</span>
              <span className="text-[22px] leading-7 font-bold tabular-nums">{opportunity("lost")}</span>
              {data.lostReasons && data.lostReasons.length > 0 ? (
                <span className="text-[13px] text-muted-foreground">
                  Por qué: {data.lostReasons.map((row) => `${CLOSE_REASON_LABEL[row.reason as CloseReason] ?? "Otro"} ${row.count}`).join(" · ")}
                </span>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-semibold text-muted-foreground">Siguen abiertas</span>
              <span className="text-[22px] leading-7 font-bold tabular-nums">{opportunity("open")}</span>
            </div>
          </div>
          <Link to="/pipeline" className="inline-flex min-h-11 items-center self-start text-sm font-semibold text-primary underline sm:min-h-8">
            Ver oportunidades
          </Link>
        </ReportCard>
      ) : null}
    </div>
  )
}
