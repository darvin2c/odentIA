import { Badge, Button } from "@odentia/ui"
import { SkeletonRegion } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { type OpportunityListItem, timeAgo, usePermission } from "../../lib/crm"
import { conversationStatusLabel } from "../../lib/glossary"
import { speaksForWords } from "../../lib/patient-overview"
import type { PersonConversation, PersonPage } from "../../lib/people"
import { QueryErrorState } from "../../lib/query-error"
import { OpportunityDrawer } from "../crm/opportunity-drawer"
import { SummaryCard } from "../patient/resumen-tab"
import { PersonLink } from "../person-link"
import { ConversationRowsSkeleton, OpportunityRowsSkeleton } from "../skeletons/person-sections"
import { useOpenRecordPanel } from "./record-panel"

/** Sus conversaciones: las lista el Resumen, con «Abrir» en cada una. */
export function usePersonConversations(personId: string) {
  const canRead = usePermission("conversations.read")
  return useQuery({
    queryKey: ["person-conversations", personId],
    queryFn: () =>
      apiFetch<{ data: PersonConversation[] }>(`/api/people/${personId}/conversations`),
    enabled: canRead,
    retry: false,
  })
}

/**
 * Sus conversaciones (quien lee la Bandeja) y sus oportunidades (quien lleva el
 * CRM), en el Resumen: antes era una pestaña aparte (QA de la ficha del 8 nov).
 * Solo las suyas: si otra persona habla por ella, se enlaza su conversación, no
 * se copia aquí. «Escribirle» está en la cabecera; las oportunidades cerradas
 * se abren a pedido.
 */
export function PersonConversations({ person }: { person: PersonPage }) {
  const canChats = usePermission("conversations.read")
  const openPanel = useOpenRecordPanel()
  const receptionName = useReceptionName()
  const canCrm = usePermission("crm.read")
  const canCrmWrite = usePermission("crm.write")
  const queryClient = useQueryClient()
  const [newOpportunity, setNewOpportunity] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  // La oportunidad se abre en su cajón, sin ir al embudo.
  const [viewingOpportunity, setViewingOpportunity] = useState<string | null>(null)
  const conversations = usePersonConversations(person.id)
  const opportunities = useQuery({
    queryKey: ["person-opportunities", person.id, "all"],
    queryFn: () =>
      apiFetch<{ data: OpportunityListItem[] }>(
        `/api/opportunities?contactId=${person.id}&limit=30`,
      ),
    enabled: canCrm,
    retry: false,
  })
  if (!canChats && !canCrm) return null
  const list = conversations.data?.data ?? []
  // Las conversaciones de quien habla por ella (no de quien solo es su contacto de emergencia).
  const spokenWithConversation = person.spokenForBy.filter((other) => other.conversationId && !other.emergencyOnly)
  const allOpportunities = opportunities.data?.data ?? []
  const openOnes = allOpportunities.filter((row) => row.status === "open")
  const closedOnes = allOpportunities.filter((row) => row.status !== "open")
  const shownOpportunities = showClosed ? allOpportunities : openOnes

  return (
    <SummaryCard
      title={canChats && canCrm ? "Conversaciones y oportunidades" : canChats ? "Conversaciones" : "Oportunidades"}
      action={
        canCrm && canCrmWrite && !person.archived ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setNewOpportunity(true)}>
            Nueva oportunidad
          </Button>
        ) : undefined
      }
    >
      {canChats ? (
        conversations.isPending ? (
          <SkeletonRegion message="Cargando conversaciones…">
            <ConversationRowsSkeleton />
          </SkeletonRegion>
        ) : conversations.isError ? (
          <QueryErrorState error={conversations.error} onRetry={() => void conversations.refetch()} />
        ) : (
          <div className="flex min-w-0 flex-col gap-1">
            {list.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {spokenWithConversation.length > 0
                  ? "No ha escrito por su cuenta: habla por ella quien sale abajo."
                  : "Todavía no ha escrito."}
              </p>
            ) : (
              <ul className="flex flex-col divide-y">
                {list.map((conversation) => (
                  <li key={conversation.id} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0">
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium">
                        {channelLabel(conversation.channel)}
                        {conversation.connectionName ? ` · ${conversation.connectionName}` : ""}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {conversationStatusLabel(conversation.status, conversation.closure, receptionName)}
                        {conversation.lastMessageAt ? ` · ${timeAgo(conversation.lastMessageAt)}` : ""}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => openPanel?.({ conversationId: conversation.id, name: person.displayName })}
                    >
                      Abrir
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {spokenWithConversation.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm">
                {spokenWithConversation.map((other) => (
                  <li key={other.personId}>
                    {speaksForWords(person.sex)}{" "}
                    <PersonLink contactId={other.personId} isPatient={other.isPatient} inText>
                      {other.displayName}
                    </PersonLink>
                    {" · "}
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0"
                      onClick={() => {
                        if (other.conversationId) openPanel?.({ conversationId: other.conversationId, name: other.displayName })
                      }}
                    >
                      Abrir su conversación
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )
      ) : null}

      {canCrm ? (
        <div className={canChats ? "flex min-w-0 flex-col gap-1 border-t pt-3" : "flex min-w-0 flex-col gap-1"}>
          {canChats ? <h3 className="text-sm font-medium text-muted-foreground">Oportunidades</h3> : null}
          {opportunities.isPending ? (
            <SkeletonRegion message="Cargando oportunidades…">
              <OpportunityRowsSkeleton />
            </SkeletonRegion>
          ) : opportunities.isError ? (
            <QueryErrorState error={opportunities.error} onRetry={() => void opportunities.refetch()} />
          ) : allOpportunities.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Ninguna. Nacen cuando pide algo concreto: un precio, un tratamiento o una evaluación.
            </p>
          ) : (
            <>
              {openOnes.length === 0 && !showClosed ? (
                <p className="text-sm text-muted-foreground">Ninguna abierta.</p>
              ) : (
                <ul className="flex flex-col divide-y">
                  {shownOpportunities.map((row) => (
                    <li key={row.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                      <Button
                        type="button"
                        variant="link"
                        // Un título largo baja de línea: no se sale de la tarjeta.
                        className="h-auto whitespace-normal p-0 text-left font-medium"
                        onClick={() => setViewingOpportunity(row.id)}
                      >
                        {row.title}
                      </Button>
                      <Badge variant="secondary">{row.stageName}</Badge>
                      {row.status !== "open" ? (
                        <Badge variant={row.status === "won" ? "default" : "outline"}>
                          {row.status === "won" ? "Ganada" : "Perdida"}
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {closedOnes.length > 0 ? (
                <Button
                  type="button"
                  variant="link"
                  className="h-auto self-start p-0"
                  aria-expanded={showClosed}
                  onClick={() => setShowClosed((value) => !value)}
                >
                  {showClosed
                    ? "Ocultar las cerradas"
                    : closedOnes.length === 1
                      ? "Ver la cerrada"
                      : `Ver las ${closedOnes.length} cerradas`}
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {viewingOpportunity ? (
        <OpportunityDrawer
          open
          opportunityId={viewingOpportunity}
          contactId={person.id}
          onClose={() => setViewingOpportunity(null)}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: ["person-opportunities", person.id] })}
        />
      ) : null}
      <OpportunityDrawer
        open={newOpportunity}
        contactId={person.id}
        onClose={() => setNewOpportunity(false)}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ["person-opportunities", person.id] })
        }}
      />
    </SummaryCard>
  )
}
