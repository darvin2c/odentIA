/**
 * «Devolver» desde un ticket (ADR 0068): el paciente devuelve algo o pide su
 * dinero otro día. La venta del ticket queda en pie y la devolución la rebaja:
 * de cada producto se elige cuántos y si vuelve a la sede; de un servicio, el
 * importe que se le devuelve. Al final, cómo se le devuelve el dinero o si
 * queda a favor. Al terminar, la devolución se imprime y se envía como el ticket.
 */
import { formatMoney } from "@odentia/clinical"
import { Button, Field, FieldDescription, FieldLabel, Textarea } from "@odentia/ui"
import { ErrorState, FormDrawer, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Check, CreditCard, Minus, Plus, Printer } from "lucide-react"
import { useId, useMemo, useState } from "react"
import { SendFinancialDocument } from "../finance-documents/SendFinancialDocument"
import { ChoiceButtons } from "../choice-buttons"
import { financeErrorMessage } from "../../lib/finance"
import {
  CASH_TYPE_CODE,
  createTicketReturnApi,
  fetchPaymentMethods,
  fetchTicketReturnable,
  returnPdfPath,
  type PaymentReturnRow,
  type ReturnableLine,
} from "../../lib/finance-collect"
import { byCount } from "../../lib/inventory"
import { MoneyInput, parseMoneyOrNull } from "./collect-drawer"
import { openServerPdf } from "./ticket-view"

/** Tarjeta (UN/CEFACT 4461): la devolución también se hace en su terminal. */
const CARD_TYPE_CODE = "48"
const LEAVE_AS_CREDIT = "__a_favor__"
const MAX_REASON = 2000

interface LineChoice {
  /** Producto: unidades que devuelve. */
  quantity: number
  /** Producto: vuelve a la sede. */
  backToStock: boolean
  /** Servicio: importe escrito. */
  amountText: string
}

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
  const uid = useId()
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

  const [choices, setChoices] = useState<Record<string, LineChoice>>({})
  const [payout, setPayout] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [done, setDone] = useState<PaymentReturnRow | null>(null)
  const [printing, setPrinting] = useState(false)

  const choiceOf = (line: ReturnableLine): LineChoice =>
    choices[line.chargeId] ?? { quantity: 0, backToStock: true, amountText: "" }
  const setChoice = (line: ReturnableLine, patch: Partial<LineChoice>) => {
    setError(null)
    setChoices((current) => ({ ...current, [line.chargeId]: { ...choiceOf(line), ...patch } }))
  }

  // El medio con que pagó va primero y es el que se propone.
  const paidWith = data?.methods[0]?.paymentMethodId ?? null
  const methodOptions = useMemo(() => {
    const sorted = [...methodList].sort((a, b) => Number(b.id === paidWith) - Number(a.id === paidWith))
    return sorted.map((method) => ({
      value: method.id,
      label: method.id === paidWith ? `${method.name} (como pagó)` : method.name,
    }))
  }, [methodList, paidWith])
  const chosenPayout = payout ?? (methodList.some((method) => method.id === paidWith) ? paidWith : (methodList[0]?.id ?? null))
  const chosenMethod = methodList.find((method) => method.id === chosenPayout) ?? null

  // Lo que se devuelve, línea por línea, con el mismo redondeo que el servidor.
  const picked = lines
    .filter((line) => !line.blockedReason)
    .map((line) => {
      const choice = choiceOf(line)
      if (line.kind === "producto") {
        const sold = line.quantity ?? 1
        const quantity = Math.min(Math.max(choice.quantity, 0), sold)
        const cents = quantity === 0 ? 0 : quantity === sold ? line.amountCents : Math.round((line.amountCents * quantity) / sold)
        return { line, quantity, cents, backToStock: choice.backToStock, invalid: false }
      }
      const raw = choice.amountText.trim()
      const cents = raw ? parseMoneyOrNull(raw, currency, locale) : 0
      const invalid = cents === null || cents < 0 || cents > line.paidCents
      return { line, quantity: null, cents: invalid ? 0 : (cents ?? 0), backToStock: null, invalid }
    })
  const chosen = picked.filter((item) => item.cents > 0)
  const total = chosen.reduce((sum, item) => sum + item.cents, 0)
  const backWords = chosen
    .filter((item) => item.line.kind === "producto" && item.backToStock)
    .map((item) => `${item.quantity} ${item.line.productName ?? item.line.description}`)
  const wasteWords = chosen
    .filter((item) => item.line.kind === "producto" && !item.backToStock)
    .map((item) => `${item.quantity} ${item.line.productName ?? item.line.description}`)

  const reset = () => {
    setChoices({})
    setPayout(null)
    setReason("")
    setError(null)
    setDone(null)
    setRequestId(crypto.randomUUID())
  }

  const mutation = useMutation({
    mutationFn: () =>
      createTicketReturnApi(patientId, ticketId, {
        branchId,
        lines: chosen.map((item) =>
          item.line.kind === "producto"
            ? { chargeId: item.line.chargeId, quantity: item.quantity ?? 0, backToStock: item.backToStock ?? true }
            : { chargeId: item.line.chargeId, amountCents: item.cents },
        ),
        paymentMethodId: chosenPayout === LEAVE_AS_CREDIT ? null : chosenPayout,
        reason: reason.trim(),
        requestId,
      }),
    onSuccess: (result) => {
      setDone(result.data.paymentReturn)
      setError(null)
      onReturned()
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const close = () => {
    if (mutation.isPending) return
    reset()
    onClose()
  }

  const numberLabel = done ? String(done.returnNumber).padStart(6, "0") : ""

  return (
    <FormDrawer
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
      error={error}
      isSubmitting={mutation.isPending}
      isLoading={returnable.isPending || methods.isPending}
      hideSubmit={done !== null}
      submitLabel={total > 0 ? `Devolver ${money(total)}` : "Devolver"}
      cancelLabel={done ? "Listo" : "Cancelar"}
      onClose={close}
      onSubmit={(event) => {
        event.preventDefault()
        if (done || mutation.isPending) return
        if (picked.some((item) => item.invalid)) {
          setError("Revisa el importe: no puede ser más de lo que pagó en este ticket.")
          return
        }
        if (total <= 0) {
          setError("Elige qué devuelve: un producto o un importe de un servicio.")
          return
        }
        if (!chosenPayout) {
          setError("Elige cómo se lo devuelves.")
          return
        }
        if (!reason.trim()) {
          setError("Escribe el motivo de la devolución.")
          return
        }
        mutation.mutate()
      }}
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
              void openServerPdf(returnPdfPath(patientId, done.id))
                .catch((err: unknown) => setError(financeErrorMessage(err)))
                .finally(() => setPrinting(false))
            }}
          >
            <Printer aria-hidden />
            Imprimir
          </SubmitButton>
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
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-semibold">Qué devuelve</legend>
            {lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">De este ticket ya no queda nada por devolver.</p>
            ) : null}
            {lines.map((line) => {
              const choice = choiceOf(line)
              if (line.blockedReason) {
                return (
                  <div key={line.chargeId} className="flex flex-col gap-1 rounded-xl border px-3.5 py-3 text-sm">
                    <span className="font-medium">{line.description}</span>
                    <span className="text-muted-foreground">{line.blockedReason}</span>
                  </div>
                )
              }
              if (line.kind === "producto") {
                const sold = line.quantity ?? 1
                const name = line.productName ?? line.description
                return (
                  <div key={line.chargeId} className="flex flex-col gap-3 rounded-xl border px-3.5 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-col">
                        <span className="break-words text-sm font-medium">{name}</span>
                        <span className="text-sm text-muted-foreground">
                          {byCount(sold, "Se vendió", "Se vendieron")} {sold} · {money(line.amountCents)}
                        </span>
                      </div>
                      <QuantityStepper
                        name={name}
                        value={choice.quantity}
                        max={sold}
                        onChange={(quantity) => setChoice(line, { quantity })}
                      />
                    </div>
                    {choice.quantity > 0 ? (
                      <div className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">¿Vuelve a {branchName}?</span>
                        <ChoiceButtons
                          label={`¿${name} vuelve a ${branchName}?`}
                          columns={2}
                          value={choice.backToStock ? "si" : "no"}
                          options={[
                            { value: "si", label: "Sí, está en buen estado" },
                            { value: "no", label: "No, no vuelve a la venta" },
                          ]}
                          onChange={(value) => setChoice(line, { backToStock: value === "si" })}
                        />
                      </div>
                    ) : null}
                  </div>
                )
              }
              const id = `${uid}-${line.chargeId}`
              return (
                <Field key={line.chargeId} className="rounded-xl border px-3.5 py-3">
                  <FieldLabel htmlFor={id}>{line.description}</FieldLabel>
                  <MoneyInput
                    id={id}
                    currency={currency}
                    locale={locale}
                    value={choice.amountText}
                    onChange={(value) => setChoice(line, { amountText: value })}
                    aria-label={`Cuánto devuelve de ${line.description}`}
                  />
                  <FieldDescription>
                    Pagó {money(line.paidCents)} en este ticket. Devolver por un reclamo no cambia su historia clínica.
                  </FieldDescription>
                </Field>
              )
            })}
          </fieldset>

          <div className="flex flex-col gap-2">
            <span id={`${uid}-medio`} className="text-sm font-semibold">
              ¿Cómo se lo devuelves?
            </span>
            {methods.isError ? (
              <ErrorState
                title="No se pudieron consultar los medios de pago"
                message={financeErrorMessage(methods.error)}
                onRetry={() => void methods.refetch()}
              />
            ) : (
              <ChoiceButtons
                label="Cómo se lo devuelves"
                tone="primary"
                columns={2}
                value={chosenPayout}
                options={[...methodOptions, { value: LEAVE_AS_CREDIT, label: "Dejarlo a favor" }]}
                onChange={(value) => {
                  setError(null)
                  setPayout(value)
                }}
              />
            )}
          </div>

          <Field>
            <FieldLabel htmlFor={`${uid}-motivo`}>Motivo</FieldLabel>
            <Textarea
              id={`${uid}-motivo`}
              rows={2}
              maxLength={MAX_REASON}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>

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
  onChange,
}: {
  name: string
  value: number
  max: number
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <fieldset className="m-0 flex items-center gap-1 border-0 p-0">
      <legend className="sr-only">Cuántos {name} devuelve</legend>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-11"
        aria-label={`Uno menos de ${name}`}
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
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <Plus aria-hidden />
      </Button>
    </fieldset>
  )
}
