import { Button } from "@odentia/ui"
import { topicQuote, topicWords } from "../../lib/conversation-state"
import { type InboxTopic, timeAgo } from "../../lib/crm"

/**
 * Los temas por atender, cuando la caja no puede elegir sola (ADR 0122): con
 * varios, responder a uno es decirlo; y lo que no necesita respuesta se resuelve
 * desde aquí, sin enviar nada.
 */
export function TopicList({
  topics,
  myUserId,
  receptionName,
  busy,
  onPick,
  onResolve,
}: {
  topics: InboxTopic[]
  myUserId: string | null
  receptionName: string
  busy: boolean
  onPick: (topic: InboxTopic) => void
  onResolve: (topic: InboxTopic) => void
}) {
  const isMine = (topic: InboxTopic) => !topic.assigneeUserId || topic.assigneeUserId === myUserId
  // Lo que ya dice la lista («te toca») no se repite en cada fila.
  const meta = (topic: InboxTopic) => {
    return [
      isMine(topic) ? (topic.urgent ? "Ahora" : null) : topicWords(topic, myUserId, receptionName),
      topic.source ? timeAgo(topic.source.createdAt) : null,
      topic.askedMessageIds.length > 0 ? `${topic.askedMessageIds.length + 1} mensajes` : null,
    ]
      .filter(Boolean)
      .join(" · ")
  }
  return (
    <section aria-label="Temas por atender" className="flex flex-col gap-1 rounded-2xl bg-input/50 p-2">
      <p className="flex flex-wrap items-center gap-x-2 px-1.5 text-[13px]">
        <span aria-hidden className="size-2 shrink-0 rounded-[2px] bg-warning" />
        <span className="font-semibold text-warning">{topics.length === 1 ? "1 tema por atender" : `${topics.length} temas por atender`}</span>
        <span className="text-muted-foreground">Toca uno para verlo y responderlo</span>
      </p>
      {/* Con muchos temas la lista se desplaza: la caja de escribir sigue a la vista. */}
      <ul className="flex max-h-36 flex-col gap-1 overflow-y-auto">

        {topics.map((topic) => (
          <li key={topic.id} className="flex items-center gap-1 rounded-xl bg-background">
            <button
              type="button"
              disabled={!topic.source || busy}
              onClick={() => onPick(topic)}
              className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-x-2 rounded-xl px-3 py-1 text-left text-[13px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent sm:min-h-8"
            >
              <span className="min-w-[10rem] flex-1 basis-40 truncate">«{topicQuote(topic)}»</span>
              <span className={`shrink-0 text-xs ${topic.urgent ? "font-semibold text-destructive" : "text-muted-foreground"}`}>{meta(topic)}</span>
            </button>
            {/* Lo de otra persona no se cierra de un toque: se elige y se resuelve en su «…». */}
            {isMine(topic) ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-11 shrink-0 px-2 text-xs font-semibold text-primary sm:min-h-8"
                aria-label={`Resolver sin responder: ${topicQuote(topic, 40)}`}
                disabled={busy}
                onClick={() => onResolve(topic)}
              >
                Resolver
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
