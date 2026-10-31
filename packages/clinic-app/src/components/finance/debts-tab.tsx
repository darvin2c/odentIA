/**
 * Deudas: la lista de trabajo para cobrar lo pendiente de la sede, por páginas
 * del servidor. Cada fila dice lo que debe concepto por concepto, quién atendió,
 * desde cuándo y su próxima cita (a quien ya viene se le cobra entonces), con
 * «Escribirle» y «Cobrar». La barra busca por nombre o documento y filtra por
 * antigüedad; el orden por defecto es lo que más se debe. Encima, lo que se
 * debe en la sede entera.
 */
import { documentText, formatMoney } from "@odentia/clinical"
import { Badge, Button, Spinner } from "@odentia/ui"
import {
  common,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  type FilterDef,
  SkeletonRegion,
  useListSearch,
} from "@odentia/ui-patterns"
import { useInfiniteQuery } from "@tanstack/react-query"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { PersonLink } from "../person-link"
import { DebtRowsSkeleton } from "../skeletons/finance"
import { WriteToPersonDialog } from "../write-to-person"
import { plainAmount } from "../../lib/commissions"
import { usePermission } from "../../lib/crm"
import { financeErrorMessage } from "../../lib/finance"
import {
  DEBT_SORT_OPTIONS,
  type DebtListParams,
  type DebtListRow,
  type DebtTotals,
  fetchDebtList,
  financeKeys,
  formatDayMonth,
  formatWeekdayDay,
  isForbidden,
} from "../../lib/finance-cash"

/** Las claves de la barra en la dirección: «Limpiar» solo quita estas. */
export const DEBT_LIST_KEYS = ["q", "antiguedad"] as const

/** Conceptos a la vista en una fila; el resto se cuenta. */
const ITEMS_SHOWN = 4

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

function totalsText(totals: DebtTotals, locale: string): string {
  return totals.totals.map((row) => formatMoney(row.cents, row.currency, locale)).join(" · ")
}

function ageWords(days: number | null): string {
  if (days === null) return ""
  return days === 0 ? "desde hoy" : `hace ${plural(days, "día", "días")}`
}

export function DebtsTab({
  branchId,
  locale,
  timeZone,
  canWrite,
  onCollect,
}: {
  branchId: string
  locale: string
  /** Zona de la sede: desde cuándo debe y su próxima cita. */
  timeZone: string
  canWrite: boolean
  onCollect: (patient?: { id: string; name: string } | null) => void
}) {
  const listSearch = useListSearch()
  const canMessage = usePermission("conversations.read")
  // Sin conversación abierta: se elige por dónde escribirle.
  const [writeTo, setWriteTo] = useState<DebtListRow | null>(null)
  const age = listSearch.get("antiguedad")
  const params: DebtListParams = {
    q: listSearch.get("q") ?? "",
    ...(age === "30" || age === "90" ? { age } : {}),
    sort: listSearch.get("sort")?.replace(/^-/, "") ?? "",
  }
  const filtered = DEBT_LIST_KEYS.some((key) => !!listSearch.get(key))

  const debts = useInfiniteQuery({
    queryKey: financeKeys.debtList(branchId, params),
    queryFn: ({ pageParam }: { pageParam: string | null }) => fetchDebtList(branchId, params, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.data.nextCursor,
  })
  const first = debts.data?.pages[0]?.data ?? null
  const rows = useMemo(() => debts.data?.pages.flatMap((page) => page.data.data) ?? [], [debts.data])

  const filters: FilterDef[] = [
    {
      key: "antiguedad",
      label: "Antigüedad",
      type: "select",
      options: [
        { value: "30", label: "Más de 30 días" },
        { value: "90", label: "Más de 90 días" },
      ],
    },
  ]

  const columns = useMemo<ColumnDef<DebtListRow>[]>(
    () => [
      {
        id: "paciente",
        header: "Paciente",
        meta: { view: { role: "title" } },
        cell: ({ row }) => {
          const debt = row.original
          const doc = debt.docNumber ? documentText(debt.docType, debt.docNumber) : ""
          return (
            <div className="flex min-w-0 flex-col">
              <PersonLink patientId={debt.patientId} search={{ tab: "cuenta" }} className="font-medium hover:underline">
                {debt.displayName || "Paciente sin nombre"}
              </PersonLink>
              {doc ? <span className="text-xs text-muted-foreground">{doc}</span> : null}
            </div>
          )
        },
      },
      {
        id: "debe",
        header: "Lo que debe",
        cell: ({ row }) => {
          const debt = row.original
          const rest = debt.items.length - ITEMS_SHOWN
          return (
            <div className="flex min-w-0 flex-col gap-0.5">
              {debt.items.slice(0, ITEMS_SHOWN).map((item, index) => (
                <span key={`${item.description}-${index}`} className="flex justify-between gap-3">
                  <span className="min-w-0 break-words">{item.description}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {plainAmount(item.outstandingCents, debt.currency, locale)}
                  </span>
                </span>
              ))}
              {rest > 0 ? <span className="text-xs text-muted-foreground">y {plural(rest, "concepto", "conceptos")} más</span> : null}
              {debt.lastAttended?.professionalName ? (
                <span className="text-xs text-muted-foreground">Atendió {debt.lastAttended.professionalName}</span>
              ) : null}
            </div>
          )
        },
      },
      {
        id: "desde",
        header: "Desde",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const debt = row.original
          if (!debt.oldestSince) return <span className="text-muted-foreground">Sin fecha</span>
          return (
            <div className="flex flex-col items-start gap-1">
              <span className="whitespace-nowrap">
                {formatDayMonth(debt.oldestSince, locale, timeZone)}{" "}
                <span className="text-muted-foreground">{ageWords(debt.ageDays)}</span>
              </span>
              {debt.ageDays !== null && debt.ageDays > 90 ? <Badge variant="warning">Más de 90 días</Badge> : null}
            </div>
          )
        },
      },
      {
        id: "cita",
        header: "Próxima cita",
        cell: ({ row }) =>
          row.original.nextAppointmentAt ? (
            <span className="font-medium whitespace-nowrap text-primary-soft-foreground">
              Viene el {formatWeekdayDay(row.original.nextAppointmentAt, locale, timeZone)}
            </span>
          ) : (
            <span className="text-muted-foreground">Sin cita</span>
          ),
      },
      {
        id: "monto",
        header: () => <span className="block text-right">Debe</span>,
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const debt = row.original
          return (
            <div className="text-right">
              <p className="font-semibold whitespace-nowrap tabular-nums">{formatMoney(debt.dueCents, debt.currency, locale)}</p>
              {debt.creditUsedCents > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {plainAmount(debt.totalCents, debt.currency, locale)} menos{" "}
                  {plainAmount(debt.creditUsedCents, debt.currency, locale)} a favor
                </p>
              ) : null}
            </div>
          )
        },
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Acciones</span>,
        cell: ({ row }) => {
          const debt = row.original
          const name = debt.displayName || "Paciente sin nombre"
          return (
            <div className="flex justify-end gap-1">
              {canMessage && debt.contactId ? (
                <Button type="button" variant="ghost" size="sm" aria-label={`Escribirle a ${name}`} onClick={() => setWriteTo(debt)}>
                  Escribirle
                </Button>
              ) : null}
              {canWrite ? (
                <Button type="button" size="sm" aria-label={`Cobrar a ${name}`} onClick={() => onCollect({ id: debt.patientId, name })}>
                  Cobrar
                </Button>
              ) : null}
            </div>
          )
        },
      },
    ],
    [locale, timeZone, canMessage, canWrite, onCollect],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })

  if (debts.isError && isForbidden(debts.error)) {
    return <EmptyState title="Sin acceso a finanzas" description={financeErrorMessage(debts.error)} />
  }
  const summary = first?.summary ?? null

  return (
    <div className="flex flex-col gap-3">
      <FilterBar
        filters={filters}
        sortOptions={[...DEBT_SORT_OPTIONS]}
        searchPlaceholder="Buscar por paciente o documento"
        searchLabel="Buscar en deudas"
        searchPending={debts.isFetching && !debts.isFetchingNextPage && filtered}
        resetKeys={[...DEBT_LIST_KEYS]}
      />
      {summary && summary.people > 0 ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1 text-sm text-muted-foreground">
          <p>
            Te deben <span className="font-semibold text-foreground">{totalsText(summary, locale)}</span> ·{" "}
            {plural(summary.people, "persona", "personas")}
          </p>
          <p>
            Más de 30 días: {summary.over30.people > 0 ? `${totalsText(summary.over30, locale)} (${summary.over30.people})` : "nadie"} · Más de
            90 días: {summary.over90.people > 0 ? `${totalsText(summary.over90, locale)} (${summary.over90.people})` : "nadie"}
          </p>
        </div>
      ) : null}
      {debts.isPending ? (
        <SkeletonRegion message="Consultando quién debe">
          <DebtRowsSkeleton />
        </SkeletonRegion>
      ) : debts.isError && rows.length === 0 ? (
        <ErrorState
          title="No se pudieron consultar las deudas"
          message={financeErrorMessage(debts.error)}
          onRetry={() => void debts.refetch()}
        />
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyState
            title={common.filters.noResults}
            description={age ? `Nadie coincide entre quienes deben desde hace más de ${age} días.` : "Nadie que deba coincide con lo que buscas."}
            actionLabel="Limpiar"
            onAction={() => listSearch.setParams(Object.fromEntries(DEBT_LIST_KEYS.map((key) => [key, undefined])))}
          />
        ) : (
          <EmptyState
            title="Nadie debe por ahora"
            description="Cuando se cierre una atención con costo, la persona aparece aquí sola."
            actionLabel={canWrite ? "Cobrar un adelanto" : undefined}
            onAction={canWrite ? () => onCollect() : undefined}
          />
        )
      ) : (
        <div className="flex flex-col gap-2">
          <DataTable
            className="[&_td]:align-top [&_td]:whitespace-normal [&_td]:[overflow-wrap:anywhere]"
            table={table}
            isFetching={debts.isFetching && !debts.isFetchingNextPage}
          />
          {debts.isError ? (
            <p role="alert" className="text-sm text-destructive">
              No se pudo actualizar la lista; se conservan las deudas cargadas.{" "}
              <Button type="button" variant="link" size="sm" onClick={() => void debts.refetch()}>
                Reintentar
              </Button>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground" role="status">
              Se ven {rows.length.toLocaleString()} de {plural(first?.total ?? rows.length, "persona", "personas")}
            </p>
            {debts.hasNextPage ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={debts.isFetchingNextPage}
                onClick={() => void debts.fetchNextPage()}
              >
                {debts.isFetchingNextPage ? <Spinner className="size-6" aria-hidden /> : null}
                Cargar más
              </Button>
            ) : null}
          </div>
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        Lo aceptado en un presupuesto que todavía no se atiende no aparece aquí: no es deuda.
      </p>
      <WriteToPersonDialog
        open={writeTo !== null}
        onClose={() => setWriteTo(null)}
        people={writeTo?.contactId ? [{ contactId: writeTo.contactId, displayName: writeTo.displayName }] : []}
      />
    </div>
  )
}
