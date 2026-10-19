import { Badge, Button } from "@odentia/ui"
import { Clock, Minus, TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"
import { type AgentHandoff, URGENCY_WORDS, urgencyWord } from "../../lib/agent"
import { channelLabel } from "../../lib/channels"
import { timeAgo } from "../../lib/crm"

/**
 * Qué tan pronto hay que atender un caso que pasó al equipo. La prioridad es
 * la misma del sistema (alta, media, baja); aquí se dice con una palabra, un
 * icono y un color, para que no dependa solo del color.
 */
const URGENCY = {
  alta: { label: URGENCY_WORDS.alta, variant: "destructive", Icon: TriangleAlert },
  media: { label: URGENCY_WORDS.media, variant: "warning", Icon: Clock },
  baja: { label: URGENCY_WORDS.baja, variant: "outline", Icon: Minus },
} as const

/** La palabra del nivel, para donde no cabe la insignia (una fila de la Bandeja). */
export const urgencyLabel = urgencyWord

export function HandoffUrgency({ priority }: { priority: string }) {
  const urgency = URGENCY[priority as keyof typeof URGENCY] ?? URGENCY.media
  return (
    <Badge variant={urgency.variant} className="gap-1 font-semibold">
      <urgency.Icon className="size-3.5" aria-hidden />
      {urgency.label}
    </Badge>
  )
}

/** Lo que la persona escribió, tal como lo dejó el agente al pasar el caso («Escribió: «a» · «b»»). */
const SAID = /^Escribió: («.+»)$/s

/**
 * El resumen de una derivación. Cuando trae los mensajes de la persona se
 * muestran uno por línea y en orden: lo importante puede estar en el primero.
 */
export function HandoffSummary({ reason, summary }: { reason: string; summary: string | null }) {
  const said = summary ? SAID.exec(summary.trim())?.[1] : undefined
  const messages = said
    ? said
        .slice(1, -1)
        .split("» · «")
        .map((text) => text.trim())
        .filter(Boolean)
    : []
  if (messages.length === 0) {
    return summary && summary !== reason ? <p className="whitespace-pre-wrap text-muted-foreground">{summary}</p> : null
  }
  if (messages.length === 1) return <p className="text-foreground">«{messages[0]}»</p>
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-semibold text-muted-foreground">Escribió {messages.length} mensajes seguidos</p>
      <ol className="flex list-decimal flex-col gap-0.5 pl-5">
        {messages.map((text, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: mensajes en el orden en que se escribieron; la lista no se reordena.
          <li key={`${index}-${text.slice(0, 24)}`}>{text}</li>
        ))}
      </ol>
    </div>
  )
}

/**
 * El aviso de un caso que pasó al equipo: qué tan urgente es, de qué se trata,
 * quién escribe, lo que escribió y lo que se le dijo. «Ver el caso» abre el
 * resumen; las demás acciones las pone cada superficie.
 */
export function HandoffNotice({
  handoff,
  onOpenCase,
  children,
}: {
  handoff: AgentHandoff
  /** Abre el resumen del caso; sin conversación no hay resumen que abrir. */
  onOpenCase?: (handoff: AgentHandoff) => void
  children?: ReactNode
}) {
  const arrived = timeAgo(handoff.createdAt)
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <HandoffUrgency priority={handoff.priority} />
        {/* El motivo se parte en líneas en vez de cortarse en la columna angosta. */}
        <Badge variant="secondary" className="h-auto max-w-full whitespace-normal text-left">
          {handoff.reason}
        </Badge>
      </div>
      <div className="flex flex-col">
        <span className="font-semibold">{handoff.contactName ?? "Interlocutor no disponible"}</span>
        <span className="text-muted-foreground">
          {[handoff.channel ? channelLabel(handoff.channel) : null, arrived || null].filter(Boolean).join(" · ")}
        </span>
      </div>
      <HandoffSummary reason={handoff.reason} summary={handoff.summary} />
      {handoff.notice ? (
        <p className="text-muted-foreground">
          Se le dijo: <span className="line-clamp-3 text-foreground">«{handoff.notice}»</span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {handoff.conversationId && onOpenCase ? (
          <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={() => onOpenCase(handoff)}>
            Ver el caso
          </Button>
        ) : null}
        {children}
      </div>
    </div>
  )
}
