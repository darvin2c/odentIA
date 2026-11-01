import { Badge } from "@odentia/ui"
import { Clock, Minus, TriangleAlert } from "lucide-react"
import { URGENCY_WORDS, urgencyWord } from "../../lib/agent"

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

/**
 * `urgent`: el servidor ya dice si es «Ahora» (alta, o dos horas de clínica
 * abierta esperando; decisión 1 del pulido de la Bandeja). Sin él, la prioridad.
 */
export function HandoffUrgency({ priority, urgent }: { priority: string; urgent?: boolean }) {
  const urgency = urgent ? URGENCY.alta : (URGENCY[priority as keyof typeof URGENCY] ?? URGENCY.media)
  return (
    <Badge variant={urgency.variant} className="gap-1 font-semibold">
      <urgency.Icon className="size-3.5" aria-hidden />
      {urgency.label}
    </Badge>
  )
}
