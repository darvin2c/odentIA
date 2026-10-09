import { Button } from "@odentia/ui"
import { LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ConsentSheet } from "../../components/patient/consent-sheet"
import { fetchConsentPrint } from "../../lib/clinical-forms"
import { hcLabel } from "../../lib/patients"
import { QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute("/_org/patients/$patientId/consents/$consentId/print")({
  component: ConsentPrintPage,
})

/**
 * Hoja del consentimiento para imprimir: el pendiente sale con recuadros para
 * firmar en papel (alternativa a la firma en pantalla); el firmado, con sus
 * firmas y la huella del PDF guardado.
 */
function ConsentPrintPage() {
  const { consentId } = Route.useParams()
  const query = useQuery({
    queryKey: ["consent-print", consentId],
    queryFn: () => fetchConsentPrint(consentId),
  })
  if (query.isPending)
    return (
      <PageShell>
        <LoadingState message="Preparando el consentimiento…" />
      </PageShell>
    )
  if (query.isError)
    return (
      <PageShell>
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      </PageShell>
    )
  const { document, patient, establishment, diagnosisDescription } = query.data.data
  const cancelled = document.status === "anulado"
  return (
    <PageShell className="flex flex-col gap-4">
      <style>{`@media print {
        body * { visibility: hidden; }
        .consent-sheet, .consent-sheet * { visibility: visible; }
        .consent-sheet { position: absolute; inset: 0 auto auto 0; width: 100%; }
        .consent-sheet article { border: 0; }
      }`}</style>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-muted-foreground">
          {cancelled
            ? "Este consentimiento está anulado: no se usa."
            : document.status === "pendiente"
              ? "Para firma en papel: imprime, firma y adjunta el escaneo en Documentos."
              : "Copia del consentimiento con sus firmas."}
        </p>
        <Button type="button" disabled={cancelled} onClick={() => window.print()}>
          Imprimir
        </Button>
      </div>
      <div className="consent-sheet mx-auto flex w-full max-w-[210mm] flex-col gap-3">
        {establishment ? (
          <header className="text-sm">
            <p className="font-semibold">{establishment.tradeName || establishment.legalName}</p>
            <p className="text-xs">
              {[
                establishment.fiscalDocNumber
                  ? `${establishment.fiscalDocType ?? "RUC"} ${establishment.fiscalDocNumber}`
                  : null,
                establishment.address,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </header>
        ) : null}
        <ConsentSheet
          document={document}
          diagnosisDescription={diagnosisDescription}
          paper
          patientLabel={`Paciente: ${patient.displayName} · ${hcLabel(patient.patientNumber)}${
            patient.docNumber ? ` · ${patient.docType ?? ""} ${patient.docNumber}` : ""
          }${patient.minor ? " · menor de edad: firma su representante legal" : ""}`}
        />
      </div>
    </PageShell>
  )
}
