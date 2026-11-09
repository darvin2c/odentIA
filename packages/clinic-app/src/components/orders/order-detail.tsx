/**
 * Un pedido al lado de la lista (`?pedido=`): para quién es, qué lleva, la copia
 * de lo que se copió al vender (vistIA: la receta), las medidas, las notas y cómo
 * fue, paso a paso, con quién marcó cada uno. Quien trabaja los pedidos tiene a
 * la vista el paso siguiente («Enviado al laboratorio», «Llegó del laboratorio»,
 * «Revisado: está listo», «Entregar») y en «…» saltar a listo; rehacer y anular
 * son además de quien lleva la caja (deciden sobre lo cobrado).
 * Entregar no exige pagar: si falta, se dice y se ofrece «Cobrar» con el cajón
 * de Cobros. Lo que se cambia aquí vuelve a pedir el pedido y las listas, salga
 * bien o no: un 409 de un cambio de otra persona deja la pantalla al día.
 */
import {
  Alert,
  AlertDescription,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from "@odentia/ui"
import {
  DatePickerButton,
  DetailDrawer,
  DetailField,
  DetailList,
  DetailSection,
  FormDrawer,
  regionToday,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MoreHorizontal } from "lucide-react"
import * as React from "react"
import { z } from "zod"
import { formatDate, formatDateTime } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { invalidatePatientAccount } from "../../lib/finance-collect"
import { inventoryKeys } from "../../lib/inventory"
import { activeOrgLocale } from "../../lib/locale"
import {
  advanceOrder,
  canSkipToReady,
  canVoid,
  dueOf,
  fetchOrder,
  invalidateOrders,
  nextStepOf,
  type OrderDetail,
  type OrderLink,
  type OrderStep,
  orderKeys,
  orderMoney,
  orderNumberWords,
  remakeOrder,
  voidOrder,
} from "../../lib/orders"
import { QueryErrorState } from "../../lib/query-error"
import { productUi } from "../../product/product-ui"
import { useCollectFlow } from "../patient/collect-flow"
import { PersonLink } from "../person-link"

/** Una medida en el formato de la clínica («19,5»); un texto, tal cual. */
function measureText(value: unknown): string {
  return typeof value === "number"
    ? new Intl.NumberFormat(activeOrgLocale() ?? "es", { maximumFractionDigits: 2 }).format(value)
    : String(value)
}

/** Los avisos de la copia (vistIA: vencida o sin verificar), si los trae: se informan, no impiden. */
function copyNotices(copy: Record<string, unknown> | null): string[] {
  const notices = copy?.notices
  return Array.isArray(notices)
    ? notices.filter((item): item is string => typeof item === "string")
    : []
}

export function OrderDetailDrawer({
  orderId,
  onClose,
  onOpen,
}: {
  orderId: string | null
  onClose: () => void
  /** Abre otro pedido en el mismo lugar (el original de uno rehecho, el que se rehízo). */
  onOpen: (id: string) => void
}) {
  const query = useQuery({
    queryKey: orderKeys.detail(orderId ?? ""),
    queryFn: () => fetchOrder(orderId as string),
    enabled: orderId !== null,
  })
  const order = query.data
  return (
    <DetailDrawer
      open={orderId !== null}
      onClose={onClose}
      title={order ? `Pedido N.º ${order.orderNumber}` : "Pedido"}
      description={order?.title}
      isLoading={query.isPending && orderId !== null}
      actions={order ? <OrderActions order={order} onOpen={onOpen} /> : undefined}
    >
      {query.isError && !order ? (
        <QueryErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          notFound="Este pedido ya no está disponible."
        />
      ) : order ? (
        <OrderBody order={order} onOpen={onOpen} />
      ) : null}
    </DetailDrawer>
  )
}

function OrderBody({ order, onOpen }: { order: OrderDetail; onOpen: (id: string) => void }) {
  const orders = productUi().orders
  const money = (cents: number) => orderMoney(cents, order.currency)
  const due = dueOf(order)
  const notices = copyNotices(order.prescription)
  const copied =
    order.prescription && orders?.prescriptionLines
      ? orders.prescriptionLines(order.prescription)
      : []
  // Solo las medidas que el producto nombra: una clave interna no es un nombre.
  const fitting = (orders?.fitting ?? []).flatMap((field) => {
    const value = order.fitting?.[field.key]
    return value === null || value === undefined || value === "" ? [] : [{ field, value }]
  })
  return (
    <div className="flex flex-col gap-6">
      <DetailList>
        <DetailField label="Para quién">
          <PersonLink patientId={order.patientId}>{order.patientName}</PersonLink>
        </DetailField>
        <DetailField label="Cómo va">{order.statusLabel}</DetailField>
        <DetailField label="Para cuándo">
          <span className={order.overdue ? "font-medium text-destructive" : undefined}>
            {formatDate(order.promisedOn)}
            {order.overdue ? " · Atrasado" : ""}
          </span>
        </DetailField>
        <DetailField label="Lo hace">{order.maker}</DetailField>
        {due ? (
          <DetailField label={due.label}>
            <span className="tabular-nums">{due.amount}</span>
          </DetailField>
        ) : null}
      </DetailList>

      {order.remadeAs ? (
        <RemadeLine prefix="Se rehízo en el" target={order.remadeAs} onOpen={onOpen} />
      ) : null}
      {order.remakeOfOrder ? (
        <div className="flex flex-col gap-1 text-sm">
          <RemadeLine prefix="Rehace el" target={order.remakeOfOrder} onOpen={onOpen} />
          {order.remakeReason ? (
            <p className="[overflow-wrap:anywhere]">Por qué: {order.remakeReason}</p>
          ) : null}
        </div>
      ) : null}
      {order.voidReason ? <p className="text-sm">Se anuló: {order.voidReason}</p> : null}

      <DetailSection title="Lo que lleva">
        <ul className="flex flex-col divide-y text-sm">
          {order.lines.map((line) => (
            <li key={line.id} className="flex items-start justify-between gap-3 py-2">
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {line.description}
                {line.quantity > 1 ? ` × ${line.quantity}` : ""}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {line.amountCents !== null
                  ? money(line.amountCents)
                  : line.chargeId === null
                    ? "Sin cobro"
                    : null}
              </span>
            </li>
          ))}
        </ul>
      </DetailSection>

      {orders && order.prescriptionHidden ? (
        <DetailSection title={orders.referenceLabel}>
          <p className="text-sm text-muted-foreground">Va con el pedido; la ve quien lo hace.</p>
        </DetailSection>
      ) : orders && copied.length > 0 ? (
        <DetailSection title={orders.referenceLabel}>
          <ul className="flex flex-col gap-1 text-sm tabular-nums">
            {copied.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {notices.length > 0 ? (
            <Alert role="status" className="border-warning/40 bg-warning-soft">
              <AlertDescription className="text-foreground">
                {notices.map((notice) => (
                  <p key={notice}>{notice}</p>
                ))}
              </AlertDescription>
            </Alert>
          ) : null}
        </DetailSection>
      ) : null}

      {fitting.length > 0 ? (
        <DetailSection title="Medidas para montar">
          <DetailList>
            {fitting.map(({ field, value }) => (
              <DetailField key={field.key} label={field.label}>
                <span className="tabular-nums">
                  {measureText(value)}
                  {typeof value === "number" ? ` ${field.unit}` : ""}
                </span>
              </DetailField>
            ))}
          </DetailList>
        </DetailSection>
      ) : null}

      {order.notes ? (
        <DetailSection title="Notas">
          <p className="whitespace-pre-line text-sm [overflow-wrap:anywhere]">{order.notes}</p>
        </DetailSection>
      ) : null}

      <DetailSection title="Cómo fue">
        <ol className="flex flex-col gap-3 text-sm">
          {/* Cada paso se marca una vez: su estado y su hora lo identifican. */}
          {order.events.map((event) => (
            <li
              key={`${event.status}-${event.at}`}
              className="flex flex-col gap-0.5 border-l-2 pl-3"
            >
              <span className="font-medium">{event.statusLabel}</span>
              <span className="text-muted-foreground">
                {formatDateTime(event.at)}
                {event.actorName ? ` · ${event.actorName}` : ""}
              </span>
              {event.note ? <span className="[overflow-wrap:anywhere]">{event.note}</span> : null}
            </li>
          ))}
        </ol>
      </DetailSection>
    </div>
  )
}

function OrderActions({ order, onOpen }: { order: OrderDetail; onOpen: (id: string) => void }) {
  const canWrite = usePermission("orders.write")
  const canCollect = usePermission("finance.write")
  const queryClient = useQueryClient()
  const [remaking, setRemaking] = React.useState(false)
  const [voiding, setVoiding] = React.useState(false)
  const advance = useMutation({
    mutationFn: (status: OrderStep) => advanceOrder(order.id, status),
    onSuccess: (updated) => {
      queryClient.setQueryData(orderKeys.detail(updated.id), updated)
      toast.success(`Pedido N.º ${updated.orderNumber}: ${updated.statusLabel.toLowerCase()}`)
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
    // Bien o mal (otra persona lo cambió: 409), el pedido y las listas vuelven a pedirse.
    onSettled: () => invalidateOrders(queryClient),
  })
  // Entregar no exige pagar: lo que falta se dice al lado, con «Cobrar». El cajón y el
  // ticket viven aquí y siguen a la vista cuando ya no falta nada y el botón se va.
  const due = order.status === "listo" && !order.remadeAs ? dueOf(order) : null
  const collect = useCollectFlow({
    patientId: order.patientId,
    patientName: order.patientName,
    enabled: due !== null,
    onChanged: () => invalidateOrders(queryClient),
  })
  if (!canWrite) return collect.surfaces
  // Rehecho: sigue en el otro pedido; este ya no avanza, no se anula ni se cobra.
  if (order.remadeAs)
    return <RemadeLine prefix="Se rehízo en el" target={order.remadeAs} onOpen={onOpen} />
  const next = nextStepOf(order.status)
  const menu = [
    ...(canSkipToReady(order.status)
      ? [
          {
            key: "listo",
            label: "Marcar listo",
            onSelect: () => advance.mutate("listo"),
          },
        ]
      : []),
    // Rehacer y anular deciden sobre lo cobrado: son de quien lleva la caja.
    ...(order.status !== "anulado" && canCollect
      ? [{ key: "rehacer", label: "Rehacer", onSelect: () => setRemaking(true) }]
      : []),
  ]
  const voidable = canCollect && canVoid(order.status)
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {/* En el teléfono ya está arriba, en «Falta pagar»: aquí solo en pantalla ancha. */}
      {due ? (
        <span className="hidden text-sm font-medium tabular-nums sm:inline" role="status">
          {due.label} {due.amount}
        </span>
      ) : null}
      {due && canCollect ? collect.button({ variant: "outline" }) : null}
      {collect.surfaces}
      {next ? (
        <Button
          type="button"
          disabled={advance.isPending}
          onClick={() => advance.mutate(next.status)}
        >
          {next.label}
        </Button>
      ) : null}
      {menu.length > 0 || voidable ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 min-w-11 sm:min-h-9"
                aria-label={`Más acciones del pedido N.º ${order.orderNumber}`}
              />
            }
          >
            <MoreHorizontal aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {menu.map((item) => (
              <DropdownMenuItem key={item.key} disabled={advance.isPending} onClick={item.onSelect}>
                {item.label}
              </DropdownMenuItem>
            ))}
            {voidable && menu.length > 0 ? <DropdownMenuSeparator /> : null}
            {voidable ? (
              <DropdownMenuItem className="text-destructive" onClick={() => setVoiding(true)}>
                Anular
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {remaking ? (
        <RemakeDrawer
          order={order}
          onClose={() => setRemaking(false)}
          onRemade={(created) => {
            setRemaking(false)
            onOpen(created.id)
          }}
        />
      ) : null}
      {voiding ? <VoidDrawer order={order} onClose={() => setVoiding(false)} /> : null}
    </div>
  )
}

/** «Se rehízo en el pedido N.º 14», con el pedido que lo abre ahí mismo. */
function RemadeLine({
  prefix,
  target,
  onOpen,
}: {
  prefix: string
  target: OrderLink
  onOpen: (id: string) => void
}) {
  return (
    <p className="flex flex-wrap items-center gap-x-1 text-sm">
      {prefix}
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0"
        onClick={() => onOpen(target.id)}
      >
        pedido {orderNumberWords(target)}
      </Button>
    </p>
  )
}

const remakeSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Escribe por qué se rehace.")
    .max(2000, "Escribe como mucho 2000 caracteres."),
  promisedOn: z.string().min(1, "Elige para cuándo."),
})

/**
 * Rehacer (vuelve porque no ve bien, se rompió en el taller): otro pedido unido a
 * este, con lo mismo y sin cobrar otra vez. Pide por qué y para cuándo.
 */
function RemakeDrawer({
  order,
  onClose,
  onRemade,
}: {
  order: OrderDetail
  onClose: () => void
  onRemade: (created: OrderDetail) => void
}) {
  const queryClient = useQueryClient()
  const today = regionToday()
  // La misma clave mientras el cajón siga abierto: un reintento no rehace dos veces.
  const [requestId] = React.useState(() => crypto.randomUUID())
  const form = useAppForm({
    defaultValues: { reason: "", promisedOn: "" },
    validators: { onSubmit: remakeSchema },
    onSubmit: async ({ value }) => {
      const created = await remakeOrder(order.id, {
        reason: value.reason.trim(),
        promisedOn: value.promisedOn,
        requestId,
      }).finally(() => invalidateOrders(queryClient))
      queryClient.setQueryData(orderKeys.detail(created.id), created)
      toast.success(
        `Pedido N.º ${order.orderNumber}: se rehace como el N.º ${created.orderNumber}, sin cobrar otra vez.`,
      )
      onRemade(created)
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={`Rehacer el pedido N.º ${order.orderNumber}`}
      description="Sale otro pedido con lo mismo, unido a este y sin cobrar otra vez."
      submitLabel="Rehacer"
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="reason">
          {(field) => <field.TextareaField label="Por qué se rehace" rows={3} maxLength={2000} />}
        </form.AppField>
        <form.AppField name="promisedOn">
          {(field) => (
            <field.Control label="Para cuándo" id="rehacer-para-cuando">
              {(control) => (
                <DatePickerButton
                  id={control.id}
                  aria-invalid={control.invalid || undefined}
                  aria-describedby={control.describedBy}
                  min={today}
                  value={field.state.value}
                  onChange={(next) => {
                    field.handleChange(next)
                    field.handleBlur()
                  }}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}

const voidSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Escribe el motivo.")
    .max(2000, "Escribe como mucho 2000 caracteres."),
})

/**
 * Anular, con su motivo y siempre en cajón: hay que decidir antes de seguir. Lo
 * que no se cobró se anula con él (lo que salió del inventario vuelve); lo ya
 * cobrado queda en su cuenta, y devolverlo es de Cobros.
 */
function VoidDrawer({ order, onClose }: { order: OrderDetail; onClose: () => void }) {
  const queryClient = useQueryClient()
  const form = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: voidSchema },
    onSubmit: async ({ value }) => {
      const updated = await voidOrder(order.id, value.reason.trim()).finally(() =>
        invalidateOrders(queryClient),
      )
      queryClient.setQueryData(orderKeys.detail(updated.id), updated)
      // Sus cargos sin pagar se anulan y lo del inventario vuelve a la sede.
      invalidatePatientAccount(queryClient, order.patientId)
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
      void queryClient.invalidateQueries({ queryKey: ["sale-products"] })
      toast.success(`Pedido N.º ${order.orderNumber} anulado`)
      onClose()
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      dock={false}
      title={`Anular el pedido N.º ${order.orderNumber}`}
      description="Lo que no se cobró se anula con él y lo que salió del inventario vuelve a él. Lo ya cobrado queda en su cuenta: devuélvelo o úsalo desde Cobros."
      submitLabel="Anular el pedido"
    >
      <form.AppField name="reason">
        {(field) => <field.TextareaField label="Motivo" rows={3} maxLength={2000} />}
      </form.AppField>
    </FormDrawer>
  )
}
