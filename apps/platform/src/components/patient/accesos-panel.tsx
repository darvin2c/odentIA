import { DataTable, EmptyState, LoadingState } from "@odentia/ui-patterns"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { ShieldCheck } from "lucide-react"
import { apiFetch } from "../../lib/api"
import { formatDateTime } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { QueryErrorState } from "../../lib/query-error"

interface AccessItem {
  id: string
  userId: string
  userName: string | null
  resource: string
  firstAt: string
  lastAt: string
  hits: number
}

const RESOURCE_LABELS: Record<string, string> = {
  resumen: "Resumen clínico",
  antecedentes: "Antecedentes",
  odontograma: "Odontograma",
  historia: "Historia",
  atenciones: "Atenciones",
  diagnosticos: "Diagnósticos",
  notas: "Notas clínicas",
  plan: "Plan de tratamiento",
  tratamientos: "Tratamientos",
  controles: "Controles",
  recetas: "Recetas",
  documentos: "Imágenes y documentos",
  formularios: "Formularios",
  consentimientos: "Consentimientos",
  ordenes: "Órdenes",
}

/**
 * Bitácora de consultas a la historia clínica: quién abrió qué parte de la
 * ficha. Una fila por persona, parte y hora; solo la ve quien audita.
 */
export function AccesosPanel({ patientId }: { patientId: string }) {
  const canAudit = usePermission("audit.read")
  const query = useQuery({
    queryKey: ["clinical-access-log", patientId],
    queryFn: () => apiFetch<{ data: AccessItem[] }>(`/api/patients/${patientId}/access-log`),
    enabled: canAudit,
    retry: false,
  })
  if (query.isPending) return <LoadingState message="Cargando consultas…" />
  if (query.isError)
    return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
  const rows = query.data.data
  if (rows.length === 0)
    return (
      <EmptyState
        icon={ShieldCheck}
        title="Sin consultas registradas"
        description="Aquí queda la traza de quién consulta la historia clínica de este paciente."
      />
    )
  return (
    <section
      className="elevated rounded-xl border bg-card p-6"
      aria-labelledby="accesos-titulo"
    >
      <h2 id="accesos-titulo" className="font-heading text-base font-medium">
        Consultas a la historia clínica
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Las {rows.length} consultas más recientes, agrupadas por persona, parte de la ficha y hora.
        Los cambios se auditan aparte, en Configuración → Auditoría.
      </p>
      <div className="mt-4">
        <AccessTable rows={rows} />
      </div>
    </section>
  )
}

/** Tabla del patrón común: lista en móvil, tabla desde 768 px. */
function AccessTable({ rows }: { rows: AccessItem[] }) {
  const columns = useMemo<ColumnDef<AccessItem>[]>(
    () => [
      {
        id: "quien",
        header: "Quién",
        meta: { view: { primary: true } },
        cell: ({ row }) => row.original.userName ?? "Usuario sin nombre",
      },
      {
        id: "que",
        header: "Qué consultó",
        meta: { view: { primary: true } },
        cell: ({ row }) => RESOURCE_LABELS[row.original.resource] ?? row.original.resource,
      },
      {
        id: "cuando",
        header: "Última consulta",
        cell: ({ row }) => <span className="tabular-nums">{formatDateTime(row.original.lastAt)}</span>,
      },
      {
        id: "veces",
        header: "Veces en la hora",
        cell: ({ row }) => <span className="tabular-nums">{row.original.hits}</span>,
      },
    ],
    [],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  return <DataTable table={table} />
}
