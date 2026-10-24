// Demostración de Sofi en la portada de /agentes/recepcion (lienzo del paso 3, tablero Sofi): la
// conversación se escribe sola —Andrea pregunta, «Sofi está escribiendo…» dentro de la burbuja, la
// respuesta, Andrea elige, la confirmación y la cita marcada en la agenda— y se puede cambiar el tono
// (cercano, neutro o formal de usted) y los emojis. Con movimiento reducido se ve el estado final.
import { useEffect, useState } from "react"
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

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    setStep(0)
    const timer = window.setInterval(() => {
      setStep((s) => {
        if (s >= LAST - 1) window.clearInterval(timer)
        return Math.min(s + 1, LAST)
      })
    }, 1400)
    return () => window.clearInterval(timer)
  }, [])

  const [reply, confirm] = TEXTS[tone]
  // «Pocos» emojis: uno como mucho, y nunca cuando hablan de dolor, urgencias, pagos o reclamos;
  // por eso solo va en la confirmación.
  const confirmText = emoji ? `${confirm} 🙂` : confirm
  const shown = (on: boolean) => ({ className: on ? "sd-on" : "sd-off", "aria-hidden": on ? undefined : true })

  return (
    <div className="sd">
      <div className="sd-top">
        <span className="sd-avatar" aria-hidden="true">S</span>
        <span className="sd-who">
          <b>Sofi · Clínica Sonrisa Norte</b>
          <span className="sd-meta">WhatsApp · miércoles 23:40 · la clínica está cerrada</span>
        </span>
      </div>
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
        <p {...shown(step >= 0)} data-side="in">
          Hola, buenas noches. ¿Tienen cita para mañana? Me duele una muela.
        </p>
        <p {...shown(step >= 1)} data-side="out" data-typing={step === 1 || undefined}>
          {step === 1 ? TYPING : reply}
        </p>
        <p {...shown(step >= 3)} data-side="in">
          A las 16:30, por favor.
        </p>
        <p {...shown(step >= 4)} data-side="out" data-typing={step === 4 || undefined}>
          {step === 4 ? TYPING : confirmText}
        </p>
        <div {...shown(step >= LAST)} data-side="agenda" data-marked={step >= LAST || undefined}>
          <span>
            <b>Agenda · jueves 22</b> · 16:30 con el Dr. Ríos
          </span>
          <span className="sd-booked">reservada · 23:41</span>
        </div>
      </div>
      <span className="sd-note">Demostración con datos de ejemplo. Cambia el tono y los emojis.</span>
    </div>
  )
}
