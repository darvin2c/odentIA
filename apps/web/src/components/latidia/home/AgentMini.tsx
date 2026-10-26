// La mini demo de cada agente de latidIA (lienzo «Inicio», sección 3; también en /agentes): un caso
// corto en tres tiempos que se repite. Sofi reconoce la señal de alarma de Julia, Clío propone el
// control que dicta la doctora y Argos le reserva a Luis su control de presión.
import { VoiceBubble } from "../../agents/frame/AgentFrame"
import { useLoop } from "./loop"
import "./agent-mini.css"

export type MiniAgent = "sofi" | "clio" | "argos"

interface Props {
  agent: MiniAgent
}

export default function AgentMini({ agent }: Props) {
  const { step } = useLoop({ len: 4, hold: 4, ms: 1700 })
  const on = (from: number) => (step >= from ? " on" : "")

  if (agent === "sofi")
    return (
      <div className="am sofi">
        <span className="am-meta">Julia Ramos · WhatsApp · 21:05</span>
        <div className="am-in on">Estoy embarazada de 12 semanas y estoy sangrando.</div>
        <div className={`am-out${on(1)}`}>
          Julia, esto puede ser una urgencia. Llama ahora al <b>106</b> o ve a la emergencia más cercana. También puedes llamar al consultorio. Ya avisé al
          equipo.
        </div>
        <div className={`am-chip alarm${on(2)}`}>
          <span aria-hidden="true">⚑</span>
          <span>
            <b>Aviso al equipo</b> · señal de alarma · Julia Ramos Vega
          </span>
        </div>
      </div>
    )

  if (agent === "clio")
    return (
      <div className="am clio">
        <span className="am-meta">Clío · consulta de Rosa</span>
        {/* El mismo globo de voz de las páginas de Clío: se ve que la doctora le está hablando. */}
        <VoiceBubble initials="EV" who="Dra. Vela" text="Control en una semana." speaking={step === 0} idle="dictó" />
        <div className={`am-sugg${on(1)}`}>
          <span>
            <b>Plan y controles</b>
            <span>Control en 7 días · con la Dra. Vela</span>
          </span>
          <span className="am-btn">Confirmar</span>
        </div>
        <div className={`am-chip ok${on(2)}`}>
          <span aria-hidden="true">✓</span>
          <span>
            <b>Confirmado</b> · Argos la invitará a tiempo
          </span>
        </div>
      </div>
    )

  return (
    <div className="am argos">
      <span className="am-meta">Luis Gómez · control cada 3 meses</span>
      <div className="am-out on">
        Hola, Luis. Le toca su control de presión con la Dra. Vela. ¿Le reservo el martes a las 10:00? Traiga el registro de presión de su casa.
      </div>
      <div className={`am-in${on(1)}`}>Sí, el martes está bien.</div>
      <div className={`am-chip booked${on(2)}`}>
        <span aria-hidden="true">✓</span>
        <span>
          <b>Reservado</b> · martes 10:00 · Sala 2
        </span>
      </div>
    </div>
  )
}
