import { usePermission } from "@odentia/clinic-app/lib/crm"
import { fetchPatientDiagnoses, setDiagnosisStatusApi } from "@odentia/clinic-app/lib/encounters"
import { activeOrgLocale, activeOrgTimeZone } from "@odentia/clinic-app/lib/locale"
import { fetchPatientHealth } from "@odentia/clinic-app/lib/patients"
import { QueryErrorState } from "@odentia/clinic-app/lib/query-error"
import { diagnosisCodeLabel } from "@odentia/clinical"
import { pregnancyLines, readMedicalHistory } from "@odentia/medical"
import { Button } from "@odentia/ui"
import { regionToday } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

function sinceWords(iso: string | null): string {
  if (!iso) return ""
  return `desde el ${new Date(iso).toLocaleDateString(activeOrgLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: activeOrgTimeZone(),
  })}`
}

/**
 * La lista de problemas de latidIA (issue 229, entrega 5): el embarazo y la
 * lactancia con su fecha, que cambian lo que se receta, y los diagnósticos
 * activos de sus atenciones, cada uno con desde cuándo y quién lo puso. Un
 * problema que ya pasó se marca resuelto aquí, sin abrir la atención.
 */
export function ProblemsCard({
  patientId,
  onSection,
}: {
  patientId: string
  onSection: (section: string) => void
}) {
  const canRead = usePermission("clinical.read")
  const canWrite = usePermission("clinical.write")
  const queryClient = useQueryClient()
  const health = useQuery({
    queryKey: ["patient-health", patientId],
    queryFn: () => fetchPatientHealth(patientId),
    enabled: canRead,
  })
  const diagnoses = useQuery({
    queryKey: ["patient-diagnoses", patientId, "activo"],
    queryFn: () => fetchPatientDiagnoses(patientId, "activo"),
    enabled: canRead,
  })
  const resolve = useMutation({
    mutationFn: (diagnosisId: string) => setDiagnosisStatusApi(patientId, diagnosisId, "resuelto"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["patient-diagnoses", patientId] }),
  })
  if (!canRead) return null
  const today = regionToday()
  const pregnancy = pregnancyLines(
    readMedicalHistory(health.data?.data.latestAnamnesis?.answers, today),
    today,
  )
  const active = diagnoses.data?.data ?? []
  return (
    <section
      aria-label="Lista de problemas"
      className="flex min-w-0 flex-col gap-3 elevated rounded-xl border bg-card p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-base font-medium">Lista de problemas</h2>
        <Button type="button" size="sm" variant="outline" onClick={() => onSection("historia")}>
          Historia
        </Button>
      </div>
      {pregnancy.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {pregnancy.map((line) => (
            <li
              key={line}
              className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm font-medium"
            >
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      {diagnoses.isError ? (
        <QueryErrorState error={diagnoses.error} onRetry={() => void diagnoses.refetch()} />
      ) : diagnoses.isPending ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : active.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Sin diagnósticos activos. Los diagnósticos de cada atención quedan aquí hasta que se
          resuelven.
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {active.map((diagnosis) => (
            <li
              key={diagnosis.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0"
            >
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">
                  {diagnosis.description ||
                    diagnosisCodeLabel(diagnosis.diagnosisSystem, diagnosis.diagnosisCode)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {[
                    diagnosisCodeLabel(diagnosis.diagnosisSystem, diagnosis.diagnosisCode),
                    diagnosis.diagnosisType === "provisional"
                      ? "presuntivo"
                      : diagnosis.diagnosisType === "confirmed"
                        ? "definitivo"
                        : "",
                    sinceWords(diagnosis.encounterStartedAt),
                    diagnosis.authorName ?? "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              {canWrite ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={resolve.isPending}
                  onClick={() => resolve.mutate(diagnosis.id)}
                >
                  Marcar resuelto
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {resolve.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudo marcar como resuelto. Vuelve a intentarlo.
        </p>
      ) : null}
    </section>
  )
}
