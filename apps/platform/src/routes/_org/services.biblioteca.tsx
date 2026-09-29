import { Badge, Button, Checkbox, toast } from "@odentia/ui"
import {
  common,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  PageHeader,
  RowActions,
  SubmitButton,
  useListSearch,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Library } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ApiError } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import {
  fetchServices,
  fetchTreatmentTemplates,
  incorporateTemplatesApi,
  SPECIALTY_FILTER_OPTIONS,
  TREATMENT_SCOPE_LABELS,
  TREATMENT_SPECIALTY_LABELS,
  type TreatmentTemplateCatalog,
  type TreatmentTemplateItem,
} from "../../lib/services"

export const Route = createFileRoute("/_org/services/biblioteca")({
  component: BibliotecaPage,
})

const PAGE_LIMIT = 20

/** Tope de incorporación por envío: la API acepta 100 identificadores como máximo. */
const MAX_SELECTION = 100

/** Todos los templateId ya incorporados (recorre el cursor de cada estado). */
async function fetchAllOwnedTemplateIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const state of ["active", "inactive"] as const) {
    let cursor: string | undefined
    do {
      const page = await fetchServices({ state, limit: 100, cursor })
      for (const row of page.data) {
        if (row.templateId) ids.add(row.templateId)
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)
  }
  return ids
}

/**
 * Biblioteca de prestaciones: el catálogo oficial completo, sin precios. Lo que
 * se incorpora entra al tarifario inactivo y con tarifa 0, para revisar el monto
 * y activarlo allí.
 */
function BibliotecaPage() {
  const canIncorporate = usePermission("settings.write")
  const canViewLibrary =
    canIncorporate ||
    usePermission("clinical.read") ||
    usePermission("appointments.read") ||
    usePermission("finance.read")
  const queryClient = useQueryClient()
  const listSearch = useListSearch()
  const search = listSearch.get("q") ?? ""
  const specialtyFilter = listSearch.get("especialidad") ?? "todas"
  const cursor = listSearch.get("cursor")
  const [previousCursors, setPreviousCursors] = useState<string[]>([])
  const [checked, setChecked] = useState<string[]>([])

  useEffect(() => {
    if (!cursor) setPreviousCursors([])
  }, [cursor])

  // Al cambiar búsqueda o filtro se vuelve a la primera página: el cursor anterior
  // pertenece al resultado previo y la selección por página se conserva aparte.
  const filterKey = `${search}||${specialtyFilter}`
  const prevFilterKey = useRef(filterKey)
  useEffect(() => {
    if (prevFilterKey.current === filterKey) return
    prevFilterKey.current = filterKey
    setPreviousCursors([])
    if (cursor) listSearch.setParam("cursor", undefined)
  })

  const libraryQuery = useQuery({
    queryKey: ["services", "biblioteca", search, specialtyFilter, cursor],
    enabled: canViewLibrary,
    queryFn: () =>
      fetchTreatmentTemplates({
        q: search.trim() || undefined,
        specialty: specialtyFilter === "todas" ? undefined : specialtyFilter,
        cursor: cursor ?? undefined,
        limit: PAGE_LIMIT,
      }),
  })

  const ownedQuery = useQuery({
    queryKey: ["services", "owned-templates"],
    enabled: canViewLibrary,
    queryFn: fetchAllOwnedTemplateIds,
    staleTime: 60_000,
  })

  const rows = useMemo(() => libraryQuery.data?.data ?? [], [libraryQuery.data])
  const nextCursor = libraryQuery.data?.nextCursor ?? null
  const total = libraryQuery.data?.total ?? rows.length
  const catalog: TreatmentTemplateCatalog | null = libraryQuery.data?.catalog ?? null
  const pageNumber = previousCursors.length + 1
  const owned = ownedQuery.data ?? new Set<string>()
  const selectable = rows.filter((row) => !owned.has(row.id))
  /** Selección acumulada de todas las páginas visitadas (ya incorporadas excluidas). */
  const checkedPending = checked.filter((id) => !owned.has(id))
  const incorporateMutation = useMutation({
    mutationFn: (templateIds: string[]) => incorporateTemplatesApi(templateIds),
    onSuccess: async (result) => {
      setChecked([])
      await queryClient.invalidateQueries({ queryKey: ["services"] })
      const created = result.data.created.length
      toast.success(
        created > 0
          ? `${created} prestación(es) incorporada(s) inactiva(s): revisa sus tarifas y actívalas`
          : "Esas prestaciones ya estaban en tu tarifario",
      )
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError ? (error.shape.message ?? error.message) : error.message,
      )
    },
  })

  const toggle = useCallback(
    (id: string) => {
      if (!checked.includes(id) && checkedPending.length >= MAX_SELECTION) {
        toast.info(`Máximo ${MAX_SELECTION} prestaciones por incorporación`)
        return
      }
      setChecked((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]))
    },
    [checked, checkedPending.length],
  )

  /** Casillas de esta página marcadas (la selección global se conserva al navegar). */
  const checkedOnPage = selectable.filter((row) => checked.includes(row.id))
  const allSelected = selectable.length > 0 && checkedOnPage.length === selectable.length
  const togglePage = useCallback(
    (value: boolean) => {
      if (value) {
        const fresh = selectable.map((row) => row.id).filter((id) => !checked.includes(id))
        const room = MAX_SELECTION - checkedPending.length
        if (room <= 0) {
          toast.info(`Máximo ${MAX_SELECTION} prestaciones por incorporación`)
          return
        }
        if (fresh.length > room) {
          toast.info(`Solo se seleccionan ${room} más (máximo ${MAX_SELECTION})`)
        }
        setChecked((prev) => [...prev, ...fresh.slice(0, room)])
        return
      }
      setChecked((prev) => {
        const pageIds = new Set(selectable.map((row) => row.id))
        return prev.filter((id) => !pageIds.has(id))
      })
    },
    [checked, checkedPending.length, selectable],
  )

  const columns = useMemo<ColumnDef<TreatmentTemplateItem>[]>(
    () => [
      {
        id: "select",
        meta: { view: { role: "select" } },
        header: () => (
          <Checkbox
            checked={allSelected}
            disabled={!canIncorporate || selectable.length === 0}
            onCheckedChange={(value) => togglePage(value === true)}
            aria-label="Seleccionar las prestaciones disponibles de esta página"
          />
        ),
        cell: ({ row }) => {
          const incorporated = owned.has(row.original.id)
          return (
            <Checkbox
              checked={checked.includes(row.original.id)}
              disabled={!canIncorporate || incorporated}
              onCheckedChange={() => toggle(row.original.id)}
              aria-label={`Incorporar ${row.original.name}`}
            />
          )
        },
      },
      {
        accessorKey: "name",
        header: "Prestación",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <span className="flex min-w-0 max-w-xl flex-col whitespace-normal">
            <span className="font-medium break-words">{row.original.name}</span>
            <span className="text-xs text-muted-foreground">
              {TREATMENT_SPECIALTY_LABELS[row.original.specialty] ?? row.original.specialty} ·{" "}
              {TREATMENT_SCOPE_LABELS[row.original.scope] ?? row.original.scope}
              {row.original.surfaceCountMin !== null
                ? ` · ${row.original.surfaceCountMin}–${row.original.surfaceCountMax ?? "…"} superficies`
                : ""}
            </span>
          </span>
        ),
      },
      {
        id: "codigo",
        header: "Código oficial",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          // Cada plantilla proyecta UN código oficial: se muestra completo, sin recortes.
          const coding = row.original.codings[0]
          if (!coding) {
            return <span className="text-muted-foreground">Sin código oficial</span>
          }
          return (
            <span className="flex min-w-0 flex-col whitespace-normal">
              <span className="font-mono font-medium break-all">{coding.code}</span>
              <span className="text-xs text-muted-foreground break-words">
                {coding.system} · edición {coding.version}
              </span>
            </span>
          )
        },
      },
      {
        id: "estado",
        header: "Estado",
        cell: ({ row }) =>
          owned.has(row.original.id) ? (
            <Badge variant="secondary">En tu tarifario</Badge>
          ) : (
            <Badge variant="outline">Disponible</Badge>
          ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const incorporated = owned.has(row.original.id)
          return (
            <RowActions
              label={`Acciones de ${row.original.name}`}
              items={[
                {
                  key: "incorporar",
                  label: "Incorporar a mi tarifario",
                  disabled: incorporated || !canIncorporate || incorporateMutation.isPending,
                  onSelect: () => incorporateMutation.mutate([row.original.id]),
                },
              ]}
            />
          )
        },
      },
    ],
    [
      allSelected,
      canIncorporate,
      checked,
      incorporateMutation.isPending,
      incorporateMutation.mutate,
      owned,
      selectable,
      toggle,
      togglePage,
    ],
  )

  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })

  const goNext = () => {
    if (!nextCursor) return
    setPreviousCursors((stack) => [...stack, cursor ?? ""])
    listSearch.setParam("cursor", nextCursor)
  }
  const goPrevious = () => {
    const copy = [...previousCursors]
    const previous = copy.pop()
    setPreviousCursors(copy)
    listSearch.setParam("cursor", previous || undefined)
  }

  const hasFilters = search.trim() !== "" || specialtyFilter !== "todas"

  if (!canViewLibrary) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          title="Biblioteca de prestaciones"
          subtitle="Catálogo oficial sin precios: lo que se incorpora se tarifa en el tarifario"
        />
        <EmptyState
          title="Sin acceso"
          description="Necesitas permiso clínico, de agenda, de caja o de configuración para ver la biblioteca."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Biblioteca de prestaciones"
        subtitle="Catálogo oficial sin precios: lo que se incorpora se tarifa en el tarifario"
      />
      <FilterBar
        filters={[
          {
            key: "especialidad",
            label: "Especialidad",
            type: "select",
            options: SPECIALTY_FILTER_OPTIONS,
          },
        ]}
        sortOptions={[]}
        searchPlaceholder="Buscar por código o nombre"
      />
      {catalog ? (
        <div className="flex flex-col gap-1 rounded-lg border p-3 text-sm" role="note">
          <p className="font-medium">
            Biblioteca {catalog.system} · edición {catalog.version}
          </p>
          <p className="text-xs text-muted-foreground">
            Cobertura limitada a esta edición y su ámbito ({catalog.scope}):{" "}
            {catalog.availableCount} de {catalog.expectedCount} procedimientos disponibles. Cada
            prestación corresponde a un solo código oficial.
          </p>
          <p className="text-xs">
            <a
              href={catalog.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Ver fuente oficial
            </a>
          </p>
        </div>
      ) : libraryQuery.data ? (
        <p
          className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground"
          role="note"
        >
          Sin edición oficial importada: la biblioteca no muestra cobertura ni fuente.
        </p>
      ) : null}
      {canIncorporate ? (
        <div className="flex flex-col items-end gap-1">
          <SubmitButton
            type="button"
            disabled={checkedPending.length === 0}
            pending={incorporateMutation.isPending}
            onClick={() => incorporateMutation.mutate(checkedPending)}
          >
            <Library aria-hidden />
            {checkedPending.length > 0
              ? `Incorporar a mi tarifario (${checkedPending.length})`
              : "Incorporar a mi tarifario"}
          </SubmitButton>
          {checkedPending.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              La selección se conserva al cambiar de página (máximo {MAX_SELECTION} por envío). Se
              incorporan inactivas a tarifa 0; revisa sus precios y actívalas antes de usarlas.
            </p>
          ) : null}
        </div>
      ) : null}
      {libraryQuery.isPending ? (
        <LoadingState />
      ) : libraryQuery.isError ? (
        <ErrorState
          error={libraryQuery.error instanceof ApiError ? libraryQuery.error.shape : null}
          onRetry={() => void libraryQuery.refetch()}
        />
      ) : rows.length === 0 && !hasFilters ? (
        <EmptyState
          icon={Library}
          title="Biblioteca vacía"
          description="Aún no hay prestaciones publicadas."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Library}
          title="Sin resultados"
          description="Ninguna prestación de la biblioteca coincide con la búsqueda."
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Denominación oficial completa con su código único
            {catalog ? ` (${catalog.system} · edición ${catalog.version})` : ""}, sin precios
            propuestos. Al incorporarlas quedan inactivas con tarifa 0; revisa cada monto y
            actívalas en el tarifario. El nombre incorporado es comercial y editable; el código
            oficial no se altera.
          </p>
          <DataTable table={table} />
          <div className="flex flex-wrap items-center justify-between gap-2 py-2">
            <p className="text-xs text-muted-foreground">
              Página {pageNumber} · {rows.length} en esta página · {total} con este filtro
              {nextCursor ? " · hay más resultados" : " · fin del listado"}
              {catalog
                ? ` · cobertura de la edición: ${catalog.availableCount} de ${catalog.expectedCount}`
                : ""}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={previousCursors.length === 0 || libraryQuery.isFetching}
                onClick={goPrevious}
              >
                {common.filters.previous}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!nextCursor || libraryQuery.isFetching}
                onClick={goNext}
              >
                {common.filters.next}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
