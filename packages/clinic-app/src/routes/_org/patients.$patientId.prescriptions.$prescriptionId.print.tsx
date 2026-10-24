import { diagnosisCodeLabel } from "@odentia/clinical"
import { Button } from "@odentia/ui"
import { LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { fetchPrescriptionPrint, formatDate } from "../../lib/clinical-journey"
import { ageFrom, hcLabel } from "../../lib/patients"
import { QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute(
  "/_org/patients/$patientId/prescriptions/$prescriptionId/print",
)({
  component: PrescriptionPrintPage,
})

/** Unidades en letras (hasta 9999) para la cantidad total, como exige la receta. */
function inWords(n: number): string {
  const units = ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"]
  const teens = [
    "diez",
    "once",
    "doce",
    "trece",
    "catorce",
    "quince",
    "dieciséis",
    "diecisiete",
    "dieciocho",
    "diecinueve",
  ]
  const tens = [
    "",
    "",
    "veinte",
    "treinta",
    "cuarenta",
    "cincuenta",
    "sesenta",
    "setenta",
    "ochenta",
    "noventa",
  ]
  const twenties = [
    "veinte",
    "veintiuno",
    "veintidós",
    "veintitrés",
    "veinticuatro",
    "veinticinco",
    "veintiséis",
    "veintisiete",
    "veintiocho",
    "veintinueve",
  ]
  const hundreds = [
    "",
    "ciento",
    "doscientos",
    "trescientos",
    "cuatrocientos",
    "quinientos",
    "seiscientos",
    "setecientos",
    "ochocientos",
    "novecientos",
  ]
  const below100 = (v: number): string => {
    if (v < 10) return units[v] ?? ""
    if (v < 20) return teens[v - 10] ?? ""
    if (v < 30) return twenties[v - 20] ?? ""
    const t = Math.floor(v / 10)
    const u = v % 10
    return u === 0 ? (tens[t] ?? "") : `${tens[t]} y ${units[u]}`
  }
  const below1000 = (v: number): string => {
    if (v === 100) return "cien"
    const h = Math.floor(v / 100)
    const rest = v % 100
    return [hundreds[h], rest > 0 || h === 0 ? below100(rest) : ""].filter(Boolean).join(" ")
  }
  if (n < 1000) return below1000(n)
  const th = Math.floor(n / 1000)
  const rest = n % 1000
  return [th === 1 ? "mil" : `${below1000(th)} mil`, rest > 0 ? below1000(rest) : ""]
    .filter(Boolean)
    .join(" ")
}

/**
 * Hoja de la receta para imprimir: establecimiento, paciente, medicamentos
 * por DCI con concentración, forma, vía, posología y cantidad en números y
 * letras, diagnóstico, vigencia y firma con colegiatura. Solo se imprime una
 * receta emitida; la anulada se muestra como tal.
 */
function PrescriptionPrintPage() {
  const { patientId, prescriptionId } = Route.useParams()
  const query = useQuery({
    queryKey: ["prescription-print", patientId, prescriptionId],
    queryFn: () => fetchPrescriptionPrint(patientId, prescriptionId),
  })
  if (query.isPending)
    return (
      <PageShell>
        <LoadingState kind="indeterminate" message="Preparando la receta…" />
      </PageShell>
    )
  if (query.isError)
    return (
      <PageShell>
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      </PageShell>
    )
  const { prescription, patient, establishment, diagnosisDescription } = query.data.data
  const cancelled = prescription.status !== "emitida"
  const age = ageFrom(patient.birthDate)
  return (
    <PageShell className="flex flex-col gap-4">
      <style>{`@media print {
        body * { visibility: hidden; }
        .rx-sheet, .rx-sheet * { visibility: visible; }
        .rx-sheet { position: absolute; inset: 0 auto auto 0; width: 100%; border: 0; box-shadow: none; }
      }`}</style>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-muted-foreground">
          {cancelled
            ? "Esta receta está anulada: no debe dispensarse."
            : "Revisa la receta y usa «Imprimir»; firma y sello van en el papel."}
        </p>
        <Button type="button" disabled={cancelled} onClick={() => window.print()}>
          Imprimir
        </Button>
      </div>
      <article className="rx-sheet mx-auto flex w-full max-w-[210mm] flex-col gap-5 rounded-lg border bg-white p-8 text-sm text-black">
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
            <p className="text-base font-semibold">Receta N.º {prescription.prescriptionNumber}</p>
            <p>Emitida el {formatDate(prescription.issuedAt)}</p>
            {prescription.validUntil ? (
              <p>Válida hasta el {formatDate(prescription.validUntil)}</p>
            ) : null}
            {cancelled ? <p className="font-semibold">ANULADA</p> : null}
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
          {prescription.patientWeightKg ? (
            <p>
              <span className="font-medium">Peso:</span> {Number(prescription.patientWeightKg)} kg
            </p>
          ) : null}
          {prescription.diagnosisCode ? (
            <p className="sm:col-span-2">
              <span className="font-medium">Diagnóstico:</span>{" "}
              {diagnosisCodeLabel(prescription.diagnosisSystem, prescription.diagnosisCode)}
              {diagnosisDescription ? ` · ${diagnosisDescription}` : ""}
            </p>
          ) : null}
        </section>
        <section className="flex flex-col gap-3">
          <h2 className="font-semibold">Rp/</h2>
          <ol className="flex flex-col gap-3 pl-5">
            {(prescription.items ?? []).map((item) => (
              <li key={item.id} className="list-decimal">
                <p className="font-medium">
                  {item.genericName ?? item.medicationName}
                  {item.strength ? ` ${item.strength}` : ""}
                  {item.dosageForm ? ` · ${item.dosageForm}` : ""}
                  {item.brandName ? ` (${item.brandName})` : ""}
                </p>
                {item.quantity ? (
                  <p>
                    Cantidad: {item.quantity} ({inWords(item.quantity)})
                  </p>
                ) : null}
                <p>
                  {item.dose} vía {item.route}, {item.frequency}, durante {item.duration}.
                  {item.instructions ? ` ${item.instructions}` : ""}
                </p>
              </li>
            ))}
          </ol>
          {prescription.notes ? <p>{prescription.notes}</p> : null}
        </section>
        <footer className="mt-10 flex justify-end">
          <div className="w-64 border-t pt-2 text-center">
            <p className="font-medium">{prescription.prescriberName ?? "—"}</p>
            {prescription.prescriberTitle ? <p>{prescription.prescriberTitle}</p> : null}
            {prescription.prescriberRegistration ? (
              <p>{prescription.prescriberRegistration}</p>
            ) : null}
            <p className="text-xs">Firma y sello</p>
          </div>
        </footer>
      </article>
    </PageShell>
  )
}
