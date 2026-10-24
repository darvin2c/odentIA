import { documentText } from "@odentia/clinical"
import { EmptyState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Lock } from "lucide-react"
import { LockedRecordsNoAccess } from "../../components/person/locked-record"
import { formatDate } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { fetchLockedRecords, LOCKED_RECORDS_KEY } from "../../lib/locked-records"
import { hcLabel } from "../../lib/patients"
import { QueryErrorState } from "../../lib/query-error"

/**
 * Pacientes › Historias bloqueadas (ADR 0080, tablero 7): las personas que
 * pidieron borrar sus datos. Solo Administración; ni el buscador rápido ni
 * las listas las muestran.
 */
export const Route = createFileRoute("/_org/people/locked")({
  component: LockedRecordsPage,
})

function LockedRecordsPage() {
  const canSee = usePermission("patients.erase")
  const query = useQuery({ queryKey: LOCKED_RECORDS_KEY, queryFn: fetchLockedRecords, enabled: canSee, retry: false })
  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Historias bloqueadas"
        subtitle={
          <Link to="/people" className="underline-offset-4 hover:underline">
            Volver a Pacientes
          </Link>
        }
      />
      {!canSee ? (
        <LockedRecordsNoAccess />
      ) : query.isPending ? (
        <LoadingState message="Cargando…" />
      ) : query.isError ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.length === 0 ? (
        <EmptyState
          icon={Lock}
          title="Ninguna historia bloqueada"
          description="Cuando alguien pide borrar sus datos, lo no clínico se borra y su historia queda aquí, guardada como pide la ley."
        />
      ) : (
        <>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Pidieron borrar sus datos: lo no clínico se borró y su historia se guarda porque la ley lo pide. Ábrela con motivo
            desde su página.
          </p>
          <ul className="flex max-w-3xl flex-col divide-y rounded-lg border">
            {query.data.map((record) => (
              <li key={record.patientId}>
                <Link
                  to="/people/$personId"
                  params={{ personId: record.personId }}
                  className="flex min-h-14 flex-wrap items-center gap-3 p-3 hover:bg-muted"
                >
                  <Lock aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium">{record.displayName}</span>
                    <span className="text-sm text-muted-foreground">
                      {[hcLabel(record.patientNumber), record.docNumber ? documentText(record.docType, record.docNumber) : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="text-sm text-muted-foreground">
                    Bloqueada el {formatDate(record.lockedAt)}
                    {record.lockedByName ? ` · ${record.lockedByName}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </PageShell>
  )
}
