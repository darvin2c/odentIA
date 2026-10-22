/**
 * Registrar lo que llegó (tableros 10 y 15): lo hace quien recibe la caja. Una
 * tarjeta por producto con «Llegaron» puesto en lo que falta: si llegó todo,
 * un botón. Lote y vencimiento se abren solos si el producto los suele tener
 * (o con «+ Lote y vencimiento»); «+ Llegó en otro lote» suma otra fila. El
 * precio de la factura lo corrige solo quien lleva las compras. Una clave por
 * formulario abierto: un reintento no registra dos veces.
 */
import { formatMoneyInput, parseMoney, unitFor } from "@odentia/clinical"
import { Button, Field, FieldDescription, FieldError, FieldGroup, FieldLabel, Input, toast } from "@odentia/ui"
import { DatePickerButton, FormDrawer, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import * as React from "react"
import {
  fetchOrder,
  fetchProducts,
  formatWhole,
  inventoryErrorMessage,
  inventoryKeys,
  moneyText,
  newKey,
  parseWhole,
  type PurchaseLine,
  type PurchaseOrderView,
  receiveOrder,
  unitsText,
} from "../../lib/inventory"
import { QueryErrorState } from "../../lib/query-error"
import { MoneyInput, Optional, QuantityInput } from "./fields"
import { useInventory } from "./inventory-scope"

interface LotDraft {
  quantity: string
  lotCode: string
  expiresAt: string
}

interface LineDraft {
  lots: LotDraft[]
  lotOpen: boolean
  price: string
}

export function ReceiveDrawer({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const query = useQuery({ queryKey: inventoryKeys.order(orderId), queryFn: () => fetchOrder(orderId) })
  const order = query.data
  if (!order) {
    return (
      <FormDrawer open onClose={onClose} title="Registrar lo que llegó" hideSubmit cancelLabel="Cerrar" onSubmit={(event) => event.preventDefault()}>
        {query.isError ? (
          <QueryErrorState error={query.error} onRetry={() => void query.refetch()} notFound="Esta compra ya no está disponible." />
        ) : (
          <LoadingState message="Cargando la compra…" />
        )}
      </FormDrawer>
    )
  }
  return <ReceiveForm order={order} onClose={onClose} />
}

function ReceiveForm({ order, onClose }: { order: PurchaseOrderView; onClose: () => void }) {
  const { can, locale } = useInventory()
  const queryClient = useQueryClient()
  const ids = React.useId()
  const lines = order.lines.filter((line) => line.pendingQuantity > 0)
  const priced = can.write && can.prices
  const [initial] = React.useState<Record<string, LineDraft>>(() =>
    Object.fromEntries(
      lines.map((line) => [
        line.id,
        {
          lots: [{ quantity: formatWhole(line.pendingQuantity, locale), lotCode: "", expiresAt: "" }],
          lotOpen: line.tracksLots,
          price: priced && line.unitCostCents !== undefined ? formatMoneyInput(line.unitCostCents, order.currency, locale) : "",
        },
      ]),
    ),
  )
  const [drafts, setDrafts] = React.useState(initial)
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [key, setKey] = React.useState(newKey)
  const dirty = JSON.stringify(drafts) !== JSON.stringify(initial)
  const sede = useQuery({
    queryKey: inventoryKeys.products(order.branchId ?? "", "", ""),
    queryFn: () => fetchProducts(order.branchId ?? ""),
    enabled: Boolean(order.branchId),
  })
  const shortageOf = (productId: string) => sede.data?.items.find((item) => item.id === productId)?.shortage ?? 0
  const update = (lineId: string, patch: (draft: LineDraft) => LineDraft) =>
    setDrafts((current) => ({ ...current, [lineId]: patch(current[lineId] as LineDraft) }))
  const arrivedOf = (draft: LineDraft | undefined) =>
    (draft?.lots ?? []).reduce((sum, lot) => {
      const parsed = parseWhole(lot.quantity)
      return sum + (parsed !== null && !Number.isNaN(parsed) ? parsed : 0)
    }, 0)

  const mutation = useMutation({
    mutationFn: (body: Parameters<typeof receiveOrder>[1]) => receiveOrder(order.id, body),
    onSuccess: (saved) => {
      setKey(newKey())
      toast.success(saved.complete ? `Se registró lo que llegó: ${order.label} llegó completa.` : `Se registró lo que llegó de ${order.label}.`)
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
      onClose()
    },
  })

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (mutation.isPending) return
    const found: Record<string, string> = {}
    const body: Parameters<typeof receiveOrder>[1]["lines"] = []
    for (const line of lines) {
      const draft = drafts[line.id]
      if (!draft) continue
      const unit = line.purchaseUnit ?? line.unit
      const lots: Array<{ quantity: number; lotCode: string | null; expiresAt: string | null }> = []
      let bad = false
      for (const lot of draft.lots) {
        const parsed = parseWhole(lot.quantity)
        if (parsed !== null && Number.isNaN(parsed)) bad = true
        else if (parsed && parsed > 0) lots.push({ quantity: parsed, lotCode: draft.lotOpen ? lot.lotCode.trim() || null : null, expiresAt: draft.lotOpen ? lot.expiresAt || null : null })
      }
      const arrived = lots.reduce((sum, lot) => sum + lot.quantity, 0)
      if (bad) found[line.id] = "Escribe cuánto llegó con un número entero."
      else if (arrived > line.pendingQuantity) found[line.id] = `Llegó más de lo que falta: ${line.pendingQuantity === 1 ? "falta" : "faltan"} ${unitsText(line.pendingQuantity, unit)}.`
      let unitCostCents: number | undefined
      if (priced && line.unitCostCents !== undefined && draft.price.trim()) {
        try {
          const cents = parseMoney(draft.price, order.currency, locale)
          if (cents !== line.unitCostCents) unitCostCents = cents
        } catch (error) {
          found[`${line.id}-precio`] = error instanceof Error ? `${error.message}.` : "El precio no es un importe válido."
        }
      }
      if (!found[line.id] && arrived > 0) body.push({ productId: line.productId, lots, ...(unitCostCents !== undefined ? { unitCostCents } : {}) })
    }
    if (Object.keys(found).length === 0 && body.length === 0) found.form = "Escribe cuánto llegó de al menos un producto."
    setErrors(found)
    if (Object.keys(found).length > 0) return
    mutation.mutate({ idempotencyKey: key, lines: body })
  }

  const noticeLines = lines.filter((line) => shortageOf(line.productId) > 0)

  return (
    <FormDrawer
      open
      onClose={onClose}
      title="Registrar lo que llegó"
      description={[order.label, order.supplierName, order.branchName].filter(Boolean).join(" · ")}
      error={errors.form ?? (mutation.error ? inventoryErrorMessage(mutation.error) : null)}
      isDirty={dirty}
      isSubmitting={mutation.isPending}
      submitDisabled={lines.length === 0}
      submitLabel="Registrar lo que llegó"
      cancelLabel="Cancelar"
      onSubmit={submit}
    >
      <FieldGroup className="gap-4">
        {lines.length === 0 ? <p className="text-sm text-muted-foreground">Ya llegó todo lo de esta compra.</p> : null}
        {lines.map((line) => (
          <LineCard
            key={line.id}
            ids={`${ids}-${line.id}`}
            line={line}
            order={order}
            draft={drafts[line.id] as LineDraft}
            arrived={arrivedOf(drafts[line.id])}
            priced={priced}
            error={errors[line.id]}
            priceError={errors[`${line.id}-precio`]}
            onChange={(patch) => update(line.id, patch)}
          />
        ))}
        {noticeLines.map((line) => {
          const shortage = shortageOf(line.productId)
          return (
            <p key={line.id} className="rounded-md bg-primary-soft px-3 py-2 text-sm text-primary-soft-foreground">
              {arrivedOf(drafts[line.id]) > 0 ? `Lo que llega de ${line.productName} cubre primero` : `Cuando llegue ${line.productName}, cubrirá primero`}{" "}
              {unitsText(shortage, line.unit)} que se {shortage === 1 ? "usó" : "usaron"} sin haber.
            </p>
          )
        })}
      </FieldGroup>
    </FormDrawer>
  )
}

function LineCard({
  ids,
  line,
  order,
  draft,
  arrived,
  priced,
  error,
  priceError,
  onChange,
}: {
  ids: string
  line: PurchaseLine
  order: PurchaseOrderView
  draft: LineDraft
  arrived: number
  priced: boolean
  error?: string
  priceError?: string
  onChange: (patch: (draft: LineDraft) => LineDraft) => void
}) {
  const { locale } = useInventory()
  const unit = line.purchaseUnit ?? line.unit
  const factor = line.purchaseUnit ? line.unitFactor : 1
  const setLot = (index: number, patch: Partial<LotDraft>) =>
    onChange((current) => ({ ...current, lots: current.lots.map((lot, at) => (at === index ? { ...lot, ...patch } : lot)) }))
  const showLots = draft.lotOpen && arrived > 0
  const invoice = (() => {
    if (!priced || line.unitCostCents === undefined) return null
    try {
      return draft.price.trim() ? parseMoney(draft.price, order.currency, locale) : null
    } catch {
      return null
    }
  })()
  const asked = line.orderedUnitCostCents ?? line.unitCostCents
  return (
    <section aria-labelledby={`${ids}-nombre`} className="flex flex-col gap-3 rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`${ids}-nombre`} className="text-sm font-semibold">
          {line.productName}
        </h3>
        <span className="text-xs text-muted-foreground">
          {line.pendingQuantity === 1 ? "falta" : "faltan"} {unitsText(line.pendingQuantity, unit)}
        </span>
      </div>
      {draft.lots.map((lot, index) => {
        const parsed = parseWhole(lot.quantity)
        const count = parsed !== null && !Number.isNaN(parsed) ? parsed : 0
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: los lotes de una tarjeta solo se agregan al final o se quitan por su lugar.
          <div key={index} className="grid gap-2 sm:grid-cols-3">
            <Field data-invalid={error ? true : undefined} className="gap-1">
              <FieldLabel htmlFor={`${ids}-llegaron-${index}`}>
                {draft.lots.length > 1 ? `Llegaron (lote ${index + 1})` : "Llegaron"}
                <span className="sr-only"> de {line.productName}</span>
              </FieldLabel>
              <QuantityInput
                id={`${ids}-llegaron-${index}`}
                value={lot.quantity}
                suffix={unitFor(count === 1 ? 1 : 2, unit)}
                invalid={Boolean(error)}
                onChange={(next) => setLot(index, { quantity: next })}
              />
              {factor > 1 && count > 0 ? <FieldDescription>Son {unitsText(count * factor, line.unit)}.</FieldDescription> : null}
            </Field>
            {showLots ? (
              <>
                <Field className="gap-1">
                  <FieldLabel htmlFor={`${ids}-lote-${index}`}>
                    Lote <span className="sr-only">de {line.productName}</span> <Optional />
                  </FieldLabel>
                  <Input id={`${ids}-lote-${index}`} maxLength={120} value={lot.lotCode} onChange={(event) => setLot(index, { lotCode: event.target.value })} />
                </Field>
                <Field className="gap-1">
                  <FieldLabel htmlFor={`${ids}-vence-${index}`}>
                    Vence<span className="sr-only"> {line.productName}</span>
                  </FieldLabel>
                  <div className="flex items-center gap-1">
                    <DatePickerButton id={`${ids}-vence-${index}`} className="w-full min-w-0" value={lot.expiresAt} emptyLabel="Sin vencimiento" onChange={(next) => setLot(index, { expiresAt: next })} />
                    {index > 0 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11 shrink-0"
                        aria-label={`Quitar el lote ${index + 1} de ${line.productName}`}
                        onClick={() => onChange((current) => ({ ...current, lots: current.lots.filter((_, at) => at !== index) }))}
                      >
                        <X aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                </Field>
              </>
            ) : null}
          </div>
        )
      })}
      {error ? <FieldError>{error}</FieldError> : null}
      {arrived === 0 ? (
        <p className="text-xs text-muted-foreground">No llegó: lote y vencimiento no se piden.</p>
      ) : draft.lotOpen ? (
        <Button
          type="button"
          variant="link"
          className="h-auto min-h-11 self-start p-0 text-xs sm:min-h-0"
          onClick={() => onChange((current) => ({ ...current, lots: [...current.lots, { quantity: "", lotCode: "", expiresAt: "" }] }))}
        >
          + Llegó en otro lote
        </Button>
      ) : (
        <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0 text-xs sm:min-h-0" onClick={() => onChange((current) => ({ ...current, lotOpen: true }))}>
          + Lote y vencimiento
        </Button>
      )}
      {priced && line.unitCostCents !== undefined ? (
        <Field data-invalid={priceError ? true : undefined} className="gap-1">
          <FieldLabel htmlFor={`${ids}-precio`}>Precio de la factura</FieldLabel>
          <MoneyInput
            id={`${ids}-precio`}
            currency={order.currency}
            value={draft.price}
            invalid={Boolean(priceError)}
            aria-describedby={`${ids}-precio-ayuda`}
            onChange={(next) => onChange((current) => ({ ...current, price: next }))}
          />
          <FieldDescription id={`${ids}-precio-ayuda`}>
            {invoice !== null && asked !== undefined && invoice !== asked
              ? `Pediste a ${moneyText(asked, order.currency)}. «Por pagar» se calcula con ${moneyText(invoice, order.currency)}.`
              : `Por ${unitFor(1, unit)}. Si la factura dice otro, escríbelo: «Por pagar» se calcula con él.`}
          </FieldDescription>
          {priceError ? <FieldError>{priceError}</FieldError> : null}
        </Field>
      ) : null}
    </section>
  )
}
