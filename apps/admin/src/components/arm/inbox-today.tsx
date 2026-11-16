/**
 * «Te toca» en Hoy (ADR 0196): las tres conversaciones de la Bandeja que esperan hace más tiempo,
 * con «Ver la Bandeja». Cada una se abre en su cajón, la misma conversación de `/inbox`. Solo
 * Administración (la Bandeja es suya).
 */
import { Button } from "@odentia/ui"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { momentWords } from "./chat-api"
import { ConversationDrawer, type ConversationTarget } from "./conversation-drawer"
import { CLIENT_PHASE_WORDS, INBOX_CHANNEL_WORDS, useInbox } from "./inbox-api"

export function InboxToday() {
  const inbox = useInbox({ estado: "te_toca", limit: 3 })
  const [target, setTarget] = useState<ConversationTarget | null>(null)
  const total = inbox.data?.counts.teToca ?? 0
  const items = inbox.data?.items ?? []
  if (!inbox.data || total === 0) return null
  return (
    <section aria-labelledby="hoy-te-toca" className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="hoy-te-toca" className="text-base font-semibold">
          Te toca responder
        </h2>
        <span className="text-sm text-muted-foreground tabular-nums">
          {total > items.length ? `${items.length} de ${total}` : total}
        </span>
        <Link to="/inbox" className="ml-auto text-sm font-medium text-primary underline-offset-4 hover:underline">
          Ver la Bandeja
        </Link>
      </div>
      <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
        {items.map((item) => (
          <li key={`${item.kind}:${item.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
            <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
              <p className="truncate text-sm font-medium">
                {item.who.name ?? item.who.address}
                {item.subject ? <span className="font-normal text-muted-foreground"> · {item.subject}</span> : null}
              </p>
              <p className="truncate text-sm text-muted-foreground">{item.preview ?? "Mandó un archivo"}</p>
              <p className="text-xs text-muted-foreground">
                {INBOX_CHANNEL_WORDS[item.channel]} · {momentWords(item.lastInboundAt)}
                {item.client
                  ? ` · ${item.client.name} · ${CLIENT_PHASE_WORDS[item.client.phase]}`
                  : " · sin cliente"}
                {item.stateWhy ? ` · ${item.stateWhy}` : ""}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() =>
                setTarget(
                  item.kind === "chat" ? { kind: "chat", chatId: item.id } : { kind: "correo", emailId: item.id },
                )
              }
            >
              Responder
            </Button>
          </li>
        ))}
      </ul>
      <ConversationDrawer target={target} open={Boolean(target)} onClose={() => setTarget(null)} />
    </section>
  )
}
