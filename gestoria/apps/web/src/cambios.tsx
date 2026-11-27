import { Button, FieldDescription, FieldGroup, FieldLegend, FieldSet, toast } from "@odentia/ui"
import {
  addSubmitErrors,
  ConfirmDialog,
  clearSubmitErrors,
  ErrorState,
  FormDrawer,
  fieldErrorMessages,
  RadioChips,
  submitForm,
  useAppForm,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { HandCoins, Plus, Repeat, Trash2 } from "lucide-react"
import { type FormEvent, useEffect, useRef, useState } from "react"
import { z } from "zod"
import { MoneyInput } from "./campos"
import { DayChoice } from "./entregas"
import { api } from "./lib/api"
import { CUSTOMER_KEY, CUSTOMERS_KEY, whatsappLink } from "./lib/clientes"
import {
  type ExchangeSummary,
  itemText,
  type OrderDetail,
  RETURN_REASONS,
  type SellableVariant,
  storeToday,
  whatsappWithText,
} from "./lib/pedidos"
import { type DeliveryMethod, money, moneyInput, type PaymentMethod, readMoney } from "./lib/tienda"
import { ORDERS_KEY, Row, useOrderAction } from "./pedidos"
import { useStoreContext } from "./tiendas"

/**
 * Cambiar o devolver después de entregar (tablero 17): el pedido entregado no se toca; el cambio es
 * un pedido nuevo, enlazado, con su entrega y su cobro. Aquí están «Cambio o devolución» (qué vuelve
 * y por qué, qué se lleva y la entrega, en unos pocos toques y sin escribir), los enlaces entre los
 * dos pedidos y «Anotar la devolución» del dinero que sobra. Las cifras las calcula el servidor.
 */

/** «Cambio del 0147» en el cambio, y «Cambio en el 0171» en el pedido entregado. */
export function ExchangeLinks({ order }: { order: OrderDetail }) {
  const { store } = useStoreContext()
  const go = (id: string, number: string) => (
    <Link
      className="font-medium underline"
      to="/tiendas/$id/pedidos"
      params={{ id: store.id }}
      search={{ pedido: id }}
    >
      {number}
    </Link>
  )
  if (!order.exchangeOf && order.exchanges.length === 0) return null
  return (
    <p className="mb-2 rounded-lg bg-surface-muted px-3 py-2 text-sm">
      {order.exchangeOf ? (
        <>
          Cambio del {go(order.exchangeOf.id, order.exchangeOf.number)}. Ese pedido no cambia: su
          total y su pago siguen igual.
        </>
      ) : (
        <>
          {order.exchanges.length === 1 ? "Cambio en el " : "Cambios en el "}
          {order.exchanges.map((e, i) => (
            <span key={e.id}>
              {i > 0 ? (i === order.exchanges.length - 1 ? " y " : ", ") : ""}
              {go(e.id, e.number)}
              {e.state === "anulado" ? " (anulado)" : ""}
            </span>
          ))}
          . Su total y su pago no cambian.
        </>
      )}
    </p>
  )
}

/** Lo que vuelve en un cambio, con lo que se descuenta y si ya llegó a la tienda. */
export function ReturnLines({ order }: { order: OrderDetail }) {
  const { store } = useStoreContext()
  if (order.returns.length === 0) return null
  return (
    <ul className="flex flex-col gap-2 border-t pt-2">
      {order.returns.map((r) => (
        <li key={r.variantId} className="flex items-start justify-between gap-3 text-sm">
          <span className="flex min-w-0 flex-col">
            <span className="font-medium">Vuelve: {itemText(r)}</span>
            <span className="text-xs text-muted-foreground">
              «{r.reason}» ·{" "}
              {r.returnedAt
                ? "ya volvió a tu stock"
                : "entra a tu stock cuando llegue, al marcar «Entregado»"}
            </span>
          </span>
          <span className="tabular-nums">− {money(r.unitCents * r.quantity, store.currency)}</span>
        </li>
      ))}
    </ul>
  )
}

interface ExchangeValues {
  /** Cada línea del pedido que todavía puede volver, en su orden. */
  back: { variantId: string; checked: boolean; quantity: string }[]
  /** Uno de `RETURN_REASONS`, «otro» (y entonces `other`) o nada todavía. */
  reason: string
  other: string
  kind: "cambio" | "devolucion"
  takes: { key: number; variantId: string; quantity: string }[]
  deliveryMethodId: string
  zone: string
  deliveryCost: string
  storePays: boolean
  address: string
  deliverOn: string
  /** Vacío: el que propone el servidor (el del resumen). */
  paymentMethodId: string
  whatsapp: boolean
}

const KIND_OPTIONS = [
  { value: "cambio", label: "Otra talla u otro producto" },
  { value: "devolucion", label: "Nada: es una devolución" },
] as const

const REASON_OPTIONS = [
  ...RETURN_REASONS.map((r) => ({ value: r as string, label: r as string })),
  { value: "otro", label: "Otro motivo" },
]

const whyOf = (v: Pick<ExchangeValues, "reason" | "other">) =>
  v.reason === "otro" ? v.other.trim() : v.reason

/** Lo que se envía, armado de lo que se ve: lo mismo para el resumen y para crear el cambio. */
function bodyOf(v: ExchangeValues, deliveries: DeliveryMethod[], currency: string) {
  const delivery = deliveries.find((d) => d.id === v.deliveryMethodId)
  return {
    returns: v.back
      .filter((b) => b.checked)
      .map((b) => ({ variantId: b.variantId, quantity: Number(b.quantity) || 0 })),
    reason: whyOf(v),
    takes:
      v.kind === "cambio"
        ? v.takes
            .filter((t) => t.variantId)
            .map((t) => ({ variantId: t.variantId, quantity: Number(t.quantity) || 0 }))
        : [],
    deliveryMethodId: v.deliveryMethodId,
    zone: delivery?.cost === "por_zona" ? v.zone || null : null,
    deliveryListCents:
      delivery?.cost === "se_acuerda" && v.deliveryCost.trim()
        ? readMoney(v.deliveryCost, currency)
        : null,
    storePaysDelivery: v.storePays,
    address: v.address,
    deliverOn: v.deliverOn || null,
    paymentMethodId: v.paymentMethodId || null,
  }
}

/** Lo que falta para crear el cambio, con el campo donde se dice. */
function missingOf(v: ExchangeValues): { path: keyof ExchangeValues; message: string }[] {
  const missing: { path: keyof ExchangeValues; message: string }[] = []
  if (!v.back.some((b) => b.checked)) missing.push({ path: "back", message: "Marca lo que vuelve" })
  if (whyOf(v).length < 3)
    missing.push(
      v.reason === "otro"
        ? { path: "other", message: "Escribe el motivo" }
        : { path: "reason", message: "Elige por qué vuelve" },
    )
  if (v.kind === "cambio" && !v.takes.some((t) => t.variantId))
    missing.push({ path: "takes", message: "Elige lo que se lleva" })
  if (!v.deliveryMethodId)
    missing.push({ path: "deliveryMethodId", message: "Elige cómo se entrega" })
  return missing
}

const exchangeSchema = z.custom<ExchangeValues>().superRefine((v, ctx) => {
  for (const { path, message } of missingOf(v))
    ctx.addIssue({ code: "custom", path: [path], message })
})

/**
 * El campo de la pantalla para lo que el servidor señala por su nombre en el cuerpo: lo que
 * vuelve y lo que se lleva van solo con lo marcado, así que su número es el de lo marcado.
 */
function exchangeField(v: ExchangeValues, key: string): string | undefined {
  if (key === "returns") return "back"
  if (key === "reason") return v.reason === "otro" ? "other" : "reason"
  if (key === "deliveryListCents") return "deliveryCost"
  const row = /^(returns|takes)\.(\d+)\.(\w+)$/.exec(key)
  if (!row) return undefined
  const returns = row[1] === "returns"
  const rows = returns
    ? v.back.flatMap((b, i) => (b.checked ? [i] : []))
    : v.takes.flatMap((t, i) => (t.variantId ? [i] : []))
  const index = rows[Number(row[2])]
  if (index === undefined) return returns ? "back" : "takes"
  return `${returns ? "back" : "takes"}[${index}].${row[3]}`
}

/**
 * «Cambio o devolución» de un pedido entregado: qué vuelve y por qué, qué se lleva (otra talla u
 * otro producto, o nada si es una devolución) y la entrega del cambio. El resumen sale del servidor
 * con la misma operación que lo crea; «Crear el cambio» abre el pedido nuevo y, si se eligió, el
 * WhatsApp del celular con el aviso escrito (lo envía la persona).
 */
export function ExchangeSheet({ order, onClose }: { order: OrderDetail; onClose: () => void }) {
  const { store } = useStoreContext()
  const cur = store.currency
  const queryClient = useQueryClient()
  const navigate = useNavigate()
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
  const deliveries = (lists.data?.deliveries ?? []).filter((d) => d.isActive)
  const payments = (lists.data?.payments ?? []).filter((p) => p.isActive)
  const variants = sellable.data?.variants ?? []
  const left = new Map(order.returnable.map((r) => [r.variantId, r.quantity]))
  const returnable = order.lines.filter((l) => left.has(l.variantId))
  const today = storeToday(store.timeZone)
  const link = whatsappLink(order.customerPhone ? [order.customerPhone] : [], store.country)
  const nextKey = useRef(1)
  // La pestaña del WhatsApp se abre en el mismo toque (si no, el navegador la bloquea) y se llena
  // al crear.
  const tab = useRef<Window | null>(null)

  const defaultValues: ExchangeValues = {
    back: returnable.map((l) => ({
      variantId: l.variantId,
      // Si es lo único que llevó, ya va marcado.
      checked: returnable.length === 1,
      quantity: String(left.get(l.variantId) ?? 1),
    })),
    reason: "",
    other: "",
    kind: "cambio",
    takes: [{ key: 0, variantId: "", quantity: "1" }],
    deliveryMethodId: order.deliveryMethodId ?? "",
    zone: order.deliveryZone ?? "",
    deliveryCost: "",
    storePays: false,
    address: order.address,
    deliverOn: today,
    paymentMethodId: "",
    whatsapp: Boolean(link),
  }
  const form = useAppForm({
    defaultValues,
    validators: { onSubmit: exchangeSchema },
    onSubmit: async ({ value }) => {
      const opened = tab.current
      tab.current = null
      try {
        const data = await api<{ order: OrderDetail; notice: string }>(
          `/api/tiendas/${store.id}/pedidos/${order.id}/cambio`,
          {
            method: "POST",
            body: {
              ...bodyOf(value, deliveries, cur),
              whatsapp: value.whatsapp && Boolean(link),
            },
          },
        )
        const url = whatsappWithText(link, data.notice)
        if (opened && url) opened.location.href = url
        queryClient.setQueryData(["pedido", store.id, data.order.id], data.order)
        await queryClient.invalidateQueries({ queryKey: ["pedido", store.id, order.id] })
        await queryClient.invalidateQueries({ queryKey: ORDERS_KEY(store.id) })
        await queryClient.invalidateQueries({ queryKey: ["para-vender", store.id] })
        await queryClient.invalidateQueries({ queryKey: CUSTOMERS_KEY(store.id) })
        await queryClient.invalidateQueries({ queryKey: CUSTOMER_KEY(store.id) })
        toast.success(
          value.kind === "cambio"
            ? `Cambio ${data.order.number} creado`
            : `Devolución ${data.order.number} creada`,
        )
        onClose()
        void navigate({
          to: "/tiendas/$id/pedidos",
          params: { id: store.id },
          search: { pedido: data.order.id },
        })
      } catch (error) {
        opened?.close()
        throw error
      }
    },
  })
  const values = useStore(form.store, (s) => s.values)
  const surface = useFormSurface(form, {
    fieldMap: (key) => exchangeField(form.state.values, key),
  })
  const submit = (event: FormEvent) => {
    // Con todo lo que pide ya elegido, la pestaña se abre aquí, en el toque; si falta algo, no.
    if (values.whatsapp && link && missingOf(values).length === 0) {
      const opened = window.open("", "_blank")
      if (opened) opened.opener = null
      tab.current = opened
    }
    surface.onSubmit(event)
  }

  // La forma de entrega del pedido entregado, si sigue encendida; si no, la primera. No cuenta
  // como algo escrito: cerrar sin tocar nada no pregunta.
  useEffect(() => {
    if (!lists.data) return
    const on = lists.data.deliveries.filter((d) => d.isActive)
    const id = form.getFieldValue("deliveryMethodId")
    if (id && on.some((d) => d.id === id)) return
    form.setFieldValue("deliveryMethodId", on[0]?.id ?? "", { dontUpdateMeta: true })
  }, [lists.data, form])

  const delivery = deliveries.find((d) => d.id === values.deliveryMethodId)
  const firstName = order.customerName.trim().split(/\s+/)[0] ?? "la clienta"
  const body = bodyOf(values, deliveries, cur)
  const ready =
    body.returns.length > 0 &&
    values.deliveryMethodId !== "" &&
    (values.kind === "devolucion" || body.takes.length > 0)
  // El resumen lo calcula el servidor, con la misma regla que al crear (el motivo no cambia nada).
  const key = JSON.stringify({ ...body, reason: "Le quedó chica" })
  const [debounced, setDebounced] = useState(key)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(key), 300)
    return () => clearTimeout(timer)
  }, [key])
  const preview = useQuery({
    queryKey: ["cambio", store.id, order.id, debounced],
    queryFn: () =>
      api<{ summary: ExchangeSummary | null; fields: Record<string, string> }>(
        `/api/tiendas/${store.id}/pedidos/${order.id}/cambio/calcular`,
        { method: "POST", body: JSON.parse(debounced) },
      ),
    enabled: ready && debounced === key,
    placeholderData: (previous) => previous,
  })
  const summary = ready ? preview.data?.summary : undefined

  // Lo que el resumen no pudo calcular se dice en su campo, como al crear; se va al corregirlo.
  const previewed = useRef(new Set<string>())
  const previewFields = ready ? preview.data?.fields : undefined
  useEffect(() => {
    const before = previewed.current
    if (before.size > 0) clearSubmitErrors(form, (name) => before.has(name))
    const mounted = form.fieldInfo as Record<string, { instance: unknown } | undefined>
    const shown: Record<string, string> = {}
    for (const [serverKey, message] of Object.entries(previewFields ?? {})) {
      const name = exchangeField(form.state.values, serverKey) ?? serverKey
      if (mounted[name]?.instance) shown[name] ??= message
    }
    previewed.current = new Set(Object.keys(shown))
    if (previewed.current.size > 0) addSubmitErrors(form, shown)
  }, [previewFields, form])

  const variantLabel = (v: SellableVariant) =>
    `${v.productName}${v.variantName === "Única" ? "" : ` · ${v.variantName}`} — ${money(v.autoUnitCents, cur)}${v.stock === 0 ? " · agotado" : ` · quedan ${v.stock}`}`
  // Lo del mismo producto que vuelve va primero: otra talla u otro color.
  const backProducts = new Set(
    order.lines
      .filter((l) => values.back.some((b) => b.checked && b.variantId === l.variantId))
      .map((l) => l.productName),
  )
  const options = [
    ...variants.filter((v) => backProducts.has(v.productName)),
    ...variants.filter((v) => !backProducts.has(v.productName)),
  ].map((v) => ({ value: v.id, label: variantLabel(v) }))
  const usablePayments = payments.filter(
    (p) => p.collection !== "al_recibir" || delivery?.acceptsPayOnDelivery,
  )

  return (
    <FormDrawer
      {...surface}
      onSubmit={submit}
      open
      className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(42rem,calc(100vw-2rem))]"
      title={`Cambio o devolución · ${order.number}`}
      description="Ya entregado no se corrige: el cambio va en un pedido nuevo, enlazado a este. Su total y su pago no cambian."
      onClose={onClose}
      submitLabel={values.kind === "cambio" ? "Crear el cambio" : "Crear la devolución"}
    >
      {sellable.isError || lists.isError ? (
        <ErrorState
          error={sellable.error ?? lists.error}
          onRetry={() => void Promise.all([sellable.refetch(), lists.refetch()])}
        />
      ) : null}
      <FieldGroup>
        <form.AppField name="back" mode="array">
          {(list) => (
            <list.Group legend="¿Qué vuelve?">
              {() =>
                returnable.map((line, i) => {
                  const most = left.get(line.variantId) ?? 1
                  return (
                    <div key={line.variantId} className="flex flex-col gap-2 rounded-lg border p-3">
                      <form.AppField name={`back[${i}].checked`}>
                        {(field) => (
                          <field.CheckboxField
                            label={`${itemText({ ...line, quantity: most })} · ${line.gift ? "de regalo" : `${money(line.unitCents, cur)} c/u`}`}
                          />
                        )}
                      </form.AppField>
                      {list.state.value[i]?.checked && most > 1 ? (
                        <form.AppField name={`back[${i}].quantity`}>
                          {(field) => (
                            <field.TextField
                              className="max-w-32"
                              label="Cuántas vuelven"
                              inputMode="numeric"
                            />
                          )}
                        </form.AppField>
                      ) : null}
                    </div>
                  )
                })
              }
            </list.Group>
          )}
        </form.AppField>
        <form.AppField name="reason">
          {(field) => (
            <field.Group legend="¿Por qué?">
              {(control) => (
                <RadioChips
                  id={control.id}
                  aria-label="¿Por qué?"
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={field.state.value || null}
                  options={REASON_OPTIONS}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        {values.reason === "otro" ? (
          <form.AppField name="other">
            {(field) => <field.TextField label="Escribe el motivo" maxLength={120} autoFocus />}
          </form.AppField>
        ) : null}

        <form.AppField name="takes" mode="array">
          {(list) => (
            <list.Group legend="¿Qué se lleva?">
              {() => (
                <div className="flex flex-col gap-3">
                  <form.AppField name="kind">
                    {(field) => (
                      <RadioChips
                        aria-label="¿Qué se lleva?"
                        value={field.state.value}
                        options={KIND_OPTIONS}
                        onBlur={field.handleBlur}
                        onChange={(next) => field.handleChange(next)}
                      />
                    )}
                  </form.AppField>
                  {values.kind === "cambio" ? (
                    <>
                      {list.state.value.map((take, i) => {
                        const v = variants.find((x) => x.id === take.variantId)
                        const priced = summary?.takes.find((t) => t.variantId === take.variantId)
                        const many = list.state.value.length > 1
                        return (
                          <div key={take.key} className="flex flex-col gap-3 rounded-lg border p-3">
                            <div className="flex items-start gap-2">
                              <form.AppField name={`takes[${i}].variantId`}>
                                {(field) => (
                                  <field.SelectField
                                    className="min-w-0 flex-1"
                                    label={many ? `Se lleva ${i + 1}` : "Se lleva"}
                                    placeholder={
                                      sellable.isPending
                                        ? "Cargando el catálogo…"
                                        : "Elige la talla o el producto"
                                    }
                                    options={options}
                                  />
                                )}
                              </form.AppField>
                              {many ? (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  type="button"
                                  className="mt-6"
                                  aria-label={`Quitar lo que se lleva ${i + 1}`}
                                  onClick={() => list.removeValue(i)}
                                >
                                  <Trash2 aria-hidden />
                                </Button>
                              ) : null}
                            </div>
                            {v ? (
                              <div className="grid gap-3 sm:grid-cols-[6rem_minmax(0,1fr)]">
                                <form.AppField name={`takes[${i}].quantity`}>
                                  {(field) => (
                                    <field.TextField label="Cantidad" inputMode="numeric" />
                                  )}
                                </form.AppField>
                                <p className="self-end pb-2 text-sm text-muted-foreground">
                                  {v.stock === 0
                                    ? "Agotada: el cambio se crea igual y no sale hasta que entre."
                                    : `De ${v.variantName === "Única" ? "este producto" : `la ${v.variantName}`} quedan ${v.stock}.`}
                                  {priced && priced.unitCents < v.autoUnitCents
                                    ? ` Va a ${money(priced.unitCents, cur)}, lo que pagó por lo que vuelve.`
                                    : ""}
                                </p>
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                      <Button
                        variant="outline"
                        type="button"
                        className="self-start"
                        onClick={() =>
                          list.pushValue({ key: nextKey.current++, variantId: "", quantity: "1" })
                        }
                      >
                        <Plus aria-hidden />
                        Agregar otro producto
                      </Button>
                    </>
                  ) : null}
                </div>
              )}
            </list.Group>
          )}
        </form.AppField>

        <FieldSet>
          <FieldLegend>La entrega del cambio</FieldLegend>
          <form.AppField
            name="deliveryMethodId"
            listeners={{ onChange: () => form.setFieldValue("zone", "") }}
          >
            {(field) => (
              <field.SelectField
                label="Forma de entrega"
                placeholder="Elige cómo se entrega"
                options={deliveries.map((d) => ({ value: d.id, label: d.name }))}
              />
            )}
          </form.AppField>
          {delivery?.cost === "por_zona" ? (
            <form.AppField name="zone">
              {(field) => (
                <field.SelectField
                  label="Zona"
                  placeholder="Elige la zona"
                  options={delivery.zones.map((z) => ({
                    value: z.name,
                    label: `${z.name} — ${money(z.priceCents, cur)}`,
                  }))}
                />
              )}
            </form.AppField>
          ) : null}
          {delivery?.cost === "se_acuerda" ? (
            <form.AppField name="deliveryCost">
              {(field) => (
                <field.Control label="Cuánto cuesta el envío">
                  {(control) => (
                    <MoneyInput
                      control={control}
                      currency={cur}
                      value={field.state.value}
                      onChange={field.handleChange}
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
          ) : null}
          {delivery && delivery.cost !== "gratis" ? (
            <form.AppField name="storePays">
              {(field) => (
                <RadioChips
                  aria-label="Quién paga el envío del cambio"
                  value={field.state.value ? "tienda" : "clienta"}
                  options={[
                    { value: "clienta", label: `Lo paga ${firstName}` },
                    { value: "tienda", label: "Lo paga la tienda" },
                  ]}
                  onBlur={field.handleBlur}
                  onChange={(next) => field.handleChange(next === "tienda")}
                />
              )}
            </form.AppField>
          ) : null}
          <form.AppField name="address">
            {(field) => <field.TextField label="Dirección (opcional)" maxLength={300} />}
          </form.AppField>
          <form.AppField name="deliverOn">
            {(field) => (
              <DayChoice
                today={today}
                value={field.state.value}
                onChange={field.handleChange}
                label="¿Cuándo va?"
                error={fieldErrorMessages(field.state.meta.errors)[0]}
              />
            )}
          </form.AppField>
          {delivery && delivery.type !== "OnSitePickup" ? (
            <FieldDescription>
              {values.kind === "cambio"
                ? "Quien reparte recoge lo que vuelve y lleva lo nuevo en el mismo viaje."
                : "Quien reparte recoge lo que vuelve."}{" "}
              Lo que vuelve entra a tu stock al marcar «Entregado».
            </FieldDescription>
          ) : delivery ? (
            <FieldDescription>
              Lo que vuelve entra a tu stock al marcar «Entregado», cuando lo traiga a la tienda.
            </FieldDescription>
          ) : null}
        </FieldSet>

        <section
          aria-live="polite"
          className="flex flex-col gap-1 rounded-lg bg-surface-muted px-4 py-3"
        >
          <h3 className="text-sm font-semibold">Resumen</h3>
          {!ready ? (
            <p className="text-sm text-muted-foreground">
              Marca lo que vuelve, lo que se lleva y la entrega para ver la diferencia.
            </p>
          ) : summary ? (
            <>
              <Row
                label={`Vuelve ${money(summary.backCents, cur)} · sale ${money(summary.takesCents, cur)}`}
              >
                Diferencia {money(summary.takesCents - summary.backCents, cur)}
              </Row>
              <Row label="Envío del cambio">
                {summary.deliveryListCents === 0
                  ? "Gratis"
                  : summary.deliveryCents === 0
                    ? `Lo paga la tienda (${money(summary.deliveryListCents, cur)})`
                    : money(summary.deliveryCents, cur)}
              </Row>
              {summary.dueCents > 0 ? (
                <>
                  <Row label="Falta cobrar" strong>
                    {money(summary.dueCents, cur)}
                    {summary.payOnDelivery ? " · al entregar" : ""}
                  </Row>
                  {usablePayments.length > 1 ? (
                    <form.AppField name="paymentMethodId">
                      {(field) => (
                        <field.SelectField
                          label="Cobrar con"
                          // Sin elegir, se cobra con el que propone el resumen.
                          placeholder={summary.paymentName}
                          options={usablePayments.map((p) => ({ value: p.id, label: p.name }))}
                        />
                      )}
                    </form.AppField>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Se cobra con {summary.paymentName}.
                    </p>
                  )}
                </>
              ) : summary.refundCents > 0 ? (
                <Row label="Le devuelves" strong>
                  {money(summary.refundCents, cur)}
                </Row>
              ) : (
                <Row label="Falta cobrar">Nada</Row>
              )}
              {summary.refundCents > 0 ? (
                <p className="text-xs text-muted-foreground">
                  gestorIA no mueve el dinero: cuando lo devuelvas desde tu app, anótalo en el
                  cambio con «Anotar la devolución».
                </p>
              ) : null}
              {summary.takes.some((t) => t.short) ? (
                <p className="text-xs text-warning">
                  No alcanza el stock de lo que se lleva: el cambio se crea igual y no sale hasta
                  que entre.
                </p>
              ) : null}
            </>
          ) : preview.isFetching || debounced !== key ? (
            <p className="text-sm text-muted-foreground">Calculando…</p>
          ) : (
            <p className="text-sm text-warning">Revisa lo marcado arriba para ver la diferencia.</p>
          )}
        </section>

        {link ? (
          <form.AppField name="whatsapp">
            {(field) => <field.CheckboxField label="Abrir WhatsApp con el aviso del cambio" />}
          </form.AppField>
        ) : (
          <p className="text-xs text-muted-foreground">
            Sin un teléfono con su código de país, el aviso del cambio queda escrito en su historia.
          </p>
        )}
      </FieldGroup>
    </FormDrawer>
  )
}

/** Abre «Cambio o devolución» desde un pedido entregado que todavía tiene algo que puede volver. */
export function ExchangeAction({ order }: { order: OrderDetail }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-1 pb-2">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setOpen(true)}>
          <Repeat aria-hidden />
          Cambio o devolución
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Ya entregado no se corrige: el cambio va en un pedido nuevo, enlazado a este.
      </p>
      {open ? <ExchangeSheet order={order} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}

/** Lo que la tienda devolvió de lo que sobra: «Devuelto · Plin − S/ 129». */
export function RefundLines({ order }: { order: OrderDetail }) {
  const { store } = useStoreContext()
  if (order.refunds.length === 0) return null
  return (
    <ul className="flex flex-col gap-1">
      {order.refunds.map((r) => (
        <li key={r.id} className="flex justify-between gap-4 text-sm">
          <span className="text-muted-foreground">
            Devuelto · {r.methodName}
            {r.createdByName ? ` · ${r.createdByName}` : ""}
          </span>
          <span className="tabular-nums">− {money(r.amountCents, store.currency)}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * «Anotar la devolución»: lo que sobra de un cambio, una devolución o un pago doble se devuelve
 * fuera de gestorIA (desde la app del medio) y aquí se anota cuánto y con qué. Queda con el nombre
 * de quien lo anota.
 */
export function RefundAction({ order }: { order: OrderDetail }) {
  const [asking, setAsking] = useState(false)
  return (
    <div className="flex flex-col gap-1 pt-1">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setAsking(true)}>
          <HandCoins aria-hidden />
          Anotar la devolución
        </Button>
      </div>
      {/* Se monta al abrir: cada vez empieza con lo que sobra ahora. */}
      {asking ? <RefundDialog order={order} onClose={() => setAsking(false)} /> : null}
    </div>
  )
}

/** Lo que el servidor señala en `amountCents` es del campo «Devolver». */
const REFUND_FIELDS = { amountCents: "amount" }

function RefundDialog({ order, onClose }: { order: OrderDetail; onClose: () => void }) {
  const { store } = useStoreContext()
  const cur = store.currency
  const over = order.balance.overCents
  const lists = useQuery({
    queryKey: ["pagos-y-entregas", store.id],
    queryFn: () =>
      api<{ payments: PaymentMethod[]; deliveries: DeliveryMethod[] }>(
        `/api/tiendas/${store.id}/pagos-y-entregas`,
      ),
  })
  const methods = (lists.data?.payments ?? []).filter((m) => m.isActive && m.collection !== "link")
  // Sin elegir, el del pedido o el primero: el mismo que se anota.
  const proposed = methods.find((m) => m.name === order.paymentName)?.id || methods[0]?.id || ""
  const action = useOrderAction(store.id, order.id, onClose)
  const form = useAppForm({
    defaultValues: { amount: moneyInput(over, cur), methodId: "" },
    validators: {
      onSubmit: z.object({
        amount: z
          .string()
          .refine((text) => Boolean(readMoney(text, cur)), "Escribe cuánto devolviste"),
        methodId: z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      await action.mutateAsync({
        path: "devolucion",
        body: {
          amountCents: readMoney(value.amount, cur),
          methodId: value.methodId || proposed || null,
        },
        done: "Devolución anotada",
      })
    },
  })
  const amount = useStore(form.store, (s) => s.values.amount)
  const methodId = useStore(form.store, (s) => s.values.methodId)
  const pending = useStore(form.store, (s) => s.isSubmitting)
  const error = useFormSubmitError(form)
  const chosenName = methods.find((m) => m.id === (methodId || proposed))?.name
  return (
    <ConfirmDialog
      open
      variant="default"
      title={`Devolución · ${order.number} · ${order.customerName}`}
      description={`gestorIA no mueve el dinero: anota lo que devolviste${chosenName ? ` desde tu app de ${chosenName}` : ""}. Queda con tu nombre.`}
      confirmLabel="Anotar la devolución"
      cancelLabel="Volver"
      pending={pending}
      confirmDisabled={!readMoney(amount, cur)}
      error={error}
      onConfirm={() => void submitForm(form, { fieldMap: REFUND_FIELDS })}
      onClose={onClose}
    >
      <FieldGroup>
        <form.AppField name="amount">
          {(field) => (
            <field.Control label="Devolver" description={`Sobran ${money(over, cur)}.`}>
              {(control) => (
                <MoneyInput
                  control={control}
                  currency={cur}
                  value={field.state.value}
                  onChange={field.handleChange}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        {methods.length > 0 ? (
          <form.AppField name="methodId">
            {(field) => (
              <field.SelectField
                label="Medio"
                placeholder={methods.find((m) => m.id === proposed)?.name}
                options={methods.map((m) => ({ value: m.id, label: m.name }))}
              />
            )}
          </form.AppField>
        ) : null}
      </FieldGroup>
    </ConfirmDialog>
  )
}
