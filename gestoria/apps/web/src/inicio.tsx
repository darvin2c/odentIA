import { Badge, Button, cn, toast } from "@odentia/ui"
import { KpiCard } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Check, Circle, Clock3, MinusCircle } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { SimilarQueue } from "./clientes"
import { api } from "./lib/api"
import { fromWhom } from "./lib/caja"
import {
  byWhen,
  FROM_HOME,
  firstName,
  greeting,
  HOME_KEY,
  longDay,
  type SetupStepState,
  type StoreHome,
  sameText,
  setupProgress,
  stepView,
  type ToDoItem,
  WHEN_TITLES,
} from "./lib/inicio"
import { dayName, storeToday } from "./lib/pedidos"
import { money } from "./lib/tienda"
import { MoveToDay, OrderSheet } from "./pedidos"
import { ErrorBlock, StoreHeader, useMe, useStoreContext } from "./tiendas"

/**
 * Inicio (lienzo «gestorIA como odentIA», tableros 5 y 16): abro y sé qué me toca. Lo ve todo el
 * equipo que atiende, cada rol con lo suyo; las cifras y las líneas las arma el servidor con la
 * hora de la tienda y la misma cuenta de Reportes (`apps/api/src/inicio.ts`).
 *
 * - Arriba, los primeros pasos de una tienda nueva, para quien la configura: cada paso abre su
 *   apartado y vuelve («Volver a Inicio»). Nada obliga.
 * - Las cuatro cifras del día; Ventas ve las suyas, sin los totales de dinero.
 * - «Te toca», ahora, hoy y sin apuro: cada línea con el único botón que la resuelve.
 *
 * «Sale hoy» abre Despachos, que cuenta lo mismo. El efectivo por recibir es una línea de «Te toca»
 * que lleva a Caja. Lo de la Bandeja (los chats que esperan) se suma cuando llegue su pantalla: hoy
 * no se dibuja.
 */
export function HomePage() {
  const { store } = useStoreContext()
  const me = useMe()
  const home = useQuery({
    queryKey: HOME_KEY(store.id),
    queryFn: () => api<StoreHome>(`/api/tiendas/${store.id}/inicio`),
    refetchInterval: 60_000,
  })
  const today = home.data?.today ?? storeToday(store.timeZone)
  const name = firstName(me.data?.person.name ?? "")
  const data = home.data
  const quiet =
    data !== undefined &&
    data.setup !== null &&
    data.toDo.length === 0 &&
    !data.figures.collected?.cents &&
    !data.figures.toConfirm.payments &&
    !data.figures.due?.cents &&
    !data.figures.leaves.orders &&
    !data.figures.leaves.missed
  return (
    <>
      <StoreHeader
        title={`${greeting(store.timeZone)}${name ? `, ${name}` : ""}`}
        subtitle={longDay(today)}
      />
      {home.isPending ? <p className="text-sm text-muted-foreground">Cargando…</p> : null}
      {home.isError ? <ErrorBlock error={home.error} onRetry={() => void home.refetch()} /> : null}
      {data?.setup ? <FirstSteps setup={data.setup} /> : null}
      {/* Una tienda que recién empieza, sin nada todavía, no ve cifras en cero. */}
      {data && !quiet ? <Figures figures={data.figures} /> : null}
      {data ? <ToDo items={data.toDo} today={data.today} /> : null}
    </>
  )
}

/* ------------------------------------------------------------------------- las cifras */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function Figures({ figures }: { figures: StoreHome["figures"] }) {
  const { store } = useStoreContext()
  const m = (cents: number) => money(cents, store.currency)
  const { collected, toConfirm, due, leaves } = figures
  const waiting = toConfirm.payments
  return (
    <section aria-label="Las cifras de hoy" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {collected ? (
        <KpiCard
          title="Cobrado hoy"
          value={m(collected.cents)}
          description={
            collected.payments
              ? plural(collected.payments, "pago confirmado", "pagos confirmados")
              : "Todavía sin pagos confirmados"
          }
        />
      ) : null}
      <KpiCard
        title="Por confirmar"
        value={toConfirm.cents !== null ? m(toConfirm.cents) : plural(waiting, "pago", "pagos")}
        description={
          waiting
            ? toConfirm.cents !== null
              ? `${plural(waiting, "pago", "pagos")}: revisa la captura`
              : "Revisa la captura"
            : "Nada por revisar"
        }
      />
      {due ? (
        <KpiCard
          title="Falta cobrar"
          value={m(due.cents)}
          description={due.orders ? plural(due.orders, "pedido", "pedidos") : "Nada por cobrar"}
        />
      ) : null}
      <Link
        to="/tiendas/$id/despachos"
        params={{ id: store.id }}
        className="rounded-xl focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 [&>div]:transition-colors [&>div]:hover:bg-surface-muted"
      >
        <KpiCard
          title="Sale hoy"
          value={leaves.orders}
          description={
            leaves.missed
              ? `y ${leaves.missed} que no se ${leaves.missed === 1 ? "entregó" : "entregaron"}`
              : leaves.orders
                ? "Ver los de hoy"
                : "Nada para entregar hoy"
          }
        />
      </Link>
    </section>
  )
}

/* --------------------------------------------------------------------------- Te toca */

const TAGS: Record<ToDoItem["kind"], string> = {
  pago: "Pago",
  no_entregado: "No se entregó",
  efectivo: "Efectivo",
  misma: "Clienta",
  stock: "Stock",
  reponer: "Reponer",
}

function ToDo({ items, today }: { items: ToDoItem[]; today: string }) {
  const id = useId()
  const groups = byWhen(items)
  const [order, setOrder] = useState<string | null>(null)
  const [comparing, setComparing] = useState<string | null>(null)
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-lg font-bold">
        Te toca
      </h2>
      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-5 text-sm text-muted-foreground">
          Nada por ahora. Cuando lleguen pedidos, aquí verás lo que te toca, con su botón.
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.when} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-muted-foreground">
              {WHEN_TITLES[group.when]}
            </h3>
            <ul className="elevated flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
              {group.items.map((item) => (
                <ToDoLine
                  key={lineKey(item)}
                  item={item}
                  today={today}
                  onOpenOrder={setOrder}
                  onCompare={setComparing}
                />
              ))}
            </ul>
          </div>
        ))
      )}
      {order ? <OrderSheet orderId={order} onClose={() => setOrder(null)} /> : null}
      {comparing ? <SimilarQueue first={comparing} onClose={() => setComparing(null)} /> : null}
    </section>
  )
}

function lineKey(item: ToDoItem): string {
  switch (item.kind) {
    case "pago":
      return `pago-${item.orderId}-${item.at}`
    case "no_entregado":
    case "stock":
      return `${item.kind}-${item.orderId}`
    case "efectivo":
      return `efectivo-${item.courierId ?? "tienda"}`
    case "misma":
      return `misma-${item.a.id}-${item.b.id}`
    case "reponer":
      return `reponer-${item.productId}-${item.variant}`
  }
}

function ToDoLine({
  item,
  today,
  onOpenOrder,
  onCompare,
}: {
  item: ToDoItem
  today: string
  onOpenOrder: (orderId: string) => void
  onCompare: (customerId: string) => void
}) {
  const { store } = useStoreContext()
  const m = (cents: number) => money(cents, store.currency)
  let text: ReactNode
  let action: ReactNode
  switch (item.kind) {
    case "pago":
      text = (
        <>
          <strong className="font-semibold">{item.customer}</strong>{" "}
          {item.byLink
            ? `pagó ${m(item.amountCents)} por el link y no coincide`
            : `envió su ${item.method} de ${m(item.amountCents)}`}{" "}
          · pedido {item.number}
        </>
      )
      action = (
        <Button size="sm" onClick={() => onOpenOrder(item.orderId)}>
          Ver y confirmar
        </Button>
      )
      break
    case "no_entregado":
      text = (
        <>
          <strong className="font-semibold">
            {item.number} · {item.customer}
          </strong>{" "}
          · {dayName(storeToday(store.timeZone, new Date(item.missedAt)), today)}
          {item.reason ? ` · ${item.reason}` : ""}
          {item.deliverOn ? ` · sale ${dayName(item.deliverOn, today)}` : ""}
        </>
      )
      action = (
        <MoveToDay
          size="sm"
          order={{ id: item.orderId, number: item.number, deliverOn: item.deliverOn }}
        />
      )
      break
    case "efectivo":
      text = (
        <>
          <strong className="font-semibold">{fromWhom(item.courier)}</strong>: {m(item.cents)} en
          efectivo por recibir ·{" "}
          {plural(item.payments, "cobro en la puerta", "cobros en la puerta")}
        </>
      )
      action = (
        <Button
          size="sm"
          variant="outline"
          render={<Link to="/tiendas/$id/caja" params={{ id: store.id }} />}
        >
          Ir a Caja
        </Button>
      )
      break
    case "misma":
      text = sameText(item)
      action = (
        <Button size="sm" variant="outline" onClick={() => onCompare(item.b.id)}>
          Comparar
        </Button>
      )
      break
    case "stock":
      text = (
        <>
          <strong className="font-semibold">
            {item.number} · {item.customer}
          </strong>
          : pagado, y no alcanza el stock de lo que lleva
        </>
      )
      action = (
        <Button size="sm" variant="outline" onClick={() => onOpenOrder(item.orderId)}>
          Ver pedido
        </Button>
      )
      break
    case "reponer":
      text = (
        <>
          <strong className="font-semibold">
            {item.product}
            {item.variant ? ` ${item.variant}` : ""}
          </strong>
          : se acabó y{" "}
          {item.people === 1 ? "1 persona la pidió" : `${item.people} personas la pidieron`}. Cuando
          entre, Sofi les avisa sola.
        </>
      )
      action = (
        <Button
          size="sm"
          variant="outline"
          render={
            <Link
              to="/tiendas/$id/catalogo/$productId"
              params={{ id: store.id, productId: item.productId }}
            />
          }
        >
          Registrar una entrada
        </Button>
      )
      break
  }
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <Badge variant={item.when === "ahora" ? "warning" : "outline"}>{TAGS[item.kind]}</Badge>
        <p className="text-sm">{text}</p>
      </div>
      <div className="shrink-0 self-start sm:self-center">{action}</div>
    </li>
  )
}

/* --------------------------------------------------------------- los primeros pasos */

const STATE_BADGES: Record<
  SetupStepState,
  { label: string; variant: "success" | "outline" | "secondary" }
> = {
  hecho: { label: "Hecho", variant: "success" },
  falta: { label: "Falta", variant: "outline" },
  saltado: { label: "Saltado", variant: "secondary" },
  pronto: { label: "Muy pronto", variant: "outline" },
}

const STATE_ICONS: Record<SetupStepState, ReactNode> = {
  hecho: <Check aria-hidden className="size-4 text-success" />,
  falta: <Circle aria-hidden className="size-4 text-muted-foreground" />,
  saltado: <MinusCircle aria-hidden className="size-4 text-muted-foreground" />,
  pronto: <Clock3 aria-hidden className="size-4 text-muted-foreground" />,
}

function FirstSteps({ setup }: { setup: NonNullable<StoreHome["setup"]> }) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const id = useId()
  const progress = setupProgress(setup.steps)
  const next = setup.steps.find((s) => s.state === "falta")?.step
  const done = setup.steps.filter((s) => s.state === "hecho")
  const skip = useMutation({
    mutationFn: (step: string) =>
      api(`/api/tiendas/${store.id}/primeros-pasos/saltar`, { method: "POST", body: { step } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: HOME_KEY(store.id) })
      toast.success("Listo: ese paso ya no falta")
    },
    onError: (error) => toast.error(error.message),
  })
  return (
    <section
      aria-labelledby={id}
      className="elevated flex flex-col gap-4 rounded-xl border bg-card p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 id={id} className="text-lg font-bold">
            Tu tienda está casi lista
          </h2>
          <p className="text-sm text-muted-foreground">
            Cada paso abre su apartado y vuelve aquí. Puedes vender sin terminarlos.
          </p>
        </div>
        <Badge variant="soft">
          {progress.done} de {progress.total}
        </Badge>
      </div>
      {/* A 390 px, lo hecho se junta en una línea y lo que falta queda a la vista. */}
      {done.length > 0 ? (
        <p className="flex items-center gap-2 text-sm sm:hidden">
          {STATE_ICONS.hecho}
          <span className="min-w-0 flex-1">
            {done.map((s) => stepView(s.step, s.state, setup.facts, store).title).join(", ")}
          </span>
          <Badge variant="success">Hecho</Badge>
        </p>
      ) : null}
      <ol className="flex flex-col divide-y">
        {setup.steps.map((s) => {
          const view = stepView(s.step, s.state, setup.facts, store)
          const isNext = s.step === next
          return (
            <li
              key={s.step}
              className={cn(
                "flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4",
                s.state === "hecho" && "max-sm:hidden",
              )}
            >
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 shrink-0">{STATE_ICONS[s.state]}</span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 font-semibold">
                    {view.title}
                    <Badge variant={STATE_BADGES[s.state].variant}>
                      {STATE_BADGES[s.state].label}
                    </Badge>
                  </span>
                  <span className={cn("text-sm text-muted-foreground", !isNext && "max-sm:hidden")}>
                    {view.detail}
                  </span>
                </div>
              </div>
              {view.action ? (
                <div className="flex shrink-0 flex-wrap gap-2 pl-7 sm:pl-0">
                  {s.skippable && s.state === "falta" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={skip.isPending}
                      onClick={() => skip.mutate(s.step)}
                    >
                      No lo necesito
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant={isNext ? "default" : "outline"}
                    render={
                      <Link to={`/tiendas/${store.id}${view.action.path}`} search={FROM_HOME} />
                    }
                  >
                    {view.action.label}
                  </Button>
                </div>
              ) : null}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
