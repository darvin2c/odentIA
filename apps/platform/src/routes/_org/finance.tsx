/**
 * Finanzas: caja por sede, deudas, gastos cortos y cierres. La caja se crea
 * sola al cobrar; cada cierre deja su hoja inmutable.
 *
 * Lectura con `finance.read`; cobrar/gastar/anular con `finance.write`;
 * cerrar con `finance.close` (la anulación tras un cierre la decide el
 * servidor y puede exigir `finance.admin`). Comisiones vive en /commissions.
 * Dinero con `@odentia/clinical`; moneda/locale/zona siempre del perfil.
 */
import { formatMoney, parseMoney } from "@odentia/clinical"
import { Badge, Button, Field, FieldLabel, Input, Textarea } from "@odentia/ui"
import { DetailDrawer, EmptyState, FormDrawer, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { BranchSwitcher } from "../../components/branch-switcher"
import { CollectDrawer } from "../../components/finance/collect-drawer"
import { CashCloseDrawer, CashClosureSheet } from "../../components/finance/cash-close-drawer"
import { TicketView, ticketDisplayNumber } from "../../components/finance/ticket-view"
import { ChoiceSelect } from "../../components/ui/choice-select"
import { ApiError } from "../../lib/api"
import { useActiveBranch } from "../../lib/active-branch"
import { usePermission } from "../../lib/crm"
import { financeErrorMessage } from "../../lib/finance"
import {
  appendCashMovementApi,
  createShortExpenseApi,
  dayInTimezone,
  daysSince,
  expenseFromCash,
  EXPENSE_CATEGORIES,
  fetchCashState,
  fetchClosures,
  fetchClosureSheet,
  fetchDayMovements,
  fetchDebts,
  fetchOpenShiftDetail,
  fetchShortExpenses,
  formatDateTimeShortLocale,
  useOrgFinanceProfile,
  voidShortExpenseApi,
  type ClosureListItem,
  type ClosureSheetEnvelope,
  type CollectResultBody,
  type ExpenseCategory,
  type ShiftDetailBody,
} from "../../lib/finance-collect"
import { useOrgEvents } from "../../lib/org-events"
import { usePageDraftGuard } from "../../lib/page-draft-guard"

export const Route = createFileRoute("/_org/finance")({
  component: FinancePage,
})

type Tab = "caja" | "deudas" | "gastos"

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "caja", label: "Caja" },
  { key: "deudas", label: "Deudas" },
  { key: "gastos", label: "Gastos" },
]

const FINANCE_EVENT_KINDS = [
  "payment.created",
  "payment.voided",
  "payment.refunded",
  "patient.account.updated",
  "encounter.finalized",
]

function AccessDenied({ message }: { message: string }) {
  return (
    <EmptyState
      title="Sin acceso a finanzas"
      description={message || "Tu rol no tiene permiso de caja. Pide a un administrador el rol de cajero."}
    />
  )
}

function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403
}

/** Lectura de formulario: null si el texto no es un importe válido. */
function parseOrNull(raw: string, currency: string, locale: string): number | null {
  try {
    return parseMoney(raw, currency, locale)
  } catch {
    return null
  }
}

function FinancePage() {
  const [tab, setTab] = useState<Tab>("caja")
  const canRead = usePermission("finance.read")
  const canCommissions = usePermission("commissions.read")
  const sede = useActiveBranch()
  const profile = useOrgFinanceProfile()
  const queryClient = useQueryClient()
  const [collect, setCollect] = useState<{ result: CollectResultBody; patientId: string } | null>(null)
  const draftGuard = usePageDraftGuard(false)

  useOrgEvents(FINANCE_EVENT_KINDS, () => {
    void queryClient.invalidateQueries({ queryKey: ["finance-cash"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-debts"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-movements"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-closures"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-expenses"] })
  })

  if (!canRead) {
    return (
      <PageShell>
        <PageHeader title="Finanzas" subtitle="Caja por sede, deudas y gastos" />
        <AccessDenied message="Tu rol no tiene permiso de caja. Pide a un administrador el rol de cajero." />
      </PageShell>
    )
  }

  const branchId = sede.branchId ?? sede.branches[0]?.id ?? ""
  const prof = profile.data?.data ?? null
  const currency = prof?.currency ?? null
  const locale = prof?.locale ?? null
  const timeZone = prof?.timezone ?? null

  return (
    <PageShell>
      {draftGuard.dialog}
      <PageHeader
        title="Finanzas"
        subtitle={
          sede.branches.length > 0 && branchId ? (
            <BranchSwitcher
              branches={sede.branches}
              value={branchId}
              fallbackName={sede.branches[0]?.name ?? ""}
              onChange={(id) => sede.choose(id)}
            />
          ) : (
            "Caja por sede, deudas y gastos"
          )
        }
        actions={
          canCommissions ? (
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link to="/commissions" />}
            >
              Comisiones
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap gap-2">
        {TABS.map((entry) => (
          <Button
            key={entry.key}
            variant={tab === entry.key ? "default" : "outline"}
            onClick={() => {
              if (tab !== entry.key) draftGuard.requestLeave(() => setTab(entry.key))
            }}
          >
            {entry.label}
          </Button>
        ))}
      </div>
      {profile.isPending || !sede.ready ? (
        <p className="text-sm text-muted-foreground">Cargando configuración…</p>
      ) : profile.isError || !currency || !locale || !timeZone || !branchId ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {profile.error
              ? financeErrorMessage(profile.error)
              : "La moneda, el formato y la zona de la clínica aún no están configurados."}
          </p>
          <Button type="button" variant="outline" onClick={() => void profile.refetch()}>
            Reintentar
          </Button>
        </div>
      ) : (
        <>
          {tab === "caja" ? (
            <CashTab
              branchId={branchId}
              branchName={sede.branches.find((item) => item.id === branchId)?.name ?? ""}
              currency={currency}
              locale={locale}
              timeZone={timeZone}
              onCollected={(result, patientId) => setCollect({ result, patientId })}
              onShowDebts={() => draftGuard.requestLeave(() => setTab("deudas"))}
            />
          ) : null}
          {tab === "deudas" ? (
            <DebtsTab
              branchId={branchId}
              currency={currency}
              locale={locale}
              timeZone={timeZone}
              onCollected={(result, patientId) => setCollect({ result, patientId })}
            />
          ) : null}
          {tab === "gastos" ? (
            <ExpensesTab branchId={branchId} currency={currency} locale={locale} timeZone={timeZone} />
          ) : null}
        </>
      )}
      <DetailDrawer
        open={collect !== null}
        onClose={() => setCollect(null)}
        title={collect ? `Cobro registrado · Ticket ${ticketDisplayNumber(collect.result.ticket.ticketNumber)}` : "Cobro registrado"}
      >
        {collect && locale ? (
          <TicketView
            ticket={collect.result.ticket}
            remainingCents={collect.result.remainingCents}
            patientName={collect.result.ticket.snapshot.patient.displayName}
            branchName={collect.result.ticket.snapshot.branch.name}
            locale={locale}
            timeZone={timeZone ?? undefined}
            receiptWidth={prof?.receiptWidth}
            ticketFooter={prof?.ticketFooter}
            onChanged={() => {
              void queryClient.invalidateQueries({ queryKey: ["finance-cash"] })
              void queryClient.invalidateQueries({ queryKey: ["finance-movements"] })
              void queryClient.invalidateQueries({ queryKey: ["finance-debts"] })
              void queryClient.invalidateQueries({ queryKey: ["patient-account3", collect.patientId] })
            }}
          />
        ) : null}
      </DetailDrawer>
    </PageShell>
  )
}

// --- Caja -------------------------------------------------------------------

function CashTab({
  branchId,
  branchName,
  currency,
  locale,
  timeZone,
  onCollected,
  onShowDebts,
}: {
  branchId: string
  branchName: string
  currency: string
  locale: string
  timeZone: string
  onCollected: (result: CollectResultBody, patientId: string) => void
  onShowDebts: () => void
}) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("finance.write")
  const canMessage = usePermission("conversations.read")
  const canClose = usePermission("finance.close")
  const [cobrarOpen, setCobrarOpen] = useState(false)
  const [cobrarPatient, setCobrarPatient] = useState<{ id: string; name: string } | null>(null)
  const [cashOpen, setCashOpen] = useState<"ingreso" | "egreso" | null>(null)
  const [cierreOpen, setCierreOpen] = useState(false)
  const [sheet, setSheet] = useState<ClosureSheetEnvelope | null>(null)
  const [sheetId, setSheetId] = useState<string | null>(null)
  const [concept, setConcept] = useState("")
  const [amount, setAmount] = useState("")
  const [cashError, setCashError] = useState<string | null>(null)

  const day = dayInTimezone(timeZone)
  const cash = useQuery({
    queryKey: ["finance-cash", branchId, currency],
    queryFn: () => fetchCashState(branchId, currency),
  })
  const detalle = useQuery({
    queryKey: ["finance-shift-open", branchId, currency],
    queryFn: () => fetchOpenShiftDetail(branchId, currency),
  })
  const movements = useQuery({
    queryKey: ["finance-movements", branchId, currency, day],
    queryFn: () => fetchDayMovements({ branchId, currency, day }),
  })
  const debts = useQuery({
    queryKey: ["finance-debts", branchId],
    queryFn: () => fetchDebts(branchId),
  })
  const closures = useQuery({
    queryKey: ["finance-closures", branchId],
    queryFn: () => fetchClosures(branchId),
  })
  const sheetQuery = useQuery({
    queryKey: ["finance-closure", sheetId],
    queryFn: () => fetchClosureSheet(sheetId as string),
    enabled: sheetId !== null && sheetId !== "latest",
  })

  useEffect(() => {
    if (!cashOpen) {
      setConcept("")
      setAmount("")
      setCashError(null)
    }
  }, [cashOpen])

  // Tras cerrar, la hoja nueva es la primera de la lista releída.
  useEffect(() => {
    if (sheetId !== "latest" || !closures.data) return
    const first: ClosureListItem | undefined = closures.data.data[0]
    if (!first) {
      setSheetId(null)
      return
    }
    let cancelled = false
    void fetchClosureSheet(first.id).then((result) => {
      if (!cancelled) {
        setSheet(result.data)
        setSheetId(null)
      }
    })
    return () => {
      cancelled = true
    }
  }, [sheetId, closures.data])

  if ((cash.isError && isForbidden(cash.error)) || (movements.isError && isForbidden(movements.error))) {
    return <AccessDenied message={financeErrorMessage(cash.error ?? movements.error)} />
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["finance-cash"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-shift-open"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-movements"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-closures"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-debts"] })
  }

  const cashMutation = useMutation({
    mutationFn: () =>
      appendCashMovementApi({
        branchId,
        currency,
        direction: cashOpen as "ingreso" | "egreso",
        kind: cashOpen === "ingreso" ? "aporte" : "retiro",
        amountCents: parseOrNull(amount, currency, locale) as number,
        concept: concept.trim(),
      }),
    onSuccess: () => {
      setCashOpen(null)
      invalidate()
    },
    onError: (err) => setCashError(financeErrorMessage(err)),
  })

  const estado = cash.data?.data ?? null
  const ventana: ShiftDetailBody | null = detalle.data ?? null
  const body = movements.data?.data ?? null
  const rows = body?.movements ?? []
  const movementTimeZone = body?.timezone ?? timeZone
  const ticketCount = rows.filter((row) => row.kind === "cobro" && row.direction === "ingreso").length
  const expenseCount = rows.filter((row) => row.direction === "egreso").length

  return (
    <div className="flex flex-col gap-4">
      {cash.isError ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">{financeErrorMessage(cash.error)}</p>
          <Button type="button" variant="outline" onClick={() => void cash.refetch()}>
            Reintentar
          </Button>
        </div>
      ) : null}
      <section className="elevated rounded-xl border bg-card p-4 sm:p-6">
        <h2 className="font-heading text-base font-medium">Efectivo en caja</h2>
        {cash.isPending ? (
          <p className="text-sm text-muted-foreground">Consultando la caja…</p>
        ) : estado ? (
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-2xl font-semibold tabular-nums">
              {formatMoney(estado.cashOnHandCents, estado.currency, locale)}
            </p>
            <p className="text-sm text-muted-foreground">
              {estado.openedAt
                ? `Desde ${formatDateTimeShortLocale(estado.openedAt, locale, movementTimeZone)}`
                : "Sin movimientos: la caja se abre sola al primer cobro"}
              {" · "}
              {estado.byMethod.length === 0
                ? "sin cobros desde el último cierre"
                : estado.byMethod
                    .map((row) => `${row.name} (${row.count}) ${formatMoney(row.amountCents, estado.currency, locale)}`)
                    .join(" · ")}
            </p>
            <div className="flex flex-wrap gap-2">
              {canWrite ? <Button onClick={() => setCobrarOpen(true)}>Cobrar</Button> : null}
              {canWrite ? (
                <>
                  <Button variant="outline" onClick={() => setCashOpen("ingreso")}>
                    Ingresar
                  </Button>
                  <Button variant="outline" onClick={() => setCashOpen("egreso")}>
                    Retirar
                  </Button>
                </>
              ) : null}
              {canClose ? <Button variant="outline" onClick={() => setCierreOpen(true)}>Cerrar caja</Button> : null}
            </div>
          </div>
        ) : null}
      </section>
      <section className="elevated rounded-xl border bg-card p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-heading text-base font-medium">
            Por cobrar · {(debts.data?.data ?? []).length}{" "}
            {(debts.data?.data ?? []).length === 1 ? "persona" : "personas"}
          </h2>
          <Button variant="ghost" size="sm" onClick={onShowDebts}>
            Ver deudas
          </Button>
        </div>
        {debts.isPending ? (
          <p className="mt-2 text-sm text-muted-foreground">Consultando pendientes…</p>
        ) : debts.isError ? (
          <div className="mt-2 flex flex-col gap-2">
            <p role="alert" className="text-sm text-destructive">
              {financeErrorMessage(debts.error)}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => void debts.refetch()}>
              Reintentar
            </Button>
          </div>
        ) : (debts.data?.data ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nadie debe en esta sede.</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y">
            {(debts.data?.data ?? []).slice(0, 5).map((row) => (
              <li key={`${row.patientId}-${row.branchId ?? ""}-${row.currency}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{row.displayName || "Paciente"}</p>
                  <p className="text-sm text-muted-foreground">
                    {row.chargesCount} {row.chargesCount === 1 ? "concepto" : "conceptos"}
                  </p>
                </div>
                <span className="text-base font-semibold tabular-nums">
                  {formatMoney(row.totalCents, row.currency, locale)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  nativeButton={false}
                  render={
                    <Link
                      to="/patients/$patientId"
                      params={{ patientId: row.patientId }}
                      search={{ tab: "cuenta" }}
                    />
                  }
                >
                  Ver cuenta
                </Button>
                {canMessage ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    nativeButton={false}
                    render={<Link to="/inbox" search={{ conversation: undefined, q: row.displayName }} />}
                  >
                    Escribirle
                  </Button>
                ) : null}
                {canWrite ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setCobrarPatient({ id: row.patientId, name: row.displayName })
                      setCobrarOpen(true)
                    }}
                  >
                    Cobrar
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-heading text-base font-medium">
          Movimientos de hoy · {ticketCount} tickets · {expenseCount} gastos
        </h2>
        {movements.isPending ? (
          <p className="text-sm text-muted-foreground">Consultando movimientos…</p>
        ) : movements.isError ? (
          <div className="flex flex-col gap-2">
            <p role="alert" className="text-sm text-destructive">
              {financeErrorMessage(movements.error)}
            </p>
            <Button type="button" variant="outline" onClick={() => void movements.refetch()}>
              Reintentar
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="Sin movimientos hoy"
            description="Los cobros, ingresos, retiros y gastos del día aparecen aquí."
          />
        ) : (
          <ul className="flex flex-col divide-y rounded-md border bg-card">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
                <Badge>{row.kind}</Badge>
                <span className="text-sm">{row.concept}</span>
                <span
                  className={`text-sm font-medium tabular-nums ${row.direction === "ingreso" ? "text-success" : "text-destructive"}`}
                >
                  {row.direction === "ingreso" ? "+" : "−"}
                  {formatMoney(row.amountCents, row.currency, locale)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatDateTimeShortLocale(row.createdAt, locale, movementTimeZone)}
                  {row.method ? ` · ${row.method}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-heading text-base font-medium">Cierres anteriores</h2>
        {(closures.data?.data ?? []).length === 0 && !closures.isPending ? (
          <p className="text-sm text-muted-foreground">Aún no hay cierres en esta sede.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border bg-card">
            {(closures.data?.data ?? []).map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-2 px-4 py-2 text-left hover:bg-muted"
                  onClick={() => setSheetId(row.id)}
                >
                  <span className="text-sm font-medium">
                    {formatDateTimeShortLocale(row.closedAt, locale, movementTimeZone)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    debía haber {formatMoney(row.expectedCents, row.currency, locale)} · contó{" "}
                    {formatMoney(row.countedCents, row.currency, locale)}
                  </span>
                  <span
                    className={`text-sm font-medium ${row.differenceCents === 0 ? "text-success" : "text-destructive"}`}
                  >
                    {row.differenceCents === 0
                      ? "Cuadró"
                      : row.differenceCents > 0
                        ? `Sobraron ${formatMoney(row.differenceCents, row.currency, locale)}`
                        : `Faltaron ${formatMoney(-row.differenceCents, row.currency, locale)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Un cierre no se edita. Lo que se corrija después queda como movimiento del día en que
          se corrige.
        </p>
      </section>

      <CollectDrawer
        patientId={cobrarPatient?.id ?? null}
        patientName={cobrarPatient?.name}
        branchId={branchId}
        currency={currency}
        locale={locale}
        open={cobrarOpen}
        onClose={() => {
          setCobrarOpen(false)
          setCobrarPatient(null)
        }}
        onCollected={(result, patientId) => {
          invalidate()
          onCollected(result, patientId)
        }}
      />

      <FormDrawer
        open={cashOpen !== null}
        title={cashOpen === "ingreso" ? "Ingresar efectivo" : "Retirar efectivo"}
        description={
          cashOpen === "ingreso"
            ? "Aporte a la ventana abierta de la sede."
            : "Retiro de la ventana abierta (depósito al banco o entrega)."
        }
        error={cashError}
        isSubmitting={cashMutation.isPending}
        submitLabel={cashOpen === "ingreso" ? "Ingresar" : "Retirar"}
        onClose={() => {
          if (!cashMutation.isPending) setCashOpen(null)
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (parseOrNull(amount, currency, locale) === null) {
            setCashError("Ingresa un importe válido.")
            return
          }
          if (!concept.trim()) {
            setCashError("Indica para qué es el movimiento.")
            return
          }
          cashMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="cash-amount">Importe</FieldLabel>
            <Input
              id="cash-amount"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="cash-concept">Para qué</FieldLabel>
            <Input
              id="cash-concept"
              placeholder={cashOpen === "ingreso" ? "Aporte inicial" : "Depósito al banco"}
              value={concept}
              onChange={(event) => setConcept(event.target.value)}
            />
          </Field>
          {estado ? (
            <p className="text-sm text-muted-foreground">
              El efectivo de la caja queda en {formatMoney(estado.cashOnHandCents, estado.currency, locale)}.
            </p>
          ) : null}
        </div>
      </FormDrawer>

      <CashCloseDrawer
        branchId={branchId}
        branchName={branchName}
        currency={currency}
        locale={locale}
        timeZone={movementTimeZone}
        detalle={ventana}
        open={cierreOpen}
        onClose={() => setCierreOpen(false)}
        onClosed={() => {
          invalidate()
          setSheetId("latest")
        }}
      />

      <DetailDrawer
        open={sheet !== null || sheetId !== null}
        onClose={() => {
          setSheet(null)
          setSheetId(null)
        }}
        title="Hoja de cierre"
      >
        {sheet ? (
          <CashClosureSheet sheet={sheet} locale={locale} timeZone={movementTimeZone} />
        ) : sheetQuery.data?.data ? (
          <CashClosureSheet sheet={sheetQuery.data.data} locale={locale} timeZone={movementTimeZone} />
        ) : sheetQuery.isPending || sheetId === "latest" ? (
          <p className="text-sm text-muted-foreground">Cargando hoja…</p>
        ) : (
          <div className="flex flex-col gap-2">
            <p role="alert" className="text-sm text-destructive">
              {sheetQuery.error ? financeErrorMessage(sheetQuery.error) : "No se pudo cargar la hoja."}
            </p>
            <Button type="button" variant="outline" onClick={() => void sheetQuery.refetch()}>
              Reintentar
            </Button>
          </div>
        )}
      </DetailDrawer>
    </div>
  )
}

// --- Deudas -------------------------------------------------------------------

function DebtsTab({
  branchId,
  currency,
  locale,
  timeZone,
  onCollected,
}: {
  branchId: string
  currency: string
  locale: string
  timeZone: string
  onCollected: (result: CollectResultBody, patientId: string) => void
}) {
  const canWrite = usePermission("finance.write")
  const canMessage = usePermission("conversations.read")
  const [filter, setFilter] = useState<"todas" | "30" | "90">("todas")
  const [cobrarId, setCobrarId] = useState<{ id: string; name: string; branch: string } | null>(null)

  const debts = useQuery({
    queryKey: ["finance-debts", branchId],
    queryFn: () => fetchDebts(branchId),
  })

  if (debts.isError && isForbidden(debts.error)) {
    return <AccessDenied message={financeErrorMessage(debts.error)} />
  }

  const rows = (debts.data?.data ?? []).filter((row) => {
    const days = daysSince(row.oldestSince)
    if (filter === "30") return days !== null && days > 30
    if (filter === "90") return days !== null && days > 90
    return true
  })
  const totals = new Map<string, number>()
  for (const row of debts.data?.data ?? []) {
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.totalCents)
  }

  return (
    <div className="flex flex-col gap-4">
      {debts.isError ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">{financeErrorMessage(debts.error)}</p>
          <Button type="button" variant="outline" onClick={() => void debts.refetch()}>
            Reintentar
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Por cobrar en total · {(debts.data?.data ?? []).length} personas ·{" "}
          {[...totals.entries()]
            .map(([unit, total]) => formatMoney(total, unit, locale))
            .join(" · ") || "—"}
        </p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Antigüedad">
        {(
          [
            ["todas", `Todas · ${(debts.data?.data ?? []).length}`],
            ["30", "Más de 30 días"],
            ["90", "Más de 90"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            variant={filter === value ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {debts.isPending ? (
        <p className="text-sm text-muted-foreground">Consultando deudas…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Sin deudas"
          description={
            filter === "todas"
              ? "Nadie debe en esta sede."
              : "Nadie supera esa antigüedad en esta sede."
          }
        />
      ) : (
        <ul className="flex flex-col divide-y rounded-md border bg-card">
          {rows.map((row) => {
            const days = daysSince(row.oldestSince)
            return (
              <li key={`${row.patientId}-${row.branchId ?? ""}-${row.currency}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{row.displayName || "Paciente"}</p>
                  <p className="text-sm text-muted-foreground">
                    {row.chargesCount} {row.chargesCount === 1 ? "concepto" : "conceptos"}
                    {row.oldestSince
                      ? ` · desde ${formatDateTimeShortLocale(row.oldestSince, locale, timeZone)}`
                      : ""}
                    {days !== null && days > 30 ? (
                      <span> · {days > 90 ? "más de 90 días" : "más de 30 días"}</span>
                    ) : null}
                  </p>
                </div>
                <span className="text-base font-semibold tabular-nums">
                  {formatMoney(row.totalCents, row.currency, locale)}
                </span>
                <Button
                  variant="ghost"
                  nativeButton={false}
                  render={
                    <Link
                      to="/patients/$patientId"
                      params={{ patientId: row.patientId }}
                      search={{ tab: "cuenta" }}
                    />
                  }
                >
                  Ver cuenta
                </Button>
                {canMessage ? (
                  <Button
                    variant="ghost"
                    nativeButton={false}
                    render={<Link to="/inbox" search={{ conversation: undefined, q: row.displayName }} />}
                  >
                    Escribirle
                  </Button>
                ) : null}
                {canWrite ? (
                  <Button
                    onClick={() =>
                      setCobrarId({
                        id: row.patientId,
                        name: row.displayName,
                        branch: row.branchId ?? branchId,
                      })
                    }
                  >
                    Cobrar
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <CollectDrawer
        patientId={cobrarId?.id ?? null}
        patientName={cobrarId?.name}
        branchId={cobrarId?.branch ?? branchId}
        currency={currency}
        locale={locale}
        open={cobrarId !== null}
        onClose={() => setCobrarId(null)}
        onCollected={(result, patientId) => {
          setCobrarId(null)
          onCollected(result, patientId)
        }}
      />
    </div>
  )
}

// --- Gastos -------------------------------------------------------------------

function ExpensesTab({
  branchId,
  currency,
  locale,
  timeZone,
}: {
  branchId: string
  currency: string
  locale: string
  timeZone: string
}) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("finance.write")
  const [category, setCategory] = useState<ExpenseCategory | "">("")
  const [form, setForm] = useState(false)
  const [voidId, setVoidId] = useState<string | null>(null)
  const [concept, setConcept] = useState("")
  const [amount, setAmount] = useState("")
  const [formCategory, setFormCategory] = useState<ExpenseCategory>("Materiales")
  const [fromCash, setFromCash] = useState(true)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const expenses = useQuery({
    queryKey: ["finance-expenses", branchId, category || "todas"],
    queryFn: () =>
      fetchShortExpenses({
        branchId,
        ...(category ? { category } : {}),
        limit: 100,
      }),
  })

  if (expenses.isError && isForbidden(expenses.error)) {
    return <AccessDenied message={financeErrorMessage(expenses.error)} />
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["finance-expenses"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-cash"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-shift-open"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-movements"] })
  }

  const createMutation = useMutation({
    mutationFn: () =>
      createShortExpenseApi({
        branchId,
        category: formCategory,
        concept: concept.trim(),
        amountCents: parseOrNull(amount, currency, locale) as number,
        currency,
        fromCash,
      }),
    onSuccess: () => {
      setForm(false)
      setConcept("")
      setAmount("")
      setError(null)
      invalidate()
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const voidMutation = useMutation({
    mutationFn: () => voidShortExpenseApi(voidId as string, reason.trim()),
    onSuccess: () => {
      setVoidId(null)
      setReason("")
      setError(null)
      invalidate()
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  const items = expenses.data?.data ?? []
  const totals = new Map<string, number>()
  for (const row of items) {
    totals.set(row.category, (totals.get(row.category) ?? 0) + row.amountCents)
  }
  const monthTotal = items.reduce((sum, row) => sum + row.amountCents, 0)

  return (
    <div className="flex flex-col gap-4">
      <section className="elevated rounded-xl border bg-card p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-heading text-base font-medium">
            Gastado · {formatMoney(monthTotal, currency, locale)}
          </h2>
          {canWrite ? <Button onClick={() => setForm(true)}>Registrar gasto</Button> : null}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {EXPENSE_CATEGORIES.map((entry) => (
            <div key={entry}>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">{entry}</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {formatMoney(totals.get(entry) ?? 0, currency, locale)}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <Field>
        <FieldLabel htmlFor="gastos-filtro">Filtrar por tipo</FieldLabel>
        <ChoiceSelect
          id="gastos-filtro"
          className="w-full sm:w-64"
          value={category}
          onChange={(event) => setCategory(event.target.value as ExpenseCategory | "")}
        >
          <option value="">Todos</option>
          {EXPENSE_CATEGORIES.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </ChoiceSelect>
      </Field>

      {expenses.isPending ? (
        <p className="text-sm text-muted-foreground">Consultando gastos…</p>
      ) : expenses.isError ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {financeErrorMessage(expenses.error)}
          </p>
          <Button type="button" variant="outline" onClick={() => void expenses.refetch()}>
            Reintentar
          </Button>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="Sin gastos"
          description="Registra gastos cortos por categoría; con caja descuentan del efectivo."
        />
      ) : (
        <ul className="flex flex-col divide-y rounded-md border bg-card">
          {items.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
              <Badge>{row.category}</Badge>
              <span className="font-medium">{row.concept}</span>
              <span className="text-sm font-medium text-destructive tabular-nums">
                −{formatMoney(row.amountCents, row.currency, locale)}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatDateTimeShortLocale(row.spentAt, locale, timeZone)}
                {expenseFromCash(row) ? " · salió del efectivo de la caja" : " · directo"}
              </span>
              {canWrite ? (
                <Button variant="ghost" onClick={() => {
                  setVoidId(row.id)
                  setReason("")
                  setError(null)
                }}>
                  Anular
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Un gasto se anula con motivo y queda en el historial; no se borra.
      </p>

      <FormDrawer
        open={form}
        title="Registrar gasto"
        description="Gasto corto por categoría."
        error={error}
        isSubmitting={createMutation.isPending}
        submitLabel="Registrar gasto"
        onClose={() => {
          if (!createMutation.isPending) {
            setForm(false)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!concept.trim()) {
            setError("Describe en qué se gastó.")
            return
          }
          if (parseOrNull(amount, currency, locale) === null) {
            setError("Ingresa un importe válido.")
            return
          }
          createMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="gasto-concepto">En qué se gastó</FieldLabel>
            <Input
              id="gasto-concepto"
              value={concept}
              onChange={(event) => setConcept(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="gasto-importe">Importe</FieldLabel>
            <Input
              id="gasto-importe"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="gasto-tipo">Tipo</FieldLabel>
            <ChoiceSelect
              id="gasto-tipo"
              className="w-full"
              value={formCategory}
              onChange={(event) => setFormCategory(event.target.value as ExpenseCategory)}
            >
              {EXPENSE_CATEGORIES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </ChoiceSelect>
          </Field>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={fromCash}
              onChange={(event) => setFromCash(event.target.checked)}
            />
            <span>
              Se pagó con el efectivo de la caja
              <span className="block text-xs text-muted-foreground">
                Se descuenta del efectivo que debe haber al cerrar.
              </span>
            </span>
          </label>
        </div>
      </FormDrawer>

      <FormDrawer
        dock={false}
        open={voidId !== null}
        title="Anular gasto"
        description="Queda en el historial con su motivo; no se borra."
        error={error}
        isSubmitting={voidMutation.isPending}
        submitLabel="Anular"
        onClose={() => {
          if (!voidMutation.isPending) {
            setVoidId(null)
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
        <Field>
          <FieldLabel htmlFor="gasto-void-reason">Motivo</FieldLabel>
          <Textarea
            id="gasto-void-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </FormDrawer>
    </div>
  )
}
