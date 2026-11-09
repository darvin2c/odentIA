/**
 * Vender con pedido (ADR 0171; vistIA: «Vender lentes»), en un solo formulario:
 * para quién, la receta que se copia (se informa si venció o no está verificada,
 * nunca impide), lo que lleva (lo del inventario con su precio, también con el
 * lector de códigos de barras, y lo que se escribe con el suyo), las medidas para
 * montar, qué es, quién lo hace, para cuándo, notas y el adelanto, con uno o
 * varios medios. El servidor crea los cargos, el pedido y el cobro en una sola
 * transacción; la clave de la venta (`requestId`) es la misma mientras el cajón
 * sigue abierto, así un reintento tras un corte no vende dos veces.
 */
import { formatMoney, parseMoney } from "@odentia/clinical"
import { Alert, AlertDescription, Button } from "@odentia/ui"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@odentia/ui/components/input-group"
import {
  DatePickerButton,
  FormDrawer,
  LoadingState,
  ResourceSelect,
  regionToday,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"
import * as React from "react"
import { useActiveBranch } from "../../lib/active-branch"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import {
  CASH_TYPE_CODE,
  fetchSaleProducts,
  invalidatePatientAccount,
  type PaymentMethodOption,
  usePaymentMethodsOptions,
} from "../../lib/finance-collect"
import { inventoryKeys, productLabelLine } from "../../lib/inventory"
import {
  fetchSaleReferences,
  invalidateOrders,
  type OrderSaleBody,
  orderKeys,
  sellOrder,
} from "../../lib/orders"
import { useOrgProfile } from "../../lib/org"
import type { PatientFull } from "../../lib/patients"
import type { OrderLineKind, ProductOrdersUi } from "../../product/product-ui"
import { BranchSwitcher } from "../branch-switcher"
import { ChoiceButtons } from "../choice-buttons"
import { MoneyInput } from "../inventory/fields"
import { PersonPicker, type PickedPerson } from "../person-picker"

/** «Sin receta», «Sin adelanto»: lo que se elige en lugar de una opción. */
const NONE = "sin"

/** Medios en un mismo adelanto que se ofrecen a la vista (la API admite hasta 10). */
const MAX_PAYMENTS = 3

const NO_SALE_PRICE = "Ponle precio de venta en Inventario: sin precio no se puede vender."

/** Un producto que se vende, como lo muestra el buscador (también la venta de mostrador). */
export interface SaleItem {
  productId: string
  name: string
  /** null: sin precio de venta (no se puede vender). */
  salePriceCents: number | null
  /** La moneda de su precio de venta. */
  currency: string | null
  /** Unidad de uso, en singular («frasco»): se vende por ella. */
  unit: string
  /** Lo que hay en la sede (lotes − faltante; puede ser negativo). */
  onHand: number
  /** «2 unidades» en la sede; null si no hay. */
  onHandText: string | null
  /** El código de barras, sin espacios; lo que lee el escáner. */
  barcode: string | null
  /** «Ray-Ban · RB2140 · Negro · 50□22 140»; vacío si la etiqueta no dice nada. */
  label: string
}

interface SaleLine {
  /** Para la lista y para llevar el foco a la línea nueva. */
  key: string
  kind: OrderLineKind
  product: SaleItem | null
  description: string
  amount: string
}

interface SalePayment {
  key: string
  methodId: string
  amount: string
}

interface SaleValues {
  person: PickedPerson | null
  referenceId: string
  lines: SaleLine[]
  fitting: Record<string, string>
  title: string
  maker: string
  promisedOn: string
  notes: string
  /** Vacío: sin adelanto. */
  payments: SalePayment[]
  cashReceived: string
}

/** El nombre del dato en el cuerpo de la venta → su campo en pantalla. */
function serverField(field: string): string | undefined {
  if (field === "patientId") return "person"
  if (field === "cashReceivedCents") return "cashReceived"
  const payment = /^(payments\[\d+\])\.(paymentMethodId|amountCents|reference)$/.exec(field)
  if (payment)
    return payment[2] === "amountCents"
      ? `${payment[1]}.amount`
      : payment[2] === "paymentMethodId"
        ? `${payment[1]}.methodId`
        : "payments"
  const line = /^(lines\[\d+\])\.(amountCents|productId|quantity|kind)$/.exec(field)
  if (line)
    return line[2] === "amountCents"
      ? `${line[1]}.amount`
      : line[2] === "productId"
        ? `${line[1]}.product`
        : "lines"
  return undefined
}

/** «Montura», «lunas» → «Montura y lunas»: lo que propone «Qué es» mientras nadie lo escribe. */
function titleFrom(lines: SaleLine[], orders: ProductOrdersUi): string {
  const words = lines.map((line) => {
    const kind = orders.lineKinds.find((item) => item.kind === line.kind)
    // «Otro» se nombra por lo que se escribió.
    return kind?.fromInventory === false && line.kind === "otro"
      ? line.description.trim()
      : (kind?.label ?? "")
  })
  const unique = [...new Set(words.filter(Boolean))].map((word, index) =>
    index === 0
      ? word.charAt(0).toUpperCase() + word.slice(1)
      : word.charAt(0).toLowerCase() + word.slice(1),
  )
  if (unique.length <= 1) return unique[0] ?? ""
  return `${unique.slice(0, -1).join(", ")} y ${unique.at(-1)}`
}

/** Una medida en milímetros: vacía, null; si no es un número entre 0 y 100, NaN. */
function measureOf(raw: string | undefined): number | null {
  const text = (raw ?? "").trim()
  if (!text) return null
  const value = Number(text.replace(",", "."))
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : Number.NaN
}

export function SaleDrawer({
  orders,
  presetPatientId,
  presetReferenceId,
  onClose,
  onSold,
}: {
  orders: ProductOrdersUi
  /** La persona que trae el enlace (`?persona=`, su ficha): «Vender con esta receta». */
  presetPatientId?: string
  /** La receta que trae el enlace (`?receta=`): se elige si es de esa persona y está vigente. */
  presetReferenceId?: string
  onClose: () => void
  /** Vendido: el pedido nuevo y, si dejó adelanto, su ticket. */
  onSold: (order: { id: string; orderNumber: number }, ticketId: string | null) => void
}) {
  const queryClient = useQueryClient()
  // La misma clave mientras el cajón siga abierto: un reintento devuelve la misma venta.
  const [requestId] = React.useState(() => crypto.randomUUID())
  const today = regionToday()
  const profile = useOrgProfile()
  const currency = profile.data?.currency ?? ""
  const locale = profile.data?.locale ?? "es"
  const money = (cents: number) => (currency ? formatMoney(cents, currency, locale) : "")
  const centsOf = (raw: string): number | null => {
    if (!raw.trim() || !currency) return null
    try {
      return parseMoney(raw, currency, locale)
    } catch {
      return null
    }
  }
  const sede = useActiveBranch()
  const branchId = sede.effectiveId ?? ""
  const branchName = sede.branches.find((item) => item.id === branchId)?.name ?? ""
  const methods = usePaymentMethodsOptions()
  const methodList = methods.data?.data ?? []
  const methodOf = (id: string): PaymentMethodOption | undefined =>
    methodList.find((item) => item.id === id)
  const canPrescription = usePermission("clinical.prescription")
  const canClinical = usePermission("clinical.read")
  const seesReferences = canPrescription || canClinical
  const kindOf = (kind: OrderLineKind) => orders.lineKinds.find((item) => item.kind === kind)
  const lineCents = (line: SaleLine): number | null =>
    kindOf(line.kind)?.fromInventory ? (line.product?.salePriceCents ?? null) : centsOf(line.amount)
  const totalOf = (all: SaleLine[]) => all.reduce((sum, line) => sum + (lineCents(line) ?? 0), 0)
  const cashPartOf = (all: SalePayment[]) =>
    all.reduce(
      (sum, row) =>
        sum +
        (methodOf(row.methodId)?.typeCode === CASH_TYPE_CODE ? (centsOf(row.amount) ?? 0) : 0),
      0,
    )
  /** La persona cuyas referencias ya se eligieron solas: lo que elija después es suyo. */
  const referencesFor = React.useRef<string | null>(null)

  const form = useAppForm({
    defaultValues: {
      person: null,
      referenceId: NONE,
      lines: [],
      fitting: {},
      title: "",
      maker: "",
      promisedOn: "",
      notes: "",
      payments: [],
      cashReceived: "",
    } as SaleValues,
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (!value.person?.patientId) fields.person = "Busca y elige para quién es."
        if (value.lines.length === 0) fields.lines = "Agrega lo que lleva el pedido."
        value.lines.forEach((line, index) => {
          const at = `lines[${index}]`
          if (kindOf(line.kind)?.fromInventory) {
            if (!line.product) fields[`${at}.product`] = "Busca y elige el producto."
            else if (line.product.salePriceCents === null) fields[`${at}.product`] = NO_SALE_PRICE
          } else {
            if (!line.description.trim()) fields[`${at}.description`] = "Escribe qué es."
            if (centsOf(line.amount) === null) fields[`${at}.amount`] = "Escribe el precio."
          }
        })
        for (const item of orders.fitting) {
          if (Number.isNaN(measureOf(value.fitting[item.key])))
            fields[`fitting.${item.key}`] = `Escribe la medida en ${item.unit}.`
        }
        if (!value.title.trim()) fields.title = "Escribe qué es el pedido."
        if (!value.maker.trim()) fields.maker = "Escribe quién lo hace."
        if (!value.promisedOn) fields.promisedOn = "Elige para cuándo."
        else if (value.promisedOn < today) fields.promisedOn = "No puede ser antes de hoy."
        const seen = new Set<string>()
        let deposit = 0
        value.payments.forEach((row, index) => {
          const at = `payments[${index}]`
          if (!row.methodId) fields[`${at}.methodId`] = "Elige el medio."
          else if (seen.has(row.methodId))
            fields[`${at}.methodId`] = "Ese medio ya está arriba: súmalo en su importe."
          seen.add(row.methodId)
          const cents = centsOf(row.amount)
          if (cents === null || cents <= 0)
            fields[`${at}.amount`] = "Escribe cuánto deja con este medio."
          else deposit += cents
        })
        const total = totalOf(value.lines)
        if (value.payments.length > 0 && value.lines.length > 0 && deposit > total)
          fields.payments = `El adelanto (${money(deposit)}) no puede pasar del total (${money(total)}).`
        const received = centsOf(value.cashReceived)
        if (
          value.cashReceived.trim() &&
          cashPartOf(value.payments) > 0 &&
          (received === null || received < cashPartOf(value.payments))
        )
          fields.cashReceived = "Lo que recibes en efectivo no cubre la parte en efectivo."
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      if (!branchId) throw new Error("Hace falta una sede activa para vender.")
      const payments = value.payments.map((row) => ({
        paymentMethodId: row.methodId,
        amountCents: centsOf(row.amount) as number,
      }))
      const received = cashPartOf(value.payments) > 0 ? centsOf(value.cashReceived) : null
      const fitting = Object.fromEntries(
        orders.fitting.flatMap((item) => {
          const measure = measureOf(value.fitting[item.key])
          return measure === null ? [] : [[item.key, measure]]
        }),
      )
      const body: OrderSaleBody = {
        patientId: value.person?.patientId as string,
        branchId,
        requestId,
        title: value.title.trim(),
        maker: value.maker.trim(),
        promisedOn: value.promisedOn,
        lines: value.lines.map((line) =>
          kindOf(line.kind)?.fromInventory
            ? { kind: line.kind, productId: line.product?.productId as string }
            : {
                kind: line.kind,
                description: line.description.trim(),
                amountCents: centsOf(line.amount) as number,
              },
        ),
        ...(offered && value.referenceId !== NONE ? { referenceId: value.referenceId } : {}),
        ...(Object.keys(fitting).length > 0 ? { fitting } : {}),
        ...(value.notes.trim() ? { notes: value.notes.trim() } : {}),
        ...(payments.length > 0 ? { payments } : {}),
        ...(received !== null ? { cashReceivedCents: received } : {}),
      }
      const { order, ticketId } = await sellOrder(body)
      queryClient.setQueryData(orderKeys.detail(order.id), order)
      invalidateOrders(queryClient)
      invalidatePatientAccount(queryClient, order.patientId)
      // Lo del inventario salió de la sede al vender.
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
      void queryClient.invalidateQueries({ queryKey: ["sale-products"] })
      onSold(order, ticketId)
    },
  })
  const surface = useFormSurface(form, { fieldMap: serverField })

  const person = useStore(form.store, (state) => state.values.person)
  const lines = useStore(form.store, (state) => state.values.lines)
  const referenceId = useStore(form.store, (state) => state.values.referenceId)
  const payments = useStore(form.store, (state) => state.values.payments)
  const receivedText = useStore(form.store, (state) => state.values.cashReceived)
  const patientId = person?.patientId ?? null

  // La persona del enlace, ya elegida. El buscador solo muestra su nombre y su historia:
  // `id` es el de la persona en el buscador, aquí basta la ficha.
  const preset = useQuery({
    queryKey: ["patient", presetPatientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${presetPatientId}`),
    enabled: Boolean(presetPatientId),
  })
  const presetPatient = preset.data?.data.patient
  const presetDone = React.useRef(false)
  React.useEffect(() => {
    if (!presetPatient || presetDone.current) return
    presetDone.current = true
    if (form.getFieldValue("person")) return
    form.setFieldValue(
      "person",
      {
        id: presetPatient.id,
        name: presetPatient.displayName,
        patientId: presetPatient.id,
        patientNumber: presetPatient.patientNumber,
      },
      { dontUpdateMeta: true },
    )
  }, [presetPatient, form])

  // Lo que se copia (vistIA: sus recetas vigentes). Sin permiso para verla, no se ofrece.
  const references = useQuery({
    queryKey: orderKeys.references(patientId ?? ""),
    queryFn: () => fetchSaleReferences(patientId as string),
    enabled: Boolean(patientId) && seesReferences,
  })
  const denied = references.error instanceof ApiError && references.error.status === 403
  const offered = seesReferences && !denied && Boolean(patientId)
  const referenceList = references.data ?? []
  const chosenReference = referenceList.find((item) => item.id === referenceId) ?? null
  // Al llegar las de esta persona, la del enlace o la primera.
  React.useEffect(() => {
    if (!patientId || !references.data || referencesFor.current === patientId) return
    referencesFor.current = patientId
    const fromLink =
      patientId === presetPatientId
        ? references.data.find((item) => item.id === presetReferenceId)
        : undefined
    form.setFieldValue("referenceId", (fromLink ?? references.data[0])?.id ?? NONE, {
      dontUpdateMeta: true,
    })
  }, [patientId, references.data, presetPatientId, presetReferenceId, form])

  // «Qué es» se propone con lo que lleva, mientras nadie lo escriba.
  const suggestion = titleFrom(lines, orders)
  const suggested = React.useRef("")
  React.useEffect(() => {
    const current = form.getFieldValue("title")
    if (current !== suggested.current) return
    suggested.current = suggestion
    if (current !== suggestion) form.setFieldValue("title", suggestion)
  }, [suggestion, form])

  const total = totalOf(lines)
  const deposit = payments.reduce((sum, row) => sum + (centsOf(row.amount) ?? 0), 0)
  const cashPart = cashPartOf(payments)
  const hasCash = payments.some((row) => methodOf(row.methodId)?.typeCode === CASH_TYPE_CODE)
  const received = hasCash ? centsOf(receivedText) : null
  const change = received !== null ? received - cashPart : null
  const methodOptions = methodList.map((item) => ({ value: item.id, label: item.name }))

  // Al campo, o a la primera opción de un grupo de botones.
  const focusLater = (id: string) =>
    requestAnimationFrame(() => {
      const found = document.getElementById(id)
      ;(found?.matches("input, button")
        ? found
        : found?.querySelector<HTMLElement>("input, button")
      )?.focus()
    })
  const addLine = (kind: OrderLineKind) => {
    const key = crypto.randomUUID()
    form.pushFieldValue("lines", { key, kind, product: null, description: "", amount: "" })
    // El foco va a la línea nueva: con el teclado no hay que buscarla.
    focusLater(`venta-linea-${key}`)
  }
  const addPayment = (methodId = "") => {
    const key = crypto.randomUUID()
    form.pushFieldValue("payments", { key, methodId, amount: "" })
    focusLater(methodId ? `venta-adelanto-${key}` : `venta-medio-${key}`)
  }

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={orders.sellLabel}
      // Con varias sedes se elige aquí mismo: el cobro y lo del inventario son de ella.
      headerContent={
        sede.branches.length > 1 && branchId ? (
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            Se vende en
            <BranchSwitcher
              branches={sede.branches}
              value={branchId}
              fallbackName={branchName}
              onChange={(id) => sede.choose(id)}
            />
          </p>
        ) : undefined
      }
      isLoading={profile.isPending}
      submitLabel="Vender"
      submitDisabled={!currency}
    >
      {!currency ? (
        // Sin la moneda de la clínica no se puede decir ni cobrar un precio.
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          No pudimos leer la moneda de la clínica.
          <Button type="button" size="sm" variant="outline" onClick={() => void profile.refetch()}>
            Reintentar
          </Button>
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          <form.AppField
            name="person"
            listeners={{
              // Otra persona, otras recetas: se vuelve a proponer la suya.
              onChange: () => {
                referencesFor.current = null
                form.setFieldValue("referenceId", NONE, { dontUpdateMeta: true })
              },
            }}
          >
            {(field) => (
              <field.Control label="Para quién" id="venta-persona">
                {(control) => (
                  <PersonPicker
                    id={control.id}
                    label="Pacientes"
                    patientsOnly
                    value={field.state.value}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    onChange={(next) => {
                      field.handleChange(next)
                      field.handleBlur()
                    }}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>

          {offered ? (
            references.isPending ? (
              <LoadingState message={`Cargando ${orders.referenceLabel.toLowerCase()}…`} />
            ) : references.isError ? (
              <p
                role="alert"
                className="flex flex-wrap items-center gap-2 text-sm text-destructive"
              >
                No pudimos traer lo que se copia en el pedido.
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void references.refetch()}
                >
                  Reintentar
                </Button>
              </p>
            ) : referenceList.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {orders.referenceLabel}: no tiene una vigente. El pedido va sin ella.
              </p>
            ) : (
              <form.AppField name="referenceId">
                {(field) => (
                  <field.Group legend={orders.referenceLabel} className="gap-3">
                    {(control) => (
                      <div className="flex flex-col gap-3">
                        <ChoiceButtons
                          id={control.id}
                          invalid={control.invalid}
                          aria-describedby={control.describedBy}
                          onBlur={control.onBlur}
                          value={field.state.value}
                          options={[
                            ...referenceList.map((item) => ({ value: item.id, label: item.label })),
                            { value: NONE, label: `Sin ${orders.referenceLabel.toLowerCase()}` },
                          ]}
                          onChange={(next) => field.handleChange(next)}
                        />
                        {chosenReference ? (
                          <div className="flex flex-col gap-2">
                            <ul className="flex flex-col gap-0.5 text-sm tabular-nums">
                              {chosenReference.lines.map((line) => (
                                <li key={line}>{line}</li>
                              ))}
                            </ul>
                            {chosenReference.notices.length > 0 ? (
                              <Alert role="status" className="border-warning/40 bg-warning-soft">
                                <AlertDescription className="text-foreground">
                                  {chosenReference.notices.map((notice) => (
                                    <p key={notice}>{notice}</p>
                                  ))}
                                </AlertDescription>
                              </Alert>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </field.Group>
                )}
              </form.AppField>
            )
          ) : patientId ? (
            // Sin ver la receta no se ofrece copiarla: se dice, para que nadie la busque.
            <p className="text-sm text-muted-foreground">
              {orders.referenceLabel}: la agrega quien la ve. El pedido va sin ella.
            </p>
          ) : null}

          <form.AppField name="lines" mode="array">
            {(linesField) => (
              <linesField.Group legend="Lo que lleva" className="gap-3">
                {() => (
                  <div className="flex flex-col gap-3">
                    {linesField.state.value.length > 0 ? (
                      <ul className="flex flex-col gap-3">
                        {linesField.state.value.map((line, index) => {
                          const kind = kindOf(line.kind)
                          const label = kind?.label ?? line.kind
                          const which = <span className="sr-only">, {label.toLowerCase()}</span>
                          return (
                            <li
                              key={line.key}
                              className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-3"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-semibold">{label}</span>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`Quitar ${label.toLowerCase()}`}
                                  onClick={() => linesField.removeValue(index)}
                                >
                                  <X aria-hidden />
                                  Quitar
                                </Button>
                              </div>
                              {kind?.fromInventory ? (
                                <form.AppField name={`lines[${index}].product`}>
                                  {(field) => (
                                    <field.Control
                                      label={<>Producto{which}</>}
                                      id={`venta-linea-${line.key}`}
                                      description={
                                        field.state.value
                                          ? itemDetail(field.state.value, money, branchName)
                                          : "Escribe su nombre, marca o modelo, o pasa el lector por el código de barras."
                                      }
                                    >
                                      {(control) => (
                                        <ProductSearch
                                          id={control.id}
                                          invalid={control.invalid}
                                          describedBy={control.describedBy}
                                          onBlur={control.onBlur}
                                          branchId={branchId}
                                          branchName={branchName}
                                          money={money}
                                          value={field.state.value}
                                          onChange={(next) => {
                                            field.handleChange(next)
                                            field.handleBlur()
                                          }}
                                        />
                                      )}
                                    </field.Control>
                                  )}
                                </form.AppField>
                              ) : (
                                <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
                                  <form.AppField name={`lines[${index}].description`}>
                                    {(field) => (
                                      <field.TextField
                                        label={<>Qué es{which}</>}
                                        id={`venta-linea-${line.key}`}
                                        autoComplete="off"
                                        maxLength={200}
                                      />
                                    )}
                                  </form.AppField>
                                  <form.AppField name={`lines[${index}].amount`}>
                                    {(field) => (
                                      <field.Control
                                        label={<>Precio{which}</>}
                                        id={`venta-precio-${line.key}`}
                                      >
                                        {(control) => (
                                          <MoneyInput
                                            id={control.id}
                                            currency={currency}
                                            invalid={control.invalid}
                                            aria-describedby={control.describedBy}
                                            value={field.state.value}
                                            onChange={(next) => field.handleChange(next)}
                                          />
                                        )}
                                      </field.Control>
                                    )}
                                  </form.AppField>
                                </div>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      {orders.lineKinds.map((kind) => (
                        <Button
                          key={kind.kind}
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-11 sm:min-h-8"
                          aria-label={`Agregar ${kind.label.toLowerCase()}`}
                          onClick={() => addLine(kind.kind)}
                        >
                          <Plus aria-hidden />
                          {kind.label}
                        </Button>
                      ))}
                    </div>
                    {lines.length > 0 ? (
                      <p className="text-sm font-semibold tabular-nums">Total {money(total)}</p>
                    ) : null}
                  </div>
                )}
              </linesField.Group>
            )}
          </form.AppField>

          {orders.fitting.length > 0 ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">
                Medidas para montar{" "}
                <span className="font-normal text-muted-foreground">(opcional)</span>
              </legend>
              <div className="grid grid-cols-2 gap-3">
                {orders.fitting.map((item) => (
                  <form.AppField key={item.key} name={`fitting.${item.key}`}>
                    {(field) => (
                      <field.Control label={item.label} id={`venta-medida-${item.key}`}>
                        {(control) => (
                          <InputGroup className="h-11 sm:h-9">
                            <InputGroupInput
                              {...control.props}
                              inputMode="decimal"
                              autoComplete="off"
                              className="tabular-nums"
                              value={field.state.value ?? ""}
                              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                                field.handleChange(event.target.value)
                              }
                            />
                            <InputGroupAddon align="inline-end">
                              <InputGroupText>{item.unit}</InputGroupText>
                            </InputGroupAddon>
                          </InputGroup>
                        )}
                      </field.Control>
                    )}
                  </form.AppField>
                ))}
              </div>
            </fieldset>
          ) : null}

          <form.AppField name="title">
            {(field) => (
              <field.TextField
                label="Qué es"
                placeholder={orders.titlePlaceholder}
                autoComplete="off"
                maxLength={200}
              />
            )}
          </form.AppField>
          <form.AppField name="maker">
            {(field) => (
              <field.TextField
                label="Quién lo hace"
                placeholder={orders.makerPlaceholder}
                maxLength={200}
              />
            )}
          </form.AppField>
          <form.AppField name="promisedOn">
            {(field) => (
              <field.Control label="Para cuándo" id="venta-para-cuando">
                {(control) => (
                  <DatePickerButton
                    id={control.id}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    min={today}
                    value={field.state.value}
                    onChange={(next) => {
                      field.handleChange(next)
                      field.handleBlur()
                    }}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
          <form.AppField name="notes">
            {(field) => <field.TextareaField label="Notas (opcional)" rows={2} maxLength={2000} />}
          </form.AppField>

          {methods.isPending ? (
            <LoadingState message="Cargando los medios de pago…" />
          ) : methods.isError ? (
            <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
              No pudimos cargar los medios de pago: se puede vender sin adelanto.
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void methods.refetch()}
              >
                Reintentar
              </Button>
            </p>
          ) : null}
          <form.AppField name="payments" mode="array">
            {(paymentsField) => (
              <paymentsField.Group legend="Adelanto" className="gap-3">
                {(control) => (
                  <div className="flex flex-col gap-3">
                    {/* El primer medio, o «Sin adelanto», que quita todos. */}
                    <ChoiceButtons
                      id={control.id}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      tone="primary"
                      value={payments[0]?.methodId || (payments.length === 0 ? NONE : null)}
                      options={[{ value: NONE, label: "Sin adelanto" }, ...methodOptions]}
                      onChange={(next) => {
                        if (next === NONE) paymentsField.setValue([])
                        else if (payments.length === 0) addPayment(next)
                        else form.setFieldValue("payments[0].methodId", next)
                      }}
                    />
                    {paymentsField.state.value.length > 0 ? (
                      <ul className="flex flex-col gap-3">
                        {paymentsField.state.value.map((row, index) => {
                          const which =
                            index > 0 ? <span className="sr-only">, medio {index + 1}</span> : null
                          return (
                            <li
                              key={row.key}
                              className={
                                index > 0
                                  ? "flex flex-col gap-3 rounded-xl border bg-muted/40 p-3"
                                  : "flex flex-col gap-3"
                              }
                            >
                              {index > 0 ? (
                                <form.AppField name={`payments[${index}].methodId`}>
                                  {(field) => (
                                    <field.Group legend={`Medio ${index + 1}`} className="gap-2">
                                      {(rowControl) => (
                                        <div className="flex items-start justify-between gap-2">
                                          <ChoiceButtons
                                            id={`venta-medio-${row.key}`}
                                            invalid={rowControl.invalid}
                                            aria-describedby={rowControl.describedBy}
                                            onBlur={rowControl.onBlur}
                                            tone="primary"
                                            value={field.state.value || null}
                                            options={methodOptions}
                                            onChange={(next) => field.handleChange(next)}
                                          />
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            aria-label={`Quitar el medio ${index + 1}`}
                                            onClick={() => paymentsField.removeValue(index)}
                                          >
                                            <X aria-hidden />
                                            Quitar
                                          </Button>
                                        </div>
                                      )}
                                    </field.Group>
                                  )}
                                </form.AppField>
                              ) : null}
                              <form.AppField name={`payments[${index}].amount`}>
                                {(field) => (
                                  <field.Control
                                    label={<>Importe{which}</>}
                                    id={`venta-adelanto-${row.key}`}
                                    className="sm:max-w-56"
                                  >
                                    {(amountControl) => (
                                      <MoneyInput
                                        id={amountControl.id}
                                        currency={currency}
                                        invalid={amountControl.invalid}
                                        aria-describedby={amountControl.describedBy}
                                        value={field.state.value}
                                        onChange={(next) => field.handleChange(next)}
                                      />
                                    )}
                                  </field.Control>
                                )}
                              </form.AppField>
                            </li>
                          )
                        })}
                      </ul>
                    ) : null}
                    {payments.length > 0 &&
                    payments.length < Math.min(MAX_PAYMENTS, methodList.length) ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-11 self-start sm:min-h-8"
                        onClick={() => addPayment()}
                      >
                        <Plus aria-hidden />
                        Agregar otro medio
                      </Button>
                    ) : null}
                  </div>
                )}
              </paymentsField.Group>
            )}
          </form.AppField>
          {hasCash ? (
            <div className="grid grid-cols-2 items-start gap-3">
              <form.AppField name="cashReceived">
                {(field) => (
                  <field.Control label="Recibes en efectivo" id="venta-recibes">
                    {(control) => (
                      <MoneyInput
                        id={control.id}
                        currency={currency}
                        invalid={control.invalid || (change !== null && change < 0)}
                        aria-describedby={control.describedBy}
                        value={field.state.value}
                        onChange={(next) => field.handleChange(next)}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
              <div className="flex min-h-9 flex-col justify-center">
                <span className="text-sm text-muted-foreground">
                  {change !== null && change < 0 ? "Falta" : "Vuelto"}
                </span>
                <span className="text-base font-semibold tabular-nums">
                  {change === null ? "—" : money(Math.abs(change))}
                </span>
              </div>
            </div>
          ) : null}
          {lines.length > 0 ? (
            <p className="text-sm tabular-nums">
              {deposit > 0
                ? `Adelanto ${money(deposit)}: quedan ${money(Math.max(0, total - deposit))} por pagar.`
                : `Quedan ${money(total)} por pagar.`}
            </p>
          ) : null}
        </div>
      )}
    </FormDrawer>
  )
}

/** Lo de la etiqueta, el precio y lo que hay en la sede, para elegir el producto. */
export function itemDetail(item: SaleItem, money: (cents: number) => string, branchName: string): string {
  const sale = [
    item.salePriceCents !== null ? money(item.salePriceCents) : "Sin precio de venta",
    item.onHandText ? `hay ${item.onHandText}` : `no hay en ${branchName || "esta sede"}`,
  ].join(" · ")
  return item.label ? `${item.label} — ${sale}` : sale
}

/** Lo que lee el escáner: el código de barras entero, sin espacios. */
const scanCode = (text: string) => text.replace(/\s+/g, "")

/**
 * Buscar entre lo que se vende en la sede, con la búsqueda de «Agregar producto»
 * de Cobros (todo el que vende cobra): por nombre, código, marca, modelo y el
 * código de barras exacto. El lector escribe el código y pulsa Enter: si un solo
 * producto lo tiene, queda elegido.
 */
export function ProductSearch({
  id,
  invalid,
  describedBy,
  onBlur,
  branchId,
  branchName,
  money,
  value,
  onChange,
}: {
  id: string
  invalid: boolean
  describedBy: string | undefined
  onBlur: () => void
  branchId: string
  branchName: string
  money: (cents: number) => string
  value: SaleItem | null
  onChange: (product: SaleItem | null) => void
}) {
  const queryClient = useQueryClient()
  const [query, setQuery] = React.useState("")
  const search = React.useDeferredValue(query.trim())
  // Su propia clave: guarda la búsqueda junto a lo que trajo.
  const searchQuery = (q: string) => ({
    queryKey: ["sale-products", "pedido", branchId, q],
    queryFn: async (): Promise<{ q: string; items: SaleItem[] }> => {
      const list = await fetchSaleProducts({ branchId, q: q || undefined, limit: 20 })
      return {
        q,
        // Su búsqueda dice el código de barras y la etiqueta.
        items: list.data.items.map((item) => ({
          productId: item.productId,
          name: item.name,
          salePriceCents: item.salePriceCents,
          currency: item.currency,
          unit: item.unit,
          onHand: item.onHand,
          onHandText: item.onHandText,
          barcode: item.barcode ?? null,
          label: productLabelLine(item),
        })),
      }
    },
    staleTime: 15_000,
  })
  const products = useQuery({
    ...searchQuery(search),
    enabled: Boolean(branchId),
    placeholderData: (previous) => previous,
  })
  const items = products.data?.items ?? []
  // Lo elegido sigue en la lista aunque la búsqueda ya no lo traiga (el escáner no pasa por ella).
  const options = (
    value && !items.some((item) => item.productId === value.productId) ? [value, ...items] : items
  ).map((item) => ({
    id: item.productId,
    label: item.name,
    detail: itemDetail(item, money, branchName),
  }))

  // El escáner escribe más rápido de lo que llega la búsqueda, y el buscador puede vaciarse al
  // pulsar Enter: el código se lee del campo en ese momento y se busca aparte. Si un solo
  // producto lo lleva, queda elegido; si no, Enter sigue siendo el del buscador.
  const scan = async (code: string) => {
    if (!branchId) return
    const found = await queryClient.fetchQuery(searchQuery(code)).catch(() => null)
    const matches = (found?.items ?? []).filter((item) => item.barcode === code)
    if (matches.length === 1 && matches[0]) {
      onChange(matches[0])
      setQuery("")
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: solo escucha el Enter del buscador, que es el del lector de códigos.
    <div
      className="flex flex-col gap-2"
      onKeyDown={(event) => {
        if (event.key !== "Enter") return
        const code = scanCode(event.target instanceof HTMLInputElement ? event.target.value : query)
        if (!code) return
        // Enter en el buscador no vende: busca el código que acaba de leer el escáner.
        event.preventDefault()
        void scan(code)
      }}
    >
      <ResourceSelect
        id={id}
        invalid={invalid}
        aria-describedby={describedBy}
        onBlur={onBlur}
        placeholder="Buscar o escanear…"
        value={value?.productId ?? ""}
        options={options}
        onQueryChange={setQuery}
        onChange={(productId) =>
          onChange(
            [...(value ? [value] : []), ...items].find((item) => item.productId === productId) ??
              null,
          )
        }
        empty={
          !branchId
            ? "Hace falta una sede activa para ver lo que se vende."
            : products.isPending
              ? "Buscando productos…"
              : search
                ? `Ningún producto a la venta coincide con «${search}».`
                : "Aún no hay productos a la venta. Se marcan con «Se vende» en Inventario."
        }
      />
      {products.isError && !products.data ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          No pudimos buscar los productos.
          <Button type="button" size="sm" variant="outline" onClick={() => void products.refetch()}>
            Reintentar
          </Button>
        </p>
      ) : null}
    </div>
  )
}
