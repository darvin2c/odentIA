import {
  Button,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  RadioGroup,
  RadioGroupItem,
  toast,
} from "@odentia/ui"
import { Textarea } from "@odentia/ui/components/textarea"
import { ConfirmDialog, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Plus, Trash2 } from "lucide-react"
import { useId, useState } from "react"
import { api } from "./lib/api"
import { CASH_KEY } from "./lib/caja"
import { type Courier, DISPATCH_KEY, noticeLink, noticeText, type Slot } from "./lib/despachos"
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
import {
  DateField,
  fieldErrors,
  MoneyField,
  ReceiptImage,
  SelectField,
  shrinkPhoto,
  TextField,
} from "./piezas"
import { useStoreContext } from "./tiendas"

/**
 * Lo que se hace con una entrega (entrega 3 del lienzo «gestorIA como odentIA», tableros 6, 17 y
 * 24), igual desde Despachos y desde el pedido: «Salió», «Entregado», «No se entregó», «Pasar a…»,
 * «Cambiar repartidor», el envío por agencia y «Avisar». Cada uno es la operación del pedido en el
 * servidor; aquí solo se elige y se dice lo que pasa.
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

/** Hoy, mañana u otro día (desde hoy, el de la tienda). */
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
  const tomorrow = nextDay(today)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
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
      </div>
      <DateField label={label} value={value} onChange={onChange} min={today} error={error} />
    </div>
  )
}

const slotKey = (slot: Pick<Slot, "start" | "end"> | null) =>
  slot ? `${slot.start}-${slot.end}` : ""

/** La franja: una de las de la tienda o «Sin franja». Sin franjas configuradas, no se muestra. */
function SlotChoice({
  slots,
  value,
  onChange,
  error,
}: {
  slots: Slot[]
  value: Slot | null
  onChange: (slot: Slot | null) => void
  error?: string
}) {
  // La que ya tiene, aunque la tienda la haya quitado, sigue como opción.
  const options =
    value && !slots.some((s) => slotKey(s) === slotKey(value)) ? [...slots, value] : slots
  if (options.length === 0) return null
  return (
    <FieldSet>
      <FieldLegend variant="label">Franja</FieldLegend>
      <div className="flex flex-wrap gap-2">
        {options.map((slot) => (
          <Button
            key={slotKey(slot)}
            type="button"
            size="sm"
            variant={slotKey(slot) === slotKey(value) ? "default" : "outline"}
            aria-pressed={slotKey(slot) === slotKey(value)}
            onClick={() => onChange(slot)}
          >
            {slot.label}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant={value === null ? "default" : "outline"}
          aria-pressed={value === null}
          onClick={() => onChange(null)}
        >
          Sin franja
        </Button>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </FieldSet>
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

/** El repartidor: una persona del equipo, uno externo que ya se usó, otro escrito o ninguno. */
function useCourierChoice(target: Pick<DeliveryTarget, "courierId">, couriers: Courier[]) {
  const own = couriers.find((c) => c.id !== null && c.id === target.courierId)
  const initial = target.courierId
    ? own
      ? own.team
        ? `u:${own.userId}`
        : `c:${own.id}`
      : `c:${target.courierId}`
    : ""
  const [value, setValue] = useState(initial)
  const [name, setName] = useState("")
  return {
    value,
    setValue,
    name,
    setName,
    changed: value !== initial || value === NEW,
    pick: pickOf(value, name),
    ready: value !== NEW || name.trim().length > 0,
  }
}

function CourierField({
  couriers,
  current,
  choice,
  error,
}: {
  couriers: Courier[]
  /** Quien lo lleva ahora, si ya no está en la lista (dejó de ser del equipo). */
  current: { id: string | null; name: string | null }
  choice: ReturnType<typeof useCourierChoice>
  error?: string
}) {
  const listed = couriers.some((c) => c.id === current.id)
  const options = [
    { value: "", label: "Sin repartidor" },
    ...couriers.map((c) => ({
      value: c.team ? `u:${c.userId}` : `c:${c.id}`,
      label: c.team ? `${c.name} (del equipo)` : c.name,
    })),
    ...(current.id && !listed
      ? [{ value: `c:${current.id}`, label: current.name ?? "Quien lo lleva" }]
      : []),
    { value: NEW, label: "Otro: escribe el nombre" },
  ]
  return (
    <FieldGroup className="gap-3">
      <SelectField
        label="Repartidor"
        value={choice.value}
        onChange={choice.setValue}
        options={options}
        error={choice.value === NEW ? undefined : error}
      />
      {choice.value === NEW ? (
        <TextField
          label="Nombre de quien lo lleva"
          value={choice.name}
          onChange={choice.setName}
          maxLength={80}
          error={error}
          help="Queda para la próxima vez. Cuando entre con su propia app, sus entregas siguen con su nombre."
          autoFocus
        />
      ) : null}
    </FieldGroup>
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
  const [agency, setAgency] = useState(target.agency ? (known ? target.agency : NEW) : "")
  const [otherAgency, setOtherAgency] = useState(known ? "" : (target.agency ?? ""))
  const [tracking, setTracking] = useState(target.tracking ?? "")
  const action = useDeliveryAction(target.id, onClose)
  const errors = fieldErrors(action.error)
  const chosenAgency = agency === NEW ? otherAgency.trim() : agency
  return (
    <ConfirmDialog
      open
      variant="default"
      title={later ? `Envío por agencia · ${target.number}` : `El pedido ${target.number} salió`}
      description={
        later
          ? "La agencia y el número de envío que te dio. Con el número, cualquiera lo sigue en la página de la agencia."
          : parcel
            ? "Pasa a «En camino». Anota con qué agencia va; el número de envío lo puedes anotar después."
            : "Pasa a «En camino». Si tiene número de envío, anótalo."
      }
      confirmLabel={later ? "Guardar" : "Salió"}
      cancelLabel="Volver"
      pending={action.isPending}
      confirmDisabled={later && !chosenAgency && !tracking.trim()}
      error={action.isError && !errors.agency && !errors.tracking ? action.error.message : null}
      onConfirm={() =>
        action.mutate({
          path: later ? "envio" : "salio",
          body: { agency: parcel ? chosenAgency : "", tracking },
          done: later ? "Envío anotado" : "En camino",
        })
      }
      onClose={onClose}
    >
      <FieldGroup className="gap-3">
        {parcel ? (
          <>
            <SelectField
              label="Agencia"
              value={agency}
              onChange={setAgency}
              options={[
                { value: "", label: "Elige la agencia" },
                ...AGENCIES.map((a) => ({ value: a, label: a })),
                { value: NEW, label: "Otra: escribe cuál" },
              ]}
              error={agency === NEW ? undefined : errors.agency}
            />
            {agency === NEW ? (
              <TextField
                label="¿Cuál agencia?"
                value={otherAgency}
                onChange={setOtherAgency}
                maxLength={60}
                error={errors.agency}
                autoFocus
              />
            ) : null}
          </>
        ) : null}
        <TextField
          label={later ? "Número de envío" : "Número de envío (opcional)"}
          value={tracking}
          onChange={setTracking}
          maxLength={80}
          error={errors.tracking}
          help={parcel ? "El código de seguimiento que te da la agencia." : undefined}
        />
      </FieldGroup>
    </ConfirmDialog>
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
 * antes, en el pedido.
 */
function DeliverDialog({ target, onClose }: { target: DeliveryTarget; onClose: () => void }) {
  const { store } = useStoreContext()
  const cur = store.currency
  const due = target.balance.dueCents
  const pending = target.balance.pendingCents
  const methods = useDeliveryOptions().payments.filter(
    (m) => m.collection === "al_recibir" && (m.isActive || m.name === target.paymentName),
  )
  const first = (methods.find((m) => m.name === target.paymentName) ?? methods[0])?.id ?? ""
  const [lines, setLines] = useState<DoorLine[]>([
    { key: 0, methodId: "", amount: moneyInput(due, cur) },
  ])
  const [voucher, setVoucher] = useState<File | null>(null)
  const action = useDeliveryAction(target.id, onClose)
  const errors = fieldErrors(action.error)
  const filled = lines.map((line) => ({
    methodId: line.methodId || first,
    amountCents: readMoney(line.amount, cur) ?? 0,
  }))
  const sum = filled.reduce((total, line) => total + line.amountCents, 0)
  const card = filled.some((line) => methods.find((m) => m.id === line.methodId)?.typeCode === "48")
  const charge = due > 0
  const id = useId()
  const update = (key: number, patch: Partial<DoorLine>) =>
    setLines((all) => all.map((line) => (line.key === key ? { ...line, ...patch } : line)))

  const submit = async () => {
    const body = charge ? { payments: filled } : {}
    if (charge && voucher) {
      const form = new FormData()
      form.set("datos", JSON.stringify(body))
      form.set("voucher", await shrinkPhoto(voucher))
      action.mutate({ path: "entregado", form, done: "Entregado" })
    } else action.mutate({ path: "entregado", body, done: "Entregado" })
  }

  return (
    <ConfirmDialog
      open
      variant="default"
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
      confirmLabel={charge ? `Cobré ${money(sum, cur)} y entregué` : "Entregado"}
      cancelLabel="Volver"
      pending={action.isPending}
      confirmDisabled={pending > 0 || (charge && (sum !== due || methods.length === 0))}
      error={action.isError && !errors.collectedCents ? action.error.message : null}
      onConfirm={() => void submit().catch((error: Error) => toast.error(error.message))}
      onClose={onClose}
    >
      {pending > 0 ? (
        <PendingPayments target={target} />
      ) : charge ? (
        <FieldGroup className="gap-3">
          {methods.length === 0 ? (
            <p className="text-sm text-warning">
              La tienda no tiene un medio para cobrar al recibir. Agrégalo en Configuración, en
              Medios de pago.
            </p>
          ) : null}
          {lines.map((line, i) => (
            <div key={line.key} className="flex items-end gap-2">
              <SelectField
                className="min-w-0 flex-1"
                label={lines.length > 1 ? `Medio ${i + 1}` : "Medio"}
                value={line.methodId || first}
                onChange={(methodId) => update(line.key, { methodId })}
                options={methods.map((m) => ({ value: m.id, label: m.name }))}
              />
              <MoneyField
                className="w-32"
                label="Cobraste"
                currency={cur}
                value={line.amount}
                onChange={(amount) => update(line.key, { amount })}
              />
              {lines.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Quitar el medio ${i + 1}`}
                  onClick={() => setLines((all) => all.filter((one) => one.key !== line.key))}
                >
                  <Trash2 aria-hidden />
                </Button>
              ) : null}
            </div>
          ))}
          {lines.length < 3 && methods.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              className="w-fit"
              onClick={() =>
                setLines((all) => [
                  ...all,
                  {
                    key: Math.max(...all.map((one) => one.key)) + 1,
                    methodId:
                      methods.find((m) => !all.some((one) => (one.methodId || first) === m.id))
                        ?.id ?? first,
                    amount: moneyInput(Math.max(0, due - sum), cur),
                  },
                ])
              }
            >
              <Plus aria-hidden />
              Agregar otro medio
            </Button>
          ) : null}
          <p
            className={`text-sm ${sum === due ? "text-muted-foreground" : "text-warning"}`}
            role={sum === due ? undefined : "status"}
          >
            {sum === due
              ? `Suma ${money(sum, cur)}: es lo que falta.`
              : sum < due
                ? `Faltan ${money(due - sum, cur)}: sin todo el pago no se entrega.`
                : `Es ${money(sum - due, cur)} más de lo que falta: anota solo lo que debía, sin el vuelto.`}
            {errors.collectedCents ? ` ${errors.collectedCents}` : ""}
          </p>
          {card ? (
            <Field>
              <FieldLabel htmlFor={`${id}-voucher`}>Foto del voucher del POS (opcional)</FieldLabel>
              <input
                id={`${id}-voucher`}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="text-sm"
                onChange={(e) => setVoucher(e.target.files?.[0] ?? null)}
              />
              <FieldDescription>Queda en el pedido; la clienta no la ve.</FieldDescription>
            </Field>
          ) : null}
          <p className="text-xs text-muted-foreground">
            ¿Pagó con Yape o Plin al número de la tienda? Anota su captura en el pedido y
            confírmala: así queda el pago confirmado antes de entregar.
          </p>
        </FieldGroup>
      ) : null}
    </ConfirmDialog>
  )
}

/**
 * El pago que espera a una persona, en el mismo paso de entregar (tableros 6 y 24: «¿ya te
 * pagó?»): la captura y «Ya me pagó: confirmar», la misma revisión del pedido. Confirmado, la
 * ventana sigue abierta y pasa a entregar (o a cobrar lo que falte). «No coincide» pide motivo y se
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
      {confirm.isError ? <p className="text-sm text-danger">{confirm.error.message}</p> : null}
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
  const { slots, couriers } = useDeliveryOptions()
  const [choice, setChoice] = useState<string>(MISSED_REASONS[0])
  const [other, setOther] = useState("")
  const [day, setDay] = useState(nextDay(today))
  const [slot, setSlot] = useState<Slot | null>(target.slot)
  const courier = useCourierChoice(target, couriers)
  const action = useDeliveryAction(target.id, onClose)
  const errors = fieldErrors(action.error)
  const reason = choice === "otro" ? other.trim() : choice
  const id = useId()
  return (
    <ConfirmDialog
      open
      variant="default"
      title={`No se entregó · ${target.number} ${target.customerName}`}
      description="Vuelve a «Por salir» ese día. El stock no se mueve y nada se anula."
      confirmLabel="Guardar"
      cancelLabel="Volver"
      pending={action.isPending}
      confirmDisabled={reason.length < 3 || !day || !courier.ready}
      error={action.isError && !errors.deliverOn && !errors.courier ? action.error.message : null}
      onConfirm={() =>
        action.mutate({
          path: "no-se-entrego",
          body: {
            reason,
            deliverOn: day,
            slot: slot ? { start: slot.start, end: slot.end } : null,
            ...(courier.changed ? { courier: courier.pick } : {}),
          },
          done: `Vuelve a salir ${dayName(day, today)}`,
        })
      }
      onClose={onClose}
    >
      <FieldGroup>
        <FieldSet>
          <FieldLegend variant="label">¿Qué pasó?</FieldLegend>
          <RadioGroup
            aria-label="¿Qué pasó?"
            value={choice}
            onValueChange={(value) => setChoice(String(value))}
          >
            {/* El id va con el número: un motivo con espacios no sirve de id. */}
            {[...MISSED_REASONS, "otro"].map((option, i) => (
              <Field key={option} orientation="horizontal">
                <RadioGroupItem id={`${id}-motivo-${i}`} value={option} />
                <FieldLabel htmlFor={`${id}-motivo-${i}`} className="font-normal">
                  {option === "otro" ? "Otro motivo" : option}
                </FieldLabel>
              </Field>
            ))}
          </RadioGroup>
          {choice === "otro" ? (
            <TextField
              label="Escribe el motivo"
              value={other}
              onChange={setOther}
              maxLength={300}
              error={errors.reason}
              autoFocus
            />
          ) : null}
        </FieldSet>
        <DayChoice
          today={today}
          value={day}
          onChange={setDay}
          label="¿Cuándo va?"
          error={errors.deliverOn}
        />
        <SlotChoice slots={slots} value={slot} onChange={setSlot} error={errors.slot} />
        <CourierField
          couriers={couriers}
          current={{ id: target.courierId, name: target.courierName }}
          choice={courier}
          error={errors.courier}
        />
      </FieldGroup>
    </ConfirmDialog>
  )
}

/** «Pasar a…»: otro día, otra franja u otro repartidor, sin anular nada. */
function MoveDialog({ target, onClose }: { target: DeliveryTarget; onClose: () => void }) {
  const { store } = useStoreContext()
  const today = storeToday(store.timeZone)
  const { slots, couriers } = useDeliveryOptions()
  const [day, setDay] = useState(
    target.deliverOn && target.deliverOn >= today ? target.deliverOn : today,
  )
  const [slot, setSlot] = useState<Slot | null>(target.slot)
  const courier = useCourierChoice(target, couriers)
  const action = useDeliveryAction(target.id, onClose)
  const errors = fieldErrors(action.error)
  return (
    <ConfirmDialog
      open
      variant="default"
      title={`Pasar a… · ${target.number} ${target.customerName}`}
      description={
        target.deliverOn
          ? `Ahora sale ${dayName(target.deliverOn, today)}${target.slot ? `, ${target.slot.label}` : ""}. Elige cuándo va: nada se anula.`
          : "Elige cuándo sale: nada se anula."
      }
      confirmLabel={`Pasar al ${dayName(day, today)}${slot ? ` ${slot.label}` : ""}`}
      cancelLabel="Volver"
      pending={action.isPending}
      confirmDisabled={!day || !courier.ready}
      error={
        action.isError && !errors.deliverOn && !errors.slot && !errors.courier
          ? action.error.message
          : null
      }
      onConfirm={() =>
        action.mutate({
          path: "pasar-a",
          body: {
            deliverOn: day,
            slot: slot ? { start: slot.start, end: slot.end } : null,
            ...(courier.changed ? { courier: courier.pick } : {}),
          },
          done: `Sale ${dayName(day, today)}`,
        })
      }
      onClose={onClose}
    >
      <FieldGroup>
        <DayChoice today={today} value={day} onChange={setDay} error={errors.deliverOn} />
        <SlotChoice slots={slots} value={slot} onChange={setSlot} error={errors.slot} />
        <CourierField
          couriers={couriers}
          current={{ id: target.courierId, name: target.courierName }}
          choice={courier}
          error={errors.courier}
        />
      </FieldGroup>
    </ConfirmDialog>
  )
}

/** «Cambiar repartidor». */
function CourierDialog({ target, onClose }: { target: DeliveryTarget; onClose: () => void }) {
  const { couriers } = useDeliveryOptions()
  const courier = useCourierChoice(target, couriers)
  const action = useDeliveryAction(target.id, onClose)
  const errors = fieldErrors(action.error)
  return (
    <ConfirmDialog
      open
      variant="default"
      title={`Cambiar repartidor · ${target.number}`}
      description={
        target.courierName
          ? `Ahora lo lleva ${target.courierName}. Lo que cobre en la puerta queda a nombre de quien lo lleve.`
          : "Todavía no lo lleva nadie. Lo que cobre en la puerta queda a nombre de quien lo lleve."
      }
      confirmLabel="Guardar"
      cancelLabel="Volver"
      pending={action.isPending}
      confirmDisabled={!courier.changed || !courier.ready}
      error={action.isError && !errors.courier ? action.error.message : null}
      onConfirm={() =>
        action.mutate({
          path: "repartidor",
          body: { courier: courier.pick },
          done: courier.pick ? "Repartidor cambiado" : "Sin repartidor",
        })
      }
      onClose={onClose}
    >
      <CourierField
        couriers={couriers}
        current={{ id: target.courierId, name: target.courierName }}
        choice={courier}
        error={errors.courier}
      />
    </ConfirmDialog>
  )
}

/**
 * «Avisar» (decisión 4): el texto se ve y se cambia antes; se abre el WhatsApp de este celular con
 * él y lo envía la persona. En la historia queda «enviado por usted», no «entregado».
 */
function NoticeDialog({ target, onClose }: { target: DeliveryTarget; onClose: () => void }) {
  const { store } = useStoreContext()
  const today = storeToday(store.timeZone)
  const [text, setText] = useState(() =>
    noticeText(target, today, (cents) => money(cents, store.currency)),
  )
  const link = noticeLink(target.customerPhone, text.trim(), store.country)
  const action = useDeliveryAction(target.id, onClose)
  const id = useId()
  return (
    <ConfirmDialog
      open
      variant="default"
      title={`Avisar a ${target.customerName}`}
      description="Se abre el WhatsApp de este celular con el mensaje escrito; lo envías tú. En la historia del pedido queda «enviado por usted», no «entregado»."
      confirmLabel="Abrir WhatsApp con el aviso"
      cancelLabel="Volver"
      pending={action.isPending}
      confirmDisabled={!link || text.trim().length < 3}
      error={action.isError ? action.error.message : null}
      onConfirm={() => {
        if (!link) return
        // Se abre antes de anotarlo: el navegador solo deja abrir otra ventana con el toque.
        window.open(link, "_blank", "noopener")
        action.mutate({
          path: "avisado",
          body: { text: text.trim() },
          done: "Queda como enviado por usted",
        })
      }}
      onClose={onClose}
    >
      <Field>
        <FieldLabel htmlFor={`${id}-texto`}>El mensaje</FieldLabel>
        <Textarea
          id={`${id}-texto`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={1000}
          rows={4}
        />
        <FieldDescription>
          {link
            ? "Puedes cambiarlo antes de abrir el WhatsApp."
            : target.customerPhone
              ? "No se pudo leer su número con el país de la tienda: escríbelo con su código (+51…) en el pedido."
              : "El pedido no tiene teléfono: escríbele desde su chat."}
        </FieldDescription>
      </Field>
    </ConfirmDialog>
  )
}
