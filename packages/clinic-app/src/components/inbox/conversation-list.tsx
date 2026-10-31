import { Badge, Button, ScrollArea, Spinner } from "@odentia/ui"
import { DataRefreshMarker, EmptyState, personInitials, SkeletonRegion } from "@odentia/ui-patterns"
import { Bot } from "lucide-react"
import { ConversationRowsSkeleton } from "../skeletons/inbox"
import { useReceptionName } from "../../lib/agent-names"
import { channelIcon } from "../../lib/channels"
import { screenReasonWords } from "../../lib/contact-screen"
import { channelsWords, conversationWords, type ConversationWords, listTimeWords, topicQuote } from "../../lib/conversation-state"
import { type ConversationListItem, previewWords } from "../../lib/crm"

/** Spam y Bloqueados (ADR 0054): dos listas aparte, junto a las pestañas. */
export type SideView = "spam" | "blocked"

/**
 * La fila de la lista es la persona (fase 4 del pulido): sigue elegida al abrir
 * cualquiera de sus conversaciones, también desde un enlace viejo.
 */
export function isRowOf(item: ConversationListItem, id: string | null): boolean {
  return id !== null && (item.id === id || (item.conversationIds ?? []).includes(id))
}

/**
 * En qué está la conversación, en palabras del servidor (`attention`,
 * `closure`; ver `conversationWords`). Nunca solo con color: el texto lo dice
 * y la marca solo lo acompaña.
 */
export function StateLabel({ words, className = "" }: { words: ConversationWords; className?: string }) {
  if (words.tone === "agent") {
    return (
      <span className={`flex min-w-0 items-center gap-1 font-semibold text-primary-soft-foreground ${className}`}>
        <Bot className="size-3.5 shrink-0" aria-hidden /> <span className="truncate">{words.text}</span>
      </span>
    )
  }
  // Color con un solo significado (ADR 0050): ámbar lo que pide a una persona,
  // rojo solo «Ahora», gris esperar o cerrada; siempre con su frase.
  const tone =
    words.tone === "urgent"
      ? "font-semibold text-destructive"
      : words.tone === "team" || words.tone === "waiting"
        ? "font-semibold text-warning"
        : "text-muted-foreground"
  const mark =
    words.tone === "urgent"
      ? "size-2 shrink-0 rounded-full bg-destructive"
      : words.tone === "team" || words.tone === "waiting"
        ? "size-2 shrink-0 rounded-[2px] bg-warning"
        : null
  return (
    <span className={`flex min-w-0 items-center gap-1.5 ${tone} ${className}`}>
      {mark ? <span aria-hidden className={mark} /> : null}
      <span className="truncate">{words.text}</span>
    </span>
  )
}

/**
 * La segunda línea de la fila dice una sola cosa, en este orden: lo que pide a
 * una persona, cómo se cerró, lo último que hizo el agente, en qué está y, si no,
 * el último mensaje. Todo sale de lo que entrega el servidor.
 */
function rowLine(item: ConversationListItem, myUserId: string, receptionName: string): ConversationWords {
  const topic = item.attention?.topics?.[0]
  if (topic) {
    const who = !topic.assigneeUserId || topic.assigneeUserId === myUserId ? "Te toca" : `Lo tiene ${topic.assigneeName ?? "otra persona"}`
    const mine = !topic.assigneeUserId || topic.assigneeUserId === myUserId
    return {
      text: `${topic.urgent ? "Ahora" : who} · «${topicQuote(topic)}»`,
      tone: topic.urgent ? "urgent" : mine ? "team" : "patient",
    }
  }
  const words = conversationWords({ ...item, myUserId, receptionName })
  if (words?.tone === "closed") return words
  const action = item.lastAction
  if (action) {
    const what = action.what ? ` · ${action.what}` : ""
    if (action.state === "no_se_pudo") return { text: `${receptionName} ${action.title}${what}`, tone: "team" }
    if (action.state === "espera") return { text: `Espera su sí${what}`, tone: "patient" }
    return { text: `${receptionName} ${action.title}${what}`, tone: "agent" }
  }
  // Lo que nadie respondió se dice con lo que escribió: es lo que hay que leer.
  if (words?.tone === "team") return { text: `${words.text.split(" · ")[0]} · «${previewWords(item.preview)}»`, tone: "team" }
  if (words && words.tone !== "agent") return words
  return { text: previewWords(item.preview), tone: "patient" }
}

/** Listado de conversaciones: filas, vacío y paginación por cursor. */
export function ConversationList({
  items,
  myUserId,
  selectedId,
  isLoading,
  isRefreshing,
  isError,
  hasItems,
  hasNextPage,
  isFetchingNextPage,
  onSelect,
  onFetchNextPage,
  onRetry,
  onNew,
  searching = false,
  sideView = null,
  onRowAction,
  onBackToTabs,
}: {
  items: ConversationListItem[]
  /** Quien mira: un tema suyo se dice «Lo tienes tú». */
  myUserId: string
  selectedId: string | null
  isLoading: boolean
  isRefreshing: boolean
  isError: boolean
  hasItems: boolean
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onSelect: (id: string) => void
  onFetchNextPage: () => void
  onRetry: () => void
  /** «Nueva conversación»: el vacío ofrece escribirle a alguien. */
  onNew?: () => void
  /** Hay una búsqueda: el vacío dice que nadie coincide. */
  searching?: boolean
  /** Spam o Bloqueados (ADR 0054): cada fila dice su motivo y trae su botón. */
  sideView?: SideView | null
  /** «No es spam» o «Desbloquear» de la fila; ausente sin permiso. */
  onRowAction?: (item: ConversationListItem) => void
  /** El vacío de Spam y Bloqueados lleva de vuelta a las pestañas. */
  onBackToTabs?: () => void
}) {
  const receptionName = useReceptionName()
  return (
    // El desplazamiento de la lista es el de la aplicación (ScrollArea), no la barra nativa.
    <ScrollArea className="elevated min-h-0 flex-1 rounded-xl border bg-card">
      <div className="flex flex-col divide-y">
        {sideView ? (
          <div className="flex flex-col gap-0.5 px-3.5 py-2.5">
            <span className="text-sm font-semibold">{sideView === "spam" ? "Spam · últimos 30 días" : "Bloqueados"}</span>
            <span className="text-xs text-muted-foreground">
              {sideView === "spam"
                ? `${receptionName} no responde lo que está aquí, y no se cobra.`
                : `Nadie les escribe y ${receptionName} no les responde. Para volver a atenderlos, desbloquéalos.`}
            </span>
          </div>
        ) : null}
        {items.map((item) => {
          const selected = isRowOf(item, selectedId)
          const initials = personInitials(item.contact.displayName)
          // La fila es la persona: un icono por canal, primero el de la conversación que muestra.
          const rowChannels = item.channels?.length ? item.channels : [item.connection.channel]
          const screen = item.contact.screen ?? null
          const line = screen ? null : rowLine(item, myUserId, receptionName)
          const row = (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              aria-current={selected ? "true" : undefined}
              className={`relative flex min-w-0 flex-1 gap-2.5 px-3.5 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
                selected ? "bg-muted shadow-[inset_3px_0_0_0_var(--color-foreground)]" : "hover:bg-muted/70"
              }`}
            >
              <span
                aria-hidden
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[13px] font-semibold text-primary-soft-foreground"
              >
                {initials || "?"}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={`min-w-0 truncate text-sm ${item.unreadCount > 0 ? "font-bold" : "font-semibold"}`}>
                    {item.contact.displayName}
                  </span>
                  <span className="flex flex-1 items-center gap-1 text-muted-foreground">
                    {rowChannels.map((rowChannel) => {
                      const ChannelIcon = channelIcon(rowChannel)
                      return <ChannelIcon key={rowChannel} className="size-3.5 shrink-0" aria-hidden />
                    })}
                    <span className="sr-only">{channelsWords(rowChannels)}</span>
                    {item.isTest ? <Badge variant="secondary" className="shrink-0">Prueba</Badge> : null}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {listTimeWords(item.lastMessageAt ?? item.preview?.createdAt ?? null)}
                  </span>
                </span>
                <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
                  {/* En Spam y Bloqueados la fila dice por qué; el estado de atención no aplica. */}
                  {screen ? (
                    <span className="min-w-0 flex-1 truncate">{screenReasonWords(screen, item.contact.screenReason)}</span>
                  ) : line ? (
                    <StateLabel words={line} className="flex-1 font-medium [&.font-semibold]:font-semibold" />
                  ) : null}
                  {item.unreadCount > 0 && (
                    <span
                      className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-primary px-1 text-xs font-semibold text-primary-foreground"
                      aria-label={`${item.unreadCount} sin leer`}
                    >
                      {item.unreadCount}
                    </span>
                  )}
                </span>
              </span>
            </button>
          )
          if (!sideView || !screen || !onRowAction) return row
          return (
            <div key={item.id} className="flex items-center gap-2 pr-3">
              {row}
              <Button type="button" size="sm" variant="outline" className="min-h-11 shrink-0 rounded-full sm:min-h-8" onClick={() => onRowAction(item)}>
                {screen === "blocked" ? "Desbloquear" : "No es spam"}
              </Button>
            </div>
          )
        })}
        {isRefreshing && hasItems ? (
          <div className="p-2">
            <DataRefreshMarker />
          </div>
        ) : null}
        {isLoading && !hasItems && (
          <SkeletonRegion message="Cargando conversaciones…">
            <ConversationRowsSkeleton />
          </SkeletonRegion>
        )}
        {isError && !hasItems && !isLoading && (
          <div className="flex flex-wrap items-center gap-2 p-4">
            <p className="text-sm text-destructive" role="alert">
              No se pudieron cargar las conversaciones.
            </p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Reintentar
            </Button>
          </div>
        )}
        {!isError && !hasItems && !isLoading && sideView && !searching ? (
          <EmptyState
            title={sideView === "spam" ? "Nada en spam" : "Nadie bloqueado"}
            description={
              sideView === "spam"
                ? `Si llega publicidad o un envío automático, ${receptionName} no lo responde y aparece aquí.`
                : "Para bloquear a alguien que acosa o amenaza, abre su conversación y elige «Bloquear a esta persona…» en el menú ⋯."
            }
            actionLabel={onBackToTabs ? "Ver «Por atender»" : undefined}
            onAction={onBackToTabs}
          />
        ) : null}
        {!isError && !hasItems && !isLoading && !(sideView && !searching) && (
          <EmptyState
            title={searching ? "Nadie coincide con la búsqueda" : "Sin conversaciones"}
            description={
              searching
                ? "Busca por nombre o por teléfono. Si aún no le escribiste, empieza una conversación."
                : "Los mensajes entrantes aparecen aquí."
            }
            actionLabel={onNew ? "Nueva conversación" : undefined}
            onAction={onNew}
          />
        )}
        {isError && hasItems ? (
          <div className="flex flex-wrap items-center gap-2 p-4">
            <p className="text-sm text-destructive" role="alert">
              No se pudo actualizar la lista; se conservan las conversaciones cargadas.
            </p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Reintentar solo la lista
            </Button>
          </div>
        ) : null}
        {hasNextPage && (
          <Button variant="ghost" size="sm" className="self-center" disabled={isFetchingNextPage} onClick={onFetchNextPage}>
            {isFetchingNextPage ? (
              <>
                <Spinner className="size-4" aria-hidden />
                Cargar más
              </>
            ) : (
              "Cargar más"
            )}
          </Button>
        )}
      </div>
    </ScrollArea>
  )
}
