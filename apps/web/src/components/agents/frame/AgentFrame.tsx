// Las piezas comunes de las demos de los agentes, en las dos webs: la cabecera (quién es el agente,
// dónde trabaja y en qué está), el globo de voz de quien le dicta y el pie (datos de ejemplo y
// «Repetir»). Con ellas Sofi, Clío y Argos se leen igual: alguien le habla o le escribe al agente y
// se ve lo que hace. Los colores salen de las variables de la marca (`data-brand`).
import { type ReactNode, useEffect, useState } from "react"
import "./agent-frame.css"

export type AgentId = "sofi" | "clio" | "argos"

const LETTER: Record<AgentId, string> = { sofi: "S", clio: "C", argos: "A" }

/** Barras de la onda de voz, con una clave fija para cada una. */
const WAVE = Array.from({ length: 22 }, (_, i) => `onda-${i}`)

/** Con movimiento reducido no se anima: se ve el estado final. */
export function prefersStill(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
  )
}

/** La cabecera: el agente con su inicial, dónde está y su estado («Escuchando…», «Listo»…). */
export function AgentHead({
  agent,
  name,
  meta,
  state,
  live = false,
  done = false,
}: {
  agent: AgentId
  name: string
  meta: string
  state?: string
  /** El punto late mientras el agente trabaja. */
  live?: boolean
  /** Terminado: el estado se pinta como hecho. */
  done?: boolean
}) {
  return (
    <div className="af-head">
      <span className={`af-avatar af-${agent}`} aria-hidden="true">
        {LETTER[agent]}
      </span>
      <span className="af-who">
        <b>{name}</b>
        <span className="af-meta">{meta}</span>
      </span>
      {state && (
        <span
          className="af-state"
          data-live={live || undefined}
          data-done={done || undefined}
          role="status"
        >
          <i aria-hidden="true" />
          {state}
        </span>
      )}
    </div>
  )
}

/**
 * Lo que dice quien dicta, en un globo con su nombre, el micrófono y la onda: se ve que le está
 * hablando a Clío. La frase aparece palabra por palabra mientras habla.
 */
export function VoiceBubble({
  initials,
  who,
  text,
  speaking,
  idle,
}: {
  initials: string
  who: string
  text: string
  speaking: boolean
  /** Lo que dice el globo cuando ya no habla (p. ej. «Dictado terminado · 1 min 12 s»). */
  idle?: string
}) {
  const words = text.split(" ")
  const [shown, setShown] = useState(words.length)

  // Cada frase nueva se escribe palabra por palabra; sin movimiento, entera.
  useEffect(() => {
    const total = text.split(" ").length
    if (prefersStill() || !speaking) {
      setShown(total)
      return
    }
    setShown(1)
    const timer = window.setInterval(() => {
      setShown((n) => {
        if (n + 1 >= total) window.clearInterval(timer)
        return Math.min(total, n + 1)
      })
    }, 90)
    return () => window.clearInterval(timer)
  }, [text, speaking])

  return (
    <div className="af-voice" data-speaking={speaking || undefined}>
      <span className="af-person" aria-hidden="true">
        {initials}
      </span>
      <div className="af-bubble">
        <span className="af-voice-head">
          <b>{who}</b>
          <span className="af-mic">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
            {speaking ? "le dicta a Clío" : (idle ?? "terminó de dictar")}
          </span>
        </span>
        <span className="af-wave" aria-hidden="true">
          {WAVE.map((bar) => (
            <i key={bar} />
          ))}
        </span>
        <span className="af-said">
          «{words.slice(0, shown).join(" ")}
          {shown < words.length ? (
            <span className="af-rest">{` ${words.slice(shown).join(" ")}»`}</span>
          ) : (
            "»"
          )}
        </span>
      </div>
    </div>
  )
}

/** El pie de todas las demos: que son datos de ejemplo y el botón para verla otra vez. */
export function AgentFoot({
  note,
  replay,
  onReplay,
}: {
  note: ReactNode
  replay?: string
  onReplay?: () => void
}) {
  return (
    <div className="af-foot">
      <span className="af-note">{note}</span>
      {replay && onReplay && (
        <button type="button" className="af-replay" onClick={onReplay}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" />
          </svg>
          {replay}
        </button>
      )}
    </div>
  )
}
