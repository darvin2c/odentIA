import { buttonVariants } from "@odentia/ui"
import { DetailDrawer } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { hcLabel, type PatientFull } from "../../lib/patients"
import { openBookingAnywhere } from "../agenda/schedule-host"

/** Lo que la lista ya sabe de la persona: no se vuelve a pedir. */
export interface QuickViewContext {
  patientId: string
  name: string
  /** Lo que aceptó y falta hacer, como lo dice la lista. */
  pending?: string | null
  /** Ese monto, ya escrito. */
  amount?: string | null
  planItemIds?: string[] | null
  serviceId?: string | null
}

/**
 * La persona sin salir de la lista (lienzo «Argos y citas sin cerrar»,
 * tablero 11): quién es, cómo llamarla y lo que aceptó, con «Agendar» al
 * lado. «Abrir ficha completa» es lo único que lleva a otra pantalla.
 */
export function PatientQuickView({ context, onClose }: { context: QuickViewContext; onClose: () => void }) {
  const canBook = usePermission("appointments.write")
  const patient = useQuery({
    queryKey: ["patient", context.patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${context.patientId}`),
  })
  const data = patient.data?.data.patient
  const phone = data?.phone ?? null
  const book = () => {
    onClose()
    openBookingAnywhere({
      patient: { id: context.patientId, name: context.name },
      lockedPatient: true,
      ...(context.planItemIds?.length ? { planItemIds: context.planItemIds } : {}),
      ...(context.serviceId ? { serviceId: context.serviceId } : {}),
    })
  }
  return (
    <DetailDrawer
      open
      title={context.name}
      description={data ? [hcLabel(data.patientNumber), phone].filter(Boolean).join(" · ") : undefined}
      isLoading={patient.isPending}
      onClose={onClose}
      actions={
        <>
          <Link
            to="/patients/$patientId"
            params={{ patientId: context.patientId }}
            className={buttonVariants({ variant: "ghost" })}
          >
            Abrir ficha completa
          </Link>
          {canBook ? (
            <button type="button" className={buttonVariants()} onClick={book}>
              Agendar
            </button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {phone ? (
          <a href={`tel:${phone.replace(/\s+/g, "")}`} className={buttonVariants({ variant: "secondary", size: "sm", className: "self-start" })}>
            Llamar
          </a>
        ) : null}
        {context.pending ? (
          <section aria-label="Aceptó y falta hacer" className="flex flex-col gap-1.5">
            <h3 className="text-sm font-bold">Aceptó y falta hacer</h3>
            <div className="flex items-baseline justify-between gap-3 rounded-xl border px-3 py-2.5 text-sm">
              <span className="min-w-0">{context.pending}</span>
              {context.amount ? <span className="shrink-0 font-semibold tabular-nums">{context.amount}</span> : null}
            </div>
          </section>
        ) : null}
      </div>
    </DetailDrawer>
  )
}
