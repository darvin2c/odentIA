/**
 * Un ticket abierto al lado de la lista, tal como se imprime: el mismo
 * `TicketView` de la cuenta, con Imprimir, Enviar al paciente, Devolver y
 * Anular. Se abre por su identificador (`?ticket=`), así lo abren Cobros, la
 * Caja y el buscador rápido sin saber de quién es. Desde Cobros, «Anterior» y
 * «Siguiente» recorren los tickets de la lista a la vista.
 */
import { Button } from "@odentia/ui"
import { DetailDrawer, ErrorState } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { TicketView, ticketDisplayNumber } from "./ticket-view"
import { financeErrorMessage } from "../../lib/finance"
import { financeKeys } from "../../lib/finance-cash"
import { fetchTicketById } from "../../lib/finance-collect"

export function TicketPanel({
  ticketId,
  locale,
  timeZone,
  ticketFooter,
  siblings,
  onOpen,
  onClose,
  onChanged,
}: {
  ticketId: string | null
  locale: string
  timeZone: string
  ticketFooter: string | null
  /** Los tickets de la lista, en su orden: sin ella no hay «Anterior / Siguiente». */
  siblings?: string[]
  onOpen: (ticketId: string) => void
  onClose: () => void
  onChanged: () => void
}) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: financeKeys.ticket(ticketId ?? ""),
    queryFn: () => fetchTicketById(ticketId ?? ""),
    enabled: ticketId !== null,
  })
  const body = ticketId !== null ? (query.data?.data ?? null) : null
  const row = body?.ticket ?? null
  const at = ticketId && siblings ? siblings.indexOf(ticketId) : -1
  const previous = at > 0 ? siblings?.[at - 1] : undefined
  const next = at >= 0 && siblings && at < siblings.length - 1 ? siblings[at + 1] : undefined

  return (
    <DetailDrawer
      open={ticketId !== null}
      onClose={onClose}
      title={row ? `Ticket ${ticketDisplayNumber(row.ticketNumber)}` : "Ticket"}
      isLoading={ticketId !== null && query.isPending}
      showClose
      headerContent={
        at >= 0 && siblings && siblings.length > 1 ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!previous}
              onClick={() => previous && onOpen(previous)}
            >
              <ChevronLeft aria-hidden />
              Anterior
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!next}
              onClick={() => next && onOpen(next)}
            >
              Siguiente
              <ChevronRight aria-hidden />
            </Button>
            <span className="text-sm text-muted-foreground">
              {at + 1} de {siblings.length} a la vista
            </span>
          </div>
        ) : undefined
      }
    >
      {query.isError ? (
        <ErrorState
          title="No se pudo abrir el ticket"
          message={financeErrorMessage(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : row && body ? (
        <TicketView
          key={row.id}
          ticket={row}
          remainingCents={row.snapshot?.remainingCents ?? 0}
          closedAfter={body.closedAfter ?? false}
          patientName={row.snapshot.patient.displayName}
          branchName={row.snapshot.branch.name}
          locale={locale}
          timeZone={timeZone}
          ticketFooter={ticketFooter}
          mode="review"
          onDone={onClose}
          onChanged={() => {
            onChanged()
            void query.refetch()
            void queryClient.invalidateQueries({ queryKey: ["patient-account3", body.patientId] })
          }}
        />
      ) : null}
    </DetailDrawer>
  )
}
