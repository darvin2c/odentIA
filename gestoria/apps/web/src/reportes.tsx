import { Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@odentia/ui"
import { AgentMark, AgentSurface, KpiCard, ViewTabs } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronDown } from "lucide-react"
import { useState } from "react"
import { api } from "./lib/api"
import { CHANNELS, when } from "./lib/pedidos"
import { type ArgosBoard, type StoreReport, usd } from "./lib/sofi"
import { money } from "./lib/tienda"
import { ErrorBlock, StoreHeader, useStoreContext } from "./tiendas"

/**
 * «Reportes» (lienzo B, tablero 13): cómo va la tienda y lo que hizo y le toca a Argos. Solo
 * Dueño y Administrador. Cada cifra sale de un cálculo fijo del servidor sobre los pedidos, los
 * pagos, el kardex y las conversaciones; los pedidos de prueba no cuentan.
 */

type Period = StoreReport["period"]
const PERIODS: { value: Period; label: string }[] = [
  { value: "mes", label: "Este mes" },
  { value: "semana", label: "Esta semana" },
  { value: "hoy", label: "Hoy" },
]

export function ReportsPage() {
  const { store } = useStoreContext()
  const [period, setPeriod] = useState<Period>("mes")
  // Los periodos los cuenta el servidor con la hora de la tienda.
  const report = useQuery({
    queryKey: ["reportes", store.id, period],
    queryFn: () => api<StoreReport>(`/api/tiendas/${store.id}/reportes?periodo=${period}`),
  })
  const m = (cents: number) => money(cents, store.currency)
  const r = report.data
  return (
    <>
      <StoreHeader title="Reportes" subtitle="Cómo va la tienda." />
      <Argos />
      <ViewTabs
        label="Qué periodo ver"
        value={period}
        onValueChange={setPeriod}
        options={PERIODS}
      />
      {report.isPending ? <p className="text-sm text-muted-foreground">Cargando…</p> : null}
      {report.isError ? (
        <ErrorBlock error={report.error} onRetry={() => void report.refetch()} />
      ) : null}
      {r ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              title="Vendido y cobrado"
              value={m(r.sold.cents)}
              description={
                r.sold.orders
                  ? `${r.sold.orders} ${r.sold.orders === 1 ? "pedido" : "pedidos"} · ticket ${m(r.sold.ticketCents)}`
                  : "Sin pagos confirmados"
              }
            />
            <KpiCard
              title="Falta cobrar"
              value={m(
                r.pending.toConfirm.cents + r.pending.toPay.cents + r.pending.onDelivery.cents,
              )}
              description={`${r.pending.toConfirm.orders} por confirmar · ${r.pending.toPay.orders} por pagar · ${r.pending.onDelivery.orders} al recibir`}
            />
            <KpiCard
              title="Compraron"
              value={
                r.conversations.total
                  ? `${Math.round((r.conversations.bought / r.conversations.total) * 100)} %`
                  : "—"
              }
              description={`${r.conversations.bought} de ${r.conversations.total} conversaciones`}
            />
            <KpiCard
              title="Volvieron a comprar"
              value={r.returning}
              description="Clientes con 2 o más pedidos"
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Table
              title="De dónde vienen las ventas"
              head={["Canal", "Pedidos", "Vendido"]}
              rows={r.channels.map((c) => [
                CHANNELS[c.channel].replace(/ \(.*\)$/, ""),
                String(c.orders),
                m(c.cents),
              ])}
              empty="Sin pedidos en este periodo"
            />
            <Table
              title="Lo más vendido y lo que se acaba"
              head={["Producto", "Vendidas", "Stock"]}
              rows={r.products.map((p) => [
                p.name,
                String(p.sold),
                p.stock === 0
                  ? "0 · agotado"
                  : p.daysLeft !== null && p.daysLeft < 60
                    ? `${p.stock} · alcanza ~${p.daysLeft < 14 ? `${p.daysLeft} días` : `${Math.round(p.daysLeft / 7)} semanas`}`
                    : String(p.stock),
              ])}
              empty="Sin productos"
            />
          </div>
          <section aria-labelledby="reporte-sofi" className="flex flex-col gap-3">
            <h2 id="reporte-sofi" className="flex items-center gap-2 text-lg font-bold">
              <AgentMark size="sm" />
              Sofi
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard
                title="Atendió"
                value={r.agent.conversations}
                description={`${r.agent.conversations === 1 ? "Conversación" : "Conversaciones"}; pasó ${r.agent.passedToPerson} a una persona`}
              />
              <KpiCard
                title="Pedidos que armó"
                value={m(r.agent.cents)}
                description={`${r.agent.orders} ${r.agent.orders === 1 ? "pedido" : "pedidos"} sin anular`}
              />
              <KpiCard
                title="Margen que usó"
                value={m(r.agent.marginUsedCents)}
                description={`De ${m(r.agent.marginCents)} que tenía hasta tus mínimos`}
              />
              <KpiCard
                title="Costo por conversación"
                value={usd(r.agent.costPerConversationMicros)}
                description={`${usd(r.agent.costMicros)} en el periodo`}
              />
            </div>
          </section>
        </>
      ) : null}
    </>
  )
}

function Table({
  title,
  head,
  rows,
  empty,
}: {
  title: string
  head: string[]
  rows: string[][]
  empty: string
}) {
  return (
    <section className="elevated overflow-hidden rounded-xl border bg-card">
      <h2 className="border-b px-4 py-3 font-bold">{title}</h2>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-surface-muted text-xs text-muted-foreground">
            <tr>
              {head.map((h, i) => (
                <th
                  key={h}
                  scope="col"
                  className={`px-4 py-2 font-semibold ${i ? "text-right" : "text-left"}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.join("|")}>
                {row.map((cell, i) => (
                  <td key={head[i]} className={`px-4 py-2 ${i ? "text-right tabular-nums" : ""}`}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------------ Argos */

function Argos() {
  const { store } = useStoreContext()
  const board = useQuery({
    queryKey: ["argos", store.id],
    queryFn: () => api<ArgosBoard>(`/api/tiendas/${store.id}/argos`),
    refetchInterval: 60_000,
  })
  const b = board.data
  const m = (cents: number) => money(cents, store.currency)
  return (
    <AgentSurface aria-labelledby="argos" className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <AgentMark />
        <div className="flex flex-col gap-0.5">
          <h2 id="argos" className="text-lg font-bold">
            Argos · lo que hizo y lo que te toca
          </h2>
          <p className="text-sm text-muted-foreground">
            Lo de rutina se lo encarga a Sofi sin preguntar. A ti solo te trae lo delicado.
          </p>
        </div>
      </div>
      {board.isError ? (
        <ErrorBlock error={board.error} onRetry={() => void board.refetch()} />
      ) : null}
      {b ? (
        <>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Te toca</h3>
            {b.toDo.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nada te toca por ahora.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {b.toDo.map((item, i) => (
                  <li
                    key={`${item.kind}-${item.orderId ?? item.conversationId ?? i}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2.5"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="font-semibold">{item.title}</span>
                      <span className="text-sm text-muted-foreground">
                        {item.detail}
                        {item.at ? ` · ${when(item.at)}` : ""}
                      </span>
                    </div>
                    {item.orderId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        render={
                          <Link
                            to="/tiendas/$id/pedidos"
                            params={{ id: store.id }}
                            search={{ pedido: item.orderId }}
                          />
                        }
                      >
                        Abrir el pedido
                      </Button>
                    ) : item.kind === "reponer" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        render={<Link to="/tiendas/$id/catalogo" params={{ id: store.id }} />}
                      >
                        Registrar una entrada
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Hecho esta semana</h3>
            {b.done.length === 0 ? (
              <p className="text-sm text-muted-foreground">Todavía no le encargó nada a Sofi.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {b.done.map((group) => (
                  <li key={group.kind} className="rounded-lg border bg-card px-3 py-2.5">
                    <Collapsible>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold">{group.title}</span>
                        <CollapsibleTrigger
                          render={<Button size="sm" variant="ghost" />}
                          className="group"
                        >
                          Ver lo que escribió Sofi
                          <ChevronDown
                            aria-hidden
                            className="transition-transform group-data-[panel-open]:rotate-180"
                          />
                        </CollapsibleTrigger>
                      </div>
                      <CollapsibleContent>
                        <ul className="mt-2 flex flex-col gap-2">
                          {group.messages.map((msg) => (
                            <li
                              key={`${msg.at}-${msg.customer}`}
                              className="flex flex-col gap-1 text-sm"
                            >
                              <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                {msg.customer ?? "Un cliente"} · {when(msg.at)}
                                <Badge variant="outline">Sin enviar</Badge>
                                {msg.needsTemplate ? (
                                  <Badge variant="outline">Saldrá con plantilla aprobada</Badge>
                                ) : null}
                              </span>
                              <span>{msg.text}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Se enviarán cuando conectes WhatsApp.
                        </p>
                      </CollapsibleContent>
                    </Collapsible>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-sm">
            <span className="font-semibold">Resumen de la semana: </span>
            {m(b.week.collectedCents)} cobrados
            {b.week.changePercent !== null
              ? `, ${Math.abs(b.week.changePercent)} % ${b.week.changePercent >= 0 ? "más" : "menos"} que la anterior`
              : ""}
            . Sofi atendió {b.week.conversations}{" "}
            {b.week.conversations === 1 ? "conversación" : "conversaciones"} y pasó{" "}
            {b.week.passedToPerson} a una persona.
          </p>
        </>
      ) : null}
    </AgentSurface>
  )
}
