// «Lo que pagas y lo que recuperas»: la clínica pone sus números y compara lo que hoy pierde
// sin agentes con su cuenta del mes en odentIA. Es un ejemplo, nunca una promesa de resultados.
// Arriba, la tarjeta del plan (llega como hijo, armada en el servidor) y al lado la cuenta del mes,
// cada fila cobrada por su tipo (ADR 0085); debajo, los números de la clínica y, en la misma pantalla,
// lo que pierde y lo que recupera: al lado en escritorio, en una franja pegada abajo en tableta y teléfono.
import { type ChangeEvent, type ReactNode, useEffect, useId, useState } from "react"
import { usd, type ValuePrices } from "../../lib/pricing"
import { WORDS } from "../../lib/product"
import { computeValue, DEFAULT_VALUE_INPUT, sizeOf, type ValueInput } from "../../lib/value"
import SizePicker from "../SizePicker"
import "./value-calculator.css"

/** «0,25», «1.234,50»: la cifra de la cuenta, siempre con sus centavos y sin la moneda. */
const fig = (value: number) => {
  const [int = "0", dec = "00"] = (Math.round(value * 100) / 100).toFixed(2).split(".")
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`
}

type Key = keyof ValueInput

export default function ValueCalculator({ prices, children }: { prices: ValuePrices; children?: ReactNode }) {
  const { plan: PLAN, credit: CREDIT, recovered: RECOVERED, tiers: T } = prices
  // Sin cuota ni crédito (Fundadores) no hay filas de plan que restar: serían «USD 0» que nadie paga.
  const hasPlan = PLAN > 0 || CREDIT > 0
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
  const ratio = r.ratio.toFixed(1).replace(".", ",")

  // En el teléfono, las filas se dicen más corto (como en el tablero de teléfono).
  const L = narrow
    ? {
        lNew: `${r.lost} pacientes que escribieron y se fueron`,
        lNoShow: `${r.recovered} que faltaron y no volvieron`,
        lTime: `${v.teamHours} horas de tu equipo`,
        tryIt: "Prueba con tus números",
      }
    : {
        lNew: `${r.lost} pacientes que escribieron, no recibieron respuesta a tiempo y se fueron`,
        lNoShow: `${r.recovered} pacientes que faltaron y nadie les ofreció otra cita`,
        lTime: `${v.teamHours} horas de tu equipo en mensajes y notas`,
        tryIt: `Prueba con los números de ${WORDS.yourClinic}`,
      }
  // La cuenta del mes: cada fila por su tipo, como llega en la cuenta de la clínica.
  const b = r.byType
  const bill: Array<{ label: string; value: string; sub?: boolean }> = [
    { label: `${b.informa.count} conversaciones que informan × ${fig(T.informa)}`, value: fig(b.informa.cost) },
    { label: `${b.gestiona.count} que gestionan una cita × ${fig(T.gestiona)}`, value: fig(b.gestiona.cost) },
    { label: `${b.agenda.count} citas que se dieron × ${fig(T.agenda - T.gestiona)} más`, value: fig(b.agenda.cost) },
    { label: `${v.consultations} consultas por su tipo`, value: fig(r.consultations) },
    { label: `${r.recovered} citas recuperadas × ${fig(RECOVERED)}`, value: fig(r.recoveredCost) },
    ...(hasPlan
      ? [
          { label: `Plan ${WORDS.name}`, value: fig(PLAN), sub: true },
          { label: "Crédito del plan", value: `− ${fig(r.coveredByPlan)}`, sub: true },
        ]
      : []),
  ]

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
      <div className="vc-top">
        {children}
        <div className="vc-card" id="calcula">
          <span className="tag">[ Calcula tu mes ]</span>
          <h2 className="vc-h2">Lo que pagas y lo que recuperas.</h2>
          <p className="vc-lead">
            Cada fila se cobra por su tipo, como en tu cuenta. Pon abajo los números de {WORDS.yourClinic} y compara con lo que
            hoy pierdes sin agentes.
          </p>
          <div className="vc-sheet">
            {bill.map((row) => (
              <div key={row.label.replace(/^\d+ /, "")} className={row.sub ? "vc-line vc-line-sub" : "vc-line"}>
                <span>{row.label}</span>
                <b>{row.value}</b>
              </div>
            ))}
            <div className="vc-line vc-line-total">
              <span>Tu mes, más impuestos</span>
              <b>USD {fig(r.withUs)}</b>
            </div>
          </div>
        </div>
      </div>
      <div className="vc-panel">
        <div className="vc-edit">
          <div className="vc-in">
            <span className="tag tag-d">{WORDS.YourClinic}, en un mes</span>
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
                Lo que cobra {WORDS.yourClinic} por una cita, en promedio, en dólares
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
                <span>De esos, % que se va a {WORDS.anotherClinic}</span>
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
          {/* Tableta y teléfono: el resumen queda pegado abajo mientras se editan los números y termina
              con ellos. Lo anuncia el resultado completo de abajo, así que aquí no se repite. */}
          <div className="vc-dock" aria-hidden="true">
            <span className="vc-dock-t">
              <span>
                Pierdes <span>{usd(r.withoutUs)}</span> · pagas <span>{usd(r.withUs)}</span>
              </span>
              <b>{r.worthIt ? "Recuperas por cada dólar que pagas" : "con estos números todavía no conviene"}</b>
            </span>
            <strong className="vc-dock-n">
              {r.worthIt ? (
                <>
                  <small>USD</small> <span>{ratio}</span>
                </>
              ) : (
                "—"
              )}
            </strong>
          </div>
        </div>
        {/* En escritorio, al lado de los números y quieta al bajar: se ve al abrir «Ajustar los supuestos». */}
        <div className="vc-out">
          <div className="vc-col">
            <span className="tag vc-amber">Sin {WORDS.name}, cada mes</span>
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
          <div className="vc-res">
            <div className="vc-bar">
              <div className="vc-bl">
                <span>Sin {WORDS.name} pierdes, cada mes</span>
                <strong className="vc-big vc-amber">{usd(r.withoutUs)}</strong>
              </div>
              <div className="vc-track">
                <span className="vc-fill" style={{ width: sinPct, background: "#f5c46b" }} />
              </div>
            </div>
            <div className="vc-bar">
              <div className="vc-bl">
                <span>Con {WORDS.name} pagas, cada mes</span>
                <strong className="vc-big vc-sky">{usd(r.withUs)}</strong>
              </div>
              <div className="vc-track">
                <span className="vc-fill" style={{ width: conPct, background: "var(--sky)" }} />
              </div>
            </div>
          </div>
          <div className="vc-ratio" aria-live="polite">
            <span className="vc-rt">Recuperas</span>
            <strong>
              <span className="vc-cur">{r.worthIt ? "USD" : ""}</span>
              <span className="vc-n">{r.worthIt ? ratio : "—"}</span>
            </strong>
            <span className="vc-rl">
              {r.worthIt ? "por cada dólar que pagas" : "con estos números todavía no conviene"}
            </span>
            <span className="vc-fav">
              {r.worthIt ? (
                <>
                  A tu favor, cada mes: <b>{usd(r.inFavor)}</b>
                </>
              ) : (
                L.tryIt
              )}
            </span>
          </div>
          <span className="mono vc-note">
            Ejemplo con números de prueba: pon los de {WORDS.yourClinic}. No es una promesa de resultados.
          </span>
        </div>
      </div>
    </div>
  )
}
