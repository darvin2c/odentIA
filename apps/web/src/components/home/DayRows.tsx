// 05 · «Así se ve un día en tu cuenta»: cada cosa que hicieron los agentes, fila por fila, con su precio.
import { useState } from "react"
import { CONSULTATION, CONVERSATION, RECOVERED, usd } from "../../lib/pricing"
import { prefersReducedMotion, useInterval, useMoving } from "./motion"

const DAY = [
  {
    time: "07:00",
    agent: "Administrador",
    what: "Recordó las 18 citas del día.",
    why: "Los recordatorios no se cobran.",
    price: 0,
  },
  {
    time: "08:12",
    agent: "Recepción",
    what: "Miguel escribió por un dolor de muela y quedó agendado a las 10:30.",
    why: "Una conversación: todo lo que habló con Miguel en 24 horas.",
    price: CONVERSATION,
  },
  {
    time: "09:40",
    agent: "Asistente clínico",
    what: "La Dra. Paredes dictó la consulta de Carlos y confirmó la nota.",
    why: "Se cobra cuando la doctora confirma.",
    price: CONSULTATION,
  },
  {
    time: "11:05",
    agent: "Asistente clínico",
    what: "El Dr. Ríos dictó la consulta de Miguel y prefirió escribir la nota él.",
    why: "El borrador descartado no se cobra.",
    price: 0,
  },
  {
    time: "13:20",
    agent: "Recepción",
    what: "Jorge preguntó cuánto cuesta la ortodoncia, recibió el precio y agendó su evaluación.",
    why: "Una conversación.",
    price: CONVERSATION,
  },
  {
    time: "16:05",
    agent: "Administrador",
    what: "Rosa tenía su control vencido. Le escribió y Rosa reservó el viernes desde su enlace.",
    why: "La cita recuperada se cobra solo si Rosa asiste.",
    price: 0,
    pending: true,
  },
  {
    time: "22:47",
    agent: "Recepción",
    what: "Alguien preguntó si atienden los sábados y recibió el horario.",
    why: "Una conversación, aunque no termine en cita.",
    price: CONVERSATION,
  },
]

export default function DayRows() {
  const moving = useMoving()
  const [day, setDay] = useState(7)
  useInterval(() => {
    if (moving && day < 7) setDay(day + 1)
  }, 1150)

  let total = 0
  const rows = DAY.map((r, i) => {
    const on = i < day
    if (on) total += r.price
    return { ...r, cls: on ? (i === day - 1 && day < 7 ? "drow on last" : "drow on") : "drow" }
  })

  return (
    <>
      <div className="dayhead">
        <div className="stack dayhead-t">
          <h3 className="h3d">Así se ve un día en tu cuenta.</h3>
          <p className="lead lead-d">
            Cada cosa que hacen tus agentes aparece con su precio. Lo que no dio resultado no se
            cobra.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-p"
          onClick={() => setDay(prefersReducedMotion() ? 7 : 0)}
        >
          Reproducir el día
        </button>
      </div>
      <div className="days">
        {rows.map((r) => (
          <div key={r.time} className={r.cls}>
            <span className="mono dtime">{r.time}</span>
            <span className="dagent">{r.agent}</span>
            <span className="dwhat">
              <span>{r.what}</span>
              <span className="dwhy">{r.why}</span>
            </span>
            <span className={r.price > 0 ? "price price-l dprice" : "price price-0 dprice"}>
              {r.pending ? `${usd(RECOVERED)} si asiste` : usd(r.price)}
            </span>
          </div>
        ))}
        <div className="dayfoot">
          <span>Ejemplo de un jueves en una clínica de 4 odontólogos.</span>
          <span className="daytot">
            <span>Total del día</span>
            <strong className="mono">{usd(total)}</strong>
            <span className="mono dpend">
              {day >= 6 ? `+ ${usd(RECOVERED)} el viernes, si Rosa asiste` : ""}
            </span>
          </span>
        </div>
      </div>
    </>
  )
}
