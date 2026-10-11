import { formatMoney } from "@odentia/clinical"
import { useQuery } from "@tanstack/react-query"
import { EmptyState } from "@odentia/ui-patterns"
import { ApiError } from "../../lib/api"
import { fetchMonthlyFinanceResult } from "../../lib/commissions"

/**
 * Resultado del mes (Fase 6). Extraíble: Reportes lo monta con año/mes (y
 * sede/moneda opcionales). Formatea con el locale que devuelve la API.
 */
export function MonthlyResultPanel({
  year,
  month,
  branchId,
  currency,
}: {
  year: number
  month: number
  branchId?: string
  currency?: string
}) {
  const query = useQuery({
    queryKey: ["monthly-finance-result", year, month, branchId, currency],
    queryFn: () => fetchMonthlyFinanceResult({ year, month, branchId, currency }),
    retry: false,
  })
  const result = query.data?.data ?? null
  if (query.isError && query.error instanceof ApiError && query.error.status === 403) {
    return (
      <EmptyState
        title="Sin acceso al resultado"
        description="Tu rol no tiene permiso para ver el resultado del mes."
      />
    )
  }
  if (query.isPending || !result) {
    return <p className="text-sm text-muted-foreground">Cargando el resultado del mes…</p>
  }
  if (query.isError) {
    return (
      <EmptyState
        title="No se pudo cargar"
        description="Revisa el mes pedido e inténtalo de nuevo."
      />
    )
  }
  const money = (cents: number, curr: string): string => formatMoney(cents, curr, result.locale)
  const monthLabel = new Intl.DateTimeFormat(result.locale, {
    year: "numeric",
    month: "long",
  }).format(new Date(Date.UTC(result.year, result.month - 1, 1)))
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        {monthLabel}
        {result.branchName ? ` · ${result.branchName}` : " · todas las sedes"} · zona{" "}
        {result.timezone}. Ya descontadas las devoluciones y anulaciones.
      </p>
      {result.byCurrency.length === 0 ? (
        <EmptyState
          title="Sin movimientos"
          description="No hubo cobros ni gastos en este mes."
        />
      ) : null}
      {result.byCurrency.map((bucket) => {
        const total = bucket.netoCents
        return (
          <section key={bucket.currency} className="flex min-w-0 flex-col gap-2">
            <h3 className="text-base font-semibold">
              Queda {money(bucket.quedaCents, bucket.currency)} · cobrado{" "}
              {money(bucket.cobradoCents, bucket.currency)} · gastado{" "}
              {money(bucket.gastadoCents, bucket.currency)}
            </h3>
            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
              <div className="rounded-md border bg-card px-4 py-3">
                <p className="text-sm font-medium">Cobrado por medio</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {bucket.byMethod.map((row) => (
                    <li key={row.key} className="flex justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate">
                        {row.label}
                        {row.cash ? "" : " · electrónico"}
                      </span>
                      <span className="tabular-nums">
                        {total > 0 ? `${Math.round((row.cents / total) * 100)} % · ` : ""}
                        {money(row.cents, bucket.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  Contrasta el efectivo con los cierres de caja del mes; sus ventanas pueden cruzar de
                  mes.
                </p>
              </div>
              <div className="rounded-md border bg-card px-4 py-3">
                <p className="text-sm font-medium">Gastado por tipo</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {bucket.byCategory.map((row) => (
                    <li key={row.category} className="flex justify-between gap-2 text-sm">
                      <span>{row.category}</span>
                      <span className="tabular-nums">{money(row.cents, bucket.currency)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        )
      })}
      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-base font-semibold">Cobrado por profesional</h3>
        <p className="text-sm text-muted-foreground">
          Según quién atendió cada tratamiento cobrado.
        </p>
        {result.byProfessional.length === 0 ? (
          <EmptyState title="Sin cobros" description="Nadie cobró atenciones este mes." />
        ) : (
          <ul className="flex min-w-0 flex-col divide-y rounded-md border bg-card">
            {result.byProfessional.map((row) => (
              <li
                key={`${row.professionalUserId}-${row.currency}`}
                className="flex flex-wrap items-baseline gap-x-2 px-4 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">{row.name ?? "Profesional fuera del equipo"}</span>
                <span className="tabular-nums font-medium">
                  {money(row.cobradoCents, row.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-base font-semibold">Promociones</h3>
        {result.byPromotion.length === 0 ? (
          <EmptyState
            title="Sin promociones cobradas"
            description="Cuando se cobre con una promoción, aparece aquí con sus veces e importe."
          />
        ) : (
          <ul className="flex min-w-0 flex-col divide-y rounded-md border bg-card">
            {result.byPromotion.map((row) => (
              <li
                key={`${row.promotionId}-${row.currency}`}
                className="flex flex-wrap items-baseline gap-x-2 px-4 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">
                  {row.name} · {row.veces} {row.veces === 1 ? "vez" : "veces"}
                </span>
                <span className="tabular-nums font-medium">
                  {money(row.cobradoCents, row.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-base font-semibold">Cierres de caja del mes</h3>
        {result.closures.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin cierres registrados en el mes.</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y rounded-md border bg-card">
            {result.closures.map((row) => (
              <li
                key={row.currency}
                className="flex flex-wrap items-baseline gap-x-2 px-4 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">
                  {row.cierres} {row.cierres === 1 ? "cierre" : "cierres"} · efectivo{" "}
                  {money(row.efectivoCents, row.currency)} · diferencia{" "}
                  {money(row.diferenciasCents, row.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-base font-semibold">Quedó por cobrar al terminar el mes</h3>
        {result.outstanding.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nada pendiente al cierre del mes.</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y rounded-md border bg-card">
            {result.outstanding.map((row) => (
              <li
                key={row.currency}
                className="flex flex-wrap items-baseline gap-x-2 px-4 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">
                  {row.pacientes} {row.pacientes === 1 ? "persona" : "personas"}
                </span>
                <span className="tabular-nums font-medium">
                  {money(row.pendienteCents, row.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
