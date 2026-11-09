/**
 * Facturas por pagar (ADR 0174): la del laboratorio que llega hoy y se paga a fin de mes. Se anotan
 * en Gastos › Por pagar con «Anotar una factura» (no pagan ni tocan la caja) y se pagan con «Pagar»,
 * que abre el cajón del gasto lleno: se puede pagar una parte. Pueden decir de qué paciente y de qué
 * tratamiento son; su costo junto a lo cobrado lo ve quien administra comisiones, en la cuenta de la
 * paciente.
 */
import { currencyWord, expenseReceiptTypes, formatMoney, formatMoneyInput, isTaxDocument, NO_RECEIPT_TYPE, rucLooksValid } from "@odentia/clinical"
import { Button, FieldDescription, Input, toast } from "@odentia/ui"
import { DatePickerButton, FormDrawer, RowActions, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useRef, useState } from "react"
import {
  EXPENSE_CATEGORIES,
  expenseCategoryHint,
  expenseCategoryLabel,
  fetchExpenseSuppliers,
  fetchPayables,
  financeKeys,
  formatDayKey,
  invalidateFinance,
  notePayableApi,
  type Payable,
  correctPayableApi,
  parseAmount,
  todayIn,
  voidPayableApi,
} from "../../lib/finance-cash"
import { fetchAcceptedTotals, treatmentLineName } from "../../lib/finance-collect"
import { useOrgProfile, useTodayRate } from "../../lib/org"
import { currencyChoices } from "../../lib/product-words"
import { productUi } from "../../product/product-ui"
import { ChoiceButtons } from "../choice-buttons"
import { PersonPicker, type PickedPerson } from "../person-picker"
import { ChoiceChips } from "./cash-close-drawer"
import { VoidDrawer } from "./void-drawer"

/** Lo que vence: «vence el 30 nov», o «venció el 2 nov» si ya pasó. */
function dueWords(payable: Payable, locale: string, today: string): string | null {
  if (!payable.dueOn) return null
  const day = formatDayKey(payable.dueOn, locale, today)
  return payable.overdue ? `venció ${day.startsWith("hoy") || day.startsWith("ayer") ? day : `el ${day}`}` : `vence ${day.startsWith("hoy") || day.startsWith("mañana") ? day : `el ${day}`}`
}

/** El nombre del tratamiento con su lugar (la pieza en odentIA). */
function placeName(code: string): string | null {
  const site = productUi().site
  const place = Number(code)
  return site?.isPlace(place) ? site.placeName(place) : null
}

/** Las facturas que aún deben algo en la sede. */
export function useOpenPayables(branchId: string, enabled = true) {
  return useQuery({
    queryKey: financeKeys.payables(branchId),
    queryFn: () => fetchPayables({ branchId, open: true }),
    enabled: enabled && Boolean(branchId),
    staleTime: 15_000,
  })
}

/** Las filas de las facturas en «Por pagar»: lo que falta, cuándo vence y «Pagar». */
export function PayableRows({
  payables,
  today,
  locale,
  canWrite,
  onPay,
  onVoid,
  onCorrect,
  onShowPayments,
}: {
  payables: Payable[]
  today: string
  locale: string
  canWrite: boolean
  onPay: (payable: Payable) => void
  onVoid: (payable: Payable) => void
  /** «Corregir la factura»: solo sin pagos. */
  onCorrect: (payable: Payable) => void
  /** Con pagos no se corrige ni se anula: primero se ven (y se anulan) sus pagos. */
  onShowPayments: (payable: Payable) => void
}) {
  return (
    <>
      {payables.map((row) => {
        const due = dueWords(row, locale, today)
        const of = row.planItemTitle && row.patientName ? `${treatmentLineName({ title: row.planItemTitle, siteCode: row.planItemSite }, placeName)} de ${row.patientName}` : null
        return (
          <li key={row.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium [overflow-wrap:anywhere]">{row.concept}</span>
              <span className={row.overdue ? "text-sm font-medium text-warning" : "text-sm text-muted-foreground"}>
                {[
                  expenseCategoryLabel(row.category),
                  of,
                  row.paidCents > 0 ? `pagado ${formatMoney(row.paidCents, row.currency, locale)} de ${formatMoney(row.amountCents, row.currency, locale)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                {due ? (
                  <>
                    {" · "}
                    {due}
                  </>
                ) : null}
              </span>
            </span>
            <span className="shrink-0 font-semibold tabular-nums">
              {row.paidCents > 0 ? <span className="font-normal text-muted-foreground">queda </span> : null}
              {formatMoney(row.dueCents, row.currency, locale)}
            </span>
            {canWrite ? (
              <span className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onPay(row)}
                  aria-label={`Pagar ${row.concept}, ${formatMoney(row.dueCents, row.currency, locale)}`}
                >
                  Pagar
                </Button>
                <RowActions
                  label={`Más acciones de ${row.concept}`}
                  items={
                    row.paidCents === 0
                      ? [
                          { key: "corregir", label: "Corregir la factura", onSelect: () => onCorrect(row) },
                          { key: "anular", label: "Anular la factura", onSelect: () => onVoid(row) },
                        ]
                      : [{ key: "pagos", label: "Ver sus pagos", onSelect: () => onShowPayments(row) }]
                  }
                />
              </span>
            ) : null}
          </li>
        )
      })}
    </>
  )
}

/** «Anular la factura»: solo lo anotado por error y sin pagos vigentes. */
export function PayableVoidDrawer({ payable, locale, onClose }: { payable: Payable | null; locale: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const voiding = payable
  return (
      <VoidDrawer
        open={voiding !== null}
        title="Anular la factura"
        description={
          voiding && voiding.paidCents > 0
            ? `Tiene ${formatMoney(voiding.paidCents, voiding.currency, locale)} pagados: anula primero esos pagos en la lista de gastos.`
            : "Deja de estar por pagar; queda registrada con su motivo en la actividad del equipo. Es para lo anotado por error."
        }
        onClose={onClose}
        onConfirm={async (reason) => {
          if (!voiding) return
          await voidPayableApi(voiding.id, reason)
          invalidateFinance(queryClient)
          toast.success(`${voiding.concept}: anulada`)
          onClose()
        }}
      />
  )
}

interface PayableValues {
  category: string
  supplier: string
  supplierTaxId: string
  receiptType: string
  receiptNumber: string
  currency: string
  amount: string
  issuedOn: string
  dueOn: string
  patient: PickedPerson | null
  planItem: string
}

const CATEGORY_OPTIONS = EXPENSE_CATEGORIES.filter((value) => value !== "Personal").map((value) => ({
  value,
  label: expenseCategoryLabel(value),
}))

/** «Anotar una factura»: a quién se le debe, el comprobante, el importe y cuándo vence. No paga. */
export function NotePayableDrawer({
  place,
  open,
  onClose,
  correcting = null,
}: {
  place: { branchId: string; branchName: string; currency: string; locale: string; orgTimeZone: string }
  open: boolean
  onClose: () => void
  /** «Corregir la factura»: el cajón viene lleno y, al guardar, la anotada queda anulada con lo que cambió. */
  correcting?: Payable | null
}) {
  const { branchId, locale, orgTimeZone } = place
  const queryClient = useQueryClient()
  const requestId = useRef<string>(crypto.randomUUID())
  const { second } = useTodayRate(locale)
  const country = useOrgProfile().data?.countryCode ?? "PE"
  const receiptTypes = expenseReceiptTypes(country)
  const today = todayIn(orgTimeZone)
  const supplierListId = useId()
  const suppliers = useQuery({ queryKey: ["finance", "suppliers"], queryFn: fetchExpenseSuppliers, enabled: open, staleTime: 60_000 })
  const note = useMutation({
    mutationFn: (body: Parameters<typeof notePayableApi>[0]) => (correcting ? correctPayableApi(correcting.id, body) : notePayableApi(body)),
  })
  const form = useAppForm({
    defaultValues: {
      category: "Laboratorio",
      supplier: "",
      supplierTaxId: "",
      receiptType: receiptTypes.find((type) => type.asksTaxId)?.code ?? "",
      receiptNumber: "",
      currency: place.currency,
      amount: "",
      issuedOn: today,
      dueOn: "",
      patient: null,
      planItem: "",
    } as PayableValues,
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (!value.supplier.trim()) fields.supplier = "Escribe a quién se le debe."
        const cents = parseAmount(value.amount, value.currency, locale)
        if (value.amount.trim() !== "" && cents === null) fields.amount = "Ese importe no se entiende. Revísalo."
        else if (cents === null || cents <= 0) fields.amount = "Escribe un importe mayor que cero."
        if (value.issuedOn > today) fields.issuedOn = "La fecha de emisión no puede ser futura."
        if (value.dueOn && value.dueOn < value.issuedOn) fields.dueOn = "Vence el mismo día de la emisión o después."
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const cents = parseAmount(value.amount, value.currency, locale)
      if (cents === null) return
      const supplier = (suppliers.data?.data ?? []).find(
        (item) => item.name.toLocaleLowerCase(locale) === value.supplier.trim().toLocaleLowerCase(locale),
      )
      const type = receiptTypes.find((item) => item.code === value.receiptType)
      await note.mutateAsync({
        requestId: requestId.current,
        branchId,
        category: value.category,
        ...(supplier?.id ? { supplierId: supplier.id } : { supplierName: value.supplier.trim() }),
        ...(type?.asksTaxId && value.supplierTaxId.trim() ? { supplierTaxId: value.supplierTaxId.trim() } : {}),
        ...(value.receiptType ? { receiptType: value.receiptType } : {}),
        ...(value.receiptType && value.receiptType !== NO_RECEIPT_TYPE && value.receiptNumber.trim()
          ? { receiptNumber: value.receiptNumber.trim() }
          : {}),
        issuedOn: value.issuedOn,
        ...(value.dueOn ? { dueOn: value.dueOn } : {}),
        ...(value.currency !== place.currency ? { currency: value.currency } : {}),
        amountCents: cents,
        ...(value.patient?.patientId ? { patientId: value.patient.patientId } : {}),
        ...(value.patient?.patientId && value.planItem ? { planItemId: value.planItem } : {}),
      })
      invalidateFinance(queryClient)
      toast.success(
        correcting
          ? `Factura corregida: queda por pagar ${formatMoney(cents, value.currency, locale)}; la de antes, anulada con lo que cambió`
          : `Anotada: queda por pagar ${formatMoney(cents, value.currency, locale)} a ${value.supplier.trim()}`,
      )
      onClose()
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: { amountCents: "amount", supplierName: "supplier", supplierId: "supplier", patientId: "patient", planItemId: "planItem" },
  })
  const values = useStore(form.store, (s) => s.values)
  useEffect(() => {
    if (!open) return
    requestId.current = crypto.randomUUID()
    form.reset()
    if (!correcting) return
    // Corregir: lo anotado, para cambiar solo lo que estaba mal.
    form.setFieldValue("category", correcting.category)
    form.setFieldValue("supplier", correcting.supplierName)
    form.setFieldValue("supplierTaxId", correcting.supplierTaxId ?? "")
    form.setFieldValue("receiptType", correcting.receiptType ?? "")
    form.setFieldValue("receiptNumber", correcting.receiptNumber ?? "")
    form.setFieldValue("currency", correcting.currency)
    form.setFieldValue("amount", formatMoneyInput(correcting.amountCents, correcting.currency, locale))
    form.setFieldValue("issuedOn", correcting.issuedOn)
    form.setFieldValue("dueOn", correcting.dueOn ?? "")
    if (correcting.patientId && correcting.patientName)
      form.setFieldValue("patient", { id: correcting.patientId, name: correcting.patientName, patientId: correcting.patientId })
    form.setFieldValue("planItem", correcting.planItemId ?? "")
  }, [open, form, correcting, locale])
  const patientId = values.patient?.patientId ?? null
  const accepted = useQuery({
    queryKey: ["finance-payables", "accepted", patientId],
    queryFn: () => fetchAcceptedTotals(patientId ?? ""),
    enabled: open && Boolean(patientId),
  })
  const lines = (accepted.data?.data ?? []).flatMap((group) => group.lines)
  const pickedType = receiptTypes.find((item) => item.code === values.receiptType) ?? null
  const [moreOpen, setMoreOpen] = useState(false)
  useEffect(() => {
    if (open) setMoreOpen(Boolean(correcting))
  }, [open, correcting])

  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={() => {
        if (!surface.isSubmitting) onClose()
      }}
      title={correcting ? "Corregir la factura" : "Anotar una factura"}
      description={
        correcting
          ? "Al guardar, la anotada queda anulada con lo que cambió y queda esta."
          : `No paga: queda en «Por pagar» de ${place.branchName} hasta que se pague.`
      }
      submitLabel={correcting ? "Guardar corrección" : "Anotar"}
    >
      <div className="flex flex-col gap-5">
        <form.AppField
          name="supplier"
          listeners={{
            // El RUC del proveedor de la lista, si se tiene y aún no se escribió otro.
            onChange: ({ value }) => {
              const found = (suppliers.data?.data ?? []).find(
                (item) => item.name.toLocaleLowerCase(locale) === value.trim().toLocaleLowerCase(locale),
              )
              if (found?.docNumber && isTaxDocument(found.docType) && !form.getFieldValue("supplierTaxId"))
                form.setFieldValue("supplierTaxId", found.docNumber)
            },
          }}
        >
          {(field) => (
            <field.Control label="A quién se le debe" description="El de tu lista de proveedores, o escríbelo.">
              {(control) => (
                <>
                  <Input
                    {...control.props}
                    list={supplierListId}
                    autoComplete="off"
                    maxLength={200}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <datalist id={supplierListId}>
                    {(suppliers.data?.data ?? []).map((item) => (
                      <option key={item.name} value={item.name} />
                    ))}
                  </datalist>
                </>
              )}
            </field.Control>
          )}
        </form.AppField>
        <div className="grid gap-4 sm:grid-cols-2">
          <form.AppField name="receiptType">
            {(field) => (
              <field.SelectField
                label="Comprobante"
                options={[
                  ...receiptTypes.map((type) => ({ value: type.code, label: type.label })),
                  { value: NO_RECEIPT_TYPE, label: "Sin comprobante" },
                ]}
              />
            )}
          </form.AppField>
          {values.receiptType && values.receiptType !== NO_RECEIPT_TYPE ? (
            <form.AppField name="receiptNumber">
              {(field) => <field.TextField label="Número (opcional)" maxLength={60} placeholder="F001-000123" />}
            </form.AppField>
          ) : null}
        </div>
        {pickedType?.asksTaxId ? (
          <form.AppField name="supplierTaxId">
            {(field) => (
              <div className="flex flex-col gap-1">
                <field.TextField label="RUC (opcional)" maxLength={20} inputMode="numeric" inputClassName="sm:w-48" />
                {/* Avisa, no frena: el contador lo revisa con el comprobante. */}
                {country === "PE" && field.state.value.trim() && !rucLooksValid(field.state.value) ? (
                  <FieldDescription>Ese RUC no parece válido: revísalo con la factura.</FieldDescription>
                ) : !field.state.value.trim() ? (
                  <FieldDescription>Sin RUC, tu contador no podrá usar la factura. Puedes anotarla igual.</FieldDescription>
                ) : null}
              </div>
            )}
          </form.AppField>
        ) : null}
        {second ? (
          <form.AppField name="currency">
            {(field) => (
              <field.Group legend="Moneda" className="gap-3">
                {(control) => (
                  <ChoiceButtons
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    tone="primary"
                    value={field.state.value}
                    options={currencyChoices([place.currency, second.currency], locale)}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
        ) : null}
        <form.AppField name="amount">
          {(field) => <field.TextField label={`Importe, en ${currencyWord(values.currency, locale)}`} inputMode="decimal" inputClassName="w-40" />}
        </form.AppField>
        <div className="grid gap-4 sm:grid-cols-2">
          <form.AppField name="dueOn">
            {(field) => (
              <field.Control label="Vence (opcional)">
                {(control) => (
                  <DatePickerButton
                    {...control.props}
                    className="justify-start font-normal"
                    value={field.state.value || values.issuedOn}
                    min={values.issuedOn}
                    onChange={(day) => field.handleChange(day)}
                  >
                    {field.state.value ? formatDayKey(field.state.value, locale, today) : "Sin fecha"}
                  </DatePickerButton>
                )}
              </field.Control>
            )}
          </form.AppField>
        </div>
        {/* El tipo y la emisión casi nunca cambian: una línea quieta, y se cambian si hace falta. */}
        {moreOpen ? (
          <>
        <form.AppField name="category">
          {(field) => (
            <field.Group
              legend="Tipo"
              description={
                field.state.value === "Materiales"
                  ? "Si es mercadería de una compra de Inventario, se paga en la compra: no la anotes aquí."
                  : expenseCategoryHint(field.state.value)
              }
            >
              {(control) => (
                <ChoiceChips
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  options={CATEGORY_OPTIONS}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
          <form.AppField name="issuedOn">
            {(field) => (
              <field.Control label="Emitida">
                {(control) => (
                  <DatePickerButton
                    {...control.props}
                    className="justify-start font-normal"
                    value={field.state.value}
                    max={today}
                    onChange={(day) => field.handleChange(day)}
                  >
                    {formatDayKey(field.state.value, locale, today)}
                  </DatePickerButton>
                )}
              </field.Control>
            )}
          </form.AppField>
          </>
        ) : (
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            {expenseCategoryLabel(values.category)} · emitida {formatDayKey(values.issuedOn, locale, today).toLocaleLowerCase("es")}.
            <Button type="button" variant="link" className="h-auto p-0" onClick={() => setMoreOpen(true)}>
              Cambiar
            </Button>
          </p>
        )}
        <form.AppField name="patient">
          {(field) => (
            <field.Control label="¿De qué paciente? (opcional)" description="Para ver su costo junto a lo cobrado de su tratamiento.">
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
                    form.setFieldValue("planItem", "")
                  }}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        {patientId ? (
          <form.AppField name="planItem">
            {(field) =>
              lines.length > 0 ? (
                <field.SelectField
                  label="¿De qué tratamiento? (opcional)"
                  placeholder="Ninguno en particular"
                  options={lines.map((line) => ({ value: line.planItemId, label: treatmentLineName(line, placeName) }))}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {accepted.isPending ? "Buscando sus tratamientos aceptados…" : "No tiene un tratamiento aceptado: la factura queda solo con su nombre."}
                </p>
              )
            }
          </form.AppField>
        ) : null}
      </div>
    </FormDrawer>
  )
}

/** «Anotar una factura» en la cabecera de «Por pagar». */
export function NotePayableButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" variant="link" className="h-auto p-0 text-sm font-semibold" onClick={onClick}>
      Anotar una factura
    </Button>
  )
}
