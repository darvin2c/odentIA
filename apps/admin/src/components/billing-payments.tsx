/**
 * Los pagos de una clínica, una sola vez para Cobros y planes y para la ficha
 * del cliente › Plan y pagos (ARM, ADR 0183): ver el comprobante, confirmar,
 * rechazar con motivo, reversar, devolver y registrar un pago recibido. Las
 * reglas son del servidor (solo Administración, 409 si otra persona ya lo
 * decidió); aquí solo se piden y se dicen.
 */
import { formatMoney } from "@odentia/clinical"
import { Button, Input } from "@odentia/ui"
import {
  DatePickerButton,
  EmptyState,
  ErrorState,
  FormDrawer,
  SkeletonRegion,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { type ReactNode, useState } from "react"
import { z } from "zod"
import { api } from "../lib/api"
import { currencyDigits, majorToCents } from "./billing-fields"
import { ReasonDialog } from "./reason-dialog"
import { BillingHistorySkeleton } from "./skeletons/billing"

const LOCALE = "es-PE"

export const paymentMethodSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  instructions: z.string().nullable(),
  isActive: z.boolean(),
})
export type PaymentMethod = z.infer<typeof paymentMethodSchema>

export const historyPaymentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  amountCents: z.number(),
  currency: z.string(),
  methodCode: z.string(),
  status: z.string(),
  receiptFilename: z.string().nullable(),
  rejectedAt: z.string().nullable(),
  rejectReason: z.string().nullable(),
  rejectedByName: z.string().nullable(),
  createdAt: z.string(),
})
export type HistoryPayment = z.infer<typeof historyPaymentSchema>

/** Lo que hace falta para decir de qué comprobante se habla al rechazarlo. */
export interface PaymentTarget {
  id: string
  organizationId: string
  organizationName: string | null
  receiptFilename: string | null
  amountCents: number
  currency: string
}

/** El estado de un pago en palabras, el mismo que lee la clínica en Plan y pagos. */
export const PAYMENT_STATUS: Record<string, string> = {
  pendiente: "Pendiente de confirmación",
  confirmado: "Confirmado",
  reversado: "Reversado",
  devuelto: "Devuelto",
  rechazado: "Rechazado",
}

export function money(cents: number, currency: string): string {
  try {
    return formatMoney(cents, currency, LOCALE)
  } catch {
    return `${cents} ${currency}`
  }
}

/** «mié 11 nov, 15:30», en la hora de Lima, donde trabaja la administración. */
export function dayTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const parts = new Intl.DateTimeFormat(LOCALE, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "America/Lima",
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value.replace(/\./g, "") ?? ""
  return `${part("weekday")} ${part("day")} ${part("month")}, ${part("hour")}:${part("minute")}`
}

/** «Rechazado: No se ve el número de operación · por Ada el mié 11 nov, 15:30». */
export function paymentStatusLine(payment: HistoryPayment): string {
  const label = PAYMENT_STATUS[payment.status] ?? payment.status
  if (payment.status !== "rechazado") return label
  const who = payment.rejectedByName ? ` · por ${payment.rejectedByName.split(" ")[0]}` : ""
  const when = payment.rejectedAt ? ` el ${dayTime(payment.rejectedAt)}` : ""
  return `${label}${payment.rejectReason ? `: ${payment.rejectReason}` : ""}${who || when ? `${who || " ·"}${when}` : ""}`
}

/** Los medios de pago (también los inactivos, para nombrar los pagos de antes). */
export function usePaymentMethods(enabled = true) {
  return useQuery({
    queryKey: ["admin", "billing", "methods"],
    enabled,
    queryFn: async () =>
      z
        .array(paymentMethodSchema)
        .parse(await api<unknown>("/api/admin/billing/methods?includeInactive=1")),
  })
}

export type PaymentChange = "confirm" | "reject" | "reverse" | "refund"

/**
 * Las acciones sobre los pagos y sus diálogos con motivo. Quien la usa pinta
 * `dialogs` una vez y llama a `request*` desde cada fila; `onChanged` dice qué
 * cambió para refrescar lo suyo.
 */
export function usePaymentActions({ onChanged }: { onChanged: (change: PaymentChange) => void }) {
  const [rejectTarget, setRejectTarget] = useState<PaymentTarget | null>(null)
  // «Reversar» es solo de lo confirmado; lo pendiente se «Rechaza», con su propio diálogo.
  const [reverseTarget, setReverseTarget] = useState<{ id: string; organizationId: string } | null>(
    null,
  )
  const [refundTarget, setRefundTarget] = useState<{ id: string; organizationId: string } | null>(
    null,
  )
  const [receiptBusy, setReceiptBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  async function openReceipt(organizationId: string, paymentId: string) {
    setActionError(null)
    setReceiptBusy(paymentId)
    try {
      const res = z
        .object({ url: z.string() })
        .parse(
          await api<unknown>(
            `/api/admin/billing/payments/receipt?organizationId=${encodeURIComponent(organizationId)}&paymentId=${encodeURIComponent(paymentId)}`,
          ),
        )
      window.open(res.url, "_blank", "noopener")
    } catch (e) {
      setActionError(submitErrorMessage(e))
    } finally {
      setReceiptBusy(null)
    }
  }
  const confirm = useMutation({
    mutationFn: (payment: { id: string; organizationId: string }) =>
      api(`/api/admin/billing/payments/${payment.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ organizationId: payment.organizationId }),
      }),
    onSuccess: () => onChanged("confirm"),
  })
  const reverse = useMutation({
    mutationFn: ({
      target,
      reason,
    }: {
      target: { id: string; organizationId: string }
      reason: string
    }) =>
      api(`/api/admin/billing/payments/${target.id}/reverse`, {
        method: "POST",
        body: JSON.stringify({ organizationId: target.organizationId, reason }),
      }),
    onSuccess: () => onChanged("reverse"),
  })
  // Si otra persona ya lo confirmó o lo rechazó, el 409 lo dice en el diálogo y la lista se pone al día.
  const reject = useMutation({
    mutationFn: ({ target, reason }: { target: PaymentTarget; reason: string }) =>
      api(`/api/admin/billing/payments/${target.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ organizationId: target.organizationId, reason }),
      }),
    onSettled: () => onChanged("reject"),
  })
  const refund = useMutation({
    mutationFn: ({
      target,
      reason,
    }: {
      target: { id: string; organizationId: string }
      reason: string
    }) =>
      api(`/api/admin/billing/payments/${target.id}/refund`, {
        method: "POST",
        body: JSON.stringify({ organizationId: target.organizationId, reason }),
      }),
    onSuccess: () => onChanged("refund"),
  })
  const rejectClinic = rejectTarget ? (rejectTarget.organizationName ?? "la clínica") : ""

  const dialogs: ReactNode = (
    <>
      <ReasonDialog
        open={rejectTarget !== null}
        id="reject-reason"
        title={
          rejectTarget
            ? `Rechazar ${rejectTarget.receiptFilename ?? "el comprobante"} · ${money(rejectTarget.amountCents, rejectTarget.currency)} de ${rejectClinic}`
            : "Rechazar comprobante"
        }
        description={`El comprobante se cierra y no suma al cargo; ${rejectClinic} podrá registrar otro. Verá este motivo en Plan y pagos y en el aviso de su pantalla. No le llega correo. Si fue un error, registra el pago en el cargo.`}
        confirmLabel="Rechazar"
        placeholder="Por qué no se puede confirmar, como lo leerá la clínica"
        onConfirm={(reason) =>
          rejectTarget ? reject.mutateAsync({ target: rejectTarget, reason }) : Promise.resolve()
        }
        onClose={() => setRejectTarget(null)}
      />
      <ReasonDialog
        open={reverseTarget !== null}
        id="reverse-reason"
        title="Reversar pago"
        description="El pago dejará de sumar al cargo. Si su comisión ya se liquidó, se descuenta como ajuste en la próxima liquidación (la liquidación original no se modifica)."
        confirmLabel="Reversar"
        placeholder="Por qué se reversa"
        onConfirm={(reason) =>
          reverseTarget ? reverse.mutateAsync({ target: reverseTarget, reason }) : Promise.resolve()
        }
        onClose={() => setReverseTarget(null)}
      />
      <ReasonDialog
        open={refundTarget !== null}
        id="refund-reason"
        title="Devolver pago"
        description="El dinero vuelve a la clínica y el cargo deja de sumarlo. Si su comisión ya se liquidó, se descuenta como ajuste en la próxima liquidación."
        confirmLabel="Devolver"
        placeholder="Por qué se devuelve"
        onConfirm={(reason) =>
          refundTarget ? refund.mutateAsync({ target: refundTarget, reason }) : Promise.resolve()
        }
        onClose={() => setRefundTarget(null)}
      />
    </>
  )

  return {
    openReceipt: (organizationId: string, paymentId: string) =>
      void openReceipt(organizationId, paymentId),
    receiptBusy,
    actionError,
    confirm,
    requestReject: setRejectTarget,
    requestReverse: setReverseTarget,
    requestRefund: setRefundTarget,
    dialogs,
  }
}

export type PaymentActions = ReturnType<typeof usePaymentActions>

/**
 * Los pagos de una clínica, lo último arriba: pendientes, confirmados,
 * rechazados, reversos y devoluciones. Con `confirmPending`, lo pendiente se
 * confirma o se rechaza en la misma fila (la ficha del cliente); en Cobros eso
 * vive en «Comprobantes por confirmar».
 */
export function PaymentHistoryList({
  organizationId,
  organizationName,
  methodName,
  actions,
  confirmPending = false,
}: {
  organizationId: string
  organizationName: string | null
  methodName: (code: string) => string
  actions: PaymentActions
  confirmPending?: boolean
}) {
  const payments = useQuery({
    queryKey: ["admin", "billing", "history", organizationId],
    queryFn: async () =>
      z
        .array(historyPaymentSchema)
        .parse(
          await api<unknown>(
            `/api/admin/billing/payments?organizationId=${encodeURIComponent(organizationId)}`,
          ),
        ),
  })
  if (payments.isPending)
    return (
      <SkeletonRegion message="Cargando pagos…">
        <BillingHistorySkeleton />
      </SkeletonRegion>
    )
  if (payments.isError)
    return (
      <ErrorState
        title="No se pudieron cargar los pagos"
        message={submitErrorMessage(payments.error)}
        onRetry={() => void payments.refetch()}
      />
    )
  if (payments.data.length === 0)
    return <EmptyState title="Sin pagos" description="Esta clínica aún no registra pagos." />
  return (
    <ul className="flex flex-col gap-2">
      {payments.data.map((payment) => (
        <li
          key={payment.id}
          className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4"
        >
          <div className="min-w-0 flex-1 basis-56">
            <p className="text-sm font-medium [overflow-wrap:anywhere]">
              {payment.receiptFilename ?? "Comprobante"}
            </p>
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {paymentStatusLine(payment)} · {methodName(payment.methodCode)} ·{" "}
              {dayTime(payment.createdAt)}
            </p>
          </div>
          <p className="text-sm font-semibold tabular-nums">
            {money(payment.amountCents, payment.currency)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={actions.receiptBusy === payment.id}
              onClick={() => actions.openReceipt(payment.organizationId, payment.id)}
            >
              Ver
            </Button>
            {confirmPending && payment.status === "pendiente" ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actions.confirm.isPending}
                  onClick={() => actions.confirm.mutate(payment)}
                >
                  Confirmar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    actions.requestReject({
                      id: payment.id,
                      organizationId: payment.organizationId,
                      organizationName,
                      receiptFilename: payment.receiptFilename,
                      amountCents: payment.amountCents,
                      currency: payment.currency,
                    })
                  }
                >
                  Rechazar
                </Button>
              </>
            ) : null}
            {payment.status === "confirmado" ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => actions.requestReverse(payment)}>
                  Reversar
                </Button>
                <Button size="sm" variant="ghost" onClick={() => actions.requestRefund(payment)}>
                  Devolver
                </Button>
              </>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}

interface ChargeOption {
  id: string
  planName: string
  amountCents: number
  currency: string
  paidCents: number
  status: string
}

const chargeOptionSchema = z.object({
  id: z.string(),
  planName: z.string(),
  amountCents: z.number(),
  currency: z.string(),
  paidCents: z.number(),
  status: z.string(),
})

/** Lo que falla en el importe según los decimales de la moneda del cargo; vacío lo dice el esquema. */
function amountProblem(text: string, currency: string | undefined): string | undefined {
  const value = text.trim()
  if (!value || !currency) return undefined
  const digits = currencyDigits(currency)
  const pattern = digits > 0 ? new RegExp(`^\\d+([.,]\\d{1,${digits}})?$`) : /^\d+$/
  if (!pattern.test(value))
    return digits > 0
      ? `Escribe el importe con hasta ${digits} decimales, como 150.00`
      : "Escribe el importe sin decimales"
  const cents = majorToCents(value, currency)
  if (cents === null || cents <= 0) return "El importe debe ser mayor que cero"
  return undefined
}

const manualSchema = z.object({
  organizationId: z.string().min(1, "Elige la clínica"),
  chargeId: z.string().min(1, "Elige el cargo"),
  methodCode: z.string().min(1, "Elige el medio usado"),
  amount: z.string().trim().min(1, "Escribe el importe"),
  paidAt: z.string().min(1, "Elige la fecha de pago"),
  notes: z.string().max(2000, "Escribe las notas en 2000 caracteres como mucho"),
  file: z.custom<File | null>((value) => value instanceof File, "Adjunta el comprobante recibido"),
})

/**
 * Registrar un pago recibido (D1): clínica y cargo por nombre, fecha de pago,
 * medio, importe y comprobante real. Con una sola clínica (la ficha del
 * cliente) no se elige: se dice cuál es.
 */
export function ManualPaymentDrawer({
  orgs,
  methods,
  onClose,
  onSaved,
}: {
  orgs: Array<{ organizationId: string; organizationName: string | null }>
  methods: PaymentMethod[]
  onClose: () => void
  onSaved: () => void
}) {
  // El servidor solo acepta medios activos.
  const activeMethods = methods.filter((method) => method.isActive)
  const save = useMutation({
    mutationFn: (body: FormData) =>
      api("/api/admin/billing/payments/manual", { method: "POST", body }),
  })
  const form = useAppForm({
    defaultValues: {
      organizationId: orgs[0]?.organizationId ?? "",
      chargeId: "",
      methodCode: activeMethods[0]?.code ?? "",
      amount: "",
      paidAt: new Date().toISOString().slice(0, 10),
      notes: "",
      file: null as File | null,
    },
    validators: { onSubmit: manualSchema },
    onSubmit: async ({ value }) => {
      const charge = charges.data?.find((item) => item.id === value.chargeId)
      const amountCents = charge ? majorToCents(value.amount, charge.currency) : null
      // Los validadores de cargo, importe y comprobante ya lo garantizan; si el cargo
      // dejó de estar en la lista mientras se escribía, se dice junto a los botones.
      if (!charge || amountCents === null || !value.file) {
        throw new Error(
          "El cargo elegido ya no está en la lista. Vuelve a elegirlo antes de registrar el pago.",
        )
      }
      const body = new FormData()
      body.append("organizationId", value.organizationId)
      body.append("chargeId", charge.id)
      body.append("methodCode", value.methodCode)
      body.append("amountCents", String(amountCents))
      body.append("idempotencyKey", crypto.randomUUID())
      if (value.notes.trim()) body.append("notes", value.notes.trim())
      body.append("paidAt", new Date(`${value.paidAt}T12:00:00Z`).toISOString())
      body.append("file", value.file, value.file.name)
      await save.mutateAsync(body)
      onSaved()
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: { amountCents: "amount" } })
  const orgId = useStore(form.store, (state) => state.values.organizationId)
  const chargeId = useStore(form.store, (state) => state.values.chargeId)
  const charges = useQuery({
    queryKey: ["admin", "billing", "charges", orgId],
    queryFn: async (): Promise<ChargeOption[]> =>
      z
        .array(chargeOptionSchema)
        .parse(
          await api<unknown>(
            `/api/admin/billing/charges?organizationId=${encodeURIComponent(orgId)}`,
          ),
        ),
    enabled: orgId !== "",
  })
  const charge = charges.data?.find((item) => item.id === chargeId) ?? null
  const single = orgs.length === 1 ? orgs[0] : null
  return (
    <FormDrawer
      {...surface}
      open
      title="Registrar pago recibido"
      submitLabel="Registrar y confirmar"
      onClose={onClose}
    >
      {single ? (
        <p className="text-sm">
          <span className="text-muted-foreground">Clínica: </span>
          {single.organizationName ?? "esta clínica"}
        </p>
      ) : (
        <form.AppField
          name="organizationId"
          listeners={{ onChange: () => form.setFieldValue("chargeId", "") }}
        >
          {(field) => (
            <field.SelectField
              id="manual-org"
              label="Clínica"
              placeholder="Elige la clínica"
              options={orgs.map((org) => ({
                value: org.organizationId,
                label: org.organizationName ?? org.organizationId,
              }))}
            />
          )}
        </form.AppField>
      )}
      <form.AppField
        name="chargeId"
        validators={{
          onSubmit: ({ value }) =>
            value && charges.data && !charges.data.some((item) => item.id === value)
              ? "Ese cargo ya no está: elige otro."
              : undefined,
        }}
      >
        {(field) => (
          <field.SelectField
            id="manual-charge"
            label="Cargo"
            placeholder={
              charges.data?.length === 0
                ? "Esta clínica no tiene cargos por pagar"
                : "Elige el cargo"
            }
            options={(charges.data ?? []).map((item) => ({
              value: item.id,
              label: `${item.planName} · saldo ${money(item.amountCents - item.paidCents, item.currency)}`,
            }))}
          />
        )}
      </form.AppField>
      <div className="grid grid-cols-2 gap-3">
        <form.AppField name="methodCode">
          {(field) => (
            <field.SelectField
              id="manual-method"
              label="Medio usado"
              placeholder="Elige el medio"
              options={activeMethods.map((method) => ({ value: method.code, label: method.name }))}
            />
          )}
        </form.AppField>
        <form.AppField
          name="amount"
          validators={{ onSubmit: ({ value }) => amountProblem(value, charge?.currency) }}
        >
          {(field) => (
            <field.TextField
              id="manual-amount"
              label={`Importe${charge ? ` (${charge.currency})` : ""}`}
              inputMode="decimal"
              placeholder="150.00"
            />
          )}
        </form.AppField>
      </div>
      <form.AppField name="paidAt">
        {(field) => (
          <field.Control id="manual-paid" label="Fecha de pago">
            {(control) => (
              <DatePickerButton
                {...control.props}
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
        {(field) => (
          <field.TextareaField id="manual-notes" label="Notas (opcional)" maxLength={2000} />
        )}
      </form.AppField>
      <form.AppField name="file">
        {(field) => (
          <field.Control id="manual-file" label="Comprobante (PNG, JPG, WebP o PDF, máx. 10 MB)">
            {(control) => (
              <Input
                {...control.props}
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf"
                onChange={(event) => {
                  field.handleChange(event.target.files?.[0] ?? null)
                  field.handleBlur()
                }}
              />
            )}
          </field.Control>
        )}
      </form.AppField>
    </FormDrawer>
  )
}
