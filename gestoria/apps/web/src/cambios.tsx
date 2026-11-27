import {
  Button,
  Checkbox,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  RadioGroup,
  RadioGroupItem,
  toast,
} from "@odentia/ui"
import { ConfirmDialog, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { HandCoins, Plus, Repeat, Trash2 } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
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
import { DayChoice, ORDERS_KEY, Row, SelectField, useOrderAction } from "./pedidos"
import { FormAlert, FormSheet, fieldErrors, MoneyField, TextField, useDirty } from "./piezas"
import { ErrorBlock, useStoreContext } from "./tiendas"

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

interface BackDraft {
  variantId: string
  checked: boolean
  quantity: string
}

interface TakeDraft {
  key: number
  variantId: string
  quantity: string
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

  const [back, setBack] = useState<BackDraft[]>(() =>
    returnable.map((l) => ({
      variantId: l.variantId,
      // Si es lo único que llevó, ya va marcado.
      checked: returnable.length === 1,
      quantity: String(left.get(l.variantId) ?? 1),
    })),
  )
  const [reason, setReason] = useState("")
  const [other, setOther] = useState("")
  const [kind, setKind] = useState<"cambio" | "devolucion">("cambio")
  const nextKey = useRef(1)
  const [takes, setTakes] = useState<TakeDraft[]>([{ key: 0, variantId: "", quantity: "1" }])
  const [deliveryId, setDeliveryId] = useState(order.deliveryMethodId ?? "")
  const [zone, setZone] = useState(order.deliveryZone ?? "")
  const [deliveryCost, setDeliveryCost] = useState("")
  const [storePays, setStorePays] = useState(false)
  const [address, setAddress] = useState(order.address)
  const [day, setDay] = useState(today)
  const [paymentId, setPaymentId] = useState("")
  const link = whatsappLink(order.customerPhone ? [order.customerPhone] : [], store.country)
  const [whatsapp, setWhatsapp] = useState(Boolean(link))
  const dirty = useDirty({ back, reason, other, kind, takes, deliveryId, zone, address, day })

  // La forma de entrega del pedido entregado, si sigue encendida; si no, la primera.
  useEffect(() => {
    if (!lists.data) return
    const on = lists.data.deliveries.filter((d) => d.isActive)
    setDeliveryId((id) => (id && on.some((d) => d.id === id) ? id : (on[0]?.id ?? "")))
  }, [lists.data])
  const delivery = deliveries.find((d) => d.id === deliveryId)
  const firstName = order.customerName.trim().split(/\s+/)[0] ?? "la clienta"
  const why = reason === "otro" ? other.trim() : reason
  const body = {
    returns: back
      .filter((b) => b.checked)
      .map((b) => ({ variantId: b.variantId, quantity: Number(b.quantity) || 0 })),
    reason: why,
    takes:
      kind === "cambio"
        ? takes
            .filter((t) => t.variantId)
            .map((t) => ({ variantId: t.variantId, quantity: Number(t.quantity) || 0 }))
        : [],
    deliveryMethodId: deliveryId,
    zone: delivery?.cost === "por_zona" ? zone || null : null,
    deliveryListCents:
      delivery?.cost === "se_acuerda" && deliveryCost.trim() ? readMoney(deliveryCost, cur) : null,
    storePaysDelivery: storePays,
    address,
    deliverOn: day || null,
    paymentMethodId: paymentId || null,
  }
  const ready =
    body.returns.length > 0 && deliveryId !== "" && (kind === "devolucion" || body.takes.length > 0)
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

  const create = useMutation({
    mutationFn: () =>
      api<{ order: OrderDetail; notice: string }>(
        `/api/tiendas/${store.id}/pedidos/${order.id}/cambio`,
        { method: "POST", body: { ...body, whatsapp: whatsapp && Boolean(link) } },
      ),
  })
  const resetCreate = create.reset
  useEffect(() => {
    if (key) resetCreate()
  }, [key, resetCreate])
  const errors = {
    ...(create.error ? fieldErrors(create.error) : (preview.data?.fields ?? {})),
  }
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({})
  const shown = { ...errors, ...localErrors }

  const submit = () => {
    const next: Record<string, string> = {}
    if (body.returns.length === 0) next.returns = "Marca lo que vuelve"
    if (why.length < 3)
      next.reason = reason === "otro" ? "Escribe el motivo" : "Elige por qué vuelve"
    if (kind === "cambio" && body.takes.length === 0) next.takes = "Elige lo que se lleva"
    if (!deliveryId) next.deliveryMethodId = "Elige cómo se entrega"
    setLocalErrors(next)
    if (Object.keys(next).length > 0) return
    // El WhatsApp se abre en el mismo toque (si no, el navegador lo bloquea) y se llena al crear.
    const tab = whatsapp && link ? window.open("", "_blank") : null
    if (tab) tab.opener = null
    create.mutate(undefined, {
      onSuccess: async (data) => {
        const url = whatsappWithText(link, data.notice)
        if (tab && url) tab.location.href = url
        queryClient.setQueryData(["pedido", store.id, data.order.id], data.order)
        await queryClient.invalidateQueries({ queryKey: ["pedido", store.id, order.id] })
        await queryClient.invalidateQueries({ queryKey: ORDERS_KEY(store.id) })
        await queryClient.invalidateQueries({ queryKey: ["para-vender", store.id] })
        await queryClient.invalidateQueries({ queryKey: CUSTOMERS_KEY(store.id) })
        await queryClient.invalidateQueries({ queryKey: CUSTOMER_KEY(store.id) })
        toast.success(
          kind === "cambio"
            ? `Cambio ${data.order.number} creado`
            : `Devolución ${data.order.number} creada`,
        )
        onClose()
        void navigate({
          to: "/tiendas/$id/pedidos",
          params: { id: store.id },
          search: { pedido: data.order.id },
        })
      },
      onError: () => tab?.close(),
    })
  }

  const variantLabel = (v: SellableVariant) =>
    `${v.productName}${v.variantName === "Única" ? "" : ` · ${v.variantName}`} — ${money(v.autoUnitCents, cur)}${v.stock === 0 ? " · agotado" : ` · quedan ${v.stock}`}`
  // Lo del mismo producto que vuelve va primero: otra talla u otro color.
  const backProducts = new Set(
    order.lines
      .filter((l) => back.some((b) => b.checked && b.variantId === l.variantId))
      .map((l) => l.productName),
  )
  const options = [
    ...variants.filter((v) => backProducts.has(v.productName)),
    ...variants.filter((v) => !backProducts.has(v.productName)),
  ].map((v) => ({ value: v.id, label: variantLabel(v) }))
  const updateTake = (k: number, patch: Partial<TakeDraft>) =>
    setTakes((all) => all.map((t) => (t.key === k ? { ...t, ...patch } : t)))
  const reasonId = useId()
  const kindId = useId()
  const payId = useId()
  const usablePayments = payments.filter(
    (p) => p.collection !== "al_recibir" || delivery?.acceptsPayOnDelivery,
  )

  return (
    <FormSheet
      open
      wide
      title={`Cambio o devolución · ${order.number}`}
      description="Ya entregado no se corrige: el cambio va en un pedido nuevo, enlazado a este. Su total y su pago no cambian."
      onClose={onClose}
      onSubmit={submit}
      dirty={dirty}
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancelar
          </Button>
          <SubmitButton type="submit" pending={create.isPending}>
            {kind === "cambio" ? "Crear el cambio" : "Crear la devolución"}
          </SubmitButton>
        </>
      }
    >
      {sellable.isError || lists.isError ? (
        <ErrorBlock error={sellable.error ?? lists.error} />
      ) : null}
      <FieldGroup>
        <FieldSet>
          <FieldLegend>¿Qué vuelve?</FieldLegend>
          {shown.returns ? <FieldError>{shown.returns}</FieldError> : null}
          {returnable.map((line, i) => {
            const draft = back[i]!
            const most = left.get(line.variantId) ?? 1
            const id = `${reasonId}-vuelve-${i}`
            const sent = body.returns.findIndex((r) => r.variantId === line.variantId)
            const quantityError = sent >= 0 ? shown[`returns.${sent}.quantity`] : undefined
            return (
              <div key={line.variantId} className="flex flex-col gap-2 rounded-lg border p-3">
                <div className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={id}
                    checked={draft.checked}
                    onCheckedChange={(next) =>
                      setBack((all) =>
                        all.map((b, k) => (k === i ? { ...b, checked: Boolean(next) } : b)),
                      )
                    }
                  />
                  <label htmlFor={id}>
                    {itemText({ ...line, quantity: most })} ·{" "}
                    {line.gift ? "de regalo" : `${money(line.unitCents, cur)} c/u`}
                  </label>
                </div>
                {draft.checked && most > 1 ? (
                  <TextField
                    className="max-w-32"
                    label="Cuántas vuelven"
                    value={draft.quantity}
                    inputMode="numeric"
                    onChange={(quantity) =>
                      setBack((all) => all.map((b, k) => (k === i ? { ...b, quantity } : b)))
                    }
                    error={quantityError}
                  />
                ) : quantityError ? (
                  <FieldError>{quantityError}</FieldError>
                ) : null}
              </div>
            )
          })}
          <SelectField
            label="¿Por qué?"
            value={reason}
            onChange={setReason}
            placeholder="Elige el motivo"
            error={reason === "otro" ? undefined : shown.reason}
            options={[
              ...RETURN_REASONS.map((r) => ({ value: r, label: r })),
              { value: "otro", label: "Otro motivo" },
            ]}
          />
          {reason === "otro" ? (
            <TextField
              label="Escribe el motivo"
              value={other}
              onChange={setOther}
              maxLength={120}
              error={shown.reason}
              autoFocus
            />
          ) : null}
        </FieldSet>

        <FieldSet>
          <FieldLegend>¿Qué se lleva?</FieldLegend>
          <RadioGroup
            aria-label="¿Qué se lleva?"
            value={kind}
            onValueChange={(value) => setKind(value === "devolucion" ? "devolucion" : "cambio")}
          >
            <Field orientation="horizontal">
              <RadioGroupItem id={`${kindId}-cambio`} value="cambio" />
              <FieldLabel htmlFor={`${kindId}-cambio`} className="font-normal">
                Otra talla u otro producto
              </FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <RadioGroupItem id={`${kindId}-devolucion`} value="devolucion" />
              <FieldLabel htmlFor={`${kindId}-devolucion`} className="font-normal">
                Nada: es una devolución
              </FieldLabel>
            </Field>
          </RadioGroup>
          {kind === "cambio" ? (
            <>
              {shown.takes ? <FieldError>{shown.takes}</FieldError> : null}
              {takes.map((take, i) => {
                const v = variants.find((x) => x.id === take.variantId)
                const sent = body.takes.findIndex((t) => t.variantId === take.variantId)
                const priced = summary?.takes.find((t) => t.variantId === take.variantId)
                return (
                  <div key={take.key} className="flex flex-col gap-3 rounded-lg border p-3">
                    <div className="flex items-start gap-2">
                      <SelectField
                        className="flex-1"
                        label={takes.length > 1 ? `Se lleva ${i + 1}` : "Se lleva"}
                        value={take.variantId}
                        onChange={(variantId) => updateTake(take.key, { variantId })}
                        placeholder={
                          sellable.isPending
                            ? "Cargando el catálogo…"
                            : "Elige la talla o el producto"
                        }
                        error={sent >= 0 ? shown[`takes.${sent}.variantId`] : undefined}
                        options={options}
                      />
                      {takes.length > 1 ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          type="button"
                          className="mt-6"
                          aria-label={`Quitar lo que se lleva ${i + 1}`}
                          onClick={() => setTakes((all) => all.filter((t) => t.key !== take.key))}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                    {v ? (
                      <div className="grid gap-3 sm:grid-cols-[6rem_minmax(0,1fr)]">
                        <TextField
                          label="Cantidad"
                          value={take.quantity}
                          onChange={(quantity) => updateTake(take.key, { quantity })}
                          inputMode="numeric"
                          error={sent >= 0 ? shown[`takes.${sent}.quantity`] : undefined}
                        />
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
                  setTakes((all) => [
                    ...all,
                    { key: nextKey.current++, variantId: "", quantity: "1" },
                  ])
                }
              >
                <Plus aria-hidden />
                Agregar otro producto
              </Button>
            </>
          ) : null}
        </FieldSet>

        <FieldSet>
          <FieldLegend>La entrega del cambio</FieldLegend>
          <SelectField
            label="Forma de entrega"
            value={deliveryId}
            onChange={(id) => {
              setDeliveryId(id)
              setZone("")
            }}
            error={shown.deliveryMethodId}
            placeholder="Elige cómo se entrega"
            options={deliveries.map((d) => ({ value: d.id, label: d.name }))}
          />
          {delivery?.cost === "por_zona" ? (
            <SelectField
              label="Zona"
              value={zone}
              onChange={setZone}
              error={shown.zone}
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
              error={shown.deliveryListCents}
            />
          ) : null}
          {delivery && delivery.cost !== "gratis" ? (
            <RadioGroup
              aria-label="Quién paga el envío del cambio"
              value={storePays ? "tienda" : "clienta"}
              onValueChange={(value) => setStorePays(value === "tienda")}
              className="flex flex-wrap gap-4"
            >
              <Field orientation="horizontal">
                <RadioGroupItem id={`${payId}-clienta`} value="clienta" />
                <FieldLabel htmlFor={`${payId}-clienta`} className="font-normal">
                  Lo paga {firstName}
                </FieldLabel>
              </Field>
              <Field orientation="horizontal">
                <RadioGroupItem id={`${payId}-tienda`} value="tienda" />
                <FieldLabel htmlFor={`${payId}-tienda`} className="font-normal">
                  Lo paga la tienda
                </FieldLabel>
              </Field>
            </RadioGroup>
          ) : null}
          <TextField
            label="Dirección (opcional)"
            value={address}
            onChange={setAddress}
            maxLength={300}
            error={shown.address}
          />
          <DayChoice
            today={today}
            value={day}
            onChange={setDay}
            label="¿Cuándo va?"
            error={shown.deliverOn}
          />
          {delivery && delivery.type !== "OnSitePickup" ? (
            <FieldDescription>
              {kind === "cambio"
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
                    <SelectField
                      label="Cobrar con"
                      value={
                        paymentId ||
                        (usablePayments.find((p) => p.name === summary.paymentName)?.id ?? "")
                      }
                      onChange={setPaymentId}
                      error={shown.paymentMethodId}
                      options={usablePayments.map((p) => ({ value: p.id, label: p.name }))}
                    />
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
          <div className="flex items-center gap-2 text-sm">
            <Checkbox
              id={`${payId}-whatsapp`}
              checked={whatsapp}
              onCheckedChange={(next) => setWhatsapp(Boolean(next))}
            />
            <label htmlFor={`${payId}-whatsapp`}>Abrir WhatsApp con el aviso del cambio</label>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Sin un teléfono con su código de país, el aviso del cambio queda escrito en su historia.
          </p>
        )}
        <FormAlert error={create.error} />
      </FieldGroup>
    </FormSheet>
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
  const { store } = useStoreContext()
  const over = order.balance.overCents
  const [asking, setAsking] = useState(false)
  const [amount, setAmount] = useState(moneyInput(over, store.currency))
  const lists = useQuery({
    queryKey: ["pagos-y-entregas", store.id],
    queryFn: () =>
      api<{ payments: PaymentMethod[]; deliveries: DeliveryMethod[] }>(
        `/api/tiendas/${store.id}/pagos-y-entregas`,
      ),
  })
  const methods = (lists.data?.payments ?? []).filter((m) => m.isActive && m.collection !== "link")
  const own = methods.find((m) => m.name === order.paymentName)
  const [methodId, setMethodId] = useState("")
  const chosen = methodId || own?.id || methods[0]?.id || ""
  const chosenName = methods.find((m) => m.id === chosen)?.name
  const action = useOrderAction(store.id, order.id, () => setAsking(false))
  const errors = fieldErrors(action.error)
  const cents = readMoney(amount, store.currency)
  return (
    <div className="flex flex-col gap-1 pt-1">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            setAmount(moneyInput(over, store.currency))
            setAsking(true)
          }}
        >
          <HandCoins aria-hidden />
          Anotar la devolución
        </Button>
      </div>
      <ConfirmDialog
        open={asking}
        variant="default"
        title={`Devolución · ${order.number} · ${order.customerName}`}
        description={`gestorIA no mueve el dinero: anota lo que devolviste${chosenName ? ` desde tu app de ${chosenName}` : ""}. Queda con tu nombre.`}
        confirmLabel="Anotar la devolución"
        cancelLabel="Volver"
        pending={action.isPending}
        confirmDisabled={!cents}
        error={action.isError && !errors.amountCents ? action.error.message : null}
        onConfirm={() =>
          action.mutate({
            path: "devolucion",
            body: { amountCents: cents, methodId: chosen || null },
            done: "Devolución anotada",
          })
        }
        onClose={() => setAsking(false)}
      >
        <FieldGroup>
          <MoneyField
            label="Devolver"
            currency={store.currency}
            value={amount}
            onChange={setAmount}
            error={errors.amountCents}
            help={`Sobran ${money(over, store.currency)}.`}
          />
          {methods.length > 0 ? (
            <SelectField
              label="Medio"
              value={chosen}
              onChange={setMethodId}
              error={errors.methodId}
              options={methods.map((m) => ({ value: m.id, label: m.name }))}
            />
          ) : null}
        </FieldGroup>
      </ConfirmDialog>
    </div>
  )
}
