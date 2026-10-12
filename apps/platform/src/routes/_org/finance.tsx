/**
 * Finanzas: la caja del día por sede, las deudas y los gastos del mes.
 *
 * La caja se crea sola con el primer cobro y nunca bloquea: se cierra contando
 * solo el efectivo y cada cierre deja su hoja, que no se edita. Lectura con
 * `finance.read`; cobrar, gastar, ingresar o retirar con `finance.write`;
 * cerrar con `finance.close` (decide siempre el servidor). Comisiones vive en
 * `/commissions`.
 *
 * `?tab=` conserva la sección y `?cierre=<id>` abre la hoja de ese cierre: es
 * el enlace del aviso que recibe administración. Dinero con
 * `@odentia/clinical`; moneda, formato y zona de la clínica o la sede.
 */
import { formatMoney, formatMoneyInput } from "@odentia/clinical"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Checkbox,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  Input,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
  useIsMobile,
} from "@odentia/ui"
import {
  DataTableSkeleton,
  DatePickerButton,
  DetailDrawer,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  PageHeader,
  PageShell,
} from "@odentia/ui-patterns"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { ArrowLeft, ChevronDown } from "lucide-react"
import { useEffect, useId, useMemo, useState } from "react"
import { BranchSwitcher } from "../../components/branch-switcher"
import { ContactConversationDialog } from "../../components/contact-conversation-dialog"
import {
  CashCloseDrawer,
  CashMoveDrawer,
  ChoiceChips,
  ClosureSheetDrawer,
} from "../../components/finance/cash-close-drawer"
import { CollectDrawer } from "../../components/finance/collect-drawer"
import {
  CommissionsAdminPanel,
  MonthPicker,
  MyCommissionsPanel,
} from "../../components/finance/CommissionsPanel"
import { TicketView, ticketDisplayNumber } from "../../components/finance/ticket-view"
import { ChoiceSelect } from "../../components/ui/choice-select"
import { useActiveBranch } from "../../lib/active-branch"
import { compareMonths, FIRST_YEAR, plainAmount } from "../../lib/commissions"
import { usePermission } from "../../lib/crm"
import { financeErrorMessage } from "../../lib/finance"
import {
  attendedTodayAt,
  CLOSURES_PAGE,
  CASH_TERMS,
  type CashBreakdown,
  cashErrorMessage,
  createExpenseApi,
  currentMonthIn,
  type DayEntry,
  dayKeyOf,
  debtAgeDays,
  debtConcepts,
  debtDue,
  type DebtRow,
  differenceLabel,
  EXPENSE_CATEGORIES,
  type ExpenseCategory,
  type ExpenseRow,
  fetchClosures,
  fetchDayMovements,
  fetchDebts,
  fetchMonthExpenses,
  financeKeys,
  formatClock,
  formatDateTimeLong,
  formatDayKey,
  formatDayMonth,
  formatDayShort,
  formatMonth,
  formatMonthName,
  groupDayMovements,
  hasEarlierDaysOpen,
  invalidateFinance,
  isForbidden,
  joinList,
  momentDay,
  momentShort,
  type MonthRef,
  monthsBack,
  monthValue,
  NO_RECEIPT,
  noonOf,
  otherMethods,
  parseAmount,
  parseMonthValue,
  spokenMoment,
  todayIn,
  totalsByCurrency,
  useBranchesStatus,
  useCashState,
  voidCashMovementApi,
  voidExpenseApi,
} from "../../lib/finance-cash"
import {
  type CollectResultBody,
  fetchTicketReceipt,
  useOrgFinanceProfile,
} from "../../lib/finance-collect"
import { useOrgEvents } from "../../lib/org-events"

type FinanceView = "caja" | "deudas" | "gastos" | "comisiones" | "cierres"

const VIEWS: readonly FinanceView[] = ["caja", "deudas", "gastos", "comisiones", "cierres"]

function isView(value: unknown): value is FinanceView {
  return typeof value === "string" && (VIEWS as readonly string[]).includes(value)
}

interface FinanceSearch {
  /** Sección; `cierres` es la lista de cierres anteriores, dentro de Caja. */
  tab?: FinanceView
  /** Cierre (o su ventana) cuya hoja está abierta. */
  cierre?: string
  /** Sede elegida (`useActiveBranch`). */
  branch?: string
  /** Mes de Comisiones; sin él, el mes en curso de la clínica. */
  year?: number
  month?: number
  /** Profesional con el detalle abierto en Comisiones (solo administración). */
  profesional?: string
}

/** Un mes mal escrito en el enlace no rompe la pantalla: se muestra el mes en curso. */
function monthOfSearch(search: Record<string, unknown>): { year: number; month: number } | null {
  const year = Number(search.year)
  const month = Number(search.month)
  const valid =
    Number.isInteger(year) &&
    year >= FIRST_YEAR &&
    year <= 2100 &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12
  return valid ? { year, month } : null
}

export const Route = createFileRoute("/_org/finance")({
  validateSearch: (search: Record<string, unknown>): FinanceSearch => ({
    ...(isView(search.tab) ? { tab: search.tab } : {}),
    ...(typeof search.cierre === "string" && search.cierre ? { cierre: search.cierre } : {}),
    ...(typeof search.branch === "string" && search.branch ? { branch: search.branch } : {}),
    ...(monthOfSearch(search) ?? {}),
    ...(typeof search.profesional === "string" && search.profesional
      ? { profesional: search.profesional }
      : {}),
  }),
  component: FinancePage,
})

// `finance.cash.updated`: gasto, ingreso, retiro, anulación o cierre hechos en
// cualquier sesión. Los cobros y las atenciones traen su propio aviso.
const FINANCE_EVENT_KINDS = [
  "finance.cash.updated",
  "payment.created",
  "payment.voided",
  "payment.refunded",
  "patient.account.updated",
  "encounter.finalized",
]

/** Personas «de antes» a la vista en Caja; el resto se ve en Deudas. */
const CASH_EARLIER_LIMIT = 8
/** Deudas a la vista antes de «Ver las N que faltan». */
const DEBTS_PAGE = 12
/** Meses que ofrece el selector de Gastos. */
const EXPENSE_MONTHS = 24

/** Lo que cada sección necesita saber de la clínica y la sede. */
interface Workspace {
  branchId: string
  branchName: string
  /** Moneda y formato de la clínica. */
  currency: string
  locale: string
  /** Zona de la clínica: el mes de los gastos. */
  orgTimeZone: string
  /** Zona de la sede: el día de la caja. */
  timeZone: string
}

interface CollectTarget {
  id: string
  name: string
}

type Panel =
  | { kind: "cobrar"; patient: CollectTarget | null }
  | { kind: "gasto" }
  | { kind: "cerrar" }
  | { kind: "efectivo" }

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function lowerFirst(text: string): string {
  return text ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text
}

function upperFirst(text: string): string {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text
}

function AccessDenied({ message }: { message?: string }) {
  return (
    <EmptyState
      title="Sin acceso a finanzas"
      description={message || "Tu rol no tiene permiso de caja. Pide a un administrador el rol de cajero."}
    />
  )
}

function FinancePage() {
  const canRead = usePermission("finance.read")
  if (!canRead) {
    return (
      <PageShell className="flex flex-col gap-4">
        <PageHeader title="Finanzas" subtitle="Caja por sede, deudas y gastos" />
        <AccessDenied />
      </PageShell>
    )
  }
  return <FinanceWorkspace />
}

function FinanceWorkspace() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const queryClient = useQueryClient()
  const sede = useActiveBranch()
  const profile = useOrgFinanceProfile()
  const isMobile = useIsMobile()
  const canWrite = usePermission("finance.write")
  const canClose = usePermission("finance.close")
  const canCommissions = usePermission("commissions.read")
  const canCommissionsWrite = usePermission("commissions.write")
  const canSettings = usePermission("settings.write")
  const [panel, setPanel] = useState<Panel | null>(null)
  const [ticket, setTicket] = useState<{ result: CollectResultBody; patientId: string } | null>(null)
  // Cierre recién hecho: la hoja que se abre lo dice (y si ya estaba cerrada).
  const [justClosed, setJustClosed] = useState<{ id: string; alreadyClosed: boolean } | null>(null)
  // Ticket consultado desde «Movimientos de hoy».
  const [review, setReview] = useState<{ patientId: string; ticketId: string } | null>(null)

  const branchId = sede.branchId ?? sede.branches[0]?.id ?? ""
  const branchName = sede.branches.find((item) => item.id === branchId)?.name ?? ""
  const prof = profile.data?.data ?? null
  const branchZone = useBranchesStatus()
  // La zona de la sede la dice su caja; mientras llega, la de la clínica.
  const cashZone = useCashState(branchId)

  useOrgEvents(FINANCE_EVENT_KINDS, () => invalidateFinance(queryClient))

  const view: FinanceView = search.tab ?? "caja"
  const strip = view === "cierres" ? "caja" : view
  const setSearch = (patch: Partial<FinanceSearch>, replace = false) =>
    void navigate({
      search: (previous) => ({ ...previous, ...patch }),
      replace,
      // Abrir una hoja o cambiar de sección no debe devolver la página arriba.
      resetScroll: false,
    })
  const showView = (next: FinanceView) => setSearch({ tab: next === "caja" ? undefined : next })

  const collect = (patient: CollectTarget | null = null) => setPanel({ kind: "cobrar", patient })
  const ws: Workspace | null =
    prof && branchId
      ? {
          branchId,
          branchName,
          currency: prof.currency,
          locale: prof.locale,
          orgTimeZone: prof.timezone,
          timeZone: cashZone.data?.data.timezone || prof.timezone,
        }
      : null

  // Comisiones: el mes vive en el enlace y el mes en curso no se escribe.
  const thisMonth = prof ? currentMonthIn(prof.timezone) : null
  const period =
    search.year !== undefined && search.month !== undefined
      ? { year: search.year, month: search.month }
      : thisMonth
  const setPeriod = (next: MonthRef) => {
    const isCurrent = thisMonth !== null && compareMonths(next, thisMonth) === 0
    setSearch({
      year: isCurrent ? undefined : next.year,
      month: isCurrent ? undefined : next.month,
    })
  }
  const monthPicker =
    view === "comisiones" && canCommissions && prof && period && thisMonth ? (
      <MonthPicker value={period} onChange={setPeriod} max={thisMonth} locale={prof.locale} />
    ) : null

  const collectButton = (mobile: boolean) =>
    canWrite ? (
      <Button className={mobile ? "h-12 flex-1 text-base" : undefined} onClick={() => collect()}>
        Cobrar
      </Button>
    ) : null
  const closeButton = (mobile: boolean) =>
    canClose ? (
      <Button
        variant="outline"
        className={mobile ? "h-12 flex-1 text-base" : undefined}
        onClick={() => setPanel({ kind: "cerrar" })}
      >
        Cerrar caja
      </Button>
    ) : null
  const expenseButton = (mobile: boolean, primary: boolean) =>
    canWrite ? (
      <Button
        variant={primary ? "default" : "outline"}
        className={mobile ? "h-12 flex-1 text-base" : undefined}
        onClick={() => setPanel({ kind: "gasto" })}
      >
        Registrar gasto
      </Button>
    ) : null

  // Acciones de la sección: en la cabecera cuando caben y, en el teléfono,
  // en una barra siempre a la vista (cobrar y cerrar sin desplazarse).
  const actions = (mobile: boolean) => {
    if (!ws) return null
    if (view === "caja" && (canWrite || canClose)) {
      return (
        <>
          {mobile ? null : expenseButton(false, false)}
          {closeButton(mobile)}
          {collectButton(mobile)}
        </>
      )
    }
    if (view === "gastos" && canWrite) return expenseButton(mobile, true)
    return null
  }
  const headerActions = isMobile ? null : (monthPicker ?? actions(false))
  const mobileActions = isMobile ? actions(true) : null

  return (
    <PageShell className="flex flex-col gap-4">
      <PageHeader
        title="Finanzas"
        subtitle={
          view === "comisiones" ? (
            canCommissionsWrite ? (
              "Lo que le corresponde a cada profesional por lo que atendió y ya se cobró"
            ) : (
              "Mis comisiones"
            )
          ) : sede.branches.length > 0 && branchId ? (
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
        actions={headerActions ?? undefined}
      />

      {profile.isPending || !sede.ready || branchZone.isPending ? (
        <LoadingState message="Preparando la caja…" />
      ) : profile.isError ? (
        isForbidden(profile.error) ? (
          <AccessDenied message={financeErrorMessage(profile.error)} />
        ) : (
          <ErrorState
            title="No se pudo cargar la configuración de la clínica"
            message={financeErrorMessage(profile.error)}
            onRetry={() => void profile.refetch()}
          />
        )
      ) : !prof ? (
        <EmptyState
          title="Falta configurar la clínica"
          description={
            canSettings
              ? "Finanzas necesita la moneda, el formato y la zona horaria de la clínica."
              : "Finanzas necesita la moneda, el formato y la zona horaria de la clínica. Pídeselo a quien la administra."
          }
          actionLabel={canSettings ? "Ir a Configuración" : undefined}
          onAction={canSettings ? () => void navigate({ to: "/settings" }) : undefined}
        />
      ) : !ws ? (
        branchZone.isError ? (
          <ErrorState
            title="No se pudieron cargar las sedes"
            message={financeErrorMessage(branchZone.error)}
            onRetry={branchZone.refetch}
          />
        ) : (
          <EmptyState
            title="Aún no hay sedes activas"
            description={
              canSettings
                ? "La caja trabaja por sede: hace falta al menos una."
                : "La caja trabaja por sede: hace falta al menos una. Pídesela a quien administra la clínica."
            }
            actionLabel={canSettings ? "Ir a Sedes" : undefined}
            onAction={canSettings ? () => void navigate({ to: "/branches" }) : undefined}
          />
        )
      ) : (
        <Tabs
          className="gap-4"
          value={strip}
          onValueChange={(value) => {
            if (isView(value)) showView(value)
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <TabsList aria-label="Secciones de Finanzas">
              <TabsTrigger value="caja">Caja</TabsTrigger>
              <TabsTrigger value="deudas">Deudas</TabsTrigger>
              <TabsTrigger value="gastos">Gastos</TabsTrigger>
              {canCommissions ? <TabsTrigger value="comisiones">Comisiones</TabsTrigger> : null}
            </TabsList>
            {isMobile && monthPicker ? <div className="ml-auto">{monthPicker}</div> : null}
          </div>
          <TabsContent value={strip}>
            {view === "caja" ? (
              <CashTab
                key={ws.branchId}
                ws={ws}
                canWrite={canWrite}
                canClose={canClose}
                expenseShortcut={isMobile}
                onCollect={collect}
                onExpense={() => setPanel({ kind: "gasto" })}
                onCloseCash={() => setPanel({ kind: "cerrar" })}
                onCashMove={() => setPanel({ kind: "efectivo" })}
                onShowDebts={() => showView("deudas")}
                onShowClosures={() => showView("cierres")}
                onOpenTicket={setReview}
              />
            ) : null}
            {view === "comisiones" ? (
              !canCommissions || !period || !thisMonth ? (
                <EmptyState
                  title="Sin acceso a comisiones"
                  description="Tu rol no tiene permiso para ver comisiones. Pide el acceso a la administración de la clínica."
                  actionLabel="Volver a Caja"
                  onAction={() => showView("caja")}
                />
              ) : canCommissionsWrite ? (
                <CommissionsAdminPanel
                  period={period}
                  locale={ws.locale}
                  timeZone={ws.orgTimeZone}
                  selectedId={search.profesional ?? null}
                  onSelect={(professionalUserId) =>
                    setSearch({ profesional: professionalUserId ?? undefined })
                  }
                />
              ) : (
                <MyCommissionsPanel
                  period={period}
                  currentMonth={thisMonth}
                  locale={ws.locale}
                  timeZone={ws.orgTimeZone}
                  onMonthChange={setPeriod}
                />
              )
            ) : null}
            {view === "cierres" ? (
              <ClosuresView
                key={ws.branchId}
                ws={ws}
                canClose={canClose}
                openId={search.cierre ?? null}
                onOpen={(id) => {
                  setJustClosed(null)
                  setSearch({ cierre: id })
                }}
                onBack={() => showView("caja")}
                onCloseCash={() => setPanel({ kind: "cerrar" })}
              />
            ) : null}
            {view === "deudas" ? (
              <DebtsTab key={ws.branchId} ws={ws} canWrite={canWrite} onCollect={collect} />
            ) : null}
            {view === "gastos" ? (
              <ExpensesTab
                key={ws.branchId}
                ws={ws}
                canWrite={canWrite}
                onExpense={() => setPanel({ kind: "gasto" })}
              />
            ) : null}
          </TabsContent>
        </Tabs>
      )}

      {mobileActions ? (
        <div className="sticky bottom-0 z-10 -mx-4 -mb-4 mt-auto flex gap-2 border-t bg-canvas/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:-mx-6 sm:-mb-6 sm:px-6">
          {mobileActions}
        </div>
      ) : null}

      {ws ? (
        <>
          <CollectDrawer
            patientId={panel?.kind === "cobrar" ? (panel.patient?.id ?? null) : null}
            patientName={panel?.kind === "cobrar" ? panel.patient?.name : undefined}
            branchId={ws.branchId}
            currency={ws.currency}
            locale={ws.locale}
            open={panel?.kind === "cobrar"}
            onClose={() => setPanel(null)}
            onCollected={(result, patientId) => {
              invalidateFinance(queryClient)
              setTicket({ result, patientId })
            }}
          />
          <ExpenseFormDrawer
            ws={ws}
            open={panel?.kind === "gasto"}
            onClose={() => setPanel(null)}
          />
          <CashMoveDrawer
            branchId={ws.branchId}
            currency={ws.currency}
            locale={ws.locale}
            open={panel?.kind === "efectivo"}
            onClose={() => setPanel(null)}
          />
          <CashCloseDrawer
            branchId={ws.branchId}
            branchName={ws.branchName}
            currency={ws.currency}
            locale={ws.locale}
            timeZone={ws.timeZone}
            open={panel?.kind === "cerrar"}
            onClose={() => setPanel(null)}
            onClosed={(windowId, alreadyClosed) => {
              setJustClosed({ id: windowId, alreadyClosed })
              setSearch({ cierre: windowId })
            }}
          />
        </>
      ) : null}

      {prof ? (
        <ClosureSheetDrawer
          closureId={search.cierre ?? null}
          locale={prof.locale}
          orgTimeZone={prof.timezone}
          notice={
            justClosed && justClosed.id === search.cierre
              ? justClosed.alreadyClosed
                ? "Esta caja ya la había cerrado otra persona: esta es la hoja de ese cierre y lo que contaste no se guardó."
                : "Caja cerrada. Imprime la hoja para firmar la entrega."
              : null
          }
          onClose={() => {
            setJustClosed(null)
            setSearch({ cierre: undefined }, true)
          }}
        />
      ) : null}

      {prof ? (
        <TicketReviewDrawer
          target={review}
          locale={prof.locale}
          timeZone={ws?.timeZone ?? prof.timezone}
          ticketFooter={prof.ticketFooter}
          onClose={() => setReview(null)}
          onChanged={() => invalidateFinance(queryClient)}
        />
      ) : null}

      <DetailDrawer
        open={ticket !== null}
        onClose={() => setTicket(null)}
        title={
          ticket
            ? `Cobro registrado · Ticket ${ticketDisplayNumber(ticket.result.ticket.ticketNumber)}`
            : "Cobro registrado"
        }
      >
        {ticket && prof ? (
          <TicketView
            ticket={ticket.result.ticket}
            remainingCents={ticket.result.remainingCents}
            patientName={ticket.result.ticket.snapshot.patient.displayName}
            branchName={ticket.result.ticket.snapshot.branch.name}
            locale={prof.locale}
            timeZone={ws?.timeZone ?? prof.timezone}
            receiptWidth={prof.receiptWidth}
            ticketFooter={prof.ticketFooter}
            onChanged={() => {
              invalidateFinance(queryClient)
              void queryClient.invalidateQueries({ queryKey: ["patient-account3", ticket.patientId] })
            }}
          />
        ) : null}
      </DetailDrawer>
    </PageShell>
  )
}

// --- Piezas compartidas ---------------------------------------------------------------

/** Confirmación de una anulación: siempre en cajón y siempre con motivo. */
function VoidDrawer({
  open,
  title,
  description,
  isSubmitting,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  description: string
  isSubmitting: boolean
  error: string | null
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const fieldId = useId()
  const [reason, setReason] = useState("")
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (!open) return
    setReason("")
    setMissing(false)
  }, [open])

  return (
    <FormDrawer
      dock={false}
      open={open}
      title={title}
      description={description}
      error={missing ? "Escribe el motivo de la anulación." : error}
      isSubmitting={isSubmitting}
      isDirty={reason !== ""}
      submitLabel="Anular"
      cancelLabel="No anular"
      onClose={() => {
        if (!isSubmitting) onClose()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        if (!reason.trim()) {
          setMissing(true)
          return
        }
        setMissing(false)
        onConfirm(reason.trim())
      }}
    >
      <Field>
        <FieldLabel htmlFor={fieldId}>Motivo</FieldLabel>
        <Textarea
          id={fieldId}
          maxLength={2000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
    </FormDrawer>
  )
}

/** Ticket ya emitido, abierto desde su renglón: se lee completo del servidor. */
function TicketReviewDrawer({
  target,
  locale,
  timeZone,
  ticketFooter,
  onClose,
  onChanged,
}: {
  target: { patientId: string; ticketId: string } | null
  locale: string
  timeZone: string
  ticketFooter: string | null
  onClose: () => void
  onChanged: () => void
}) {
  const queryClient = useQueryClient()
  const receipt = useQuery({
    queryKey: ["ticket-receipt", target?.patientId ?? "", target?.ticketId ?? ""],
    queryFn: () => fetchTicketReceipt(target?.patientId ?? "", target?.ticketId ?? ""),
    enabled: target !== null,
  })
  const row = target ? (receipt.data?.data.ticket ?? null) : null
  return (
    <DetailDrawer
      open={target !== null}
      onClose={onClose}
      title={row ? `Ticket ${ticketDisplayNumber(row.ticketNumber)}` : "Ticket"}
      isLoading={target !== null && receipt.isPending}
      showClose={!row}
    >
      {receipt.isError ? (
        <ErrorState
          title="No se pudo abrir el ticket"
          message={financeErrorMessage(receipt.error)}
          onRetry={() => void receipt.refetch()}
        />
      ) : row && target ? (
        <TicketView
          key={row.id}
          ticket={row}
          remainingCents={0}
          patientName={row.snapshot.patient.displayName}
          branchName={row.snapshot.branch.name}
          locale={locale}
          timeZone={timeZone}
          ticketFooter={ticketFooter}
          mode="review"
          onDone={onClose}
          onChanged={() => {
            onChanged()
            void receipt.refetch()
            void queryClient.invalidateQueries({ queryKey: ["patient-account3", target.patientId] })
          }}
        />
      ) : null}
    </DetailDrawer>
  )
}

/** Una persona que debe: quién, qué, desde cuándo, cuánto y qué se puede hacer. */
function DebtLine({
  row,
  locale,
  detail,
  badge,
  canWrite,
  onMessage,
  onCollect,
}: {
  row: DebtRow
  locale: string
  detail: string
  badge?: string
  canWrite: boolean
  /**
   * «Escribirle» (solo en Deudas y con permiso de conversaciones): abre su
   * conversación abierta o, si no tiene, deja elegir por dónde escribirle.
   */
  onMessage?: (row: DebtRow) => void
  onCollect: (patient: CollectTarget) => void
}) {
  const { dueCents, creditUsedCents } = debtDue(row)
  const name = row.displayName || "Paciente sin nombre"
  const money = (cents: number) => formatMoney(cents, row.currency, locale)
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-56">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            to="/patients/$patientId"
            params={{ patientId: row.patientId }}
            search={{ tab: "cuenta" }}
            className="text-base font-medium underline-offset-4 hover:underline"
          >
            {name}
          </Link>
          {badge ? <Badge variant="warning">{badge}</Badge> : null}
        </p>
        <p className="text-sm text-muted-foreground">{debtConcepts(row)}</p>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <div className="text-right">
          <p className="text-base font-semibold tabular-nums">{money(dueCents)}</p>
          {creditUsedCents > 0 ? (
            <p className="text-xs text-muted-foreground">
              {plainAmount(row.totalCents, row.currency, locale)} menos{" "}
              {plainAmount(creditUsedCents, row.currency, locale)} a favor
            </p>
          ) : null}
        </div>
        {onMessage && row.conversationId ? (
          <Button
            variant="ghost"
            nativeButton={false}
            aria-label={`Escribirle a ${name}`}
            render={<Link to="/inbox" search={{ conversation: row.conversationId }} />}
          >
            Escribirle
          </Button>
        ) : onMessage && row.contactId ? (
          <Button variant="ghost" aria-label={`Escribirle a ${name}`} onClick={() => onMessage(row)}>
            Escribirle
          </Button>
        ) : null}
        {canWrite ? (
          <Button aria-label={`Cobrar a ${name}`} onClick={() => onCollect({ id: row.patientId, name })}>
            Cobrar
          </Button>
        ) : null}
      </div>
    </li>
  )
}

function debtTotalsText(rows: DebtRow[], locale: string): string {
  return totalsByCurrency(rows.map((row) => ({ currency: row.currency, cents: debtDue(row).dueCents })))
    .map(([unit, cents]) => formatMoney(cents, unit, locale))
    .join(" · ")
}

function byOldest(a: DebtRow, b: DebtRow): number {
  return (
    (a.oldestSince ? Date.parse(a.oldestSince) : Number.POSITIVE_INFINITY) -
    (b.oldestSince ? Date.parse(b.oldestSince) : Number.POSITIVE_INFINITY)
  )
}

// --- Caja -----------------------------------------------------------------------------

/** «Quedó … + cobros … − gastos …»: solo los términos que no valen cero. */
function breakdownLine(breakdown: CashBreakdown, plain: (cents: number) => string): string | null {
  const terms = CASH_TERMS.filter((term) => breakdown[term.key] !== 0)
  if (terms.length === 0) return null
  return terms
    .map((term, index) => {
      const sign = term.sign < 0 ? "− " : index === 0 ? "" : "+ "
      const word = index === 0 ? upperFirst(term.short) : term.short
      return `${sign}${word} ${plain(breakdown[term.key])}`
    })
    .join(" ")
}

function CashTab({
  ws,
  canWrite,
  canClose,
  expenseShortcut,
  onCollect,
  onExpense,
  onCloseCash,
  onCashMove,
  onShowDebts,
  onShowClosures,
  onOpenTicket,
}: {
  ws: Workspace
  canWrite: boolean
  canClose: boolean
  onOpenTicket: (target: { patientId: string; ticketId: string }) => void
  /** En el teléfono «Registrar gasto» no cabe en la barra: va junto a los movimientos. */
  expenseShortcut: boolean
  onCollect: (patient?: CollectTarget | null) => void
  onExpense: () => void
  onCloseCash: () => void
  onCashMove: () => void
  onShowDebts: () => void
  onShowClosures: () => void
}) {
  const { branchId, locale, timeZone } = ws
  const queryClient = useQueryClient()
  const today = todayIn(timeZone)
  const cash = useCashState(branchId)
  const movements = useQuery({
    queryKey: financeKeys.movements(branchId, today),
    queryFn: () => fetchDayMovements(branchId, today),
  })
  const debts = useQuery({
    queryKey: financeKeys.debts(branchId),
    queryFn: () => fetchDebts(branchId),
  })
  const [voiding, setVoiding] = useState<DayEntry | null>(null)
  const [voidError, setVoidError] = useState<string | null>(null)
  const [earlierOpen, setEarlierOpen] = useState(false)

  const state = cash.data?.data ?? null
  const dayBody = movements.data?.data ?? null
  // La zona con que el servidor partió el día (la de la sede) manda al mostrar horas.
  const zone = dayBody?.timezone ?? timeZone
  const money = (cents: number) => formatMoney(cents, state?.currency ?? ws.currency, locale)
  // Importes secundarios: sin símbolo; el principal de cada bloque lo lleva.
  const plain = (cents: number) => plainAmount(cents, state?.currency ?? ws.currency, locale)

  // «Días sin cerrar» compara dos consultas: se decide solo con ambas quietas,
  // para que una a medio recargar no encienda el aviso por un instante.
  const settled = state !== null && dayBody !== null && !cash.isFetching && !movements.isFetching
  useEffect(() => {
    if (settled && state && dayBody) setEarlierOpen(hasEarlierDaysOpen(state, dayBody.movements))
  }, [settled, state, dayBody])

  const voidMutation = useMutation({
    mutationFn: (input: { id: string; reason: string }) => voidCashMovementApi(input.id, input.reason),
    onSuccess: () => {
      invalidateFinance(queryClient)
      toast.success("Movimiento anulado")
      setVoiding(null)
      setVoidError(null)
    },
    onError: (err) => setVoidError(cashErrorMessage(err)),
  })

  const entries = useMemo(
    () => groupDayMovements(dayBody?.movements ?? [], dayBody?.voidedTickets ?? []),
    [dayBody],
  )
  const debtRows = debts.data?.data ?? []
  const { attended, earlier } = useMemo(() => {
    const todayRows: Array<{ row: DebtRow; at: string }> = []
    const before: DebtRow[] = []
    for (const row of debtRows) {
      const at = attendedTodayAt(row, zone, today)
      if (at) todayRows.push({ row, at })
      else before.push(row)
    }
    todayRows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    before.sort(byOldest)
    return { attended: todayRows, earlier: before }
  }, [debtRows, zone, today])

  if (
    (cash.isError && isForbidden(cash.error)) ||
    (movements.isError && isForbidden(movements.error)) ||
    (debts.isError && isForbidden(debts.error))
  ) {
    return <AccessDenied message={financeErrorMessage(cash.error ?? movements.error ?? debts.error)} />
  }

  const last = state?.lastClosure ?? null
  const reference = last?.closedAt ?? state?.openedAt ?? null
  const unclosedSince =
    earlierOpen && reference && dayKeyOf(reference, zone) < today
      ? spokenMoment(reference, locale, zone)
      : null
  const closedToday = last !== null && dayKeyOf(last.closedAt, zone) === today
  const others = otherMethods(state?.byMethod ?? [])
  const collected = (state?.byMethod ?? []).reduce((total, row) => total + row.amountCents, 0)
  const line = state ? breakdownLine(state.breakdown, plain) : null
  const ticketCount = entries.filter((entry) => entry.type === "cobro" && !entry.voided).length
  const expenseCount = entries.filter((entry) => entry.type === "gasto").length
  const openedDay = state?.openedAt ? spokenMoment(state.openedAt, locale, zone) : null

  return (
    <div className="flex flex-col gap-4">
      {unclosedSince ? (
        <Alert role="status" className="border-transparent bg-warning-soft">
          <AlertTitle>
            {last
              ? `La caja no se cierra desde ${momentDay(unclosedSince)}`
              : `La caja tiene movimientos sin cerrar desde ${momentDay(unclosedSince)}`}
          </AlertTitle>
          <AlertDescription className="text-foreground/80">
            Puedes seguir cobrando sin problema. Al cerrar se contará todo el efectivo recibido
            desde entonces.
          </AlertDescription>
          {canClose ? (
            <Button className="mt-2 justify-self-start" onClick={onCloseCash}>
              Cerrar caja ahora
            </Button>
          ) : null}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="text-sm text-muted-foreground">
          {cash.isPending ? (
            <Skeleton className="h-4 w-56" />
          ) : last ? (
            `Último cierre: ${momentShort(spokenMoment(last.closedAt, locale, zone))}, ${lowerFirst(differenceLabel(last.differenceCents, money))}`
          ) : state ? (
            "Esta caja aún no tiene cierres."
          ) : null}
        </div>
        <Button variant="link" className="h-auto p-0" onClick={onShowClosures}>
          Cierres anteriores
        </Button>
      </div>

      {cash.isPending ? (
        <div role="status" aria-busy aria-label="Consultando la caja" className="flex flex-wrap gap-3">
          <Skeleton className="h-32 grow-[2] basis-full rounded-xl sm:basis-80" />
          <Skeleton className="h-32 min-w-36 flex-1 rounded-xl" />
          <Skeleton className="h-32 min-w-36 flex-1 rounded-xl" />
        </div>
      ) : cash.isError || !state ? (
        <ErrorState
          title="No se pudo consultar la caja"
          message={cashErrorMessage(cash.error)}
          onRetry={() => void cash.refetch()}
        />
      ) : (
        <section aria-labelledby="caja-efectivo" className="flex flex-wrap gap-3">
          <div className="elevated min-w-0 grow-[2] basis-full rounded-xl border bg-card p-4 sm:basis-80 sm:p-5">
            <h2 id="caja-efectivo" className="text-sm font-medium text-muted-foreground">
              Efectivo en caja
            </h2>
            <p className="mt-1 text-3xl leading-tight font-bold tracking-tight tabular-nums">
              {money(state.cashOnHandCents)}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {line ??
                (state.shiftId
                  ? "Sin efectivo desde el último cierre."
                  : "La caja se abre sola con el primer cobro.")}
            </p>
          </div>
          {others.map((row) => (
            <div key={row.name} className="elevated min-w-36 flex-1 rounded-xl border bg-card p-4 sm:p-5">
              <p className="truncate text-sm font-medium text-muted-foreground">{row.name}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{money(row.amountCents)}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {plural(row.count, "cobro", "cobros")}
                {row.refundedCents > 0 ? ` · devuelto ${money(row.refundedCents)}` : ""}
              </p>
            </div>
          ))}
          <div className="elevated min-w-36 flex-1 rounded-xl border bg-card p-4 sm:p-5">
            <p className="text-sm font-medium text-muted-foreground">
              {unclosedSince || closedToday ? "Cobrado desde el último cierre" : "Cobrado hoy"}
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{money(collected)}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {plural(state.tickets, "ticket", "tickets")}
            </p>
          </div>
        </section>
      )}

      <section aria-labelledby="caja-por-cobrar" className="elevated rounded-xl border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 id="caja-por-cobrar" className="font-heading text-base font-medium">
            Por cobrar
          </h2>
          {debtRows.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              {plural(debtRows.length, "persona", "personas")} · {debtTotalsText(debtRows, locale)}
            </p>
          ) : null}
        </div>
        {debts.isPending ? (
          <div className="mt-3">
            <DataTableSkeleton view="list" rowCount={3} label="Consultando quién debe" />
          </div>
        ) : debts.isError ? (
          <ErrorState
            className="mt-3"
            title="No se pudo consultar quién debe"
            message={financeErrorMessage(debts.error)}
            onRetry={() => void debts.refetch()}
          />
        ) : debtRows.length === 0 ? (
          <EmptyState
            className="mt-3"
            title="Nadie debe por ahora"
            description="Cuando se cierre una atención con costo, la persona aparece aquí sola."
            actionLabel={canWrite ? "Cobrar un adelanto" : undefined}
            onAction={canWrite ? () => onCollect() : undefined}
          />
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            {attended.length > 0 ? (
              <div>
                <h3 className="pt-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Atendidos hoy
                </h3>
                <ul className="divide-y">
                  {attended.map(({ row, at }) => {
                    const left =
                      row.lastAttended?.at === at
                        ? `Salió a las ${formatClock(at, locale, zone)}${row.lastAttended.dentistName ? ` · ${row.lastAttended.dentistName}` : ""}`
                        : `Anotado hoy a las ${formatClock(at, locale, zone)}`
                    const older =
                      row.oldestSince && dayKeyOf(row.oldestSince, zone) < today
                        ? ` · también debe desde el ${formatDayMonth(row.oldestSince, locale, zone)}`
                        : ""
                    return (
                      <DebtLine
                        key={`${row.patientId}-${row.currency}`}
                        row={row}
                        locale={locale}
                        detail={`${left}${older}`}
                        canWrite={canWrite}
                        onCollect={onCollect}
                      />
                    )
                  })}
                </ul>
              </div>
            ) : null}
            {earlier.length > 0 ? (
              <div>
                <h3 className="pt-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Deben de antes
                </h3>
                <ul className="divide-y">
                  {earlier.slice(0, CASH_EARLIER_LIMIT).map((row) => (
                    <DebtLine
                      key={`${row.patientId}-${row.currency}`}
                      row={row}
                      locale={locale}
                      detail={
                        row.oldestSince
                          ? `Debe desde el ${formatDayMonth(row.oldestSince, locale, zone)}`
                          : "Debe de antes"
                      }
                      canWrite={canWrite}
                      onCollect={onCollect}
                    />
                  ))}
                </ul>
                {earlier.length > CASH_EARLIER_LIMIT ? (
                  <Button variant="link" className="mt-1 h-auto p-0" onClick={onShowDebts}>
                    Ver las {earlier.length - CASH_EARLIER_LIMIT} que faltan
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section aria-labelledby="caja-movimientos" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div>
            <h2 id="caja-movimientos" className="font-heading text-base font-medium">
              Movimientos de hoy
            </h2>
            {entries.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                {plural(ticketCount, "ticket", "tickets")} · {plural(expenseCount, "gasto", "gastos")}
              </p>
            ) : null}
          </div>
          {canWrite ? (
            <div className="flex flex-wrap gap-2">
              {expenseShortcut ? (
                <Button variant="outline" size="sm" onClick={onExpense}>
                  Registrar gasto
                </Button>
              ) : null}
              <Button variant="outline" size="sm" onClick={onCashMove}>
                Ingresar o retirar efectivo
              </Button>
            </div>
          ) : null}
        </div>
        {movements.isPending ? (
          <DataTableSkeleton view="list" rowCount={4} label="Consultando los movimientos de hoy" />
        ) : movements.isError ? (
          <ErrorState
            title="No se pudieron consultar los movimientos"
            message={financeErrorMessage(movements.error)}
            onRetry={() => void movements.refetch()}
          />
        ) : entries.length === 0 ? (
          <EmptyState
            title="Sin movimientos hoy"
            description="Los cobros, los gastos y el efectivo que entra o sale hoy aparecen aquí."
            actionLabel={canWrite ? "Cobrar" : undefined}
            onAction={canWrite ? () => onCollect() : undefined}
          />
        ) : (
          <ul className="divide-y rounded-xl border bg-card">
            {entries.map((entry) => (
              <MovementLine
                key={entry.key}
                entry={entry}
                locale={locale}
                timeZone={zone}
                onOpenTicket={onOpenTicket}
                onVoid={
                  canWrite && (entry.type === "aporte" || entry.type === "retiro")
                    ? () => {
                        setVoidError(null)
                        setVoiding(entry)
                      }
                    : undefined
                }
              />
            ))}
          </ul>
        )}
        {state && state.breakdown.openingCents > 0 ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border bg-card px-4 py-3">
            <span className="w-14 shrink-0 text-sm text-muted-foreground">
              {openedDay
                ? openedDay.relative
                  ? upperFirst(openedDay.relative)
                  : formatDayShort(state.openedAt as string, locale, zone)
                : ""}
            </span>
            <div className="min-w-0 flex-1 basis-40">
              <p className="font-medium">Quedó del cierre anterior</p>
              <p className="text-sm text-muted-foreground">Lo que se dejó en caja</p>
            </div>
            <span className="ml-auto font-medium tabular-nums">{money(state.breakdown.openingCents)}</span>
          </div>
        ) : null}
      </section>

      <VoidDrawer
        open={voiding !== null}
        title={voiding?.type === "aporte" ? "Anular ingreso de efectivo" : "Anular retiro de efectivo"}
        description="Queda en el historial con su motivo y deja de contar en la caja."
        isSubmitting={voidMutation.isPending}
        error={voidError}
        onClose={() => {
          setVoiding(null)
          setVoidError(null)
        }}
        onConfirm={(reason) => {
          if (voiding && voiding.type !== "cobro") {
            setVoidError(null)
            voidMutation.mutate({ id: voiding.movementId, reason })
          }
        }}
      />
    </div>
  )
}

/** Renglón de «Movimientos de hoy», dicho con palabras: nunca el código del movimiento. */
function MovementLine({
  entry,
  locale,
  timeZone,
  onOpenTicket,
  onVoid,
}: {
  entry: DayEntry
  locale: string
  timeZone: string
  onOpenTicket: (target: { patientId: string; ticketId: string }) => void
  /** Solo los ingresos y retiros hechos a mano se anulan desde aquí. */
  onVoid?: () => void
}) {
  const money = (cents: number) => formatMoney(cents, entry.currency, locale)
  let title: React.ReactNode
  let subtitle: string
  let amountCents: number
  let leaves = false
  let open: (() => void) | null = null
  const voided = entry.type === "cobro" ? entry.voided : null
  if (entry.type === "cobro") {
    const { patientId, ticketId } = entry
    if (patientId && ticketId) open = () => onOpenTicket({ patientId, ticketId })
    const name = entry.patientName || "Cobro"
    title = entry.patientId ? (
      <Link
        to="/patients/$patientId"
        params={{ patientId: entry.patientId }}
        search={{ tab: "cuenta" }}
        className="underline-offset-4 hover:underline"
      >
        {name}
      </Link>
    ) : (
      name
    )
    const methods =
      entry.parts.length === 1
        ? (entry.parts[0].method ?? "Medio sin nombre")
        : joinList(
            entry.parts.map(
              (part) =>
                `${part.method ?? "Otro medio"} ${plainAmount(part.amountCents, entry.currency, locale)}`,
            ),
            locale,
          )
    subtitle = `${entry.ticketNumber !== null ? `Ticket ${ticketDisplayNumber(entry.ticketNumber)}` : "Cobro sin ticket"} · ${methods}`
    amountCents = entry.totalCents
  } else {
    amountCents = entry.amountCents
    leaves = entry.type !== "aporte"
    if (entry.type === "gasto") {
      title = `Gasto: ${entry.concept}`
      subtitle = entry.fromCash ? "Salió del efectivo" : `Pagado con ${entry.method ?? "otro medio"}`
    } else if (entry.type === "aporte") {
      title = "Ingreso de efectivo"
      subtitle = entry.concept
    } else if (entry.type === "retiro") {
      title = "Retiro de efectivo"
      subtitle = entry.concept
    } else {
      title = "Devolución"
      subtitle = `${entry.concept} · ${entry.fromCash ? "Salió del efectivo" : `Devuelto por ${entry.method ?? "otro medio"}`}`
    }
  }
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
      <time dateTime={entry.at} className="w-14 shrink-0 text-sm text-muted-foreground tabular-nums">
        {formatClock(entry.at, locale, timeZone)}
      </time>
      <div className="min-w-0 flex-1 basis-40">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium break-words">
          <span className={cn(voided && "text-muted-foreground line-through")}>{title}</span>
          {voided ? <Badge variant="destructive">Anulado</Badge> : null}
        </p>
        <p className="text-sm break-words text-muted-foreground">{subtitle}</p>
        {voided ? (
          <p className="text-sm break-words text-muted-foreground">
            {voided.reason ? `Motivo: ${voided.reason}. ` : ""}No suma en la caja.
          </p>
        ) : null}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <span
          className={cn(
            "font-medium tabular-nums",
            leaves && "text-destructive",
            voided && "text-muted-foreground line-through",
          )}
        >
          {leaves ? "− " : ""}
          {money(amountCents)}
        </span>
        {open ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={
              entry.type === "cobro" && entry.ticketNumber !== null
                ? `Ver el ticket ${ticketDisplayNumber(entry.ticketNumber)}`
                : "Ver el ticket"
            }
            onClick={open}
          >
            Ver ticket
          </Button>
        ) : null}
        {onVoid ? (
          <Button variant="ghost" size="sm" onClick={onVoid}>
            Anular
          </Button>
        ) : null}
      </div>
    </li>
  )
}

// --- Cierres anteriores ------------------------------------------------------------------

function ClosuresView({
  ws,
  canClose,
  openId,
  onOpen,
  onBack,
  onCloseCash,
}: {
  ws: Workspace
  canClose: boolean
  /** Cierre cuya hoja está abierta, para marcarlo en la lista. */
  openId: string | null
  onOpen: (id: string) => void
  onBack: () => void
  onCloseCash: () => void
}) {
  const { branchId, locale, timeZone } = ws
  const closures = useInfiniteQuery({
    queryKey: financeKeys.closures(branchId),
    queryFn: ({ pageParam }) => fetchClosures(branchId, pageParam),
    initialPageParam: null as string | null,
    // Hay más mientras la página llegue completa: sigue desde su último cierre.
    getNextPageParam: (last) =>
      last.data.length === CLOSURES_PAGE ? (last.data.at(-1)?.closedAt ?? undefined) : undefined,
  })
  const rows = closures.data?.pages.flatMap((page) => page.data) ?? []

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
          <ArrowLeft aria-hidden />
          Volver a Caja
        </Button>
      </div>
      <h2 className="font-heading text-base font-medium">Cierres anteriores</h2>
      {closures.isPending ? (
        <DataTableSkeleton view="list" rowCount={4} label="Consultando los cierres" />
      ) : closures.isError ? (
        isForbidden(closures.error) ? (
          <AccessDenied message={financeErrorMessage(closures.error)} />
        ) : (
          <ErrorState
            title="No se pudieron consultar los cierres"
            message={financeErrorMessage(closures.error)}
            onRetry={() => void closures.refetch()}
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          title="Aún no hay cierres en esta sede"
          description="Cada vez que se cierra la caja queda aquí su hoja, con lo contado y lo entregado."
          actionLabel={canClose ? "Cerrar caja" : undefined}
          onAction={canClose ? onCloseCash : undefined}
        />
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {rows.map((row) => {
            const money = (cents: number | null) =>
              cents === null ? "—" : plainAmount(cents, row.currency, locale)
            const when = formatDateTimeLong(row.closedAt, locale, timeZone)
            return (
              <li
                key={row.id}
                aria-current={openId === row.id ? "true" : undefined}
                className={cn(
                  "flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3",
                  openId === row.id && "bg-muted/60",
                )}
              >
                <div className="min-w-0 flex-1 basis-64">
                  <p className="text-base font-medium">{when}</p>
                  <p className="text-sm text-muted-foreground">
                    {row.closedByName ?? "Sin registro de quién cerró"} · debía haber{" "}
                    {money(row.expectedCents)} · contó {money(row.countedCents)}
                  </p>
                </div>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
                  <div className="text-right text-sm">
                    <p
                      className={cn(
                        "font-medium",
                        row.differenceCents === 0 ? "text-success" : "text-destructive",
                      )}
                    >
                      {row.differenceCents === null
                        ? "Sin dato de la diferencia"
                        : differenceLabel(row.differenceCents, (cents) => money(cents))}
                    </p>
                    <p className="text-muted-foreground">
                      {row.deliveredCents === null
                        ? "Sin dato de lo entregado"
                        : `Entregó ${money(row.deliveredCents)}`}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Ver la hoja del cierre del ${when}`}
                    onClick={() => onOpen(row.id)}
                  >
                    Ver hoja
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {closures.hasNextPage ? (
        <div>
          <Button
            variant="outline"
            disabled={closures.isFetchingNextPage}
            aria-busy={closures.isFetchingNextPage}
            onClick={() => void closures.fetchNextPage()}
          >
            Ver cierres más antiguos
          </Button>
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Un cierre no se edita. Lo que se corrija después queda como movimiento del día en que se
        corrige.
      </p>
    </div>
  )
}

// --- Deudas -------------------------------------------------------------------------------

type DebtFilter = "todas" | "30" | "90"

function DebtsTab({
  ws,
  canWrite,
  onCollect,
}: {
  ws: Workspace
  canWrite: boolean
  onCollect: (patient?: CollectTarget | null) => void
}) {
  const { branchId, locale, timeZone } = ws
  const canMessage = usePermission("conversations.read")
  const [filter, setFilter] = useState<DebtFilter>("todas")
  const [expanded, setExpanded] = useState(false)
  // Sin conversación abierta: se elige por dónde escribirle.
  const [writeTo, setWriteTo] = useState<DebtRow | null>(null)
  const debts = useQuery({
    queryKey: financeKeys.debts(branchId),
    queryFn: () => fetchDebts(branchId),
  })
  const today = todayIn(timeZone)
  const all = useMemo(
    () =>
      [...(debts.data?.data ?? [])]
        .sort(byOldest)
        .map((row) => ({ row, days: debtAgeDays(row, timeZone, today) })),
    [debts.data, timeZone, today],
  )

  if (debts.isError && isForbidden(debts.error)) {
    return <AccessDenied message={financeErrorMessage(debts.error)} />
  }

  const over30 = all.filter((item) => (item.days ?? 0) > 30)
  const over90 = all.filter((item) => (item.days ?? 0) > 90)
  const visible = filter === "30" ? over30 : filter === "90" ? over90 : all
  const shown = expanded ? visible : visible.slice(0, DEBTS_PAGE)
  const filters: Array<{ value: DebtFilter; label: string; count: number }> = [
    { value: "todas", label: "Todas", count: all.length },
    { value: "30", label: "Más de 30 días", count: over30.length },
    { value: "90", label: "Más de 90 días", count: over90.length },
  ]

  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="deudas-total" className="elevated rounded-xl border bg-card p-4 sm:p-5">
        <h2 id="deudas-total" className="text-sm font-medium text-muted-foreground">
          Por cobrar en total
          {debts.isSuccess ? ` · ${plural(all.length, "persona", "personas")}` : ""}
        </h2>
        {debts.isPending ? (
          <Skeleton className="mt-2 h-9 w-48" />
        ) : debts.isError ? null : (
          <p className="mt-1 text-3xl leading-tight font-bold tracking-tight tabular-nums">
            {all.length > 0
              ? debtTotalsText(
                  all.map((item) => item.row),
                  locale,
                )
              : formatMoney(0, ws.currency, locale)}
          </p>
        )}
      </section>

      <div role="group" aria-label="Antigüedad de la deuda" className="flex flex-wrap gap-2">
        {filters.map((option) => (
          <Button
            key={option.value}
            size="sm"
            variant={filter === option.value ? "default" : "outline"}
            aria-pressed={filter === option.value}
            onClick={() => {
              setFilter(option.value)
              setExpanded(false)
            }}
          >
            {option.label}
            {debts.isSuccess ? ` · ${option.count}` : ""}
          </Button>
        ))}
      </div>

      {debts.isPending ? (
        <DataTableSkeleton view="list" rowCount={5} label="Consultando las deudas" />
      ) : debts.isError ? (
        <ErrorState
          title="No se pudieron consultar las deudas"
          message={financeErrorMessage(debts.error)}
          onRetry={() => void debts.refetch()}
        />
      ) : all.length === 0 ? (
        <EmptyState
          title="Nadie debe por ahora"
          description="Cuando se cierre una atención con costo, la persona aparece aquí sola."
          actionLabel={canWrite ? "Cobrar un adelanto" : undefined}
          onAction={canWrite ? () => onCollect() : undefined}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title={`Nadie debe desde hace más de ${filter} días`}
          description="Las deudas más recientes siguen en «Todas»."
          actionLabel="Ver todas"
          onAction={() => setFilter("todas")}
        />
      ) : (
        <div className="rounded-xl border bg-card px-4">
          <ul className="divide-y">
            {shown.map(({ row, days }) => (
              <DebtLine
                key={`${row.patientId}-${row.currency}`}
                row={row}
                locale={locale}
                badge={days !== null && days > 90 ? "Más de 90 días" : undefined}
                detail={
                  row.oldestSince
                    ? `Debe desde el ${formatDayMonth(row.oldestSince, locale, timeZone)}${
                        days === null
                          ? ""
                          : days === 0
                            ? ", desde hoy"
                            : `, hace ${plural(days, "día", "días")}`
                      }`
                    : "Sin fecha registrada"
                }
                canWrite={canWrite}
                onMessage={canMessage ? setWriteTo : undefined}
                onCollect={onCollect}
              />
            ))}
          </ul>
          {visible.length > shown.length ? (
            <div className="border-t py-2">
              <Button variant="link" className="h-auto p-0" onClick={() => setExpanded(true)}>
                Ver las {visible.length - shown.length} que faltan
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        Lo aceptado en un presupuesto que todavía no se atiende no aparece aquí: no es deuda.
      </p>

      <ContactConversationDialog
        open={writeTo !== null}
        onClose={() => setWriteTo(null)}
        contacts={
          writeTo?.contactId
            ? [{ contactId: writeTo.contactId, displayName: writeTo.displayName }]
            : []
        }
      />
    </div>
  )
}

// --- Gastos -------------------------------------------------------------------------------

function receiptText(row: ExpenseRow): string | null {
  const kind = row.receiptKind && row.receiptKind !== NO_RECEIPT ? row.receiptKind : ""
  const number = row.receiptNumber ?? ""
  if (kind) return number ? `${kind} ${number}` : kind
  return number ? `comprobante ${number}` : null
}

function ExpensesTab({
  ws,
  canWrite,
  onExpense,
}: {
  ws: Workspace
  canWrite: boolean
  onExpense: () => void
}) {
  const { branchId, locale, orgTimeZone } = ws
  const queryClient = useQueryClient()
  const thisMonth = currentMonthIn(orgTimeZone)
  const [month, setMonth] = useState<MonthRef>(thisMonth)
  const [voiding, setVoiding] = useState<ExpenseRow | null>(null)
  const [voidError, setVoidError] = useState<string | null>(null)
  const expenses = useQuery({
    queryKey: financeKeys.expenses(branchId, month),
    queryFn: () => fetchMonthExpenses({ branchId, ...month }),
  })
  const voidMutation = useMutation({
    mutationFn: (input: { id: string; reason: string }) => voidExpenseApi(input.id, input.reason),
    onSuccess: () => {
      invalidateFinance(queryClient)
      toast.success("Gasto anulado")
      setVoiding(null)
      setVoidError(null)
    },
    onError: (err) => setVoidError(cashErrorMessage(err)),
  })

  const data = expenses.data?.data ?? null
  const zone = data?.timezone ?? orgTimeZone
  const days = useMemo(() => {
    const groups: Array<{ day: string; rows: ExpenseRow[] }> = []
    for (const row of data?.expenses ?? []) {
      const day = dayKeyOf(row.spentAt, zone)
      const group = groups.at(-1)
      if (group && group.day === day) group.rows.push(row)
      else groups.push({ day, rows: [row] })
    }
    return groups
  }, [data, zone])
  const recent = monthsBack(thisMonth, EXPENSE_MONTHS)
  const options = recent.some((item) => monthValue(item) === monthValue(month))
    ? recent
    : [month, ...recent]

  if (expenses.isError && isForbidden(expenses.error)) {
    return <AccessDenied message={financeErrorMessage(expenses.error)} />
  }

  const monthName = formatMonthName(month, locale)

  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="gastos-total" className="elevated rounded-xl border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="gastos-total" className="text-sm font-medium text-muted-foreground">
              Gastado en {monthName}
            </h2>
            {expenses.isPending ? (
              <Skeleton className="mt-2 h-9 w-48" />
            ) : data ? (
              <p className="mt-1 text-3xl leading-tight font-bold tracking-tight tabular-nums">
                {formatMoney(data.totalCents, data.currency, locale)}
              </p>
            ) : null}
          </div>
          <Field className="w-full sm:w-56">
            <FieldLabel htmlFor="gastos-mes">Mes</FieldLabel>
            <ChoiceSelect
              id="gastos-mes"
              value={monthValue(month)}
              onChange={(event) => {
                const next = parseMonthValue(event.target.value)
                if (next) setMonth(next)
              }}
            >
              {options.map((item) => (
                <option key={monthValue(item)} value={monthValue(item)}>
                  {formatMonth(item, locale)}
                </option>
              ))}
            </ChoiceSelect>
          </Field>
        </div>
        {data && data.byCategory.length > 0 ? (
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t pt-4 sm:grid-cols-3 lg:grid-cols-4">
            {data.byCategory.map((entry) => (
              <div key={entry.category}>
                <dt className="text-sm text-muted-foreground">{entry.category}</dt>
                <dd className="font-semibold tabular-nums">
                  {plainAmount(entry.cents, data.currency, locale)}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </section>

      {expenses.isPending ? (
        <DataTableSkeleton view="list" rowCount={5} label="Consultando los gastos del mes" />
      ) : expenses.isError || !data ? (
        <ErrorState
          title="No se pudieron consultar los gastos"
          message={financeErrorMessage(expenses.error)}
          onRetry={() => void expenses.refetch()}
        />
      ) : days.length === 0 ? (
        <EmptyState
          title={`Sin gastos en ${monthName}`}
          description="Aquí se anota en qué se va el dinero de la sede: materiales, laboratorio, alquiler y lo demás."
          actionLabel={canWrite ? "Registrar gasto" : undefined}
          onAction={canWrite ? onExpense : undefined}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {days.map((group) => (
            <section key={group.day} aria-label={formatDayShort(group.rows[0].spentAt, locale, zone)}>
              <h3 className="px-1 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {formatDayShort(group.rows[0].spentAt, locale, zone)}
              </h3>
              <ul className="divide-y rounded-xl border bg-card">
                {group.rows.map((row) => {
                  const voided = row.voidedAt !== null
                  const facts = [
                    row.category,
                    row.fromCash ? "salió del efectivo de la caja" : null,
                    receiptText(row),
                  ].filter((item): item is string => !!item)
                  return (
                    <li key={row.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                      <div className="min-w-0 flex-1 basis-56">
                        <p
                          className={cn(
                            "text-base font-medium break-words",
                            voided && "text-muted-foreground line-through",
                          )}
                        >
                          {row.concept}
                        </p>
                        <p className="text-sm text-muted-foreground">{facts.join(" · ")}</p>
                        {voided ? (
                          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                            <Badge variant="destructive">Anulado</Badge>
                            {row.voidReason ? <span>Motivo: {row.voidReason}</span> : null}
                          </p>
                        ) : null}
                      </div>
                      <div className="ml-auto flex items-center gap-2">
                        <span
                          className={cn(
                            "font-medium tabular-nums",
                            voided && "text-muted-foreground line-through",
                          )}
                        >
                          {plainAmount(row.amountCents, row.currency, locale)}
                        </span>
                        {!voided && canWrite ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Anular el gasto ${row.concept}`}
                            onClick={() => {
                              setVoidError(null)
                              setVoiding(row)
                            }}
                          >
                            Anular
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        Un gasto se anula con motivo y queda en el historial; no se borra.
      </p>

      <VoidDrawer
        open={voiding !== null}
        title="Anular gasto"
        description={
          voiding?.fromCash
            ? "Queda en el historial con su motivo, deja de sumar en el mes y el efectivo vuelve a contar en la caja si aún no se cerró."
            : "Queda en el historial con su motivo y deja de sumar en el mes."
        }
        isSubmitting={voidMutation.isPending}
        error={voidError}
        onClose={() => {
          setVoiding(null)
          setVoidError(null)
        }}
        onConfirm={(reason) => {
          if (!voiding) return
          setVoidError(null)
          voidMutation.mutate({ id: voiding.id, reason })
        }}
      />
    </div>
  )
}

const CATEGORY_OPTIONS = EXPENSE_CATEGORIES.map((value) => ({ value, label: value }))

function ExpenseFormDrawer({
  ws,
  open,
  onClose,
}: {
  ws: Workspace
  open: boolean
  onClose: () => void
}) {
  const { branchId, locale, orgTimeZone } = ws
  const queryClient = useQueryClient()
  const canWrite = usePermission("finance.write")
  const cash = useCashState(branchId, open)
  const today = todayIn(orgTimeZone)
  const [concept, setConcept] = useState("")
  const [amount, setAmount] = useState("")
  const [category, setCategory] = useState<ExpenseCategory | "">("")
  const [fromCash, setFromCash] = useState(true)
  const [moreOpen, setMoreOpen] = useState(false)
  const [receiptKind, setReceiptKind] = useState("")
  const [receiptNumber, setReceiptNumber] = useState("")
  const [spentDay, setSpentDay] = useState(today)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setConcept("")
    setAmount("")
    setCategory("")
    setFromCash(true)
    setMoreOpen(false)
    setReceiptKind("")
    setReceiptNumber("")
    setSpentDay(todayIn(orgTimeZone))
    setError(null)
  }, [open, branchId, orgTimeZone])

  const state = cash.data?.data ?? null
  const unit = state?.currency ?? ws.currency
  const money = (cents: number) => formatMoney(cents, unit, locale)
  const cents = amount.trim() === "" ? null : parseAmount(amount, unit, locale)
  // Con la caja a la vista se avisa antes de guardar si el efectivo no alcanza.
  const after = fromCash && state && cents !== null ? state.cashOnHandCents - cents : null

  const createMutation = useMutation({
    mutationFn: createExpenseApi,
    onSuccess: () => {
      invalidateFinance(queryClient)
      toast.success("Gasto registrado")
      onClose()
    },
    onError: (err) => setError(cashErrorMessage(err)),
  })

  return (
    <FormDrawer
      open={open}
      title="Registrar gasto"
      description={ws.branchName ? `Gasto de ${ws.branchName}.` : undefined}
      error={error}
      isSubmitting={createMutation.isPending}
      isDirty={concept !== "" || amount !== "" || category !== "" || receiptKind !== "" || receiptNumber !== ""}
      submitLabel="Registrar gasto"
      submitDisabled={!canWrite}
      onClose={() => {
        if (!createMutation.isPending) onClose()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        if (!concept.trim()) {
          setError("Escribe en qué se gastó.")
          return
        }
        if (cents === null || cents <= 0) {
          setError("Escribe un importe mayor que cero.")
          return
        }
        if (category === "") {
          setError("Elige el tipo de gasto.")
          return
        }
        if (after !== null && after < 0 && state) {
          setError(
            `En la caja solo hay ${money(state.cashOnHandCents)}: no alcanza para pagar este gasto con el efectivo.`,
          )
          return
        }
        if (spentDay > today) {
          setError("La fecha del gasto no puede ser futura.")
          return
        }
        setError(null)
        createMutation.mutate({
          branchId,
          concept: concept.trim(),
          amountCents: cents,
          category,
          fromCash,
          ...(receiptKind.trim() ? { receiptKind: receiptKind.trim() } : {}),
          ...(receiptNumber.trim() ? { receiptNumber: receiptNumber.trim() } : {}),
          // Hoy lleva la hora real; otro día, su mediodía en la zona de la clínica.
          ...(spentDay === today ? {} : { spentAt: noonOf(spentDay, orgTimeZone) }),
        })
      }}
    >
      <div className="flex flex-col gap-5">
        <Field>
          <FieldLabel htmlFor="gasto-concepto">En qué se gastó</FieldLabel>
          <Input
            id="gasto-concepto"
            maxLength={500}
            value={concept}
            onChange={(event) => setConcept(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="gasto-importe">Importe</FieldLabel>
          <Input
            id="gasto-importe"
            inputMode="decimal"
            autoComplete="off"
            placeholder={formatMoneyInput(0, unit, locale)}
            aria-invalid={amount.trim() !== "" && cents === null}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <ChoiceChips label="Tipo" value={category} options={CATEGORY_OPTIONS} onChange={setCategory} />
        <Field orientation="horizontal">
          <Checkbox
            id="gasto-caja"
            aria-describedby="gasto-caja-ayuda"
            checked={fromCash}
            onCheckedChange={(checked) => setFromCash(checked === true)}
          />
          <FieldContent>
            <FieldLabel htmlFor="gasto-caja">Se pagó con el efectivo de la caja</FieldLabel>
            <FieldDescription id="gasto-caja-ayuda">
              {after === null ? (
                "Se descuenta del efectivo que debe haber al cerrar."
              ) : after < 0 && state ? (
                <span className="text-destructive">
                  En la caja solo hay {money(state.cashOnHandCents)}: no alcanza para este gasto.
                </span>
              ) : (
                `Se descuenta del efectivo que debe haber al cerrar: la caja queda en ${money(after)}.`
              )}
            </FieldDescription>
          </FieldContent>
        </Field>
        <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
          <CollapsibleTrigger render={<Button type="button" variant="link" className="h-auto p-0" />}>
            Más detalles: comprobante recibido y fecha
            <ChevronDown aria-hidden className={cn("transition-transform", moreOpen && "rotate-180")} />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-4 pt-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="gasto-comprobante">Comprobante recibido</FieldLabel>
                  <Input
                    id="gasto-comprobante"
                    maxLength={60}
                    placeholder="Factura, recibo…"
                    value={receiptKind}
                    onChange={(event) => setReceiptKind(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="gasto-numero">Número</FieldLabel>
                  <Input
                    id="gasto-numero"
                    maxLength={60}
                    autoComplete="off"
                    value={receiptNumber}
                    onChange={(event) => setReceiptNumber(event.target.value)}
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="gasto-fecha">Fecha del gasto</FieldLabel>
                <DatePickerButton
                  id="gasto-fecha"
                  className="justify-start font-normal"
                  value={spentDay}
                  max={today}
                  onChange={setSpentDay}
                >
                  {formatDayKey(spentDay, locale, today)}
                </DatePickerButton>
              </Field>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </FormDrawer>
  )
}
