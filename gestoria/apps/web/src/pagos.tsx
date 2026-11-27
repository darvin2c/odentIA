import { Badge, Button, FieldGroup, toast } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import {
  ConfirmDialog,
  clockMinutes,
  EmptyState,
  ErrorState,
  FormDrawer,
  RadioChips,
  SubmitButton,
  submitErrorMessage,
  TimeSelect,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Clock, Plus, Trash2, Truck } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { z } from "zod"
import { MoneyInput, ToggleField } from "./campos"
import { api } from "./lib/api"
import type { Slot } from "./lib/despachos"
import {
  DELIVERY_COSTS,
  DELIVERY_TYPES,
  type DeliveryCost,
  type DeliveryMethod,
  type DeliveryType,
  money,
  moneyInput,
  readMoney,
} from "./lib/tienda"
import { StoreHeader, useStoreContext } from "./tiendas"

/**
 * Configuración › Entregas (lienzo B, tablero 6; «gestorIA como odentIA», tablero 10): cómo llega
 * el pedido, con un tipo de una lista estándar. Lo que se apaga, Sofi deja de ofrecerlo. Los
 * cambia quien tiene `configuracion`; soporte los mira sin cambiarlos. Cobros está en `cobros.tsx`.
 */

interface Lists {
  deliveries: DeliveryMethod[]
  slots: Slot[]
}

const LISTS_KEY = (storeId: string) => ["pagos-y-entregas", storeId]

/** Cobros está en `cobros.tsx` (lienzo «gestorIA · Configuración, de nuevo», tablero 6). */
export function DeliveriesPage() {
  const { store } = useStoreContext()
  const canEdit = store.permissions.includes("configuracion")
  const lists = useQuery({
    queryKey: LISTS_KEY(store.id),
    queryFn: () => api<Lists>(`/api/tiendas/${store.id}/pagos-y-entregas`),
  })
  const [delivery, setDelivery] = useState<DeliveryMethod | "new" | null>(null)

  return (
    <>
      <StoreHeader
        title="Entregas"
        subtitle="Cómo llega el pedido y cuánto cuesta. Lo que apagues, Sofi deja de ofrecerlo."
      />
      {lists.isError ? (
        <ErrorState
          error={lists.error instanceof Error ? lists.error : "No se pudo cargar"}
          onRetry={() => void lists.refetch()}
        />
      ) : null}
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
      {lists.data ? (
        <SlotsSection storeId={store.id} slots={lists.data.slots ?? []} canEdit={canEdit} />
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
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
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
    onError: (error) => toast.error(submitErrorMessage(error)),
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
        className="self-start text-danger"
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
        error={remove.isError ? submitErrorMessage(remove.error) : null}
        onConfirm={() => remove.mutate()}
        onClose={() => setAsking(false)}
      />
    </>
  )
}

/** Lo que el servidor llama distinto que el formulario. */
const DELIVERY_FIELDS = {
  priceCents: "price",
  maxDiscountCents: "maxDiscount",
  freeFromCents: "freeFrom",
  acceptsPayOnDelivery: "payOnDelivery",
}

/** Un monto que puede ir vacío: null si está vacío, undefined si no se entiende. */
function optionalMoney(text: string, currency: string): number | null | undefined {
  if (!text.trim()) return null
  return readMoney(text, currency) ?? undefined
}

/** Las reglas de una forma de entrega, con la moneda de la tienda. */
function deliverySchema(currency: string) {
  return z
    .object({
      name: z.string(),
      type: z.custom<DeliveryType>(),
      details: z.string(),
      cost: z.custom<DeliveryCost>(),
      price: z.string(),
      zones: z.array(z.object({ name: z.string(), price: z.string() })),
      eta: z.string(),
      payOnDelivery: z.boolean(),
      maxDiscount: z.string(),
      freeFrom: z.string(),
      isActive: z.boolean(),
    })
    .superRefine((value, ctx) => {
      // Todo en un solo refinamiento: zod no corre el refinamiento si ya hay otro error.
      if (!value.name.trim())
        ctx.addIssue({ code: "custom", path: ["name"], message: "Escribe cómo lo dirá Sofi" })
      if (value.cost === "fijo" && readMoney(value.price, currency) === null)
        ctx.addIssue({
          code: "custom",
          path: ["price"],
          message: "Escribe el precio, como 8 o 8.50",
        })
      if (
        value.cost === "por_zona" &&
        value.zones.some((zone) => !zone.name.trim() || readMoney(zone.price, currency) === null)
      )
        ctx.addIssue({
          code: "custom",
          path: ["zones"],
          message: "Cada zona necesita su nombre y su precio",
        })
      if (value.cost === "fijo" || value.cost === "por_zona")
        for (const key of ["maxDiscount", "freeFrom"] as const) {
          const amount = optionalMoney(value[key], currency)
          if (amount === undefined || amount === 0)
            ctx.addIssue({
              code: "custom",
              path: [key],
              message: "Escribe un monto mayor que 0, o déjalo vacío",
            })
        }
    })
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
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      method
        ? api(`/api/tiendas/${storeId}/formas-de-entrega/${method.id}`, { method: "PATCH", body })
        : api(`/api/tiendas/${storeId}/formas-de-entrega`, { method: "POST", body }),
  })
  const form = useAppForm({
    defaultValues: {
      name: method?.name ?? "",
      type: (method?.type ?? "DeliveryModeOwnFleet") as DeliveryType,
      details: method?.details ?? "",
      cost: (method?.cost ?? "fijo") as DeliveryCost,
      price: moneyInput(method?.priceCents ?? null, currency),
      zones: (method?.zones.length ? method.zones : [{ name: "", priceCents: 0 }]).map((z) => ({
        name: z.name,
        price: method?.zones.length ? moneyInput(z.priceCents, currency) : "",
      })),
      eta: method?.eta ?? "",
      payOnDelivery: method?.acceptsPayOnDelivery ?? false,
      maxDiscount: moneyInput(method?.maxDiscountCents ?? null, currency),
      freeFrom: moneyInput(method?.freeFromCents ?? null, currency),
      isActive: method?.isActive ?? true,
    },
    validators: { onSubmit: deliverySchema(currency) },
    onSubmit: async ({ value }) => {
      const negotiable = value.cost === "fijo" || value.cost === "por_zona"
      await save.mutateAsync({
        name: value.name,
        type: value.type,
        details: value.details,
        cost: value.cost,
        priceCents: value.cost === "fijo" ? readMoney(value.price, currency) : null,
        zones:
          value.cost === "por_zona"
            ? value.zones.map((z) => ({
                name: z.name.trim(),
                priceCents: readMoney(z.price, currency),
              }))
            : [],
        eta: value.eta,
        acceptsPayOnDelivery: value.payOnDelivery,
        maxDiscountCents: negotiable ? (optionalMoney(value.maxDiscount, currency) ?? null) : null,
        freeFromCents: negotiable ? (optionalMoney(value.freeFrom, currency) ?? null) : null,
        isActive: value.isActive,
      })
      await queryClient.invalidateQueries({ queryKey: LISTS_KEY(storeId) })
      toast.success(method ? "Forma de entrega guardada" : "Forma de entrega agregada")
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: DELIVERY_FIELDS })
  const costId = useId()

  const moneyField = (
    name: "price" | "maxDiscount" | "freeFrom",
    label: string,
    description?: string,
  ) => (
    <form.AppField name={name}>
      {(field) => (
        <field.Control label={label} description={description}>
          {(control) => (
            <MoneyInput
              control={control}
              currency={currency}
              value={field.state.value}
              onChange={field.handleChange}
            />
          )}
        </field.Control>
      )}
    </form.AppField>
  )

  return (
    <FormDrawer
      {...surface}
      open
      title={method ? method.name : "Nueva forma de entrega"}
      description="Así se agrega cualquier forma, aunque no se parezca a las de la lista."
      onClose={onClose}
      submitLabel="Guardar"
    >
      <FieldGroup className="gap-5">
        <form.AppField name="name">
          {(field) => (
            <field.TextField
              label="Nombre"
              description="Como lo dirá Sofi al cliente."
              placeholder="Moto en San Juan de Lurigancho"
              maxLength={80}
              autoFocus
            />
          )}
        </form.AppField>
        <form.AppField name="type">
          {(field) => (
            <field.SelectField
              label="Tipo"
              id="delivery-type"
              options={(Object.keys(DELIVERY_TYPES) as DeliveryType[]).map((option) => ({
                value: option,
                label: DELIVERY_TYPES[option],
              }))}
            />
          )}
        </form.AppField>
        <form.AppField name="details">
          {(field) => (
            <field.TextField
              label="Detalle (opcional)"
              description="Lo que ayuda a elegirla: la dirección del recojo, la agencia."
              maxLength={300}
            />
          )}
        </form.AppField>
        <form.AppField name="cost">
          {(field) => (
            <field.Group legend={<span id={costId}>Costo</span>}>
              {(control) => (
                <RadioChips
                  id={control.id}
                  aria-labelledby={costId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  options={(Object.keys(DELIVERY_COSTS) as DeliveryCost[]).map((option) => ({
                    value: option,
                    label: DELIVERY_COSTS[option],
                  }))}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        <form.Subscribe selector={(state) => state.values.cost}>
          {(cost) => (
            <>
              {cost === "fijo" ? moneyField("price", "Precio del envío") : null}
              {cost === "por_zona" ? (
                <form.AppField name="zones" mode="array">
                  {(field) => (
                    <field.Group legend="Zonas">
                      {() => (
                        <div className="flex flex-col gap-2">
                          {field.state.value.map((_, i) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: las filas no tienen id hasta guardarse
                            <div key={i} className="flex items-end gap-2">
                              <form.AppField name={`zones[${i}].name`}>
                                {(zone) => (
                                  <zone.TextField
                                    label={`Zona ${i + 1}`}
                                    placeholder="Surco y Miraflores"
                                    maxLength={60}
                                    className="flex-1"
                                  />
                                )}
                              </form.AppField>
                              <form.AppField name={`zones[${i}].price`}>
                                {(zone) => (
                                  <zone.Control label="Precio" className="w-28">
                                    {(control) => (
                                      <MoneyInput
                                        control={control}
                                        currency={currency}
                                        value={zone.state.value}
                                        onChange={zone.handleChange}
                                      />
                                    )}
                                  </zone.Control>
                                )}
                              </form.AppField>
                              {field.state.value.length > 1 ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Quitar la zona ${i + 1}`}
                                  onClick={() => field.removeValue(i)}
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
                            onClick={() => field.pushValue({ name: "", price: "" })}
                          >
                            <Plus aria-hidden />
                            Otra zona
                          </Button>
                        </div>
                      )}
                    </field.Group>
                  )}
                </form.AppField>
              ) : null}
            </>
          )}
        </form.Subscribe>
        <form.AppField name="eta">
          {(field) => (
            <field.TextField
              label="Cuándo llega"
              placeholder="El mismo día si pides antes de las 2 p. m."
              maxLength={120}
            />
          )}
        </form.AppField>
        <form.AppField name="payOnDelivery">
          {(field) => <field.CheckboxField label="Acepta pago al recibir" />}
        </form.AppField>
        <form.Subscribe
          selector={(state) => state.values.cost === "fijo" || state.values.cost === "por_zona"}
        >
          {(negotiable) =>
            negotiable ? (
              <FieldGroup className="gap-3">
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">Lo que Sofi puede negociar del envío</p>
                  <p className="text-sm text-muted-foreground">Déjalo vacío si no se negocia.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {moneyField(
                    "maxDiscount",
                    "Rebajarlo hasta",
                    "Lo mismo que cuesta: puede regalarlo.",
                  )}
                  {moneyField("freeFrom", "Gratis desde una compra de")}
                </div>
              </FieldGroup>
            ) : null
          }
        </form.Subscribe>
        <form.AppField name="isActive">
          {() => (
            <ToggleField
              label={(on) => (on ? "Encendida: Sofi la ofrece" : "Apagada: Sofi no la ofrece")}
            />
          )}
        </form.AppField>
        {method ? (
          <DeleteButton
            what={method.name}
            path={`/api/tiendas/${storeId}/formas-de-entrega/${method.id}`}
            storeId={storeId}
            onDone={onClose}
          />
        ) : null}
      </FieldGroup>
    </FormDrawer>
  )
}

/**
 * Las franjas de entrega (Despachos): opcionales. Un pedido sin franja sale igual, en «Sin franja»;
 * con ellas, Despachos agrupa cada día por franja y «Pasar a…» deja elegirla. Cada cambio se guarda
 * al momento; quitar una no cambia los pedidos que ya la tienen.
 */
function SlotsSection({
  storeId,
  slots,
  canEdit,
}: {
  storeId: string
  slots: Slot[]
  canEdit: boolean
}) {
  const queryClient = useQueryClient()
  const id = useId()
  const plain = slots.map((slot) => ({ start: slot.start, end: slot.end }))
  const saveSlots = (next: { start: number; end: number }[]) =>
    api(`/api/tiendas/${storeId}/franjas`, { method: "PATCH", body: { slots: next } })
  const remove = useMutation({
    mutationFn: saveSlots,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: LISTS_KEY(storeId) })
      toast.success("Franjas guardadas")
    },
  })
  const add = useMutation({ mutationFn: saveSlots })
  const form = useAppForm({
    defaultValues: { start: "", end: "" },
    validators: {
      onSubmit: z
        .object({
          start: z.string().min(1, "Elige desde qué hora"),
          end: z.string().min(1, "Elige hasta qué hora"),
        })
        .superRefine((value, ctx) => {
          const from = clockMinutes(value.start)
          const to = clockMinutes(value.end)
          if (from === null || to === null) return
          if (from >= to)
            ctx.addIssue({
              code: "custom",
              path: ["end"],
              message: "La franja termina después de empezar",
            })
          else if (plain.some((slot) => slot.start === from && slot.end === to))
            ctx.addIssue({ code: "custom", path: ["end"], message: "Esa franja ya está" })
        }),
    },
    onSubmit: async ({ value, formApi }) => {
      const from = clockMinutes(value.start) ?? 0
      const to = clockMinutes(value.end) ?? 0
      await add.mutateAsync([...plain, { start: from, end: to }])
      await queryClient.invalidateQueries({ queryKey: LISTS_KEY(storeId) })
      formApi.reset()
      toast.success("Franjas guardadas")
    },
  })
  const { onSubmit, isSubmitting: pending, error: addError } = useFormSurface(form)
  const timeField = (name: "start" | "end", label: string) => (
    <form.AppField name={name}>
      {(field) => (
        <field.Control label={label} className="w-36">
          {(control) => (
            <TimeSelect
              id={control.id}
              step={30}
              value={field.state.value}
              onChange={(next) => {
                field.handleChange(next)
                field.handleBlur()
              }}
              invalid={control.invalid}
              aria-describedby={control.describedBy}
              className="w-full"
            />
          )}
        </field.Control>
      )}
    </form.AppField>
  )
  return (
    <section aria-labelledby={id} className="elevated overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-col gap-1 border-b px-5 py-4">
        <h2 id={id} className="text-base font-semibold">
          Franjas de entrega
        </h2>
        <p className="text-sm text-muted-foreground">
          Opcionales. En Despachos, cada día se ordena por franja; un pedido sin franja sale igual.
        </p>
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">
        {slots.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no hay franjas.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {slots.map((slot) => (
              <li
                key={`${slot.start}-${slot.end}`}
                className="flex items-center gap-1 rounded-full border py-1 pr-1 pl-3 text-sm"
              >
                <Clock aria-hidden className="size-3.5 text-muted-foreground" />
                {slot.label}
                {canEdit ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Quitar la franja ${slot.label}`}
                    disabled={remove.isPending || pending}
                    onClick={() =>
                      remove.mutate(
                        plain.filter((s) => s.start !== slot.start || s.end !== slot.end),
                      )
                    }
                  >
                    <Trash2 aria-hidden />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <form noValidate className="flex flex-col gap-2" onSubmit={onSubmit}>
            <FieldGroup className="flex-row flex-wrap items-end gap-3">
              {timeField("start", "Desde")}
              {timeField("end", "Hasta")}
              <SubmitButton type="submit" variant="outline" pending={pending}>
                <Plus aria-hidden />
                Agregar franja
              </SubmitButton>
            </FieldGroup>
            {addError ? (
              <p role="alert" className="text-sm text-danger">
                {addError}
              </p>
            ) : null}
          </form>
        ) : null}
        {remove.isError ? (
          <p role="alert" className="text-sm text-danger">
            {submitErrorMessage(remove.error)}
          </p>
        ) : null}
      </div>
    </section>
  )
}
