// 05 · «Así se ve un día en tu cuenta»: cada cosa que hicieron los agentes, fila por fila, con su precio.
import { useState } from "react"
import { usd, type ValuePrices } from "../../lib/pricing"
import { prefersReducedMotion, useInterval, useMoving } from "./motion"

const DAY = [
  {
    time: "07:00",
    agent: "Argos",
    what: "Recordó las 18 citas del día.",
    why: "Los recordatorios no se cobran.",
    price: null,
  },
  {
    time: "08:12",
    agent: "Sofi",
    what: "Miguel escribió por un dolor de muela y quedó agendado a las 10:30.",
    why: "Una conversación: todo lo que habló con Miguel en 24 horas.",
    price: "conversation" as const,
  },
  {
    time: "09:40",
    agent: "Clío",
    what: "La Dra. Paredes dictó la consulta de Carlos y confirmó la nota.",
    why: "Se cobra cuando la doctora confirma.",
    price: "consultation" as const,
  },
  {
    time: "11:05",
    agent: "Clío",
    what: "El Dr. Ríos dictó la consulta de Miguel y prefirió escribir la nota él.",
    why: "El borrador descartado no se cobra.",
    price: null,
  },
  {
    time: "13:20",
    agent: "Sofi",
    what: "Jorge preguntó cuánto cuesta la ortodoncia, recibió el precio y agendó su evaluación.",
    why: "Una conversación.",
    price: "conversation" as const,
  },
  {
    time: "16:05",
    agent: "Argos",
    what: "Rosa faltó ayer a su cita. Le ofreció otro horario y Rosa reservó el viernes con Sofi.",
    why: "La cita recuperada se cobra solo si Rosa asiste.",
    price: null,
    pending: true,
  },
  {
    time: "22:47",
    agent: "Sofi",
    what: "Alguien preguntó si atienden los sábados y recibió el horario.",
    why: "Una conversación, aunque no termine en cita.",
    price: "conversation" as const,
  },
]

export default function DayRows({ prices }: { prices: ValuePrices }) {
  const cost = (key: "conversation" | "consultation" | null) => (key ? prices[key] : 0)
  const moving = useMoving()
  const [day, setDay] = useState(7)
  useInterval(() => {
    if (moving && day < 7) setDay(day + 1)
  }, 1150)

  let total = 0
  const rows = DAY.map((r, i) => {
    const on = i < day
    if (on) total += cost(r.price)
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
            <span className={cost(r.price) > 0 ? "price price-l dprice" : "price price-0 dprice"}>
              {r.pending ? `${usd(prices.recovered)} si asiste` : usd(cost(r.price))}
            </span>
          </div>
        ))}
        <div className="dayfoot">
          <span>Ejemplo de un jueves en una clínica de 4 odontólogos.</span>
          <span className="daytot">
            <span>Total del día</span>
            <strong className="mono">{usd(total)}</strong>
            <span className="mono dpend">
              {day >= 6 ? `+ ${usd(prices.recovered)} el viernes, si Rosa asiste` : ""}
            </span>
          </span>
        </div>
      </div>
    </>
  )
}
