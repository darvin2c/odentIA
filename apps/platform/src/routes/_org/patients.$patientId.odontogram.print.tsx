import { FDI_ADULT_ROWS, FDI_CHILD_ROWS, surfaceLabel, toothNameOf } from "@odentia/clinical"
import { Button } from "@odentia/ui"
import { LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { findingWords } from "../../components/odontogram-notation"
import { formatDate } from "../../lib/clinical-journey"
import { fetchOdontogramPrint } from "../../lib/odontogram"
import { hcLabel, type OdontogramEntry } from "../../lib/patients"
import { QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute("/_org/patients/$patientId/odontogram/print")({
  component: OdontogramPrintPage,
})

/** Las cuatro filas de la numeración FDI, como se leen de frente a la persona. */
const ROWS: Array<{ caption: string; teeth: readonly number[] }> = [
  { caption: "Permanentes superiores", teeth: FDI_ADULT_ROWS[0] ?? [] },
  { caption: "Temporales superiores", teeth: FDI_CHILD_ROWS[0] ?? [] },
  { caption: "Temporales inferiores", teeth: FDI_CHILD_ROWS[1] ?? [] },
  { caption: "Permanentes inferiores", teeth: FDI_ADULT_ROWS[1] ?? [] },
]

/** Orden de las piezas en la lista: el de las filas FDI. */
const ORDER = new Map(ROWS.flatMap((row) => row.teeth).map((tooth, index) => [tooth, index]))

/**
 * Hoja neutra del odontograma (núcleo internacional, ADR 0036): sin norma de
 * ningún país, con la numeración internacional (FDI) y los hallazgos vigentes
 * por pieza. Es lo que se imprime donde el odontograma no se firma.
 */
function OdontogramPrintPage() {
  const { patientId } = Route.useParams()
  const query = useQuery({
    queryKey: ["odontogram-print", patientId, "hoy"],
    queryFn: () => fetchOdontogramPrint(patientId),
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
  const { entries, patient, establishment, printedAt } = query.data.data
  const byTooth = new Map<number, OdontogramEntry[]>()
  for (const entry of entries) {
    for (const tooth of entry.details?.relatedTeeth?.length ? entry.details.relatedTeeth : [entry.toothNumber]) {
      byTooth.set(tooth, [...(byTooth.get(tooth) ?? []), entry])
    }
  }
  const teeth = [...byTooth.keys()].sort((a, b) => (ORDER.get(a) ?? 99) - (ORDER.get(b) ?? 99))
  return (
    <PageShell className="flex flex-col gap-4">
      <style>{`@page { size: A4; margin: 12mm }
      @media print {
        body * { visibility: hidden; }
        .odontogram-sheet, .odontogram-sheet * { visibility: visible; }
        .odontogram-sheet { position: absolute; inset: 0 auto auto 0; width: 100%; border: 0; box-shadow: none; }
      }`}</style>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-muted-foreground">
          Hoja con la numeración internacional (FDI) y los hallazgos de hoy por pieza.
        </p>
        <Button type="button" onClick={() => window.print()}>
          Imprimir
        </Button>
      </div>
      <article className="odontogram-sheet mx-auto flex w-full max-w-[210mm] flex-col gap-5 rounded-lg border bg-white p-8 text-sm text-black">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
          <div>
            <p className="text-base font-semibold">
              {establishment?.tradeName || establishment?.legalName || "Establecimiento"}
            </p>
            {establishment?.address ? <p>{establishment.address}</p> : null}
          </div>
          <div className="text-right">
            <p className="text-base font-semibold">Odontograma</p>
            <p>{formatDate(printedAt)}</p>
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
              <span className="font-medium">{patient.docType ?? "Documento"}:</span> {patient.docNumber}
            </p>
          ) : null}
        </section>
        <section aria-label="Numeración FDI" className="flex flex-col gap-2">
          {ROWS.map((row) => (
            <div key={row.caption} className="flex flex-col items-center gap-1">
              <span className="sr-only">{row.caption}</span>
              <div className="flex flex-wrap justify-center gap-1">
                {row.teeth.map((tooth) => (
                  <span
                    key={tooth}
                    className={`flex h-8 w-8 items-center justify-center rounded border text-xs tabular-nums ${
                      byTooth.has(tooth) ? "border-black font-bold" : "border-gray-300 text-gray-500"
                    }`}
                  >
                    {tooth}
                  </span>
                ))}
              </div>
            </div>
          ))}
          <p className="text-center text-xs text-gray-600">En negrita, las piezas con hallazgos.</p>
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">Hallazgos por pieza</h2>
          {teeth.length === 0 ? (
            <p>Sin hallazgos registrados.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {teeth.map((tooth) => (
                <li key={tooth} className="flex flex-col gap-0.5 py-2">
                  <span className="font-medium">
                    Pieza {tooth} · {toothNameOf(tooth)}
                  </span>
                  {(byTooth.get(tooth) ?? []).map((entry) => (
                    <span key={entry.id}>
                      {findingWords(null, entry)}
                      {entry.surface ? ` · cara ${surfaceLabel(entry.surface).toLowerCase()}` : ""}
                      {entry.diagnosisCode ? ` · CIE-10 ${entry.diagnosisCode}` : ""}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </section>
      </article>
    </PageShell>
  )
}
