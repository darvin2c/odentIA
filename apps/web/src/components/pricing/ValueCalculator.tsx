// «Lo que pagas y lo que recuperas»: la clínica pone sus números y compara lo que hoy pierde
// sin agentes con su cuenta del mes en odentIA. Es un ejemplo, nunca una promesa de resultados.
import { type ChangeEvent, useEffect, useId, useState } from "react"
import { usd, type ValuePrices } from "../../lib/pricing"
import { computeValue, DEFAULT_VALUE_INPUT, sizeOf, type ValueInput } from "../../lib/value"
import SizePicker from "../SizePicker"
import "./value-calculator.css"

type Key = keyof ValueInput

export default function ValueCalculator({ prices }: { prices: ValuePrices }) {
  const { plan: PLAN, conversation: CONVERSATION, consultation: CONSULTATION, recovered: RECOVERED } = prices
  const [v, setV] = useState<ValueInput>(DEFAULT_VALUE_INPUT)
  const [narrow, setNarrow] = useState(false)
  // Prefijo único para asociar cada etiqueta con su campo (htmlFor/id).
  const uid = useId()
  const fieldId = (k: Key) => `${uid}-${k}`

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 720px)")
    const sync = () => setNarrow(mq.matches)
    sync()
    mq.addEventListener("change", sync)
    return () => mq.removeEventListener("change", sync)
  }, [])

  const set = (k: Key, max: number) => (e: ChangeEvent<HTMLInputElement>) => {
    const n = Math.max(0, Math.min(max, Math.round(Number(e.target.value) || 0)))
    setV((prev) => ({ ...prev, [k]: n }))
  }

  const r = computeValue(v, prices)
  const top = Math.max(r.withoutUs, r.withUs, 1)
  const sinPct = `${((r.withoutUs / top) * 100).toFixed(1)}%`
  const conPct = `${Math.max(2, (r.withUs / top) * 100).toFixed(1)}%`

  // En el teléfono, las filas se dicen más corto (como en el tablero de teléfono).
  const L = narrow
    ? {
        lNew: `${r.lost} pacientes que escribieron y se fueron`,
        lNoShow: `${r.recovered} que faltaron y no volvieron`,
        lTime: `${v.teamHours} horas de tu equipo`,
        lConv: `${v.writers} conversaciones × ${usd(CONVERSATION)}`,
        lRec: `${r.recovered} citas recuperadas × ${usd(RECOVERED)}`,
        lCons: `${v.consultations} consultas × ${usd(CONSULTATION)}`,
        bill: "Tu mes, más impuestos",
        tryIt: "Prueba con tus números",
      }
    : {
        lNew: `${r.lost} pacientes que escribieron, no recibieron respuesta a tiempo y se fueron`,
        lNoShow: `${r.recovered} pacientes que faltaron y nadie les ofreció otra cita`,
        lTime: `${v.teamHours} horas de tu equipo en mensajes y notas`,
        lConv: `${v.writers} conversaciones atendidas × ${usd(CONVERSATION)}`,
        lRec: `${r.recovered} citas recuperadas × ${usd(RECOVERED)}, solo si asisten`,
        lCons: `${v.consultations} consultas confirmadas × ${usd(CONSULTATION)}`,
        bill: "Tu mes, más los impuestos de tu país",
        tryIt: "Prueba con los números de tu clínica",
      }

  const num = (k: Key, max: number) => (
    <input
      id={fieldId(k)}
      type="number"
      className="vc-num"
      inputMode="numeric"
      min={0}
      max={max}
      value={v[k]}
      onChange={set(k, max)}
    />
  )
  const range = (k: Key, max: number, step: number, label: string) => (
    <input
      type="range"
      className="vc-range"
      min={0}
      max={max}
      step={step}
      value={v[k]}
      onChange={set(k, max)}
      aria-label={label}
    />
  )

  return (
    <div className="vc">
      <div className="vc-grid">
        <div className="vc-in">
          <span className="tag tag-d">Tu clínica, en un mes</span>
          <SizePicker current={sizeOf(v)} onPick={setV} />
          <label className="vc-l" htmlFor={fieldId("writers")}>
            <span>Personas que te escriben</span>
            {num("writers", 5000)}
          </label>
          {range("writers", 2000, 10, "Personas que te escriben al mes")}
          <label className="vc-l" htmlFor={fieldId("noShows")}>
            <span>Pacientes que faltaron a su cita en el mes</span>
            {num("noShows", 1000)}
          </label>
          {range("noShows", 300, 5, "Pacientes que faltaron a su cita en el mes")}
          <label className="vc-l" htmlFor={fieldId("consultations")}>
            <span>Consultas que dictarías</span>
            {num("consultations", 5000)}
          </label>
          {range("consultations", 2000, 10, "Consultas que dictarías al mes")}
          <label className="vc-l" htmlFor={fieldId("appointmentValue")}>
            <span>
              Lo que cobra tu clínica por una cita, en promedio, en dólares
              <small>Si no lo sabes: lo facturado en el mes entre las citas atendidas.</small>
            </span>
            {num("appointmentValue", 2000)}
          </label>
          <details className="vc-sup">
            <summary>Ajustar los supuestos</summary>
            <label className="vc-l" htmlFor={fieldId("unansweredPct")}>
              <span>De quienes te escriben, % que hoy no recibe respuesta a tiempo</span>
              {num("unansweredPct", 100)}
            </label>
            <label className="vc-l" htmlFor={fieldId("leavePct")}>
              <span>De esos, % que se va a otra clínica</span>
              {num("leavePct", 100)}
            </label>
            <label className="vc-l" htmlFor={fieldId("returnPct")}>
              <span>De quienes faltaron, % que vuelve a reservar si alguien le escribe</span>
              {num("returnPct", 100)}
            </label>
            <label className="vc-l" htmlFor={fieldId("teamHours")}>
              <span>Horas de tu equipo al mes en mensajes y notas</span>
              {num("teamHours", 1000)}
            </label>
            <label className="vc-l" htmlFor={fieldId("hourCost")}>
              <span>Lo que cuesta una hora de tu equipo, en dólares</span>
              {num("hourCost", 200)}
            </label>
          </details>
        </div>
        <div className="vc-col">
          <span className="tag vc-amber">Sin odentIA, cada mes</span>
          <div className="vc-row">
            <span>{L.lNew}</span>
            <strong>{usd(r.lostNew)}</strong>
          </div>
          <div className="vc-row">
            <span>{L.lNoShow}</span>
            <strong>{usd(r.lostNoShows)}</strong>
          </div>
          <div className="vc-row">
            <span>{L.lTime}</span>
            <strong>{usd(r.lostTime)}</strong>
          </div>
        </div>
        <div className="vc-col vc-us">
          <span className="tag tag-d">Con odentIA, tu cuenta del mes</span>
          <div className="vc-row">
            <span>{L.lConv}</span>
            <strong>{usd(r.conversations)}</strong>
          </div>
          <div className="vc-row">
            <span>{L.lRec}</span>
            <strong>{usd(r.recoveredCost)}</strong>
          </div>
          <div className="vc-row">
            <span>{L.lCons}</span>
            <strong>{usd(r.consultations)}</strong>
          </div>
          <div className="vc-row vc-sub">
            <span>Plan odentIA</span>
            <strong>{usd(PLAN)}</strong>
          </div>
          <div className="vc-row vc-sub">
            <span>Crédito del plan</span>
            <strong>− {usd(r.coveredByPlan)}</strong>
          </div>
          <div className="vc-bill">
            <span>{L.bill}</span>
            <strong className="mono">{usd(r.withUs)}</strong>
          </div>
        </div>
      </div>
      <div className="vc-res">
        <div className="vc-left">
          <div className="vc-bar">
            <div className="vc-bl">
              <span>Sin odentIA pierdes, cada mes</span>
              <strong className="vc-big vc-amber">{usd(r.withoutUs)}</strong>
            </div>
            <div className="vc-track">
              <span className="vc-fill" style={{ width: sinPct, background: "#f5c46b" }} />
            </div>
          </div>
          <div className="vc-bar">
            <div className="vc-bl">
              <span>Con odentIA pagas, cada mes</span>
              <strong className="vc-big vc-sky">{usd(r.withUs)}</strong>
            </div>
            <div className="vc-track">
              <span className="vc-fill" style={{ width: conPct, background: "#4fc3d7" }} />
            </div>
          </div>
          <div className="vc-diff">
            <span>{r.worthIt ? "A tu favor, cada mes" : L.tryIt}</span>
            <strong>{r.worthIt ? usd(r.inFavor) : "—"}</strong>
          </div>
        </div>
        <div className="vc-ratio" aria-live="polite">
          <span className="vc-rt">Recuperas</span>
          <strong>
            <span className="vc-cur">{r.worthIt ? "USD" : ""}</span>
            <span className="vc-n">{r.worthIt ? r.ratio.toFixed(1).replace(".", ",") : "—"}</span>
          </strong>
          <span className="vc-rl">
            {r.worthIt ? "por cada dólar que pagas" : "con estos números todavía no conviene"}
          </span>
        </div>
        <span className="mono vc-note">
          Ejemplo con números de prueba: pon los de tu clínica. No es una promesa de resultados.
        </span>
      </div>
    </div>
  )
}
