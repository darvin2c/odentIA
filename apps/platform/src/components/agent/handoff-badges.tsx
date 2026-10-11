import { Badge } from "@odentia/ui"
import { Clock, Minus, TriangleAlert } from "lucide-react"

/**
 * Qué tan pronto hay que atender un caso que pasó al equipo. La prioridad es
 * la misma del sistema (alta, media, baja); aquí se dice con una palabra, un
 * icono y un color, para que no dependa solo del color.
 */
const URGENCY = {
  alta: { label: "Ahora", variant: "destructive", Icon: TriangleAlert },
  media: { label: "Hoy", variant: "warning", Icon: Clock },
  baja: { label: "Sin apuro", variant: "outline", Icon: Minus },
} as const

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
