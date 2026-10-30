/**
 * Finanzas: la caja del día por sede, todos los cobros con su ticket, las
 * deudas y los gastos del mes.
 *
 * La caja se crea sola con el primer cobro y nunca bloquea: se cierra contando
 * solo el efectivo y cada cierre deja su hoja, que no se edita. Caja es el día;
 * lo de antes se busca en Cobros, Deudas, Gastos y Cierres, cada uno con la
 * misma barra de búsqueda y filtros, y todo vive en la dirección. Lectura con
 * `finance.read`; cobrar, gastar, ingresar o retirar con `finance.write`;
 * cerrar con `finance.close` (decide siempre el servidor). Comisiones vive en
 * `/commissions`.
 *
 * `?tab=` conserva la sección, `?ticket=<id>` abre ese ticket al lado (lo usa
 * el buscador rápido) y `?cierre=<id>` abre la hoja de ese cierre: es el enlace
 * del aviso que recibe administración. Dinero con `@odentia/clinical`; moneda,
 * formato y zona de la clínica o la sede.
 */
import { formatMoney } from "@odentia/clinical"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  cn,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
  useIsMobile,
} from "@odentia/ui"
import {
  DataTableSkeleton,
  DetailDrawer,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  PageHeader,
  PageShell,
  useListSearch,
} from "@odentia/ui-patterns"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { ArrowLeft, Banknote, Lock, Plus } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { BranchSwitcher } from "../../components/branch-switcher"
import {
  CashCloseDrawer,
  CashMoveDrawer,
  ClosureSheetDrawer,
} from "../../components/finance/cash-close-drawer"
import { CollectDrawer } from "../../components/finance/collect-drawer"
import { DebtsTab } from "../../components/finance/debts-tab"
import { ExpenseFormDrawer } from "../../components/finance/expense-form-drawer"
import { ExpensesTab } from "../../components/finance/expenses-tab"
import {
  CommissionsAdminPanel,
  MonthPicker,
  MyCommissionsPanel,
} from "../../components/finance/CommissionsPanel"
import { TicketPanel } from "../../components/finance/ticket-panel"
import { TicketView, ticketDisplayNumber } from "../../components/finance/ticket-view"
import { TicketsTab } from "../../components/finance/tickets-tab"
import { VoidDrawer } from "../../components/finance/void-drawer"
import { useActiveBranch } from "../../lib/active-branch"
import { compareMonths, FIRST_YEAR, plainAmount } from "../../lib/commissions"
import { usePermission } from "../../lib/crm"
import { financeErrorMessage } from "../../lib/finance"
import {
  CLOSURES_PAGE,
  CASH_TERMS,
  type CashBreakdown,
  cashErrorMessage,
  currentMonthIn,
  type DayEntry,
  dayKeyOf,
  debtConcepts,
  debtDue,
  type DebtRow,
  type DebtTotals,
  differenceLabel,
  fetchClosures,
  fetchDayMovements,
  fetchDebtList,
  financeKeys,
  formatClock,
  formatDateTimeLong,
  formatDayMonth,
  formatDayShort,
  groupDayMovements,
  hasEarlierDaysOpen,
  invalidateFinance,
  isForbidden,
  joinList,
  momentDay,
  momentShort,
  type MonthRef,
  otherMethods,
  spokenMoment,
  todayIn,
  useBranchesStatus,
  useCashState,
  voidCashMovementApi,
} from "../../lib/finance-cash"
import {
  type CollectResultBody,
  useOrgFinanceProfile,
} from "../../lib/finance-collect"
import { useOrgEvents } from "../../lib/org-events"

type FinanceView = "caja" | "cobros" | "deudas" | "gastos" | "comisiones" | "cierres"

const VIEWS: readonly FinanceView[] = ["caja", "cobros", "deudas", "gastos", "comisiones", "cierres"]

function isView(value: unknown): value is FinanceView {
  return typeof value === "string" && (VIEWS as readonly string[]).includes(value)
}

/**
 * Lo que la barra de cada lista guarda en la dirección (`useListSearch`): la
 * búsqueda, el orden y los filtros. Al cambiar de sección se limpian.
 */
const LIST_KEYS = [
  "q",
  "sort",
  "fecha_from",
  "fecha_to",
  "medio",
  "cobro",
  "estado",
  "antiguedad",
  "tipo",
  "resultado",
] as const
type ListKey = (typeof LIST_KEYS)[number]

type FinanceSearch = {
  /** Sección; `cierres` es la lista de cierres anteriores, dentro de Caja. */
  tab?: FinanceView
  /** Cierre (o su ventana) cuya hoja está abierta. */
  cierre?: string
  /** Ticket abierto al lado. */
  ticket?: string
  /** Sede elegida (`useActiveBranch`). */
  branch?: string
  /** Mes de Gastos y de Comisiones; sin él, el mes en curso de la clínica. */
  year?: number
  month?: number
  /** Profesional con el detalle abierto en Comisiones (solo administración). */
  profesional?: string
} & Partial<Record<ListKey, string>>

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

function textOf(search: Record<string, unknown>, key: string): Record<string, string> {
  const value = search[key]
  return typeof value === "string" && value ? { [key]: value } : {}
}

export const Route = createFileRoute("/_org/finance")({
  validateSearch: (search: Record<string, unknown>): FinanceSearch => ({
    ...(isView(search.tab) ? { tab: search.tab } : {}),
    ...textOf(search, "cierre"),
    ...textOf(search, "ticket"),
    ...textOf(search, "branch"),
    ...(monthOfSearch(search) ?? {}),
    ...textOf(search, "profesional"),
    ...Object.assign({}, ...LIST_KEYS.map((key) => textOf(search, key))),
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

/** Personas atendidas hoy a la vista en «Por cobrar ahora» de la Caja. */
const ATTENDED_TODAY_LIMIT = 50

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
        <PageHeader title="Finanzas" subtitle="Caja por sede, cobros, deudas y gastos" />
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
  const canReports = usePermission("reports.read")
  const [panel, setPanel] = useState<Panel | null>(null)
  const [ticket, setTicket] = useState<{ result: CollectResultBody; patientId: string } | null>(null)
  // Cierre recién hecho: la hoja que se abre lo dice (y si ya estaba cerrada).
  const [justClosed, setJustClosed] = useState<{ id: string; alreadyClosed: boolean } | null>(null)
  // Los tickets a la vista en Cobros, en su orden: «Anterior / Siguiente» del ticket abierto.
  const [ticketList, setTicketList] = useState<string[]>([])

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
  const cleared = Object.fromEntries(LIST_KEYS.map((key) => [key, undefined])) as Partial<FinanceSearch>
  // La búsqueda y los filtros son de cada lista: al cambiar de sección se limpian.
  const showView = (next: FinanceView, patch: Partial<FinanceSearch> = {}) =>
    setSearch({ ...cleared, ticket: undefined, tab: next === "caja" ? undefined : next, ...patch })
  const openTicket = (ticketId: string) => setSearch({ ticket: ticketId }, view === "cobros" && !!search.ticket)

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

  // Gastos y Comisiones van por mes: el mes vive en el enlace y el mes en curso no se escribe.
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
  const byMonth = view === "gastos" || (view === "comisiones" && canCommissions)
  const monthPicker =
    byMonth && prof && period && thisMonth ? (
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
    if ((view === "cobros" || view === "deudas") && canWrite) return collectButton(mobile)
    if (view === "gastos" && canWrite) return expenseButton(mobile, true)
    return null
  }
  const mobileActions = isMobile ? actions(true) : null
  // En el escritorio, la cabecera trae la acción principal de la sección y lo demás en ⋯; en el teléfono, las acciones van en la barra de abajo.
  const headerOn = !isMobile && ws !== null
  const headerPrimary = !headerOn
    ? undefined
    : (view === "caja" || view === "cobros" || view === "deudas") && canWrite
      ? { label: "Cobrar", icon: <Banknote aria-hidden />, onClick: () => collect() }
      : view === "caja" && canClose
        ? { label: "Cerrar caja", icon: <Lock aria-hidden />, onClick: () => setPanel({ kind: "cerrar" }) }
        : view === "gastos" && canWrite
          ? { label: "Registrar gasto", icon: <Plus aria-hidden />, onClick: () => setPanel({ kind: "gasto" }) }
          : undefined
  const headerMenu =
    headerOn && view === "caja" && canWrite
      ? [
          { label: "Registrar gasto", icon: <Plus aria-hidden />, onSelect: () => setPanel({ kind: "gasto" }) },
          ...(canClose ? [{ label: "Cerrar caja", icon: <Lock aria-hidden />, onSelect: () => setPanel({ kind: "cerrar" }) }] : []),
        ]
      : []

  return (
    <PageShell className="flex flex-col gap-4">
      <PageHeader
        title="Finanzas"
        subtitle={
          <>
            {view === "comisiones" ? (
              <p className="min-w-0">
                {canCommissionsWrite ? "Lo que le corresponde a cada profesional por lo que atendió y ya se cobró" : "Mis comisiones"}
              </p>
            ) : sede.branches.length > 0 && branchId ? (
              <BranchSwitcher
                branches={sede.branches}
                value={branchId}
                fallbackName={sede.branches[0]?.name ?? ""}
                onChange={(id) => sede.choose(id)}
              />
            ) : (
              <p className="min-w-0">Caja por sede, cobros, deudas y gastos</p>
            )}
            {headerOn && monthPicker ? monthPicker : null}
          </>
        }
        primary={headerPrimary}
        menu={headerMenu}
      />

      {profile.isPending || branchZone.isPending ? (
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
            onAction={canSettings ? () => void navigate({ to: "/settings/branches" }) : undefined}
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
            <TabsList
              aria-label="Secciones de Finanzas"
              className="max-w-full justify-start overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <TabsTrigger value="caja" className="shrink-0">Caja</TabsTrigger>
              <TabsTrigger value="cobros" className="shrink-0">Cobros</TabsTrigger>
              <TabsTrigger value="deudas" className="shrink-0">Deudas</TabsTrigger>
              <TabsTrigger value="gastos" className="shrink-0">Gastos</TabsTrigger>
              {canCommissions ? <TabsTrigger value="comisiones" className="shrink-0">Comisiones</TabsTrigger> : null}
            </TabsList>
            {isMobile && monthPicker ? <div className="ml-auto">{monthPicker}</div> : null}
            {canReports ? (
              <Link
                to="/reports"
                search={{ tab: "finanzas", ...(view !== "comisiones" ? { branch: ws.branchId } : {}) }}
                className="ml-auto inline-flex min-h-11 items-center text-sm font-semibold text-primary-soft-foreground underline-offset-2 hover:underline sm:min-h-8"
              >
                Ver el reporte
              </Link>
            ) : null}
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
                onShowTickets={() => showView("cobros", { fecha_from: todayIn(ws.timeZone), fecha_to: todayIn(ws.timeZone) })}
                onShowClosures={() => showView("cierres")}
                onOpenTicket={openTicket}
              />
            ) : null}
            {view === "cobros" ? (
              <TicketsTab
                key={ws.branchId}
                branchId={ws.branchId}
                branchName={ws.branchName}
                locale={ws.locale}
                timeZone={ws.timeZone}
                canWrite={canWrite}
                openTicketId={search.ticket ?? null}
                onOpenTicket={openTicket}
                onListChange={setTicketList}
                onCollect={() => collect()}
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
              <DebtsTab
                key={ws.branchId}
                branchId={ws.branchId}
                locale={ws.locale}
                timeZone={ws.timeZone}
                canWrite={canWrite}
                onCollect={collect}
              />
            ) : null}
            {view === "gastos" && period ? (
              <ExpensesTab
                key={ws.branchId}
                branchId={ws.branchId}
                locale={ws.locale}
                orgTimeZone={ws.orgTimeZone}
                currency={ws.currency}
                month={period}
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
            place={ws}
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
          onShowTickets={(range) =>
            showView("cobros", { cierre: undefined, fecha_from: range.from, fecha_to: range.to })
          }
          onClose={() => {
            setJustClosed(null)
            setSearch({ cierre: undefined }, true)
          }}
        />
      ) : null}

      {prof ? (
        <TicketPanel
          ticketId={search.ticket ?? null}
          locale={prof.locale}
          timeZone={ws?.timeZone ?? prof.timezone}
          ticketFooter={prof.ticketFooter}
          siblings={view === "cobros" ? ticketList : undefined}
          onOpen={(id) => setSearch({ ticket: id }, true)}
          onClose={() => setSearch({ ticket: undefined }, true)}
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
            receipt={ticket.result.receipt ?? null}
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

/** Una persona que salió hoy de su atención con algo por pagar: quién, qué, cuánto y «Cobrar». */
function DebtLine({
  row,
  locale,
  detail,
  canWrite,
  onCollect,
}: {
  row: DebtRow
  locale: string
  detail: string
  canWrite: boolean
  onCollect: (patient: CollectTarget) => void
}) {
  const { dueCents, creditUsedCents } = debtDue(row)
  const name = row.displayName || "Paciente sin nombre"
  const money = (cents: number) => formatMoney(cents, row.currency, locale)
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-56">
        <Link
          to="/patients/$patientId"
          params={{ patientId: row.patientId }}
          search={{ tab: "cuenta" }}
          className="text-base font-medium underline-offset-4 hover:underline"
        >
          {name}
        </Link>
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
        {/* En el teléfono, cobrar a alguien es la barra de abajo: sin repetir el botón en cada fila. */}
        {canWrite ? (
          <Button className="max-sm:hidden" aria-label={`Cobrar a ${name}`} onClick={() => onCollect({ id: row.patientId, name })}>
            Cobrar
          </Button>
        ) : null}
      </div>
    </li>
  )
}

function totalsText(totals: DebtTotals, locale: string): string {
  return totals.totals.map((row) => formatMoney(row.cents, row.currency, locale)).join(" · ")
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
  onShowTickets,
  onShowClosures,
  onOpenTicket,
}: {
  ws: Workspace
  canWrite: boolean
  canClose: boolean
  onOpenTicket: (ticketId: string) => void
  /** En el teléfono «Registrar gasto» no cabe en la barra: va junto a los movimientos. */
  expenseShortcut: boolean
  onCollect: (patient?: CollectTarget | null) => void
  onExpense: () => void
  onCloseCash: () => void
  onCashMove: () => void
  onShowDebts: () => void
  /** Cobros con la fecha de hoy. */
  onShowTickets: () => void
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
  // Solo quienes salieron hoy de su atención; lo de antes se dice en una línea y vive en Deudas.
  const debts = useQuery({
    queryKey: financeKeys.debtList(branchId, { when: "hoy" }),
    queryFn: () => fetchDebtList(branchId, { when: "hoy" }, null, ATTENDED_TODAY_LIMIT),
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
  const attended = debts.data?.data.data ?? []
  const earlier = debts.data?.data.summary.earlier ?? null

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
  const attendedDue = attended.reduce<Record<string, number>>((sum, row) => {
    sum[row.currency] = (sum[row.currency] ?? 0) + row.dueCents
    return sum
  }, {})

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
          Cierres
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
              {state.tickets > 0 ? (
                <>
                  {" · "}
                  <Button variant="link" className="h-auto p-0 align-baseline" onClick={onShowTickets}>
                    Ver cobros
                  </Button>
                </>
              ) : null}
            </p>
          </div>
        </section>
      )}

      <section aria-labelledby="caja-por-cobrar" className="elevated rounded-xl border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 id="caja-por-cobrar" className="font-heading text-base font-medium">
            Por cobrar ahora
          </h2>
          {attended.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              Salieron hoy de su atención · {plural(attended.length, "persona", "personas")} ·{" "}
              {Object.entries(attendedDue)
                .map(([unit, cents]) => formatMoney(cents, unit, locale))
                .join(" · ")}
            </p>
          ) : null}
        </div>
        {debts.isPending ? (
          <div className="mt-3">
            <DataTableSkeleton view="list" rowCount={2} label="Consultando quién salió hoy con algo por pagar" />
          </div>
        ) : debts.isError ? (
          <ErrorState
            className="mt-3"
            title="No se pudo consultar quién debe"
            message={financeErrorMessage(debts.error)}
            onRetry={() => void debts.refetch()}
          />
        ) : attended.length === 0 && (!earlier || earlier.people === 0) ? (
          <EmptyState
            className="mt-3"
            title="Nadie debe por ahora"
            description="Cuando se cierre una atención con costo, la persona aparece aquí sola."
            actionLabel={canWrite ? "Cobrar un adelanto" : undefined}
            onAction={canWrite ? () => onCollect() : undefined}
          />
        ) : (
          <>
            {attended.length > 0 ? (
              <ul className="mt-1 divide-y">
                {attended.map((row) => {
                  const at = row.attendedTodayAt ?? ""
                  const left =
                    row.lastAttended?.at === at
                      ? `Salió a las ${formatClock(at, locale, zone)}${row.lastAttended.professionalName ? ` · ${row.lastAttended.professionalName}` : ""}`
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
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">Nadie salió hoy de su atención con algo por pagar.</p>
            )}
            {earlier && earlier.people > 0 ? (
              <p className="mt-2 border-t pt-3 text-sm text-muted-foreground">
                {attended.length > 0 ? "Además, " : ""}
                {plural(earlier.people, "persona debe", "personas deben")} de antes: {totalsText(earlier, locale)} ·{" "}
                <Button variant="link" className="h-auto p-0 align-baseline" onClick={onShowDebts}>
                  Ver deudas
                </Button>
              </p>
            ) : null}
          </>
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
  onOpenTicket: (ticketId: string) => void
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
    const { ticketId } = entry
    if (ticketId) open = () => onOpenTicket(ticketId)
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
  const listSearch = useListSearch()
  const result = listSearch.get("resultado") === "descuadre" ? "descuadre" : undefined
  const closures = useInfiniteQuery({
    queryKey: financeKeys.closures(branchId, result),
    queryFn: ({ pageParam }) => fetchClosures(branchId, pageParam, result),
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
      <h2 className="font-heading text-base font-medium">Cierres de {ws.branchName}</h2>
      <FilterBar
        filters={[
          { key: "resultado", label: "Resultado", type: "select", options: [{ value: "descuadre", label: "No cuadró" }] },
        ]}
        sortOptions={[]}
        showSearch={false}
        resetKeys={["resultado"]}
      />
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
        result ? (
          <EmptyState
            title="Todos los cierres cuadraron"
            description="Ningún cierre de esta sede tuvo faltante ni sobrante."
            actionLabel="Ver todos"
            onAction={() => listSearch.setParam("resultado", undefined)}
          />
        ) : (
          <EmptyState
            title="Aún no hay cierres en esta sede"
            description="Cada vez que se cierra la caja queda aquí su hoja, con lo contado y lo entregado."
            actionLabel={canClose ? "Cerrar caja" : undefined}
            onAction={canClose ? onCloseCash : undefined}
          />
        )
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
