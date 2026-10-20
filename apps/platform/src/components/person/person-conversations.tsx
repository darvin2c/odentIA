import { Badge, Button, buttonVariants } from "@odentia/ui"
import { EmptyState, LoadingState } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { MessageCircle } from "lucide-react"
import { useState } from "react"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { type OpportunityListItem, timeAgo, usePermission } from "../../lib/crm"
import { conversationStatusLabel } from "../../lib/glossary"
import type { PersonPage } from "../../lib/people"
import { QueryErrorState } from "../../lib/query-error"
import { OpportunityDrawer } from "../crm/opportunity-drawer"
import { SummaryCard } from "../patient/resumen-tab"
import { PersonLink } from "../person-link"
import { WriteToPersonDialog } from "../write-to-person"
import { usePersonConversations } from "./person-summary"

/**
 * Pestaña Conversaciones: las conversaciones de la persona (quien lee la
 * Bandeja) y sus oportunidades (quien lleva el CRM). Solo las suyas: si otra
 * persona habla por ella, se enlaza su conversación, no se copia aquí.
 */
export function PersonConversations({ person }: { person: PersonPage }) {
  const canChats = usePermission("conversations.read")
  const canWrite = usePermission("conversations.write")
  const receptionName = useReceptionName()
  const canCrm = usePermission("crm.read")
  const canCrmWrite = usePermission("crm.write")
  const queryClient = useQueryClient()
  const [writing, setWriting] = useState(false)
  const [newOpportunity, setNewOpportunity] = useState(false)
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
  const list = conversations.data?.data ?? []
  const spokenWithConversation = person.spokenForBy.filter((other) => other.conversationId)

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {canChats ? (
        <SummaryCard
          title="Conversaciones"
          action={
            canWrite && !person.archived ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setWriting(true)}>
                <MessageCircle aria-hidden className="size-4" />
                Escribirle
              </Button>
            ) : undefined
          }
        >
          {conversations.isPending ? (
            <LoadingState message="Cargando conversaciones…" />
          ) : conversations.isError ? (
            <QueryErrorState
              error={conversations.error}
              onRetry={() => void conversations.refetch()}
            />
          ) : list.length === 0 ? (
            <EmptyState
              title="Todavía no ha escrito"
              description={
                spokenWithConversation.length > 0
                  ? "Quien habla por ella tiene su propia conversación: se abre desde su enlace de abajo."
                  : "Cuando escriba, o le escriba el equipo, su conversación aparece aquí."
              }
              actionLabel={canWrite && !person.archived ? "Escribirle" : undefined}
              onAction={canWrite && !person.archived ? () => setWriting(true) : undefined}
            />
          ) : (
            <ul className="flex flex-col divide-y">
              {list.map((conversation) => (
                <li
                  key={conversation.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">
                      {channelLabel(conversation.channel)}
                      {conversation.connectionName ? ` · ${conversation.connectionName}` : ""}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {conversationStatusLabel(conversation.status, conversation.closure, receptionName)}
                      {conversation.lastMessageAt
                        ? ` · ${timeAgo(conversation.lastMessageAt)}`
                        : ""}
                    </span>
                  </span>
                  <Link
                    to="/inbox"
                    search={{ conversation: conversation.id }}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    Abrir
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {spokenWithConversation.length > 0 ? (
            <ul className="flex flex-col gap-1 border-t pt-3 text-sm">
              {spokenWithConversation.map((other) => (
                <li key={other.personId}>
                  Habla por ella{" "}
                  <PersonLink contactId={other.personId} isPatient={other.isPatient}>
                    {other.displayName}
                  </PersonLink>
                  {" · "}
                  <Link
                    to="/inbox"
                    search={{ conversation: other.conversationId ?? undefined }}
                    className="text-primary hover:underline"
                  >
                    Abrir su conversación
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </SummaryCard>
      ) : null}

      {canCrm ? (
        <SummaryCard
          title="Oportunidades"
          action={
            canCrmWrite && !person.archived ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setNewOpportunity(true)}
              >
                Nueva oportunidad
              </Button>
            ) : undefined
          }
        >
          {opportunities.isPending ? (
            <LoadingState message="Cargando oportunidades…" />
          ) : opportunities.isError ? (
            <QueryErrorState
              error={opportunities.error}
              onRetry={() => void opportunities.refetch()}
            />
          ) : (opportunities.data?.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Sin oportunidades. Nacen cuando pide algo concreto: un precio, un tratamiento o una
              evaluación.
            </p>
          ) : (
            <ul className="flex flex-col divide-y">
              {(opportunities.data?.data ?? []).map((row) => (
                <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                    <Link
                      to="/pipeline"
                      search={{ oportunidad: row.id }}
                      className="font-medium text-primary hover:underline"
                    >
                      {row.title}
                    </Link>
                    <Badge variant="secondary">{row.stageName}</Badge>
                    {row.status !== "open" ? (
                      <Badge variant={row.status === "won" ? "default" : "outline"}>
                        {row.status === "won" ? "Ganada" : "Perdida"}
                      </Badge>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SummaryCard>
      ) : null}

      <WriteToPersonDialog
        open={writing}
        onClose={() => setWriting(false)}
        people={[{ contactId: person.id, displayName: person.displayName }]}
      />
      <OpportunityDrawer
        open={newOpportunity}
        contactId={person.id}
        onClose={() => setNewOpportunity(false)}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ["person-opportunities", person.id] })
        }}
      />
    </div>
  )
}
