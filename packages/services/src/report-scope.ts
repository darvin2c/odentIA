/**
 * Lo común a todas las consultas de Reportes: el periodo y la sede que se
 * piden, la región de la clínica, lo que cada respuesta dice de sí misma y
 * cómo se calcula una cifra para varios tramos en una sola consulta.
 *
 * Una cifra se define una vez como consulta por tramos (`spansSql`): el
 * periodo, el anterior y los 12 meses de su línea pequeña salen de la misma
 * definición, en una sola ida a la base.
 */
import type { Db } from "@odentia/db"
import { requireBranch } from "./finance.js"
import { getOrgLocale } from "./locale.js"
import { type ReportBucket, reportBuckets, type ReportSpan, type ReportWindow, resolveReportWindow } from "./report-periods.js"

export interface ReportQuery {
  /** `este_mes`, `mes_pasado`, `ultimos_3_meses`, `este_ano`, `YYYY-MM` o `YYYY-MM-DD..YYYY-MM-DD`. */
  period: string
  branchId?: string
}

export interface ReportScope {
  window: ReportWindow
  timezone: string
  locale: string
  /** Moneda de la clínica: va primero cuando hay más de una. */
  currency: string
  branch: { id: string; name: string } | null
  now: Date
}

export async function reportScope(tx: Db, orgId: string, query: ReportQuery, now: Date): Promise<ReportScope> {
  const { timezone, locale, currency } = await getOrgLocale(tx, orgId)
  const window = resolveReportWindow(timezone, query.period, now)
  const branch = query.branchId ? await requireBranch(tx, orgId, query.branchId) : null
  return { window, timezone, locale, currency, branch: branch ? { id: branch.id, name: branch.name } : null, now }
}

export function serializeSpan(span: ReportSpan) {
  return {
    from: span.from,
    to: span.to,
    partial: span.partial,
    start: span.start.toISOString(),
    end: span.end.toISOString(),
    ...(span.days ? { days: span.days } : {}),
  }
}

/** Lo que toda respuesta de Reportes dice de sí misma: periodo, comparación, región y sede. */
export function reportHead(scope: ReportScope) {
  return {
    period: { key: scope.window.key, kind: scope.window.kind, grain: scope.window.grain, ...serializeSpan(scope.window) },
    previous: serializeSpan(scope.window.previous),
    timezone: scope.timezone,
    locale: scope.locale,
    currency: scope.currency,
    branch: scope.branch,
  }
}

/** Un tramo del gráfico como lo recibe la pantalla. */
export function serializeBucket(bucket: ReportBucket) {
  return { key: bucket.key, firstDay: bucket.firstDay, lastDay: bucket.lastDay, partial: bucket.partial }
}

/** Los tramos del gráfico del periodo (`reportBuckets`). */
export function scopeBuckets(scope: ReportScope): ReportBucket[] {
  return reportBuckets(scope.timezone, scope.window)
}

export { at, bySpan, hullOf, safeCents, type Span, spansSql } from "./report-spans.js"
