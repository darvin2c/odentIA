/**
 * Una compra al lado de la lista (tablero 8, `?orden=`): sus productos en
 * unidades de compra, lo que llegó y, para quien ve precios, el bloque de pago
 * de siempre (ADR 0061). Un borrador lleva «Editar» y «Confirmar pedido»; una
 * compra pedida, «Registrar lo que llegó» y «Copiar el pedido», y en «⋯»
 * «Cerrar con lo recibido» y «Cancelar la compra».
 */
import { formatMoney } from "@odentia/clinical"
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FieldDescription,
  FieldLabel,
  RadioGroup,
  RadioGroupItem,
  Textarea,
  toast,
} from "@odentia/ui"
import { ConfirmDialog, DetailDrawer, DetailSection, FormDrawer, submitForm, useAppForm, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { MoreHorizontal } from "lucide-react"
import * as React from "react"
import { z } from "zod"
import { invalidateFinance, voidSupplierCreditUseApi } from "../../lib/finance-cash"
import {
  cancelOrder,
  closeOrder,
  confirmOrder,
  dayText,
  fetchOrder,
  formatWhole,
  hasPrices,
  inventoryErrorMessage,
  inventoryKeys,
  moneyText,
  ORDER_STATUS_WORDS,
  orderMessage,
  type PurchaseOrderDetail,
  type PurchaseOrderView,
  type PurchasePayment,
  purchaseQuantityText,
  supplierShortName,
  unitsText,
  withArticle,
  clinicDayOf,
} from "../../lib/inventory"
import { QueryErrorState } from "../../lib/query-error"
import { PurchasePaymentDrawer } from "./purchase-payment-drawer"
import { VoidDrawer } from "../finance/void-drawer"
import { Chip } from "./fields"
import { useInventory } from "./inventory-scope"

const ROW = "flex items-start justify-between gap-3 py-2"
const SMALL = "block text-xs text-muted-foreground"

const pending = (status: string) => status === "confirmada" || status === "parcialmente_recibida"

/** «Llega a Sede Miraflores · pedida el 12 oct por Dra. Ana Torres». */
function arrivalLine(order: PurchaseOrderView): string {
  const where = `Llega a ${order.branchName ?? "la sede"}${order.warehouseIsDefault ? "" : ` (${order.warehouseName})`}`
  const when = dayText(clinicDayOf(order.createdAt))
  const by = order.createdByName ? ` por ${order.createdByName}` : ""
  return order.status === "borrador" ? `${where} · borrador del ${when}${by ? ` de ${order.createdByName}` : ""}` : `${where} · pedida el ${when}${by}`
}

export function PurchasePanel({ orderId, onClose }: { orderId: string | null; onClose: () => void }) {
  const query = useQuery({
    queryKey: inventoryKeys.order(orderId ?? ""),
    queryFn: () => fetchOrder(orderId as string),
    enabled: orderId !== null,
  })
  const order = query.data
  return (
    <DetailDrawer
      open={orderId !== null}
      onClose={onClose}
      size="lg"
      title={order ? `${order.label} · ${order.supplierName ?? "Proveedor"}` : "Compra"}
      description={order ? arrivalLine(order) : undefined}
      isLoading={query.isPending && orderId !== null}
      headerContent={order ? <OrderActions order={order} /> : undefined}
    >
      {query.isError && !order ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} notFound="Esta compra ya no está disponible." />
      ) : order ? (
        <OrderBody order={order} />
      ) : null}
    </DetailDrawer>
  )
}

function OrderActions({ order }: { order: PurchaseOrderView }) {
  const { can, open, clinicName } = useInventory()
  const queryClient = useQueryClient()
  const [copying, setCopying] = React.useState(false)
  const [closing, setClosing] = React.useState(false)
  const [cancelling, setCancelling] = React.useState<"plain" | "paid" | null>(null)
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    invalidateFinance(queryClient)
  }
  const confirm = useMutation({
    mutationFn: () => confirmOrder(order.id),
    onSuccess: () => {
      toast.success(`${order.label} quedó pedida. Ya se puede registrar lo que llegue.`)
      refresh()
    },
    onError: (error) => toast.error(inventoryErrorMessage(error)),
  })
  // Cerrar y cancelar se confirman en un diálogo: el motivo del rechazo se dice ahí, no en un aviso detrás.
  const close = useMutation({
    mutationFn: () => closeOrder(order.id),
    onSuccess: () => {
      setClosing(false)
      toast.success(`${order.label} quedó cerrada con lo que llegó.`)
      refresh()
    },
  })
  const cancel = useMutation({
    mutationFn: (payments?: "anular" | "a_favor") => cancelOrder(order.id, payments),
    onSuccess: () => {
      setCancelling(null)
      toast.success(`${order.label} quedó cancelada.`)
      refresh()
    },
  })
  const paid = order.balance?.paidCents ?? 0
  const startCancel = () => setCancelling(paid > 0 ? "paid" : "plain")
  const status = order.status
  const draft = status === "borrador"
  const open_ = pending(status)
  const menu: Array<{ key: string; label: string; onClick: () => void; danger?: boolean }> = []
  if (draft || open_) menu.push({ key: "copiar", label: "Copiar el pedido", onClick: () => setCopying(true) })
  if (can.write && open_ && order.received) menu.push({ key: "cerrar", label: "Cerrar con lo recibido", onClick: () => setClosing(true) })
  if (can.write && (draft || status === "confirmada") && !order.received)
    menu.push({ key: "cancelar", label: "Cancelar la compra", onClick: startCancel, danger: true })
  // «Copiar el pedido» va a la vista en una compra pedida; en el borrador, en «⋯».
  const copyVisible = open_
  const menuItems = copyVisible ? menu.filter((item) => item.key !== "copiar") : menu

  const closeText = (() => {
    const parts = order.lines.map((line) => {
      const unit = line.purchaseUnit ?? line.unit
      return `${formatWhole(line.receivedQuantity)} de ${unitsText(line.quantity, unit)} de ${line.productName}`
    })
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} y ${parts.at(-1)}` : (parts[0] ?? "")
    return `${order.label} queda cerrada con lo que llegó: ${list}.`
  })()

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Chip tone={draft ? "muted" : status === "parcialmente_recibida" ? "warn" : status === "recibida" ? "ok" : "muted"}>
        {ORDER_STATUS_WORDS[status] ?? status}
      </Chip>
      {draft && can.write ? (
        <>
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => open.editPurchase(order)}>
            Editar
          </Button>
          <Button
            type="button"
            size="sm"
            className="min-h-11 sm:min-h-8"
            disabled={confirm.isPending}
            onClick={() => {
              // Un borrador guardado sin precio no se pide a 0: se abre con esas filas marcadas.
              if (order.lines.some((line) => !line.unitCostCents)) open.editPurchase(order, { missingPrices: true })
              else confirm.mutate()
            }}
          >
            Confirmar pedido
          </Button>
        </>
      ) : null}
      {open_ && can.receive ? (
        <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={() => open.receive(order.id)}>
          Registrar lo que llegó
        </Button>
      ) : null}
      {copyVisible ? (
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setCopying(true)}>
          Copiar el pedido
        </Button>
      ) : null}
      {menuItems.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button type="button" variant="ghost" size="sm" className="min-h-11 min-w-11 sm:min-h-8" aria-label={`Más acciones de ${order.label}`} />}
          >
            <MoreHorizontal aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {menuItems.map((item) => (
              <DropdownMenuItem key={item.key} className={item.danger ? "text-destructive" : undefined} onClick={item.onClick}>
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {copying ? (
        <CopyOrderDrawer text={orderMessage({ ...order, lines: order.lines }, clinicName)} onClose={() => setCopying(false)} />
      ) : null}
      <ConfirmDialog
        open={closing}
        variant="default"
        title="Cerrar con lo recibido"
        description={closeText}
        confirmLabel="Cerrar la compra"
        cancelLabel="Volver"
        pending={close.isPending}
        error={close.error ? inventoryErrorMessage(close.error) : null}
        onClose={() => {
          setClosing(false)
          close.reset()
        }}
        onConfirm={() => close.mutate()}
      >
        <p className="text-sm text-muted-foreground">
          Lo que no llegó deja de esperarse.
          {can.prices
            ? ` Si pagaste por adelantado más de lo recibido, la diferencia queda a favor con ${supplierShortName(order.supplierName ?? "el proveedor")}.`
            : ""}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={cancelling === "plain"}
        title={`Cancelar ${order.label}`}
        description="La compra queda cancelada: ya no se espera nada de ella. Sigue en la lista con su historia."
        confirmLabel="Cancelar la compra"
        cancelLabel="Volver"
        pending={cancel.isPending}
        error={cancel.error ? inventoryErrorMessage(cancel.error) : null}
        onClose={() => {
          setCancelling(null)
          cancel.reset()
        }}
        onConfirm={() => cancel.mutate(undefined)}
      />
      <CancelPaidDialog
        order={cancelling === "paid" ? order : null}
        canPay={can.pay}
        onClose={() => {
          setCancelling(null)
          cancel.reset()
        }}
        onConfirm={(payments) => cancel.mutateAsync(payments)}
      />
    </div>
  )
}

/** «Copiar el pedido»: el texto listo para WhatsApp o un correo. odentIA no envía nada. */
function CopyOrderDrawer({ text, onClose }: { text: string; onClose: () => void }) {
  const ids = React.useId()
  const area = React.useRef<HTMLTextAreaElement>(null)
  const [error, setError] = React.useState<string | null>(null)
  return (
    <FormDrawer
      open
      onClose={onClose}
      title="Copiar el pedido"
      description="Lo que se copia para pegar en WhatsApp o en un correo"
      error={error}
      submitLabel="Copiar"
      cancelLabel="Cerrar"
      onSubmit={(event) => {
        event.preventDefault()
        const select = () => {
          area.current?.focus()
          area.current?.select()
        }
        if (!navigator.clipboard?.writeText) {
          select()
          setError("Este navegador no deja copiar solo: el texto quedó seleccionado, cópialo con Ctrl+C o manteniéndolo presionado.")
          return
        }
        navigator.clipboard.writeText(text).then(
          () => {
            toast.success("Pedido copiado: pégalo en WhatsApp o en un correo al proveedor.")
            onClose()
          },
          () => {
            select()
            setError("No se pudo copiar solo: el texto quedó seleccionado, cópialo con Ctrl+C o manteniéndolo presionado.")
          },
        )
      }}
    >
      <Field>
        <FieldLabel htmlFor={`${ids}-texto`}>El pedido</FieldLabel>
        <Textarea id={`${ids}-texto`} ref={area} readOnly rows={Math.min(14, text.split("\n").length + 1)} value={text} aria-describedby={`${ids}-ayuda`} />
        <FieldDescription id={`${ids}-ayuda`}>No se envía nada: el mensaje lo mandas tú.</FieldDescription>
      </Field>
    </FormDrawer>
  )
}

const cancelPaidSchema = z.object({
  payments: z.string().refine((value) => value === "anular" || value === "a_favor", "Elige qué pasa con lo pagado."),
})

/** Cancelar una compra con pagos: anularlos (el proveedor devolvió el dinero) o dejarlos a favor. */
function CancelPaidDialog({
  order,
  canPay,
  onClose,
  onConfirm,
}: {
  order: PurchaseOrderView | null
  canPay: boolean
  onClose: () => void
  /** La cancelación (`mutateAsync`): si la rechaza, el motivo se dice en el diálogo. */
  onConfirm: (payments: "anular" | "a_favor") => Promise<unknown>
}) {
  const { locale } = useInventory()
  const form = useAppForm({
    defaultValues: { payments: "" },
    validators: { onSubmit: cancelPaidSchema },
    onSubmit: async ({ value }) => {
      await onConfirm(value.payments as "anular" | "a_favor")
    },
  })
  const error = useFormSubmitError(form)
  const busy = useStore(form.store, (state) => state.isSubmitting)
  // Cada apertura empieza sin elegir.
  React.useEffect(() => {
    if (order) form.reset()
  }, [order, form])
  const paid = order?.balance?.paidCents ?? 0
  // Nunca se supone una moneda: la de la orden, y sin orden no hay importe que decir.
  const money = (cents: number) => (order ? formatMoney(cents, order.currency, locale) : "")
  return (
    <ConfirmDialog
      open={order !== null}
      title={order ? `Cancelar ${order.label}` : "Cancelar la compra"}
      description={
        canPay
          ? `Esta compra ya tiene ${money(paid)} pagados. Elige qué pasa con ese dinero: nunca queda suelto.`
          : `Esta compra ya tiene ${money(paid)} pagados: cancelarla la hace quien registra los pagos (caja).`
      }
      confirmLabel="Cancelar la compra"
      cancelLabel="Volver"
      pending={busy}
      error={error}
      // Sin permiso de pagos no se cancela: la descripción dice quién lo hace.
      confirmDisabled={!canPay}
      onClose={onClose}
      onConfirm={() => void submitForm(form)}
    >
      {canPay ? (
        <form.AppField name="payments">
          {(field) => (
            <field.Group legend="Qué pasa con lo pagado">
              {(control) => (
                <RadioGroup
                  name={control.name}
                  value={field.state.value}
                  aria-invalid={control.invalid || undefined}
                  aria-describedby={control.describedBy}
                  onValueChange={(value) => {
                    field.handleChange(String(value))
                    field.handleBlur()
                  }}
                  className="flex flex-col gap-2"
                >
                  <FieldLabel className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 font-normal">
                    <RadioGroupItem value="a_favor" className="mt-0.5" aria-invalid={control.invalid || undefined} />
                    <span>
                      <strong>Dejarlo a favor con {order?.supplierName ?? "el proveedor"}</strong>
                      <br />
                      <span className="text-sm text-muted-foreground">Se usa al pagar su próxima compra.</span>
                    </span>
                  </FieldLabel>
                  <FieldLabel className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 font-normal">
                    <RadioGroupItem value="anular" className="mt-0.5" aria-invalid={control.invalid || undefined} />
                    <span>
                      <strong>Anular los pagos</strong>
                      <br />
                      <span className="text-sm text-muted-foreground">El proveedor devolvió el dinero: los gastos quedan anulados con su motivo.</span>
                    </span>
                  </FieldLabel>
                </RadioGroup>
              )}
            </field.Group>
          )}
        </form.AppField>
      ) : null}
    </ConfirmDialog>
  )
}

function OrderBody({ order }: { order: PurchaseOrderView }) {
  const { can } = useInventory()
  const priced = hasPrices(order) ? order : null
  return (
    <div className="flex flex-col gap-6">
      <DetailSection title="Productos">
        <ul className="flex flex-col divide-y text-sm">
          {order.lines.map((line) => {
            const unit = line.purchaseUnit ?? line.unit
            const price =
              can.prices && line.unitCostCents !== undefined ? `${moneyText(line.unitCostCents, order.currency)} ${withArticle(unit)}` : null
            const asked =
              can.prices && line.orderedUnitCostCents != null ? `pediste a ${moneyText(line.orderedUnitCostCents, order.currency)}` : null
            return (
              <li key={line.id} className={ROW}>
                <span className="min-w-0">
                  <span className="block font-medium">{line.productName}</span>
                  <span className={SMALL}>{[purchaseQuantityText(line.quantity, line), price, asked].filter(Boolean).join(" · ")}</span>
                </span>
                <span className="text-right whitespace-nowrap tabular-nums">
                  {order.status === "borrador"
                    ? can.prices && line.subtotalCents !== undefined
                      ? moneyText(line.subtotalCents, order.currency)
                      : null
                    : `${line.receivedQuantity === 1 ? "llegó" : "llegaron"} ${formatWhole(line.receivedQuantity)}`}
                </span>
              </li>
            )
          })}
          {priced ? (
            <li className={cn(ROW, "font-semibold")}>
              <span>Total</span>
              <span className="tabular-nums">{moneyText(priced.totalCents, order.currency)}</span>
            </li>
          ) : null}
        </ul>
      </DetailSection>
      {order.notes ? (
        <DetailSection title="Notas">
          <p className="text-sm whitespace-pre-wrap">{order.notes}</p>
        </DetailSection>
      ) : null}
      {priced?.balance && order.status !== "borrador" ? <PaymentBlock order={priced} /> : null}
    </div>
  )
}

/** El pago de la compra, tal como se aprobó en Reportes (ADR 0061). */
function PaymentBlock({ order }: { order: PurchaseOrderDetail }) {
  const { can, locale, timeZone } = useInventory()
  const queryClient = useQueryClient()
  const [paying, setPaying] = React.useState(false)
  const [voidingCredit, setVoidingCredit] = React.useState<PurchasePayment | null>(null)
  const voidCredit = useMutation({
    mutationFn: (input: { id: string; reason: string }) => voidSupplierCreditUseApi(input.id, input.reason),
    onSuccess: () => {
      toast.success("Uso anulado: vuelve a estar a favor con el proveedor y esta compra lo vuelve a deber")
      setVoidingCredit(null)
      invalidateFinance(queryClient)
    },
  })
  const balance = order.balance
  if (!balance) return null
  const money = (cents: number) => formatMoney(cents, order.currency, locale)
  const payable = can.pay && order.status !== "borrador" && order.status !== "cancelada"
  const restToAdvance = Math.max(0, balance.orderedCents - balance.paidCents)
  /** El mes del pago en la zona de la clínica: «Ver gasto» abre ese mes de Gastos. */
  const monthOf = (iso: string): { year: number; month: number } => {
    const [year, month] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).format(new Date(iso)).split("-").map(Number)
    return { year: year ?? 0, month: month ?? 0 }
  }
  const closed = order.status === "recibida" || order.status === "cancelada" || order.status === "cerrada"
  return (
    <DetailSection title="Pago">
      <section aria-label="Pago de la compra" className="flex flex-col gap-2.5">
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col rounded-md bg-muted/50 px-2.5 py-2">
            <span className="text-xs font-bold text-muted-foreground">Recibido</span>
            <strong className="tabular-nums">{money(balance.receivedCents)}</strong>
          </div>
          <div className="flex flex-col rounded-md bg-muted/50 px-2.5 py-2">
            <span className="text-xs font-bold text-muted-foreground">Pagado</span>
            <strong className="tabular-nums">{money(balance.paidCents)}</strong>
          </div>
          <div
            className={cn(
              "flex flex-col rounded-md px-2.5 py-2",
              balance.dueCents > 0 ? "bg-warning-soft text-warning" : balance.aheadCents > 0 ? "bg-primary-soft text-primary-soft-foreground" : "bg-success-soft text-success",
            )}
          >
            <span className="text-xs font-bold">{balance.dueCents > 0 ? "Por pagar" : balance.aheadCents > 0 ? (closed ? "A favor" : "Adelantado") : "Por pagar"}</span>
            <strong className="tabular-nums">{money(balance.dueCents > 0 ? balance.dueCents : balance.aheadCents)}</strong>
          </div>
        </div>
        <div
          role="img"
          aria-label={`De ${money(balance.orderedCents)} pedidos: pagado ${money(Math.min(balance.paidCents, balance.orderedCents))}, recibido sin pagar ${money(balance.dueCents)}, falta recibir ${money(Math.max(0, balance.orderedCents - balance.receivedCents))}`}
          className="flex h-3 gap-0.5 overflow-hidden rounded"
        >
          <span className="h-full bg-series-1" style={{ flex: `${Math.min(balance.paidCents, balance.orderedCents)} 1 0` }} />
          <span className="h-full bg-series-2" style={{ flex: `${balance.dueCents} 1 0` }} />
          <span className="h-full flex-1 bg-secondary" style={{ flex: `${Math.max(0, balance.orderedCents - Math.max(balance.receivedCents, balance.paidCents))} 1 0` }} />
        </div>
        <ul className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-foreground/80">
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-[3px] bg-series-1" />
            Pagado
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-[3px] bg-series-2" />
            Recibido sin pagar
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-[3px] bg-secondary" />
            Falta recibir
          </li>
        </ul>
        {order.supplierCreditCents > 0 ? (
          <p className="text-sm">
            A favor con {order.supplierName}: <strong>{money(order.supplierCreditCents)}</strong>, para pagar una próxima compra.
          </p>
        ) : null}
        {payable ? (
          <Button
            type="button"
            variant={balance.dueCents > 0 ? "default" : "outline"}
            className="min-h-11 self-start sm:min-h-9"
            disabled={balance.dueCents === 0 && restToAdvance === 0}
            onClick={() => setPaying(true)}
          >
            {balance.dueCents > 0
              ? `Registrar pago de ${money(balance.dueCents)}`
              : balance.receivedCents === 0
                ? balance.paidCents > 0
                  ? "Registrar otro adelanto"
                  : "Registrar un adelanto"
                : "Adelantar lo que falta recibir"}
          </Button>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <strong className="text-sm">Pagos</strong>
          {order.payments.length === 0 ? (
            <span className="text-sm text-muted-foreground">Todavía no hay pagos.</span>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {order.payments.map((item) => (
                <li key={item.id} className={cn("flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm", item.voidedAt && "text-muted-foreground line-through")}>
                  <span className="flex flex-col">
                    <strong className="tabular-nums">{money(item.amountCents)}</strong>
                    <span className="text-xs text-muted-foreground">
                      {[
                        new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone }).format(new Date(item.paidAt)).replace(/\./g, ""),
                        item.kind === "a_favor" ? "con lo que se tenía a favor" : item.fromCash ? "efectivo de la caja" : null,
                        item.receiptKind && item.receiptKind !== "ninguno" ? `${item.receiptKind}${item.receiptNumber ? ` ${item.receiptNumber}` : ""}` : null,
                        item.byName,
                        item.voidedAt ? "anulado" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  {item.kind === "pago" ? (
                    can.finance ? (
                      <Link to="/finance" search={{ tab: "gastos", branch: balance.branchId, ...monthOf(item.paidAt) }} className="text-sm font-semibold text-primary-soft-foreground">
                        Ver gasto
                      </Link>
                    ) : null
                  ) : can.pay && !item.voidedAt ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Anular el uso de ${money(item.amountCents)} a favor`}
                      onClick={() => setVoidingCredit(item)}
                    >
                      Anular
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      {paying ? <PurchasePaymentDrawer order={order} locale={locale} timeZone={timeZone} open={paying} onClose={() => setPaying(false)} /> : null}
      <VoidDrawer
        open={voidingCredit !== null}
        title="Anular lo usado a favor"
        description={
          voidingCredit
            ? `${money(voidingCredit.amountCents)} vuelven a estar a favor con ${order.supplierName ?? "el proveedor"} y esta compra los vuelve a deber. Queda en el historial con su motivo.`
            : ""
        }
        onClose={() => setVoidingCredit(null)}
        onConfirm={(reason) => (voidingCredit ? voidCredit.mutateAsync({ id: voidingCredit.id, reason }) : Promise.resolve())}
      />
    </DetailSection>
  )
}
