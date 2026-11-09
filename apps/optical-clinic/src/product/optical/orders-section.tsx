import { formatDate } from "@odentia/clinic-app/lib/clinical-journey"
import { usePermission } from "@odentia/clinic-app/lib/crm"
import { dueOf, fetchPersonOrders, orderKeys } from "@odentia/clinic-app/lib/orders"
import { QueryErrorState } from "@odentia/clinic-app/lib/query-error"
import type { RecordSectionProps } from "@odentia/clinic-app/product/product-ui"
import { buttonVariants, cn } from "@odentia/ui"
import { EmptyState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { PackageCheck } from "lucide-react"
import { opticalOrders } from "./orders"

/**
 * Los pedidos de la persona en su página (entrega 4): cómo va cada uno y para
 * cuándo se prometió, para responder «¿ya están mis lentes?» sin buscarla en
 * Pedidos. Cada fila abre su pedido allí, al lado de la lista; vender es de quien
 * lleva los pedidos y la caja.
 */
export function OrdersSection({ patientId }: RecordSectionProps) {
  const navigate = useNavigate()
  const canOrders = usePermission("orders.write")
  const canCollect = usePermission("finance.write")
  const canSell = canOrders && canCollect
  const query = useQuery({
    queryKey: orderKeys.ofPerson(patientId),
    queryFn: () => fetchPersonOrders(patientId),
  })
  const sell = () => void navigate({ to: "/orders", search: { vender: 1, persona: patientId } })
  if (query.isPending) return <LoadingState message="Cargando sus pedidos…" />
  if (query.isError)
    return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
  const rows = query.data
  return (
    <section className="flex flex-col gap-4" aria-labelledby="pedidos-de-lentes">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="pedidos-de-lentes" className="font-heading text-lg font-semibold">
          Pedidos
        </h2>
        {canSell && rows.length > 0 ? (
          <Link
            to="/orders"
            search={{ vender: 1, persona: patientId }}
            className={buttonVariants({ variant: "outline" })}
          >
            {opticalOrders.sellLabel}
          </Link>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={PackageCheck}
          title="Sin pedidos todavía"
          description="Lo que se le vende con pedido al laboratorio o al taller aparece aquí, con cómo va."
          {...(canSell ? { actionLabel: opticalOrders.sellLabel, onAction: sell } : {})}
        />
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {rows.map((row) => {
            const due = dueOf(row)
            return (
              <li key={row.id}>
                <Link
                  to="/orders"
                  search={{ pedido: row.id }}
                  className="flex min-h-11 flex-col gap-0.5 px-4 py-3 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <span className="font-medium [overflow-wrap:anywhere]">
                    N.º {row.orderNumber} · {row.title}
                  </span>
                  <span className="text-muted-foreground">
                    {row.statusLabel}
                    {row.remadeAs ? " · se rehízo" : ""} · para el{" "}
                    <span className={cn(row.overdue && "font-medium text-destructive")}>
                      {formatDate(row.promisedOn)}
                      {row.overdue ? " · Atrasado" : ""}
                    </span>
                  </span>
                  {due ? (
                    <span className="tabular-nums">
                      {due.label} {due.amount}
                    </span>
                  ) : null}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
