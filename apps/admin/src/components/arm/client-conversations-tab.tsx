/**
 * La pestaña «Conversaciones» de la ficha (ADR 0196): las conversaciones de este cliente en la
 * Bandeja, de todos sus canales, las que esperan primero. Cada una se abre en su cajón, la misma
 * conversación de `/inbox`. Solo Administración (la Bandeja es suya).
 */
import { Badge, Button } from "@odentia/ui"
import { EmptyState, ErrorState, SkeletonRegion } from "@odentia/ui-patterns"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { useIsAdmin } from "../../lib/session"
import { momentWords } from "./chat-api"
import { ConversationDrawer, type ConversationTarget } from "./conversation-drawer"
import { INBOX_CHANNEL_WORDS, INBOX_STATE_WORDS, useInbox } from "./inbox-api"

const STATE_BADGE = { te_toca: "warning", kairos: "soft", respondida: "secondary" } as const

export function ClientConversationsTab({ clientId }: { clientId: string }) {
  const isAdmin = useIsAdmin()
  const inbox = useInbox({ estado: "todas", cliente: clientId, limit: 100 }, { enabled: isAdmin })
  const [target, setTarget] = useState<ConversationTarget | null>(null)

  if (!isAdmin)
    return (
      <p className="text-sm text-muted-foreground">
        Las conversaciones por correo y por chat las atiende Administración.
      </p>
    )
  if (inbox.isPending)
    return (
      <SkeletonRegion message="Cargando sus conversaciones…">
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-16 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      </SkeletonRegion>
    )
  if (inbox.isError && !inbox.data)
    return (
      <ErrorState
        title="No pude cargar sus conversaciones"
        error={inbox.error}
        onRetry={() => void inbox.refetch()}
      />
    )
  const items = inbox.data?.items ?? []
  return (
    <section aria-labelledby="ficha-conversaciones" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="ficha-conversaciones" className="text-base font-semibold">
          Conversaciones
        </h2>
        <span className="text-sm text-muted-foreground">
          Lo que nos escribió por correo, WhatsApp, Instagram o Messenger, y lo que le respondimos.
        </span>
        <Link to="/inbox" className="ml-auto text-sm font-medium text-primary underline-offset-4 hover:underline">
          Ir a la Bandeja
        </Link>
      </div>
      {items.length === 0 ? (
        <EmptyState
          title="Todavía no nos escribió"
          description="Cuando escriba por correo o por chat, su conversación aparece aquí y en la Bandeja."
        />
      ) : (
        <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
                <p className="truncate text-sm font-medium">
                  {item.subject ?? item.who.name ?? item.who.address}
                </p>
                <p className="truncate text-sm text-muted-foreground">{item.preview ?? "Mandó un archivo"}</p>
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <Badge variant={STATE_BADGE[item.state]}>{INBOX_STATE_WORDS[item.state]}</Badge>
                  <span>{INBOX_CHANNEL_WORDS[item.channel]}</span>
                  <span>· {momentWords(item.lastActivityAt)}</span>
                  {item.stateWhy ? <span>· {item.stateWhy}</span> : null}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant={item.state === "te_toca" ? "default" : "outline"}
                onClick={() =>
                  setTarget(
                    item.kind === "chat" ? { kind: "chat", chatId: item.id } : { kind: "correo", emailId: item.id },
                  )
                }
              >
                {item.state === "te_toca" ? "Responder" : "Abrir"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConversationDrawer target={target} open={Boolean(target)} onClose={() => setTarget(null)} />
    </section>
  )
}
