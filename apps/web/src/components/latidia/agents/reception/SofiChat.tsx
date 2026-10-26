// La conversación de Sofi en la portada de /agentes/recepcion de latidIA (tablero «Sofi»): el WhatsApp
// del Consultorio San Martín un viernes a las 22:40, con dos escenas. «Agenda»: Rosa tiene fiebre y
// Sofi le ofrece dos horas con la Dra. Vela y el precio de la consulta, y la cita queda en la agenda.
// «Urgencia»: una embarazada con sangrado; Sofi da el 106 y el teléfono del consultorio, y la banda
// «Te lo pasó el agente» avisa al equipo. Se escribe sola; cambiar de escena la empieza de nuevo. El
// tono y los emojis cambian las respuestas. Con movimiento reducido se ve la conversación completa.
import { useEffect, useRef, useState } from "react"
import { AgentFoot, AgentHead } from "../../../agents/frame/AgentFrame"
import "./sofi-chat.css"

type Scene = "agenda" | "urgencia"
type Tone = "cercano" | "neutro" | "formal"
type Kind = "in" | "out" | "card" | "band"

/** Datos de la demo de latidIA: el consultorio, la doctora y sus pacientes son de ejemplo. */
const TEXTS: Record<Scene, Record<Tone, string[]>> = {
  agenda: {
    cercano: [
      "Hola, Rosa. Soy Sofi, asistente virtual del Consultorio San Martín. Siento que estés así. Mañana sábado la Dra. Vela tiene libre a las 09:00 o a las 11:30. La consulta de medicina general cuesta S/ 80. ¿Cuál te acomoda?",
      "¡Listo, Rosa! Te esperamos mañana a las 09:00 con la Dra. Vela, en Av. Perú 1820. Te escribo un rato antes para recordártelo.",
    ],
    neutro: [
      "Hola, Rosa. Soy Sofi, asistente virtual del Consultorio San Martín. Mañana sábado hay horarios a las 09:00 y a las 11:30 con la Dra. Vela. La consulta de medicina general cuesta S/ 80. ¿Cuál prefieres?",
      "Listo. Tu cita es mañana a las 09:00 con la Dra. Vela, en Av. Perú 1820. Te enviaremos un recordatorio.",
    ],
    formal: [
      "Buenas noches, señora Rosa. Le saluda Sofi, asistente virtual del Consultorio San Martín. Lamento la molestia. Mañana sábado la Dra. Vela tiene disponibilidad a las 09:00 o a las 11:30. La consulta de medicina general cuesta S/ 80. ¿Cuál le acomoda?",
      "Su cita queda registrada para mañana a las 09:00 con la Dra. Vela, en Av. Perú 1820. Le enviaremos un recordatorio.",
    ],
  },
  // En una señal de alarma, primero el número de emergencias (Perú: 106) y el teléfono del consultorio.
  urgencia: {
    cercano: [
      "Carla, esto necesita atención ahora. Llama al 106 o ve a la emergencia más cercana. El teléfono del consultorio es (01) 555 0188. Ya avisé al equipo.",
    ],
    neutro: [
      "Carla, esto necesita atención inmediata. Llama al 106 o acude a la emergencia más cercana. Teléfono del consultorio: (01) 555 0188. Ya avisé al equipo.",
    ],
    formal: [
      "Señora Carla, esto requiere atención inmediata. Llame al 106 o acuda a la emergencia más cercana. Teléfono del consultorio: (01) 555 0188. Ya informé al equipo.",
    ],
  },
}

const SCENES: [Scene, string][] = [
  ["agenda", "Agenda"],
  ["urgencia", "Urgencia"],
]
const TONES: [Tone, string][] = [
  ["cercano", "Cercano"],
  ["neutro", "Neutro"],
  ["formal", "Formal"],
]

/** Cada mensaje de Sofi ocupa dos pasos: primero los puntos de «escribiendo», luego el texto. */
const LAST = 8
const STEP_MS = 1500

export default function SofiChat() {
  const [scene, setScene] = useState<Scene>("agenda")
  const [tone, setTone] = useState<Tone>("cercano")
  const [emoji, setEmoji] = useState(false)
  // En el servidor, la conversación completa: sin JavaScript o con movimiento reducido se lee entera.
  const [step, setStep] = useState(LAST)
  const timer = useRef<number | null>(null)
  const reduce = useRef(false)

  const play = (next: Scene) => {
    if (timer.current) window.clearInterval(timer.current)
    setScene(next)
    if (reduce.current) {
      setStep(LAST)
      return
    }
    setStep(0)
    timer.current = window.setInterval(() => {
      setStep((s) => {
        if (s + 1 >= LAST && timer.current) window.clearInterval(timer.current)
        return Math.min(s + 1, LAST)
      })
    }, STEP_MS)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: arranca una sola vez al montar
  useEffect(() => {
    reduce.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    if (!reduce.current) play("agenda")
    return () => {
      if (timer.current) window.clearInterval(timer.current)
    }
  }, [])

  const t = TEXTS[scene][tone]
  const script: { kind: Kind; text: string; meta: string }[] =
    scene === "agenda"
      ? [
          { kind: "in", text: "Buenas noches. Tengo fiebre y me duele la garganta desde el miércoles. ¿La doctora me puede ver mañana?", meta: "22:40" },
          { kind: "out", text: t[0], meta: "22:40" },
          { kind: "in", text: "A las 9, por favor.", meta: "22:41" },
          // «Pocos» emojis: uno como mucho, y solo en la confirmación.
          { kind: "out", text: emoji ? `${t[1]} 🙂` : t[1], meta: "22:41" },
          { kind: "card", text: "Agenda · sábado 25 · 09:00 · Dra. Vela · Sala 1", meta: "reservada · 22:41" },
        ]
      : [
          { kind: "in", text: "Hola, estoy embarazada de 30 semanas y estoy sangrando. ¿Qué hago?", meta: "22:40" },
          { kind: "out", text: t[0], meta: "22:40" },
          { kind: "band", text: "Te lo pasó el agente · Ahora", meta: "Posible urgencia: embarazada con sangrado. Sofi le dio el 106 y el teléfono del consultorio." },
          { kind: "in", text: "Ya salgo para la emergencia. Gracias.", meta: "22:42" },
        ]

  let at = 0
  const messages = script.map((m) => {
    const start = at
    at += m.kind === "out" ? 2 : 1
    return { ...m, start, visible: step >= start, typing: m.kind === "out" && step === start }
  })

  return (
    <div className="lsc">
      <div className="lsc-top">
        <AgentHead
          agent="sofi"
          name="Sofi · Consultorio San Martín"
          meta="WhatsApp · viernes 22:40 · cerrado"
          state={step < LAST ? "Escribiendo…" : scene === "agenda" ? "Cita agendada" : "Avisó al equipo"}
          live={step < LAST}
          done={step >= LAST}
        />
      </div>
      <div className="lsc-controls">
        <fieldset className="lsc-scenes" aria-label="Escena">
          {SCENES.map(([id, label]) => (
            <button key={id} type="button" className="lsc-scene" aria-pressed={scene === id} onClick={() => play(id)}>
              {label}
            </button>
          ))}
        </fieldset>
        <div className="lsc-right">
          <fieldset className="lsc-tones" aria-label="Tono">
            {TONES.map(([id, label]) => (
              <button key={id} type="button" className="lsc-tone" aria-pressed={tone === id} onClick={() => setTone(id)}>
                {label}
              </button>
            ))}
          </fieldset>
          <button type="button" className="lsc-emoji" aria-pressed={emoji} onClick={() => setEmoji(!emoji)}>
            <span className="lsc-switch" aria-hidden="true">
              <span />
            </span>
            Emojis
          </button>
        </div>
      </div>
      <div className="lsc-chat" aria-live="polite">
        <span className="lsc-day">HOY</span>
        {messages.map((m) => (
          <div
            key={`${scene}-${m.start}`}
            className={`lsc-msg ${m.visible ? "on" : "off"}`}
            data-kind={m.kind}
            aria-hidden={m.visible ? undefined : true}
          >
            {m.typing ? (
              <span className="lsc-dots" role="img" aria-label="Sofi está escribiendo">
                <i />
                <i />
                <i />
              </span>
            ) : (
              <>
                <span className="lsc-text">{m.text}</span>
                <span className="lsc-time">{m.meta}</span>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="lsc-note">
        <AgentFoot
          note={
            scene === "urgencia"
              ? "En una alarma no ofrece cita ni emojis: primero, el 106."
              : "Datos de ejemplo. Cambia escena, tono y emojis."
          }
          replay="Volver a ver"
          onReplay={() => play(scene)}
        />
      </div>
    </div>
  )
}
