/**
 * Ticket de cobro en pantalla. Se arma solo con lo que el ticket congeló al
 * cobrar (`payment_ticket.snapshot`) y sus importes: clínica, sede, paciente,
 * quién pagó, quién cobró, conceptos, medios y frase al pie. Es el mismo
 * contenido que el PDF del servidor, que es lo que se imprime y se envía.
 *
 * Desde aquí se imprime, se envía al paciente, se devuelve (el paciente pide su
 * dinero o devuelve algo) y se anula el ticket (un error al cobrar), con motivo
 * (ADR 0068).
 * Dinero con `@odentia/clinical`; fecha y formato en la zona de la clínica.
 */
import { documentText, formatMoney, ticketFooterLines, ticketUntaxedNote } from "@odentia/clinical"
import { Badge, Button, buttonVariants, cn, Skeleton } from "@odentia/ui"
import { FormDrawer, SubmitButton, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Check, CreditCard, Printer } from "lucide-react"
import { useState, type ReactNode } from "react"
import { z } from "zod"
import { SendFinancialDocument } from "../finance-documents/SendFinancialDocument"
import { apiFetchBytes } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { useActiveBranch } from "../../lib/active-branch"
import { financeErrorMessage, financeFormMessage } from "../../lib/finance"
import {
  CASH_TYPE_CODE,
  dayInTimezone,
  fetchPatientAccount3,
  fetchTicketReturnable,
  formatAmountPlain,
  formatDayLongLocale,
  formatTimeShortLocale,
  returnPdfPath,
  voidTicketApi,
  type CollectReceipt,
  type CollectTicketRow,
} from "../../lib/finance-collect"
import { ReturnDrawer } from "./return-drawer"

/** Tarjeta (UN/CEFACT 4461): anular o devolver se hace también en su terminal. */
const CARD_TYPE_CODE = "48"
const MAX_VOID_REASON = 2000

const voidSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Escribe el motivo de la anulación.")
    .max(MAX_VOID_REASON, `Escribe el motivo en ${MAX_VOID_REASON} caracteres como mucho.`),
})

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
  onCollect,
  mode = "collected",
  inAccount = false,
  closedAfter = false,
  receipt = null,
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
  /** Abre «Cobrar» de esta persona: tras anular, se ofrece «Ir a Cobrar». */
  onCollect?: () => void
  /** `collected`: recién cobrado, dice cómo quedó la deuda. `review`: ticket consultado después. */
  mode?: "collected" | "review"
  /** Ya se está en la cuenta de esta persona: no se ofrece abrirla. */
  inAccount?: boolean
  /** La caja de su sede ya cerró después de este cobro: solo administración lo anula. */
  closedAfter?: boolean
  /** Recién cobrado: si el comprobante salió solo por correo o qué hacer (decisión 20 v2). */
  receipt?: CollectReceipt | null
}): React.JSX.Element {
  const canWrite = usePermission("finance.write")
  const canAdmin = usePermission("finance.admin")
  const [voidOpen, setVoidOpen] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [printError, setPrintError] = useState<string | null>(null)
  // Anulación hecha en esta pantalla: se guarda con el ticket al que pertenece.
  const [voidedHere, setVoidedHere] = useState<{
    ticketId: string
    reason: string
    reopenedCents: number
    returnedProducts: Array<{ description: string; quantity: number }>
  } | null>(null)
  const [returnOpen, setReturnOpen] = useState(false)
  const [returnPdfBusy, setReturnPdfBusy] = useState<string | null>(null)
  const sede = useActiveBranch()

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
  // Lo que hoy queda de este ticket: sus conceptos, sus medios y sus devoluciones.
  const returnable = useQuery({
    queryKey: ["ticket-returnable", ticket.patientId, ticket.id],
    queryFn: () => fetchTicketReturnable(ticket.patientId, ticket.id),
    staleTime: 15_000,
  })
  const returnsMade = returnable.data?.data.returns ?? []
  const hasReturns = returnsMade.length > 0
  const returnLines = returnable.data?.data.lines ?? []
  const canReturn = canWrite && !voided && returnLines.some((line) => !line.blockedReason)
  // Una devolución ya cambió la venta: el ticket deja de poder anularse.
  const canVoid = canWrite && (!closedAfter || canAdmin) && !hasReturns
  const number = ticketDisplayNumber(ticket.ticketNumber)

  const person = snapshot.patient?.displayName || patientName
  const document = snapshot.patient?.docNumber
    ? documentText(snapshot.patient.docType, snapshot.patient.docNumber)
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
  const untaxedNote = snapshot.taxes ? ticketUntaxedNote(snapshot.taxes) : null
  // Lo que deshace anular: los productos vuelven a la sede, los servicios quedan por cobrar.
  const productLines = returnLines.filter((line) => line.kind === "producto" && line.paidCents === line.amountCents)
  const serviceCents = returnLines
    .filter((line) => line.kind === "servicio")
    .reduce((sum, line) => sum + line.paidCents, 0)
  const paidByCard = methods.some((method) => method.typeCode === CARD_TYPE_CODE)
  const returnBranchId = sede.branchId ?? ticket.branchId
  const returnBranchName = sede.branches.find((item) => item.id === returnBranchId)?.name ?? sedeName

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
    ? (account.data.data.byCurrency.find((row) => row.currency === currency)?.saldo ?? 0)
    : null

  const voidMutation = useMutation({
    mutationFn: (reason: string) => voidTicketApi(ticket.patientId, ticket.id, reason),
    onSuccess: (result, reason) => {
      setVoidedHere({
        ticketId: ticket.id,
        reason,
        reopenedCents: result.data.reopenedCents ?? 0,
        returnedProducts: result.data.returnedProducts ?? [],
      })
      setVoidOpen(false)
      onChanged()
    },
  })
  // El motivo va en su campo; lo que decide el servidor (anulado, con
  // devoluciones, tras un cierre solo administración) se dice junto a los botones.
  const voidForm = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: voidSchema },
    onSubmit: async ({ value }) => {
      await voidMutation.mutateAsync(value.reason.trim())
    },
  })
  const voidSurface = useFormSurface(voidForm, { formMessage: financeFormMessage })

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
          <p className="font-semibold text-destructive">Ticket anulado</p>
          <p>El ticket queda marcado y no se borra.</p>
          {justVoided && justVoided.returnedProducts.length > 0 ? (
            <p>
              {justVoided.returnedProducts.length === 1 ? "Volvió" : "Volvieron"} a {sedeName}:{" "}
              {justVoided.returnedProducts.map((item) => item.description).join(" y ")}.
            </p>
          ) : null}
          {justVoided && paidByCard ? <p>Anula también la operación en el terminal de la tarjeta.</p> : null}
          {justVoided && onCollect ? (
            <Button type="button" variant="outline" className="mt-1 min-h-10 self-start" onClick={onCollect}>
              Ir a Cobrar
            </Button>
          ) : null}
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
            {receipt ? (
              <p className={cn("break-words text-sm", receipt.sent ? "text-muted-foreground" : "font-medium")}>
                {receipt.sent
                  ? `El comprobante salió por correo a ${receipt.email}. También queda en su enlace, en «Tus papeles».`
                  : `${receipt.text}.`}
              </p>
            ) : null}
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
                    Paga una parte: cuesta {plain(line.amountCents)}
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
        {snapshot.taxes ? (
          // Como una boleta: lo cobrado hoy sin impuesto y el impuesto de cada tasa (ADR 0083).
          <div className="flex flex-col gap-1">
            <Row label="Subtotal" value={plain(snapshot.taxes.subtotalCents)} />
            {snapshot.taxes.groups
              .filter((group) => group.taxCents > 0)
              .map((group) => (
                <Row key={`${group.category}-${group.rateBps}`} label={group.label} value={plain(group.taxCents)} />
              ))}
            {untaxedNote ? <span className="text-xs text-muted-foreground">{untaxedNote}</span> : null}
          </div>
        ) : null}
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
          {returnsMade.map((item) => (
            <div key={item.id} className="flex items-baseline justify-between gap-3">
              <button
                type="button"
                className="min-w-0 break-words text-left text-primary underline-offset-4 hover:underline disabled:opacity-60"
                disabled={returnPdfBusy !== null}
                aria-label={`Abrir la devolución ${ticketDisplayNumber(item.number)}`}
                onClick={() => {
                  setReturnPdfBusy(item.id)
                  setPrintError(null)
                  void openServerPdf(returnPdfPath(ticket.patientId, item.id))
                    .catch((err: unknown) => setPrintError(financeErrorMessage(err)))
                    .finally(() => setReturnPdfBusy(null))
                }}
              >
                Devolución {ticketDisplayNumber(item.number)} ·{" "}
                {formatDayLongLocale(item.createdAt, format, zone)}
              </button>
              <span className="shrink-0 tabular-nums">−{plain(item.totalCents)}</span>
            </div>
          ))}
        </div>
        {conceptLines.length > 0 && stillOwed > 0 ? (
          // Lo que falta del tratamiento, aparte del pago y solo si falta algo.
          <div className="flex flex-col gap-0.5 rounded-md border bg-muted/40 px-3 py-2">
            <Row label="Le falta pagar" value={money(stillOwed)} strong />
            {(snapshot.pending ?? []).map((item) => (
              <span key={item.chargeId} className="text-xs text-muted-foreground">
                {item.description}: pagó {plain(item.amountCents - item.remainingCents)} de {plain(item.amountCents)}
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex flex-col gap-0.5 text-center text-xs text-muted-foreground">
          {ticketFooterLines(snapshot.notice || ticketFooter).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
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

      {!voided && canWrite && hasReturns ? (
        <p role="note" className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
          Este ticket tiene una devolución: ya no se anula. Si devuelve algo más, usa «Devolver».
        </p>
      ) : !voided && canWrite && !canVoid ? (
        <p role="note" className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
          La caja ya se cerró después de este ticket: solo administración puede anularlo. Si el paciente pide su dinero,
          usa «Devolver».
        </p>
      ) : null}

      {!inAccount || (!voided && (canVoid || canReturn)) ? (
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
          <div className="flex flex-wrap gap-2">
            {canReturn ? (
              <Button type="button" variant="outline" className="min-h-10" onClick={() => setReturnOpen(true)}>
                Devolver
              </Button>
            ) : null}
            {!voided && canVoid ? (
              <Button
                type="button"
                variant="ghost"
                className="min-h-10 text-destructive hover:text-destructive"
                onClick={() => {
                  voidForm.reset()
                  setVoidOpen(true)
                }}
              >
                Anular ticket
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <FormDrawer
        {...voidSurface}
        dock={false}
        open={voidOpen}
        title="Anular ticket"
        headerContent={
          <div className="flex min-w-0 flex-col">
            <p className="font-heading text-lg font-semibold">Ticket {number}</p>
            <p className="break-words text-sm text-muted-foreground">
              {person} · {paidWith} · {when}
            </p>
          </div>
        }
        submitLabel="Anular ticket"
        cancelLabel="No anular"
        onClose={() => {
          if (!voidSurface.isSubmitting) setVoidOpen(false)
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
              {returnable.data ? (
                <>
                  {productLines.length > 0 ? (
                    <li>
                      <strong className="font-semibold">
                        {productLines.length === 1 ? "Vuelve" : "Vuelven"} a {sedeName}:{" "}
                        {productLines.map((line) => line.description).join(" y ")}
                      </strong>
                      , y {productLines.length === 1 ? "sale" : "salen"} de su cuenta.
                    </li>
                  ) : null}
                  {serviceCents > 0 ? (
                    <li>
                      Lo atendido ya se hizo: {person} vuelve a deber{" "}
                      <strong className="font-semibold">{money(serviceCents)}</strong>.
                    </li>
                  ) : null}
                </>
              ) : appliedToConcepts > 0 ? (
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
          {paidByCard ? (
            <p role="note" className="flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2 text-sm">
              <CreditCard className="mt-0.5 size-4 shrink-0" aria-hidden />
              Anula también la operación en el terminal de la tarjeta. Si el terminal ya cerró el día, ahí será una
              devolución.
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Anular es para un error al cobrar. Si el paciente devuelve algo o pide su dinero, usa «Devolver».
          </p>
          <voidForm.AppField name="reason">
            {(field) => <field.TextareaField label="Motivo" rows={3} maxLength={MAX_VOID_REASON} />}
          </voidForm.AppField>
          <p role="note" className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
            {closedAfter
              ? "La caja ya se cerró después de este cobro. Lo anulas como administración: ese cierre no cambia."
              : "Puedes anularlo porque la caja no se ha cerrado desde este cobro. Después de un cierre, solo administración."}
          </p>
        </div>
      </FormDrawer>

      {canWrite ? (
        <ReturnDrawer
          open={returnOpen}
          onClose={() => setReturnOpen(false)}
          patientId={ticket.patientId}
          patientName={person}
          ticketId={ticket.id}
          ticketNumber={number}
          branchId={returnBranchId}
          branchName={returnBranchName}
          locale={format}
          onReturned={() => {
            void returnable.refetch()
            onChanged()
          }}
        />
      ) : null}
    </div>
  )
}

export function TicketStatusBadge({ voidedAt }: { voidedAt: string | null }): React.JSX.Element {
  return <Badge>{voidedAt ? "Anulado" : "Vigente"}</Badge>
}
