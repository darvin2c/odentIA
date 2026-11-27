import {
  Badge,
  Button,
  Checkbox,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  toast,
} from "@odentia/ui"
import { Textarea } from "@odentia/ui/components/textarea"
import { ConfirmDialog, EmptyState, SubmitButton, ViewTabs } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSearch } from "@tanstack/react-router"
import { Copy, ImageOff, Link2, PackageCheck, Plus, ReceiptText, Trash2, Truck } from "lucide-react"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { api } from "./lib/api"
import {
  CHANNELS,
  dayName,
  FILTERS,
  type OrderChannel,
  type OrderDetail,
  type OrderFilter,
  type OrderList,
  type OrderPayment,
  type OrderRow,
  type Quote,
  type SellableVariant,
  STATE_TONE,
  stateName,
  storeToday,
  when,
} from "./lib/pedidos"
import { type DeliveryMethod, money, moneyInput, type PaymentMethod, readMoney } from "./lib/tienda"
import {
  FormAlert,
  FormSheet,
  fieldErrors,
  MoneyField,
  Photo,
  SELECT_CLASSES,
  shrinkPhoto,
  TextField,
  useDirty,
} from "./piezas"
import { ErrorBlock, StoreHeader, useStoreContext } from "./tiendas"

/**
 * «Pedidos» (lienzo B, tablero 5): qué falta cobrar y qué sale hoy. Una lista con filtros por
 * estado; cada fila abre su pedido, con lo que toca hacer según su estado: cobrar (link de
 * pago, captura que confirma una persona o al recibir), salir, entregar o anular con motivo.
 * «Anotar un pedido» es para la venta que llega por otro lado. Los avisos al cliente quedan
 * escritos en el pedido: salen cuando se conecte WhatsApp.
 *
 * Un pedido acepta varios pagos, cada uno con su medio; lo que falta cobrar lo dice el servidor
 * (el mismo saldo en el pedido, la lista y Reportes). «Hoy» es el de la tienda, con su hora.
 */

const ORDERS_KEY = (storeId: string) => ["pedidos", storeId]

function lineSummary(lines: OrderRow["lines"]): string {
  const sold = lines.filter((l) => !l.gift)
  const first = sold[0] ?? lines[0]
  if (!first) return ""
  const text = `${first.productName} ${first.variantName === "Única" ? "" : `· ${first.variantName}`}${first.quantity > 1 ? `, ${first.quantity} unidades` : ""}`
  return lines.length > 1 ? `${text} y ${lines.length - 1} más` : text
}

function StateBadge({
  order,
}: {
  order: Pick<OrderRow, "state" | "paymentCollection" | "balance">
}) {
  return <Badge variant={STATE_TONE[order.state]}>{stateName(order)}</Badge>
}

export function OrdersPage() {
  const { store } = useStoreContext()
  const [filter, setFilter] = useState<OrderFilter>("abiertos")
  // «?pedido=…» llega desde Argos o desde la conversación de prueba: abre ese pedido.
  const search = useSearch({ strict: false }) as { pedido?: string }
  const [open, setOpen] = useState<string | null>(search.pedido ?? null)
  useEffect(() => {
    if (search.pedido) setOpen(search.pedido)
  }, [search.pedido])
  const [adding, setAdding] = useState(false)
  const list = useQuery({
    queryKey: [...ORDERS_KEY(store.id), filter],
    queryFn: () => api<OrderList>(`/api/tiendas/${store.id}/pedidos?filtro=${filter}`),
    refetchInterval: 60_000,
  })
  // El día de la tienda: «hoy», «mañana» o «ayer» se cuentan con su hora, no con la del equipo.
  const today = list.data?.today ?? storeToday(store.timeZone)
  const orders = list.data?.orders ?? []
  const counts = list.data?.counts

  return (
    <>
      <StoreHeader
        title="Pedidos"
        subtitle="Qué falta cobrar y qué sale hoy."
        primary={{
          label: "Anotar un pedido",
          icon: <Plus aria-hidden />,
          onClick: () => setAdding(true),
        }}
      />
      <ViewTabs
        label="Qué pedidos ver"
        value={filter}
        onValueChange={setFilter}
        options={FILTERS.map((f) => ({
          ...f,
          count:
            counts && !["entregados", "anulados"].includes(f.value) ? counts[f.value] : undefined,
        }))}
      />
      {list.isPending ? <p className="text-sm text-muted-foreground">Cargando pedidos…</p> : null}
      {list.isError ? <ErrorBlock error={list.error} onRetry={() => void list.refetch()} /> : null}
      {list.data && orders.length === 0 ? (
        <EmptyState
          icon={filter === "hoy" ? Truck : ReceiptText}
          title={
            filter === "hoy"
              ? "Nada para entregar hoy"
              : filter === "por_confirmar"
                ? "No hay pagos por confirmar"
                : "No hay pedidos aquí"
          }
          description={
            filter === "abiertos"
              ? "Los pedidos que arma Sofi en la conversación aparecerán aquí. Mientras tanto, anota la venta que te llega por otro lado."
              : "Cambia de filtro para ver los demás."
          }
        />
      ) : null}
      {orders.length > 0 ? (
        <div className="elevated overflow-hidden rounded-xl border bg-card">
          <div className="hidden grid-cols-[3.5rem_minmax(0,1.1fr)_minmax(0,1.8fr)_5.5rem_minmax(0,1fr)_minmax(0,1fr)_9.5rem] gap-4 border-b bg-surface-muted px-4 py-2.5 text-xs font-semibold text-muted-foreground lg:grid">
            <span>Pedido</span>
            <span>Cliente</span>
            <span>Productos</span>
            <span className="text-right">Total</span>
            <span>Pago</span>
            <span>Entrega</span>
            <span>Estado</span>
          </div>
          <ul className="flex flex-col divide-y">
            {orders.map((order) => (
              <li key={order.id}>
                <button
                  type="button"
                  onClick={() => setOpen(order.id)}
                  className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:ring-inset lg:grid-cols-[3.5rem_minmax(0,1.1fr)_minmax(0,1.8fr)_5.5rem_minmax(0,1fr)_minmax(0,1fr)_9.5rem] lg:items-center"
                >
                  <span className="hidden font-mono text-sm tabular-nums lg:block">
                    {order.number}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-semibold">
                      <span className="font-mono font-normal text-muted-foreground lg:hidden">
                        {order.number} ·{" "}
                      </span>
                      {order.customerName}
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {CHANNELS[order.channel].replace(/ \(.*\)$/, "")}
                      {order.bySofi ? " · lo armó Sofi" : ""}
                      {order.test ? <Badge variant="outline">Prueba</Badge> : null}
                    </span>
                  </span>
                  <span className="col-start-1 min-w-0 text-sm lg:line-clamp-2 lg:col-start-auto">
                    {lineSummary(order.lines)}
                  </span>
                  <span className="col-start-2 row-start-1 flex flex-col text-right tabular-nums lg:col-start-auto lg:row-start-auto">
                    <span className="font-semibold">{money(order.totalCents, store.currency)}</span>
                    {order.balance.dueCents > 0 && order.balance.dueCents < order.totalCents ? (
                      <span className="text-xs text-warning">
                        falta {money(order.balance.dueCents, store.currency)}
                      </span>
                    ) : null}
                  </span>
                  <span className="col-start-1 min-w-0 text-sm lg:col-start-auto">
                    {order.paymentName}
                    {order.confirmedBy ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · confirmado por {order.confirmedBy}
                      </span>
                    ) : null}
                  </span>
                  <span className="col-start-1 min-w-0 text-sm text-muted-foreground lg:col-start-auto">
                    {order.deliveryName}
                    {order.deliverOn ? ` · ${dayName(order.deliverOn, today)}` : ""}
                  </span>
                  <span className="col-start-2 row-start-2 justify-self-end lg:col-start-auto lg:row-start-auto lg:justify-self-start">
                    <StateBadge order={order} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {open ? <OrderSheet orderId={open} onClose={() => setOpen(null)} /> : null}
      {adding ? (
        <NewOrderSheet
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false)
            setOpen(id)
          }}
        />
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------- el pedido abierto */

function useOrderAction(storeId: string, orderId: string, onDone?: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown; done?: string }) =>
      api<{ order: OrderDetail }>(`/api/tiendas/${storeId}/pedidos/${orderId}/${path}`, {
        method: "POST",
        body: body ?? {},
      }),
    onSuccess: async (data, vars) => {
      queryClient.setQueryData(["pedido", storeId, orderId], data.order)
      await queryClient.invalidateQueries({ queryKey: ORDERS_KEY(storeId) })
      if (vars.done) toast.success(vars.done)
      onDone?.()
    },
  })
}

function OrderSheet({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const { store } = useStoreContext()
  const detail = useQuery({
    queryKey: ["pedido", store.id, orderId],
    queryFn: async () =>
      (await api<{ order: OrderDetail }>(`/api/tiendas/${store.id}/pedidos/${orderId}`)).order,
  })
  const order = detail.data
  return (
    <Sheet open onOpenChange={(next) => (next ? null : onClose())}>
      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader className="pr-14">
          <SheetTitle>
            {order ? `Pedido ${order.number} · ${order.customerName}` : "Pedido"}
          </SheetTitle>
          <SheetDescription>
            {order ? (
              <span className="flex flex-wrap items-center gap-2">
                <StateBadge order={order} />
                {order.test ? <Badge variant="outline">Prueba</Badge> : null}
                <span>
                  {CHANNELS[order.channel].replace(/ \(.*\)$/, "")} · anotado el{" "}
                  {when(order.createdAt)}
                  {order.bySofi ? " · lo armó Sofi" : ""}
                </span>
              </span>
            ) : (
              "Cargando…"
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {detail.isError ? (
            <ErrorBlock error={detail.error} onRetry={() => void detail.refetch()} />
          ) : null}
          {order ? <OrderBody order={order} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 border-t py-4 first:border-t-0">
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Row({
  label,
  children,
  strong,
}: {
  label: ReactNode
  children: ReactNode
  strong?: boolean
}) {
  return (
    <div className={`flex justify-between gap-4 text-sm ${strong ? "font-semibold" : ""}`}>
      <span className={strong ? "" : "text-muted-foreground"}>{label}</span>
      <span className="text-right tabular-nums">{children}</span>
    </div>
  )
}

function OrderBody({ order }: { order: OrderDetail }) {
  const { store } = useStoreContext()
  const can = (p: string) => store.permissions.includes(p)
  const cur = store.currency
  const absorbed = order.deliveryListCents - order.deliveryCents
  const open = !["entregado", "anulado"].includes(order.state)
  const cancelAllowed = open && (!order.moneyIn || can("pagos.confirmar"))
  const { balance } = order

  return (
    <div className="flex flex-col">
      <NextStep order={order} />
      <Block title="Productos">
        <ul className="flex flex-col gap-3">
          {order.lines.map((line) => (
            <li key={line.id} className="flex items-center gap-3">
              <Photo storeId={store.id} photoId={line.photoId} alt="" className="size-10" />
              <div className="flex min-w-0 flex-1 flex-col text-sm">
                <span className="truncate font-medium">
                  {line.productName}
                  {line.variantName === "Única" ? "" : ` · ${line.variantName}`}
                </span>
                <span className="text-xs text-muted-foreground">
                  {line.quantity} × {line.gift ? "regalo" : money(line.unitCents, cur)}
                  {!line.gift && line.unitCents < line.listUnitCents
                    ? ` (lista ${money(line.listUnitCents, cur)})`
                    : ""}
                  {" · "}
                  {line.sku}
                </span>
              </div>
              <span className="text-sm tabular-nums">
                {line.gift ? "—" : money(line.unitCents * line.quantity, cur)}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-1 flex flex-col gap-1 border-t pt-2">
          <Row label="Productos">{money(order.subtotalCents, cur)}</Row>
          <Row
            label={`Envío · ${order.deliveryName}${order.deliveryZone ? ` (${order.deliveryZone})` : ""}`}
          >
            {order.deliveryCents === 0 ? "Gratis" : money(order.deliveryCents, cur)}
          </Row>
          <Row label="Total" strong>
            {money(order.totalCents, cur)}
          </Row>
        </div>
        {order.marginUsedCents > 0 || order.deliveryFreeByPolicy ? (
          <p className="rounded-lg bg-surface-muted px-3 py-2 text-xs text-muted-foreground">
            {[
              order.discountCents > 0 ? `descuento de ${money(order.discountCents, cur)}` : null,
              absorbed > 0
                ? order.deliveryFreeByPolicy
                  ? `envío gratis por compra desde el mínimo de la forma de entrega`
                  : `la tienda pone ${money(absorbed, cur)} del envío`
                : null,
              order.giftCents > 0 ? `regalo de ${money(order.giftCents, cur)} (a su mínimo)` : null,
            ]
              .filter(Boolean)
              .join(", ")
              .replace(/^./, (c) => `Se cedió: ${c}`)}
            .
            {order.marginUsedCents > 0
              ? ` Usó ${money(order.marginUsedCents, cur)} de ${money(order.marginCents, cur)} de margen.`
              : ""}
            {order.priceExpiresAt && open && !order.moneyIn
              ? order.priceExpired
                ? " El precio acordado ya venció."
                : ` El precio vale hasta el ${when(order.priceExpiresAt)}`
              : ""}
          </p>
        ) : null}
      </Block>

      <Block title="Cobro">
        <Row label="Medio de pago">{order.paymentName}</Row>
        {order.payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {order.paymentCollection === "al_recibir"
              ? "Se cobra al entregar."
              : "Todavía no hay pagos anotados."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {order.payments.map((p) => (
              <PaymentItem key={p.id} order={order} payment={p} />
            ))}
          </ul>
        )}
        {order.payments.length > 0 && order.state !== "anulado" ? (
          <div className="flex flex-col gap-1 border-t pt-2">
            {balance.confirmedCents > 0 ? (
              <Row label="Cobrado">{money(balance.confirmedCents, cur)}</Row>
            ) : null}
            {balance.pendingCents > 0 ? (
              <Row label="Por confirmar">{money(balance.pendingCents, cur)}</Row>
            ) : null}
            {balance.dueCents > 0 ? (
              <Row label="Falta cobrar" strong>
                {money(balance.dueCents, cur)}
              </Row>
            ) : balance.paid ? (
              <Row label="Falta cobrar">Nada: está pagado</Row>
            ) : null}
          </div>
        ) : null}
        {order.state === "por_pagar" ? (
          <CollectActions order={order} />
        ) : order.state !== "anulado" && balance.dueCents > 0 ? (
          <OtherPayment order={order} />
        ) : null}
      </Block>

      <Block title="Entrega">
        <Row label="Forma">{order.deliveryName}</Row>
        {order.deliverOn ? (
          <Row label="Día">{dayName(order.deliverOn, storeToday(store.timeZone))}</Row>
        ) : null}
        {order.address ? <Row label="Dirección">{order.address}</Row> : null}
        {order.customerPhone ? (
          <Row label="Teléfono">
            <a className="underline" href={`tel:${order.customerPhone.replace(/[^+\d]/g, "")}`}>
              {order.customerPhone}
            </a>
          </Row>
        ) : null}
        {order.tracking ? <Row label="Número de envío">{order.tracking}</Row> : null}
        {order.notes ? <p className="text-sm">{order.notes}</p> : null}
        {(order.state === "por_salir" || order.state === "en_camino") && can("entregas") ? (
          <DeliveryActions order={order} />
        ) : null}
      </Block>

      <Block title="Lo que pasó">
        <History order={order} />
      </Block>

      {cancelAllowed ? <CancelOrder order={order} /> : null}
      {open && order.moneyIn && !can("pagos.confirmar") ? (
        <p className="pt-2 text-xs text-muted-foreground">
          Un pedido que ya tiene un pago lo anula quien confirma pagos.
        </p>
      ) : null}
    </div>
  )
}

/** Lo que toca ahora, en una línea, arriba de todo. */
function NextStep({ order }: { order: OrderDetail }) {
  const { store } = useStoreContext()
  const due = order.balance.dueCents
  const dueText = money(due, store.currency)
  const text: Record<OrderDetail["state"], string | null> = {
    por_pagar: order.priceExpired
      ? "El precio acordado venció: si sigue en pie, anúlalo y anótalo de nuevo."
      : order.linkConnected
        ? "Falta que pague. Mándale el link de pago o anota su captura cuando llegue."
        : "Falta que pague. Anota su captura cuando llegue.",
    por_confirmar: "Revisa la cuenta de la tienda y confirma el pago, o di que no coincide.",
    por_salir: order.stockPending
      ? "Ya pagó, pero no alcanzaba el stock: registra la entrada en el catálogo antes de que salga."
      : due > 0
        ? `Listo para salir. Falta cobrar ${dueText}: se cobra al entregar.`
        : order.balance.paid
          ? "Pagado. Listo para salir."
          : "Listo para salir. Falta confirmar un pago.",
    en_camino:
      due > 0
        ? `Va en camino. Al entregar, cobra ${dueText}.`
        : "Va en camino. Márcalo como entregado cuando llegue.",
    entregado: due > 0 ? `Entregado, pero falta cobrar ${dueText}.` : null,
    anulado: order.cancelReason ? `Anulado: ${order.cancelReason}` : null,
  }
  const message = text[order.state]
  if (!message) return null
  const warn =
    order.priceExpired ||
    order.stockPending ||
    order.state === "por_confirmar" ||
    (order.state === "entregado" && due > 0)
  return (
    <p
      className={`mb-2 rounded-lg px-3 py-2 text-sm ${warn ? "bg-warning-soft text-warning" : "bg-surface-muted"}`}
    >
      {message}
    </p>
  )
}

function ReceiptImage({
  storeId,
  orderId,
  paymentId,
}: {
  storeId: string
  orderId: string
  paymentId: string
}) {
  const blob = useQuery({
    queryKey: ["captura", storeId, paymentId],
    queryFn: () =>
      api<Blob>(`/api/tiendas/${storeId}/pedidos/${orderId}/pagos/${paymentId}/captura`, {
        as: "blob",
      }),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob.data) return
    const next = URL.createObjectURL(blob.data)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob.data])
  if (blob.isError)
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <ImageOff className="size-4" aria-hidden /> No se pudo abrir la captura
      </span>
    )
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="block w-fit">
      <img src={url} alt="Captura del pago" className="max-h-64 rounded-lg border object-contain" />
    </a>
  ) : (
    <span className="block h-24 w-40 animate-pulse rounded-lg bg-muted" />
  )
}

const PAYMENT_KINDS: Record<OrderPayment["kind"], string> = {
  link: "Por el link",
  comprobante: "Captura",
  al_recibir: "Al recibir",
}

function PaymentItem({ order, payment }: { order: OrderDetail; payment: OrderPayment }) {
  const { store } = useStoreContext()
  const cur = store.currency
  const canConfirm = store.permissions.includes("pagos.confirmar")
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState("")
  const action = useOrderAction(store.id, order.id, () => setRejecting(false))
  const review = (body: { decision: "confirmar" } | { decision: "no_coincide"; reason: string }) =>
    action.mutate({
      path: `pagos/${payment.id}/revision`,
      body,
      done: body.decision === "confirmar" ? "Pago confirmado" : "Anotado: el pago no coincide",
    })
  const status = {
    por_confirmar: <Badge variant="warning">Por confirmar</Badge>,
    confirmado: <Badge variant="success">Confirmado</Badge>,
    no_coincide: <Badge variant="destructive">No coincide</Badge>,
  }[payment.status]
  return (
    <li className="flex flex-col gap-2 rounded-lg border px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">
          {payment.methodName} · {money(payment.amountCents, cur)}
          {payment.operation ? (
            <span className="font-normal text-muted-foreground"> · op. {payment.operation}</span>
          ) : null}
        </span>
        {status}
      </div>
      <p className="text-xs text-muted-foreground">
        {PAYMENT_KINDS[payment.kind]} ·{" "}
        {payment.byLink
          ? `llegó por el link el ${when(payment.createdAt)}`
          : `anotado por ${payment.createdByName ?? "alguien del equipo"} el ${when(payment.createdAt)}`}
        {payment.reviewedAt && payment.reviewedByName
          ? `; ${payment.status === "confirmado" ? "confirmado" : "revisado"} por ${payment.reviewedByName} el ${when(payment.reviewedAt)}`
          : ""}
      </p>
      {payment.note ? <p className="text-sm">{payment.note}</p> : null}
      {payment.hasPhoto ? (
        <ReceiptImage storeId={store.id} orderId={order.id} paymentId={payment.id} />
      ) : null}
      {payment.status === "por_confirmar" ? (
        canConfirm ? (
          <>
            {order.state === "anulado" ? (
              <p className="text-sm text-warning">
                El pedido está anulado: si lo confirmas, queda anotado para ver si hay que
                devolverlo.
              </p>
            ) : payment.overIfConfirmedCents > 0 ? (
              <p className="text-sm text-warning">
                Con este pago se cobra {money(payment.overIfConfirmedCents, cur)} más que el total (
                {money(order.totalCents, cur)}): si lo confirmas, queda como pago doble para
                revisar.
              </p>
            ) : order.balance.dueCents > 0 ? (
              <p className="text-sm text-muted-foreground">
                Es una parte del total: después de confirmarlo, faltan{" "}
                {money(order.balance.dueCents, cur)}.
              </p>
            ) : null}
            {order.priceExpiresAt && payment.createdAt > order.priceExpiresAt ? (
              <p className="text-sm text-warning">El precio acordado venció antes de este pago.</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <SubmitButton
                pending={
                  action.isPending && action.variables?.path.endsWith("revision") && !rejecting
                }
                onClick={() => review({ decision: "confirmar" })}
              >
                Confirmar pago
              </SubmitButton>
              <Button variant="outline" onClick={() => setRejecting(true)}>
                No coincide
              </Button>
            </div>
            {action.isError && !rejecting ? <FormAlert error={action.error} /> : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Lo confirma alguien del equipo que puede confirmar pagos.
          </p>
        )
      ) : null}
      <ConfirmDialog
        open={rejecting}
        title="El pago no coincide"
        description={
          order.state === "por_confirmar" &&
          order.payments.filter((p) => p.status === "por_confirmar").length === 1
            ? "El pedido vuelve a «Por pagar». Pídele al cliente que lo revise: el aviso queda escrito en el pedido, pero todavía no se envía solo."
            : "Queda anotado con tu motivo, y el pedido sigue como está."
        }
        confirmLabel="Anotar que no coincide"
        cancelLabel="Volver"
        pending={action.isPending}
        confirmDisabled={reason.trim().length < 3}
        error={action.isError ? action.error.message : null}
        onConfirm={() => review({ decision: "no_coincide", reason })}
        onClose={() => setRejecting(false)}
      >
        <ReasonField
          value={reason}
          onChange={setReason}
          placeholder="Por ejemplo: no aparece en la cuenta, el monto es otro"
        />
      </ConfirmDialog>
    </li>
  )
}

function ReasonField({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  const id = useId()
  return (
    <Field>
      <FieldLabel htmlFor={id}>Motivo</FieldLabel>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={300}
        rows={3}
      />
      <FieldDescription>Queda escrito en el pedido, con tu nombre.</FieldDescription>
    </Field>
  )
}

/** Por pagar: el link de pago (primero) o la captura del pago. */
function CollectActions({ order }: { order: OrderDetail }) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const [capturing, setCapturing] = useState(false)
  const link = useMutation({
    mutationFn: () =>
      api<{ url: string }>(`/api/tiendas/${store.id}/pedidos/${order.id}/link`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["pedido", store.id, order.id] })
    },
  })
  const url = link.data?.url ?? order.linkUrl
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success("Link copiado. Pégalo en la conversación con el cliente.")
    } catch {
      toast.error("No se pudo copiar: selecciona el link y cópialo.")
    }
  }
  return (
    <div className="flex flex-col gap-3">
      {url ? (
        <div className="flex flex-col gap-1.5 rounded-lg bg-surface-muted px-3 py-2.5">
          <span className="text-xs font-semibold">
            Link de pago por {money(order.totalCents, store.currency)}
          </span>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={url}
              aria-label="Link de pago"
              onFocus={(e) => e.target.select()}
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => void copy(url)}
              aria-label="Copiar el link"
            >
              <Copy aria-hidden />
            </Button>
          </div>
          <span className="text-xs text-muted-foreground">
            Cuando pague con el link, el pedido pasa a pagado solo.
          </span>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!url && order.linkConnected && !order.priceExpired ? (
          <SubmitButton pending={link.isPending} onClick={() => link.mutate()}>
            <Link2 aria-hidden />
            Crear link de pago
          </SubmitButton>
        ) : null}
        <Button
          variant={url || order.linkConnected ? "outline" : "default"}
          onClick={() => setCapturing(true)}
        >
          <ReceiptText aria-hidden />
          Anotar captura del pago
        </Button>
      </div>
      {!order.linkConnected ? (
        <p className="text-xs text-muted-foreground">
          {store.permissions.includes("configuracion")
            ? "Para cobrar con link de pago, conéctalo en Pagos y entregas."
            : "El link de pago se usa cuando el dueño lo conecte."}
        </p>
      ) : null}
      <FormAlert error={link.error} />
      {capturing ? <ReceiptSheet order={order} onClose={() => setCapturing(false)} /> : null}
    </div>
  )
}

/**
 * Los medios de la tienda con que se puede anotar un pago de una forma (una captura, o en la
 * puerta), con el del pedido primero si se cobra así. El servidor los vuelve a comprobar.
 */
function useMethodsFor(order: OrderDetail, collection: PaymentMethod["collection"]) {
  const { store } = useStoreContext()
  const lists = useQuery({
    queryKey: ["pagos-y-entregas", store.id],
    queryFn: () =>
      api<{ payments: PaymentMethod[]; deliveries: DeliveryMethod[] }>(
        `/api/tiendas/${store.id}/pagos-y-entregas`,
      ),
  })
  const methods = (lists.data?.payments ?? []).filter(
    (m) => m.collection === collection && (m.isActive || m.name === order.paymentName),
  )
  const own = methods.find((m) => m.name === order.paymentName)
  return own ? [own, ...methods.filter((m) => m !== own)] : methods
}

/**
 * Ya sale (o salió) y falta cobrar: un pago más antes de la puerta, como el resto por Yape o un
 * adelanto de un pedido que se paga al recibir.
 */
function OtherPayment({ order }: { order: OrderDetail }) {
  const [capturing, setCapturing] = useState(false)
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <Button variant="outline" onClick={() => setCapturing(true)}>
        <ReceiptText aria-hidden />
        {order.payments.length > 0 ? "Anotar otro pago" : "Anotar un pago"}
      </Button>
      {capturing ? <ReceiptSheet order={order} onClose={() => setCapturing(false)} /> : null}
    </div>
  )
}

function ReceiptSheet({ order, onClose }: { order: OrderDetail; onClose: () => void }) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const due = order.balance.dueCents
  const [amount, setAmount] = useState(moneyInput(due || order.totalCents, store.currency))
  const methods = useMethodsFor(order, "comprobante")
  const [methodId, setMethodId] = useState("")
  const chosen = methodId || methods[0]?.id || ""
  const [operation, setOperation] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [amountError, setAmountError] = useState<string | undefined>()
  const fileInput = useRef<HTMLInputElement>(null)
  const dirty = useDirty({ amount, operation, file: file?.name })
  useEffect(() => {
    if (!file) return setPreview(null)
    const next = URL.createObjectURL(file)
    setPreview(next)
    return () => URL.revokeObjectURL(next)
  }, [file])
  const save = useMutation({
    mutationFn: async (amountCents: number) => {
      const form = new FormData()
      form.set("amountCents", String(amountCents))
      form.set("operation", operation.trim())
      if (chosen) form.set("methodId", chosen)
      if (file) form.set("captura", await shrinkPhoto(file), "captura")
      return api<{ order: OrderDetail }>(
        `/api/tiendas/${store.id}/pedidos/${order.id}/comprobante`,
        {
          method: "POST",
          form,
        },
      )
    },
    onSuccess: async (data) => {
      queryClient.setQueryData(["pedido", store.id, order.id], data.order)
      await queryClient.invalidateQueries({ queryKey: ORDERS_KEY(store.id) })
      toast.success("Captura anotada: queda por confirmar")
      onClose()
    },
  })
  const submit = () => {
    const cents = readMoney(amount, store.currency)
    if (!cents) return setAmountError("Escribe el monto que se ve en la captura")
    setAmountError(undefined)
    save.mutate(cents)
  }
  const errors = fieldErrors(save.error)
  return (
    <FormSheet
      open
      title={`Captura del pago · pedido ${order.number}`}
      description="Anota lo que se ve en la captura. Alguien que puede confirmar pagos revisa la cuenta y lo confirma."
      onClose={onClose}
      onSubmit={submit}
      dirty={dirty}
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancelar
          </Button>
          <SubmitButton type="submit" pending={save.isPending}>
            Anotar captura
          </SubmitButton>
        </>
      }
    >
      <FieldGroup>
        {methods.length > 1 ? (
          <SelectField
            label="Medio"
            value={chosen}
            onChange={setMethodId}
            options={methods.map((m) => ({ value: m.id, label: m.name }))}
            error={errors.methodId}
          />
        ) : null}
        <MoneyField
          label="Monto"
          currency={store.currency}
          value={amount}
          onChange={setAmount}
          error={amountError ?? errors.amountCents}
          help={
            due < order.totalCents
              ? `Falta cobrar ${money(due, store.currency)} de ${money(order.totalCents, store.currency)}.`
              : `El total del pedido es ${money(order.totalCents, store.currency)}. Si paga una parte, anota lo que pagó.`
          }
          autoFocus
        />
        <TextField
          label="Número de operación (opcional)"
          value={operation}
          onChange={setOperation}
          maxLength={60}
          error={errors.operation}
        />
        <Field>
          <FieldLabel>Imagen de la captura (opcional)</FieldLabel>
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {preview ? (
            <img
              src={preview}
              alt="La captura elegida"
              className="max-h-56 w-fit rounded-lg border object-contain"
            />
          ) : null}
          <div className="flex gap-2">
            <Button variant="outline" type="button" onClick={() => fileInput.current?.click()}>
              {file ? "Elegir otra" : "Elegir la imagen"}
            </Button>
            {file ? (
              <Button variant="ghost" type="button" onClick={() => setFile(null)}>
                Quitar
              </Button>
            ) : null}
          </div>
          <FieldDescription>Queda guardada con el pedido para revisarla después.</FieldDescription>
        </Field>
        <FormAlert error={save.error} />
      </FieldGroup>
    </FormSheet>
  )
}

/** Por salir o en camino: «Salió» y «Entregado» (o «Entregado y cobrado»). */
function DeliveryActions({ order }: { order: OrderDetail }) {
  const { store } = useStoreContext()
  const due = order.balance.dueCents
  const [tracking, setTracking] = useState("")
  const [collected, setCollected] = useState(moneyInput(due, store.currency))
  const methods = useMethodsFor(order, "al_recibir")
  const [methodId, setMethodId] = useState("")
  const chosen = methodId || methods[0]?.id || ""
  const [asking, setAsking] = useState<"salio" | "entregado" | null>(null)
  const action = useOrderAction(store.id, order.id, () => setAsking(null))
  // Falta cobrar (todo, o lo que quedó de un adelanto): se cobra en la puerta.
  const cashOnDelivery = due > 0
  const errors = fieldErrors(action.error)
  const collectedCents = readMoney(collected, store.currency)
  const pickup = order.deliveryType === "OnSitePickup"
  return (
    <div className="flex flex-col gap-2 pt-1">
      <div className="flex flex-wrap gap-2">
        {order.state === "por_salir" && !pickup ? (
          <Button onClick={() => setAsking("salio")}>
            <Truck aria-hidden />
            Salió
          </Button>
        ) : null}
        <Button
          variant={order.state === "en_camino" || pickup ? "default" : "outline"}
          onClick={() => {
            // Lo que falta cobrar ahora, aunque haya entrado otro pago desde que se abrió.
            setCollected(moneyInput(due, store.currency))
            setAsking("entregado")
          }}
        >
          <PackageCheck aria-hidden />
          {cashOnDelivery ? "Entregado y cobrado" : "Entregado"}
        </Button>
      </div>
      <ConfirmDialog
        open={asking === "salio"}
        title={`El pedido ${order.number} salió`}
        description="Pasa a «En camino». Si va por agencia, pega su número de envío."
        confirmLabel="Salió"
        cancelLabel="Volver"
        pending={action.isPending}
        error={action.isError ? action.error.message : null}
        onConfirm={() => action.mutate({ path: "salio", body: { tracking }, done: "En camino" })}
        onClose={() => setAsking(null)}
      >
        <TextField
          label="Número de envío (opcional)"
          value={tracking}
          onChange={setTracking}
          maxLength={80}
          error={errors.tracking}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={asking === "entregado"}
        title={cashOnDelivery ? "Entregado y cobrado" : `El pedido ${order.number} llegó`}
        description={
          cashOnDelivery
            ? "Anota cuánto cobraste en la puerta y con qué: queda con tu nombre."
            : "Pasa a «Entregado»."
        }
        confirmLabel={cashOnDelivery ? "Entregado y cobrado" : "Entregado"}
        cancelLabel="Volver"
        pending={action.isPending}
        confirmDisabled={cashOnDelivery && !collectedCents}
        error={action.isError && !errors.collectedCents ? action.error.message : null}
        onConfirm={() =>
          action.mutate({
            path: "entregado",
            body: cashOnDelivery ? { collectedCents, methodId: chosen || null } : {},
            done: "Entregado",
          })
        }
        onClose={() => setAsking(null)}
      >
        {cashOnDelivery ? (
          <FieldGroup>
            <MoneyField
              label="¿Cuánto cobraste?"
              currency={store.currency}
              value={collected}
              onChange={setCollected}
              error={errors.collectedCents}
              help={
                collectedCents !== null && collectedCents !== due
                  ? `No es lo que faltaba (${money(due, store.currency)}): queda anotado lo que cobraste para revisarlo.`
                  : due < order.totalCents
                    ? `Falta cobrar ${money(due, store.currency)} de ${money(order.totalCents, store.currency)}.`
                    : `El total es ${money(order.totalCents, store.currency)}.`
              }
            />
            {methods.length > 1 ? (
              <SelectField
                label="Medio"
                value={chosen}
                onChange={setMethodId}
                options={methods.map((m) => ({ value: m.id, label: m.name }))}
                error={errors.methodId}
              />
            ) : null}
          </FieldGroup>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}

function CancelOrder({ order }: { order: OrderDetail }) {
  const { store } = useStoreContext()
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState("")
  const action = useOrderAction(store.id, order.id, () => setAsking(false))
  return (
    <div className="border-t pt-4">
      <Button variant="ghost" className="text-destructive" onClick={() => setAsking(true)}>
        <Trash2 aria-hidden />
        Anular pedido
      </Button>
      <ConfirmDialog
        open={asking}
        variant="destructive"
        title={`Anular el pedido ${order.number}`}
        description={
          order.moneyIn
            ? "Ya pagó: el stock vuelve, pero la devolución del dinero la haces tú, fuera de gestorIA."
            : "Lo que salió del stock vuelve con su movimiento."
        }
        confirmLabel="Anular pedido"
        cancelLabel="Volver"
        pending={action.isPending}
        confirmDisabled={reason.trim().length < 3}
        error={action.isError ? action.error.message : null}
        onConfirm={() =>
          action.mutate({ path: "anular", body: { reason }, done: "Pedido anulado" })
        }
        onClose={() => setAsking(false)}
      >
        <ReasonField
          value={reason}
          onChange={setReason}
          placeholder="Por ejemplo: el cliente se arrepintió, no había su talla"
        />
      </ConfirmDialog>
    </div>
  )
}

const EVENT_TEXT: Record<Exclude<OrderDetail["events"][number]["action"], "aviso">, string> = {
  creado: "Anotó el pedido",
  link: "Creó el link de pago",
  comprobante: "Anotó una captura del pago",
  pago_confirmado: "Confirmó el pago",
  pago_no_coincide: "Anotó que el pago no coincide",
  pago_link: "Pago por el link",
  salio: "Salió",
  entregado: "Entregado",
  anulado: "Anuló el pedido",
}

function History({ order }: { order: OrderDetail }) {
  const { store } = useStoreContext()
  return (
    <ol className="flex flex-col gap-2.5">
      {order.events.map((event) => {
        const d = event.detail as Record<string, string | number | boolean | null>
        if (event.action === "aviso")
          return (
            <li key={event.id} className="flex flex-col gap-0.5 text-sm">
              <span className="text-xs text-muted-foreground">
                Aviso al cliente · {when(event.createdAt)} · sin enviar: WhatsApp todavía no está
                conectado
              </span>
              <span className="w-fit max-w-full rounded-lg bg-surface-muted px-3 py-1.5 break-words">
                {String(d.texto ?? "")}
              </span>
            </li>
          )
        const extra = [
          typeof d.motivo === "string" ? `«${d.motivo}»` : null,
          typeof d.monto === "number" ? money(d.monto, store.currency) : null,
          typeof d.medio === "string" ? d.medio : null,
          typeof d.cobrado === "number" ? `cobró ${money(d.cobrado, store.currency)}` : null,
          typeof d.falta === "number" ? `faltan ${money(d.falta, store.currency)}` : null,
          typeof d.envio === "string" ? `envío ${d.envio}` : null,
          typeof d.porRevisar === "string" ? d.porRevisar : null,
          d.faltaStock ? "no alcanzaba el stock" : null,
          typeof d.stockDevuelto === "number" ? "el stock volvió" : null,
        ].filter(Boolean)
        return (
          <li key={event.id} className="text-sm">
            <span className="font-medium">{EVENT_TEXT[event.action]}</span>
            {extra.length ? ` · ${extra.join(" · ")}` : ""}
            <span className="block text-xs text-muted-foreground">
              {event.byLink ? "El link de pago" : (event.actorName ?? "Alguien del equipo")} ·{" "}
              {when(event.createdAt)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/* ------------------------------------------------------------------- anotar un pedido */

interface LineDraft {
  key: number
  variantId: string
  quantity: string
  price: string
  gift: boolean
}

function NewOrderSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const { store } = useStoreContext()
  const cur = store.currency
  const queryClient = useQueryClient()
  const sellable = useQuery({
    queryKey: ["para-vender", store.id],
    queryFn: () =>
      api<{ variants: SellableVariant[] }>(`/api/tiendas/${store.id}/pedidos/para-vender`),
  })
  const lists = useQuery({
    queryKey: ["pagos-y-entregas", store.id],
    queryFn: () =>
      api<{ payments: PaymentMethod[]; deliveries: DeliveryMethod[] }>(
        `/api/tiendas/${store.id}/pagos-y-entregas`,
      ),
  })
  const variants = sellable.data?.variants ?? []
  const deliveries = (lists.data?.deliveries ?? []).filter((d) => d.isActive)
  const payments = (lists.data?.payments ?? []).filter((p) => p.isActive)

  const [customerName, setCustomerName] = useState("")
  const [customerPhone, setCustomerPhone] = useState("")
  const [channel, setChannel] = useState<OrderChannel>("otro")
  const nextKey = useRef(1)
  const [lines, setLines] = useState<LineDraft[]>([
    { key: 0, variantId: "", quantity: "1", price: "", gift: false },
  ])
  const [deliveryId, setDeliveryId] = useState("")
  const [zone, setZone] = useState("")
  const [deliveryCost, setDeliveryCost] = useState("")
  const [deliveryCharged, setDeliveryCharged] = useState("")
  const [address, setAddress] = useState("")
  const [deliverOn, setDeliverOn] = useState(storeToday(store.timeZone))
  const [paymentId, setPaymentId] = useState("")
  const [notes, setNotes] = useState("")
  const dirty = useDirty({
    customerName,
    customerPhone,
    lines,
    deliveryId,
    paymentId,
    address,
    notes,
  })

  const delivery = deliveries.find((d) => d.id === deliveryId)
  const payment = payments.find((p) => p.id === paymentId)
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({})

  const money_ = (text: string) => (text.trim() === "" ? null : readMoney(text, cur))
  // Solo van las líneas con producto; `sent[i]` es la posición en pantalla de la línea i que se
  // envía, para poner cada error y cada precio en su línea.
  const sent = lines.flatMap((l, i) => (l.variantId ? [i] : []))
  const body = {
    customerName,
    customerPhone,
    channel,
    address,
    notes,
    lines: sent.map((i) => {
      const l = lines[i]!
      return {
        variantId: l.variantId,
        quantity: Number(l.quantity) || 0,
        unitCents: l.gift ? null : money_(l.price),
        gift: l.gift,
      }
    }),
    deliveryMethodId: deliveryId,
    zone: delivery?.cost === "por_zona" ? zone || null : null,
    deliveryListCents: delivery?.cost === "se_acuerda" ? money_(deliveryCost) : null,
    deliveryCents: money_(deliveryCharged),
    paymentMethodId: paymentId,
    deliverOn: deliverOn || null,
  }
  // El resumen lo calcula el servidor, con la misma regla que al guardar.
  const ready = body.lines.length > 0 && deliveryId !== "" && paymentId !== ""
  const quoteKey = JSON.stringify(body)
  const [debounced, setDebounced] = useState(quoteKey)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(quoteKey), 300)
    return () => clearTimeout(timer)
  }, [quoteKey])
  const quote = useQuery({
    queryKey: ["calcular", store.id, debounced],
    queryFn: () =>
      api<{ quote: Quote | null; fields: Record<string, string> }>(
        `/api/tiendas/${store.id}/pedidos/calcular`,
        { method: "POST", body: JSON.parse(debounced) },
      ),
    enabled: ready && debounced === quoteKey,
    placeholderData: (previous) => previous,
  })

  const create = useMutation({
    mutationFn: () =>
      api<{ order: OrderDetail }>(`/api/tiendas/${store.id}/pedidos`, {
        method: "POST",
        body,
      }),
    onSuccess: async (data) => {
      queryClient.setQueryData(["pedido", store.id, data.order.id], data.order)
      await queryClient.invalidateQueries({ queryKey: ORDERS_KEY(store.id) })
      await queryClient.invalidateQueries({ queryKey: ["para-vender", store.id] })
      toast.success(`Pedido ${data.order.number} anotado`)
      onCreated(data.order.id)
    },
  })
  // Al cambiar algo, el error de guardar ya no vale: vuelve a mandar el resumen.
  const resetCreate = create.reset
  useEffect(() => {
    if (quoteKey) resetCreate()
  }, [quoteKey, resetCreate])
  // Lo que el servidor dijo al guardar manda; si no, lo que dice el resumen. Los errores de
  // `lines.N` vuelven a la línea de la pantalla.
  const serverErrors = Object.fromEntries(
    Object.entries(create.error ? fieldErrors(create.error) : (quote.data?.fields ?? {})).map(
      ([key, message]) => [
        key.replace(/^lines\.(\d+)\./, (_, n: string) => `lines.${sent[Number(n)] ?? n}.`),
        message,
      ],
    ),
  )
  const errors = { ...serverErrors, ...localErrors }
  const quotedLine = (i: number) => q?.lines[sent.indexOf(i)]

  const submit = () => {
    const next: Record<string, string> = {}
    if (!customerName.trim()) next.customerName = "Escribe el nombre del cliente"
    if (body.lines.length === 0) next.lines = "Agrega al menos un producto"
    if (!deliveryId) next.deliveryMethodId = "Elige cómo se entrega"
    if (!paymentId) next.paymentMethodId = "Elige cómo paga"
    lines.forEach((l, i) => {
      if (l.variantId && !(Number(l.quantity) >= 1)) next[`lines.${i}.quantity`] = "Al menos 1"
      if (!l.gift && l.price.trim() && money_(l.price) === null)
        next[`lines.${i}.unitCents`] = "Escribe un monto válido"
    })
    setLocalErrors(next)
    if (Object.keys(next).length === 0) create.mutate()
  }

  const update = (key: number, patch: Partial<LineDraft>) =>
    setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const q = quote.data?.quote
  const absorbed = q ? q.deliveryListCents - q.deliveryCents : 0

  return (
    <FormSheet
      open
      wide
      title="Anotar un pedido"
      description="Para la venta que llegó por otro lado, como una llamada o la tienda. Se arma con los mismos precios y límites que usa Sofi."
      onClose={onClose}
      onSubmit={submit}
      dirty={dirty}
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancelar
          </Button>
          <SubmitButton type="submit" pending={create.isPending}>
            Anotar pedido
          </SubmitButton>
        </>
      }
    >
      {sellable.isError || lists.isError ? (
        <ErrorBlock error={sellable.error ?? lists.error} />
      ) : null}
      <FieldGroup>
        <FieldSet>
          <FieldLegend>Cliente</FieldLegend>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Nombre"
              value={customerName}
              onChange={setCustomerName}
              maxLength={120}
              error={errors.customerName}
              autoFocus
            />
            <TextField
              label="Teléfono (opcional)"
              value={customerPhone}
              onChange={setCustomerPhone}
              maxLength={30}
              inputMode="text"
              placeholder="+51 987 654 321"
              error={errors.customerPhone}
            />
          </div>
          <SelectField
            label="Por dónde llegó"
            value={channel}
            onChange={(v) => setChannel(v as OrderChannel)}
            options={Object.entries(CHANNELS).map(([value, label]) => ({ value, label }))}
          />
        </FieldSet>

        <FieldSet>
          <FieldLegend>Productos</FieldLegend>
          {errors.lines ? <FieldError>{errors.lines}</FieldError> : null}
          {lines.map((line, i) => {
            const v = variants.find((x) => x.id === line.variantId)
            const negotiable = v && v.floorUnitCents < v.autoUnitCents
            return (
              <div key={line.key} className="flex flex-col gap-3 rounded-lg border p-3">
                <div className="flex items-start gap-2">
                  <SelectField
                    className="flex-1"
                    label={`Producto ${i + 1}`}
                    value={line.variantId}
                    onChange={(variantId) => update(line.key, { variantId, price: "" })}
                    error={errors[`lines.${i}.variantId`]}
                    placeholder={sellable.isPending ? "Cargando el catálogo…" : "Elige el producto"}
                    options={variants.map((x) => ({
                      value: x.id,
                      label: `${x.productName}${x.variantName === "Única" ? "" : ` · ${x.variantName}`} — ${money(x.autoUnitCents, cur)}${x.stock === 0 ? " · agotado" : ` · quedan ${x.stock}`}`,
                      disabled: x.stock === 0,
                    }))}
                  />
                  {lines.length > 1 ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      className="mt-6"
                      aria-label={`Quitar el producto ${i + 1}`}
                      onClick={() => setLines((all) => all.filter((l) => l.key !== line.key))}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  ) : null}
                </div>
                <div className="grid gap-3 sm:grid-cols-[6rem_minmax(0,1fr)]">
                  <TextField
                    label="Cantidad"
                    value={line.quantity}
                    onChange={(quantity) => update(line.key, { quantity })}
                    inputMode="numeric"
                    error={errors[`lines.${i}.quantity`]}
                  />
                  {line.gift ? (
                    <p className="self-end pb-2 text-sm text-muted-foreground">
                      Va de regalo: sale del margen de lo que compra.
                    </p>
                  ) : (
                    <MoneyField
                      label="Precio acordado por unidad"
                      currency={cur}
                      value={line.price}
                      onChange={(price) => update(line.key, { price })}
                      placeholder={
                        v ? moneyInput(quotedLine(i)?.autoUnitCents ?? v.autoUnitCents, cur) : ""
                      }
                      error={errors[`lines.${i}.unitCents`]}
                      help={
                        v
                          ? negotiable
                            ? `Vacío: ${money(v.autoUnitCents, cur)}${v.promotion ? ` (${v.promotion})` : ""}. Se negocia hasta ${money(v.floorUnitCents, cur)}.`
                            : `${money(v.autoUnitCents, cur)}${v.promotion ? ` (${v.promotion})` : ""}. No se negocia.`
                          : undefined
                      }
                    />
                  )}
                </div>
                <GiftCheck checked={line.gift} onChange={(gift) => update(line.key, { gift })} />
              </div>
            )
          })}
          <Button
            variant="outline"
            type="button"
            className="self-start"
            onClick={() =>
              setLines((all) => [
                ...all,
                { key: nextKey.current++, variantId: "", quantity: "1", price: "", gift: false },
              ])
            }
          >
            <Plus aria-hidden />
            Agregar otro producto
          </Button>
        </FieldSet>

        <FieldSet>
          <FieldLegend>Entrega</FieldLegend>
          <SelectField
            label="Forma de entrega"
            value={deliveryId}
            onChange={(id) => {
              setDeliveryId(id)
              setZone("")
              setDeliveryCharged("")
            }}
            error={errors.deliveryMethodId}
            placeholder="Elige cómo se entrega"
            options={deliveries.map((d) => ({ value: d.id, label: d.name }))}
          />
          {delivery?.cost === "por_zona" ? (
            <SelectField
              label="Zona"
              value={zone}
              onChange={setZone}
              error={errors.zone}
              placeholder="Elige la zona"
              options={delivery.zones.map((z) => ({
                value: z.name,
                label: `${z.name} — ${money(z.priceCents, cur)}`,
              }))}
            />
          ) : null}
          {delivery?.cost === "se_acuerda" ? (
            <MoneyField
              label="Cuánto cuesta el envío"
              currency={cur}
              value={deliveryCost}
              onChange={setDeliveryCost}
              error={errors.deliveryListCents}
              help="Se acuerda con el cliente."
            />
          ) : null}
          {delivery && (delivery.cost === "fijo" || delivery.cost === "por_zona") ? (
            <MoneyField
              label="Lo que paga de envío (opcional)"
              currency={cur}
              value={deliveryCharged}
              onChange={setDeliveryCharged}
              placeholder={q ? moneyInput(q.deliveryCents, cur) : ""}
              error={errors.deliveryCents}
              help={
                delivery.maxDiscountCents
                  ? `Vacío: lo que corresponde. Se puede rebajar hasta ${money(delivery.maxDiscountCents, cur)}, del margen.`
                  : "Vacío: lo que corresponde. Este envío no se rebaja."
              }
            />
          ) : null}
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
            <TextField
              label="Dirección (opcional)"
              value={address}
              onChange={setAddress}
              maxLength={300}
              error={errors.address}
            />
            <DateField label="Día de entrega" value={deliverOn} onChange={setDeliverOn} />
          </div>
        </FieldSet>

        <FieldSet>
          <FieldLegend>Pago</FieldLegend>
          <SelectField
            label="Medio de pago"
            value={paymentId}
            onChange={setPaymentId}
            error={errors.paymentMethodId}
            placeholder="Elige cómo paga"
            options={payments.map((p) => ({
              value: p.id,
              label:
                p.collection === "al_recibir" && delivery && !delivery.acceptsPayOnDelivery
                  ? `${p.name} (esta entrega no acepta pago al recibir)`
                  : p.name,
              disabled:
                p.collection === "al_recibir" &&
                delivery !== undefined &&
                !delivery.acceptsPayOnDelivery,
            }))}
          />
          {payment?.collection === "al_recibir" ? (
            <FieldDescription>
              Se cobra en la puerta: el pedido queda listo para salir.
            </FieldDescription>
          ) : null}
          <TextField label="Nota (opcional)" value={notes} onChange={setNotes} maxLength={500} />
        </FieldSet>

        <section
          aria-live="polite"
          className="flex flex-col gap-1 rounded-lg bg-surface-muted px-4 py-3"
        >
          <h3 className="text-sm font-semibold">Resumen</h3>
          {!ready ? (
            <p className="text-sm text-muted-foreground">
              Elige los productos, la entrega y el pago para ver el total.
            </p>
          ) : q ? (
            <>
              <Row label="Productos">{money(q.subtotalCents, cur)}</Row>
              <Row label="Envío">
                {q.deliveryCents === 0 ? "Gratis" : money(q.deliveryCents, cur)}
                {absorbed > 0 ? ` (cuesta ${money(q.deliveryListCents, cur)})` : ""}
              </Row>
              <Row label="Total" strong>
                {money(q.totalCents, cur)}
              </Row>
              {q.marginUsedCents > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Cedes {money(q.marginUsedCents, cur)} de {money(q.marginCents, cur)} de margen
                  {q.discountCents ? `: ${money(q.discountCents, cur)} de descuento` : ""}
                  {absorbed > 0 && !q.deliveryFreeByPolicy
                    ? `, ${money(absorbed, cur)} del envío`
                    : ""}
                  {q.giftCents ? `, ${money(q.giftCents, cur)} en regalo` : ""}. El precio acordado
                  vale 24 horas.
                </p>
              ) : null}
              {q.deliveryFreeByPolicy ? (
                <p className="text-xs text-muted-foreground">
                  Envío gratis: la compra llega al monto de esta forma de entrega.
                </p>
              ) : null}
            </>
          ) : quote.isFetching || debounced !== quoteKey ? (
            <p className="text-sm text-muted-foreground">Calculando…</p>
          ) : (
            <p className="text-sm text-warning">Revisa lo marcado arriba para ver el total.</p>
          )}
        </section>
        <FormAlert error={create.error} />
      </FieldGroup>
    </FormSheet>
  )
}

function SelectField({
  label,
  value,
  onChange,
  options,
  error,
  placeholder,
  className,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string; disabled?: boolean }[]
  error?: string
  placeholder?: string
  className?: string
}) {
  const id = useId()
  return (
    <Field data-invalid={error ? true : undefined} className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={SELECT_CLASSES}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  )
}

function GiftCheck({ checked, onChange }: { checked: boolean; onChange: (gift: boolean) => void }) {
  const id = useId()
  return (
    <div className="flex items-center gap-2 text-sm">
      <Checkbox id={id} checked={checked} onCheckedChange={(next) => onChange(Boolean(next))} />
      <label htmlFor={id}>De regalo</label>
    </div>
  )
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  const id = useId()
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  )
}
