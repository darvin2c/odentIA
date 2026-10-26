// 05 · «Así se ve un día en tu cuenta»: cada cosa que hicieron los agentes, fila por fila, con el precio de su tipo (ADR 0085).
import { useState } from "react"
import { hours, usd, type ValuePrices } from "../../lib/pricing"
import { prefersReducedMotion, useInterval, useMoving } from "./motion"

const DAY = [
  {
    // El horario de recontacto por defecto empieza a las 8:00 (ADR 0084).
    time: "08:00",
    agent: "Argos",
    what: "Recordó las 18 citas del día.",
    why: "Los recordatorios no se cobran.",
    price: null,
  },
  {
    time: "08:12",
    agent: "Sofi",
    what: "Miguel escribió por un dolor de muela y quedó agendado a las 10:30.",
    /** La ventana de las condiciones comerciales: llega de la administración. */
    why: (conversationHours: number) => `Una conversación que gestionó su cita: todo lo que habló con Miguel en ${hours(conversationHours)}.`,
    price: "gestiona" as const,
  },
  {
    time: "09:40",
    agent: "Clío",
    what: "La Dra. Paredes dictó el control de Ana y confirmó la nota.",
    why: "Una consulta simple, una sola parte: se cobra cuando la doctora confirma.",
    price: "simple" as const,
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
    why: "Una conversación que gestionó su cita.",
    price: "gestiona" as const,
  },
  {
    time: "16:05",
    agent: "Argos",
    what: "Rosa faltó ayer a su cita. Le ofreció otro horario y Rosa reservó el viernes con Sofi.",
    // ADR 0085: reservar es «Gestiona»; si Rosa viene, esa conversación se devuelve y se cobra solo la cita recuperada.
    why: "La conversación que gestionó su cita. Si Rosa asiste, se devuelve y se cobra la cita recuperada.",
    price: "gestiona" as const,
  },
  {
    time: "22:47",
    agent: "Sofi",
    what: "Alguien preguntó si atienden los sábados y recibió el horario.",
    why: "Una conversación que solo informa: la más barata.",
    price: "informa" as const,
  },
]

export default function DayRows({ prices, conversationHours }: { prices: ValuePrices; conversationHours: number }) {
  const cost = (key: keyof ValuePrices["tiers"] | null) => (key ? prices.tiers[key] : 0)
  const moving = useMoving()
  const [day, setDay] = useState(7)
  useInterval(() => {
    if (moving && day < 7) setDay(day + 1)
  }, 1150)

  let total = 0
  const rows = DAY.map((r, i) => {
    const on = i < day
    if (on) total += cost(r.price)
    const why = typeof r.why === "function" ? r.why(conversationHours) : r.why
    return { ...r, why, cls: on ? (i === day - 1 && day < 7 ? "drow on last" : "drow on") : "drow" }
  })

  const play = () => setDay(prefersReducedMotion() ? 7 : 0)
  const totalTxt = usd(total)

  // El total va junto al botón que reproduce el día; en teléfono, en una barra pegada abajo
  // mientras se ven las filas. Solo una de las dos se ve a la vez, y esa es la que se anuncia.
  return (
    <div className="dayblk">
      <div className="dayhead">
        <div className="stack dayhead-t">
          <h3 className="h3d">Así se ve un día en tu cuenta.</h3>
          <p className="lead lead-d">
            Cada cosa que hacen tus agentes aparece con su precio. Lo que no dio resultado no se
            cobra.
          </p>
        </div>
        <div className="daynow">
          <span className="daytot">
            <span>Total del día</span>
            <strong className="mono" aria-live="polite">
              {totalTxt}
            </strong>
          </span>
          <button type="button" className="btn btn-p" onClick={play}>
            Reproducir el día
          </button>
        </div>
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
              {usd(cost(r.price))}
            </span>
          </div>
        ))}
        <div className="dayfoot">
          <span>Ejemplo de un jueves en una clínica de 4 odontólogos.</span>
          <span className="mono dpend">
            {day >= 6
              ? `Si Rosa asiste el viernes: + ${usd(prices.recovered)} y se devuelven ${usd(prices.tiers.gestiona)}`
              : ""}
          </span>
        </div>
      </div>
      <div className="daydock">
        <span className="daydock-t">
          <span>Total del día · {day} de 7</span>
          <strong className="mono" aria-live="polite">
            {totalTxt}
          </strong>
        </span>
        <button type="button" className="btn btn-p btn-sm daydock-b" onClick={play}>
          Reproducir el día
        </button>
      </div>
    </div>
  )
}
