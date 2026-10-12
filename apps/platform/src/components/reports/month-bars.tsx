import { Button, cn, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@odentia/ui"
import { useId, useState } from "react"
import { monthLabel, monthName, type YearMonth } from "../../lib/commissions"

export interface MonthBarSeries {
  key: string
  label: string
  tone: "primary" | "muted"
  values: number[]
  /** El valor escrito entero, para la tabla y el nombre accesible. */
  display: (value: number) => string
}

const TONE = { primary: "bg-primary", muted: "bg-muted-foreground/45" }
const BAR_HEIGHT = 160

/**
 * La misma cifra mes a mes, cuando el periodo abarca varios. Las barras son un
 * apoyo visual: «Ver como tabla» da los mismos datos escritos.
 */
export function MonthBars({
  title,
  note,
  months,
  series,
  locale,
  compact,
}: {
  title: string
  note?: string
  months: Array<YearMonth & { partial: boolean }>
  series: MonthBarSeries[]
  locale: string
  /** El valor abreviado que va sobre la primera barra de cada mes. */
  compact: (value: number) => string
}) {
  const id = useId()
  const [asTable, setAsTable] = useState(false)
  const max = Math.max(1, ...series.flatMap((item) => item.values.map((value) => Math.max(0, value))))
  const height = (value: number): number => Math.round((Math.max(0, value) / max) * BAR_HEIGHT)
  const monthShort = (month: YearMonth & { partial: boolean }): string =>
    `${monthName(month.month, locale, "short").toLocaleLowerCase(locale)}${month.partial ? ", hasta hoy" : ""}`
  const summary = series
    .map((item) => `${item.label}: ${months.map((month, index) => `${monthName(month.month, locale)} ${item.display(item.values[index] ?? 0)}`).join(", ")}`)
    .join(". ")

  return (
    <section aria-labelledby={id} className="elevated flex min-w-0 flex-col gap-3.5 rounded-xl border bg-card p-5">
      <div className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1 basis-48">
          <h3 id={id} className="font-semibold">
            {title}
          </h3>
          {note ? <p className="text-[13px] text-muted-foreground">{note}</p> : null}
        </div>
        {series.length > 1
          ? series.map((item) => (
              <span key={item.key} className="flex items-center gap-1.5 text-[13px]">
                <span aria-hidden className={cn("size-2.5 rounded-[3px]", TONE[item.tone])} />
                {item.label}
              </span>
            ))
          : null}
      </div>

      {asTable ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Mes</TableHead>
              {series.map((item) => (
                <TableHead key={item.key} scope="col" className="text-right">
                  {item.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {months.map((month, index) => (
              <TableRow key={`${month.year}-${month.month}`}>
                <TableCell>
                  {monthLabel(month, locale)}
                  {month.partial ? ", hasta hoy" : ""}
                </TableCell>
                {series.map((item) => (
                  <TableCell key={item.key} className="text-right tabular-nums">
                    {item.display(item.values[index] ?? 0)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <div role="img" aria-label={summary} className="flex min-w-fit items-end gap-3 border-b border-border" style={{ height: BAR_HEIGHT + 24 }}>
            {months.map((month, index) => (
              <div key={`${month.year}-${month.month}`} className="flex min-w-9 flex-1 flex-col items-center gap-1">
                <span className="text-xs font-semibold tabular-nums">{compact(series[0]?.values[index] ?? 0)}</span>
                <div className="flex items-end gap-0.5">
                  {series.map((item) => (
                    <div key={item.key} className={cn("w-[18px] rounded-t", TONE[item.tone])} style={{ height: height(item.values[index] ?? 0) }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div aria-hidden className="flex min-w-fit gap-3 pt-1.5 text-xs text-muted-foreground">
            {months.map((month) => (
              <span key={`${month.year}-${month.month}`} className="min-w-9 flex-1 text-center">
                {monthShort(month)}
              </span>
            ))}
          </div>
        </div>
      )}

      <Button type="button" variant="link" className="h-auto min-h-11 self-end p-0 sm:min-h-8" aria-pressed={asTable} onClick={() => setAsTable((value) => !value)}>
        {asTable ? "Ver como barras" : "Ver como tabla"}
      </Button>
    </section>
  )
}
