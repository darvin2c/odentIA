// «Tu cuenta · jueves» (portada de Precios): el día se llena fila por fila y el total sube.
// Cada fila se cobra por su tipo con los precios del plan que se muestra (ADR 0085); lo que no es
// trabajo de un agente dice 0. Con «reducir movimiento», el día se ve completo desde el principio.
import { useEffect, useRef, useState } from "react"
import type { ValuePrices } from "../../lib/pricing"
import { MEDICAL } from "../../lib/product"
import "./work-day-ledger.css"

type Agent = "sofi" | "clio" | "argos" | null
/** Qué se cobra en cada fila: un tipo, la cita recuperada, la conversación que se devuelve o nada. */
type Charge = "gestiona" | "estandar" | "recovered" | "refund" | null
type Row = { time: string; agent: Agent; who: string; what: string; charge: Charge }

const NAMES: Record<Exclude<Agent, null>, string> = { sofi: "Sofi", clio: "Clío", argos: "Argos" }

/** Un jueves de ejemplo. En latidIA cambia lo que se dice, no lo que se cobra. */
const DAY: Row[] = [
  {
    time: "08:12",
    agent: "sofi",
    who: "Sofi",
    what: MEDICAL ? " agendó a Miguel, con fiebre desde ayer" : " agendó a Miguel por un dolor de muela",
    charge: "gestiona",
  },
  {
    time: "09:40",
    agent: "clio",
    who: "Clío",
    what: MEDICAL ? " ordenó la consulta de Carlos: faringitis con placas" : " ordenó la consulta de Carlos: caries en la 36",
    charge: "estandar",
  },
  { time: "11:05", agent: "clio", who: "Clío", what: ": el Dr. Ríos descartó el borrador", charge: null },
  { time: "16:20", agent: "sofi", who: "Sofi", what: " reservó a Pedro; Pedro no vino", charge: "gestiona" },
  { time: "17:00", agent: "argos", who: "Argos", what: ": Rosa volvió tras faltar y la atendieron", charge: "recovered" },
  // ADR 0085: si la cita recuperada cuenta, se cobra solo ella y la conversación se devuelve.
  { time: "17:00", agent: null, who: "", what: "Se devuelve la conversación de Rosa: cuenta la cita", charge: "refund" },
]

/** Una fila cada segundo y medio. */
const STEP_MS = 1500

/** «0,25», «−0,25», «1,00». */
const fig = (value: number) => `${value < 0 ? "−" : ""}${Math.abs(value).toFixed(2).replace(".", ",")}`

export default function WorkDayLedger({
  prices,
  currency,
  note,
}: {
  prices: ValuePrices
  currency: string
  /** «Ejemplo con precios de Fundadores.» o el del plan de lista. */
  note: string
}) {
  const cost = (charge: Charge) =>
    charge === "recovered"
      ? prices.recovered
      : charge === "refund"
        ? -prices.tiers.gestiona
        : charge
          ? prices.tiers[charge]
          : 0
  // En el servidor y sin JavaScript, el día completo; al cargar, empieza a llenarse.
  const [shown, setShown] = useState(DAY.length)
  const [reduced, setReduced] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const play = () => {
    if (timer.current) clearInterval(timer.current)
    setShown(0)
    timer.current = setInterval(() => {
      setShown((n) => {
        if (n + 1 >= DAY.length && timer.current) clearInterval(timer.current)
        return Math.min(DAY.length, n + 1)
      })
    }, STEP_MS)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: arranca una sola vez, al cargar.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(mq.matches)
    if (!mq.matches) play()
    const onChange = () => {
      setReduced(mq.matches)
      if (mq.matches) {
        if (timer.current) clearInterval(timer.current)
        setShown(DAY.length)
      }
    }
    mq.addEventListener("change", onChange)
    return () => {
      mq.removeEventListener("change", onChange)
      if (timer.current) clearInterval(timer.current)
    }
  }, [])

  const total = DAY.slice(0, shown).reduce((sum, row) => sum + cost(row.charge), 0)

  return (
    <div className="wd">
      <div className="wd-head">
        <span className="wd-title">Tu cuenta · jueves</span>
        <span className="wd-total">
          {currency} {fig(total)}
        </span>
      </div>
      <ol className="wd-rows">
        {DAY.map((row, i) => {
          const value = cost(row.charge)
          return (
            <li
              key={`${row.time}-${row.what}`}
              className={`wd-row${i < shown ? " wd-on" : ""}${i === shown - 1 && !reduced ? " wd-new" : ""}`}
            >
              <span className="wd-time">{row.time}</span>
              <span>
                {row.agent ? <b className={`wd-${row.agent}`}>{NAMES[row.agent]}</b> : null}
                {row.what}
              </span>
              <span className={value === 0 ? "wd-price wd-free" : "wd-price"}>{value === 0 ? "0" : fig(value)}</span>
            </li>
          )
        })}
      </ol>
      <div className="wd-foot">
        <span>{note}</span>
        {reduced ? null : (
          <button type="button" className="wd-replay" onClick={play}>
            Repetir el día
          </button>
        )}
      </div>
    </div>
  )
}
