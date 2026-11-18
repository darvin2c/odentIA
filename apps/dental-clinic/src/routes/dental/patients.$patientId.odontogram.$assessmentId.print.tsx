import { DocumentPaperPanel } from "@odentia/clinic-app/components/patient/document-paper-panel"
import { formatDate } from "@odentia/clinic-app/lib/clinical-journey"
import { QueryErrorState } from "@odentia/clinic-app/lib/query-error"
import { SIGNED_ODONTOGRAM_PURPOSE_LABELS } from "@odentia/dental"
import { LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { fetchSignedOdontograms } from "../../lib/dental/odontogram"

export const Route = createFileRoute("/_org/patients/$patientId/odontogram/$assessmentId/print")({
  component: SignedOdontogramPrintPage,
})

/**
 * Un odontograma firmado (solo en clínicas de Perú, NTS 188; ADR 0036) para ver,
 * imprimir y descargar: su PDF, el papel emitido que se guardó al firmarlo, como la
 * receta (ADR 0132). Es el mismo archivo que va en la copia de la historia, con la
 * clínica, la persona, el momento, el gráfico de la norma a color, la firma de quien
 * lo firmó y el QR para comprobarlo (ADR 0115).
 */
function SignedOdontogramPrintPage() {
  const { patientId, assessmentId } = Route.useParams()
  const query = useQuery({
    queryKey: ["odontogram-assessments", patientId],
    queryFn: () => fetchSignedOdontograms(patientId),
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
  const assessment = query.data.data.find((item) => item.id === assessmentId)
  if (!assessment)
    return (
      <PageShell>
        <QueryErrorState
          error={new Error("No encontramos este odontograma firmado.")}
          onRetry={() => void query.refetch()}
        />
      </PageShell>
    )
  const signer = [assessment.examinerName, assessment.registrationNumber]
    .filter(Boolean)
    .join(" · ")
  return (
    <DocumentPaperPanel
      page
      patientId={patientId}
      pdfPath={`/api/patients/${patientId}/odontogram/assessments/${assessmentId}/pdf`}
      title={`Odontograma firmado · ${SIGNED_ODONTOGRAM_PURPOSE_LABELS[assessment.purpose]}`}
      // A color: los seguros lo piden en rojo y azul.
      status={`Firmado el ${formatDate(assessment.createdAt)}${signer ? ` · ${signer}` : ""} · se imprime a color`}
      send={null}
      revision="firmado"
    />
  )
}
