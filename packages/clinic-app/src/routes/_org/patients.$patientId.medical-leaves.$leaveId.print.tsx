import { diagnosisCodeLabel, medicalLeaveWords } from "@odentia/clinical"
import { Button } from "@odentia/ui"
import { LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { formatDate } from "../../lib/clinical-journey"
import { fetchMedicalLeavePrint } from "../../lib/medical-leaves"
import { ageFrom, hcLabel } from "../../lib/patients"
import { QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute("/_org/patients/$patientId/medical-leaves/$leaveId/print")({
  component: MedicalLeavePrintPage,
})

/**
 * Hoja del descanso médico para imprimir (issue 229, decisión 8): el
 * establecimiento, la persona, los días con sus fechas, el diagnóstico solo si
 * lo autorizó, las indicaciones y la firma con colegiatura. Es una constancia
 * propia, sin el formato oficial de ningún país. La anulada se muestra como tal.
 */
function MedicalLeavePrintPage() {
  const { patientId, leaveId } = Route.useParams()
  const query = useQuery({
    queryKey: ["medical-leave-print", patientId, leaveId],
    queryFn: () => fetchMedicalLeavePrint(patientId, leaveId),
  })
  if (query.isPending)
    return (
      <PageShell>
        <LoadingState kind="indeterminate" message="Preparando el descanso médico…" />
      </PageShell>
    )
  if (query.isError)
    return (
      <PageShell>
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      </PageShell>
    )
  const { leave, patient, establishment, diagnosisDescription } = query.data.data
  const cancelled = leave.status !== "emitido"
  const age = ageFrom(patient.birthDate)
  return (
    <PageShell className="flex flex-col gap-4">
      <style>{`@media print {
        body * { visibility: hidden; }
        .leave-sheet, .leave-sheet * { visibility: visible; }
        .leave-sheet { position: absolute; inset: 0 auto auto 0; width: 100%; border: 0; box-shadow: none; }
      }`}</style>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-muted-foreground">
          {cancelled
            ? "Este descanso médico está anulado: no vale como constancia."
            : "Revisa la constancia y usa «Imprimir»; firma y sello van en el papel."}
        </p>
        <Button type="button" disabled={cancelled} onClick={() => window.print()}>
          Imprimir
        </Button>
      </div>
      <article className="leave-sheet mx-auto flex w-full max-w-[210mm] flex-col gap-5 rounded-lg border bg-white p-8 text-sm text-black">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
          <div>
            <p className="text-base font-semibold">
              {establishment?.tradeName || establishment?.legalName || "Establecimiento"}
            </p>
            {establishment?.fiscalDocNumber ? (
              <p>
                {establishment.fiscalDocType} {establishment.fiscalDocNumber}
              </p>
            ) : null}
            {establishment?.address ? <p>{establishment.address}</p> : null}
          </div>
          <div className="text-right">
            <p className="text-base font-semibold">Descanso médico N.º {leave.leaveNumber}</p>
            <p>Emitido el {formatDate(leave.issuedAt)}</p>
            {cancelled ? <p className="font-semibold">ANULADO</p> : null}
          </div>
        </header>
        <section className="grid gap-1 sm:grid-cols-2">
          <p>
            <span className="font-medium">Paciente:</span> {patient.displayName}
          </p>
          <p>
            <span className="font-medium">Historia clínica:</span> {hcLabel(patient.patientNumber)}
          </p>
          {patient.docNumber ? (
            <p>
              <span className="font-medium">{patient.docType ?? "Documento"}:</span>{" "}
              {patient.docNumber}
            </p>
          ) : null}
          {age ? (
            <p>
              <span className="font-medium">Edad:</span> {age} años
            </p>
          ) : null}
        </section>
        <section className="flex flex-col gap-2">
          <p className="text-base font-medium">
            Se indican {medicalLeaveWords(leave.startsOn, leave.days)}.
          </p>
          {leave.showDiagnosis && leave.diagnosisCode ? (
            <p>
              <span className="font-medium">Diagnóstico:</span>{" "}
              {diagnosisCodeLabel(leave.diagnosisSystem, leave.diagnosisCode)}
              {diagnosisDescription ? ` · ${diagnosisDescription}` : ""}
            </p>
          ) : null}
          {leave.notes ? (
            <p>
              <span className="font-medium">Indicaciones:</span> {leave.notes}
            </p>
          ) : null}
        </section>
        <footer className="mt-10 flex justify-end">
          <div className="w-64 border-t pt-2 text-center">
            <p className="font-medium">{leave.signerName ?? "—"}</p>
            {leave.signerTitle ? <p>{leave.signerTitle}</p> : null}
            {leave.signerRegistration ? <p>{leave.signerRegistration}</p> : null}
            <p className="text-xs">Firma y sello</p>
          </div>
        </footer>
      </article>
    </PageShell>
  )
}
