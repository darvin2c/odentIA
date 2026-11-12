// «Tú decides» de latidIA (lienzo «Inicio», sección 6; también en /agentes): cada interruptor dice
// qué pasa prendido y qué pasa apagado. Son los mismos de la configuración del consultorio; aquí
// solo se prueban, no se guarda nada. Los nombres son los de la app: «Agendar, mover y cancelar citas»
// (packages/services/src/agent-roles.ts) y las líneas del Administrador (admin-lines.ts).
import { useState } from "react"
import "./agent-switches.css"

const SWITCHES = [
  {
    id: "agendar",
    agent: "Sofi",
    tone: "sofi",
    label: "Agendar, mover y cancelar citas",
    on: "Agenda en los horarios libres de cada médico, con el sí del paciente.",
    off: "No toca la agenda: envía el enlace para que la persona elija la hora.",
  },
  {
    id: "controles",
    agent: "Argos",
    tone: "argos",
    label: "Avisar un control",
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
    label: "Reprogramar tras una inasistencia",
    on: "A quien faltó, le ofrece otra hora.",
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
