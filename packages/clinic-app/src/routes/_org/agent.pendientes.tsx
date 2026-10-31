import { Button } from "@odentia/ui"
import { EmptyState, PageHeader, PageShell, SubmitButton, SkeletonRegion } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useState } from "react"
import { AgentTabs } from "../../components/agent-tabs"
import { AWAITING_ANSWER_KEY, type AwaitingAnswerList } from "../../lib/agent"
import { ApiError, apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { timeAgo, useCan, usePermission } from "../../lib/crm"
import { canConfirmByPhone } from "../../lib/screen-rules"
import { useOrgEvents } from "../../lib/org-events"
import { useReceptionName } from "../../lib/agent-names"
import { AwaitingAnswerPageSkeleton, AwaitingAnswerSkeleton } from "../../components/skeletons/agent"

/**
 * Agente › «Esperan su sí» (decisión 21, tablero 2c): solo las citas que el
 * agente propuso y esperan la respuesta de la persona. Para saber, no para
 * hacer: los casos del agente están en «Te espera» y en el panel lateral, y lo
 * ya hecho se ve en la conversación y en la cita. Si la persona confirma por
 * teléfono, recepción lo anota con un clic y la cita se reserva con la misma
 * regla que la del agente.
 */
export const Route = createFileRoute("/_org/agent/pendientes")({
  pendingComponent: AwaitingAnswerPageSkeleton,
  component: AwaitingAnswerPage,
})

const EVENTS = ["agent.proposal.created", "agent.proposal.decided", "agent.proposal.executed", "appointment.updated", "conversation.updated"]

function AwaitingAnswerPage() {
  const queryClient = useQueryClient()
  // Los mismos roles que antes veían Pendientes: quien supervisa o decide por el agente.
  const canSupervise = usePermission("agent.read")
  const canDecide = usePermission("agent.decide")
  const canRead = canSupervise || canDecide
  const canConfirm = canConfirmByPhone(useCan())
  const receptionName = useReceptionName()
  /** Lo que pasó con la última «Confirmó por teléfono», dicho junto a su fila. */
  const [outcome, setOutcome] = useState<{ id: string; text: string; ok: boolean } | null>(null)
  const query = useQuery({
    queryKey: AWAITING_ANSWER_KEY,
    queryFn: () => apiFetch<{ data: AwaitingAnswerList }>("/api/agent/awaiting"),
    enabled: canRead,
  })
  const refresh = () => {
    for (const key of [AWAITING_ANSWER_KEY[0], "agent-panel", "agent-panel-proposals", "agent-proposals", "conversations", "conversation", "agenda-availability"]) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  }
  useOrgEvents(EVENTS, refresh)
  const confirm = useMutation({
    retry: false,
    mutationFn: (id: string) => apiFetch<{ data: { status: string } }>(`/api/agent/proposals/${id}/phone-confirm`, { method: "POST" }),
    onSuccess: (response, id) => {
      const done = response.data.status === "ejecutada"
      setOutcome({ id, ok: done, text: done ? "Listo: quedó anotado y la cita está en la Agenda." : "No se pudo hacer: revísalo en la conversación." })
      refresh()
    },
    onError: (error, id) => {
      setOutcome({ id, ok: false, text: (error instanceof ApiError ? error.shape.message : null) ?? "No pudimos anotarlo. Inténtalo otra vez." })
      refresh()
    },
  })
  const data = query.data?.data

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader title="Agente" subtitle={`Las citas que ${receptionName} propuso y esperan la respuesta de la persona.`} />
      <AgentTabs />
      {!canRead ? (
        <EmptyState title="Sin acceso" description="No tienes acceso a las citas que esperan respuesta. Pídelo a quien administra la clínica." />
      ) : (
        <section aria-labelledby="esperan-su-si" className="elevated flex flex-col gap-3 rounded-xl border bg-card p-4 sm:p-6">
          <div>
            <h2 id="esperan-su-si" className="font-heading text-base font-semibold">
              Esperan su sí
            </h2>
            <p className="text-sm text-muted-foreground">
              Para saber, no para hacer. Si la persona confirma por teléfono, anótalo aquí. Lo ya hecho se ve en la conversación y en la cita.
            </p>
          </div>
          {query.isPending ? (
            <SkeletonRegion message="Cargando…">
              <AwaitingAnswerSkeleton />
            </SkeletonRegion>
          ) : query.isError || !data ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
              <p>No pudimos cargar las citas que esperan respuesta.</p>
              <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => void query.refetch()}>
                Volver a intentar
              </Button>
            </div>
          ) : data.items.length === 0 ? (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
              Ninguna cita espera respuesta. Cuando {receptionName} le proponga una a alguien, la ves aquí.
            </p>
          ) : (
            <>
              <ul className="flex flex-col divide-y rounded-xl border">
                {data.items.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                    <div className="min-w-0 flex-1 basis-64">
                      <p className="font-semibold">
                        {item.contactName ?? "Persona sin nombre"}
                        {item.channel ? <span className="font-normal text-muted-foreground"> · {channelLabel(item.channel)}</span> : null}
                      </p>
                      <p className="text-sm">
                        {item.text} <span className="text-muted-foreground">· {timeAgo(item.createdAt)}</span>
                      </p>
                      {item.taken ? (
                        <p className="text-sm font-semibold text-warning">
                          {item.action === "reservar_cita" ? "Ese horario se ocupó" : "La cita cambió desde que se propuso"}
                        </p>
                      ) : null}
                      {outcome?.id === item.id ? (
                        <p role={outcome.ok ? "status" : "alert"} className={outcome.ok ? "text-sm" : "text-sm text-destructive"}>
                          {outcome.text}
                          {!outcome.ok && item.action === "reservar_cita" ? (
                            <>
                              {" "}
                              <Link to="/agenda" search={{}} className="font-semibold text-primary underline-offset-4 hover:underline">
                                Ir a la Agenda
                              </Link>
                            </>
                          ) : null}
                        </p>
                      ) : null}
                    </div>
                    {/* En teléfono, los botones a lo ancho. */}
                    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                      <Link
                        to="/inbox"
                        search={{ conversation: item.conversationId }}
                        className="inline-flex min-h-11 flex-1 items-center justify-center rounded-md border px-3 text-sm font-semibold hover:bg-accent/60 sm:min-h-8 sm:flex-none"
                      >
                        Ver conversación
                      </Link>
                      {canConfirm && !item.taken ? (
                        <SubmitButton
                          size="sm"
                          className="min-h-11 flex-1 sm:min-h-8 sm:flex-none"
                          pending={confirm.isPending && confirm.variables === item.id}
                          disabled={confirm.isPending}
                          onClick={() => {
                            setOutcome(null)
                            confirm.mutate(item.id)
                          }}
                        >
                          Confirmó por teléfono
                        </SubmitButton>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
              {data.total > data.items.length ? (
                <p className="text-sm text-muted-foreground">
                  Se muestran las {data.items.length} que más llevan esperando, de {data.total}.
                </p>
              ) : null}
            </>
          )}
        </section>
      )}
    </PageShell>
  )
}
