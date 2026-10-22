import { ColumnChart, type SeriesTone } from "@odentia/ui-patterns"
import { useId } from "react"
import { monthLabel, monthName, type YearMonth } from "../../lib/commissions"

export interface MonthBarSeries {
  key: string
  label: string
  tone: "primary" | "muted"
  values: number[]
  /** El valor escrito entero, para la tabla, el detalle y el nombre accesible. */
  display: (value: number) => string
}

const TONE: Record<MonthBarSeries["tone"], SeriesTone> = { primary: "series-1", muted: "muted" }

/**
 * La misma cifra mes a mes, cuando el periodo abarca varios: columnas con su
 * eje, el detalle de cada mes al pasar el mouse o con las flechas y «Ver como
 * tabla» con los mismos datos escritos. El mes en curso va rayado.
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
  /** El valor abreviado del eje. */
  compact: (value: number) => string
}) {
  const id = useId()
  const display = series[0]?.display ?? String
  return (
    <section aria-labelledby={id} className="elevated flex min-w-0 flex-col gap-3.5 rounded-xl border bg-card p-5">
      <div className="min-w-0">
        <h3 id={id} className="font-semibold">
          {title}
        </h3>
        {note ? <p className="text-[13px] text-muted-foreground">{note}</p> : null}
      </div>
      <ColumnChart
        title={title}
        categories={months.map((month) => ({
          key: `${month.year}-${month.month}`,
          label: monthLabel(month, locale),
          short: monthName(month.month, locale, "short").toLocaleLowerCase(locale),
          partial: month.partial,
        }))}
        bars={series.map((item) => ({ key: item.key, label: item.label, tone: TONE[item.tone], values: item.values }))}
        format={display}
        axis={compact}
      />
    </section>
  )
}
