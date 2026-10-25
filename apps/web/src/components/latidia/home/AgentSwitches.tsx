// «Tú decides» de latidIA (lienzo «Inicio», sección 6; también en /agentes): cada interruptor dice
// qué pasa prendido y qué pasa apagado. Son los mismos de la configuración del consultorio; aquí
// solo se prueban, no se guarda nada.
import { useState } from "react"
import "./agent-switches.css"

const SWITCHES = [
  {
    id: "agendar",
    agent: "Sofi",
    tone: "sofi",
    label: "Agendar citas",
    on: "Agenda en los horarios libres de cada médico, con el sí del paciente.",
    off: "Envía su enlace para que la persona elija la hora.",
  },
  {
    id: "controles",
    agent: "Argos",
    tone: "argos",
    label: "Avisar los controles",
    on: "Escribe antes de que toque el control, como a Luis cada 3 meses.",
    off: "Te deja la lista y tu equipo decide a quién llamar.",
  },
  {
    id: "volver",
    agent: "Argos",
    tone: "argos",
    label: "Invitar a volver",
    on: "Escribe a quien lleva 12 meses sin venir. Si no puede escribirle, te deja una tarea de llamada.",
    off: "Nadie recibe la invitación.",
  },
  {
    id: "otro",
    agent: "Argos",
    tone: "argos",
    label: "Ofrecer otro horario",
    on: "A quien faltó o canceló, le ofrece otra hora.",
    off: "Quien faltó espera a que tu equipo lo llame.",
  },
]

export default function AgentSwitches() {
  const [state, setState] = useState<Record<string, boolean>>({ agendar: true, controles: true, volver: true, otro: false })
  return (
    <div className="asw">
      {SWITCHES.map((sw) => {
        const on = !!state[sw.id]
        return (
          <button
            key={sw.id}
            type="button"
            role="switch"
            aria-checked={on}
            className={`asw-row${on ? " on" : ""}`}
            onClick={() => setState({ ...state, [sw.id]: !on })}
          >
            <span className="asw-copy">
              <span className={`asw-agent ${sw.tone}`}>{sw.agent}</span>
              <b>{sw.label}</b>
              <span className="asw-desc">{on ? sw.on : sw.off}</span>
            </span>
            <span className="asw-track" aria-hidden="true">
              <i></i>
            </span>
          </button>
        )
      })}
    </div>
  )
}
