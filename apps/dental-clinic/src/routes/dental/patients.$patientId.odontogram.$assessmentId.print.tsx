import { formatDate } from "@odentia/clinic-app/lib/clinical-journey"
import { hcLabel } from "@odentia/clinic-app/lib/patients"
import { QueryErrorState } from "@odentia/clinic-app/lib/query-error"
import { SIGNED_ODONTOGRAM_PURPOSE_LABELS } from "@odentia/dental"
import { Button } from "@odentia/ui"
import { LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { OdontogramDocument } from "../../components/dental/odontogram-document"
import {
  SheetLetterhead,
  SheetPageStyle,
  SheetSignature,
} from "../../components/dental/odontogram-sheet"
import { fetchSignedOdontogramPrint } from "../../lib/dental/odontogram"

export const Route = createFileRoute("/_org/patients/$patientId/odontogram/$assessmentId/print")({
  component: SignedOdontogramPrintPage,
})

/**
 * Hoja de un odontograma firmado (solo en clínicas de Perú, NTS 188; ADR 0036)
 * para imprimir y entregar: la clínica, la persona, el momento y su instantánea
 * en el gráfico de la norma, en negro (5.17), con la firma electrónica de quien
 * lo firmó y el QR para comprobarlo (ADR 0115).
 */
function SignedOdontogramPrintPage() {
  const { patientId, assessmentId } = Route.useParams()
  const query = useQuery({
    queryKey: ["odontogram-print", patientId, assessmentId],
    queryFn: () => fetchSignedOdontogramPrint(patientId, assessmentId),
  })
  if (query.isPending)
    return (
      <PageShell>
        <LoadingState kind="indeterminate" message="Preparando el odontograma…" />
      </PageShell>
    )
  if (query.isError)
    return (
      <PageShell>
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      </PageShell>
    )
  const { assessment, patient, establishment, checkUrl } = query.data.data
  return (
    <PageShell className="flex flex-col gap-4">
      <SheetPageStyle />
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-muted-foreground">
          Odontograma firmado. Usa «Imprimir» para llevarlo en papel.
        </p>
        <Button type="button" onClick={() => window.print()}>
          Imprimir
        </Button>
      </div>
      <article className="odontogram-sheet mx-auto flex w-full max-w-[210mm] flex-col gap-3 rounded-lg border bg-white p-6 text-sm text-black">
        <SheetLetterhead establishment={establishment} />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold tracking-wide">ODONTOGRAMA</h1>
            <p className="text-[11px] text-gray-700">{assessment.standard} · Gráfico oficial</p>
            <p className="font-semibold">{SIGNED_ODONTOGRAM_PURPOSE_LABELS[assessment.purpose]}</p>
          </div>
          <div className="text-right">
            <p className="font-semibold">Paciente: {assessment.patientName}</p>
            <p>Historia clínica: {hcLabel(patient.patientNumber)}</p>
            {patient.docNumber ? (
              <p>
                {patient.docType ?? "Documento"}: {patient.docNumber}
              </p>
            ) : null}
            <p>Fecha: {formatDate(assessment.createdAt)}</p>
          </div>
        </div>
        <OdontogramDocument
          entries={assessment.entries}
          standard={assessment.standard}
          date={assessment.createdAt}
          specifications={assessment.specifications}
          observations={assessment.observations}
          examinerName={assessment.examinerName}
          examinerTitle={assessment.examinerTitle}
          registrationNumber={assessment.registrationNumber}
          patientName={assessment.patientName}
          embedded={{
            signature: (
              <SheetSignature
                name={assessment.examinerName}
                title={assessment.examinerTitle}
                registration={assessment.registrationNumber}
                at={assessment.createdAt}
                checkUrl={checkUrl}
              />
            ),
          }}
        />
      </article>
    </PageShell>
  )
}
