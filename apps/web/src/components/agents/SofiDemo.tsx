// Demostración de Sofi en la portada de /agentes/recepcion (lienzo del paso 3, tablero Sofi): la
// conversación se escribe sola —Andrea pregunta, «Sofi está escribiendo…» dentro de la burbuja, la
// respuesta, Andrea elige, la confirmación y la cita marcada en la agenda— y se puede cambiar el tono
// (cercano, neutro o formal de usted) y los emojis. Con movimiento reducido se ve el estado final.
// Los mensajes van pegados al fondo, como en WhatsApp, y la tarjeta mide lo que la conversación
// completa (useSteadyHeight): cada mensaje entra abajo y «Volver a ver» no se mueve.
import { useCallback, useEffect, useRef, useState } from "react"
import { useSteadyHeight } from "../../lib/steady"
import { AgentFoot, AgentHead, prefersStill } from "./frame/AgentFrame"
import "./sofi-demo.css"

type Tone = "cercano" | "neutro" | "formal"

/** Datos de ejemplo: Clínica Sonrisa Norte y sus profesionales son inventados. */
const TEXTS: Record<Tone, [string, string]> = {
  cercano: [
    "Hola, Andrea. Soy Sofi, asistente virtual de Clínica Sonrisa Norte. Siento lo de la muela. Mañana jueves tengo libre a las 10:30 con la Dra. Paredes o a las 16:30 con el Dr. Ríos. ¿Cuál te acomoda?",
    "¡Listo! Te esperamos mañana a las 16:30 con el Dr. Ríos. Te escribo un rato antes para recordártelo.",
  ],
  neutro: [
    "Hola, Andrea. Soy Sofi, asistente virtual de Clínica Sonrisa Norte. Mañana jueves hay horarios a las 10:30 con la Dra. Paredes y a las 16:30 con el Dr. Ríos. ¿Cuál prefieres?",
    "Listo. Tu cita es mañana a las 16:30 con el Dr. Ríos. Te enviaremos un recordatorio.",
  ],
  formal: [
    "Buenas noches, señora Andrea. Le saluda Sofi, asistente virtual de Clínica Sonrisa Norte. Lamento la molestia. Mañana jueves hay disponibilidad a las 10:30 con la Dra. Paredes o a las 16:30 con el Dr. Ríos. ¿Cuál le acomoda?",
    "Su cita queda registrada para mañana a las 16:30 con el Dr. Ríos. Le enviaremos un recordatorio.",
  ],
}

const TONES: [Tone, string][] = [
  ["cercano", "Cercano"],
  ["neutro", "Neutro"],
  ["formal", "Formal · usted"],
]

const LAST = 6
const TYPING = "Sofi está escribiendo…"

export default function SofiDemo() {
  const [tone, setTone] = useState<Tone>("cercano")
  const [emoji, setEmoji] = useState(false)
  // Se arma en el servidor con la conversación completa: sin JavaScript o con movimiento reducido, se lee entera.
  const [step, setStep] = useState(LAST)

  const timer = useRef<number | null>(null)
  // Al girar el teléfono, la conversación se muestra completa y se mide de nuevo.
  const steady = useSteadyHeight<HTMLDivElement>(undefined, () => {
    if (timer.current) window.clearInterval(timer.current)
    setStep(LAST)
  })

  const play = useCallback(() => {
    if (timer.current) window.clearInterval(timer.current)
    setStep(0)
    timer.current = window.setInterval(() => {
      setStep((s) => {
        if (s >= LAST - 1 && timer.current) window.clearInterval(timer.current)
        return Math.min(s + 1, LAST)
      })
    }, 1400)
  }, [])

  useEffect(() => {
    if (!prefersStill()) play()
    return () => {
      if (timer.current) window.clearInterval(timer.current)
    }
  }, [play])

  const [reply, confirm] = TEXTS[tone]
  // «Pocos» emojis: uno como mucho, y nunca cuando hablan de dolor, urgencias, pagos o reclamos;
  // por eso solo va en la confirmación.
  const confirmText = emoji ? `${confirm} 🙂` : confirm
  /** Mientras escribe, la burbuja dice «Sofi está escribiendo…»; después, la respuesta. */
  const said = (text: string, typing: boolean) => (typing ? <span className="sd-typing">{TYPING}</span> : text)

  return (
    <div className="sd" ref={steady}>
      <AgentHead
        agent="sofi"
        name="Sofi · Clínica Sonrisa Norte"
        meta="WhatsApp · miércoles 23:40 · cerrado"
        state={step >= LAST ? "Cita agendada" : step === 1 || step === 4 ? "Escribiendo…" : "Conversando"}
        live={step < LAST}
        done={step >= LAST}
      />
      <div className="sd-controls">
        <div className="sd-tones">
          {TONES.map(([id, label]) => (
            <button key={id} type="button" className="sd-tone" aria-pressed={tone === id} onClick={() => setTone(id)}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="sd-emoji" aria-pressed={emoji} onClick={() => setEmoji(!emoji)}>
          <span className="sd-switch" aria-hidden="true">
            <span />
          </span>
          Emojis
        </button>
      </div>
      <div className="sd-chat">
        <p data-side="in">Hola, buenas noches. ¿Tienen cita para mañana? Me duele una muela.</p>
        {step >= 1 && <p data-side="out">{said(reply, step === 1)}</p>}
        {step >= 3 && <p data-side="in">A las 16:30, por favor.</p>}
        {step >= 4 && <p data-side="out">{said(confirmText, step === 4)}</p>}
        {step >= LAST && (
          <div data-side="agenda" data-marked>
            <span>
              <b>Agenda · jueves 22</b> · 16:30 con el Dr. Ríos
            </span>
            <span className="sd-booked">reservada · 23:41</span>
          </div>
        )}
      </div>
      <AgentFoot note="Datos de ejemplo. Cambia el tono y los emojis." replay="Volver a ver" onReplay={play} />
    </div>
  )
}
