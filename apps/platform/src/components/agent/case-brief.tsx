import { DetailDrawer, DetailSection, LoadingState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { mutationErrorMessage, QueryErrorState } from "../../lib/query-error"
import { HandoffUrgency } from "./handoff-badges"

interface CaseBrief {
  conversationId: string
  contactId: string
  handoff: {
    id: string
    reason: string
    summary: string
    priority: string
    status: "abierta" | "tomada" | "resuelta"
    dueAt: string | null
    createdAt: string
  } | null
  said: string[]
  known: Array<{ text: string; origin: "caso" | "persona" | "ficha"; channel: string | null; notedBy: "agente" | "equipo" | null; at: string | null }>
  proposals: Array<{ label: string; summary: string; status: string; at: string }>
  lastAgentMessage: { text: string; at: string } | null
}

const PROPOSAL_STATUS: Record<string, string> = {
  propuesta: "pendiente",
  aprobada: "aprobada",
  ejecutada: "hecha",
  rechazada: "rechazada",
  expirada: "venció",
  fallida: "no se pudo",
}

/** De dónde sale cada dato: quien toma el caso decide cuánto fiarse sin volver a preguntar. */
function origin(item: CaseBrief["known"][number]): string {
  if (item.origin === "caso") return "Lo dijo en esta conversación"
  if (item.origin === "ficha") return "De su ficha"
  const day = item.at ? new Date(item.at).toLocaleDateString("es-PE", { day: "numeric", month: "long" }) : null
  const when = day ? ` el ${day}` : ""
  if (item.notedBy === "equipo") return `Lo anotó tu equipo${when}`
  return `Lo dijo${item.channel ? ` por ${channelLabel(item.channel)}` : ""}${when}`
}

/**
 * Resumen del caso para quien lo toma: lo que la persona escribió, lo que ya
 * se sabe y lo que hizo el agente, sin releer todo el hilo ni volver a
 * preguntar. Se arma con lo que el sistema ya guarda; aquí no se edita nada.
 */
export function CaseBriefDrawer({
  conversationId,
  name,
  canClaim,
  onClose,
  onClaimed,
}: {
  /** La conversación; null = cerrado. */
  conversationId: string | null
  name: string
  canClaim: boolean
  onClose: () => void
  onClaimed?: () => void
}) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["agent-case-brief", conversationId],
    queryFn: () => apiFetch<{ data: CaseBrief }>(`/api/agent/case/brief?conversationId=${conversationId}`),
    enabled: conversationId !== null,
    retry: false,
  })
  const claim = useMutation({
    retry: false,
    mutationFn: (id: string) => apiFetch(`/api/agent/handoffs/${id}/claim`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-case-brief", conversationId] })
      onClaimed?.()
    },
  })

  if (conversationId === null) return null
  const brief = query.data?.data
  const claimError = mutationErrorMessage(claim.error)

  return (
    <DetailDrawer open title="Resumen del caso" description={`${name} · lo que ya se sabe, sin volver a preguntar`} onClose={onClose} isSubmitting={claim.isPending}>
      {query.isPending ? (
        <LoadingState message="Cargando el resumen…" />
      ) : query.isError || !brief ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          {brief.handoff ? (
            <div className="flex flex-col gap-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <HandoffUrgency priority={brief.handoff.priority} />
                <span className="font-semibold">{brief.handoff.reason}</span>
              </div>
              <p className="text-muted-foreground">
                {brief.handoff.status === "abierta" ? "En cola por recoger" : "Con responsable asignado"}
                {brief.handoff.dueAt ? ` · vence ${new Date(brief.handoff.dueAt).toLocaleString("es-PE")}` : ""}
              </p>
            </div>
          ) : null}

          <DetailSection title="Lo que escribió">
            {brief.said.length === 0 ? (
              <p className="text-sm text-muted-foreground">No hay mensajes recientes de esta persona.</p>
            ) : brief.said.length === 1 ? (
              <p className="text-sm">«{brief.said[0]}»</p>
            ) : (
              <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
                {brief.said.map((text, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: mensajes en el orden en que se escribieron; la lista no se reordena.
                  <li key={`${index}-${text.slice(0, 24)}`}>{text}</li>
                ))}
              </ol>
            )}
          </DetailSection>

          <DetailSection title="Lo que ya se sabe">
            {brief.known.length === 0 ? (
              <p className="text-sm text-muted-foreground">Todavía no hay datos guardados de este caso ni de esta persona.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {brief.known.map((item, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: datos de solo lectura; la lista se reemplaza entera al recargar.
                  <li key={`${item.origin}-${index}`} className="flex flex-col rounded-xl border bg-card p-3 text-sm">
                    <span className="font-semibold">{item.text}</span>
                    <span className="text-muted-foreground">{origin(item)}</span>
                  </li>
                ))}
              </ul>
            )}
          </DetailSection>

          <DetailSection title="Lo que hizo el agente">
            {brief.lastAgentMessage === null && brief.proposals.length === 0 ? (
              <p className="text-sm text-muted-foreground">El agente no respondió ni propuso nada en este caso.</p>
            ) : (
              <div className="flex flex-col gap-3 text-sm">
                {brief.lastAgentMessage ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Lo último que le dijo</span>
                    <p className="whitespace-pre-wrap rounded-xl border border-agent-border bg-agent-soft p-3">{brief.lastAgentMessage.text}</p>
                  </div>
                ) : null}
                {brief.proposals.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {brief.proposals.map((proposal, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: propuestas de solo lectura, en el orden que entrega el servidor.
                      <li key={`${proposal.at}-${index}`}>
                        <span className="font-semibold">{proposal.label}</span>: {proposal.summary}{" "}
                        <span className="text-muted-foreground">({PROPOSAL_STATUS[proposal.status] ?? proposal.status})</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </DetailSection>

          {brief.handoff?.status === "abierta" && canClaim ? (
            <div className="flex flex-col gap-2">
              <SubmitButton pending={claim.isPending} onClick={() => brief.handoff && claim.mutate(brief.handoff.id)}>
                Tomar el caso
              </SubmitButton>
              {claimError ? (
                <p role="alert" className="text-sm text-destructive">
                  {claimError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </DetailDrawer>
  )
}
