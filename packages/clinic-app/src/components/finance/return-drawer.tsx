/**
 * «Devolver» desde un ticket (ADR 0068): el paciente devuelve algo o pide su
 * dinero otro día. La venta del ticket queda en pie y la devolución la rebaja:
 * de cada producto se elige cuántos y si vuelve a la sede; de un servicio, el
 * importe que se le devuelve. Al final, cómo se le devuelve el dinero o si
 * queda a favor. Al terminar, la devolución se imprime y se envía como el ticket.
 */
import { formatMoney } from "@odentia/clinical"
import { Button } from "@odentia/ui"
import { ErrorState, FormDrawer, SubmitButton, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Check, CreditCard, Minus, Plus, Printer } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { SendFinancialDocument } from "../finance-documents/SendFinancialDocument"
import { ChoiceButtons } from "../choice-buttons"
import { financeErrorMessage, financeFormMessage } from "../../lib/finance"
import {
  CASH_TYPE_CODE,
  createTicketReturnApi,
  fetchPaymentMethods,
  fetchTicketReturnable,
  returnPdfPath,
  type PaymentReturnRow,
  type ReturnableLine,
  type ReturnBody,
  type ReturnLineBody,
} from "../../lib/finance-collect"
import { byCount } from "../../lib/inventory"
import { MoneyInput, parseMoneyOrNull } from "./collect-drawer"
import { openServerPdf } from "./ticket-view"

/** Tarjeta (UN/CEFACT 4461): la devolución también se hace en su terminal. */
const CARD_TYPE_CODE = "48"
const LEAVE_AS_CREDIT = "__a_favor__"
const MAX_REASON = 2000

/** Lo que se elige de una línea que se puede devolver (las bloqueadas no entran). */
interface LineDraft {
  chargeId: string
  /** Producto: unidades que devuelve. */
  quantity: number
  /** Producto: vuelve a la sede. */
  backToStock: boolean
  /** Servicio: importe escrito. */
  amount: string
}

interface ReturnValues {
  lines: LineDraft[]
  /** Medio elegido; null = el que se propone (con el que pagó). */
  payout: string | null
  reason: string
}

const EMPTY: ReturnValues = { lines: [], payout: null, reason: "" }

export function ReturnDrawer({
  open,
  onClose,
  patientId,
  patientName,
  ticketId,
  ticketNumber,
  branchId,
  branchName,
  locale,
  onReturned,
}: {
  open: boolean
  onClose: () => void
  patientId: string
  patientName: string
  ticketId: string
  ticketNumber: string
  /** Sede donde se devuelve: de su caja sale el dinero. */
  branchId: string
  branchName: string
  locale: string
  onReturned: () => void
}): React.JSX.Element {
  const returnable = useQuery({
    queryKey: ["ticket-returnable", patientId, ticketId],
    queryFn: () => fetchTicketReturnable(patientId, ticketId),
    enabled: open,
  })
  const methods = useQuery({ queryKey: ["org-payment-methods"], queryFn: fetchPaymentMethods, enabled: open })
  const data = returnable.data?.data
  const currency = data?.currency ?? ""
  const money = (cents: number) => formatMoney(cents, currency, locale)
  const lines = data?.lines ?? []
  const methodList = methods.data?.data ?? []
  const lineOf = useMemo(() => new Map(lines.map((line) => [line.chargeId, line])), [lines])

  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [done, setDone] = useState<PaymentReturnRow | null>(null)
  const [printing, setPrinting] = useState(false)
  const [printError, setPrintError] = useState<string | null>(null)
  /** Fila del formulario de cada línea enviada, en el orden del cuerpo (`lines[i]` del servidor). */
  const sentRows = useRef<number[]>([])

  // El medio con que pagó va primero y es el que se propone.
  const paidWith = data?.methods[0]?.paymentMethodId ?? null
  const methodOptions = useMemo(() => {
    const sorted = [...methodList].sort((a, b) => Number(b.id === paidWith) - Number(a.id === paidWith))
    return sorted.map((method) => ({
      value: method.id,
      label: method.id === paidWith ? `${method.name} (como pagó)` : method.name,
    }))
  }, [methodList, paidWith])
  const proposedPayout = methodList.some((method) => method.id === paidWith) ? paidWith : (methodList[0]?.id ?? null)

  /** Cuánto devuelve una línea, con el mismo redondeo que el servidor; null si el importe no vale. */
  const centsOf = (line: ReturnableLine, draft: LineDraft): number | null => {
    if (line.kind === "producto") {
      const sold = line.quantity ?? 1
      const quantity = Math.min(Math.max(draft.quantity, 0), sold)
      return quantity === 0 ? 0 : quantity === sold ? line.amountCents : Math.round((line.amountCents * quantity) / sold)
    }
    const raw = draft.amount.trim()
    if (!raw) return 0
    const cents = parseMoneyOrNull(raw, currency, locale)
    return cents === null || cents < 0 || cents > line.paidCents ? null : cents
  }

  const schema = useMemo(
    () =>
      z
        .object({
          lines: z.array(
            z.object({ chargeId: z.string(), quantity: z.number(), backToStock: z.boolean(), amount: z.string() }),
          ),
          payout: z.string().nullable(),
          reason: z
            .string()
            .trim()
            .min(1, "Escribe el motivo de la devolución.")
            .max(MAX_REASON, `Escribe el motivo en ${MAX_REASON} caracteres como mucho.`),
        })
        .superRefine((value, ctx) => {
          let picked = 0
          let invalid = false
          value.lines.forEach((draft, index) => {
            const line = lineOf.get(draft.chargeId)
            if (!line) return
            if (line.kind === "producto") {
              if (draft.quantity > 0) picked += 1
              return
            }
            const raw = draft.amount.trim()
            if (!raw) return
            const cents = parseMoneyOrNull(raw, currency, locale)
            if (cents === null || cents < 0) {
              invalid = true
              ctx.addIssue({
                code: "custom",
                path: ["lines", index, "amount"],
                message: "No se entiende el importe: escribe solo la cifra, sin letras ni signos.",
              })
            } else if (cents > line.paidCents) {
              invalid = true
              ctx.addIssue({
                code: "custom",
                path: ["lines", index, "amount"],
                message: `Es más de lo que pagó en este ticket: como mucho ${formatMoney(line.paidCents, currency, locale)}.`,
              })
            } else if (cents > 0) picked += 1
          })
          if (picked === 0 && !invalid)
            ctx.addIssue({
              code: "custom",
              path: ["lines"],
              message: "Elige qué devuelve: un producto o un importe de un servicio.",
            })
          if (!(value.payout ?? proposedPayout))
            ctx.addIssue({ code: "custom", path: ["payout"], message: "Elige cómo se lo devuelves." })
        }),
    [lineOf, currency, locale, proposedPayout],
  )

  const mutation = useMutation({
    mutationFn: (body: ReturnBody) => createTicketReturnApi(patientId, ticketId, body),
    onSuccess: (result) => {
      setDone(result.data.paymentReturn)
      onReturned()
    },
  })

  const form = useAppForm({
    defaultValues: EMPTY,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      if (done) return
      const rows: number[] = []
      const body: ReturnLineBody[] = []
      value.lines.forEach((draft, index) => {
        const line = lineOf.get(draft.chargeId)
        if (!line) return
        const cents = centsOf(line, draft) ?? 0
        if (cents <= 0) return
        rows.push(index)
        const sold = line.quantity ?? 1
        body.push(
          line.kind === "producto"
            ? { chargeId: line.chargeId, quantity: Math.min(draft.quantity, sold), backToStock: draft.backToStock }
            : { chargeId: line.chargeId, amountCents: cents },
        )
      })
      sentRows.current = rows
      const payout = value.payout ?? proposedPayout
      await mutation.mutateAsync({
        branchId,
        lines: body,
        paymentMethodId: payout === LEAVE_AS_CREDIT ? null : payout,
        reason: value.reason.trim(),
        requestId,
      })
    },
  })
  const values = useStore(form.store, (state) => state.values)

  // El servidor nombra cada línea por su lugar en el cuerpo (`lines[1].amountCents`):
  // va a la fila de la pantalla de donde salió, y el medio, al grupo del medio.
  const surface = useFormSurface(form, {
    formMessage: financeFormMessage,
    fieldMap: (key) => {
      if (key === "paymentMethodId") return "payout"
      const match = /^lines\[(\d+)\]\./.exec(key)
      if (!match) return undefined
      const row = sentRows.current[Number(match[1])]
      const draft = row === undefined ? undefined : form.state.values.lines[row]
      if (row === undefined || !draft) return undefined
      return `lines[${row}].${lineOf.get(draft.chargeId)?.kind === "producto" ? "quantity" : "amount"}`
    },
  })

  // Las líneas llegan con la consulta: el borrador se arma una vez por apertura.
  const seeded = useRef(false)
  useEffect(() => {
    if (!open || !data || seeded.current) return
    seeded.current = true
    form.reset({
      lines: data.lines
        .filter((line) => !line.blockedReason)
        .map((line) => ({ chargeId: line.chargeId, quantity: 0, backToStock: true, amount: "" })),
      payout: null,
      reason: "",
    })
  }, [open, data, form])

  const rowOf = new Map(values.lines.map((draft, index) => [draft.chargeId, index]))
  const chosenPayout = values.payout ?? proposedPayout
  const chosenMethod = methodList.find((method) => method.id === chosenPayout) ?? null

  // Lo que se devuelve, línea por línea, con el mismo redondeo que el servidor.
  const chosen = values.lines.flatMap((draft) => {
    const line = lineOf.get(draft.chargeId)
    const cents = line ? (centsOf(line, draft) ?? 0) : 0
    return line && cents > 0 ? [{ line, draft, cents }] : []
  })
  const total = chosen.reduce((sum, item) => sum + item.cents, 0)
  const productWords = (back: boolean) =>
    chosen
      .filter((item) => item.line.kind === "producto" && item.draft.backToStock === back)
      .map((item) => `${item.draft.quantity} ${item.line.productName ?? item.line.description}`)
  const backWords = productWords(true)
  const wasteWords = productWords(false)

  const close = () => {
    if (surface.isSubmitting) return
    form.reset(EMPTY)
    seeded.current = false
    sentRows.current = []
    setDone(null)
    setPrintError(null)
    setRequestId(crypto.randomUUID())
    onClose()
  }

  const numberLabel = done ? String(done.returnNumber).padStart(6, "0") : ""

  return (
    <FormDrawer
      {...surface}
      isDirty={surface.isDirty && done === null}
      dock={false}
      open={open}
      title={done ? `Devolución N.º ${numberLabel}` : "Devolver"}
      headerContent={
        done ? undefined : (
          <div className="flex min-w-0 flex-col">
            <p className="font-heading text-lg font-semibold">Ticket {ticketNumber}</p>
            <p className="break-words text-sm text-muted-foreground">{patientName}</p>
          </div>
        )
      }
      isLoading={returnable.isPending || methods.isPending}
      hideSubmit={done !== null}
      submitLabel={total > 0 ? `Devolver ${money(total)}` : "Devolver"}
      cancelLabel={done ? "Listo" : "Cancelar"}
      onClose={close}
    >
      {done ? (
        <div className="flex flex-col gap-4">
          <div role="status" className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
              <Check className="size-5" aria-hidden />
            </span>
            <div className="flex min-w-0 flex-col">
              <p className="font-heading text-base font-semibold">Devolución registrada</p>
              <p className="break-words text-sm text-muted-foreground">
                {done.outcome === "pagado"
                  ? `Se devolvieron ${money(done.totalCents)} por ${done.methodName}.`
                  : `Quedan ${money(done.totalCents)} a favor de ${patientName}.`}
              </p>
            </div>
          </div>
          <article aria-label={`Devolución ${numberLabel}`} className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm">
            <p className="text-center font-heading text-base font-semibold">DEVOLUCIÓN N.º {numberLabel}</p>
            <p className="text-center text-muted-foreground">Del ticket N.º {ticketNumber}</p>
            <ul className="flex flex-col gap-1.5 border-y py-2">
              {done.snapshot.lines.map((line) => (
                <li key={line.chargeId} className="flex flex-col">
                  <span className="flex justify-between gap-3">
                    <span className="min-w-0 break-words">{line.description}</span>
                    <span className="shrink-0 tabular-nums">{money(line.amountCents)}</span>
                  </span>
                  {line.kind === "producto" && line.backToStock === false ? (
                    <span className="text-xs text-muted-foreground">No volvió a la venta</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="flex justify-between gap-3 font-semibold">
              <span>TOTAL DEVUELTO</span>
              <span className="tabular-nums">{money(done.totalCents)}</span>
            </p>
            <p className="text-muted-foreground">Motivo: {done.snapshot.reason}</p>
          </article>
          <SubmitButton
            className="min-h-11 w-full"
            pending={printing}
            onClick={() => {
              setPrinting(true)
              setPrintError(null)
              void openServerPdf(returnPdfPath(patientId, done.id))
                .catch((err: unknown) => setPrintError(financeErrorMessage(err)))
                .finally(() => setPrinting(false))
            }}
          >
            <Printer aria-hidden />
            Imprimir
          </SubmitButton>
          {printError ? (
            <p role="alert" className="text-sm text-destructive">
              {printError}
            </p>
          ) : null}
          <SendFinancialDocument
            patientId={patientId}
            documentType="return"
            documentId={done.id}
            trigger={
              <Button type="button" variant="outline" className="min-h-10 w-full">
                Enviar al paciente
              </Button>
            }
          />
        </div>
      ) : returnable.isError ? (
        <ErrorState
          title="No se pudo consultar el ticket"
          message={financeErrorMessage(returnable.error)}
          onRetry={() => void returnable.refetch()}
        />
      ) : (
        <div className="flex flex-col gap-5">
          <form.AppField name="lines" mode="array">
            {(linesField) => (
              <linesField.Group legend="Qué devuelve" className="flex flex-col gap-3">
                {() => (
                  <>
                    {lines.length === 0 ? (
                      <p className="text-sm text-muted-foreground">De este ticket ya no queda nada por devolver.</p>
                    ) : null}
                    {lines.map((line) => {
                      if (line.blockedReason) {
                        return (
                          <div key={line.chargeId} className="flex flex-col gap-1 rounded-xl border px-3.5 py-3 text-sm">
                            <span className="font-medium">{line.description}</span>
                            <span className="text-muted-foreground">{line.blockedReason}</span>
                          </div>
                        )
                      }
                      const row = rowOf.get(line.chargeId)
                      if (row === undefined) return null
                      if (line.kind === "producto") {
                        const sold = line.quantity ?? 1
                        const name = line.productName ?? line.description
                        return (
                          <form.AppField key={line.chargeId} name={`lines[${row}].quantity`}>
                            {(field) => (
                              <field.Group
                                legend={name}
                                description={`${byCount(sold, "Se vendió", "Se vendieron")} ${sold} · ${money(line.amountCents)}`}
                                className="flex flex-col gap-3 rounded-xl border px-3.5 py-3"
                              >
                                {(control) => (
                                  <>
                                    <QuantityStepper
                                      name={name}
                                      value={field.state.value}
                                      max={sold}
                                      invalid={control.invalid}
                                      aria-describedby={control.describedBy}
                                      onBlur={control.onBlur}
                                      onChange={(quantity) => field.handleChange(quantity)}
                                    />
                                    {field.state.value > 0 ? (
                                      <form.Field name={`lines[${row}].backToStock`}>
                                        {(stock) => (
                                          <div className="flex flex-col gap-1.5">
                                            <span className="text-sm font-medium">¿Vuelve a {branchName}?</span>
                                            <ChoiceButtons
                                              aria-label={`¿${name} vuelve a ${branchName}?`}
                                              columns={2}
                                              value={stock.state.value ? "si" : "no"}
                                              options={[
                                                { value: "si", label: "Sí, está en buen estado" },
                                                { value: "no", label: "No, no vuelve a la venta" },
                                              ]}
                                              onChange={(value) => stock.handleChange(value === "si")}
                                            />
                                          </div>
                                        )}
                                      </form.Field>
                                    ) : null}
                                  </>
                                )}
                              </field.Group>
                            )}
                          </form.AppField>
                        )
                      }
                      return (
                        <form.AppField key={line.chargeId} name={`lines[${row}].amount`}>
                          {(field) => (
                            <field.Control
                              label={line.description}
                              description={`Pagó ${money(line.paidCents)} en este ticket. Devolver por un reclamo no cambia su historia clínica.`}
                              className="rounded-xl border px-3.5 py-3"
                            >
                              {(control) => (
                                <MoneyInput
                                  id={control.id}
                                  invalid={control.invalid}
                                  aria-describedby={control.describedBy}
                                  onBlur={control.onBlur}
                                  currency={currency}
                                  locale={locale}
                                  value={field.state.value}
                                  onChange={(value) => field.handleChange(value)}
                                />
                              )}
                            </field.Control>
                          )}
                        </form.AppField>
                      )
                    })}
                  </>
                )}
              </linesField.Group>
            )}
          </form.AppField>

          <form.AppField name="payout">
            {(field) => (
              <field.Group legend="¿Cómo se lo devuelves?" className="flex flex-col gap-2">
                {(control) =>
                  methods.isError ? (
                    <ErrorState
                      title="No se pudieron consultar los medios de pago"
                      message={financeErrorMessage(methods.error)}
                      onRetry={() => void methods.refetch()}
                    />
                  ) : (
                    <ChoiceButtons
                      id={control.id}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      tone="primary"
                      columns={2}
                      value={chosenPayout}
                      options={[...methodOptions, { value: LEAVE_AS_CREDIT, label: "Dejarlo a favor" }]}
                      onChange={(value) => field.handleChange(value)}
                    />
                  )
                }
              </field.Group>
            )}
          </form.AppField>

          <form.AppField name="reason">
            {(field) => <field.TextareaField label="Motivo" rows={2} maxLength={MAX_REASON} />}
          </form.AppField>

          {total > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-semibold">Al devolver</p>
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
                <li>
                  Se emite una <strong className="font-semibold">devolución</strong> con su número. El ticket {ticketNumber}{" "}
                  sigue valiendo.
                </li>
                {backWords.length > 0 ? (
                  <li>
                    <strong className="font-semibold">
                      {byCount(backWords.length, "Vuelve", "Vuelven")} a {branchName}: {backWords.join(" y ")}.
                    </strong>
                  </li>
                ) : null}
                {wasteWords.length > 0 ? <li>No vuelve a la venta: {wasteWords.join(" y ")}.</li> : null}
                <li>
                  {chosenPayout === LEAVE_AS_CREDIT
                    ? `Quedan ${money(total)} a favor de ${patientName}: se usan en su próximo cobro.`
                    : chosenMethod?.typeCode === CASH_TYPE_CODE
                      ? `Salen ${money(total)} del efectivo de la caja de ${branchName}.`
                      : chosenMethod
                        ? `Se devuelven ${money(total)} por ${chosenMethod.name}; no salen del efectivo.`
                        : `Se devuelven ${money(total)}.`}
                </li>
              </ul>
              {chosenMethod?.typeCode === CARD_TYPE_CODE && chosenPayout !== LEAVE_AS_CREDIT ? (
                <p role="note" className="flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2 text-sm">
                  <CreditCard className="mt-0.5 size-4 shrink-0" aria-hidden />
                  Haz también la devolución en el terminal de la tarjeta.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </FormDrawer>
  )
}

/** Cuántas unidades devuelve, con botones de 44 px y el número a la vista. */
function QuantityStepper({
  name,
  value,
  max,
  invalid = false,
  "aria-describedby": describedBy,
  onBlur,
  onChange,
}: {
  name: string
  value: number
  max: number
  invalid?: boolean
  "aria-describedby"?: string
  onBlur?: () => void
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <fieldset
      className="m-0 flex items-center gap-1 border-0 p-0"
      onBlur={
        onBlur
          ? (event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) onBlur()
            }
          : undefined
      }
    >
      <legend className="sr-only">Cuántos {name} devuelve</legend>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-11"
        aria-label={`Uno menos de ${name}`}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={value <= 0}
        onClick={() => onChange(Math.max(0, value - 1))}
      >
        <Minus aria-hidden />
      </Button>
      <span className="min-w-20 text-center text-sm tabular-nums" aria-live="polite">
        Devuelve {value} de {max}
      </span>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-11"
        aria-label={`Uno más de ${name}`}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <Plus aria-hidden />
      </Button>
    </fieldset>
  )
}
