// 04 · El control: cada tarea de los agentes se prende o se apaga, y dice qué pasa en cada caso.
import { useState } from "react"

const SW = [
  {
    id: "responder",
    agent: "Recepción",
    label: "Responder mensajes",
    on: "Responde al momento, de día y de noche.",
    off: "Los mensajes esperan a que alguien de tu equipo los vea.",
    phone: true,
  },
  {
    id: "agendar",
    agent: "Recepción",
    label: "Agendar citas",
    on: "Agenda en los horarios libres de quien atiende ese servicio, con el sí del paciente.",
    off: "Envía su enlace para que la persona elija la hora.",
    phone: false,
  },
  {
    id: "recordar",
    agent: "Administrador",
    label: "Recordar la cita",
    on: "Un día antes y tres horas antes. Viene prendido.",
    off: "Nadie recibe recordatorio.",
    phone: true,
  },
  {
    id: "recuperar",
    agent: "Administrador",
    label: "Avisar los controles",
    on: "Escribe a quien ya le toca su control.",
    off: "Te deja la lista y tu equipo decide a quién llamar.",
    phone: false,
  },
  {
    id: "presupuestos",
    agent: "Administrador",
    label: "Retomar los presupuestos",
    on: "Pregunta por los presupuestos que quedaron sin respuesta.",
    off: "Los presupuestos esperan a tu equipo.",
    phone: true,
  },
]

export default function Switches() {
  const [sw, setSw] = useState<Record<string, boolean>>({
    responder: true,
    agendar: true,
    recordar: true,
    recuperar: true,
    presupuestos: false,
  })
  return (
    <div className="sws">
      {SW.map((w) => {
        const on = !!sw[w.id]
        return (
          <button
            key={w.id}
            type="button"
            role="switch"
            aria-checked={on}
            className={"sw" + (on ? " on" : "") + (w.phone ? "" : " d-only")}
            onClick={() => setSw({ ...sw, [w.id]: !on })}
          >
            <span className="stack swb">
              <span className="mono swa">{w.agent}</span>
              <strong>{w.label}</strong>
              <span className="swd">{on ? w.on : w.off}</span>
            </span>
            <span className="track" aria-hidden="true">
              <i></i>
            </span>
          </button>
        )
      })}
    </div>
  )
}
