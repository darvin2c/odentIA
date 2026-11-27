import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@odentia/ui"
import {
  DatePickerButton,
  FormDrawer,
  FormFieldGroup,
  RadioChips,
  SubmitButton,
  useAppForm,
  useFieldContext,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Plus, Trash2 } from "lucide-react"
import { useCallback, useId, useSyncExternalStore } from "react"
import { z } from "zod"
import { MoneyInput } from "./campos"
import { api } from "./lib/api"
import { CASH_KEY } from "./lib/caja"
import { type Courier, DISPATCH_KEY, noticeLink, noticeText, type Slot } from "./lib/despachos"
import { HOME_KEY } from "./lib/inicio"
import {
  type Balance,
  dayName,
  MISSED_REASONS,
  nextDay,
  type OrderDetail,
  type OrderState,
  storeToday,
} from "./lib/pedidos"
import {
  type DeliveryMethod,
  type DeliveryType,
  money,
  moneyInput,
  type PaymentMethod,
  readMoney,
} from "./lib/tienda"
import { ReceiptImage, shrinkPhoto } from "./piezas"
import { useStoreContext } from "./tiendas"

/**
 * Lo que se hace con una entrega (entrega 3 del lienzo «gestorIA como odentIA», tableros 6, 17 y
 * 24), igual desde Despachos y desde el pedido: «Salió», «Entregado», «No se entregó», «Pasar a…»,
 * «Cambiar repartidor», el envío por agencia y «Avisar». Cada uno es la operación del pedido en el
 * servidor; aquí solo se elige y se dice lo que pasa.
 *
 * Cada paso es un formulario común (`FormDrawer` con `useAppForm`): en una ventana ancha se abre en
 * la columna lateral, con la lista a la vista; lo que el servidor rechaza se dice en su campo.
 * «Cambiar repartidor» reasigna: va siempre en cajón, para decidir antes de seguir.
 *
 * «Pasar a…» es la única forma de mover una entrega: sin arrastrar, con teclado y en el celular.
 */

/** Lo que estas acciones necesitan de una entrega: lo tienen la fila de Despachos y el pedido. */
export interface DeliveryTarget {
  id: string
  number: string
  state: OrderState
  customerName: string
  customerPhone: string | null
  deliveryType: DeliveryType
  deliverOn: string | null
  slot: Slot | null
  courierId: string | null
  courierName: string | null
  agency: string | null
  tracking: string | null
  totalCents: number
  paymentName: string
  balance: Balance
}

/** La entrega de un pedido abierto, para estas acciones. */
export function targetOf(order: OrderDetail): DeliveryTarget {
  return order
}

/** Las agencias de siempre (tablero 17); otra se escribe. */
export const AGENCIES = ["Shalom", "Olva Courier", "Marvisur"] as const

/** Los medios de pago, las franjas y los repartidores de la tienda. */
export function useDeliveryOptions() {
  const { store } = useStoreContext()
  const query = useQuery({
    queryKey: ["pagos-y-entregas", store.id],
    queryFn: () =>
      api<{
        payments: PaymentMethod[]
        deliveries: DeliveryMethod[]
        slots?: Slot[]
        couriers?: Courier[]
      }>(`/api/tiendas/${store.id}/pagos-y-entregas`),
  })
  return {
    payments: query.data?.payments ?? [],
    slots: query.data?.slots ?? [],
    couriers: query.data?.couriers ?? [],
    /** Todavía no llegan: el formulario espera para empezar con lo que ya tiene la entrega. */
    isPending: query.isPending,
  }
}

/**
 * Una operación de la entrega. Al terminar se ponen al día el pedido, Pedidos, Despachos, su número
 * en el menú y Caja: todos dicen lo mismo.
 */
export function useDeliveryAction(orderId: string, onDone?: () => void) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      path,
      body,
      form,
    }: {
      path: string
      body?: unknown
      form?: FormData
      done?: string
    }) =>
      api<{ order: OrderDetail }>(`/api/tiendas/${store.id}/pedidos/${orderId}/${path}`, {
        method: "POST",
        ...(form ? { form } : { body: body ?? {} }),
      }),
    onSuccess: async (data, vars) => {
      queryClient.setQueryData(["pedido", store.id, orderId], data.order)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["pedidos", store.id] }),
        queryClient.invalidateQueries({ queryKey: DISPATCH_KEY(store.id) }),
        queryClient.invalidateQueries({ queryKey: ["despachos-resumen", store.id] }),
        queryClient.invalidateQueries({ queryKey: CASH_KEY(store.id) }),
        queryClient.invalidateQueries({ queryKey: HOME_KEY(store.id) }),
        queryClient.invalidateQueries({ queryKey: ["pagos-y-entregas", store.id] }),
      ])
      if (vars.done) toast.success(vars.done)
      onDone?.()
    },
  })
}

export type DeliveryStep =
  | "salio"
  | "entregado"
  | "no_entregado"
  | "pasar"
  | "repartidor"
  | "envio"
  | "avisar"

/** El paso abierto de una entrega, o ninguno. */
export function DeliveryStepDialog({
  target,
  step,
  onClose,
}: {
  target: DeliveryTarget
  step: DeliveryStep | null
  onClose: () => void
}) {
  switch (step) {
    case "salio":
      return <ShipDialog target={target} onClose={onClose} />
    case "envio":
      return <ShipDialog target={target} onClose={onClose} later />
    case "entregado":
      return <DeliverDialog target={target} onClose={onClose} />
    case "no_entregado":
      return <MissedDialog target={target} onClose={onClose} />
    case "pasar":
      return <MoveDialog target={target} onClose={onClose} />
    case "repartidor":
      return <CourierDialog target={target} onClose={onClose} />
    case "avisar":
      return <NoticeDialog target={target} onClose={onClose} />
    default:
      return null
  }
}

/* ------------------------------------------------------------------------------- piezas */

/**
 * Lo escrito en un formulario de `useAppForm`, al día: para lo que se dice mientras se llena (la
 * suma de lo cobrado, el botón «Pasar a mañana») y lo que aparece según lo elegido.
 */
export function useFormValues<T>(form: {
  store: {
    readonly state: { values: T }
    subscribe: (listener: () => void) => { unsubscribe: () => void }
  }
}): T {
  const { store } = form
  const subscribe = useCallback(
    (listener: () => void) => {
      const subscription = store.subscribe(listener)
      return () => subscription.unsubscribe()
    },
    [store],
  )
  return useSyncExternalStore(subscribe, () => store.state.values)
}

/** «Hoy», «Mañana» y el calendario para otro día (desde hoy, el de la tienda). */
function DayButtons({
  today,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  today: string
  value: string
  onChange: (day: string) => void
  invalid?: boolean
  describedBy?: string
}) {
  const tomorrow = nextDay(today)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant={value === today ? "default" : "outline"}
        aria-pressed={value === today}
        onClick={() => onChange(today)}
      >
        Hoy
      </Button>
      <Button
        type="button"
        size="sm"
        variant={value === tomorrow ? "default" : "outline"}
        aria-pressed={value === tomorrow}
        onClick={() => onChange(tomorrow)}
      >
        Mañana
      </Button>
      <DatePickerButton
        value={value}
        onChange={onChange}
        min={today}
        aria-label="Otro día"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className="min-w-44"
      />
    </div>
  )
}

/**
 * Hoy, mañana u otro día, fuera de un formulario de `useAppForm` (lo usa «Cambio o devolución»):
 * con su nombre y su error.
 */
export function DayChoice({
  today,
  value,
  onChange,
  error,
  label = "Día de entrega",
}: {
  today: string
  value: string
  onChange: (day: string) => void
  error?: string
  label?: string
}) {
  const id = useId()
  return (
    <FieldSet
      data-invalid={error ? true : undefined}
      aria-describedby={error ? `${id}-error` : undefined}
    >
      <FieldLegend variant="label">{label}</FieldLegend>
      <DayButtons
        today={today}
        value={value}
        onChange={onChange}
        invalid={Boolean(error)}
        describedBy={error ? `${id}-error` : undefined}
      />
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </FieldSet>
  )
}

/**
 * Hoy, mañana u otro día dentro de un formulario: va dentro de `form.AppField`, que le da el dato,
 * y dice su error debajo del grupo.
 */
export function DayField({ today, legend = "Día de entrega" }: { today: string; legend?: string }) {
  const field = useFieldContext<string>()
  return (
    <FormFieldGroup legend={legend}>
      {(control) => (
        <DayButtons
          today={today}
          value={field.state.value}
          onChange={(day) => field.handleChange(day)}
          invalid={control.invalid}
          describedBy={control.describedBy}
        />
      )}
    </FormFieldGroup>
  )
}

const slotKey = (slot: Pick<Slot, "start" | "end"> | null) =>
  slot ? `${slot.start}-${slot.end}` : ""

/** «Sin franja» en el formulario. */
const NO_SLOT = "sin"

/** Las franjas para elegir: las de la tienda y la que ya tiene, aunque la tienda la haya quitado. */
function slotOptions(slots: Slot[], current: Slot | null): Slot[] {
  return current && !slots.some((s) => slotKey(s) === slotKey(current))
    ? [...slots, current]
    : slots
}

function slotOf(key: string, options: Slot[]): Slot | null {
  return key === NO_SLOT ? null : (options.find((s) => slotKey(s) === key) ?? null)
}

/**
 * La franja: una de las de la tienda o «Sin franja», en pastillas. Sin franjas configuradas, no se
 * muestra. Va dentro de `form.AppField`.
 */
function SlotField({ options }: { options: Slot[] }) {
  const field = useFieldContext<string>()
  if (options.length === 0) return null
  return (
    <FormFieldGroup legend="Franja">
      {(control) => (
        <RadioChips
          aria-label="Franja"
          aria-describedby={control.describedBy}
          invalid={control.invalid}
          onBlur={control.onBlur}
          value={field.state.value}
          onChange={(key) => field.handleChange(key)}
          options={[
            ...options.map((slot) => ({ value: slotKey(slot), label: slot.label })),
            { value: NO_SLOT, label: "Sin franja" },
          ]}
        />
      )}
    </FormFieldGroup>
  )
}

/** Lo que se elige como repartidor, como lo pide el servidor. */
type CourierPick = { courierId: string } | { userId: string } | { name: string } | null

const NEW = "nuevo"

function pickOf(value: string, name: string): CourierPick {
  if (value === "") return null
  if (value === NEW) return { name: name.trim() }
  if (value.startsWith("c:")) return { courierId: value.slice(2) }
  return { userId: value.slice(2) }
}

/** Quién lo lleva ahora, como opción de la lista. */
function courierInitial(target: Pick<DeliveryTarget, "courierId">, couriers: Courier[]): string {
  const own = couriers.find((c) => c.id !== null && c.id === target.courierId)
  return target.courierId
    ? own
      ? own.team
        ? `u:${own.userId}`
        : `c:${own.id}`
      : `c:${target.courierId}`
    : ""
}

/** Una persona del equipo, uno externo que ya se usó, quien lo lleva ahora, otro escrito o ninguno. */
function courierOptions(
  couriers: Courier[],
  current: Pick<DeliveryTarget, "courierId" | "courierName">,
) {
  const listed = couriers.some((c) => c.id === current.courierId)
  return [
    { value: "", label: "Sin repartidor" },
    ...couriers.map((c) => ({
      value: c.team ? `u:${c.userId}` : `c:${c.id}`,
      label: c.team ? `${c.name} (del equipo)` : c.name,
    })),
    ...(current.courierId && !listed
      ? [{ value: `c:${current.courierId}`, label: current.courierName ?? "Quien lo lleva" }]
      : []),
    { value: NEW, label: "Otro: escribe el nombre" },
  ]
}

const COURIER_NAME_HELP =
  "Queda para la próxima vez. Cuando entre con su propia app, sus entregas siguen con su nombre."

/** El repartidor en el formulario: lo elegido en la lista y, con «Otro», el nombre escrito. */
interface CourierValue {
  choice: string
  name: string
}

/** «Otro: escribe el nombre» sin nombre. */
function checkCourier(courier: CourierValue, ctx: z.RefinementCtx) {
  if (courier.choice === NEW && courier.name.trim() === "")
    ctx.addIssue({
      code: "custom",
      path: ["courier"],
      message: "Escribe el nombre de quien lo lleva",
    })
}

const courierShape = z.object({ choice: z.string(), name: z.string() })

/** Lo que se le manda al servidor, solo si cambió quién lo lleva. */
function courierBody(courier: CourierValue, initial: string) {
  const changed = courier.choice !== initial || courier.choice === NEW
  return changed ? { courier: pickOf(courier.choice, courier.name) } : {}
}

/**
 * El repartidor y, con «Otro», su nombre: un solo dato del formulario (va dentro de
 * `form.AppField`), con su error debajo de los dos.
 */
function CourierField({
  couriers,
  target,
}: {
  couriers: Courier[]
  target: Pick<DeliveryTarget, "courierId" | "courierName">
}) {
  const field = useFieldContext<CourierValue>()
  const value = field.state.value
  const options = courierOptions(couriers, target)
  const nameId = useId()
  return (
    <FormFieldGroup legend="Repartidor">
      {(control) => (
        <div className="flex flex-col gap-3">
          <Select
            items={Object.fromEntries(options.map((option) => [option.value, option.label]))}
            value={value.choice}
            onValueChange={(next) =>
              field.handleChange({ ...value, choice: next == null ? "" : String(next) })
            }
          >
            <SelectTrigger
              aria-label="Repartidor"
              aria-invalid={(control.invalid && value.choice !== NEW) || undefined}
              aria-describedby={control.describedBy}
              className="w-full"
            >
              <SelectValue placeholder="Sin repartidor" />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value} data-value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {value.choice === NEW ? (
            <Field data-invalid={control.invalid || undefined}>
              <FieldLabel htmlFor={nameId}>Nombre de quien lo lleva</FieldLabel>
              <Input
                id={nameId}
                value={value.name}
                maxLength={80}
                autoFocus
                aria-invalid={control.invalid || undefined}
                aria-describedby={[`${nameId}-ayuda`, control.describedBy]
                  .filter(Boolean)
                  .join(" ")}
                onChange={(event) => field.handleChange({ ...value, name: event.target.value })}
              />
              <FieldDescription id={`${nameId}-ayuda`}>{COURIER_NAME_HELP}</FieldDescription>
            </Field>
          ) : null}
        </div>
      )}
    </FormFieldGroup>
  )
}

/* ----------------------------------------------------------------------------- los pasos */

/** «Salió» (o, después, la agencia y su número): por agencia, con cuál va y su número de envío. */
function ShipDialog({
  target,
  onClose,
  later = false,
}: {
  target: DeliveryTarget
  onClose: () => void
  later?: boolean
}) {
  const parcel = target.deliveryType === "ParcelService"
  const known = target.agency && AGENCIES.includes(target.agency as (typeof AGENCIES)[number])
  const action = useDeliveryAction(target.id, onClose)
  const chosenAgency = (value: { agency: string; otherAgency: string }) =>
    value.agency === NEW ? value.otherAgency.trim() : value.agency
  const form = useAppForm({
    defaultValues: {
      agency: target.agency ? (known ? target.agency : NEW) : "",
      otherAgency: known ? "" : (target.agency ?? ""),
      tracking: target.tracking ?? "",
    },
    validators: {
      onSubmit: z
        .object({ agency: z.string(), otherAgency: z.string(), tracking: z.string() })
        .superRefine((value, ctx) => {
          // Después, se anota al menos una de las dos cosas.
          if (later && !chosenAgency(value) && !value.tracking.trim())
            ctx.addIssue({
              code: "custom",
              path: ["tracking"],
              message: "Anota la agencia o el número de envío",
            })
        }),
    },
    onSubmit: async ({ value }) => {
      await action.mutateAsync({
        path: later ? "envio" : "salio",
        body: { agency: parcel ? chosenAgency(value) : "", tracking: value.tracking },
        done: later ? "Envío anotado" : "En camino",
      })
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: (key) =>
      key === "agency" && form.state.values.agency === NEW ? "otherAgency" : undefined,
  })
  const otherAgency = useFormValues(form).agency === NEW
  return (
    <FormDrawer
      {...surface}
      open
      title={later ? `Envío por agencia · ${target.number}` : `El pedido ${target.number} salió`}
      description={
        later
          ? "La agencia y el número de envío que te dio. Con el número, cualquiera lo sigue en la página de la agencia."
          : parcel
            ? "Pasa a «En camino». Anota con qué agencia va; el número de envío lo puedes anotar después."
            : "Pasa a «En camino». Si tiene número de envío, anótalo."
      }
      submitLabel={later ? "Guardar" : "Salió"}
      cancelLabel="Volver"
      onClose={onClose}
    >
      <FieldGroup className="gap-3">
        {parcel ? (
          <>
            <form.AppField name="agency">
              {(field) => (
                <field.SelectField
                  label="Agencia"
                  options={[
                    { value: "", label: "Elige la agencia" },
                    ...AGENCIES.map((a) => ({ value: a, label: a })),
                    { value: NEW, label: "Otra: escribe cuál" },
                  ]}
                />
              )}
            </form.AppField>
            {otherAgency ? (
              <form.AppField name="otherAgency">
                {(field) => <field.TextField label="¿Cuál agencia?" maxLength={60} autoFocus />}
              </form.AppField>
            ) : null}
          </>
        ) : null}
        <form.AppField name="tracking">
          {(field) => (
            <field.TextField
              label={later ? "Número de envío" : "Número de envío (opcional)"}
              maxLength={80}
              description={parcel ? "El código de seguimiento que te da la agencia." : undefined}
            />
          )}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

interface DoorLine {
  key: number
  methodId: string
  amount: string
}

/**
 * «Entregado». Sin pago confirmado no se entrega (tablero 24): si falta cobrar, se anota aquí lo
 * cobrado, con cada medio, y tiene que ser todo lo que falta; un pago por confirmar se confirma
 * antes, en este mismo paso.
 */
function DeliverDialog({ target, onClose }: { target: DeliveryTarget; onClose: () => void }) {
  const { store } = useStoreContext()
  const cur = store.currency
  const due = target.balance.dueCents
  const pending = target.balance.pendingCents
  const options = useDeliveryOptions()
  const methods = options.payments.filter(
    (m) => m.collection === "al_recibir" && (m.isActive || m.name === target.paymentName),
  )
  const first = (methods.find((m) => m.name === target.paymentName) ?? methods[0])?.id ?? ""
  const action = useDeliveryAction(target.id, onClose)
  const charge = due > 0
  const filledOf = (lines: DoorLine[]) =>
    lines.map((line) => ({
      methodId: line.methodId || first,
      amountCents: readMoney(line.amount, cur) ?? 0,
    }))
  const sumOf = (lines: DoorLine[]) =>
    filledOf(lines).reduce((total, line) => total + line.amountCents, 0)
  const form = useAppForm({
    // El medio de siempre llega con los medios de la tienda: sin tocar nada, el formulario lo toma.
    defaultValues: {
      lines: [{ key: 0, methodId: first, amount: moneyInput(due, cur) }] as DoorLine[],
      voucher: null as File | null,
    },
    validators: {
      onSubmit: z
        .object({
          lines: z.array(z.object({ key: z.number(), methodId: z.string(), amount: z.string() })),
          voucher: z.custom<File | null>(),
        })
        .superRefine((value, ctx) => {
          // Sin todo el pago no se entrega: lo anotado es justo lo que falta, sin el vuelto.
          if (charge && sumOf(value.lines) !== due)
            ctx.addIssue({
              code: "custom",
              path: ["lines", value.lines.length - 1, "amount"],
              message: `Lo cobrado tiene que sumar ${money(due, cur)}.`,
            })
        }),
    },
    onSubmit: async ({ value }) => {
      const body = charge ? { payments: filledOf(value.lines) } : {}
      if (charge && value.voucher) {
        const data = new FormData()
        data.set("datos", JSON.stringify(body))
        data.set("voucher", await shrinkPhoto(value.voucher))
        await action.mutateAsync({ path: "entregado", form: data, done: "Entregado" })
      } else await action.mutateAsync({ path: "entregado", body, done: "Entregado" })
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: (key) =>
      key === "collectedCents" ? `lines[${form.state.values.lines.length - 1}].amount` : undefined,
  })
  const lines = useFormValues(form).lines
  const sum = sumOf(lines)
  const card = filledOf(lines).some(
    (line) => methods.find((m) => m.id === line.methodId)?.typeCode === "48",
  )

  return (
    <FormDrawer
      {...surface}
      open
      isLoading={charge && options.isPending}
      title={
        pending > 0
          ? `Antes de entregar · ${target.number}`
          : charge
            ? `Cobrar ${money(due, cur)} y entregar`
            : `El pedido ${target.number} llegó`
      }
      description={
        pending > 0
          ? `Hay un pago de ${money(pending, cur)} por confirmar. Sin pago confirmado no se entrega: mira la captura y confírmalo aquí mismo; si no coincide, dilo en el pedido.`
          : charge
            ? due < target.totalCents
              ? `Falta cobrar ${money(due, cur)} de ${money(target.totalCents, cur)}. Anota lo que cobraste y con qué: queda a nombre de quien lo llevó.`
              : `Anota lo que cobraste y con qué: queda a nombre de quien lo llevó.`
            : "Pasa a «Entregado»."
      }
      submitLabel={charge ? `Cobré ${money(sum, cur)} y entregué` : "Entregado"}
      cancelLabel="Volver"
      // Con un pago por confirmar, o sin un medio para cobrar en la puerta, todavía no se entrega.
      submitDisabled={pending > 0 || (charge && methods.length === 0)}
      onClose={onClose}
    >
      {pending > 0 ? (
        <PendingPayments target={target} />
      ) : charge ? (
        <FieldGroup className="gap-3">
          {methods.length === 0 && !options.isPending ? (
            <p className="text-sm text-warning">
              La tienda no tiene un medio para cobrar al recibir. Agrégalo en Configuración, en
              Medios de pago.
            </p>
          ) : null}
          <form.AppField name="lines" mode="array">
            {(linesField) => (
              <>
                {linesField.state.value.map((line, i) => (
                  <div key={line.key} className="flex items-start gap-2">
                    <form.AppField name={`lines[${i}].methodId`}>
                      {(field) => (
                        <field.SelectField
                          className="min-w-0 flex-1"
                          label={linesField.state.value.length > 1 ? `Medio ${i + 1}` : "Medio"}
                          options={methods.map((m) => ({ value: m.id, label: m.name }))}
                        />
                      )}
                    </form.AppField>
                    <form.AppField name={`lines[${i}].amount`}>
                      {(field) => (
                        <field.Control label="Cobraste" className="w-32">
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
                    {linesField.state.value.length > 1 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="mt-6"
                        aria-label={`Quitar el medio ${i + 1}`}
                        onClick={() => linesField.removeValue(i)}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                ))}
                {linesField.state.value.length < 3 && methods.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-fit"
                    onClick={() => {
                      const all = linesField.state.value
                      linesField.pushValue({
                        key: Math.max(...all.map((one) => one.key)) + 1,
                        methodId:
                          methods.find((m) => !all.some((one) => (one.methodId || first) === m.id))
                            ?.id ?? first,
                        amount: moneyInput(Math.max(0, due - sumOf(all)), cur),
                      })
                    }}
                  >
                    <Plus aria-hidden />
                    Agregar otro medio
                  </Button>
                ) : null}
              </>
            )}
          </form.AppField>
          <p
            className={`text-sm ${sum === due ? "text-muted-foreground" : "text-warning"}`}
            role={sum === due ? undefined : "status"}
          >
            {sum === due
              ? `Suma ${money(sum, cur)}: es lo que falta.`
              : sum < due
                ? `Faltan ${money(due - sum, cur)}: sin todo el pago no se entrega.`
                : `Es ${money(sum - due, cur)} más de lo que falta: anota solo lo que debía, sin el vuelto.`}
          </p>
          {card ? (
            <form.AppField name="voucher">
              {(field) => (
                <field.Control
                  label="Foto del voucher del POS (opcional)"
                  description="Queda en el pedido; la clienta no la ve."
                >
                  {(control) => (
                    <input
                      {...control.props}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="text-sm"
                      onChange={(e) => field.handleChange(e.target.files?.[0] ?? null)}
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
          ) : null}
          <p className="text-xs text-muted-foreground">
            ¿Pagó con Yape o Plin al número de la tienda? Anota su captura en el pedido y
            confírmala: así queda el pago confirmado antes de entregar.
          </p>
        </FieldGroup>
      ) : null}
    </FormDrawer>
  )
}

/**
 * El pago que espera a una persona, en el mismo paso de entregar (tableros 6 y 24: «¿ya te
 * pagó?»): la captura y «Ya me pagó: confirmar», la misma revisión del pedido. Confirmado, el
 * paso sigue abierto y pasa a entregar (o a cobrar lo que falte). «No coincide» pide motivo y se
 * dice en el pedido.
 */
function PendingPayments({ target }: { target: DeliveryTarget }) {
  const { store } = useStoreContext()
  const cur = store.currency
  const queryClient = useQueryClient()
  const canConfirm = store.permissions.includes("pagos.confirmar")
  const detail = useQuery({
    queryKey: ["pedido", store.id, target.id],
    queryFn: async () =>
      (await api<{ order: OrderDetail }>(`/api/tiendas/${store.id}/pedidos/${target.id}`)).order,
  })
  const confirm = useMutation({
    mutationFn: (paymentId: string) =>
      api<{ order: OrderDetail }>(
        `/api/tiendas/${store.id}/pedidos/${target.id}/pagos/${paymentId}/revision`,
        { method: "POST", body: { decision: "confirmar" } },
      ),
    onSuccess: async (data) => {
      queryClient.setQueryData(["pedido", store.id, target.id], data.order)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["pedidos", store.id] }),
        queryClient.invalidateQueries({ queryKey: DISPATCH_KEY(store.id) }),
        queryClient.invalidateQueries({ queryKey: CASH_KEY(store.id) }),
        queryClient.invalidateQueries({ queryKey: HOME_KEY(store.id) }),
      ])
      toast.success("Pago confirmado: ya puedes entregar")
    },
  })
  const waiting = (detail.data?.payments ?? []).filter((p) => p.status === "por_confirmar")
  return (
    <div className="flex flex-col gap-3">
      {detail.isPending ? <p className="text-sm text-muted-foreground">Cargando el pago…</p> : null}
      {waiting.map((payment) => (
        <div key={payment.id} className="flex flex-col gap-2 rounded-lg border px-3 py-2.5">
          <span className="text-sm font-medium">
            {payment.methodName} · {money(payment.amountCents, cur)}
            {payment.operation ? (
              <span className="font-normal text-muted-foreground"> · op. {payment.operation}</span>
            ) : null}
          </span>
          {payment.hasPhoto ? (
            <ReceiptImage storeId={store.id} orderId={target.id} paymentId={payment.id} />
          ) : null}
          {payment.overIfConfirmedCents > 0 ? (
            <p className="text-sm text-warning">
              Con este pago se cobra {money(payment.overIfConfirmedCents, cur)} más que el total: si
              lo confirmas, queda como pago doble para revisar.
            </p>
          ) : null}
          {canConfirm ? (
            <SubmitButton
              className="self-start"
              pending={confirm.isPending && confirm.variables === payment.id}
              onClick={() => confirm.mutate(payment.id)}
            >
              Ya me pagó: confirmar
            </SubmitButton>
          ) : (
            <p className="text-sm text-muted-foreground">
              Lo confirma quien revisa los pagos de la tienda.
            </p>
          )}
        </div>
      ))}
      {confirm.isError ? (
        <p role="alert" className="text-sm text-danger">
          {confirm.error.message}
        </p>
      ) : null}
      <Button
        variant="outline"
        className="self-start"
        render={
          <Link
            to="/tiendas/$id/pedidos"
            params={{ id: store.id }}
            search={{ pedido: target.id }}
          />
        }
      >
        Abrir el pedido
      </Button>
    </div>
  )
}

/** «No se entregó»: con su motivo y cuándo va, con su franja y quién lo lleva. */
function MissedDialog({ target, onClose }: { target: DeliveryTarget; onClose: () => void }) {
  const { store } = useStoreContext()
  const today = storeToday(store.timeZone)
  const { slots, couriers, isPending } = useDeliveryOptions()
  const options = slotOptions(slots, target.slot)
  const action = useDeliveryAction(target.id, onClose)
  const reasonOf = (value: { choice: string; other: string }) =>
    value.choice === "otro" ? value.other.trim() : value.choice
  const form = useAppForm({
    // Quien lo lleva llega con los repartidores de la tienda: sin tocar nada, el formulario lo toma.
    defaultValues: {
      choice: MISSED_REASONS[0] as string,
      other: "",
      day: nextDay(today),
      slot: slotKey(target.slot) || NO_SLOT,
      courier: { choice: courierInitial(target, couriers), name: "" },
    },
    validators: {
      onSubmit: z
        .object({
          choice: z.string(),
          other: z.string(),
          day: z.string(),
          slot: z.string(),
          courier: courierShape,
        })
        .superRefine((value, ctx) => {
          if (reasonOf(value).length < 3)
            ctx.addIssue({
              code: "custom",
              path: ["other"],
              message: "Escribe el motivo, con al menos 3 letras",
            })
          checkCourier(value.courier, ctx)
        }),
    },
    onSubmit: async ({ value }) => {
      const slot = slotOf(value.slot, options)
      await action.mutateAsync({
        path: "no-se-entrego",
        body: {
          reason: reasonOf(value),
          deliverOn: value.day,
          slot: slot ? { start: slot.start, end: slot.end } : null,
          ...courierBody(value.courier, courierInitial(target, couriers)),
        },
        done: `Vuelve a salir ${dayName(value.day, today)}`,
      })
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: (key) => ({ reason: "other", deliverOn: "day" })[key],
  })
  const values = useFormValues(form)
  return (
    <FormDrawer
      {...surface}
      open
      isLoading={isPending}
      title={`No se entregó · ${target.number} ${target.customerName}`}
      description="Vuelve a «Por salir» ese día. El stock no se mueve y nada se anula."
      submitLabel="Guardar"
      cancelLabel="Volver"
      onClose={onClose}
    >
      <FieldGroup>
        <form.AppField name="choice">
          {(field) => (
            <field.Group legend="¿Qué pasó?">
              {(control) => (
                <RadioChips
                  aria-label="¿Qué pasó?"
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  onChange={(choice) => field.handleChange(choice)}
                  options={[
                    ...MISSED_REASONS.map((reason) => ({ value: reason, label: reason })),
                    { value: "otro", label: "Otro motivo" },
                  ]}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        {values.choice === "otro" ? (
          <form.AppField name="other">
            {(field) => <field.TextField label="Escribe el motivo" maxLength={300} autoFocus />}
          </form.AppField>
        ) : null}
        <form.AppField name="day">
          {() => <DayField today={today} legend="¿Cuándo va?" />}
        </form.AppField>
        <form.AppField name="slot">{() => <SlotField options={options} />}</form.AppField>
        <form.AppField name="courier">
          {() => <CourierField couriers={couriers} target={target} />}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

/** «Pasar a hoy», «Pasar a mañana», «Pasar al jue, 27 nov». */
function moveLabel(day: string, today: string): string {
  const name = dayName(day, today)
  return ["hoy", "mañana"].includes(name) ? `Pasar a ${name}` : `Pasar al ${name}`
}

/** «Pasar a…»: otro día, otra franja u otro repartidor, sin anular nada. */
function MoveDialog({ target, onClose }: { target: DeliveryTarget; onClose: () => void }) {
  const { store } = useStoreContext()
  const today = storeToday(store.timeZone)
  const { slots, couriers, isPending } = useDeliveryOptions()
  const options = slotOptions(slots, target.slot)
  const action = useDeliveryAction(target.id, onClose)
  const form = useAppForm({
    defaultValues: {
      day: target.deliverOn && target.deliverOn >= today ? target.deliverOn : today,
      slot: slotKey(target.slot) || NO_SLOT,
      courier: { choice: courierInitial(target, couriers), name: "" },
    },
    validators: {
      onSubmit: z
        .object({ day: z.string(), slot: z.string(), courier: courierShape })
        .superRefine((value, ctx) => checkCourier(value.courier, ctx)),
    },
    onSubmit: async ({ value }) => {
      const slot = slotOf(value.slot, options)
      await action.mutateAsync({
        path: "pasar-a",
        body: {
          deliverOn: value.day,
          slot: slot ? { start: slot.start, end: slot.end } : null,
          ...courierBody(value.courier, courierInitial(target, couriers)),
        },
        done: `Sale ${dayName(value.day, today)}`,
      })
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: (key) => (key === "deliverOn" ? "day" : undefined),
  })
  const values = useFormValues(form)
  const slot = slotOf(values.slot, options)
  return (
    <FormDrawer
      {...surface}
      open
      isLoading={isPending}
      title={`Pasar a… · ${target.number} ${target.customerName}`}
      description={
        target.deliverOn
          ? `Ahora sale ${dayName(target.deliverOn, today)}${target.slot ? `, ${target.slot.label}` : ""}. Elige cuándo va: nada se anula.`
          : "Elige cuándo sale: nada se anula."
      }
      submitLabel={`${moveLabel(values.day, today)}${slot ? `, ${slot.label}` : ""}`}
      cancelLabel="Volver"
      onClose={onClose}
    >
      <FieldGroup>
        <form.AppField name="day">{() => <DayField today={today} />}</form.AppField>
        <form.AppField name="slot">{() => <SlotField options={options} />}</form.AppField>
        <form.AppField name="courier">
          {() => <CourierField couriers={couriers} target={target} />}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

/** «Cambiar repartidor»: reasigna la entrega, así que va en cajón aunque haya columna lateral. */
function CourierDialog({ target, onClose }: { target: DeliveryTarget; onClose: () => void }) {
  const { couriers, isPending } = useDeliveryOptions()
  const action = useDeliveryAction(target.id, onClose)
  const form = useAppForm({
    defaultValues: { courier: { choice: courierInitial(target, couriers), name: "" } },
    validators: {
      onSubmit: z
        .object({ courier: courierShape })
        .superRefine((value, ctx) => checkCourier(value.courier, ctx)),
    },
    onSubmit: async ({ value }) => {
      // Sin cambiar a nadie no hay nada que guardar: se cierra sin llamar al servidor.
      const changed = courierBody(value.courier, courierInitial(target, couriers))
      if (!("courier" in changed)) return onClose()
      const pick = changed.courier
      await action.mutateAsync({
        path: "repartidor",
        body: { courier: pick },
        done: pick ? "Repartidor cambiado" : "Sin repartidor",
      })
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      dock={false}
      isLoading={isPending}
      title={`Cambiar repartidor · ${target.number}`}
      description={
        target.courierName
          ? `Ahora lo lleva ${target.courierName}. Lo que cobre en la puerta queda a nombre de quien lo lleve.`
          : "Todavía no lo lleva nadie. Lo que cobre en la puerta queda a nombre de quien lo lleve."
      }
      submitLabel="Guardar"
      cancelLabel="Volver"
      onClose={onClose}
    >
      <form.AppField name="courier">
        {() => <CourierField couriers={couriers} target={target} />}
      </form.AppField>
    </FormDrawer>
  )
}

/**
 * «Avisar» (decisión 4): el texto se ve y se cambia antes; se abre el WhatsApp de este celular con
 * él y lo envía la persona. En la historia queda «enviado por usted», no «entregado».
 */
function NoticeDialog({ target, onClose }: { target: DeliveryTarget; onClose: () => void }) {
  const { store } = useStoreContext()
  const today = storeToday(store.timeZone)
  const action = useDeliveryAction(target.id, onClose)
  const form = useAppForm({
    defaultValues: { text: noticeText(target, today, (cents) => money(cents, store.currency)) },
    validators: {
      onSubmit: z.object({
        text: z.string().trim().min(3, "Escribe el mensaje que le vas a enviar"),
      }),
    },
    onSubmit: async ({ value }) => {
      await action.mutateAsync({
        path: "avisado",
        body: { text: value.text.trim() },
        done: "Queda como enviado por usted",
      })
    },
  })
  const surface = useFormSurface(form)
  const text = useFormValues(form).text
  const link = noticeLink(target.customerPhone, text.trim(), store.country)
  return (
    <FormDrawer
      {...surface}
      // Se abre antes de anotarlo: el navegador solo deja abrir otra ventana con el toque.
      onSubmit={(event) => {
        if (link && text.trim().length >= 3) window.open(link, "_blank", "noopener")
        surface.onSubmit(event)
      }}
      open
      title={`Avisar a ${target.customerName}`}
      description="Se abre el WhatsApp de este celular con el mensaje escrito; lo envías tú. En la historia del pedido queda «enviado por usted», no «entregado»."
      submitLabel="Abrir WhatsApp con el aviso"
      cancelLabel="Volver"
      // Sin un número que se pueda leer no hay a quién abrirle el WhatsApp.
      submitDisabled={!link}
      onClose={onClose}
    >
      <form.AppField name="text">
        {(field) => (
          <field.TextareaField
            label="El mensaje"
            maxLength={1000}
            rows={4}
            description={
              link
                ? "Puedes cambiarlo antes de abrir el WhatsApp."
                : target.customerPhone
                  ? "No se pudo leer su número con el país de la tienda: escríbelo con su código (+51…) en el pedido."
                  : "El pedido no tiene teléfono: escríbele desde su chat."
            }
          />
        )}
      </form.AppField>
    </FormDrawer>
  )
}
