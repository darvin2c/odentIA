/**
 * Cuenta del paciente: tres cifras (debe, a favor y saldo, que descuenta lo
 * que tiene a favor: decisión 22), lo pendiente
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
import { Badge, Button, cn, Field, FieldDescription, FieldLabel } from "@odentia/ui"
import {
  DetailDrawer,
  EmptyState,
  ErrorState,
  FormDrawer,
  SubmitButton,
  useAppForm,
  useFormSurface,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Plus } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { z } from "zod"
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
import { financeErrorMessage, financeFormMessage } from "../../lib/finance"
import {
  CASH_TYPE_CODE,
  collectApi,
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
import { AccountSkeleton } from "../skeletons/person-sections"

const MAX_REASON = 2000

type ParseCents = (text: string) => number | null

/** «Agregar un concepto»: qué se cobra y cuánto, dicho en cada campo. */
function chargeSchema(cents: ParseCents) {
  return z.object({
    description: z.string().trim().min(1, "Escribe qué es lo que se cobra.").max(MAX_REASON),
    amountText: z.string().refine((text) => (cents(text) ?? 0) > 0, "Escribe el importe."),
  })
}

/** «Devolver dinero»: lo que exige `refundCredit`, dicho en cada campo antes de enviar. */
function refundSchema(input: { cents: ParseCents; favor: number; favorText: string; hasMethod: boolean }) {
  return z
    .object({
      amountText: z.string(),
      paymentMethodId: z.string(),
      reason: z.string().trim().min(1, "Escribe el motivo de la devolución.").max(MAX_REASON),
    })
    .superRefine((value, ctx) => {
      const amount = input.cents(value.amountText)
      if (amount === null || amount <= 0)
        ctx.addIssue({ code: "custom", path: ["amountText"], message: "Escribe cuánto devuelves." })
      else if (amount > input.favor)
        ctx.addIssue({ code: "custom", path: ["amountText"], message: `Solo tiene ${input.favorText} a favor.` })
      if (!input.hasMethod)
        ctx.addIssue({ code: "custom", path: ["paymentMethodId"], message: "Elige cómo se lo devuelves." })
    })
}

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
  openCollect = false,
  onCollectOpened,
}: {
  patientId: string
  /** Se conserva por compatibilidad de enlaces: la cuenta ya no lleva presupuestos. */
  part?: "cuenta"
  /** «Cobrar» de Pendientes: abre el cobro (o aplica lo que tiene a favor) al llegar. */
  openCollect?: boolean
  onCollectOpened?: () => void
}): React.JSX.Element {
  const uid = useId()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canRead = usePermission("finance.read")
  const canWrite = usePermission("finance.write")
  const sede = useActiveBranch()
  const profile = useOrgFinanceProfile()

  const [pickedBranch, setPickedBranch] = useState("")
  const [askBranch, setAskBranch] = useState<"cobrar" | "devolver" | "agregar" | "aplicar" | null>(null)
  /** Lo que quedó tras aplicar lo que tenía a favor: «Listo» o lo que falta. */
  const [applied, setApplied] = useState<{ appliedCents: number; remainingCents: number } | null>(null)
  const [cobrarOpen, setCobrarOpen] = useState(false)
  const [collect, setCollect] = useState<CollectResultBody | null>(null)
  const [viewTicket, setViewTicket] = useState<AccountCobro | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refundOpen, setRefundOpen] = useState(false)
  const [receipt, setReceipt] = useState<RefundResult | null>(null)
  const [adding, setAdding] = useState(false)
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
  // La sede activa, la misma de la Agenda: solo se pregunta si la clínica no tiene ninguna activa.
  const activeBranch = sede.effectiveId ?? pickedBranch
  const branchName = sede.branches.find((item) => item.id === activeBranch)?.name ?? ""

  const cents = (text: string) => parseMoneyOrNull(text, orgUnit ?? "", locale ?? "")
  const favor = account.data?.data.byCurrency.find((row) => row.currency === orgUnit)?.aFavor ?? 0
  const methodList = methods.data?.data ?? []

  const refundMutation = useMutation({
    mutationFn: (input: { amountCents: number; paymentMethodId: string; reason: string }) =>
      refundApi(patientId, { branchId: activeBranch, ...input }),
  })
  const refundForm = useAppForm({
    defaultValues: { amountText: "", paymentMethodId: "", reason: "" },
    validators: {
      onSubmit: refundSchema({
        cents,
        favor,
        favorText: orgUnit && locale ? formatMoney(favor, orgUnit, locale) : "",
        hasMethod: methodList.length > 0,
      }),
    },
    onSubmit: async ({ value }) => {
      const result = await refundMutation.mutateAsync({
        amountCents: cents(value.amountText) ?? 0,
        // Sin elegir, el primero de la lista: el que se ve marcado.
        paymentMethodId: value.paymentMethodId || (methodList[0]?.id ?? ""),
        reason: value.reason.trim(),
      })
      setReceipt(result.data)
      setRefundOpen(false)
      invalidate()
    },
  })
  // El importe se escribe como texto: lo que el servidor dice de `amountCents` va en él.
  const refundSurface = useFormSurface(refundForm, {
    fieldMap: { amountCents: "amountText" },
    formMessage: financeFormMessage,
  })
  const refundAmount = useStore(refundForm.store, (state) => state.values.amountText)
  const refundMethod = useStore(refundForm.store, (state) => state.values.paymentMethodId)

  // «Aplicar lo que tiene a favor»: el mismo cobro de caja, sin dinero nuevo.
  // Queda como un ticket con el saldo a favor usado (el movimiento registrado).
  const applyMutation = useMutation({
    mutationFn: () => collectApi(patientId, { branchId: activeBranch, requestId: crypto.randomUUID() }),
    onSuccess: (result) => {
      setApplied({ appliedCents: result.data.creditAppliedCents, remainingCents: result.data.remainingCents })
      setError(null)
      invalidate()
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const addMutation = useMutation({
    mutationFn: (input: { description: string; amountCents: number }) =>
      createManualChargeApi(patientId, { branchId: activeBranch, ...input }),
  })
  const addForm = useAppForm({
    defaultValues: { description: "", amountText: "" },
    validators: { onSubmit: chargeSchema(cents) },
    onSubmit: async ({ value }) => {
      await addMutation.mutateAsync({ description: value.description.trim(), amountCents: cents(value.amountText) ?? 0 })
      setAdding(false)
      invalidate()
    },
  })
  const addSurface = useFormSurface(addForm, {
    fieldMap: { amountCents: "amountText" },
    formMessage: financeFormMessage,
  })

  // «Cobrar» de Pendientes: la acción del botón de cobro corre una vez, cuando la
  // cuenta ya está leída (la decide el render de abajo y la deja en el ref).
  const collectOnArrival = useRef<(() => void) | null>(null)
  const collectRequested = useRef(openCollect)
  const ready = Boolean(account.data) && canWrite
  useEffect(() => {
    if (!collectRequested.current || !ready || !collectOnArrival.current) return
    collectRequested.current = false
    collectOnArrival.current()
    onCollectOpened?.()
  }, [ready, onCollectOpened])

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
    return (
      <SkeletonRegion message="Cuenta del paciente">
        <AccountSkeleton canWrite={canWrite} />
      </SkeletonRegion>
    )
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
  const orgBalance = orgRow?.saldo ?? 0
  const balances =
    data.byCurrency.length > 0
      ? data.byCurrency
      : [{ currency: orgUnit, porCobrar: 0, pagado: 0, aFavor: 0, saldo: 0 }]
  const person = patient.data?.data.patient
  const patientName = person?.displayName ?? ""
  const patientDocument = person?.docNumber ? documentText(person.docType, person.docNumber) : null
  const cobros = [...data.cobros].reverse()
  const refundChoice = methodList.find((item) => item.id === refundMethod) ?? methodList[0] ?? null
  const refundCents = cents(refundAmount)

  /** Abre lo pedido, ya con la sede decidida; cada formulario empieza limpio. */
  const start = (action: "cobrar" | "devolver" | "agregar" | "aplicar") => {
    if (action === "aplicar") applyMutation.mutate()
    if (action === "cobrar") setCobrarOpen(true)
    if (action === "agregar") {
      addForm.reset()
      setAdding(true)
    }
    if (action === "devolver") {
      refundForm.reset({ amountText: formatMoneyInput(orgFavor, orgUnit, locale), paymentMethodId: "", reason: "" })
      setRefundOpen(true)
    }
  }

  /** Ejecuta la acción si ya hay sede; si no, la pide una sola vez. */
  const withBranch = (action: "cobrar" | "devolver" | "agregar" | "aplicar") => {
    setError(null)
    if (!activeBranch) {
      setAskBranch(action)
      return
    }
    setAskBranch(null)
    start(action)
  }

  // Lo que tiene a favor cubre lo que debe: la acción es aplicarlo, no cobrar.
  const coveredByCredit = orgOwed > 0 && orgBalance === 0
  collectOnArrival.current = () => withBranch(coveredByCredit ? "aplicar" : "cobrar")
  const collectButton = (className?: string) =>
    coveredByCredit ? (
      <Button className={className} disabled={applyMutation.isPending} onClick={() => withBranch("aplicar")}>
        {applyMutation.isPending ? "Aplicando…" : "Aplicar lo que tiene a favor"}
      </Button>
    ) : (
      <Button className={className} onClick={() => withBranch("cobrar")}>
        {orgBalance > 0 ? `Cobrar ${money(orgBalance)}` : "Cobrar un adelanto"}
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
                    ["Debe", balance.porCobrar],
                    ["A favor", balance.aFavor],
                    ["Saldo", balance.saldo],
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
        {error ? (
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
                start(action)
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
        {applied ? (
          <p role="status" className="mt-3 text-sm">
            {applied.remainingCents > 0
              ? `Se aplicaron ${money(applied.appliedCents)} de lo que tenía a favor. Falta: ${money(applied.remainingCents)}.`
              : `Se aplicaron ${money(applied.appliedCents)} de lo que tenía a favor. Ya no debe nada.`}
          </p>
        ) : null}
        {canWrite ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {orgOwed > 0 && orgFavor > 0 && !coveredByCredit ? (
              <Button
                variant="outline"
                disabled={applyMutation.isPending}
                onClick={() => withBranch("aplicar")}
              >
                {applyMutation.isPending ? "Aplicando…" : "Aplicar lo que tiene a favor"}
              </Button>
            ) : null}
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
                      {row.returns?.length ? <Badge variant="secondary">Con devolución</Badge> : null}
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
            receipt={collect.receipt ?? null}
            patientName={patientName}
            branchName={branchName}
            locale={locale}
            timeZone={timeZone}
            inAccount
            onDone={() => setCollect(null)}
            onCollect={() => {
              setCollect(null)
              withBranch("cobrar")
            }}
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
              onCollect={() => {
                setViewTicket(null)
                withBranch("cobrar")
              }}
              onChanged={invalidate}
            />
          )
        ) : null}
      </DetailDrawer>

      <FormDrawer
        {...addSurface}
        open={adding}
        title="Agregar un concepto por cobrar"
        description="Algo que se cobra fuera de una atención. Queda pendiente en la cuenta."
        submitLabel="Agregar concepto"
        onClose={() => {
          if (!addSurface.isSubmitting) setAdding(false)
        }}
      >
        <div className="flex flex-col gap-4">
          <addForm.AppField name="description">
            {(field) => <field.TextField label="Concepto" maxLength={MAX_REASON} />}
          </addForm.AppField>
          <addForm.AppField name="amountText">
            {(field) => (
              <field.Control label="Importe">
                {(control) => (
                  <MoneyInput
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    currency={orgUnit}
                    locale={locale}
                    value={field.state.value}
                    onChange={field.handleChange}
                  />
                )}
              </field.Control>
            )}
          </addForm.AppField>
        </div>
      </FormDrawer>

      <FormDrawer
        {...refundSurface}
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
        isLoading={methods.isPending}
        // Sin medios de pago activos no hay cómo devolver: el motivo se lee en el campo.
        submitDisabled={!refundChoice}
        submitLabel={
          refundCents !== null && refundCents > 0 ? `Devolver ${money(refundCents)}` : "Devolver"
        }
        onClose={() => {
          if (!refundSurface.isSubmitting) setRefundOpen(false)
        }}
      >
        <div className="flex flex-col gap-5">
          <refundForm.AppField name="amountText">
            {(field) => (
              <field.Control
                label="Cuánto devuelves"
                description="Solo se devuelve lo que está a favor. Para devolver algo ya cobrado, ábrelo desde su ticket: «Devolver»."
              >
                {(control) => (
                  <MoneyInput
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    currency={orgUnit}
                    locale={locale}
                    value={field.state.value}
                    onChange={field.handleChange}
                  />
                )}
              </field.Control>
            )}
          </refundForm.AppField>
          <refundForm.AppField name="paymentMethodId">
            {(field) => (
              <field.Group legend={<span id={`${uid}-devolver-medio`}>Cómo se lo devuelves</span>}>
                {() =>
                  methods.isError ? (
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
                      onChange={(id) => {
                        field.handleChange(id)
                        field.handleBlur()
                      }}
                    />
                  )
                }
              </field.Group>
            )}
          </refundForm.AppField>
          <refundForm.AppField name="reason">
            {(field) => <field.TextareaField label="Motivo" rows={2} maxLength={MAX_REASON} />}
          </refundForm.AppField>
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
