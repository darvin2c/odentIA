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
import {
  currencyWord,
  documentText,
  formatMoney,
  formatMoneyInput,
  moneyTotalsText,
} from "@odentia/clinical"
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
import { expenseCategoryLabel, fetchPayables } from "../../lib/finance-cash"
import {
  acceptedTotalsKey,
  CASH_TYPE_CODE,
  fetchAcceptedTotals,
  treatmentLineName,
  createManualChargeApi,
  fetchPatientAccount3,
  fetchPaymentMethods,
  fetchTicketReceipt,
  formatAmountPlain,
  formatDayLongLocale,
  refundLines,
  formatDateTimeShortLocale,
  invalidatePatientAccount,
  refundApi,
  useOrgFinanceProfile,
  accountBalances,
  accountBalanceTitle,
  type AccountCobro,
  type CollectResultBody,
  type RefundResult,
} from "../../lib/finance-collect"
import { useOrgSecondCurrency } from "../../lib/org"
import { productUi } from "../../product/product-ui"
import { useOrgEvents } from "../../lib/org-events"
import type { PatientFull } from "../../lib/patients"
import { AccountSkeleton } from "../skeletons/person-sections"
import { ApplyCreditDialog } from "./collect-flow"

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
  /** El enlace `?cobrar=true`: abre el cobro o la confirmación de aplicar; nunca aplica solo. */
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
  const second = useOrgSecondCurrency()

  const [pickedBranch, setPickedBranch] = useState("")
  const [askBranch, setAskBranch] = useState<"cobrar" | "devolver" | "agregar" | "aplicar" | null>(null)
  /** Lo que quedó tras aplicar lo que tenía a favor: «Listo» o lo que falta. */
  const [applied, setApplied] = useState<{
    appliedCents: number
    remainingCents: number
    currency: string
  } | null>(null)
  const [applying, setApplying] = useState(false)
  const [cobrarOpen, setCobrarOpen] = useState(false)
  /** «Cobrar lo que falta»: la moneda en que se abre el cobro. */
  const [collectIn, setCollectIn] = useState<string | undefined>(undefined)
  /** «Cobrar un adelanto» de un tratamiento aceptado: su línea del presupuesto. */
  const [advanceFor, setAdvanceFor] = useState<string | undefined>(undefined)
  /** Con otra moneda, de cuál se devuelve lo que tiene a favor. */
  const [refundUnit, setRefundUnit] = useState<string | null>(null)
  const [collect, setCollect] = useState<CollectResultBody | null>(null)
  const [viewTicket, setViewTicket] = useState<AccountCobro | null>(null)
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
  // Lo aceptado, lo pagado y lo que falta de cada presupuesto (QA de la ficha del 8 nov):
  // caja lo veía en Plan, a otro clic. Pide caja y presupuesto a la vez.
  const canBudgets = usePermission("budgets.read")
  // El costo del laboratorio junto a lo cobrado lo ve quien administra comisiones (ADR 0174).
  const canCosts = usePermission("commissions.write")
  const labInvoices = useQuery({
    queryKey: ["finance-payables", "patient", patientId],
    queryFn: () => fetchPayables({ patientId }),
    enabled: canCosts && canRead,
    staleTime: 30_000,
  })
  const acceptedTotals = useQuery({
    queryKey: acceptedTotalsKey(patientId),
    queryFn: () => fetchAcceptedTotals(patientId),
    enabled: canRead && canBudgets,
    retry: false,
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

  const invalidate = () => invalidatePatientAccount(queryClient, patientId)

  useOrgEvents(FINANCE_EVENT_KINDS, () => {
    void queryClient.invalidateQueries({ queryKey: ["patient-account3", patientId] })
  })

  // Sede del cobro: la activa; con una sola sede, esa. Solo se pregunta si no hay ninguna.
  // La sede activa, la misma de la Agenda: solo se pregunta si la clínica no tiene ninguna activa.
  const activeBranch = sede.effectiveId ?? pickedBranch
  const branchName = sede.branches.find((item) => item.id === activeBranch)?.name ?? ""

  const cents = (text: string) => parseMoneyOrNull(text, orgUnit ?? "", locale ?? "")
  const refundCurrency = refundUnit ?? orgUnit ?? ""
  const refundCentsOf = (text: string) => parseMoneyOrNull(text, refundCurrency, locale ?? "")
  const favorIn = (code: string) =>
    account.data?.data.byCurrency.find((row) => row.currency === code)?.aFavor ?? 0
  const favor = favorIn(refundCurrency)
  const methodList = methods.data?.data ?? []

  // Una clave por devolución: el mismo pedido enviado otra vez no devuelve dos veces.
  const refundRequestId = useRef<string>(crypto.randomUUID())
  // Lo que se veía a favor al abrir «Devolver dinero»: si otra pestaña devolvió, el servidor lo dice.
  const refundSeenFavor = useRef<number | null>(null)
  const refundMutation = useMutation({
    mutationFn: (input: { amountCents: number; paymentMethodId: string; reason: string }) =>
      refundApi(patientId, {
        branchId: activeBranch,
        ...input,
        requestId: refundRequestId.current,
        ...(refundSeenFavor.current !== null ? { expectedCreditCents: refundSeenFavor.current } : {}),
        // Sin otra moneda, el cuerpo de siempre.
        ...(refundCurrency && refundCurrency !== orgUnit ? { currency: refundCurrency } : {}),
      }),
  })
  const refundForm = useAppForm({
    defaultValues: { amountText: "", paymentMethodId: "", reason: "" },
    validators: {
      onSubmit: refundSchema({
        cents: refundCentsOf,
        favor,
        favorText: refundCurrency && locale ? formatMoney(favor, refundCurrency, locale) : "",
        hasMethod: methodList.length > 0,
      }),
    },
    onSubmit: async ({ value }) => {
      const result = await refundMutation.mutateAsync({
        amountCents: refundCentsOf(value.amountText) ?? 0,
        // Sin elegir, el primero de la lista: el que se ve marcado.
        paymentMethodId: value.paymentMethodId || (methodList[0]?.id ?? ""),
        reason: value.reason.trim(),
      })
      setReceipt(result.data)
      setRefundOpen(false)
      refundRequestId.current = crypto.randomUUID()
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

  // El enlace de cobro abre una vez lo que haría el botón, cuando la cuenta ya está
  // leída (lo decide el render de abajo y lo deja en el ref). Abrir no es ejecutar.
  const collectOnArrival = useRef<(() => void) | null>(null)
  const collectRequested = useRef(openCollect)
  const ready = Boolean(account.data) && canWrite
  useEffect(() => {
    if (openCollect) collectRequested.current = true
    if (!collectRequested.current || !ready || !collectOnArrival.current) return
    collectRequested.current = false
    collectOnArrival.current()
    onCollectOpened?.()
  }, [ready, openCollect, onCollectOpened])

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
  const creditSources = (data.aFavorOrigen ?? []).filter((row) => row.currency === refundCurrency)
  // Lo que entró en otra moneda se devuelve en esa moneda, sin cambio nuevo.
  const refundOut = creditSources.find((row) => row.tenderCurrency)?.tenderCurrency ?? null
  const creditOrigin =
    creditSources.length === 1 && creditSources[0]
      ? `, de ${creditSources[0].advance ? "un adelanto" : "un cobro"} del ${formatDayLongLocale(creditSources[0].paidAt, locale, timeZone)}`
      : creditSources.length > 1
        ? `, de ${creditSources.length} cobros`
        : ""
  const pending = data.pendiente
  const placeName = (code: string) => {
    const site = productUi().site
    const place = Number(code)
    return site?.isPlace(place) ? site.placeName(place) : null
  }
  const orgRow = data.byCurrency.find((row) => row.currency === orgUnit)
  // Con otra moneda, las acciones van por moneda: primero lo que debe en la del negocio.
  const rows = second ? data.byCurrency : orgRow ? [orgRow] : []
  const focusRow = orgRow?.porCobrar ? orgRow : (rows.find((row) => row.porCobrar > 0) ?? orgRow)
  const focusUnit = focusRow?.currency ?? orgUnit
  const focusFavor = focusRow?.aFavor ?? 0
  const focusOwed = focusRow?.porCobrar ?? 0
  const focusBalance = focusRow?.saldo ?? 0
  const owing = rows.filter((row) => row.saldo > 0)
  const favorRows = rows.filter((row) => row.aFavor > 0)
  const balances = accountBalances(data.byCurrency, orgUnit, second?.currency ?? null)
  const person = patient.data?.data.patient
  const patientName = person?.displayName ?? ""
  const patientDocument = person?.docNumber ? documentText(person.docType, person.docNumber) : null
  const cobros = [...data.cobros].reverse()
  const refundChoice = methodList.find((item) => item.id === refundMethod) ?? methodList[0] ?? null
  const refundCents = refundCentsOf(refundAmount)

  /** Abre lo pedido, ya con la sede decidida; cada formulario empieza limpio. */
  const start = (
    action: "cobrar" | "devolver" | "agregar" | "aplicar",
    refundFrom: string = refundCurrency,
  ) => {
    if (action === "aplicar") setApplying(true)
    if (action === "cobrar") setCobrarOpen(true)
    if (action === "agregar") {
      addForm.reset()
      setAdding(true)
    }
    if (action === "devolver") {
      refundRequestId.current = crypto.randomUUID()
      refundSeenFavor.current = favorIn(refundFrom)
      refundForm.reset({
        amountText: formatMoneyInput(favorIn(refundFrom), refundFrom, locale),
        paymentMethodId: "",
        reason: "",
      })
      setRefundOpen(true)
    }
  }

  /** Ejecuta la acción si ya hay sede; si no, la pide una sola vez. */
  const withBranch = (
    action: "cobrar" | "devolver" | "agregar" | "aplicar",
    refundFrom?: string,
  ) => {
    if (!activeBranch) {
      setAskBranch(action)
      return
    }
    setAskBranch(null)
    start(action, refundFrom)
  }

  const refundFrom = (code: string) => {
    setRefundUnit(code)
    withBranch("devolver", code)
  }

  // Lo que tiene a favor cubre lo que debe: la acción es aplicarlo, no cobrar.
  const coveredByCredit = focusOwed > 0 && focusBalance === 0 && owing.length === 0
  collectOnArrival.current = () => withBranch(coveredByCredit ? "aplicar" : "cobrar")
  const collectButton = (className?: string) =>
    coveredByCredit ? (
      <Button className={className} onClick={() => withBranch("aplicar")}>
        Aplicar lo que tiene a favor
      </Button>
    ) : (
      <Button className={className} onClick={() => withBranch("cobrar")}>
        {owing.length > 0
          ? `Cobrar ${moneyTotalsText(
              owing.map((row) => ({ currency: row.currency, cents: row.saldo })),
              money,
            )}`
          : "Cobrar un adelanto"}
      </Button>
    )

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <ApplyCreditDialog
        open={applying}
        patientId={patientId}
        patientName={patientName}
        amountText={money(Math.min(focusFavor, focusOwed), focusUnit)}
        currency={focusUnit !== orgUnit ? (focusUnit ?? undefined) : undefined}
        branchId={activeBranch}
        branchName={branchName}
        onClose={() => setApplying(false)}
        onApplied={(result) => {
          setApplied({
            appliedCents: result.creditAppliedCents,
            remainingCents: result.remainingCents,
            currency: result.ticket.currency,
          })
          invalidate()
        }}
      />
      <section aria-label="Saldo" className="elevated rounded-xl border bg-card p-4 sm:p-6">
        <div className="flex flex-col gap-4">
          {balances.map((balance) => (
            <div key={balance.currency}>
              {balances.length > 1 ? (
                <h2 className="mb-1 text-sm font-semibold">
                  {accountBalanceTitle(balance.currency, locale, second?.currency ?? null)}
                </h2>
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
              ? `Se aplicaron ${money(applied.appliedCents, applied.currency)} de lo que tenía a favor. Falta: ${money(applied.remainingCents, applied.currency)}.`
              : `Se aplicaron ${money(applied.appliedCents, applied.currency)} de lo que tenía a favor. Ya no debe nada.`}
          </p>
        ) : null}
        {canWrite ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {focusOwed > 0 && focusFavor > 0 && !coveredByCredit ? (
              <Button variant="outline" onClick={() => withBranch("aplicar")}>
                Aplicar lo que tiene a favor
              </Button>
            ) : null}
            {collectButton("hidden sm:inline-flex")}
            {favorRows.map((row) => (
              <Button key={row.currency} variant="outline" onClick={() => refundFrom(row.currency)}>
                {favorRows.length > 1
                  ? `Devolver en ${currencyWord(row.currency, locale)}`
                  : "Devolver dinero"}
              </Button>
            ))}
          </div>
        ) : null}
      </section>

      {(acceptedTotals.data?.data ?? []).length > 0 ? (
        <Section title="Tratamiento aceptado">
          <ul className="flex flex-col divide-y">
            {(acceptedTotals.data?.data ?? []).map((group) => {
              const names = group.lines.map((line) => treatmentLineName(line, placeName))
              const advanceable = group.lines.find((line) => line.billingMode !== "session" && line.toChargeCents > 0)
              const free = data.byCurrency.find((row) => row.currency === group.currency)?.aFavor ?? 0
              return (
                <li key={`${group.budgetId}-${group.currency}`} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-[1_1_16rem]">
                      <p className="text-sm font-medium">
                        {names.length > 3 ? `${names.slice(0, 3).join(", ")} y ${names.length - 3} más` : names.join(", ")}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {[
                          `Presupuesto N.º ${group.budgetNumber}`,
                          group.decidedAt ? `aceptado el ${formatDayLongLocale(group.decidedAt, locale, timeZone)}` : null,
                          // Con dos monedas, cada una en su renglón: no se suman (ADR 0135).
                          second ? `en ${currencyWord(group.currency, locale)}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    {canWrite && advanceable ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setAdvanceFor(advanceable.budgetItemId)
                          setCollectIn(group.currency)
                          withBranch("cobrar")
                        }}
                      >
                        Cobrar un adelanto
                      </Button>
                    ) : null}
                  </div>
                  <dl className="grid grid-cols-3 gap-3">
                    {(
                      [
                        ["Aceptado", group.agreedCents],
                        ["Pagó", group.paidCents],
                        ["Falta", group.remainingCents],
                      ] as const
                    ).map(([label, cents]) => (
                      <div key={label} className="min-w-0">
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className="break-words text-sm font-semibold tabular-nums sm:text-base">
                          {money(cents, group.currency)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {(() => {
                    // Las facturas de este tratamiento (su laboratorio): lo que cuesta junto a lo pagado.
                    const items = new Set(group.lines.map((line) => line.planItemId))
                    const all = (labInvoices.data?.data.payables ?? []).filter((row) => row.planItemId !== null && items.has(row.planItemId))
                    if (all.length === 0) return null
                    // Una factura en otra moneda no se resta de lo pagado: se dice aparte (ADR 0135).
                    const invoices = all.filter((row) => row.currency === group.currency)
                    const foreign = all.filter((row) => row.currency !== group.currency)
                    const foreignWords = [...new Set(foreign.map((row) => row.currency))]
                      .map((unit) => money(foreign.filter((row) => row.currency === unit).reduce((sum, row) => sum + row.amountCents, 0), unit))
                      .join(" y ")
                    const cost = invoices.reduce((sum, row) => sum + row.amountCents, 0)
                    const owed = invoices.reduce((sum, row) => sum + row.dueCents, 0)
                    if (invoices.length === 0)
                      return <p className="text-sm">Laboratorio: <span className="font-semibold tabular-nums">{foreignWords}</span>, en otra moneda que lo cobrado.</p>
                    // Casi siempre es el laboratorio; si hay de varios tipos, se dice «Facturas».
                    const kinds = new Set(invoices.map((row) => row.category))
                    const label = kinds.size === 1 ? expenseCategoryLabel(invoices[0]?.category ?? "") : "Facturas"
                    return (
                      <p className="text-sm">
                        {label}: <span className="font-semibold tabular-nums">{money(cost, group.currency)}</span>
                        {owed > 0 ? ` (por pagar ${money(owed, group.currency)})` : " (pagado)"}.{" "}
                        {group.paidCents >= cost ? (
                          <>
                            De lo que pagó, queda <span className="font-semibold tabular-nums">{money(group.paidCents - cost, group.currency)}</span>.
                          </>
                        ) : (
                          <>
                            Cuesta <span className="font-semibold tabular-nums">{money(cost - group.paidCents, group.currency)}</span> más de lo que pagó hasta hoy.
                          </>
                        )}
                        {foreignWords ? ` Además, ${foreignWords} en otra moneda.` : ""}
                      </p>
                    )
                  })()}
                  {/* «Falta» junta lo ya hecho sin pagar (en Pendiente) y lo que aún no se hace (segunda mesa). */}
                  {group.remainingCents > 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {group.owingCents > 0
                        ? group.owingCents >= group.remainingCents
                          ? `Todo lo que falta ya se puede cobrar: está en Pendiente.`
                          : `De lo que falta, ${money(group.owingCents, group.currency)} ya se puede cobrar (está en Pendiente) y ${money(group.remainingCents - group.owingCents, group.currency)} se cobra al hacerlo.`
                        : "Lo que falta se cobra al hacerlo."}
                    </p>
                  ) : null}
                  {group.discountCents > 0 || group.returnedCents > 0 || free > 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {[
                        // Sin esto, aceptado ≠ pagó + falta y la cuenta no cuadra a la vista.
                        group.discountCents > 0 ? `${money(group.discountCents, group.currency)} de descuento` : null,
                        group.returnedCents > 0 ? `${money(group.returnedCents, group.currency)} devuelto` : null,
                        // Lo que tiene a favor sin tratamiento no está en «Pagó»: se usa en el próximo cobro.
                        free > 0 ? `además tiene ${money(free, group.currency)} a favor, que se usa en el próximo cobro` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                        .replace(/^./, (first) => first.toUpperCase())}
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </Section>
      ) : null}

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
          // Con pagos anteriores a los tickets, decir «no se ha cobrado nada» es falso (QA Cobros):
          // esos pagos salen abajo, en «Pagos anteriores».
          data.historico.length > 0 ? null : (
            <p className="text-sm text-muted-foreground">Todavía no se le ha cobrado nada.</p>
          )
        ) : (
          <ul className="flex flex-col divide-y">
            {cobros.map((row) => {
              const paidWith = row.payments
                .map((payment) =>
                  // Entró en otra moneda: se dice lo que entró, porque el total es lo que canceló.
                  payment.tenderCents != null && payment.tenderCurrency
                    ? `${payment.methodName} ${money(payment.tenderCents, payment.tenderCurrency)}`
                    : payment.methodName,
                )
                .join(" + ")
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
                    {refundLines(row.refunds, money, (iso) => formatDayLongLocale(iso, locale, timeZone)).map((line) => (
                      <p key={line} className="break-words text-sm">
                        {line}
                      </p>
                    ))}
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
                  {/* Sin ticket no hay concepto guardado: no se inventa (ADR de pagos anteriores). */}
                  <p className="text-sm text-muted-foreground">Sin concepto registrado: se cobró antes de los tickets.</p>
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
        debtCurrency={collectIn}
        presetAdvanceFor={advanceFor}
        locale={locale}
        open={cobrarOpen}
        onClose={() => {
          setCobrarOpen(false)
          setCollectIn(undefined)
          setAdvanceFor(undefined)
        }}
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
            onCollectRest={(currency) => {
              setCollect(null)
              setCollectIn(currency)
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
              Tiene {money(favor, refundCurrency)} a favor{creditOrigin}
            </p>
          </div>
        }
        isLoading={methods.isPending}
        // Sin medios de pago activos no hay cómo devolver: el motivo se lee en el campo.
        submitDisabled={!refundChoice}
        submitLabel={
          refundCents !== null && refundCents > 0
            ? `Devolver ${money(refundCents, refundCurrency)}`
            : "Devolver"
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
                    currency={refundCurrency}
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
          {refundOut && refundOut !== refundCurrency ? (
            <p className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
              Sale en {currencyWord(refundOut, locale)}, como entró y en la misma proporción: sin
              cambio nuevo.
            </p>
          ) : refundChoice?.typeCode === CASH_TYPE_CODE &&
            refundCents !== null &&
            refundCents > 0 ? (
            <p className="flex items-center justify-between gap-3 rounded-xl bg-muted/60 px-3 py-2 text-sm">
              <span>Salen del efectivo de la caja{branchName ? ` de ${branchName}` : ""}</span>
              <span className="font-semibold tabular-nums">
                {money(refundCents, refundCurrency)}
              </span>
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
            {(receipt.payouts ?? []).map((payout) => (
              <div key={payout.currency} className="flex justify-between gap-3">
                <span className="text-muted-foreground">Salió de la caja</span>
                <span className="tabular-nums">{money(payout.amountCents, payout.currency)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </DetailDrawer>
    </div>
  )
}
