/**
 * Ticket de cobro en pantalla. Se arma solo con lo que el ticket congeló al
 * cobrar (`payment_ticket.snapshot`) y sus importes: clínica, sede, paciente,
 * quién pagó, quién cobró, conceptos, medios y frase al pie. Es el mismo
 * contenido que el PDF del servidor, que es lo que se imprime y se envía.
 *
 * Desde aquí se imprime, se envía al paciente y se anula el cobro (con motivo).
 * Dinero con `@odentia/clinical`; fecha y formato en la zona de la clínica.
 */
import { formatMoney } from "@odentia/clinical"
import { Badge, Button, buttonVariants, cn, Field, FieldLabel, Skeleton, Textarea } from "@odentia/ui"
import { FormDrawer, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Check, Printer } from "lucide-react"
import { useId, useState, type ReactNode } from "react"
import { SendFinancialDocument } from "../finance-documents/SendFinancialDocument"
import { apiFetchBytes } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { financeErrorMessage } from "../../lib/finance"
import {
  CASH_TYPE_CODE,
  dayInTimezone,
  fetchPatientAccount3,
  formatAmountPlain,
  formatDayLongLocale,
  formatTimeShortLocale,
  voidTicketApi,
  type CollectTicketRow,
} from "../../lib/finance-collect"

export function ticketDisplayNumber(number: number): string {
  return String(number).padStart(6, "0")
}

/** PDF del servidor para un ticket: sin `paper` sale en la térmica configurada. */
export function ticketPdfPath(patientId: string, ticketId: string): string {
  const params = new URLSearchParams({ documentType: "ticket", documentId: ticketId })
  return `/api/patients/${patientId}/financial-document-pdf?${params}`
}

/**
 * Abre un PDF del servidor en otra pestaña. La pestaña se abre en el mismo
 * clic (así el navegador no la bloquea) y recibe el documento cuando llega.
 */
export async function openServerPdf(path: string): Promise<void> {
  const tab = window.open("", "_blank")
  if (tab) tab.opener = null
  try {
    const bytes = await apiFetchBytes(path)
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
    if (tab && !tab.closed) tab.location.href = url
    else window.open(url, "_blank", "noopener")
    // El visor ya cargó el documento: se libera la memoria más tarde.
    window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000)
  } catch (err) {
    if (tab && !tab.closed) tab.close()
    throw err
  }
}

/** Imprime un bloque de la pantalla (constancias que no tienen PDF del servidor). */
export function printNodeById(nodeId: string): void {
  const node = document.getElementById(nodeId)
  if (!node) return
  const width = node.dataset.printWidth ?? "80mm"
  const full = node.dataset.printFull === "1"
  const style = document.createElement("style")
  style.textContent = `@media print {
    body * { visibility: hidden; }
    #${nodeId}, #${nodeId} * { visibility: visible; }
    #${nodeId} { position: absolute; inset: 0 ${full ? "0" : "auto"} auto 0; width: ${full ? "auto" : width}; }
  }`
  document.head.append(style)
  const cleanup = () => {
    style.remove()
    window.removeEventListener("afterprint", cleanup)
  }
  window.addEventListener("afterprint", cleanup)
  window.print()
}

function Row({
  label,
  value,
  strong,
  muted,
}: {
  label: ReactNode
  value: string
  strong?: boolean
  muted?: boolean
}): React.JSX.Element {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 ${strong ? "text-base font-semibold" : ""} ${muted ? "text-muted-foreground" : ""}`}
    >
      <span className="min-w-0 break-words">{label}</span>
      <span className="shrink-0 tabular-nums">{value}</span>
    </div>
  )
}

export function TicketView({
  ticket,
  remainingCents,
  patientName,
  branchName,
  orgName,
  orgAddress,
  locale,
  timeZone,
  ticketFooter,
  sendTrigger,
  onSent,
  onChanged,
  onDone,
  mode = "collected",
  inAccount = false,
  closedAfter = false,
}: {
  ticket: CollectTicketRow
  /** Lo que quedó por cobrar de esos conceptos (respaldo si el ticket no lo congeló). */
  remainingCents: number
  patientName: string
  branchName: string
  orgName?: string
  orgAddress?: string
  locale: string
  timeZone?: string
  /** Ya no se usa: el papel lo decide el PDF del servidor con la impresora configurada. */
  receiptWidth?: "58" | "80"
  ticketFooter?: string | null
  sendTrigger?: ReactNode
  onSent?: (info: { conversationId: string; messageId: string }) => void
  onChanged: () => void
  /** Cierra el panel: con él se ofrece «Listo». */
  onDone?: () => void
  /** `collected`: recién cobrado, dice cómo quedó la deuda. `review`: ticket consultado después. */
  mode?: "collected" | "review"
  /** Ya se está en la cuenta de esta persona: no se ofrece abrirla. */
  inAccount?: boolean
  /** La caja de su sede ya cerró después de este cobro: solo administración lo anula. */
  closedAfter?: boolean
}): React.JSX.Element {
  const uid = useId()
  const canWrite = usePermission("finance.write")
  const canAdmin = usePermission("finance.admin")
  const [voidOpen, setVoidOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [printing, setPrinting] = useState(false)
  const [printError, setPrintError] = useState<string | null>(null)
  // Anulación hecha en esta pantalla: se guarda con el ticket al que pertenece.
  const [voidedHere, setVoidedHere] = useState<{
    ticketId: string
    reason: string
    reopenedCents: number
  } | null>(null)

  const snapshot = ticket.snapshot
  const currency = ticket.currency
  // Formato y zona con que se emitió; los de hoy solo si el ticket no los congeló.
  const format = snapshot.clinic?.locale || locale
  const zone = snapshot.clinic?.timezone || timeZone
  const money = (cents: number) => formatMoney(cents, currency, format)
  /** Cifras del cuerpo del ticket: sin símbolo, como en el papel; el total sí lo lleva. */
  const plain = (cents: number) => formatAmountPlain(cents, currency, format)

  const justVoided = voidedHere?.ticketId === ticket.id ? voidedHere : null
  const voided = ticket.voidedAt !== null || justVoided !== null
  const voidReason = justVoided?.reason ?? ticket.voidReason
  const canVoid = canWrite && (!closedAfter || canAdmin)
  const number = ticketDisplayNumber(ticket.ticketNumber)

  const person = snapshot.patient?.displayName || patientName
  const document = snapshot.patient?.docNumber
    ? `${snapshot.patient.docType ? `${snapshot.patient.docType} ` : ""}${snapshot.patient.docNumber}`
    : null
  const payerName = snapshot.payer?.displayName || null
  const clinicName = snapshot.clinic?.tradeName || snapshot.clinic?.legalName || orgName || ""
  const sedeName = snapshot.branch?.name || branchName
  const address = snapshot.clinic?.fiscalAddress || orgAddress || ""
  const lines = snapshot.lines ?? []
  const conceptLines = lines.filter((line) => line.chargeId !== null)
  const advance = lines.find((line) => line.chargeId === null) ?? null
  const methods = snapshot.methods ?? []
  const appliedToConcepts = conceptLines.reduce(
    (sum, line) => sum + (line.appliedCents ?? line.amountCents),
    0,
  )
  const stillOwed = snapshot.remainingCents ?? remainingCents

  const issuedAt = new Date(ticket.createdAt)
  const issuedDate = Number.isNaN(issuedAt.getTime())
    ? "—"
    : issuedAt.toLocaleDateString(format, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        ...(zone ? { timeZone: zone } : {}),
      })
  const issuedTime = formatTimeShortLocale(ticket.createdAt, format, zone)
  const issuedToday =
    !Number.isNaN(issuedAt.getTime()) &&
    (zone
      ? dayInTimezone(zone, issuedAt) === dayInTimezone(zone)
      : issuedAt.toDateString() === new Date().toDateString())

  // Cuánto debe la persona después del cobro: la cuenta, no solo estos conceptos.
  const account = useQuery({
    queryKey: ["patient-account3", ticket.patientId],
    queryFn: () => fetchPatientAccount3(ticket.patientId),
    enabled: mode === "collected" && !voided,
    staleTime: 30_000,
  })
  const owed = account.data
    ? (account.data.data.byCurrency.find((row) => row.currency === currency)?.porCobrar ?? 0)
    : null

  const voidMutation = useMutation({
    mutationFn: () => voidTicketApi(ticket.patientId, ticket.id, reason.trim()),
    onSuccess: (result) => {
      setVoidedHere({
        ticketId: ticket.id,
        reason: reason.trim(),
        reopenedCents: result.data.reopenedCents ?? 0,
      })
      setVoidOpen(false)
      setReason("")
      setError(null)
      onChanged()
    },
    // El servidor decide: tras un cierre responde que solo administración anula.
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const print = async () => {
    if (printing) return
    setPrinting(true)
    setPrintError(null)
    try {
      await openServerPdf(ticketPdfPath(ticket.patientId, ticket.id))
    } catch (err) {
      setPrintError(financeErrorMessage(err))
    } finally {
      setPrinting(false)
    }
  }

  const paidWith =
    methods.length > 0
      ? methods
          .map((method) =>
            method.typeCode === CASH_TYPE_CODE
              ? `${money(method.amountCents)} en efectivo`
              : `${money(method.amountCents)} por ${method.name}`,
          )
          .join(" + ")
      : `${money(ticket.creditAppliedCents)} de su saldo a favor`
  const when = issuedToday
    ? `hoy a las ${issuedTime}`
    : `el ${formatDayLongLocale(ticket.createdAt, format, zone)} a las ${issuedTime}`

  return (
    <div className="flex flex-col gap-4">
      {voided ? (
        <div role="status" className="flex flex-col gap-1 rounded-xl border border-destructive/40 bg-danger-soft px-3 py-2 text-sm">
          <p className="font-semibold text-destructive">Cobro anulado</p>
          <p>El ticket queda marcado y no se borra.</p>
          {justVoided && justVoided.reopenedCents > 0 ? (
            <p>
              Era un adelanto que ya se había usado para pagar otro concepto:{" "}
              <strong className="font-semibold">{money(justVoided.reopenedCents)}</strong> vuelven a
              quedar por cobrar.
            </p>
          ) : null}
        </div>
      ) : mode === "collected" ? (
        <div role="status" className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
            <Check className="size-5" aria-hidden />
          </span>
          <div className="flex min-w-0 flex-col">
            <p className="font-heading text-base font-semibold">Cobro registrado</p>
            {owed === null ? (
              account.isError ? null : (
                <Skeleton className="mt-1 h-4 w-40" />
              )
            ) : (
              <p className="break-words text-sm text-muted-foreground">
                {owed > 0 ? `${person} todavía debe ${money(owed)}.` : `${person} ya no debe nada.`}
              </p>
            )}
          </div>
        </div>
      ) : null}

      <article
        aria-label={`Ticket ${number}${voided ? ", anulado" : ""}`}
        className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-sm"
      >
        <div className="flex flex-col items-center text-center">
          {clinicName ? <p className="font-semibold">{clinicName}</p> : null}
          {sedeName ? <p className="text-muted-foreground">{sedeName}</p> : null}
          {address ? <p className="text-muted-foreground">{address}</p> : null}
        </div>
        <div className="flex flex-col items-center text-center">
          <p className="font-heading text-base font-semibold">TICKET N.º {number}</p>
          <p className="text-muted-foreground">
            {issuedDate} · {issuedTime}
          </p>
        </div>
        {voided ? (
          <p className="rounded-md border border-destructive/40 px-3 py-1.5 text-center font-semibold text-destructive">
            ANULADO{voidReason ? ` · Motivo: ${voidReason}` : ""}
          </p>
        ) : null}
        <div className="flex flex-col gap-0.5">
          <p className="break-words">Paciente: {person}</p>
          {document ? <p className="text-muted-foreground">{document}</p> : null}
          {payerName && payerName !== person ? <p className="break-words">Pagó: {payerName}</p> : null}
          {snapshot.issuer?.name ? (
            <p className="break-words text-muted-foreground">Caja: {snapshot.issuer.name}</p>
          ) : null}
        </div>
        <ul className="flex flex-col gap-1.5 border-y py-2">
          {conceptLines.map((line, index) => {
            const paid = line.appliedCents ?? line.amountCents
            return (
              <li key={`${line.chargeId ?? "concepto"}-${index}`} className="flex flex-col">
                <Row label={line.description} value={plain(paid)} />
                {paid < line.amountCents ? (
                  <span className="text-xs text-muted-foreground">
                    A cuenta de {plain(line.amountCents)}
                  </span>
                ) : null}
                {line.promotion ? (
                  <span className="text-xs text-muted-foreground">Promoción: {line.promotion}</span>
                ) : null}
              </li>
            )
          })}
          {advance ? (
            <li>
              <Row label="Adelanto (queda como saldo a favor)" value={plain(advance.amountCents)} />
            </li>
          ) : null}
        </ul>
        <Row label="TOTAL" value={money(ticket.totalCents)} strong />
        <div className="flex flex-col gap-1">
          {methods.map((method, index) => (
            <div key={`${method.paymentMethodId}-${index}`} className="flex flex-col">
              <Row label={method.name} value={plain(method.amountCents)} />
              {method.reference ? (
                <span className="text-xs text-muted-foreground">Operación {method.reference}</span>
              ) : null}
            </div>
          ))}
          {ticket.creditAppliedCents > 0 ? (
            <Row label="Saldo a favor usado" value={plain(ticket.creditAppliedCents)} />
          ) : null}
          {ticket.cashReceivedCents != null ? (
            <Row label="Recibido" value={plain(ticket.cashReceivedCents)} />
          ) : null}
          {ticket.changeCents != null && ticket.changeCents > 0 ? (
            <Row label="Vuelto" value={plain(ticket.changeCents)} />
          ) : null}
          {conceptLines.length > 0 ? <Row label="Saldo por cobrar" value={plain(stillOwed)} /> : null}
        </div>
        {snapshot.notice || ticketFooter ? (
          <p className="text-center text-xs text-muted-foreground">
            {snapshot.notice || ticketFooter}
          </p>
        ) : null}
      </article>

      <div className="flex flex-col gap-2">
        <SubmitButton className="min-h-11 w-full" pending={printing} onClick={() => void print()}>
          <Printer aria-hidden />
          Imprimir
        </SubmitButton>
        {printError ? (
          <p role="alert" className="text-sm text-destructive">
            No se pudo abrir el ticket para imprimir. {printError}
          </p>
        ) : null}
        {canWrite || onDone ? (
          <div className="flex flex-wrap gap-2">
            {canWrite ? (
              <SendFinancialDocument
                className="min-w-0 flex-1"
                patientId={ticket.patientId}
                documentType="ticket"
                documentId={ticket.id}
                trigger={
                  sendTrigger ?? (
                    <Button type="button" variant="outline" className="min-h-10 w-full">
                      Enviar al paciente
                    </Button>
                  )
                }
                onSent={onSent}
              />
            ) : null}
            {onDone ? (
              <Button type="button" variant="outline" className="min-h-10 min-w-0 flex-1" onClick={onDone}>
                Listo
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {!voided && canWrite && !canVoid ? (
        <p role="note" className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
          La caja ya se cerró después de este cobro: solo administración puede anularlo.
        </p>
      ) : null}

      {!inAccount || (!voided && canVoid) ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          {!inAccount ? (
            <Link
              to="/patients/$patientId"
              params={{ patientId: ticket.patientId }}
              search={{ tab: "cuenta" }}
              className={cn(buttonVariants({ variant: "link" }), "h-auto min-w-0 whitespace-normal px-0 text-left")}
            >
              Abrir la cuenta de {person}
            </Link>
          ) : (
            <span />
          )}
          {!voided && canVoid ? (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                setReason("")
                setError(null)
                setVoidOpen(true)
              }}
            >
              Anular este cobro
            </Button>
          ) : null}
        </div>
      ) : null}

      <FormDrawer
        dock={false}
        open={voidOpen}
        title="Anular cobro"
        headerContent={
          <div className="flex min-w-0 flex-col">
            <p className="font-heading text-lg font-semibold">Ticket {number}</p>
            <p className="break-words text-sm text-muted-foreground">
              {person} · {paidWith} · {when}
            </p>
          </div>
        }
        error={error}
        isSubmitting={voidMutation.isPending}
        submitLabel="Anular cobro"
        cancelLabel="No anular"
        onClose={() => {
          if (!voidMutation.isPending) {
            setVoidOpen(false)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!reason.trim()) {
            setError("Escribe el motivo de la anulación.")
            return
          }
          voidMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold">Al anularlo</p>
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
              <li>
                El ticket queda marcado como <strong className="font-semibold">anulado</strong>. No se
                borra.
              </li>
              {appliedToConcepts > 0 ? (
                <li>
                  {person} vuelve a deber{" "}
                  <strong className="font-semibold">{money(appliedToConcepts)}</strong>.
                </li>
              ) : null}
              {advance ? (
                <li>
                  Pierde el adelanto de{" "}
                  <strong className="font-semibold">{money(advance.amountCents)}</strong>. Si ya se
                  usó para pagar algo, eso vuelve a quedar por cobrar.
                </li>
              ) : null}
              {methods.map((method, index) => (
                <li key={`${method.paymentMethodId}-${index}`}>
                  {method.typeCode === CASH_TYPE_CODE ? (
                    <>
                      Salen <strong className="font-semibold">{money(method.amountCents)}</strong>{" "}
                      del efectivo de la caja.
                    </>
                  ) : (
                    <>
                      <strong className="font-semibold">{money(method.amountCents)}</strong> se
                      devuelven por {method.name}; no salen del efectivo.
                    </>
                  )}
                </li>
              ))}
              {ticket.creditAppliedCents > 0 ? (
                <li>
                  Recupera{" "}
                  <strong className="font-semibold">{money(ticket.creditAppliedCents)}</strong> de
                  saldo a favor.
                </li>
              ) : null}
              {methods.length === 0 ? <li>No sale dinero de la caja.</li> : null}
            </ul>
          </div>
          <Field>
            <FieldLabel htmlFor={`${uid}-motivo`}>Motivo</FieldLabel>
            <Textarea
              id={`${uid}-motivo`}
              rows={3}
              maxLength={2000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <p role="note" className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
            {closedAfter
              ? "La caja ya se cerró después de este cobro. Lo anulas como administración: ese cierre no cambia."
              : "Puedes anularlo porque la caja no se ha cerrado desde este cobro. Después de un cierre, solo administración."}
          </p>
        </div>
      </FormDrawer>
    </div>
  )
}

export function TicketStatusBadge({ voidedAt }: { voidedAt: string | null }): React.JSX.Element {
  return <Badge>{voidedAt ? "Anulado" : "Vigente"}</Badge>
}
