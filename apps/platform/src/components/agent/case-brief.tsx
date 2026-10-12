import { Badge, Button } from "@odentia/ui"
import { DetailDrawer, DetailSection, LoadingState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { timeAgo } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
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
    asks: string | null
    pending: string | null
    notice: string | null
  } | null
  contactName: string | null
  channel: string | null
  said: string[]
  known: Array<{
    label: string | null
    text: string
    origin: "caso" | "persona" | "ficha"
    channel: string | null
    notedBy: "agente" | "equipo" | null
    at: string | null
  }>
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

/** De qué es el dato: el sistema lo sabe en los que salen de la ficha; en el resto se dice de dónde viene. */
function label(item: CaseBrief["known"][number]): string {
  if (item.label) return item.label
  return item.origin === "caso" ? "De esta conversación" : "De la persona"
}

/** De dónde sale cada dato: quien toma el caso decide cuánto fiarse sin volver a preguntar. */
function origin(item: CaseBrief["known"][number]): string {
  if (item.origin === "caso") return "Lo dijo hoy, en esta conversación"
  if (item.origin === "ficha") return "De su ficha"
  const day = item.at ? new Date(item.at).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "long" }) : null
  const when = day ? ` el ${day}` : ""
  if (item.notedBy === "equipo") return `Lo anotó tu equipo${when}`
  return `Lo recordaba de otra conversación${item.channel ? `, por ${channelLabel(item.channel)}` : ""}${when}`
}

function Messages({ said }: { said: string[] }) {
  if (said.length === 1) return <p className="text-sm">«{said[0]}»</p>
  return (
    <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
      {said.map((text, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: mensajes en el orden en que se escribieron; la lista no se reordena.
        <li key={`${index}-${text.slice(0, 24)}`}>{text}</li>
      ))}
    </ol>
  )
}

/**
 * Resumen del caso para quien lo toma: qué pide la persona, lo que ya se sabe,
 * lo que hizo el agente y lo que falta, sin releer todo el hilo ni volver a
 * preguntar. Se arma con lo que el sistema ya guarda; aquí no se edita nada.
 */
export function CaseBriefDrawer({
  conversationId,
  name,
  canClaim,
  inConversation = false,
  onClose,
  onClaimed,
}: {
  /** La conversación; null = cerrado. */
  conversationId: string | null
  name: string
  canClaim: boolean
  /** Se abrió desde la propia conversación: «Ver la conversación completa» solo cierra el resumen. */
  inConversation?: boolean
  onClose: () => void
  onClaimed?: () => void
}) {
  const queryClient = useQueryClient()
  const [showMessages, setShowMessages] = useState(false)
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
      void queryClient.invalidateQueries({ queryKey: ["agent-handoffs"] })
      onClaimed?.()
    },
  })

  if (conversationId === null) return null
  const brief = query.data?.data
  const claimError = mutationErrorMessage(claim.error)
  const handoff = brief?.handoff ?? null
  const told = handoff?.notice ?? brief?.lastAgentMessage?.text ?? null
  const arrived = handoff ? timeAgo(handoff.createdAt) : ""

  return (
    <DetailDrawer
      open
      title="Resumen del caso"
      size="lg"
      description={[brief?.contactName ?? name, brief?.channel ? channelLabel(brief.channel) : null, arrived || null].filter(Boolean).join(" · ")}
      headerContent={
        handoff ? (
          <div className="flex flex-wrap items-center gap-2">
            <HandoffUrgency priority={handoff.priority} />
            <Badge variant="secondary">{handoff.reason}</Badge>
            <span className="text-sm text-muted-foreground">
              {handoff.status === "abierta" ? "En cola por recoger" : "Con responsable asignado"}
            </span>
          </div>
        ) : undefined
      }
      onClose={onClose}
      isSubmitting={claim.isPending}
      actions={
        brief ? (
          <>
            {inConversation ? (
              <Button type="button" variant="outline" onClick={onClose}>
                Ver la conversación completa
              </Button>
            ) : (
              <Button variant="outline" nativeButton={false} render={<Link to="/inbox" search={{ conversation: conversationId }} />}>
                Ver la conversación completa
              </Button>
            )}
            {handoff?.status === "abierta" && canClaim ? (
              <SubmitButton pending={claim.isPending} onClick={() => claim.mutate(handoff.id)}>
                Tomar el caso
              </SubmitButton>
            ) : null}
          </>
        ) : undefined
      }
    >
      {query.isPending ? (
        <LoadingState message="Cargando el resumen…" />
      ) : query.isError || !brief ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          <DetailSection title="Qué pide">
            {brief.said.length === 0 && !handoff?.asks ? (
              <p className="text-sm text-muted-foreground">No hay mensajes recientes de esta persona.</p>
            ) : handoff?.asks ? (
              <>
                <p className="text-sm">{handoff.asks}</p>
                {brief.said.length > 0 ? (
                  <>
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto min-h-11 self-start p-0 sm:min-h-0"
                      aria-expanded={showMessages}
                      onClick={() => setShowMessages(!showMessages)}
                    >
                      {showMessages
                        ? "Ocultar sus mensajes"
                        : brief.said.length === 1
                          ? "Ver su mensaje"
                          : `Ver sus ${brief.said.length} mensajes`}
                    </Button>
                    {showMessages ? <Messages said={brief.said} /> : null}
                  </>
                ) : null}
              </>
            ) : (
              <Messages said={brief.said} />
            )}
          </DetailSection>

          <DetailSection title="Lo que ya se sabe">
            {brief.known.length === 0 ? (
              <p className="text-sm text-muted-foreground">Todavía no hay datos guardados de este caso ni de esta persona.</p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">No hace falta volver a preguntarlo. Cada dato dice de dónde sale.</p>
                <dl className="flex flex-col divide-y rounded-xl border bg-card text-sm">
                  {brief.known.map((item, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: datos de solo lectura; la lista se reemplaza entera al recargar.
                    <div key={`${item.origin}-${index}`} className="grid gap-1 p-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
                      <dt className="font-semibold text-muted-foreground">{label(item)}</dt>
                      <dd className="flex flex-col">
                        <span className="font-semibold">{item.text}</span>
                        <span className="text-muted-foreground">{origin(item)}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </DetailSection>

          <DetailSection title="Lo que ya hizo el agente">
            {told === null && brief.proposals.length === 0 ? (
              <p className="text-sm text-muted-foreground">El agente no respondió ni propuso nada en este caso.</p>
            ) : (
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
                {told ? (
                  <li>
                    Le dijo: <span className="whitespace-pre-wrap">«{told}»</span>
                  </li>
                ) : (
                  <li>No le envió ningún mensaje.</li>
                )}
                {brief.proposals.map((proposal, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: propuestas de solo lectura, en el orden que entrega el servidor.
                  <li key={`${proposal.at}-${index}`}>
                    <span className="font-semibold">{proposal.label}</span>: {proposal.summary}{" "}
                    <span className="text-muted-foreground">({PROPOSAL_STATUS[proposal.status] ?? proposal.status})</span>
                  </li>
                ))}
                {brief.proposals.length === 0 ? <li>No propuso ninguna cita ni otro cambio.</li> : null}
              </ul>
            )}
          </DetailSection>

          {handoff?.pending ? (
            <DetailSection title="Lo que falta">
              <p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm font-semibold">{handoff.pending}</p>
            </DetailSection>
          ) : null}

          {claimError ? (
            <p role="alert" className="text-sm text-destructive">
              {claimError}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Este resumen se arma solo con la memoria del caso, lo que se recuerda de la persona y su ficha. El agente usa el
            mismo antes de preguntar algo.
          </p>
        </div>
      )}
    </DetailDrawer>
  )
}
