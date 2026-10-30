import { Button, Input } from "@odentia/ui"
import { type ApiErrorShape, useAppForm, useFormSubmit, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useEffect, useMemo, useState } from "react"
import { z } from "zod"
import { ApiError } from "../../lib/api"
import { API_URL } from "../../lib/auth-client"
import { centsToMajor, formatPlanMoney, readMajor } from "./money"

export interface ReceiptCharge {
  id: string
  planName: string
  amountCents: number
  currency: string
  paidCents: number
  status: string
}

export interface ReceiptMethod {
  code: string
  name: string
  instructions: string | null
}

const ACCEPT = "image/png,image/jpeg,image/webp,application/pdf"
const MAX_BYTES = 10 * 1024 * 1024

/** El servidor nombra el importe por lo que recibe (`amountCents`); la pantalla, por lo que se escribe. */
const RECEIPT_FIELD_MAP = { amountCents: "amount" }

/** Registra un comprobante (multipart a /api/account/billing/receipts). Disponible en restricción. */
export function ReceiptForm({
  orgId,
  charges,
  methods,
  onDone,
}: {
  orgId: string
  charges: ReceiptCharge[]
  methods: ReceiptMethod[]
  onDone: () => void
}) {
  const [sent, setSent] = useState(false)
  const open = useMemo(
    () => charges.filter((charge) => charge.status === "pendiente" || charge.status === "parcial"),
    [charges],
  )
  // Clave estable por intento: se conserva al reintentar un error ambiguo y
  // rota al cambiar de cargo o al confirmar (nunca un UUID nuevo por clic).
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())

  // Las reglas dependen del cargo elegido (su saldo y su moneda).
  const schema = useMemo(
    () =>
      z
        .object({
          chargeId: z.string().min(1, "Elige el cargo."),
          methodCode: z.string().min(1, "Elige el medio usado."),
          amount: z.string(),
          file: z.custom<File | null>(),
        })
        .superRefine((value, ctx) => {
          const charge = open.find((item) => item.id === value.chargeId)
          if (charge) {
            const reading = readMajor(value.amount, charge.currency)
            if (!reading.ok) ctx.addIssue({ code: "custom", path: ["amount"], message: reading.error })
            else if (reading.cents > charge.amountCents - charge.paidCents)
              ctx.addIssue({
                code: "custom",
                path: ["amount"],
                message: `El importe supera el saldo del cargo (${formatPlanMoney(charge.amountCents - charge.paidCents, charge.currency)}).`,
              })
          }
          if (!value.file) ctx.addIssue({ code: "custom", path: ["file"], message: "Adjunta el archivo del comprobante." })
          else if (value.file.size > MAX_BYTES || value.file.size === 0)
            ctx.addIssue({ code: "custom", path: ["file"], message: "El archivo debe pesar entre 1 B y 10 MB." })
        }),
    [open],
  )

  const form = useAppForm({
    defaultValues: {
      chargeId: open[0]?.id ?? "",
      methodCode: methods[0]?.code ?? "",
      amount: "",
      file: null as File | null,
    },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const charge = open.find((item) => item.id === value.chargeId)
      const reading = charge ? readMajor(value.amount, charge.currency) : null
      if (!charge || !reading?.ok || !value.file) return
      const body = new FormData()
      body.append("orgId", orgId)
      body.append("chargeId", charge.id)
      body.append("methodCode", value.methodCode)
      body.append("amountCents", String(reading.cents))
      body.append("idempotencyKey", idempotencyKey)
      body.append("file", value.file, value.file.name)
      // Un fallo de red rechaza aquí: el formulario dice que no se pudo confirmar.
      const response = await fetch(`${API_URL}/api/account/billing/receipts`, {
        method: "POST",
        credentials: "include",
        body,
      })
      if (!response.ok) {
        let shape: ApiErrorShape = {}
        try {
          const json = (await response.json()) as { error?: ApiErrorShape }
          shape = json.error ?? {}
        } catch {
          // respuesta no-JSON: mensaje por estado
        }
        throw new ApiError(response.status, shape)
      }
      setIdempotencyKey(crypto.randomUUID())
      setSent(true)
      onDone()
    },
  })
  const onSubmit = useFormSubmit(form, { fieldMap: RECEIPT_FIELD_MAP })
  const formError = useFormSubmitError(form)
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
  const chargeId = useStore(form.store, (state) => state.values.chargeId)
  const methodCode = useStore(form.store, (state) => state.values.methodCode)
  useEffect(() => {
    setIdempotencyKey(crypto.randomUUID())
  }, [chargeId])

  if (open.length === 0) {
    return <p className="text-sm text-muted-foreground">No tienes cargos pendientes.</p>
  }
  if (methods.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aún no hay medios de pago configurados. Escribe a soporte para registrar tu comprobante.
      </p>
    )
  }
  if (sent) {
    return (
      <p className="text-sm">
        Comprobante registrado: queda pendiente de confirmación y te avisaremos al confirmarlo.
      </p>
    )
  }

  const selected = open.find((charge) => charge.id === chargeId) ?? null
  const outstanding = selected ? selected.amountCents - selected.paidCents : 0
  const method = methods.find((item) => item.code === methodCode) ?? null

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-3">
      <form.AppField name="chargeId">
        {(field) => (
          <field.SelectField
            id="receipt-charge"
            label="Cargo"
            placeholder="Elige el cargo"
            options={open.map((charge) => ({
              value: charge.id,
              label: `${charge.planName} · saldo ${formatPlanMoney(charge.amountCents - charge.paidCents, charge.currency)}`,
            }))}
          />
        )}
      </form.AppField>
      <div className="grid grid-cols-2 gap-3">
        <form.AppField name="methodCode">
          {(field) => (
            <field.SelectField
              id="receipt-method"
              label="Medio usado"
              placeholder="Elige el medio"
              options={methods.map((item) => ({ value: item.code, label: item.name }))}
            />
          )}
        </form.AppField>
        <form.AppField name="amount">
          {(field) => (
            <field.TextField
              id="receipt-amount"
              label={`Importe${selected ? ` (${selected.currency})` : ""}`}
              inputMode="decimal"
              placeholder={selected ? centsToMajor(outstanding, selected.currency) : ""}
            />
          )}
        </form.AppField>
      </div>
      {method?.instructions ? (
        <p className="text-xs text-muted-foreground">{method.instructions}</p>
      ) : null}
      <form.AppField name="file">
        {(field) => (
          <field.Control id="receipt-file" label="Comprobante (PNG, JPG, WebP o PDF, máx. 10 MB)">
            {(control) => (
              <Input
                {...control.props}
                type="file"
                accept={ACCEPT}
                onChange={(event) => field.handleChange(event.target.files?.[0] ?? null)}
              />
            )}
          </field.Control>
        )}
      </form.AppField>
      {formError ? (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      ) : null}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Enviando…" : "Registrar comprobante"}
      </Button>
    </form>
  )
}
