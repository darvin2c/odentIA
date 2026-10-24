import { SIGNED_ODONTOGRAM_PURPOSE_LABELS } from "@odentia/dental"
import { Button } from "@odentia/ui"
import { LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { OdontogramDocument } from "../../components/dental/odontogram-document"
import { fetchSignedOdontogramPrint } from "../../lib/dental/odontogram"
import { hcLabel } from "@odentia/clinic-app/lib/patients"
import { QueryErrorState } from "@odentia/clinic-app/lib/query-error"

export const Route = createFileRoute("/_org/patients/$patientId/odontogram/$assessmentId/print")({
  component: SignedOdontogramPrintPage,
})

/**
 * Hoja de un odontograma firmado (solo en clínicas de Perú, NTS 188; ADR 0036)
 * para imprimir y entregar: la clínica, la persona, el momento y su
 * instantánea en el gráfico de la norma, en negro (5.17), con quien lo firmó
 * desde su perfil y la línea «Firma y sello» para el papel (5.3).
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
  const { assessment, patient, establishment } = query.data.data
  return (
    <PageShell className="flex flex-col gap-4">
      <style>{`@page { size: A4; margin: 11mm }
      @media print {
        body * { visibility: hidden; }
        .odontogram-sheet, .odontogram-sheet * { visibility: visible; }
        .odontogram-sheet { position: absolute; inset: 0 auto auto 0; width: 100%; border: 0; box-shadow: none; }
      }`}</style>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-muted-foreground">
          Revisa el odontograma y usa «Imprimir»; firma y sello van en el papel.
        </p>
        <Button type="button" onClick={() => window.print()}>
          Imprimir
        </Button>
      </div>
      <article className="odontogram-sheet mx-auto flex w-full max-w-[210mm] flex-col gap-3 rounded-lg border bg-white p-6 text-sm text-black">
        <header className="flex flex-wrap items-start justify-between gap-4">
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
            <p className="font-semibold">{SIGNED_ODONTOGRAM_PURPOSE_LABELS[assessment.purpose]}</p>
            <p>Historia clínica: {hcLabel(patient.patientNumber)}</p>
            {patient.docNumber ? (
              <p>
                {patient.docType ?? "Documento"}: {patient.docNumber}
              </p>
            ) : null}
          </div>
        </header>
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
        />
      </article>
    </PageShell>
  )
}
