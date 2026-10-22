import { diagnosisCodeLabel } from "@odentia/clinical"
import { Button } from "@odentia/ui"
import { LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { fetchOrderPrint, ORDER_KIND_TITLES } from "../../lib/clinical-forms"
import { formatDate } from "../../lib/clinical-journey"
import { ageFrom, hcLabel } from "../../lib/patients"
import { QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute("/_org/patients/$patientId/orders/$orderId/print")({
  component: OrderPrintPage,
})

/**
 * Hoja de la orden para imprimir y entregar en mano: establecimiento,
 * paciente, qué se pide y para quién, el diagnóstico que la motiva y quién la
 * pide, con su colegiatura. Una orden cancelada se muestra como tal.
 */
function OrderPrintPage() {
  const { orderId } = Route.useParams()
  const query = useQuery({
    queryKey: ["order-print", orderId],
    queryFn: () => fetchOrderPrint(orderId),
  })
  if (query.isPending)
    return (
      <PageShell>
        <LoadingState kind="indeterminate" message="Preparando la orden…" />
      </PageShell>
    )
  if (query.isError)
    return (
      <PageShell>
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      </PageShell>
    )
  const { order, patient, establishment, diagnosisDescription, requestedBy } = query.data.data
  const cancelled = order.status === "cancelado"
  const age = ageFrom(patient.birthDate)
  return (
    <PageShell className="flex flex-col gap-4">
      <style>{`@media print {
        body * { visibility: hidden; }
        .order-sheet, .order-sheet * { visibility: visible; }
        .order-sheet { position: absolute; inset: 0 auto auto 0; width: 100%; border: 0; box-shadow: none; }
      }`}</style>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-muted-foreground">
          {cancelled
            ? "Esta orden está cancelada: no debe usarse."
            : "Revisa la orden y usa «Imprimir»; firma y sello van en el papel."}
        </p>
        <Button type="button" disabled={cancelled} onClick={() => window.print()}>
          Imprimir
        </Button>
      </div>
      <article className="order-sheet mx-auto flex w-full max-w-[210mm] flex-col gap-5 rounded-lg border bg-white p-8 text-sm text-black">
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
            <p className="text-base font-semibold">{ORDER_KIND_TITLES[order.kind]}</p>
            <p>Pedida el {formatDate(order.createdAt)}</p>
            {cancelled ? <p className="font-semibold">CANCELADA</p> : null}
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
          {age ? (
            <p>
              <span className="font-medium">Edad:</span> {age} años
            </p>
          ) : null}
          <p className="sm:col-span-2">
            <span className="font-medium">Para:</span> {order.recipient}
          </p>
          {order.diagnosisCode ? (
            <p className="sm:col-span-2">
              <span className="font-medium">Diagnóstico:</span> {diagnosisCodeLabel(order.diagnosisSystem, order.diagnosisCode)}
              {diagnosisDescription ? ` · ${diagnosisDescription}` : ""}
            </p>
          ) : null}
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">{order.title}</h2>
          {order.detail ? <p className="whitespace-pre-wrap">{order.detail}</p> : null}
        </section>
        <footer className="mt-10 flex justify-end">
          <div className="w-64 border-t pt-2 text-center">
            <p className="font-medium">{requestedBy?.name ?? "—"}</p>
            {requestedBy?.title ? <p>{requestedBy.title}</p> : null}
            {requestedBy?.registration ? <p>{requestedBy.registration}</p> : null}
            <p className="text-xs">Firma y sello</p>
          </div>
        </footer>
      </article>
    </PageShell>
  )
}
