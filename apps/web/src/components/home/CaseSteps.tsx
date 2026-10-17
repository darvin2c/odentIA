// 03 · Un caso, de principio a fin: siete pasos, cada uno con su agente y su canal.
// Empieza completo; «Reproducir el caso» lo enciende paso a paso.
import { type CSSProperties, useState } from "react"
import { prefersReducedMotion, useInterval, useMoving } from "./motion"

const CC = ["#0e7490", "#1f9d7a", "#c98a1c"]
const AN = ["Recepción · Sofi", "Asistente clínico", "Administrador"]
const CASE = [
  {
    when: "Lunes 19:10",
    ch: "Instagram",
    a: 0,
    text: "Lucía pregunta cuánto le falta para quitarse los brackets.",
  },
  {
    when: "Lunes 19:11",
    ch: "Instagram",
    a: 0,
    text: "Sofi le confirma su control del martes 28 y se ofrece a recordárselo.",
  },
  {
    when: "Miércoles 08:30",
    ch: "WhatsApp",
    a: 0,
    text: "Carmen, su mamá, pide pasarlo al viernes y Sofi lo mueve.",
  },
  { when: "Jueves 16:00", ch: "Correo", a: 2, text: "Le recuerda a Carmen el control de mañana." },
  {
    when: "Viernes 16:20",
    ch: "Consulta",
    a: 1,
    text: "La Dra. Paredes dicta el control y confirma la nota.",
  },
  {
    when: "Viernes 16:40",
    ch: "Historia",
    a: 1,
    text: "Queda listo el próximo control, en seis meses.",
  },
  {
    when: "Seis meses después",
    ch: "WhatsApp",
    a: 2,
    text: "Le escribe a Carmen, Lucía reserva y vuelve: cita recuperada.",
  },
]

export default function CaseSteps() {
  const moving = useMoving()
  const [cs, setCs] = useState(7)
  useInterval(() => {
    if (moving && cs < 7) setCs(cs + 1)
  }, 1150)

  return (
    <>
      <div className="sr case-head">
        <div className="hs-head">
          <span className="tag">[ 03 · Las dos juntas ]</span>
          <h2 className="h2">Un caso, de principio a fin.</h2>
          <p className="lead">
            Empieza con una pregunta por Instagram y termina con Lucía de vuelta en su control. Cada
            paso dice qué agente lo hizo y por dónde.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-d case-play"
          onClick={() => setCs(prefersReducedMotion() ? 7 : 0)}
        >
          Reproducir el caso
        </button>
      </div>
      <ol className="case">
        {CASE.map((c, i) => (
          <li
            key={c.when}
            className={i < cs ? (i === cs - 1 && cs < 7 ? "cstep on last" : "cstep on") : "cstep"}
            style={{ "--c": CC[c.a] } as CSSProperties}
          >
            <span className="when">
              {c.when}
              <span className="agent-m"> · {AN[c.a]}</span>
            </span>
            <span className="chan">{c.ch}</span>
            <strong>{c.text}</strong>
            <span className="agent">
              <i aria-hidden="true"></i>
              {AN[c.a]}
            </span>
          </li>
        ))}
      </ol>
    </>
  )
}
