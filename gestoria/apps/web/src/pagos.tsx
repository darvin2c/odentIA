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
import { Clock, CreditCard, Plus, Trash2, Truck } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { z } from "zod"
import { MoneyInput, ToggleField } from "./campos"
import { api } from "./lib/api"
import type { Slot } from "./lib/despachos"
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
import { PaymentLinkSection } from "./link-de-pago"
import { StoreHeader, useStoreContext } from "./tiendas"

/**
 * Configuración › Cobros (lienzo B, tablero 6; «gestorIA como odentIA», tablero 10): con qué
 * le pagan a la tienda (Entregas está en `config-entregas.tsx`). Igual que «Medios de
 * pago» de odentIA: un nombre libre y un tipo de una lista estándar. Lo que se apaga, Sofi deja de
 * ofrecerlo. Los cambia quien tiene `configuracion`; soporte los mira sin cambiarlos.
 */

interface Lists {
  payments: PaymentMethod[]
}

const LISTS_KEY = (storeId: string) => ["pagos-y-entregas", storeId]

export function PaymentMethodsPage() {
  return <PaymentsAndDeliveries />
}

function PaymentsAndDeliveries() {
  const { store } = useStoreContext()
  const canEdit = store.permissions.includes("configuracion")
  const lists = useQuery({
    queryKey: LISTS_KEY(store.id),
    queryFn: () => api<Lists>(`/api/tiendas/${store.id}/pagos-y-entregas`),
  })
  const [payment, setPayment] = useState<PaymentMethod | "new" | null>(null)

  return (
    <>
      <StoreHeader
        title="Cobros"
        subtitle="Con qué te pagan. Lo que apagues, Sofi deja de ofrecerlo."
      />
      {lists.isError ? (
        <ErrorState
          error={lists.error instanceof Error ? lists.error : "No se pudo cargar"}
          onRetry={() => void lists.refetch()}
        />
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
      {payment ? (
        <PaymentForm
          storeId={store.id}
          method={payment === "new" ? null : payment}
          onClose={() => setPayment(null)}
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
export function ActiveSwitch({
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

/** Borrar, con su confirmación: lo que ya se cobró o entregó conserva lo suyo. */
export function DeleteButton({
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

const paymentSchema = z.object({
  name: z.string().trim().min(1, "Escribe cómo lo dirá Sofi"),
  typeCode: z.custom<PaymentTypeCode>(),
  collection: z.custom<PaymentCollection>(),
  details: z.string(),
  isActive: z.boolean(),
})

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
  const save = useMutation({
    mutationFn: (body: {
      name: string
      typeCode: PaymentTypeCode
      collection: PaymentCollection
      details: string
      isActive: boolean
    }) =>
      method
        ? api(`/api/tiendas/${storeId}/medios-de-pago/${method.id}`, { method: "PATCH", body })
        : api(`/api/tiendas/${storeId}/medios-de-pago`, { method: "POST", body }),
  })
  const form = useAppForm({
    defaultValues: {
      name: method?.name ?? "",
      typeCode: (method?.typeCode ?? "68") as PaymentTypeCode,
      collection: (method?.collection ?? "comprobante") as PaymentCollection,
      details: method?.details ?? "",
      isActive: method?.isActive ?? true,
    },
    validators: { onSubmit: paymentSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(value)
      await queryClient.invalidateQueries({ queryKey: LISTS_KEY(storeId) })
      toast.success(method ? "Medio de pago guardado" : "Medio de pago agregado")
      onClose()
    },
  })
  const surface = useFormSurface(form)

  return (
    <FormDrawer
      {...surface}
      open
      title={method ? method.name : "Nuevo medio de pago"}
      description="Así se agrega cualquier medio, aunque no se parezca a los de la lista."
      onClose={onClose}
      submitLabel="Guardar"
    >
      <FieldGroup className="gap-5">
        <form.AppField name="name">
          {(field) => (
            <field.TextField
              label="Nombre"
              description="Como lo dirá Sofi al cliente, por ejemplo «Yape» o «Transferencia BCP»."
              maxLength={80}
              autoFocus
            />
          )}
        </form.AppField>
        <form.AppField
          name="typeCode"
          listeners={{
            // El efectivo se cobra al entregar: no hay otra forma de confirmarlo.
            onChange: ({ value }) => {
              if (value === "10") form.setFieldValue("collection", "al_recibir")
            },
          }}
        >
          {(field) => (
            <field.SelectField
              label="Tipo"
              id="payment-type"
              options={(Object.keys(PAYMENT_TYPES) as PaymentTypeCode[]).map((code) => ({
                value: code,
                label: PAYMENT_TYPES[code],
              }))}
            />
          )}
        </form.AppField>
        <form.Subscribe selector={(state) => state.values.typeCode === "10"}>
          {(cash) => (
            <form.AppField name="collection">
              {(field) => (
                <field.Group
                  legend="Cómo se confirma el pago"
                  description={cash ? "El efectivo se cobra al entregar." : undefined}
                >
                  {(control) => (
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
                              name={control.name}
                              value={option}
                              checked={field.state.value === option}
                              disabled={disabled}
                              aria-invalid={control.invalid || undefined}
                              onChange={() => field.handleChange(option)}
                              className="mt-1 accent-[var(--primary-fill)]"
                            />
                            <span className="flex flex-col">
                              <span className="text-sm font-semibold">
                                {COLLECTIONS[option].name}
                              </span>
                              <span className="text-sm text-muted-foreground">
                                {COLLECTIONS[option].hint}
                              </span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </field.Group>
              )}
            </form.AppField>
          )}
        </form.Subscribe>
        <form.Subscribe selector={(state) => state.values.collection === "link"}>
          {(link) => (
            <form.AppField name="details">
              {(field) => (
                <field.TextareaField
                  label="Lo que envía Sofi para pagar"
                  rows={3}
                  maxLength={500}
                  placeholder={link ? "" : "987 654 321 · a nombre de Rosa Quispe"}
                  description={
                    link
                      ? "Con el link de pago, Sofi enviará un enlace por cada pedido cuando se conecte el proveedor."
                      : "El número, la cuenta o a nombre de quién. Lo envía tal cual."
                  }
                />
              )}
            </form.AppField>
          )}
        </form.Subscribe>
        <form.AppField name="isActive">
          {() => (
            <ToggleField
              label={(on) => (on ? "Encendido: Sofi lo ofrece" : "Apagado: Sofi no lo ofrece")}
            />
          )}
        </form.AppField>
        {method ? (
          <DeleteButton
            what={method.name}
            path={`/api/tiendas/${storeId}/medios-de-pago/${method.id}`}
            storeId={storeId}
            onDone={onClose}
          />
        ) : null}
      </FieldGroup>
    </FormDrawer>
  )
}
