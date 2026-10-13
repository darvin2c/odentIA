import { Badge, Button, Spinner } from "@odentia/ui"
import {
  ConfirmDialog,
  DataTable,
  DataTableSkeleton,
  EmptyState,
  FilterBar,
  MasterDetail,
  PageHeader,
  PageShell,
  RowActions,
  useDetailMode,
  useListSearch,
} from "@odentia/ui-patterns"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import {
  type ColumnDef,
  getCoreRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { CreatePatientDrawer } from "../../components/patient/create-patient-drawer"
import { ApiError, apiFetch } from "../../lib/api"
import { timeAgo, usePermission } from "../../lib/crm"
import {
  PATIENT_FILTERS,
  PATIENT_SORT_OPTIONS,
  type PatientListRow,
} from "../../lib/patient-overview"
import { ageFrom, hcLabel } from "../../lib/patients"

const PAGE_LIMIT = 20

export const Route = createFileRoute("/_org/patients/")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.contactId === "string" ? { contactId: search.contactId } : {}),
    ...(typeof search.q === "string" ? { q: search.q } : {}),
    ...(typeof search.isActive === "string" ? { isActive: search.isActive } : {}),
    ...(typeof search.sort === "string" ? { sort: search.sort } : {}),
    ...(typeof search.cursor === "string" ? { cursor: search.cursor } : {}),
  }),
  component: PatientsPage,
})

function PatientsPage() {
  const navigate = useNavigate()
  const canView = usePermission("patients.read")
  const canAdmin = usePermission("patients.write")
  const { contactId } = Route.useSearch()
  const [creating, setCreating] = useState(false)
  const mode = useDetailMode()
  const [archiving, setArchiving] = useState<PatientListRow | null>(null)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const archiveMutation = useMutation({
    mutationFn: (row: PatientListRow) =>
      apiFetch(`/api/patients/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !row.isActive }),
      }),
    onSuccess: () => {
      setArchiveError(null)
      setArchiving(null)
      void queryClient.invalidateQueries({ queryKey: ["patients"] })
    },
    onError: (mutationError: unknown) => {
      setArchiveError(
        mutationError instanceof ApiError
          ? (mutationError.shape.message ?? "No se pudo actualizar el estado.")
          : "No se pudo actualizar el estado.",
      )
    },
  })
  const listSearch = useListSearch()
  const search = listSearch.get("q") ?? ""
  const isActive = listSearch.get("isActive")
  const sort = listSearch.get("sort")
  const cursor = listSearch.get("cursor")
  const [previousCursors, setPreviousCursors] = useState<string[]>([])

  useEffect(() => {
    if (!cursor) setPreviousCursors([])
  }, [cursor])

  const patientsQuery = useQuery({
    queryKey: ["patients", search, isActive, sort, cursor],
    queryFn: () => {
      const params = new URLSearchParams()
      params.set("limit", String(PAGE_LIMIT))
      if (search.trim()) params.set("q", search.trim())
      if (isActive) params.set("isActive", isActive)
      if (sort) params.set("sort", sort)
      if (cursor) params.set("cursor", cursor)
      return apiFetch<{ data: PatientListRow[]; nextCursor?: string | null }>(
        `/api/patients?${params}`,
      )
    },
    enabled: canView,
    // La página anterior sigue visible mientras llega la siguiente o el
    // refetch automático: el refetch no vacía el padrón ya cargado.
    placeholderData: keepPreviousData,
  })
  // Placeholder activo: las filas visibles son de la consulta anterior,
  // no de los filtros actuales. Se señaliza y se bloquean las acciones de
  // fila hasta recibir la respuesta nueva.
  const showingPrevious = patientsQuery.isPlaceholderData === true

  const columns = useMemo<ColumnDef<PatientListRow>[]>(
    () => [
      {
        accessorKey: "patientNumber",
        id: "number",
        header: "HC",
        meta: { view: { primary: true } },
        cell: ({ row }) => hcLabel(row.original.patientNumber),
      },
      {
        accessorKey: "displayName",
        id: "name",
        header: "Nombre",
        meta: { view: { role: "title" } },
        cell: ({ row }) => (
          <span className="font-medium">{row.original.displayName ?? "—"}</span>
        ),
      },
      {
        id: "document",
        header: "Documento",
        cell: ({ row }) =>
          row.original.docNumber ? (
            `${row.original.docType ?? ""} ${row.original.docNumber}`.trim()
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "age",
        header: "Edad",
        cell: ({ row }) => ageFrom(row.original.birthDate ?? null) || "—",
      },
      {
        id: "phone",
        header: "Teléfono",
        meta: { view: { primary: true } },
        cell: ({ row }) => row.original.phone || <span className="text-muted-foreground">—</span>,
      },
      {
        id: "status",
        header: "Estado",
        cell: ({ row }) => (
          <Badge variant={row.original.isActive ? "secondary" : "outline"}>
            {row.original.isActive ? "Activo" : "Inactivo"}
          </Badge>
        ),
      },
      {
        accessorKey: "createdAt",
        id: "created",
        header: "Registrado",
        cell: ({ row }) => timeAgo(row.original.createdAt),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <RowActions
            label={`Acciones de ${row.original.displayName ?? "paciente"}`}
            items={[
              {
                key: "open",
                label: "Abrir ficha",
                disabled: showingPrevious,
                onSelect: () =>
                  void navigate({
                    to: "/patients/$patientId",
                    params: { patientId: row.original.id },
                  }),
              },
              ...(canAdmin
                ? [
                    {
                      key: "archive",
                      label: row.original.isActive ? "Archivar" : "Reactivar",
                      tone: row.original.isActive ? ("danger" as const) : undefined,
                      disabled: showingPrevious,
                      onSelect: () => {
                        setArchiveError(null)
                        setArchiving(row.original)
                      },
                    },
                  ]
                : []),
            ]}
          />
        ),
      },
    ],
    [canAdmin, navigate, showingPrevious],
  )

  const rows = patientsQuery.data?.data ?? []
  const nextCursor = patientsQuery.data?.nextCursor ?? null
  const pageNumber = previousCursors.length + 1
  const hasActiveFilter = Boolean(search || isActive)
  const currentSort = sort ?? "-created"
  const sorting: SortingState = [
    { id: currentSort.replace(/^-/, ""), desc: currentSort.startsWith("-") },
  ]

  const table = useReactTable({
    data: rows,
    columns,
    manualSorting: true,
    enableSortingRemoval: false,
    state: { sorting },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater
      const first = next[0]
      if (first) listSearch.setParam("sort", `${first.desc ? "-" : ""}${first.id}`)
    },
    getCoreRowModel: getCoreRowModel(),
  })

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

  /** Cierra el alta y limpia el contacto del query string si venía de una ficha. */
  function closeCreatePatient() {
    setCreating(false)
    if (contactId)
      void navigate({
        to: "/patients",
        replace: true,
        search: (previous) => ({ ...previous, contactId: undefined }),
      })
  }

  return (
    <PageShell>
      <MasterDetail
        panelSize="xl"
        panel={
          mode === "panel" && canAdmin && (creating || contactId) ? (
            <CreatePatientDrawer
              key={contactId ?? "new"}
              asPanel
              open
              contactId={contactId}
              onClose={closeCreatePatient}
            />
          ) : null
        }
      >
        <PageHeader
          title="Pacientes"
          subtitle="Fichas clínicas de la organización"
          actions={
            canAdmin && (
              <Button type="button" onClick={() => setCreating(true)}>
                <Plus aria-hidden />
                Nuevo paciente
              </Button>
            )
          }
        />
        <div className="py-4">
          <FilterBar
            filters={PATIENT_FILTERS}
            sortOptions={PATIENT_SORT_OPTIONS}
            searchPlaceholder="Buscar por nombre, documento, teléfono o correo"
            searchPending={patientsQuery.isFetching}
          />
        </div>
        {patientsQuery.isPending && rows.length === 0 ? (
          <DataTableSkeleton label="Cargando pacientes…" />
        ) : patientsQuery.isError && rows.length === 0 ? (
          <div className="flex flex-col gap-2">
            <p role="alert" className="text-sm text-destructive">
              {patientsQuery.error.message}
            </p>
            <div>
              <Button type="button" variant="outline" onClick={() => void patientsQuery.refetch()}>
                Reintentar
              </Button>
            </div>
          </div>
        ) : rows.length === 0 ? (
          hasActiveFilter ? (
            <EmptyState
              title="Sin pacientes para los filtros seleccionados"
              description="Ajusta la búsqueda o limpia los filtros para ver todo el padrón."
            />
          ) : (
            <EmptyState
              title="Sin pacientes"
              description="Registra el primero con el botón Nuevo paciente."
            />
          )
        ) : (
          <>
            {showingPrevious ? (
              <p className="text-xs text-muted-foreground" role="status">
                Actualizando a los filtros actuales
                {search.trim() ? ` · búsqueda «${search.trim()}»` : ""}
                {sort ? ` · orden ${sort}` : ""} · mostrando resultados anteriores…
              </p>
            ) : null}
            <div aria-busy={showingPrevious}>
              <DataTable table={table} isFetching={patientsQuery.isFetching} />
            </div>
            {patientsQuery.isError ? (
              <p role="alert" className="text-sm text-destructive">
                No se pudo actualizar la lista; se conserva la página cargada.{" "}
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => void patientsQuery.refetch()}
                >
                  Reintentar solo la lista
                </Button>
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2 py-2">
              <p className="text-xs text-muted-foreground">
                Página {pageNumber} · {rows.length} paciente(s)
                {nextCursor ? " · hay más resultados" : " · fin del listado"}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={previousCursors.length === 0 || patientsQuery.isFetching}
                  onClick={goPrevious}
                >
                  Anterior
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!nextCursor || patientsQuery.isFetching}
                  onClick={goNext}
                >
                  {patientsQuery.isFetching ? (
                    <>
                      <Spinner className="size-6" aria-hidden />
                      Siguiente
                    </>
                  ) : (
                    "Siguiente"
                  )}
                </Button>
              </div>
            </div>
          </>
        )}
      </MasterDetail>

      {/* Un solo contenedor montado a la vez: montar panel y drawer juntos
          duplicaría los id/htmlFor de los campos. */}
      {mode === "drawer" && canAdmin && (creating || contactId) ? (
        <CreatePatientDrawer
          key={contactId ?? "new"}
          open
          contactId={contactId}
          onClose={closeCreatePatient}
        />
      ) : null}
      <ConfirmDialog
        open={archiving !== null}
        onClose={() => {
          if (!archiveMutation.isPending) {
            setArchiving(null)
            setArchiveError(null)
          }
        }}
        title={archiving?.isActive ? "Archivar paciente" : "Reactivar paciente"}
        description={
          archiveError ??
          (archiving?.isActive
            ? `«${archiving?.displayName ?? ""}» se archiva pero conserva su historia clínica y relaciones. No se borra.`
            : `«${archiving?.displayName ?? ""}» vuelve a estar activo en el padrón.`)
        }
        confirmLabel={archiving?.isActive ? "Archivar" : "Reactivar"}
        pending={archiveMutation.isPending}
        onConfirm={() => {
          if (archiving) archiveMutation.mutate(archiving)
        }}
      />
    </PageShell>
  )
}
