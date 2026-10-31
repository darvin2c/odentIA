/**
 * Registrar lo que llegó (tableros 10 y 15): lo hace quien recibe la caja. Una
 * tarjeta por producto con «Llegaron» puesto en lo que falta: si llegó todo,
 * un botón. Lote y vencimiento se abren solos si el producto los suele tener
 * (o con «+ Lote y vencimiento»); «+ Llegó en otro lote» suma otra fila. El
 * precio de la factura lo corrige solo quien lleva las compras. Una clave por
 * formulario abierto: un reintento no registra dos veces. Cada error va en el
 * lote y la columna que hay que corregir, también los del servidor.
 */
import { formatMoneyInput, parseMoney, unitFor } from "@odentia/clinical"
import { Button, FieldError, FieldGroup, toast } from "@odentia/ui"
import { DatePickerButton, FormDrawer, fieldErrorMessages, LoadingState, useAppForm, useFormSurface, withForm } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import * as React from "react"
import { z } from "zod"
import {
  fetchOrder,
  fetchProducts,
  formatWhole,
  inventoryKeys,
  inventoryUnconfirmedMessage,
  moneyText,
  newKey,
  type PurchaseLine,
  type PurchaseOrderView,
  parseWhole,
  type ReceptionLineBody,
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
  lineId: string
  lots: LotDraft[]
  lotOpen: boolean
  price: string
}

interface ReceiveValues {
  lines: LineDraft[]
}

/** Los mismos topes que la ruta y el servicio (`quantity`, `cents`). */
const MAX_QUANTITY = 1_000_000_000
const MAX_CENTS = 2_147_483_647

/** El precio escrito en la unidad menor de la moneda, o el motivo por el que no se entiende. */
function readPrice(text: string, currency: string, locale: string): { cents: number } | { error: string } {
  try {
    return { cents: parseMoney(text, currency, locale) }
  } catch (error) {
    return { error: error instanceof Error ? `${error.message}.` : "El precio no es un importe válido." }
  }
}

function countOf(text: string): number {
  const parsed = parseWhole(text)
  return parsed !== null && !Number.isNaN(parsed) ? parsed : 0
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
  const lines = order.lines.filter((line) => line.pendingQuantity > 0)
  const priced = can.write && can.prices
  // Se arma una vez al abrir: lo que llega después no pisa lo escrito.
  const [initial] = React.useState<ReceiveValues>(() => ({
    lines: lines.map((line) => ({
      lineId: line.id,
      lots: [{ quantity: formatWhole(line.pendingQuantity, locale), lotCode: "", expiresAt: "" }],
      lotOpen: line.tracksLots,
      price: priced && line.unitCostCents !== undefined ? formatMoneyInput(line.unitCostCents, order.currency, locale) : "",
    })),
  }))
  const [key, setKey] = React.useState(newKey)
  // Viajan solo las tarjetas con algo: `lines[k]` del servidor es la tarjeta `sent[k]`.
  const sent = React.useRef<number[]>([])
  const sede = useQuery({
    queryKey: inventoryKeys.products(order.branchId ?? "", "", ""),
    queryFn: () => fetchProducts(order.branchId ?? ""),
    enabled: Boolean(order.branchId),
  })
  const shortageOf = (productId: string) => sede.data?.items.find((item) => item.id === productId)?.shortage ?? 0
  const lineOf = (lineId: string) => lines.find((line) => line.id === lineId)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `lineOf` se rehace en cada render; las tarjetas que lee salen de `order`, que ya está listada.
  const schema = React.useMemo(
    () =>
      z.custom<ReceiveValues>().superRefine((value, ctx) => {
        value.lines.forEach((draft, index) => {
          const line = lineOf(draft.lineId)
          if (!line) return
          const unit = line.purchaseUnit ?? line.unit
          let arrived = 0
          draft.lots.forEach((lot, at) => {
            const parsed = parseWhole(lot.quantity)
            if (parsed !== null && (Number.isNaN(parsed) || parsed > MAX_QUANTITY))
              ctx.addIssue({ code: "custom", path: ["lines", index, "lots", at, "quantity"], message: "Escribe cuánto llegó con un número entero." })
            else arrived += parsed ?? 0
            if (draft.lotOpen && lot.lotCode.trim().length > 120)
              ctx.addIssue({ code: "custom", path: ["lines", index, "lots", at, "lotCode"], message: "El lote admite hasta 120 caracteres." })
          })
          // Lo que pasa de lo pedido es de la cantidad (con un lote) o de la tarjeta (con varios).
          if (arrived > line.pendingQuantity)
            ctx.addIssue({
              code: "custom",
              path: draft.lots.length > 1 ? ["lines", index, "lots"] : ["lines", index, "lots", 0, "quantity"],
              message: `Llegó más de lo que falta: ${line.pendingQuantity === 1 ? "falta" : "faltan"} ${unitsText(line.pendingQuantity, unit)}.`,
            })
          if (priced && line.unitCostCents !== undefined && draft.price.trim()) {
            const price = readPrice(draft.price, order.currency, locale)
            if ("error" in price) ctx.addIssue({ code: "custom", path: ["lines", index, "price"], message: price.error })
            else if (price.cents > MAX_CENTS) ctx.addIssue({ code: "custom", path: ["lines", index, "price"], message: "El precio es demasiado alto." })
          }
        })
      }),
    [order, priced, locale],
  )

  const mutation = useMutation({
    mutationFn: (body: ReceptionLineBody[]) => receiveOrder(order.id, { idempotencyKey: key, lines: body }),
  })

  const form = useAppForm({
    defaultValues: initial,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const body: ReceptionLineBody[] = []
      const cards: number[] = []
      value.lines.forEach((draft, index) => {
        const line = lineOf(draft.lineId)
        if (!line) return
        const lots = draft.lots
          .filter((lot) => countOf(lot.quantity) > 0)
          .map((lot) => ({
            quantity: countOf(lot.quantity),
            lotCode: draft.lotOpen ? lot.lotCode.trim() || null : null,
            expiresAt: draft.lotOpen ? lot.expiresAt || null : null,
          }))
        if (lots.length === 0) return
        let unitCostCents: number | undefined
        if (priced && line.unitCostCents !== undefined && draft.price.trim()) {
          const price = readPrice(draft.price, order.currency, locale)
          if ("cents" in price && price.cents !== line.unitCostCents) unitCostCents = price.cents
        }
        body.push({ productId: line.productId, lots, ...(unitCostCents !== undefined ? { unitCostCents } : {}) })
        cards.push(index)
      })
      // No es de ninguna tarjeta: se dice junto a los botones.
      if (body.length === 0) throw new Error("Escribe cuánto llegó de al menos un producto.")
      sent.current = cards
      const saved = await mutation.mutateAsync(body)
      setKey(newKey())
      toast.success(saved.complete ? `Se registró lo que llegó: ${order.label} llegó completa.` : `Se registró lo que llegó de ${order.label}.`)
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
      onClose()
    },
  })
  const surface = useFormSurface(form, {
    // El servidor cuenta solo las tarjetas enviadas, y en sus lotes (`lines[0].lots[1].lotCode`).
    fieldMap: (serverField) => {
      const match = /^lines\[(\d+)\](.*)$/.exec(serverField)
      const card = match ? sent.current[Number(match[1])] : undefined
      if (card === undefined || !match) return undefined
      const rest = match[2] ?? ""
      if (rest === ".unitCostCents") return `lines[${card}].price`
      if (rest === ".productId" || rest === ".lots" || rest === "") return `lines[${card}].lots`
      return `lines[${card}]${rest}`
    },
    formMessage: (error) => inventoryUnconfirmedMessage(error),
  })

  const values = useStore(form.store, (state) => state.values)
  const noticeLines = lines.filter((line) => shortageOf(line.productId) > 0)
  const arrivedOf = (lineId: string) => (values.lines.find((draft) => draft.lineId === lineId)?.lots ?? []).reduce((sum, lot) => sum + countOf(lot.quantity), 0)

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title="Registrar lo que llegó"
      description={[order.label, order.supplierName, order.branchName].filter(Boolean).join(" · ")}
      // Sin nada pendiente no hay qué registrar: el cuerpo lo dice.
      submitDisabled={lines.length === 0}
      submitLabel="Registrar lo que llegó"
      cancelLabel="Cancelar"
    >
      <FieldGroup className="gap-4">
        {lines.length === 0 ? <p className="text-sm text-muted-foreground">Ya llegó todo lo de esta compra.</p> : null}
        {values.lines.map((draft, index) => {
          const line = lineOf(draft.lineId)
          return line ? <LineCard key={draft.lineId} form={form} index={index} line={line} order={order} priced={priced} /> : null
        })}
        {noticeLines.map((line) => {
          const shortage = shortageOf(line.productId)
          return (
            <p key={line.id} className="rounded-md bg-primary-soft px-3 py-2 text-sm text-primary-soft-foreground">
              {arrivedOf(line.id) > 0 ? `Lo que llega de ${line.productName} cubre primero` : `Cuando llegue ${line.productName}, cubrirá primero`}{" "}
              {unitsText(shortage, line.unit)} que se {shortage === 1 ? "usó" : "usaron"} sin haber.
            </p>
          )
        })}
      </FieldGroup>
    </FormDrawer>
  )
}

const LineCard = withForm({
  defaultValues: {} as ReceiveValues,
  props: {} as { index: number; line: PurchaseLine; order: PurchaseOrderView; priced: boolean },
  render: function LineCardRender({ form, index, line, order, priced }) {
    const { locale } = useInventory()
    const ids = React.useId()
    const draft = useStore(form.store, (state) => state.values.lines[index])
    if (!draft) return null
    const unit = line.purchaseUnit ?? line.unit
    const factor = line.purchaseUnit ? line.unitFactor : 1
    const arrived = draft.lots.reduce((sum, lot) => sum + countOf(lot.quantity), 0)
    const showLots = draft.lotOpen && arrived > 0
    const invoice = (() => {
      if (!priced || line.unitCostCents === undefined || !draft.price.trim()) return null
      const price = readPrice(draft.price, order.currency, locale)
      return "cents" in price ? price.cents : null
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
        <form.AppField name={`lines[${index}].lots`} mode="array">
          {(lotsField) => {
            const cardErrors = fieldErrorMessages(lotsField.state.meta.errors)
            return (
              <>
                {draft.lots.map((lot, at) => {
                  const count = countOf(lot.quantity)
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: los lotes de una tarjeta solo se agregan al final o se quitan por su lugar.
                    <div key={at} className="grid gap-2 sm:grid-cols-3">
                      <form.AppField name={`lines[${index}].lots[${at}].quantity`}>
                        {(field) => (
                          <field.Control
                            className="gap-1"
                            label={
                              <>
                                {draft.lots.length > 1 ? `Llegaron (lote ${at + 1})` : "Llegaron"}
                                <span className="sr-only"> de {line.productName}</span>
                              </>
                            }
                            description={factor > 1 && count > 0 ? `Son ${unitsText(count * factor, line.unit)}.` : undefined}
                          >
                            {(control) => (
                              <QuantityInput
                                id={control.id}
                                value={field.state.value}
                                suffix={unitFor(count === 1 ? 1 : 2, unit)}
                                invalid={control.invalid || cardErrors.length > 0}
                                aria-describedby={[control.describedBy, cardErrors.length > 0 ? `${ids}-tarjeta-error` : null].filter(Boolean).join(" ") || undefined}
                                onChange={(next) => field.handleChange(next)}
                              />
                            )}
                          </field.Control>
                        )}
                      </form.AppField>
                      {showLots ? (
                        <>
                          <form.AppField name={`lines[${index}].lots[${at}].lotCode`}>
                            {(field) => (
                              <field.TextField
                                className="gap-1"
                                label={
                                  <>
                                    Lote <span className="sr-only">de {line.productName}</span> <Optional />
                                  </>
                                }
                                maxLength={120}
                              />
                            )}
                          </form.AppField>
                          <form.AppField name={`lines[${index}].lots[${at}].expiresAt`}>
                            {(field) => (
                              <field.Control
                                className="gap-1"
                                label={
                                  <>
                                    Vence<span className="sr-only"> {line.productName}</span>
                                  </>
                                }
                              >
                                {(control) => (
                                  <div className="flex items-center gap-1">
                                    <DatePickerButton
                                      {...control.props}
                                      className="w-full min-w-0"
                                      value={field.state.value}
                                      emptyLabel="Sin vencimiento"
                                      onChange={(next) => field.handleChange(next)}
                                    />
                                    {at > 0 ? (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="min-h-11 min-w-11 shrink-0"
                                        aria-label={`Quitar el lote ${at + 1} de ${line.productName}`}
                                        onClick={() => lotsField.removeValue(at)}
                                      >
                                        <X aria-hidden />
                                      </Button>
                                    ) : null}
                                  </div>
                                )}
                              </field.Control>
                            )}
                          </form.AppField>
                        </>
                      ) : null}
                    </div>
                  )
                })}
                {cardErrors.length > 0 ? <FieldError id={`${ids}-tarjeta-error`} errors={cardErrors.map((message) => ({ message }))} /> : null}
                {arrived === 0 ? (
                  <p className="text-xs text-muted-foreground">No llegó: lote y vencimiento no se piden.</p>
                ) : draft.lotOpen ? (
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto min-h-11 self-start p-0 text-xs sm:min-h-0"
                    onClick={() => lotsField.pushValue({ quantity: "", lotCode: "", expiresAt: "" })}
                  >
                    + Llegó en otro lote
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto min-h-11 self-start p-0 text-xs sm:min-h-0"
                    onClick={() => form.setFieldValue(`lines[${index}].lotOpen`, true)}
                  >
                    + Lote y vencimiento
                  </Button>
                )}
              </>
            )
          }}
        </form.AppField>
        {priced && line.unitCostCents !== undefined ? (
          <form.AppField name={`lines[${index}].price`}>
            {(field) => (
              <field.Control
                className="gap-1"
                label="Precio de la factura"
                description={
                  invoice !== null && asked !== undefined && invoice !== asked
                    ? `Pediste a ${moneyText(asked, order.currency)}. «Por pagar» se calcula con ${moneyText(invoice, order.currency)}.`
                    : `Por ${unitFor(1, unit)}. Si la factura dice otro, escríbelo: «Por pagar» se calcula con él.`
                }
              >
                {(control) => (
                  <MoneyInput
                    id={control.id}
                    currency={order.currency}
                    value={field.state.value}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        ) : null}
      </section>
    )
  },
})
