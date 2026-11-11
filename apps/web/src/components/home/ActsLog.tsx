// «Actúan, no solo conversan»: registro de lo que los agentes cambian en el sistema (ejemplo).
// Cada pocos segundos entra una acción nueva arriba; en teléfono se ven cuatro. Da dos vueltas por las
// ocho acciones y se queda quieto, como llegó del servidor (WCAG 2.2.2).
import { type CSSProperties, useState } from "react"
import { useSteadyHeight } from "../../lib/steady"
import { useInterval, useMoving } from "./motion"

const ACTS = [
  { t: "23:41", a: 0, verb: "Agendó", obj: "la cita de Andrea para el jueves", where: "Agenda" },
  { t: "07:00", a: 2, verb: "Recordó", obj: "las 18 citas del día", where: "WhatsApp" },
  {
    t: "08:15",
    a: 0,
    verb: "Movió",
    obj: "la cita de Lucía al viernes y avisó a su mamá",
    where: "Agenda",
  },
  {
    t: "09:41",
    a: 1,
    verb: "Escribió",
    obj: "la nota de Carlos, que la doctora confirmó",
    where: "Historia",
  },
  {
    t: "09:42",
    a: 1,
    verb: "Propuso",
    obj: "el diagnóstico K02.1 y la resina del tarifario",
    where: "Historia",
  },
  {
    t: "13:21",
    a: 0,
    verb: "Reenvió",
    obj: "el presupuesto de ortodoncia a Jorge",
    where: "Presupuestos",
  },
  {
    t: "16:05",
    a: 2,
    verb: "Retomó",
    obj: "el presupuesto que Rosa no había respondido",
    where: "Presupuestos",
  },
  {
    t: "16:30",
    a: 2,
    verb: "Dejó una tarea",
    obj: "a recepción: llamar a Pedro, que no tiene WhatsApp",
    where: "Tareas",
  },
]
const ACOL = ["#0e7490", "#1f9d7a", "#c98a1c"]
/** Vueltas por las ocho acciones antes de quedarse quieto. */
const ROUNDS = 2

export default function ActsLog() {
  const steady = useSteadyHeight<HTMLOListElement>()
  const moving = useMoving()
  // Cuántas acciones entraron; la de arriba es la `al % 8`. Al terminar sus vueltas vuelve a la primera.
  const [al, setAl] = useState(0)
  useInterval(() => {
    if (moving && al < ROUNDS * ACTS.length) setAl(al + 1)
  }, 2300)

  return (
    <ol className="acts" aria-live="polite" ref={steady}>
      {Array.from({ length: 5 }, (_, k) => {
        const x = ACTS[(al - k + ACTS.length * 4) % ACTS.length]
        return (
          <li
            key={x.t + x.verb}
            className={k === 0 ? (al % 2 ? "act new" : "act new2") : "act"}
            style={{ "--c": ACOL[x.a] } as CSSProperties}
          >
            <span className="mono at">{x.t}</span>
            <i aria-hidden="true"></i>
            {/* Cada fila mide lo que la acción más larga: al entrar una nueva, la lista no cambia de alto. */}
            <span className="fit">
              {ACTS.map((ghost) => (
                <span key={ghost.t + ghost.verb} className="atxt fit-ghost" aria-hidden="true">
                  <strong>{ghost.verb}</strong> {ghost.obj}
                  <span className="where where-m">{ghost.where}</span>
                </span>
              ))}
              <span className="atxt">
                <strong>{x.verb}</strong> {x.obj}
                <span className="where where-m">{x.where}</span>
              </span>
            </span>
            <span className="where where-d">{x.where}</span>
          </li>
        )
      })}
    </ol>
  )
}
