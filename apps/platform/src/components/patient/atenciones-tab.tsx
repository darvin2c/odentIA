import { Badge, Button } from "@odentia/ui"
import { DataTable, DataTableSkeleton, EmptyState } from "@odentia/ui-patterns"
import { useInfiniteQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { ClipboardList } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { apiFetch } from "../../lib/api"
import { useMemberName, usePermission } from "../../lib/crm"
import { type Encounter, encounterStatusLabel } from "../../lib/patients"

/** Atención en la lista del paciente: lo necesario para reconocerla sin abrirla. */
export interface EncounterListItem extends Encounter {
  diagnosisCodes: string[]
  procedureCount: number
}

const FILTERS = [
  { value: "", label: "Todas" },
  { value: "borrador", label: "En curso" },
  { value: "finalizada", label: "Finalizadas" },
  { value: "anulada", label: "Anuladas" },
] as const

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("es-PE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
}

const STATUS_VARIANT: Record<string, "outline" | "success" | "secondary"> = {
  borrador: "outline",
  finalizada: "success",
  anulada: "secondary",
}

/**
 * Atenciones del paciente, incluidas las en curso y las anuladas: la historia
 * cronológica muestra lo cerrado; aquí se retoma un borrador o se entiende por
 * qué se anuló otro. Abrir una fila lleva a la atención.
 */
export function AtencionesTab({ patientId }: { patientId: string }): React.JSX.Element {
  const navigate = useNavigate()
  const canWrite = usePermission("clinical.write")
  const memberName = useMemberName()
  const [status, setStatus] = useState<string>("")
  const query = useInfiniteQuery({
    queryKey: ["encounter", patientId, "list", status],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "25" })
      if (status) params.set("status", status)
      if (pageParam) params.set("cursor", pageParam)
      return apiFetch<{ data: EncounterListItem[]; nextCursor: string | null }>(
        `/api/patients/${patientId}/encounters?${params.toString()}`,
      )
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.data) ?? [], [query.data])
  const open = useCallback(
    (encounterId: string) =>
      void navigate({
        to: "/patients/$patientId/encounters/$encounterId",
        params: { patientId, encounterId },
      }),
    [navigate, patientId],
  )

  const columns = useMemo<ColumnDef<EncounterListItem>[]>(
    () => [
      {
        id: "fecha",
        header: "Inicio",
        cell: ({ row }) => (
          <time dateTime={row.original.startedAt ?? row.original.createdAt}>
            {formatDate(row.original.startedAt ?? row.original.createdAt)}
          </time>
        ),
      },
      {
        id: "motivo",
        header: "Motivo",
        meta: { view: { role: "title" } },
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col">
            <span className="line-clamp-2">{row.original.reason ?? "Sin motivo"}</span>
            {row.original.status === "anulada" && row.original.voidReason ? (
              <span className="text-xs text-muted-foreground">
                Anulada: {row.original.voidReason}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "estado",
        header: "Estado",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <Badge variant={STATUS_VARIANT[row.original.status] ?? "outline"}>
            {encounterStatusLabel(row.original.status)}
          </Badge>
        ),
      },
      {
        id: "profesional",
        header: "Profesional",
        meta: { view: { primary: true } },
        cell: ({ row }) => memberName(row.original.dentistUserId),
      },
      {
        id: "diagnostico",
        header: "Diagnóstico",
        cell: ({ row }) =>
          row.original.diagnosisCodes.length > 0 ? row.original.diagnosisCodes.join(", ") : "—",
      },
      {
        id: "actos",
        header: "Actos",
        cell: ({ row }) => row.original.procedureCount,
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <div className="text-right">
            <Button
              type="button"
              size="sm"
              variant={row.original.status === "borrador" && canWrite ? "default" : "outline"}
              onClick={(event) => {
                event.stopPropagation()
                open(row.original.id)
              }}
            >
              {row.original.status === "borrador" && canWrite ? "Reanudar" : "Ver"}
            </Button>
          </div>
        ),
      },
    ],
    [canWrite, memberName, open],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <fieldset className="m-0 flex flex-wrap gap-1.5 border-0 p-0" aria-label="Filtrar por estado">
        {FILTERS.map((filter) => (
          <Button
            key={filter.value}
            type="button"
            size="sm"
            variant={status === filter.value ? "default" : "outline"}
            aria-pressed={status === filter.value}
            onClick={() => setStatus(filter.value)}
          >
            {filter.label}
          </Button>
        ))}
      </fieldset>
      {query.isLoading ? (
        <DataTableSkeleton columnCount={6} rowCount={4} label="Cargando atenciones…" />
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error.message}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={status ? "Sin atenciones con este estado" : "Sin atenciones"}
          description="Las atenciones se abren desde la cabecera de la ficha o al atender una cita."
        />
      ) : (
        <>
          <DataTable table={table} onRowClick={(row) => open(row.id)} />
          {query.hasNextPage ? (
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? "Cargando…" : "Cargar más"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
