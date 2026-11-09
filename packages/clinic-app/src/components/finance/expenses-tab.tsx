/**
 * Gastos de un mes de la sede (el mes se elige arriba, como en Comisiones):
 * cuánto se gastó y en qué tipo, y la lista con la misma barra de las demás
 * (buscar por concepto, proveedor, comprobante o n.º de operación; filtrar por
 * tipo). La búsqueda y el tipo los aplica el servidor; el total del mes y el de
 * cada tipo son del mes entero. Tocar un gasto abre su detalle, con «Anular» y
 * «Corregir» (ADR 0167). Un gasto anulado queda en la lista, tachado; uno
 * corregido lo dice el nuevo.
 *
 * En el celular, lo anotado y lo buscado se ven primero (QA de Gastos, UX 5): al
 * buscar, la lista va arriba; «Por pagar» muestra tres y «Lo que se repite» va al
 * final, plegado.
 */
import { currencyWord, formatMoney } from "@odentia/clinical"
import { Alert, AlertDescription, AlertTitle, Badge, Button, buttonVariants, cn, toast } from "@odentia/ui"
import {
  common,
  DataTable,
  DetailDrawer,
  EmptyState,
  ErrorState,
  FilterBar,
  type FilterDef,
  SkeletonRegion,
  useListSearch,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { ExpenseRowsSkeleton, ExpensesTotalSkeleton } from "../skeletons/finance"
import { ExpenseFormDrawer, type ExpenseDrawerMode } from "./expense-form-drawer"
import { FixedOfMonth, RecurringDueSection, RepeatingList, useRecurringMonth } from "./recurring-due"
import { useActiveBranch } from "../../lib/active-branch"
import { VoidDrawer } from "./void-drawer"

const MONTH_WORDS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "setiembre", "octubre", "noviembre", "diciembre"]

/** «noviembre» de `2026-11`. */
function monthOfKey(key: string): string {
  return MONTH_WORDS[Number(key.slice(5, 7)) - 1] ?? key
}
import { plainAmount } from "../../lib/commissions"
import { usePermission } from "../../lib/crm"
import { expenseRateWords } from "../../lib/expense-exchange"
import { financeErrorMessage } from "../../lib/finance"
import { useOrgSecondCurrency } from "../../lib/org"
import {
  daysBetween,
  dayKeyOf,
  EXPENSE_FILTER_TYPES,
  expenseCategoryLabel,
  type ExpenseRow,
  fetchMonthExpenses,
  fetchPurchasesToPay,
  financeKeys,
  formatDayMonth,
  formatMonthName,
  invalidateFinance,
  isForbidden,
  type MonthRef,
  NO_RECEIPT,
  requestExpenseVoidApi,
  todayIn,
  voidExpenseApi,
} from "../../lib/finance-cash"
import { purchaseOrderLabel } from "../../lib/reports"

/** Las claves de la barra en la dirección: «Limpiar» solo quita estas. */
export const EXPENSE_LIST_KEYS = ["q", "tipo"] as const

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function receiptText(row: ExpenseRow): string | null {
  const kind = row.receiptKind && row.receiptKind !== NO_RECEIPT ? row.receiptKind : ""
  const number = row.receiptNumber ?? ""
  if (kind) return number ? `${kind} ${number}` : kind
  return number ? `Comprobante ${number}` : null
}

/** Con qué se pagó: el medio que se dijo, o lo único que se sabía antes (si salió de la caja). */
function methodText(row: ExpenseRow, cashWord: string): string {
  // La fila junta de sueldos o de comisiones suma pagos hechos de varias formas: no dice uno.
  if (row.salary || (row.commission && row.id.includes(":"))) return "Varios"
  if (row.methodName) return row.paymentReference ? `${row.methodName} · op. ${row.paymentReference}` : row.methodName
  return row.fromCash ? cashWord : "Otro medio"
}

export function ExpensesTab({
  branchId,
  branchName,
  locale,
  orgTimeZone,
  currency,
  month,
  canWrite,
  onExpense,
}: {
  branchId: string
  branchName: string
  locale: string
  /** Zona de la clínica: el mes de los gastos. */
  orgTimeZone: string
  currency: string
  month: MonthRef
  canWrite: boolean
  onExpense: () => void
}) {
  const queryClient = useQueryClient()
  const listSearch = useListSearch()
  const canInventory = usePermission("inventory.read")
  // Anular un gasto de una caja ya cerrada es de administración (`finance.admin`), como en el servidor.
  const canAdmin = usePermission("finance.admin")
  const second = useOrgSecondCurrency()
  const [voiding, setVoiding] = useState<ExpenseRow | null>(null)
  // El detalle de un gasto, y el cajón para corregirlo o pagar lo que se repite.
  const [viewing, setViewing] = useState<ExpenseRow | null>(null)
  const [drawer, setDrawer] = useState<ExpenseDrawerMode | null>(null)
  const place = { branchId, branchName, currency, locale, orgTimeZone }
  const q = listSearch.get("q") ?? ""
  const tipo = listSearch.get("tipo") ?? ""
  const category = (EXPENSE_FILTER_TYPES as readonly string[]).includes(tipo) ? tipo : ""
  const filtered = EXPENSE_LIST_KEYS.some((key) => !!listSearch.get(key))

  const expenses = useQuery({
    queryKey: financeKeys.expenses(branchId, month, q.trim(), category),
    queryFn: () => fetchMonthExpenses({ branchId, ...month, q, category }),
    placeholderData: (previous) => previous,
  })
  const purchases = useQuery({
    queryKey: financeKeys.purchases(branchId),
    queryFn: () => fetchPurchasesToPay(branchId),
  })
  // Lo que se repite: «Por pagar» y «Lo fijo del mes».
  const recurring = useRecurringMonth(branchId, month, true)
  // Con varias sedes, lo fijo de toda la clínica: lo que cuesta mantenerla al mes.
  const severalBranches = useActiveBranch().branches.length > 1
  const wholeClinic = useRecurringMonth("", month, severalBranches)
  const voidMutation = useMutation({
    mutationFn: (input: { id: string; reason: string }) => voidExpenseApi(input.id, input.reason),
    onSuccess: () => {
      invalidateFinance(queryClient)
      toast.success("Gasto anulado")
      setVoiding(null)
    },
  })

  // Un gasto en efectivo de una caja ya cerrada lo anula administración: caja se lo pide como tarea.
  const adminVoids = Boolean(voiding?.fromCash && voiding.shiftClosed && !canAdmin)
  const askAdmin = useMutation({
    mutationFn: (input: { expense: ExpenseRow; reason: string }) =>
      requestExpenseVoidApi({
        title: `Anular o corregir el gasto «${input.expense.concept}» de ${branchName}, del ${formatDayMonth(input.expense.spentAt, locale, orgTimeZone)} (${formatMoney(input.expense.amountCents, input.expense.currency, locale)}): ${input.reason}`,
      }),
    onSuccess: () => {
      toast.success("Se lo pediste a administración: le llegó como tarea. El gasto sigue hasta que lo anule.")
      setVoiding(null)
    },
  })

  const data = expenses.data?.data ?? null
  const zone = data?.timezone ?? orgTimeZone
  const unpaid = purchases.data?.data.unpaid ?? null
  const monthName = formatMonthName(month, locale)

  const filters: FilterDef[] = [
    {
      key: "tipo",
      label: "Tipo",
      type: "select",
      options: EXPENSE_FILTER_TYPES.map((item) => ({ value: item, label: expenseCategoryLabel(item) })),
    },
  ]

  const columns = useMemo<ColumnDef<ExpenseRow>[]>(
    () => [
      {
        id: "fecha",
        header: "Fecha",
        meta: { view: { primary: true } },
        cell: ({ row }) => <span className="whitespace-nowrap">{formatDayMonth(row.original.spentAt, locale, zone)}</span>,
      },
      {
        id: "concepto",
        header: "Concepto",
        meta: { view: { role: "title" } },
        cell: ({ row }) => {
          const expense = row.original
          const voided = expense.voidedAt !== null
          return (
            // Un ancho mínimo: partir solo una palabra larga no debe angostar la columna a una letra.
            <div className="flex min-w-0 flex-col gap-1 sm:min-w-44">
              {/* Solo el texto libre parte una palabra larga; el monto y «Anular» no se salen de la tabla (QA del 8 nov, G28). */}
              {/* Un botón: con el teclado también se abre el detalle, con «Anular» y «Corregir». */}
              <button
                type="button"
                className={cn(
                  "text-left font-medium [overflow-wrap:anywhere] hover:underline focus-visible:underline focus-visible:outline-none",
                  voided && "text-muted-foreground line-through",
                )}
                onClick={(event) => {
                  event.stopPropagation()
                  setViewing(expense)
                }}
              >
                {expense.concept}
              </button>
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {expense.personName ? <span>{expense.personName}</span> : null}
                {expense.supplierName ? <span className="[overflow-wrap:anywhere]">{expense.supplierName}</span> : null}
                {expense.purchaseOrderId && expense.purchaseOrderNumber !== null ? (
                  canInventory ? (
                    <Link
                      to="/inventory"
                      search={{ tab: "compras", orden: expense.purchaseOrderId }}
                      className="rounded-full bg-primary-soft px-2 py-0.5 font-bold text-primary-soft-foreground no-underline"
                    >
                      Compra {purchaseOrderLabel(expense.purchaseOrderNumber)}
                    </Link>
                  ) : (
                    <Badge variant="secondary">Compra {purchaseOrderLabel(expense.purchaseOrderNumber)}</Badge>
                  )
                ) : null}
                {expense.commission ? <Badge variant="secondary">Comisión</Badge> : null}
                {expense.replaced ? <Badge variant="secondary">Corregido</Badge> : null}
                {/* Pagar el impuesto de lo cobrado no es un gasto: se ve aquí y no suma (ADR 0083, G12). */}
                {expense.salesTax ? <Badge variant="secondary">No suma: es el impuesto de lo cobrado</Badge> : null}
                {voided ? <Badge variant="destructive">Anulado</Badge> : null}
              </span>
              {voided && expense.voidReason ? (
                <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">Motivo: {expense.voidReason}</span>
              ) : null}
            </div>
          )
        },
      },
      // En el teléfono también se ve el tipo y de dónde salió: son lo que se busca al revisar un gasto.
      {
        id: "tipo",
        header: "Tipo",
        meta: { view: { primary: true } },
        cell: ({ row }) => <span className="whitespace-nowrap">{expenseCategoryLabel(row.original.category)}</span>,
      },
      {
        // En el celular también: es lo que se busca al revisar un gasto (QA de Gastos, G27).
        id: "comprobante",
        header: "Comprobante",
        meta: { view: { primary: true } },
        cell: ({ row }) =>
          row.original.salary ? (
            <span className="text-muted-foreground">Varios</span>
          ) : (
            <span className="[overflow-wrap:anywhere]">{receiptText(row.original) ?? <span className="text-muted-foreground">Sin comprobante</span>}</span>
          ),
      },
      {
        id: "salio",
        header: "Con qué se pagó",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <span className="[overflow-wrap:anywhere]">
            {methodText(
              row.original,
              second ? `Caja de ${currencyWord(row.original.tenderCurrency ?? row.original.currency, locale)}` : "Efectivo de la caja",
            )}
          </span>
        ),
      },
      {
        id: "monto",
        header: () => <span className="block text-right">Monto</span>,
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const expense = row.original
          // Con otra moneda de por medio, cada cifra lleva su símbolo.
          const business = currency
          const named = second !== null || expense.currency !== business
          return (
            <span className="flex flex-col items-end gap-0.5">
              <span
                className={cn(
                  "block text-right font-semibold whitespace-nowrap tabular-nums",
                  expense.voidedAt !== null && "font-normal text-muted-foreground line-through",
                )}
              >
                {named
                  ? formatMoney(expense.amountCents, expense.currency, locale)
                  : plainAmount(expense.amountCents, expense.currency, locale)}
              </span>
              {expense.exchangeRate && expense.tenderCents != null && expense.tenderCurrency ? (
                <span className="text-right text-xs text-muted-foreground tabular-nums">
                  Salió {formatMoney(expense.tenderCents, expense.tenderCurrency, locale)} ·{" "}
                  {expenseRateWords(
                    { ...expense, exchangeRate: expense.exchangeRate },
                    business,
                    locale,
                  )}
                </span>
              ) : expense.exchangeRate && expense.businessCents != null ? (
                <span className="text-right text-xs text-muted-foreground tabular-nums">
                  Vale {formatMoney(expense.businessCents, business, locale)} ·{" "}
                  {expenseRateWords(
                    { ...expense, exchangeRate: expense.exchangeRate },
                    business,
                    locale,
                  )}
                </span>
              ) : null}
            </span>
          )
        },
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Acciones</span>,
        cell: ({ row }) =>
          row.original.commission ? (
            // El pago de una comisión se anula con su pago, en Comisiones: aquí solo lleva a él.
            row.original.commissionPayment && row.original.voidedAt === null ? (
              <div className="flex justify-end">
                {/* Es un enlace: se ve como botón, pero conserva lo de un enlace (sin `role="button"`). */}
                <Link
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                  aria-label={`Ver el pago: ${row.original.concept}`}
                  to="/finance"
                  search={{
                    tab: "comisiones",
                    // Un pago antiguo sin mes abre Comisiones con la persona elegida.
                    ...(row.original.commissionPayment.year && row.original.commissionPayment.month
                      ? { year: row.original.commissionPayment.year, month: row.original.commissionPayment.month }
                      : {}),
                    profesional: row.original.commissionPayment.professionalUserId,
                  }}
                >
                  Ver el pago
                </Link>
              </div>
            ) : null
          ) : row.original.voidedAt === null && canWrite && !row.original.salary ? (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Anular el gasto ${row.original.concept}`}
                onClick={() => setVoiding(row.original)}
              >
                Anular
              </Button>
            </div>
          ) : null,
      },
    ],
    [locale, zone, canInventory, canWrite, second, currency],
  )
  const table = useReactTable({ data: data?.expenses ?? [], columns, getCoreRowModel: getCoreRowModel() })
  // Lo que se puede hacer con un gasto: anular y corregir lo suelto; el pago de una compra o de una
  // comisión se cambia en su compra o en Comisiones, y lo junto de sueldos no se toca desde aquí.
  const editable = (row: ExpenseRow) => row.voidedAt === null && canWrite && !row.salary && !row.commission
  const correctable = (row: ExpenseRow) => editable(row) && row.purchaseOrderId === null
  // En efectivo y con la caja ya cerrada, corregir es de administración, como anular.
  const correctionBlocked = (row: ExpenseRow) => Boolean(row.fromCash && row.shiftClosed && !canAdmin)
  const searching = q.trim() !== ""

  if (expenses.isError && isForbidden(expenses.error)) {
    return <EmptyState title="Sin acceso a finanzas" description={financeErrorMessage(expenses.error)} />
  }

  /** La lista del mes, con su cuenta si se busca o se filtra: arriba al buscar, después de «Por pagar» si no. */
  const listSection = (
    <>
      {filtered && data && data.expenses.length > 0 ? (
        <p className="px-1 text-sm text-muted-foreground" role="status">
          {data.shown.count === 1 ? "Se ve" : "Se ven"} {plural(data.shown.count, "gasto", "gastos")} ·{" "}
          <span className="font-semibold text-foreground">{formatMoney(data.shown.totalCents, data.currency, locale)}</span>
          {data.shown.notCounted ? ` · y ${plural(data.shown.notCounted, "pago", "pagos")} del impuesto de lo cobrado, que no suma` : ""}
        </p>
      ) : null}
      {expenses.isPending ? (
        <SkeletonRegion message="Consultando los gastos del mes">
          <ExpenseRowsSkeleton />
        </SkeletonRegion>
      ) : expenses.isError || !data ? (
        <ErrorState
          title="No se pudieron consultar los gastos"
          message={financeErrorMessage(expenses.error)}
          onRetry={() => void expenses.refetch()}
        />
      ) : data.expenses.length === 0 ? (
        filtered ? (
          <EmptyState
            title={common.filters.noResults}
            description={`Ningún gasto de ${monthName} coincide. Prueba en otro mes o quita el tipo.`}
            actionLabel="Limpiar"
            onAction={() => listSearch.setParams(Object.fromEntries(EXPENSE_LIST_KEYS.map((key) => [key, undefined])))}
          />
        ) : (
          <EmptyState
            title={`Sin gastos en ${monthName}`}
            description="Aquí se anota en qué se va el dinero de la sede: materiales, laboratorio, alquiler y lo demás."
            actionLabel={canWrite ? "Registrar gasto" : undefined}
            onAction={canWrite ? onExpense : undefined}
          />
        )
      ) : (
        <DataTable
          className="[&_td]:align-top [&_td]:whitespace-normal"
          table={table}
          isFetching={expenses.isFetching}
          onRowClick={(row) => setViewing(row)}
        />
      )}
    </>
  )

  return (
    <div className="flex flex-col gap-3">
      <FilterBar
        filters={filters}
        sortOptions={[]}
        searchPlaceholder="Buscar por concepto, proveedor, comprobante u operación"
        searchLabel="Buscar en gastos"
        searchPending={expenses.isFetching && filtered}
        resetKeys={[...EXPENSE_LIST_KEYS]}
      />

      {/* Al buscar, lo buscado va primero (QA de Gastos, UX 5). */}
      {searching ? listSection : null}

      {data ? (
        <section aria-labelledby="gastos-total" className="elevated rounded-xl border bg-card p-4 sm:p-5">
          <h2 id="gastos-total" className="text-sm font-medium text-muted-foreground">
            Gastado en {monthName}
          </h2>
          <p className="mt-1 text-3xl leading-tight font-bold tracking-tight tabular-nums">
            {formatMoney(data.totalCents, data.currency || currency, locale)}
          </p>
          {data.salesTaxCents ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Sin contar {formatMoney(data.salesTaxCents, data.currency || currency, locale)} del impuesto de lo cobrado: ya
              salió de lo cobrado y no es un gasto, como en Reportes.
            </p>
          ) : null}
          <FixedOfMonth data={recurring.data?.data} wholeClinic={severalBranches ? wholeClinic.data?.data : undefined} locale={locale} />
          {data.byCategory.length > 0 ? (
            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t pt-4 sm:grid-cols-3 lg:grid-cols-5">
              {data.byCategory.map((entry) => (
                <div key={entry.category}>
                  <dt className={cn("text-sm text-muted-foreground", entry.category === category && "font-semibold text-foreground")}>
                    {expenseCategoryLabel(entry.category)}
                  </dt>
                  <dd className="font-semibold tabular-nums">{plainAmount(entry.cents, data.currency, locale)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </section>
      ) : expenses.isPending ? (
        <ExpensesTotalSkeleton />
      ) : null}

      <RecurringDueSection
        data={recurring.data?.data}
        locale={locale}
        canWrite={canWrite}
        onPay={(due) => setDrawer({ kind: "pagar", due })}
      />

      {searching ? null : listSection}

      <RepeatingList data={recurring.data?.data} place={place} canWrite={canWrite} />

      {unpaid && (unpaid.orders > 0 || unpaid.otherCurrencies.length > 0) ? (
        <Alert className="border-warning/40 bg-warning-soft">
          <AlertTitle>
            {[
              ...(unpaid.orders > 0
                ? [`${plural(unpaid.orders, "compra recibida", "compras recibidas")} sin pagar: ${formatMoney(unpaid.cents, currency, locale)}`]
                : []),
              // Las de otra moneda van aparte y sin convertir.
              ...unpaid.otherCurrencies.map(
                (other) =>
                  `${plural(other.orders, "compra recibida", "compras recibidas")} sin pagar en ${other.currency}: ${formatMoney(other.cents, other.currency, locale)}`,
              ),
            ].join(" · ")}
          </AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <span>
              {unpaid.oldest?.firstReceivedAt
                ? `La más antigua llegó hace ${plural(Math.max(0, daysBetween(dayKeyOf(unpaid.oldest.firstReceivedAt, zone), todayIn(zone))), "día", "días")} (${purchaseOrderLabel(unpaid.oldest.orderNumber)}, ${unpaid.oldest.supplierName}).`
                : null}{" "}
              {/* Caja no ve Inventario: a ella se le dice dónde pagarla sin nombrarlo (QA de Gastos, G24). */}
              {canInventory
                ? "Una compra se paga desde Inventario o desde «Registrar gasto» con el tipo Materiales: es el mismo pago."
                : "Una compra se paga desde «Registrar gasto» con el tipo Materiales."}
            </span>
            {canInventory ? (
              <Link to="/inventory" search={{ tab: "compras", pago: "por_pagar" }} className="font-semibold underline">
                Ver compras
              </Link>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <p className="text-sm text-muted-foreground">Tocar un gasto lo abre: se anula o se corrige con su motivo y queda en el historial; no se borra.</p>

      <DetailDrawer
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={viewing?.concept ?? "Gasto"}
        description={
          viewing
            ? `${formatMoney(viewing.amountCents, viewing.currency, locale)} · ${expenseCategoryLabel(viewing.category)} · ${formatDayMonth(viewing.spentAt, locale, zone)}`
            : undefined
        }
        actions={
          viewing && editable(viewing) ? (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setVoiding(viewing)
                  setViewing(null)
                }}
              >
                Anular
              </Button>
              {correctable(viewing) ? (
                <Button
                  type="button"
                  onClick={() => {
                    // Con la caja cerrada lo corrige administración: se le pide como al anular.
                    if (correctionBlocked(viewing)) setVoiding(viewing)
                    else setDrawer({ kind: "corregir", expense: viewing })
                    setViewing(null)
                  }}
                >
                  Corregir
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        {viewing ? (
          <dl className="grid gap-3 text-sm">
            {[
              ["Con qué se pagó", methodText(viewing, "Efectivo de la caja")],
              ["Comprobante", receiptText(viewing) ?? "Sin comprobante"],
              ...(viewing.supplierName
                ? [["A quién", viewing.supplierTaxId ? `${viewing.supplierName} · RUC ${viewing.supplierTaxId}` : viewing.supplierName]]
                : []),
              ...(viewing.replaced
                ? [
                    [
                      "Antes",
                      `${formatMoney(viewing.replaced.amountCents, viewing.replaced.currency, locale)} · ${expenseCategoryLabel(viewing.replaced.category)} · ${formatDayMonth(viewing.replaced.spentAt, locale, zone)}${viewing.replaced.methodName ? ` · ${viewing.replaced.methodName}` : ""}${viewing.replaced.reason ? `. ${viewing.replaced.reason}` : ""}`,
                    ],
                  ]
                : []),
              ...(viewing.voidedAt ? [["Anulado", viewing.voidReason ?? "Sin motivo"]] : []),
              ...(viewing.purchaseOrderNumber != null
                ? [["Compra", `${purchaseOrderLabel(viewing.purchaseOrderNumber)}: se cambia en la compra, en Inventario`]]
                : []),
              ...(viewing.commission ? [["Comisión", "Se cambia en Comisiones, con su pago"]] : []),
            ].map(([label, value]) => (
              <div key={label} className="grid gap-0.5">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="[overflow-wrap:anywhere]">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </DetailDrawer>

      {drawer ? <ExpenseFormDrawer place={place} open mode={drawer} onClose={() => setDrawer(null)} /> : null}

      <VoidDrawer
        open={voiding !== null}
        title={adminVoids ? "Pedírselo a administración" : "Anular gasto"}
        // Lo que pasa de verdad, dicho antes de escribir el motivo (QA de Gastos, G15). Si lo anula
        // administración, el motivo se le pide como tarea: el gasto sigue hasta que lo anule.
        submitLabel={adminVoids ? "Pedírselo a administración" : "Anular"}
        description={[
          adminVoids
            ? "La caja de ese día ya se cerró: este gasto lo anula o lo corrige administración, y el efectivo vuelve a la caja de hoy. Escribe el motivo y se lo pides: le llega como tarea."
            : "",
          adminVoids
            ? ""
            : voiding?.fromCash
              ? voiding.shiftClosed
                ? "Queda en el historial con su motivo y deja de sumar en el mes. Su caja ya se cerró: el efectivo vuelve a la caja de hoy como «Compensación por anulación»."
                : "Queda en el historial con su motivo, deja de sumar en el mes y el efectivo vuelve a contar en la caja."
              : "Queda en el historial con su motivo y deja de sumar en el mes.",
          // Es el pago de algo que se repite: ese mes vuelve a quedar por pagar.
          !adminVoids && voiding?.recurringMonth ? `El de ${monthOfKey(voiding.recurringMonth)} vuelve a quedar «por pagar».` : "",
          // Es el pago de una compra: la compra vuelve a deber lo que este pago cubría de lo recibido (ADR 0061).
          !adminVoids && voiding?.purchaseOrderNumber != null
            ? `La compra ${purchaseOrderLabel(voiding.purchaseOrderNumber)} vuelve a deber lo que este pago cubría de lo recibido.`
            : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClose={() => setVoiding(null)}
        onConfirm={async (reason) => {
          if (!voiding) return
          if (adminVoids) await askAdmin.mutateAsync({ expense: voiding, reason })
          else await voidMutation.mutateAsync({ id: voiding.id, reason })
        }}
      />
    </div>
  )
}
