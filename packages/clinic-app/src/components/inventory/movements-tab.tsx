/**
 * Movimientos (tablero 11): lo que entra y sale en la sede, con cuándo (en la
 * zona y el formato de la clínica), qué pasó en una frase con sus enlaces,
 * cuánto y quién. Las páginas las hace el servidor, con «Cargar más».
 */
import { Button, Spinner } from "@odentia/ui"
import { DataTable, DataTableSkeleton, EmptyState, SearchInput, useListSearch } from "@odentia/ui-patterns"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { History, X } from "lucide-react"
import * as React from "react"
import {
  clinicToday,
  fetchMovements,
  fetchProducts,
  formatWhole,
  inventoryKeys,
  MOVEMENT_KIND_OPTIONS,
  MOVEMENTS_PAGE,
  type MovementItem,
  shiftDay,
  whenText,
} from "../../lib/inventory"
import { QueryErrorState } from "../../lib/query-error"
import { ChoiceSelect } from "../ui/choice-select"
import { useInventory } from "./inventory-scope"
import { MovementWhat, movementAmount } from "./movement-words"

/** En la dirección con palabras («7-dias»): un número solo, el router lo guarda entre comillas. */
const PERIODS = [
  { value: "7-dias", label: "Últimos 7 días", days: 7 },
  { value: "30-dias", label: "Últimos 30 días", days: 30 },
  { value: "90-dias", label: "Últimos 90 días", days: 90 },
  { value: "todo", label: "Todo", days: null },
] as const

export function MovementsTab() {
  const { branchId, branchName, open } = useInventory()
  const { get, setParam, setParams } = useListSearch()
  const q = (get("q") ?? "").trim()
  const kind = get("tipo") ?? ""
  const productId = get("productoId") ?? ""
  const chosen = PERIODS.find((item) => item.value === get("periodo")) ?? PERIODS[1]
  const period: string = chosen.value
  const from = chosen.days === null ? undefined : shiftDay(clinicToday(), -(chosen.days - 1))
  const filters = { branchId, q, kind, productId, from: from ?? "" }
  const query = useInfiniteQuery({
    queryKey: inventoryKeys.movements(filters),
    queryFn: ({ pageParam }) =>
      fetchMovements({ branchId, q: q || undefined, kind: kind || undefined, productId: productId || undefined, from, offset: pageParam }),
    // Un fallo se dice al momento con «Reintentar», sin reintentos ocultos.
    retry: false,
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0)
      return loaded < last.total && last.items.length === MOVEMENTS_PAGE ? loaded : undefined
    },
  })
  const rows = React.useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data])
  const total = query.data?.pages[0]?.total ?? 0
  const products = useQuery({
    queryKey: inventoryKeys.products(branchId, "", ""),
    queryFn: () => fetchProducts(branchId),
    enabled: productId !== "",
  })
  const productName = productId ? (products.data?.items.find((item) => item.id === productId)?.name ?? rows[0]?.productName ?? "este producto") : null

  const columns = React.useMemo<ColumnDef<MovementItem>[]>(
    () => [
      {
        id: "cuando",
        header: "Cuándo",
        meta: { view: { primary: true, label: "Cuándo" } },
        cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{whenText(row.original.createdAt)}</span>,
      },
      {
        id: "producto",
        header: "Producto",
        meta: { view: { role: "title" } },
        cell: ({ row }) => (
          <button type="button" className="min-h-11 text-left font-medium hover:underline sm:min-h-0" onClick={() => open.product(row.original.productId)}>
            {row.original.productName}
          </button>
        ),
      },
      {
        id: "que",
        header: "Qué pasó",
        meta: { view: { primary: true, label: "Qué pasó" } },
        cell: ({ row }) => <MovementWhat item={row.original} />,
      },
      {
        id: "cantidad",
        header: () => <span className="block text-right">Cantidad</span>,
        meta: { view: { primary: true, label: "Cantidad" } },
        cell: ({ row }) => <span className="block whitespace-nowrap tabular-nums md:text-right">{movementAmount(row.original)}</span>,
      },
      {
        id: "quien",
        header: "Quién",
        meta: { view: { label: "Quién" } },
        cell: ({ row }) => row.original.actorName ?? "—",
      },
    ],
    [open],
  )
  // Sin paginación: reiniciar la página con cada lista nueva re-renderiza sin fin (las filas son otro arreglo en cada render).
  const table = useReactTable({ data: rows, columns, autoResetPageIndex: false, getCoreRowModel: getCoreRowModel(), getRowId: (row) => row.id })
  const filtered = q !== "" || kind !== "" || productId !== ""

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-card p-3">
        <SearchInput label="Buscar en movimientos" placeholder="Buscar producto" expandable isFetching={query.isFetching && !query.isPending && q !== ""} />
        <ChoiceSelect
          aria-label="Qué pasó"
          className="w-auto min-w-40 rounded-full"
          value={kind}
          onChange={(event) => setParam("tipo", event.target.value || undefined, { replace: true })}
        >
          <option value="">Qué pasó: todo</option>
          {MOVEMENT_KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </ChoiceSelect>
        <ChoiceSelect
          aria-label="Cuándo"
          className="w-auto min-w-40 rounded-full"
          value={period}
          onChange={(event) => setParam("periodo", event.target.value === "30-dias" ? undefined : event.target.value, { replace: true })}
        >
          {PERIODS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </ChoiceSelect>
        {productName ? (
          <Button type="button" size="sm" variant="secondary" className="min-h-11 rounded-full sm:min-h-9" onClick={() => setParams({ productoId: undefined }, { replace: true })}>
            Solo {productName}
            <X aria-hidden />
            <span className="sr-only">: quitar el filtro</span>
          </Button>
        ) : null}
      </div>

      {query.isPending ? (
        <DataTableSkeleton columnCount={5} label="Cargando movimientos…" />
      ) : query.isError && rows.length === 0 ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={History}
          title={filtered ? "Sin resultados" : `Sin movimientos en ${branchName}`}
          description={
            period !== "todo"
              ? "No hay movimientos en estos días con lo elegido. Prueba con «Todo»."
              : filtered
                ? "Ningún movimiento coincide con lo elegido."
                : "Cuando algo llegue, se use, se cuente o se traslade, queda aquí."
          }
          {...(period !== "todo" ? { actionLabel: "Ver todo", onAction: () => setParam("periodo", "todo", { replace: true }) } : {})}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <DataTable table={table} isFetching={query.isFetching && !query.isFetchingNextPage} />
          {query.isError ? (
            <p role="alert" className="text-sm text-destructive">
              No se pudo actualizar la lista; se conservan los movimientos cargados.{" "}
              <Button type="button" variant="link" size="sm" onClick={() => void query.refetch()}>
                Reintentar
              </Button>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground" role="status">
              Mostrando {formatWhole(rows.length)} de {formatWhole(total)}
            </p>
            {query.hasNextPage ? (
              <Button type="button" variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                {query.isFetchingNextPage ? <Spinner className="size-6" aria-hidden /> : null}
                Cargar más
              </Button>
            ) : null}
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Los movimientos no se borran. Si algo quedó mal, se corrige con un ajuste que dice por qué.</p>
    </div>
  )
}
