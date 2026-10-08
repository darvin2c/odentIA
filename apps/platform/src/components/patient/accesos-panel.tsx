import { EmptyState, LoadingState } from "@odentia/ui-patterns"
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
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">
                Quién
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Qué consultó
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Última consulta
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Veces en la hora
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="py-2 pr-4 font-medium">{row.userName ?? "Usuario sin nombre"}</td>
                <td className="py-2 pr-4">{RESOURCE_LABELS[row.resource] ?? row.resource}</td>
                <td className="py-2 pr-4 tabular-nums">{formatDateTime(row.lastAt)}</td>
                <td className="py-2 text-right tabular-nums">{row.hits}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
