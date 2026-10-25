// «Cómo se cobra» en el inicio de latidIA (lienzo «Inicio», sección 7): un jueves del Consultorio
// San Martín, cobro por cobro, y el total del día que se va sumando. Los precios llegan por props
// desde Astro.locals.pricing (la administración); aquí no hay ninguna cifra.
import { money } from "../../../lib/pricing"
import { useLoop } from "./loop"
import "./charge-day.css"

export type ChargeRow = { tone: "sofi" | "clio" | "argos"; what: string; why: string; amount: number }

interface Props {
  rows: ChargeRow[]
  currency: string
  /** Lo que va arriba de la tarjeta: el día y el consultorio. */
  title: string
}

/** «0,25», «1,00»: el monto sin la moneda y siempre con sus dos decimales, como en Precios. */
function cut(value: number, currency: string): string {
  const shown = money(value, currency).replace(`${currency} `, "")
  return shown.includes(",") ? shown : `${shown},00`
}

export default function ChargeDay({ rows, currency, title }: Props) {
  const { step } = useLoop({ len: rows.length + 1, hold: 6, ms: 900 })
  let total = 0
  return (
    <div className="cd2">
      <div className="cd2-head">
        <b>{title}</b>
        <span>{currency}</span>
      </div>
      <ul className="cd2-rows">
        {rows.map((row, i) => {
          const on = step >= i + 1
          if (on) total += row.amount
          return (
            <li key={row.what} className={`cd2-row${on ? " on" : ""}`}>
              <span className={`cd2-dot ${row.tone}`} aria-hidden="true"></span>
              <span className="cd2-what">
                <b>{row.what}</b>
                <span>{row.why}</span>
              </span>
              <b className={`cd2-amt${row.amount === 0 ? " zero" : ""}`}>{cut(row.amount, currency)}</b>
            </li>
          )
        })}
      </ul>
      <div className="cd2-total">
        <b>Total del día</b>
        <b className="cd2-sum">
          {currency} {cut(total, currency)}
        </b>
      </div>
    </div>
  )
}
