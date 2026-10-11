/**
 * Ticket de cobro: fila real de `payment_ticket` con su snapshot inmutable.
 * Imprimible en térmica (58/80) o en hoja, anulación con motivo y envío al
 * paciente con el componente real de Documentos (SendFinancialDocument).
 *
 * Dinero con el módulo compartido `@odentia/clinical`; moneda del ticket y
 * locale/zona del perfil (props requeridas, nada fijo).
 */
import { formatMoney } from "@odentia/clinical"
import { Badge, Button, Field, FieldLabel, Textarea } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"
import { ChoiceSelect } from "../ui/choice-select"
import { SendFinancialDocument } from "../finance-documents/SendFinancialDocument"
import { usePermission } from "../../lib/crm"
import { collectErrorMessage } from "../../lib/finance"
import {
  formatDateTimeShortLocale,
  voidTicketApi,
  type CollectTicketRow,
} from "../../lib/finance-collect"

export function ticketDisplayNumber(number: number): string {
  return String(number).padStart(6, "0")
}

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

export function TicketView({
  ticket,
  remainingCents,
  patientName,
  branchName,
  orgName,
  orgAddress,
  locale,
  timeZone,
  receiptWidth,
  ticketFooter,
  sendTrigger,
  onSent,
  onChanged,
}: {
  ticket: CollectTicketRow
  /** Lo que queda por cobrar tras este cobro (viene al nivel del collect). */
  remainingCents: number
  patientName: string
  branchName: string
  orgName?: string
  orgAddress?: string
  locale: string
  timeZone?: string
  receiptWidth?: "58" | "80"
  ticketFooter?: string | null
  sendTrigger?: ReactNode
  onSent?: (info: { conversationId: string; messageId: string }) => void
  onChanged: () => void
}): React.JSX.Element {
  const canWrite = usePermission("finance.write")
  const canAdmin = usePermission("finance.admin")
  const [voidOpen, setVoidOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [voided, setVoided] = useState(ticket.voidedAt !== null)
  const [paper, setPaper] = useState<"termica" | "A4" | "Letter">("termica")

  /** Plantilla única del servidor: sin papel usa la térmica del perfil. */
  const pdfUrl = () => {
    const params = new URLSearchParams({ documentType: "ticket", documentId: ticket.id })
    if (paper !== "termica") params.set("paper", paper)
    return `/api/patients/${ticket.patientId}/financial-document-pdf?${params}`
  }

  const voidMutation = useMutation({
    mutationFn: () => voidTicketApi(ticket.patientId, ticket.id, reason.trim()),
    onSuccess: () => {
      setVoided(true)
      setVoidOpen(false)
      setReason("")
      setError(null)
      onChanged()
    },
    onError: (err) => setError(collectErrorMessage(err)),
  })

  const nodeId = `ticket-${ticket.id}`
  const snapshot = ticket.snapshot
  const currency = ticket.currency

  return (
    <div className="flex flex-col gap-4">
      {voided ? (
        <p role="status" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          Ticket anulado{ticket.voidReason ? `: ${ticket.voidReason}` : ""}. El paciente vuelve a
          deber el importe y el movimiento sale de la caja del día.
        </p>
      ) : null}
      <div id={nodeId} data-print-width={receiptWidth === "58" ? "58mm" : "80mm"} className="flex flex-col gap-1 rounded-md border bg-card p-4 text-sm">
        {orgName ? <p className="text-center font-semibold">{orgName}</p> : null}
        {branchName ? <p className="text-center text-muted-foreground">{branchName}</p> : null}
        {orgAddress ? <p className="text-center text-muted-foreground">{orgAddress}</p> : null}
        <p className="text-center font-heading text-base font-semibold">
          TICKET N.º {ticketDisplayNumber(ticket.ticketNumber)}
        </p>
        <p className="text-center text-muted-foreground">
          {formatDateTimeShortLocale(ticket.createdAt, locale, timeZone)}
        </p>
        <dl className="mt-2 flex flex-col gap-1">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Paciente</dt>
            <dd className="font-medium">{snapshot.patient.displayName || patientName}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Caja</dt>
            <dd>{snapshot.issuer.name || "—"}</dd>
          </div>
        </dl>
        <ul className="mt-2 flex flex-col divide-y border-y">
          {snapshot.lines.map((line, index) => (
            <li key={`${line.chargeId ?? "adelanto"}-${index}`} className="flex flex-col py-1">
              <span className="flex justify-between gap-2">
                <span>{line.description}</span>
                <span className="tabular-nums">{formatMoney(line.amountCents, currency, locale)}</span>
              </span>
              {line.promotion ? (
                <span className="text-xs text-muted-foreground">Promo: {line.promotion}</span>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="flex justify-between gap-2 font-semibold">
          <span>TOTAL</span>
          <span className="tabular-nums">{formatMoney(ticket.totalCents, currency, locale)}</span>
        </div>
        {ticket.creditAppliedCents > 0 ? (
          <div className="flex justify-between gap-2 text-muted-foreground">
            <span>Se usa su saldo</span>
            <span className="tabular-nums">−{formatMoney(ticket.creditAppliedCents, currency, locale)}</span>
          </div>
        ) : null}
        {snapshot.methods.map((method, index) => (
          <div key={`${method.paymentMethodId}-${index}`} className="flex justify-between gap-2">
            <span>
              {method.name}
              {method.reference ? ` · ${method.reference}` : ""}
            </span>
            <span className="tabular-nums">{formatMoney(method.amountCents, currency, locale)}</span>
          </div>
        ))}
        {ticket.cashReceivedCents != null ? (
          <>
            <div className="flex justify-between gap-2">
              <span>Recibido</span>
              <span className="tabular-nums">
                {formatMoney(ticket.cashReceivedCents, currency, locale)}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span>Vuelto</span>
              <span className="tabular-nums">{formatMoney(ticket.changeCents ?? 0, currency, locale)}</span>
            </div>
          </>
        ) : null}
        <div className="flex justify-between gap-2">
          <span>Saldo por cobrar</span>
          <span className="tabular-nums">
            {formatMoney(remainingCents, currency, locale)}
          </span>
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          {snapshot.notice || ticketFooter || "Recibo interno. No es un documento fiscal."}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Field>
          <FieldLabel htmlFor={`${nodeId}-paper`}>Papel</FieldLabel>
          <ChoiceSelect
            id={`${nodeId}-paper`}
            className="w-44"
            value={paper}
            onChange={(event) => setPaper(event.target.value as "termica" | "A4" | "Letter")}
          >
            <option value="termica">Térmica {receiptWidth ?? "80"} mm</option>
            <option value="A4">Hoja A4</option>
            <option value="Letter">Hoja carta</option>
          </ChoiceSelect>
        </Field>
        <Button type="button" variant="outline" onClick={() => window.open(pdfUrl(), "_blank", "noopener")}>
          Imprimir
        </Button>
        <SendFinancialDocument
          patientId={ticket.patientId}
          documentType="ticket"
          documentId={ticket.id}
          trigger={sendTrigger}
          onSent={onSent}
        />
        {!voided && canWrite ? (
          <Button type="button" variant="outline" onClick={() => {
            setReason("")
            setError(null)
            setVoidOpen(true)
          }}>
            Anular cobro
          </Button>
        ) : null}
      </div>

      <FormDrawer
        dock={false}
        open={voidOpen}
        title={`Anular cobro · Ticket ${ticketDisplayNumber(ticket.ticketNumber)}`}
        description="El ticket queda marcado como anulado, no se borra. El paciente vuelve a deber el importe y el efectivo sale de la caja del día."
        error={error}
        isSubmitting={voidMutation.isPending}
        submitLabel="Anular cobro"
        onClose={() => {
          if (!voidMutation.isPending) {
            setVoidOpen(false)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!reason.trim()) {
            setError("Indica el motivo de la anulación.")
            return
          }
          voidMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-2">
          {!canAdmin ? (
            <p className="rounded-md bg-muted p-3 text-sm">
              Si la caja ya cerró desde este cobro, solo administración puede anularlo: el
              servidor lo exige y avisará.
            </p>
          ) : null}
          <Field>
            <FieldLabel htmlFor={`${nodeId}-reason`}>Motivo</FieldLabel>
            <Textarea
              id={`${nodeId}-reason`}
              maxLength={2000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
      </FormDrawer>
    </div>
  )
}

export function TicketStatusBadge({ voidedAt }: { voidedAt: string | null }): React.JSX.Element {
  return <Badge>{voidedAt ? "Anulado" : "Vigente"}</Badge>
}
