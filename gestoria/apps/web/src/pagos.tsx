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
  toast,
} from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { Textarea } from "@odentia/ui/components/textarea"
import { ConfirmDialog, EmptyState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CreditCard, Plus, Trash2, Truck } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { PaymentLinkSection } from "./link-de-pago"
import { api } from "./lib/api"
import {
  COLLECTIONS,
  DELIVERY_COSTS,
  DELIVERY_TYPES,
  type DeliveryCost,
  type DeliveryMethod,
  type DeliveryType,
  money,
  moneyInput,
  PAYMENT_TYPES,
  type PaymentCollection,
  type PaymentMethod,
  type PaymentTypeCode,
  readMoney,
} from "./lib/tienda"
import {
  FormAlert,
  FormSheet,
  fieldErrors,
  MoneyField,
  SELECT_CLASSES,
  SwitchField,
  TextField,
  useDirty,
} from "./piezas"
import { ErrorBlock, useStoreContext } from "./tiendas"

/**
 * «Pagos y entregas» (lienzo B, tablero 6): con qué le pagan a la tienda y cómo llega el pedido.
 * Igual que «Medios de pago» de odentIA: un nombre libre y un tipo de una lista estándar. Lo que
 * se apaga, Sofi deja de ofrecerlo. Ventas lo ve sin cambiarlo.
 */

interface Lists {
  payments: PaymentMethod[]
  deliveries: DeliveryMethod[]
}

const LISTS_KEY = (storeId: string) => ["pagos-y-entregas", storeId]

export function PaymentsPage() {
  const { store } = useStoreContext()
  const canEdit = store.permissions.includes("configuracion")
  const lists = useQuery({
    queryKey: LISTS_KEY(store.id),
    queryFn: () => api<Lists>(`/api/tiendas/${store.id}/pagos-y-entregas`),
  })
  const [payment, setPayment] = useState<PaymentMethod | "new" | null>(null)
  const [delivery, setDelivery] = useState<DeliveryMethod | "new" | null>(null)

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold">Pagos y entregas</h2>
        <p className="text-sm text-muted-foreground">
          Con qué te pagan y cómo llega el pedido. Lo que apagues, Sofi deja de ofrecerlo.
        </p>
      </div>
      {lists.isError ? (
        <ErrorBlock error={lists.error} onRetry={() => void lists.refetch()} />
      ) : null}
      <Section
        title="Medios de pago"
        action={canEdit ? "Agregar medio" : null}
        onAdd={() => setPayment("new")}
        loading={lists.isPending}
      >
        {lists.data?.payments.length === 0 ? (
          <EmptyState
            icon={CreditCard}
            title="Todavía no hay medios de pago"
            description="Agrega Yape, Plin, tu cuenta para transferencias o el efectivo al recibir. Sofi cobra primero por link, después con la captura y al final al recibir."
          />
        ) : (
          <ul className="flex flex-col divide-y">
            {lists.data?.payments.map((method) => (
              <PaymentRow
                key={method.id}
                method={method}
                canEdit={canEdit}
                onEdit={() => setPayment(method)}
              />
            ))}
          </ul>
        )}
      </Section>
      <PaymentLinkSection storeId={store.id} canEdit={canEdit} />
      <Section
        title="Formas de entrega"
        action={canEdit ? "Agregar forma" : null}
        onAdd={() => setDelivery("new")}
        loading={lists.isPending}
      >
        {lists.data?.deliveries.length === 0 ? (
          <EmptyState
            icon={Truck}
            title="Todavía no hay formas de entrega"
            description="Agrega tu reparto, el recojo en tienda o el envío por agencia, cada uno con su costo y cuándo llega."
          />
        ) : (
          <ul className="flex flex-col divide-y">
            {lists.data?.deliveries.map((method) => (
              <DeliveryRow
                key={method.id}
                method={method}
                currency={store.currency}
                canEdit={canEdit}
                onEdit={() => setDelivery(method)}
              />
            ))}
          </ul>
        )}
      </Section>
      {payment ? (
        <PaymentForm
          storeId={store.id}
          method={payment === "new" ? null : payment}
          onClose={() => setPayment(null)}
        />
      ) : null}
      {delivery ? (
        <DeliveryForm
          storeId={store.id}
          currency={store.currency}
          method={delivery === "new" ? null : delivery}
          onClose={() => setDelivery(null)}
        />
      ) : null}
    </>
  )
}

function Section({
  title,
  action,
  onAdd,
  loading,
  children,
}: {
  title: string
  action: string | null
  onAdd: () => void
  loading: boolean
  children: ReactNode
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="elevated overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <h3 id={id} className="text-base font-semibold">
          {title}
        </h3>
        {action ? (
          <Button onClick={onAdd}>
            <Plus aria-hidden />
            {action}
          </Button>
        ) : null}
      </div>
      {loading ? <p className="px-5 py-4 text-sm text-muted-foreground">Cargando…</p> : children}
    </section>
  )
}

/** Encender o apagar guarda al momento; si falla, vuelve como estaba y lo dice. */
function ActiveSwitch({
  path,
  storeId,
  name,
  active,
  canEdit,
}: {
  path: string
  storeId: string
  name: string
  active: boolean
  canEdit: boolean
}) {
  const queryClient = useQueryClient()
  const toggle = useMutation({
    mutationFn: (isActive: boolean) => api(path, { method: "PATCH", body: { isActive } }),
    onSuccess: async (_, isActive) => {
      await queryClient.invalidateQueries({ queryKey: LISTS_KEY(storeId) })
      toast.success(isActive ? `${name}: encendido` : `${name}: apagado, Sofi ya no lo ofrece`)
    },
    onError: (error) => toast.error(error.message),
  })
  const shown = toggle.isPending ? Boolean(toggle.variables) : active
  if (!canEdit) return <Badge variant="outline">{active ? "Encendido" : "Apagado"}</Badge>
  return (
    <div className="flex items-center gap-2 text-sm">
      <Switch
        checked={shown}
        disabled={toggle.isPending}
        onCheckedChange={(next) => toggle.mutate(next)}
        aria-label={`${name}: ${shown ? "encendido" : "apagado"}`}
      />
      <span aria-hidden>{shown ? "Encendido" : "Apagado"}</span>
    </div>
  )
}

function PaymentRow({
  method,
  canEdit,
  onEdit,
}: {
  method: PaymentMethod
  canEdit: boolean
  onEdit: () => void
}) {
  const { store } = useStoreContext()
  return (
    <li
      className={`grid gap-x-4 gap-y-2 px-5 py-3.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-center ${method.isActive ? "" : "text-muted-foreground"}`}
    >
      <div className="font-semibold">{method.name}</div>
      <div className="flex flex-col text-sm">
        <span>{PAYMENT_TYPES[method.typeCode]}</span>
        <span className="text-muted-foreground">{COLLECTIONS[method.collection].name}</span>
      </div>
      <div className="min-w-0 text-sm break-words">
        {method.details ||
          (method.collection === "link" ? (
            <span className="text-muted-foreground">Se paga con el link de la tienda</span>
          ) : (
            <span className="text-muted-foreground">Sin datos para enviar</span>
          ))}
      </div>
      <div className="flex items-center gap-2">
        <ActiveSwitch
          path={`/api/tiendas/${store.id}/medios-de-pago/${method.id}`}
          storeId={store.id}
          name={method.name}
          active={method.isActive}
          canEdit={canEdit}
        />
        {canEdit ? (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Editar<span className="sr-only"> {method.name}</span>
          </Button>
        ) : null}
      </div>
    </li>
  )
}

function deliveryCostText(method: DeliveryMethod, currency: string): string {
  switch (method.cost) {
    case "gratis":
      return "Gratis"
    case "fijo":
      return money(method.priceCents ?? 0, currency)
    case "por_zona":
      return `Por zona: ${method.zones.map((z) => `${z.name} ${money(z.priceCents, currency)}`).join(", ")}`
    default:
      return "Se acuerda en el chat"
  }
}

function dealText(method: DeliveryMethod, currency: string): string | null {
  const parts = [
    method.maxDiscountCents
      ? `Sofi puede rebajarlo hasta ${money(method.maxDiscountCents, currency)}`
      : null,
    method.freeFromCents ? `gratis desde ${money(method.freeFromCents, currency)}` : null,
  ].filter(Boolean)
  if (parts.length === 0) return null
  const text = parts.join(" y ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function DeliveryRow({
  method,
  currency,
  canEdit,
  onEdit,
}: {
  method: DeliveryMethod
  currency: string
  canEdit: boolean
  onEdit: () => void
}) {
  const { store } = useStoreContext()
  const deal = dealText(method, currency)
  return (
    <li
      className={`grid gap-x-4 gap-y-2 px-5 py-3.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,0.9fr)_auto] sm:items-center ${method.isActive ? "" : "text-muted-foreground"}`}
    >
      <div className="flex min-w-0 flex-col">
        <span className="font-semibold">{method.name}</span>
        <span className="text-sm text-muted-foreground">
          {[method.details, method.acceptsPayOnDelivery ? "Acepta pago al recibir" : null]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <div className="text-sm">{DELIVERY_TYPES[method.type]}</div>
      <div className="flex min-w-0 flex-col text-sm">
        <span>{deliveryCostText(method, currency)}</span>
        {deal ? <span className="text-muted-foreground">{deal}</span> : null}
      </div>
      <div className="text-sm">
        {method.eta || <span className="text-muted-foreground">—</span>}
      </div>
      <div className="flex items-center gap-2">
        <ActiveSwitch
          path={`/api/tiendas/${store.id}/formas-de-entrega/${method.id}`}
          storeId={store.id}
          name={method.name}
          active={method.isActive}
          canEdit={canEdit}
        />
        {canEdit ? (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Editar<span className="sr-only"> {method.name}</span>
          </Button>
        ) : null}
      </div>
    </li>
  )
}

/** Borrar, con su confirmación: lo que ya se cobró o entregó conserva lo suyo. */
function DeleteButton({
  what,
  path,
  storeId,
  onDone,
}: {
  what: string
  path: string
  storeId: string
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [asking, setAsking] = useState(false)
  const remove = useMutation({
    mutationFn: () => api(path, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: LISTS_KEY(storeId) })
      toast.success(`${what} borrado`)
      setAsking(false)
      onDone()
    },
  })
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="mr-auto text-danger"
        onClick={() => setAsking(true)}
      >
        <Trash2 aria-hidden />
        Borrar
      </Button>
      <ConfirmDialog
        open={asking}
        title={`¿Borrar «${what}»?`}
        description="Sofi deja de ofrecerlo. Si solo es por un tiempo, mejor apágalo."
        confirmLabel="Borrar"
        pending={remove.isPending}
        error={remove.error?.message ?? null}
        onConfirm={() => remove.mutate()}
        onClose={() => setAsking(false)}
      />
    </>
  )
}

function PaymentForm({
  storeId,
  method,
  onClose,
}: {
  storeId: string
  method: PaymentMethod | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(method?.name ?? "")
  const [typeCode, setTypeCode] = useState<PaymentTypeCode>(method?.typeCode ?? "68")
  const [collection, setCollection] = useState<PaymentCollection>(
    method?.collection ?? "comprobante",
  )
  const [details, setDetails] = useState(method?.details ?? "")
  const [isActive, setIsActive] = useState(method?.isActive ?? true)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const save = useMutation({
    mutationFn: () => {
      const body = { name, typeCode, collection, details, isActive }
      return method
        ? api(`/api/tiendas/${storeId}/medios-de-pago/${method.id}`, { method: "PATCH", body })
        : api(`/api/tiendas/${storeId}/medios-de-pago`, { method: "POST", body })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: LISTS_KEY(storeId) })
      toast.success(method ? "Medio de pago guardado" : "Medio de pago agregado")
      onClose()
    },
    onError: (error) => setErrors(fieldErrors(error)),
  })
  const dirty = useDirty({ name, typeCode, collection, details, isActive })
  const cash = typeCode === "10"
  const detailsId = useId()

  function submit() {
    if (!name.trim()) return setErrors({ name: "Escribe cómo lo dirá Sofi" })
    setErrors({})
    save.mutate()
  }

  return (
    <FormSheet
      open
      title={method ? method.name : "Nuevo medio de pago"}
      dirty={dirty}
      description="Así se agrega cualquier medio, aunque no se parezca a los de la lista."
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          {method ? (
            <DeleteButton
              what={method.name}
              path={`/api/tiendas/${storeId}/medios-de-pago/${method.id}`}
              storeId={storeId}
              onDone={onClose}
            />
          ) : null}
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <SubmitButton type="submit" pending={save.isPending}>
            Guardar
          </SubmitButton>
        </>
      }
    >
      <FieldGroup className="gap-5">
        <TextField
          label="Nombre"
          value={name}
          onChange={setName}
          error={errors.name}
          help="Como lo dirá Sofi al cliente, por ejemplo «Yape» o «Transferencia BCP»."
          maxLength={80}
          autoFocus
        />
        <Field>
          <FieldLabel htmlFor="payment-type">Tipo</FieldLabel>
          <select
            id="payment-type"
            className={SELECT_CLASSES}
            value={typeCode}
            onChange={(e) => {
              const next = e.target.value as PaymentTypeCode
              setTypeCode(next)
              if (next === "10") setCollection("al_recibir")
            }}
          >
            {(Object.keys(PAYMENT_TYPES) as PaymentTypeCode[]).map((code) => (
              <option key={code} value={code}>
                {PAYMENT_TYPES[code]}
              </option>
            ))}
          </select>
        </Field>
        <FieldSet>
          <FieldLegend variant="label">Cómo se confirma el pago</FieldLegend>
          <div className="flex flex-col gap-2">
            {(Object.keys(COLLECTIONS) as PaymentCollection[]).map((option) => {
              const disabled = cash && option !== "al_recibir"
              return (
                <label
                  key={option}
                  className={`flex items-start gap-3 rounded-lg border p-3 has-checked:border-primary has-checked:bg-primary-soft/40 has-focus-visible:ring-3 has-focus-visible:ring-ring/30 ${disabled ? "opacity-50" : "cursor-pointer"}`}
                >
                  <input
                    type="radio"
                    name="collection"
                    value={option}
                    checked={collection === option}
                    disabled={disabled}
                    onChange={() => setCollection(option)}
                    className="mt-1 accent-[var(--primary-fill)]"
                  />
                  <span className="flex flex-col">
                    <span className="text-sm font-semibold">{COLLECTIONS[option].name}</span>
                    <span className="text-sm text-muted-foreground">
                      {COLLECTIONS[option].hint}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
          {cash ? <FieldDescription>El efectivo se cobra al entregar.</FieldDescription> : null}
          {errors.collection ? <FieldError>{errors.collection}</FieldError> : null}
        </FieldSet>
        <Field data-invalid={errors.details ? true : undefined}>
          <FieldLabel htmlFor={detailsId}>Lo que envía Sofi para pagar</FieldLabel>
          <Textarea
            id={detailsId}
            rows={3}
            maxLength={500}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder={collection === "link" ? "" : "987 654 321 · a nombre de Rosa Quispe"}
          />
          {errors.details ? (
            <FieldError>{errors.details}</FieldError>
          ) : (
            <FieldDescription>
              {collection === "link"
                ? "Con el link de pago, Sofi enviará un enlace por cada pedido cuando se conecte el proveedor."
                : "El número, la cuenta o a nombre de quién. Lo envía tal cual."}
            </FieldDescription>
          )}
        </Field>
        <SwitchField
          checked={isActive}
          onChange={setIsActive}
          label={isActive ? "Encendido: Sofi lo ofrece" : "Apagado: Sofi no lo ofrece"}
        />
        <FormAlert error={save.error} />
      </FieldGroup>
    </FormSheet>
  )
}

function DeliveryForm({
  storeId,
  currency,
  method,
  onClose,
}: {
  storeId: string
  currency: string
  method: DeliveryMethod | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(method?.name ?? "")
  const [type, setType] = useState<DeliveryType>(method?.type ?? "DeliveryModeOwnFleet")
  const [details, setDetails] = useState(method?.details ?? "")
  const [cost, setCost] = useState<DeliveryCost>(method?.cost ?? "fijo")
  const [price, setPrice] = useState(moneyInput(method?.priceCents ?? null, currency))
  const [zones, setZones] = useState(
    (method?.zones.length ? method.zones : [{ name: "", priceCents: 0 }]).map((z) => ({
      name: z.name,
      price: method?.zones.length ? moneyInput(z.priceCents, currency) : "",
    })),
  )
  const [eta, setEta] = useState(method?.eta ?? "")
  const [payOnDelivery, setPayOnDelivery] = useState(method?.acceptsPayOnDelivery ?? false)
  const [maxDiscount, setMaxDiscount] = useState(
    moneyInput(method?.maxDiscountCents ?? null, currency),
  )
  const [freeFrom, setFreeFrom] = useState(moneyInput(method?.freeFromCents ?? null, currency))
  const [isActive, setIsActive] = useState(method?.isActive ?? true)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const negotiable = cost === "fijo" || cost === "por_zona"
  const dirty = useDirty({
    name,
    type,
    details,
    cost,
    price,
    zones,
    eta,
    payOnDelivery,
    maxDiscount,
    freeFrom,
    isActive,
  })
  const payId = useId()

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      method
        ? api(`/api/tiendas/${storeId}/formas-de-entrega/${method.id}`, { method: "PATCH", body })
        : api(`/api/tiendas/${storeId}/formas-de-entrega`, { method: "POST", body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: LISTS_KEY(storeId) })
      toast.success(method ? "Forma de entrega guardada" : "Forma de entrega agregada")
      onClose()
    },
    onError: (error) => setErrors(fieldErrors(error)),
  })

  function submit() {
    const next: Record<string, string> = {}
    if (!name.trim()) next.name = "Escribe cómo lo dirá Sofi"
    const priceCents = cost === "fijo" ? readMoney(price, currency) : null
    if (cost === "fijo" && priceCents === null) next.priceCents = "Escribe el precio, como 8 o 8.50"
    const zoneValues = zones.map((z) => ({
      name: z.name.trim(),
      priceCents: readMoney(z.price, currency),
    }))
    if (cost === "por_zona" && zoneValues.some((z) => !z.name || z.priceCents === null))
      next.zones = "Cada zona necesita su nombre y su precio"
    const read = (text: string, key: string) => {
      if (!negotiable || !text.trim()) return null
      const value = readMoney(text, currency)
      if (!value) next[key] = "Escribe un monto mayor que 0, o déjalo vacío"
      return value
    }
    const maxDiscountCents = read(maxDiscount, "maxDiscountCents")
    const freeFromCents = read(freeFrom, "freeFromCents")
    setErrors(next)
    if (Object.keys(next).length > 0) return
    save.mutate({
      name,
      type,
      details,
      cost,
      priceCents,
      zones: cost === "por_zona" ? zoneValues : [],
      eta,
      acceptsPayOnDelivery: payOnDelivery,
      maxDiscountCents,
      freeFromCents,
      isActive,
    })
  }

  return (
    <FormSheet
      open
      title={method ? method.name : "Nueva forma de entrega"}
      dirty={dirty}
      description="Así se agrega cualquier forma, aunque no se parezca a las de la lista."
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          {method ? (
            <DeleteButton
              what={method.name}
              path={`/api/tiendas/${storeId}/formas-de-entrega/${method.id}`}
              storeId={storeId}
              onDone={onClose}
            />
          ) : null}
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <SubmitButton type="submit" pending={save.isPending}>
            Guardar
          </SubmitButton>
        </>
      }
    >
      <FieldGroup className="gap-5">
        <TextField
          label="Nombre"
          value={name}
          onChange={setName}
          error={errors.name}
          help="Como lo dirá Sofi al cliente."
          placeholder="Moto en San Juan de Lurigancho"
          maxLength={80}
          autoFocus
        />
        <Field>
          <FieldLabel htmlFor="delivery-type">Tipo</FieldLabel>
          <select
            id="delivery-type"
            className={SELECT_CLASSES}
            value={type}
            onChange={(e) => setType(e.target.value as DeliveryType)}
          >
            {(Object.keys(DELIVERY_TYPES) as DeliveryType[]).map((option) => (
              <option key={option} value={option}>
                {DELIVERY_TYPES[option]}
              </option>
            ))}
          </select>
        </Field>
        <TextField
          label="Detalle (opcional)"
          value={details}
          onChange={setDetails}
          error={errors.details}
          help="Lo que ayuda a elegirla: la dirección del recojo, la agencia."
          maxLength={300}
        />
        <FieldSet>
          <FieldLegend variant="label">Costo</FieldLegend>
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(DELIVERY_COSTS) as DeliveryCost[]).map((option) => (
              <label
                key={option}
                className="flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-sm has-checked:border-primary has-checked:bg-primary-soft/40 has-focus-visible:ring-3 has-focus-visible:ring-ring/30"
              >
                <input
                  type="radio"
                  name="cost"
                  value={option}
                  checked={cost === option}
                  onChange={() => setCost(option)}
                  className="accent-[var(--primary-fill)]"
                />
                {DELIVERY_COSTS[option]}
              </label>
            ))}
          </div>
        </FieldSet>
        {cost === "fijo" ? (
          <MoneyField
            label="Precio del envío"
            currency={currency}
            value={price}
            onChange={setPrice}
            error={errors.priceCents}
          />
        ) : null}
        {cost === "por_zona" ? (
          <FieldSet>
            <FieldLegend variant="label">Zonas</FieldLegend>
            <div className="flex flex-col gap-2">
              {zones.map((zone, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: las filas no tienen id hasta guardarse
                <div key={i} className="flex items-end gap-2">
                  <TextField
                    label={`Zona ${i + 1}`}
                    value={zone.name}
                    onChange={(value) =>
                      setZones(zones.map((z, j) => (j === i ? { ...z, name: value } : z)))
                    }
                    placeholder="Surco y Miraflores"
                    maxLength={60}
                    className="flex-1"
                  />
                  <MoneyField
                    label="Precio"
                    currency={currency}
                    value={zone.price}
                    onChange={(value) =>
                      setZones(zones.map((z, j) => (j === i ? { ...z, price: value } : z)))
                    }
                    className="w-28"
                  />
                  {zones.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Quitar la zona ${i + 1}`}
                      onClick={() => setZones(zones.filter((_, j) => j !== i))}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  ) : null}
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => setZones([...zones, { name: "", price: "" }])}
              >
                <Plus aria-hidden />
                Otra zona
              </Button>
            </div>
            {errors.zones ? <FieldError>{errors.zones}</FieldError> : null}
          </FieldSet>
        ) : null}
        <TextField
          label="Cuándo llega"
          value={eta}
          onChange={setEta}
          error={errors.eta}
          placeholder="El mismo día si pides antes de las 2 p. m."
          maxLength={120}
        />
        <div className="flex items-center gap-3 text-sm">
          <Checkbox
            id={payId}
            checked={payOnDelivery}
            onCheckedChange={(v) => setPayOnDelivery(Boolean(v))}
          />
          <label htmlFor={payId}>Acepta pago al recibir</label>
        </div>
        {negotiable ? (
          <FieldSet>
            <FieldLegend variant="label">Lo que Sofi puede negociar del envío</FieldLegend>
            <FieldDescription>Déjalo vacío si no se negocia.</FieldDescription>
            <div className="grid gap-3 sm:grid-cols-2">
              <MoneyField
                label="Rebajarlo hasta"
                currency={currency}
                value={maxDiscount}
                onChange={setMaxDiscount}
                error={errors.maxDiscountCents}
                help="Lo mismo que cuesta: puede regalarlo."
              />
              <MoneyField
                label="Gratis desde una compra de"
                currency={currency}
                value={freeFrom}
                onChange={setFreeFrom}
                error={errors.freeFromCents}
              />
            </div>
          </FieldSet>
        ) : null}
        <SwitchField
          checked={isActive}
          onChange={setIsActive}
          label={isActive ? "Encendida: Sofi la ofrece" : "Apagada: Sofi no la ofrece"}
        />
        <FormAlert error={save.error} />
      </FieldGroup>
    </FormSheet>
  )
}
