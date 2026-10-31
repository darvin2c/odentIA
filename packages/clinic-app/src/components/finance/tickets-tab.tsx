/**
 * Cobros: todos los tickets de la sede, del más nuevo al más antiguo, por
 * páginas del servidor. Cada fila dice el ticket entero —número, fecha y hora,
 * paciente con su documento, lo que pagó concepto por concepto, el medio, quién
 * cobró y el total—; tocarla abre el ticket al lado. Una sola barra busca
 * (paciente, documento o número: un número se busca en todas las fechas) y
 * filtra con nombre (Fecha, Medio de pago, Cobró, Estado); todo vive en la
 * dirección. Encima, lo que suma lo que se ve, por medio de pago.
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
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useEffect, useMemo } from "react"
import { PersonLink } from "../person-link"
import { TicketRowsSkeleton } from "../skeletons/finance"
import { apiFetch } from "../../lib/api"
import { plainAmount } from "../../lib/commissions"
import { financeErrorMessage } from "../../lib/finance"
import {
  fetchTickets,
  financeKeys,
  formatClock,
  formatDayMonth,
  isForbidden,
  TICKET_SORT_OPTIONS,
  TICKET_STATE_OPTIONS,
  type TicketListParams,
  type TicketListRow,
  type TicketTotals,
} from "../../lib/finance-cash"
import { ticketDisplayNumber } from "./ticket-view"

/** Las claves de la barra en la dirección: «Limpiar» solo quita estas. */
export const TICKET_LIST_KEYS = ["q", "fecha_from", "fecha_to", "medio", "cobro", "estado"] as const

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

function totalsLine(totals: TicketTotals[], locale: string): { main: string; methods: string; refunded: string } {
  const tickets = totals.reduce((sum, row) => sum + row.tickets, 0)
  const money = totals.map((row) => formatMoney(row.cobradoCents, row.currency, locale)).join(" · ")
  return {
    main: `${plural(tickets, "ticket", "tickets")}${money ? ` · ${money}` : ""}`,
    methods: totals
      .flatMap((row) => row.byMethod.map((method) => `${method.name} ${plainAmount(method.cents, row.currency, locale)}`))
      .join(" · "),
    refunded: totals
      .filter((row) => row.refundedCents > 0)
      .map((row) => `devuelto ${formatMoney(row.refundedCents, row.currency, locale)}`)
      .join(" · "),
  }
}

export function TicketsTab({
  branchId,
  branchName,
  locale,
  timeZone,
  canWrite,
  openTicketId,
  onOpenTicket,
  onListChange,
  onCollect,
}: {
  branchId: string
  branchName: string
  locale: string
  /** Zona de la sede: la fecha y la hora de cada ticket. */
  timeZone: string
  canWrite: boolean
  openTicketId: string | null
  onOpenTicket: (ticketId: string) => void
  /** Los tickets a la vista, en su orden: «Anterior / Siguiente» del ticket abierto. */
  onListChange: (ids: string[]) => void
  onCollect: () => void
}) {
  const listSearch = useListSearch()
  const params: TicketListParams = {
    q: listSearch.get("q") ?? "",
    from: listSearch.get("fecha_from") ?? "",
    to: listSearch.get("fecha_to") ?? "",
    methods: listSearch.get("medio") ?? "",
    cashiers: listSearch.get("cobro") ?? "",
    state: listSearch.get("estado") ?? "",
    sort: listSearch.get("sort")?.replace(/^-/, "") ?? "",
  }
  const filtered = TICKET_LIST_KEYS.some((key) => !!listSearch.get(key))

  const tickets = useInfiniteQuery({
    queryKey: financeKeys.tickets(branchId, params),
    queryFn: ({ pageParam }: { pageParam: string | null }) => fetchTickets(branchId, params, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.data.nextCursor,
  })
  // Todos los medios, también los que ya no se usan: un cobro viejo se busca por el suyo.
  const methods = useQuery({
    queryKey: ["payment-methods", "todos"],
    queryFn: () => apiFetch<{ data: Array<{ id: string; name: string }> }>("/api/org/payment-methods?activeOnly=0"),
    staleTime: 5 * 60_000,
  })
  const first = tickets.data?.pages[0]?.data ?? null
  const rows = useMemo(() => tickets.data?.pages.flatMap((page) => page.data.data) ?? [], [tickets.data])
  const ids = useMemo(() => rows.map((row) => row.id), [rows])
  useEffect(() => onListChange(ids), [ids, onListChange])

  const filters: FilterDef[] = [
    { key: "fecha", label: "Fecha", type: "date-range" },
    {
      key: "medio",
      label: "Medio de pago",
      type: "multi",
      options: (methods.data?.data ?? []).map((method) => ({ value: method.id, label: method.name })),
    },
    {
      key: "cobro",
      label: "Cobró",
      type: "multi",
      options: (first?.cashiers ?? []).map((person) => ({ value: person.id, label: person.name })),
    },
    { key: "estado", label: "Estado", type: "select", options: [...TICKET_STATE_OPTIONS] },
  ]

  const columns = useMemo<ColumnDef<TicketListRow>[]>(
    () => [
      {
        id: "ticket",
        header: "Ticket",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const ticket = row.original
          return (
            <div className="flex flex-col items-start gap-1">
              <Button
                type="button"
                variant="link"
                className={`h-auto p-0 font-semibold tabular-nums ${ticket.voided ? "text-muted-foreground line-through" : ""}`}
                aria-label={`Ver el ticket ${ticketDisplayNumber(ticket.number)}`}
                onClick={() => onOpenTicket(ticket.id)}
              >
                {ticketDisplayNumber(ticket.number)}
              </Button>
              {ticket.voided ? <Badge variant="destructive">Anulado</Badge> : null}
              {!ticket.voided && ticket.returnedCents > 0 ? <Badge variant="warning">Con devolución</Badge> : null}
            </div>
          )
        },
      },
      {
        id: "fecha",
        header: "Fecha",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <span className="whitespace-nowrap">
            {formatDayMonth(row.original.createdAt, locale, timeZone)}{" "}
            <span className="text-muted-foreground">{formatClock(row.original.createdAt, locale, timeZone)}</span>
          </span>
        ),
      },
      {
        id: "paciente",
        header: "Paciente",
        meta: { view: { role: "title" } },
        cell: ({ row }) => {
          const ticket = row.original
          const doc = ticket.docNumber ? documentText(ticket.docType, ticket.docNumber) : ""
          return (
            <div className="flex min-w-0 flex-col">
              <PersonLink patientId={ticket.patientId} search={{ tab: "cuenta" }} className="font-medium hover:underline">
                {ticket.displayName || "Paciente sin nombre"}
              </PersonLink>
              {doc ? <span className="text-xs text-muted-foreground">{doc}</span> : null}
            </div>
          )
        },
      },
      {
        id: "detalle",
        header: "Lo que pagó",
        cell: ({ row }) => {
          const ticket = row.original
          return (
            <div className={`flex min-w-0 flex-col gap-0.5 ${ticket.voided ? "text-muted-foreground" : ""}`}>
              {ticket.lines.map((line, index) => (
                <span key={`${line.description}-${index}`} className="flex justify-between gap-3">
                  <span className="min-w-0 break-words">{line.description}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {plainAmount(line.appliedCents, ticket.currency, locale)}
                  </span>
                </span>
              ))}
              {ticket.lines.length === 0 ? <span>Adelanto</span> : null}
              {ticket.voided ? (
                <span className="text-xs text-muted-foreground">
                  {ticket.voided.byName ? `Anuló ${ticket.voided.byName}` : "Anulado"}
                  {ticket.voided.reason ? `: ${ticket.voided.reason}` : ""}
                </span>
              ) : ticket.remainingCents > 0 ? (
                <span className="text-xs font-medium text-warning">
                  Le falta pagar {plainAmount(ticket.remainingCents, ticket.currency, locale)}
                </span>
              ) : null}
            </div>
          )
        },
      },
      {
        id: "medio",
        header: "Medio de pago",
        cell: ({ row }) => {
          const ticket = row.original
          if (ticket.methods.length <= 1)
            return <span>{ticket.methods[0]?.name ?? (ticket.creditAppliedCents > 0 ? "Saldo a favor" : "—")}</span>
          return (
            <span className="flex flex-col">
              {ticket.methods.map((method) => (
                <span key={method.name} className="whitespace-nowrap">
                  {method.name} {plainAmount(method.amountCents, ticket.currency, locale)}
                </span>
              ))}
            </span>
          )
        },
      },
      {
        id: "cobro",
        header: "Cobró",
        cell: ({ row }) => <span>{row.original.cashierName ?? "—"}</span>,
      },
      {
        id: "total",
        header: () => <span className="block text-right">Total</span>,
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const ticket = row.original
          return (
            <span
              className={`block text-right font-semibold whitespace-nowrap tabular-nums ${ticket.voided ? "font-normal text-muted-foreground line-through" : ""}`}
            >
              {formatMoney(ticket.totalCents, ticket.currency, locale)}
            </span>
          )
        },
      },
    ],
    [locale, timeZone, onOpenTicket],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })

  if (tickets.isError && isForbidden(tickets.error)) {
    return <EmptyState title="Sin acceso a finanzas" description={financeErrorMessage(tickets.error)} />
  }
  const line = first?.totals ? totalsLine(first.totals, locale) : null

  return (
    <div className="flex flex-col gap-3">
      <FilterBar
        filters={filters}
        sortOptions={[...TICKET_SORT_OPTIONS]}
        searchPlaceholder="Buscar por paciente, documento o N.º de ticket"
        searchLabel="Buscar en cobros"
        searchPending={tickets.isFetching && !tickets.isFetchingNextPage && filtered}
        resetKeys={[...TICKET_LIST_KEYS]}
      />
      {first && line && rows.length > 0 ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1 text-sm text-muted-foreground" role="status">
          <p>
            {first.allDates ? "En todas las fechas · " : ""}
            <span className="font-semibold text-foreground">{line.main}</span>
            {line.refunded ? ` · ${line.refunded}` : ""}
          </p>
          {line.methods ? <p>{line.methods}</p> : null}
        </div>
      ) : null}
      {tickets.isPending ? (
        <SkeletonRegion message="Consultando los cobros">
          <TicketRowsSkeleton />
        </SkeletonRegion>
      ) : tickets.isError && rows.length === 0 ? (
        <ErrorState
          title="No se pudieron consultar los cobros"
          message={financeErrorMessage(tickets.error)}
          onRetry={() => void tickets.refetch()}
        />
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyState
            title={common.filters.noResults}
            description={
              params.from || params.to
                ? "Ningún cobro coincide en esas fechas. Puede que haya pagado en otras: búscalo en todas."
                : "Ningún cobro coincide con lo que buscas. También puedes buscar por documento o número de ticket."
            }
            actionLabel={params.from || params.to ? "Buscar en todas las fechas" : "Limpiar"}
            onAction={() =>
              listSearch.setParams(
                params.from || params.to
                  ? { fecha_from: undefined, fecha_to: undefined }
                  : Object.fromEntries(TICKET_LIST_KEYS.map((key) => [key, undefined])),
              )
            }
          />
        ) : (
          <EmptyState
            title={`Aún no hay cobros en ${branchName}`}
            description="Cada cobro deja aquí su ticket: lo que pagó, cómo y quién cobró."
            actionLabel={canWrite ? "Cobrar" : undefined}
            onAction={canWrite ? onCollect : undefined}
          />
        )
      ) : (
        <div className="flex flex-col gap-2">
          <DataTable
            className="[&_td]:align-top [&_td]:whitespace-normal [&_td]:[overflow-wrap:anywhere]"
            table={table}
            isFetching={tickets.isFetching && !tickets.isFetchingNextPage}
            onRowClick={(ticket: TicketListRow) => onOpenTicket(ticket.id)}
            isRowActive={(ticket: TicketListRow) => ticket.id === openTicketId}
          />
          {tickets.isError ? (
            <p role="alert" className="text-sm text-destructive">
              No se pudo actualizar la lista; se conservan los cobros cargados.{" "}
              <Button type="button" variant="link" size="sm" onClick={() => void tickets.refetch()}>
                Reintentar
              </Button>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground" role="status">
              Se ven {rows.length.toLocaleString()} de {plural(first?.total ?? rows.length, "ticket", "tickets")}
            </p>
            {tickets.hasNextPage ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={tickets.isFetchingNextPage}
                onClick={() => void tickets.fetchNextPage()}
              >
                {tickets.isFetchingNextPage ? <Spinner className="size-6" aria-hidden /> : null}
                Cargar más
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
