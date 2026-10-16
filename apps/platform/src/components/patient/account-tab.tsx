/**
 * Cuenta del paciente: tres cifras (por cobrar, pagado, a favor), lo pendiente
 * por concepto y los cobros con su ticket. Sin datos clínicos. Los
 * presupuestos están en la pestaña Plan, donde caja también anota la respuesta
 * (ADR 0034).
 *
 * Desde aquí se cobra en un paso (CollectDrawer, en la caja de la sede activa),
 * se vuelve a ver un ticket para imprimirlo, enviarlo o anularlo y se devuelve
 * saldo a favor. Dinero con `@odentia/clinical`; formato y zona del perfil de
 * la clínica.
 */
import { documentText, formatMoney, formatMoneyInput } from "@odentia/clinical"
import {
  Badge,
  Button,
  cn,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Textarea,
} from "@odentia/ui"
import { DetailDrawer, EmptyState, ErrorState, FormDrawer, LoadingState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Plus } from "lucide-react"
import { useId, useState } from "react"
import {
  CollectDrawer,
  MoneyInput,
  parseMoneyOrNull,
  PaymentMethodButtons,
} from "../finance/collect-drawer"
import { openServerPdf, TicketView, ticketDisplayNumber } from "../finance/ticket-view"
import { ChoiceSelect } from "../ui/choice-select"
import { apiFetch } from "../../lib/api"
import { useActiveBranch } from "../../lib/active-branch"
import { usePermission } from "../../lib/crm"
import { financeErrorMessage } from "../../lib/finance"
import {
  CASH_TYPE_CODE,
  createManualChargeApi,
  fetchPatientAccount3,
  fetchPaymentMethods,
  fetchTicketReceipt,
  formatAmountPlain,
  formatDayLongLocale,
  formatDateTimeShortLocale,
  refundApi,
  useOrgFinanceProfile,
  type AccountCobro,
  type CollectResultBody,
  type RefundResult,
} from "../../lib/finance-collect"
import { useOrgEvents } from "../../lib/org-events"
import type { PatientFull } from "../../lib/patients"

const MAX_REASON = 2000

const FINANCE_EVENT_KINDS = [
  "payment.created",
  "payment.voided",
  "payment.refunded",
  "patient.account.updated",
  "encounter.finalized",
]

/** Sección de la cuenta: misma tarjeta y mismo título en todas. */
function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={title} className="elevated rounded-xl border bg-card p-4 sm:p-6">
      <h2 className="font-heading text-base font-medium">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  )
}

/** Cobros del paciente: saldo, pendiente, cobros y pagos. */
export function AccountTab({
  patientId,
}: {
  patientId: string
  /** Se conserva por compatibilidad de enlaces: la cuenta ya no lleva presupuestos. */
  part?: "cuenta"
}): React.JSX.Element {
  const uid = useId()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canRead = usePermission("finance.read")
  const canWrite = usePermission("finance.write")
  const sede = useActiveBranch()
  const profile = useOrgFinanceProfile()

  const [pickedBranch, setPickedBranch] = useState("")
  const [askBranch, setAskBranch] = useState<"cobrar" | "devolver" | "agregar" | null>(null)
  const [cobrarOpen, setCobrarOpen] = useState(false)
  const [collect, setCollect] = useState<CollectResultBody | null>(null)
  const [viewTicket, setViewTicket] = useState<AccountCobro | null>(null)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [refundOpen, setRefundOpen] = useState(false)
  const [refundAmount, setRefundAmount] = useState("")
  const [refundMethod, setRefundMethod] = useState("")
  const [receipt, setReceipt] = useState<RefundResult | null>(null)
  const [adding, setAdding] = useState<{ description: string; amountText: string } | null>(null)
  const [pdfBusy, setPdfBusy] = useState<string | null>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)

  const account = useQuery({
    queryKey: ["patient-account3", patientId],
    queryFn: () => fetchPatientAccount3(patientId),
    enabled: canRead,
  })
  // La ficha ya cargó al paciente: misma clave, sin otra petición.
  const patient = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    enabled: canRead,
  })
  const methods = useQuery({
    queryKey: ["org-payment-methods"],
    queryFn: fetchPaymentMethods,
    enabled: canRead && canWrite,
  })
  const ticketQuery = useQuery({
    queryKey: ["ticket-receipt", patientId, viewTicket?.ticketId],
    queryFn: () => fetchTicketReceipt(patientId, (viewTicket as AccountCobro).ticketId),
    enabled: viewTicket !== null,
  })

  const prof = profile.data?.data ?? null
  const orgUnit = prof?.currency ?? null
  const locale = prof?.locale ?? null
  const timeZone = prof?.timezone ?? null

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["patient-account3", patientId] })
    // La cabecera de la ficha lee el saldo con su propia clave.
    void queryClient.invalidateQueries({ queryKey: ["patient-account", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["ticket-receipt", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["finance-debts"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-cash"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-movements"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-closures"] })
  }

  useOrgEvents(FINANCE_EVENT_KINDS, () => {
    void queryClient.invalidateQueries({ queryKey: ["patient-account3", patientId] })
  })

  // Sede del cobro: la activa; con una sola sede, esa. Solo se pregunta si no hay ninguna.
  const activeBranch =
    sede.branchId ?? (sede.branches.length === 1 ? sede.branches[0]?.id : undefined) ?? pickedBranch
  const branchName = sede.branches.find((item) => item.id === activeBranch)?.name ?? ""

  const refundMutation = useMutation({
    mutationFn: (input: { amountCents: number; paymentMethodId: string }) =>
      refundApi(patientId, {
        branchId: activeBranch,
        amountCents: input.amountCents,
        paymentMethodId: input.paymentMethodId,
        reason: reason.trim(),
      }),
    onSuccess: (result) => {
      setReceipt(result.data)
      setRefundOpen(false)
      setReason("")
      setError(null)
      invalidate()
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const addMutation = useMutation({
    mutationFn: (input: { description: string; amountCents: number }) =>
      createManualChargeApi(patientId, { branchId: activeBranch, ...input }),
    onSuccess: () => {
      setAdding(null)
      setError(null)
      invalidate()
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  if (!canRead) {
    return (
      <EmptyState
        title="La cuenta la maneja caja"
        description="Tu rol no ve importes ni cobros. Si el paciente pregunta cuánto debe, derívalo a caja."
        actionLabel="Volver al resumen del paciente"
        onAction={() =>
          void navigate({
            to: "/patients/$patientId",
            params: { patientId },
            search: { tab: "resumen" },
          })
        }
      />
    )
  }
  if (account.isPending || profile.isPending) {
    return <LoadingState message="Cuenta del paciente" />
  }
  if (account.isError || !account.data) {
    return (
      <ErrorState
        title="No se pudo abrir la cuenta"
        message={account.error ? financeErrorMessage(account.error) : undefined}
        onRetry={() => void account.refetch()}
      />
    )
  }
  if (profile.isError || !orgUnit || !locale || !timeZone) {
    return (
      <ErrorState
        title="Falta configurar la clínica"
        message={
          profile.error
            ? financeErrorMessage(profile.error)
            : "La moneda, el formato y la zona horaria de la clínica aún no están configurados."
        }
        onRetry={() => void profile.refetch()}
      />
    )
  }

  const data = account.data.data
  const money = (cents: number, currency = orgUnit) => formatMoney(cents, currency, locale)
  /** Cifras secundarias, sin símbolo: acompañan a un total que sí lo lleva. */
  const plain = (cents: number, currency = orgUnit) => formatAmountPlain(cents, currency, locale)
  // De qué cobro viene el saldo a favor.
  const creditSources = (data.aFavorOrigen ?? []).filter((row) => row.currency === orgUnit)
  const creditOrigin =
    creditSources.length === 1 && creditSources[0]
      ? `, de ${creditSources[0].advance ? "un adelanto" : "un cobro"} del ${formatDayLongLocale(creditSources[0].paidAt, locale, timeZone)}`
      : creditSources.length > 1
        ? `, de ${creditSources.length} cobros`
        : ""
  const pending = data.pendiente
  const orgRow = data.byCurrency.find((row) => row.currency === orgUnit)
  const orgFavor = orgRow?.aFavor ?? 0
  const orgOwed = orgRow?.porCobrar ?? 0
  const balances =
    data.byCurrency.length > 0
      ? data.byCurrency
      : [{ currency: orgUnit, porCobrar: 0, pagado: 0, aFavor: 0 }]
  const person = patient.data?.data.patient
  const patientName = person?.displayName ?? ""
  const patientDocument = person?.docNumber ? documentText(person.docType, person.docNumber) : null
  const cobros = [...data.cobros].reverse()
  const methodList = methods.data?.data ?? []
  const refundChoice = methodList.find((item) => item.id === refundMethod) ?? methodList[0] ?? null
  const refundCents = parseMoneyOrNull(refundAmount, orgUnit, locale)

  /** Ejecuta la acción si ya hay sede; si no, la pide una sola vez. */
  const withBranch = (action: "cobrar" | "devolver" | "agregar") => {
    setError(null)
    if (!activeBranch) {
      setAskBranch(action)
      return
    }
    setAskBranch(null)
    if (action === "cobrar") setCobrarOpen(true)
    if (action === "agregar") setAdding({ description: "", amountText: "" })
    if (action === "devolver") {
      setRefundAmount(formatMoneyInput(orgFavor, orgUnit, locale))
      setRefundMethod("")
      setReason("")
      setRefundOpen(true)
    }
  }

  const collectButton = (className?: string) => (
    <Button className={className} onClick={() => withBranch("cobrar")}>
      {orgOwed > 0 ? `Cobrar ${money(orgOwed)}` : "Cobrar un adelanto"}
    </Button>
  )

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <section aria-label="Saldo" className="elevated rounded-xl border bg-card p-4 sm:p-6">
        <div className="flex flex-col gap-4">
          {balances.map((balance) => (
            <div key={balance.currency}>
              {balances.length > 1 ? (
                <h2 className="mb-1 text-sm font-semibold">{balance.currency}</h2>
              ) : null}
              <dl className="grid grid-cols-3 gap-3">
                {(
                  [
                    ["Por cobrar", balance.porCobrar],
                    ["Pagado", balance.pagado],
                    ["A favor", balance.aFavor],
                  ] as const
                ).map(([label, cents]) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="break-words text-base font-semibold tabular-nums sm:text-xl">
                      {money(cents, balance.currency)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
        {error && !cobrarOpen && !refundOpen && !adding ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {askBranch ? (
          <Field className="mt-4 max-w-sm">
            <FieldLabel htmlFor={`${uid}-sede`}>¿En qué sede estás cobrando?</FieldLabel>
            <ChoiceSelect
              id={`${uid}-sede`}
              value={pickedBranch}
              placeholder="Elige la sede"
              onChange={(event) => {
                const id = event.target.value
                if (!id) return
                // Queda como sede activa: no se vuelve a preguntar.
                setPickedBranch(id)
                sede.choose(id)
                const action = askBranch
                setAskBranch(null)
                if (action === "cobrar") setCobrarOpen(true)
                if (action === "agregar") setAdding({ description: "", amountText: "" })
                if (action === "devolver") {
                  setRefundAmount(formatMoneyInput(orgFavor, orgUnit, locale))
                  setRefundMethod("")
                  setReason("")
                  setRefundOpen(true)
                }
              }}
            >
              {sede.branches.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </ChoiceSelect>
            <FieldDescription>El cobro entra a la caja de esa sede.</FieldDescription>
          </Field>
        ) : null}
        {canWrite ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {collectButton("hidden sm:inline-flex")}
            {orgFavor > 0 ? (
              <Button variant="outline" onClick={() => withBranch("devolver")}>
                Devolver dinero
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      <Section title="Pendiente">
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {patientName ? `${patientName} no debe nada.` : "No debe nada."}
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {pending.map((item) => (
              <li key={item.chargeId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="break-words font-medium">
                    {item.description}
                    {item.visitNumber && item.visitsPlanned
                      ? `, visita ${item.visitNumber} de ${item.visitsPlanned}`
                      : ""}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Costó {plain(item.totalCents, item.currency)} · pagó{" "}
                    {plain(item.paidCents, item.currency)}
                    {item.since ? ` · desde el ${formatDayLongLocale(item.since, locale, timeZone)}` : ""}
                  </p>
                  {item.promotionName ? (
                    <p className="text-sm text-muted-foreground">Promoción: {item.promotionName}</p>
                  ) : null}
                </div>
                <p className="flex items-baseline gap-2">
                  <span className="text-sm text-muted-foreground">Falta</span>
                  <span className="text-base font-semibold tabular-nums">
                    {money(item.saldoCents, item.currency)}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        )}
        {canWrite ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => withBranch("agregar")}
          >
            <Plus aria-hidden />
            Agregar un concepto por cobrar
          </Button>
        ) : null}
      </Section>

      <Section title="Cobros">
        {cobros.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no se le ha cobrado nada.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {cobros.map((row) => {
              const paidWith = row.payments.map((payment) => payment.methodName).join(" + ")
              const concepts = (row.snapshot?.lines ?? []).map((line) => line.description).join(", ")
              return (
                <li key={row.ticketId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <span>
                        Ticket {ticketDisplayNumber(row.number)} ·{" "}
                        {formatDayLongLocale(row.createdAt, locale, timeZone)}
                      </span>
                      {row.status === "anulado" ? <Badge variant="destructive">Anulado</Badge> : null}
                    </p>
                    <p className="break-words text-sm text-muted-foreground">
                      {row.status === "anulado"
                        ? `Motivo: ${row.voidReason ?? "sin motivo registrado"}`
                        : [paidWith || (row.creditAppliedCents > 0 ? "Saldo a favor" : ""), concepts]
                            .filter(Boolean)
                            .join(" · ")}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "text-base font-semibold tabular-nums",
                      row.status === "anulado" && "text-muted-foreground line-through",
                    )}
                  >
                    {money(row.totalCents > 0 ? row.totalCents : row.creditAppliedCents, row.currency)}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => setViewTicket(row)}>
                    Ver ticket
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      {data.historico.length > 0 ? (
        <Section title="Pagos anteriores">
          <p className="text-sm text-muted-foreground">
            Se registraron antes de que existieran los tickets: solo se consultan.
          </p>
          <ul className="mt-2 flex flex-col divide-y">
            {data.historico.map((row) => (
              <li key={row.paymentId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{row.methodName}</p>
                  <p className="text-sm text-muted-foreground">
                    {formatDateTimeShortLocale(row.paidAt, locale, timeZone)}
                    {row.status === "anulado"
                      ? ` · Anulado${row.voidReason ? ` · Motivo: ${row.voidReason}` : ""}`
                      : ""}
                  </p>
                </div>
                <span className="text-base font-semibold tabular-nums">
                  {money(row.amountCents, row.currency)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {canWrite ? (
        <div className="sticky bottom-3 z-10 sm:hidden">
          {collectButton("min-h-12 w-full shadow-lg")}
        </div>
      ) : null}

      <CollectDrawer
        patientId={patientId}
        patientName={patientName}
        patientDocument={patientDocument}
        patientSex={person?.sex}
        branchId={activeBranch}
        branchName={branchName}
        currency={orgUnit}
        locale={locale}
        open={cobrarOpen}
        onClose={() => setCobrarOpen(false)}
        onCollected={(result) => {
          invalidate()
          setCollect(result)
        }}
      />

      <DetailDrawer
        open={collect !== null}
        onClose={() => setCollect(null)}
        title="Cobro"
        showClose={false}
      >
        {collect ? (
          <TicketView
            key={collect.ticket.id}
            ticket={collect.ticket}
            remainingCents={collect.remainingCents}
            patientName={patientName}
            branchName={branchName}
            locale={locale}
            timeZone={timeZone}
            inAccount
            onDone={() => setCollect(null)}
            onChanged={invalidate}
          />
        ) : null}
      </DetailDrawer>

      <DetailDrawer
        open={viewTicket !== null}
        onClose={() => setViewTicket(null)}
        title={viewTicket ? `Ticket ${ticketDisplayNumber(viewTicket.number)}` : "Ticket"}
        isLoading={ticketQuery.isPending}
        showClose={false}
      >
        {viewTicket ? (
          ticketQuery.isError || !ticketQuery.data ? (
            <ErrorState
              title="No se pudo abrir el ticket"
              message={ticketQuery.error ? financeErrorMessage(ticketQuery.error) : undefined}
              onRetry={() => void ticketQuery.refetch()}
            />
          ) : (
            <TicketView
              key={viewTicket.ticketId}
              ticket={ticketQuery.data.data.ticket}
              closedAfter={ticketQuery.data.data.closedAfter ?? viewTicket.closedAfter ?? false}
              remainingCents={ticketQuery.data.data.ticket.snapshot?.remainingCents ?? 0}
              patientName={patientName}
              branchName={ticketQuery.data.data.ticket.snapshot?.branch?.name ?? ""}
              locale={locale}
              timeZone={timeZone}
              mode="review"
              inAccount
              onDone={() => setViewTicket(null)}
              onChanged={invalidate}
            />
          )
        ) : null}
      </DetailDrawer>

      <FormDrawer
        open={adding !== null}
        title="Agregar un concepto por cobrar"
        description="Algo que se cobra fuera de una atención. Queda pendiente en la cuenta."
        error={adding ? error : null}
        isSubmitting={addMutation.isPending}
        submitLabel="Agregar concepto"
        onClose={() => {
          if (!addMutation.isPending) {
            setAdding(null)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!adding) return
          const description = adding.description.trim()
          const cents = parseMoneyOrNull(adding.amountText, orgUnit, locale)
          if (!description) {
            setError("Escribe qué es lo que se cobra.")
            return
          }
          if (cents === null || cents <= 0) {
            setError("Escribe el importe.")
            return
          }
          addMutation.mutate({ description, amountCents: cents })
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={`${uid}-concepto`}>Concepto</FieldLabel>
            <Input
              id={`${uid}-concepto`}
              maxLength={MAX_REASON}
              value={adding?.description ?? ""}
              onChange={(event) =>
                adding && setAdding({ ...adding, description: event.target.value })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-concepto-importe`}>Importe</FieldLabel>
            <MoneyInput
              id={`${uid}-concepto-importe`}
              currency={orgUnit}
              locale={locale}
              value={adding?.amountText ?? ""}
              onChange={(value) => adding && setAdding({ ...adding, amountText: value })}
            />
          </Field>
        </div>
      </FormDrawer>

      <FormDrawer
        open={refundOpen}
        title="Devolver dinero"
        headerContent={
          <div className="flex min-w-0 flex-col">
            {patientName ? (
              <p className="break-words font-heading text-lg font-semibold">{patientName}</p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              Tiene {money(orgFavor)} a favor{creditOrigin}
            </p>
          </div>
        }
        error={refundOpen ? error : null}
        isSubmitting={refundMutation.isPending}
        isLoading={methods.isPending}
        submitDisabled={!refundChoice}
        submitLabel={
          refundCents !== null && refundCents > 0 ? `Devolver ${money(refundCents)}` : "Devolver"
        }
        onClose={() => {
          if (!refundMutation.isPending) {
            setRefundOpen(false)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (refundCents === null || refundCents <= 0) {
            setError("Escribe cuánto devuelves.")
            return
          }
          if (refundCents > orgFavor) {
            setError(`Solo tiene ${money(orgFavor)} a favor.`)
            return
          }
          if (!refundChoice) {
            setError("Elige cómo se lo devuelves.")
            return
          }
          if (!reason.trim()) {
            setError("Escribe el motivo de la devolución.")
            return
          }
          refundMutation.mutate({ amountCents: refundCents, paymentMethodId: refundChoice.id })
        }}
      >
        <div className="flex flex-col gap-5">
          <Field>
            <FieldLabel htmlFor={`${uid}-devolver`}>Cuánto devuelves</FieldLabel>
            <MoneyInput
              id={`${uid}-devolver`}
              currency={orgUnit}
              locale={locale}
              value={refundAmount}
              onChange={setRefundAmount}
            />
            <FieldDescription>
              Solo se devuelve lo que está a favor. Para devolver algo ya cobrado, primero se anula
              ese cobro.
            </FieldDescription>
          </Field>
          <div className="flex flex-col gap-2">
            <span id={`${uid}-devolver-medio`} className="text-sm font-medium">
              Cómo se lo devuelves
            </span>
            {methods.isError ? (
              <ErrorState
                title="No se pudieron consultar los medios de pago"
                message={financeErrorMessage(methods.error)}
                onRetry={() => void methods.refetch()}
              />
            ) : methodList.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No hay medios de pago activos. Pídele a quien administra la clínica que active uno.
              </p>
            ) : (
              <PaymentMethodButtons
                labelId={`${uid}-devolver-medio`}
                methods={methodList}
                value={refundChoice?.id ?? ""}
                onChange={setRefundMethod}
              />
            )}
          </div>
          <Field>
            <FieldLabel htmlFor={`${uid}-devolver-motivo`}>Motivo</FieldLabel>
            <Textarea
              id={`${uid}-devolver-motivo`}
              rows={2}
              maxLength={MAX_REASON}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          {refundChoice?.typeCode === CASH_TYPE_CODE && refundCents !== null && refundCents > 0 ? (
            <p className="flex items-center justify-between gap-3 rounded-xl bg-muted/60 px-3 py-2 text-sm">
              <span>Salen del efectivo de la caja{branchName ? ` de ${branchName}` : ""}</span>
              <span className="font-semibold tabular-nums">{money(refundCents)}</span>
            </p>
          ) : refundChoice ? (
            <p className="text-sm text-muted-foreground">
              Se devuelve por {refundChoice.name}: no sale del efectivo de la caja.
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Al terminar se puede imprimir la constancia de devolución.
          </p>
        </div>
      </FormDrawer>

      <DetailDrawer
        open={receipt !== null}
        onClose={() => setReceipt(null)}
        title="Devolución registrada"
        closeLabel="Listo"
        actions={
          receipt ? (
            <SubmitButton
              pending={pdfBusy === receipt.receiptId}
              disabled={pdfBusy !== null}
              onClick={() => {
                // La constancia es un PDF del servidor, como el ticket.
                setPdfBusy(receipt.receiptId)
                setPdfError(null)
                void openServerPdf(
                  `/api/patients/${patientId}/refund-receipt-pdf?receiptId=${receipt.receiptId}`,
                )
                  .catch((err: unknown) => setPdfError(financeErrorMessage(err)))
                  .finally(() => setPdfBusy(null))
              }}
            >
              Imprimir constancia
            </SubmitButton>
          ) : undefined
        }
      >
        {receipt && pdfError ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            No se pudo abrir la constancia. {pdfError}
          </p>
        ) : null}
        {receipt ? (
          <div className="flex flex-col gap-1 rounded-xl border bg-card p-4 text-sm">
            <p className="text-center font-heading text-base font-semibold">
              CONSTANCIA DE DEVOLUCIÓN
            </p>
            <p className="text-center text-muted-foreground">
              {formatDateTimeShortLocale(receipt.refundedAt, locale, timeZone)}
            </p>
            <div className="mt-2 flex justify-between gap-3">
              <span className="text-muted-foreground">Paciente</span>
              <span className="break-words text-right font-medium">{patientName}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Se devolvió por</span>
              <span>{receipt.methodName}</span>
            </div>
            <div className="flex justify-between gap-3 font-semibold">
              <span>Devuelto</span>
              <span className="tabular-nums">{money(receipt.amountCents, receipt.currency)}</span>
            </div>
          </div>
        ) : null}
      </DetailDrawer>
    </div>
  )
}
