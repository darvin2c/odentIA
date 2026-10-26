// El control de limpieza que se repite de Rosa (sección «Controles» de /agenda-odontologica): se elige
// cada 1, 3, 6 o 12 meses; «Completar control» lo pasa a realizados y deja indicado el siguiente;
// «Reservar» le pone cita y «Dejar de repetir» hace que el próximo sea el último. Como en la app
// (pestaña Plan de la ficha), un control se completa contra una atención finalizada, no por estar
// programado. Las frecuencias son las de la app: 1, 3, 6 y 12 meses.
import { useState } from "react"
import "./recurring-control.css"

const CADENCES = [1, 3, 6, 12] as const
/** Lo que se anota al completar cada control de ejemplo. */
const OUTCOMES = ["Encías sanas", "Sarro leve en la cara lingual inferior", "Sin hallazgos nuevos", "Encías sanas", "Placa leve en molares"]
const MAX_DONE = 5

/** La limpieza de hoy (26 de octubre de 2026) es el último control; desde ahí se cuentan los meses. */
const fromLast = (months: number) => new Date(2026, 9 + months, 26)
const fmt = (d: Date) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`

type State = { cadence: number; doneN: number; booked: boolean; stopped: boolean; finished: boolean }
const INITIAL: State = { cadence: 6, doneN: 0, booked: false, stopped: false, finished: false }

export default function RecurringControl() {
  const [st, setSt] = useState<State>(INITIAL)

  // La fecha de cada control: los ya hechos y el pendiente, uno detrás de otro con la frecuencia elegida.
  const offsets: number[] = []
  for (let i = 0, acc = 0; i <= st.doneN; i++) {
    acc += st.cadence
    offsets.push(acc)
  }
  const due = fmt(fromLast(offsets[st.doneN]))
  const done = [
    { date: "26/10/2026", result: "Limpieza y revisión de encías", fresh: false },
    ...offsets.slice(0, st.doneN).map((o, i) => ({ date: fmt(fromLast(o)), result: OUTCOMES[i % OUTCOMES.length], fresh: i === st.doneN - 1 })),
  ].reverse()

  const complete = () =>
    setSt((x) => (x.finished ? x : { ...x, doneN: Math.min(x.doneN + 1, MAX_DONE), booked: false, finished: x.stopped }))

  return (
    <div className="drc">
      <span className="drc-title">
        <b>Controles · Rosa Vega</b>
        <span>Un control programado no equivale a un control realizado: se completa contra una atención finalizada.</span>
      </span>
      <div className="drc-card">
        <span className="drc-line">
          <b>Control de limpieza dental</b>
          <span className={`drc-chip${st.finished ? " off" : ""}`}>{st.finished ? "Sin próximo" : "Pendiente"}</span>
          <span className="drc-due">Mantenimiento · previsto {st.finished ? "sin fecha" : due}</span>
        </span>
        <span className="drc-ind">Indicación: «Limpieza y revisión de encías.»</span>
        <span className="drc-book" aria-live="polite">
          {st.finished
            ? "Completado. Ya no queda otro control indicado."
            : st.booked
              ? `Cita reservada · ${due} · 09:00 · Unidad dental 1`
              : "Sin cita reservada · Argos la invita a reservar a tiempo"}
        </span>
        <span className="drc-repeat" aria-live="polite">
          {st.stopped
            ? "Ya no se repite: al completarlo no se indica otro."
            : `Se repite ${st.cadence === 1 ? "cada mes" : `cada ${st.cadence} meses`}: al completarlo queda indicado el siguiente.`}
        </span>
        <fieldset className="drc-cad" disabled={st.finished}>
          <legend>Cada</legend>
          {CADENCES.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={st.cadence === n && !st.stopped}
              onClick={() => setSt((x) => ({ ...x, cadence: n, stopped: false }))}
            >
              {n === 1 ? "1 mes" : `${n} meses`}
            </button>
          ))}
        </fieldset>
        {!st.finished && (
          <div className="drc-actions">
            <button type="button" className={st.booked ? "drc-btn" : "drc-btn drc-main"} onClick={() => setSt((x) => ({ ...x, booked: !x.booked }))}>
              {st.booked ? "Cancelar la reserva" : "Reservar"}
            </button>
            <button type="button" className="drc-btn" onClick={complete}>
              Completar control
            </button>
            {!st.stopped && (
              <button type="button" className="drc-btn" onClick={() => setSt((x) => ({ ...x, stopped: true }))}>
                Dejar de repetir
              </button>
            )}
          </div>
        )}
      </div>
      <div className="drc-done">
        <span className="drc-done-h">Realizados</span>
        <ul>
          {done.map((d) => (
            <li key={d.date} className={d.fresh ? "drc-pop" : undefined}>
              <span>{d.date} · en la atención firmada</span>
              <b>{d.result}</b>
            </li>
          ))}
        </ul>
      </div>
      <button type="button" className="drc-reset" onClick={() => setSt(INITIAL)}>
        Reiniciar el ejemplo
      </button>
    </div>
  )
}
