/**
 * El gráfico de una respuesta fijada de las 32 cifras (ADR 0070): las que ya
 * estaban en el Resumen se siguen mostrando. Preguntar es del Argos de las
 * vistas (`components/argos/argos-panel.tsx`, ADR 0073).
 */
import { formatMoney } from "@odentia/clinical"
import { BarList, ColumnChart } from "@odentia/ui-patterns"
import type { FigureUnit, ReportAnswer } from "../../lib/reports-ask"

function formatFigureValue(value: number, unit: FigureUnit, currency: string, locale: string): string {
  if (unit === "money") return formatMoney(Math.round(value), currency, locale)
  if (unit === "rate") return `${value} %`
  if (unit === "minutes") return `${Math.round(value)} min`
  if (unit === "hours") return `${Math.round(value / 60)} h`
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
}

/** El gráfico de una respuesta: barras por grupo o los 12 meses; los dos con «Ver como tabla». */
export function AnswerChart({ answer, compact = false }: { answer: ReportAnswer; compact?: boolean }) {
  const chart = answer.chart
  if (!chart) return null
  const format = (value: number) => formatFigureValue(value, answer.unit, answer.currency, answer.locale)
  if (chart.kind === "bars") {
    return (
      <BarList
        title={answer.title}
        size="sm"
        rows={chart.rows.map((row) => ({
          key: row.key,
          label: row.label,
          value: row.value,
          ...(row.part !== undefined ? { part: row.part } : {}),
          valueText: row.valueText,
          ...(row.note ? { note: row.note } : {}),
        }))}
        {...(chart.legend ? { legend: chart.legend } : {})}
        table={{ label: "Grupo", value: "Cifra", ...(chart.rows.some((row) => row.note) ? { note: "Detalle" } : {}) }}
      />
    )
  }
  return (
    <ColumnChart
      title={`${answer.title}, últimos 12 meses`}
      height={compact ? 120 : 150}
      categories={chart.points.map((point) => ({ key: point.key, label: point.label, short: point.short, partial: point.partial }))}
      bars={[{ key: answer.query.figure, label: answer.title, tone: "series-1", values: chart.points.map((point) => point.value) }]}
      format={format}
    />
  )
}
