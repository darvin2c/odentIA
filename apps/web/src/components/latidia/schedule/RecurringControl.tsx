// El control que se repite de Luis (lienzo de latidIA, tablero «Agenda»): se elige cada 1, 3, 6 o
// 12 meses; «Completar control» lo pasa a realizados y deja indicado el siguiente; «Reservar» le
// pone cita y «Dejar de repetir» hace que el próximo sea el último. Como en la app, un control se
// completa contra una atención firmada, no por estar programado.
import { useState } from "react"
import "./recurring-control.css"

const CADENCES = [1, 3, 6, 12] as const
/** La presión de cada control de ejemplo que se va completando (Luis sigue bajando). */
const PRESSURES = ["130/82 mmHg", "128/80 mmHg", "128/82 mmHg", "126/80 mmHg", "127/81 mmHg", "126/79 mmHg"]
const MAX_DONE = 5

/** El último control de Luis fue el 24 de octubre de 2026; desde ahí se cuentan los meses. */
const fromLast = (months: number) => new Date(2026, 9 + months, 24)
const fmt = (d: Date) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`

type State = { cadence: number; doneN: number; booked: boolean; stopped: boolean; finished: boolean }
const INITIAL: State = { cadence: 3, doneN: 0, booked: false, stopped: false, finished: false }

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
    { date: "24/10/2026", pa: "132/84 mmHg", fresh: false },
    ...offsets.slice(0, st.doneN).map((o, i) => ({ date: fmt(fromLast(o)), pa: PRESSURES[i % PRESSURES.length], fresh: i === st.doneN - 1 })),
  ].reverse()

  const complete = () =>
    setSt((x) =>
      x.finished
        ? x
        : { ...x, doneN: Math.min(x.doneN + 1, MAX_DONE), booked: false, finished: x.stopped },
    )

  return (
    <div className="rc">
      <span className="rc-title">
        <b>Controles · Luis Gómez Salas</b>
        <span>Un control programado no equivale a un control realizado: se completa contra una atención finalizada.</span>
      </span>
      <div className="rc-card">
        <span className="rc-line">
          <b>Control de presión arterial</b>
          <span className={`rc-chip${st.finished ? " off" : ""}`}>{st.finished ? "Sin próximo" : "Pendiente"}</span>
          <span className="rc-due">Mantenimiento · previsto {st.finished ? "sin fecha" : due}</span>
        </span>
        <span className="rc-ind">Indicación: «Traer el registro de presión de la casa.»</span>
        <span className="rc-book" aria-live="polite">
          {st.finished
            ? "Completado. Ya no queda otro control indicado."
            : st.booked
              ? `Cita reservada · ${due} · 10:00 · Sala 2`
              : "Sin cita reservada · Argos lo invita a reservar a tiempo"}
        </span>
        <span className="rc-repeat" aria-live="polite">
          {st.stopped
            ? "Ya no se repite: al completarlo no se indica otro."
            : `Se repite cada ${st.cadence === 1 ? "mes" : `${st.cadence} meses`}: al completarlo queda indicado el siguiente.`}
        </span>
        <fieldset className="rc-cad" disabled={st.finished}>
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
          <div className="rc-actions">
            <button type="button" className={st.booked ? "rc-btn" : "rc-btn rc-main"} onClick={() => setSt((x) => ({ ...x, booked: !x.booked }))}>
              {st.booked ? "Cancelar la reserva" : "Reservar"}
            </button>
            <button type="button" className="rc-btn" onClick={complete}>
              Completar control
            </button>
            {!st.stopped && (
              <button type="button" className="rc-btn" onClick={() => setSt((x) => ({ ...x, stopped: true }))}>
                Dejar de repetir
              </button>
            )}
          </div>
        )}
      </div>
      <div className="rc-done">
        <span className="rc-done-h">Realizados</span>
        <ul>
          {done.map((d) => (
            <li key={d.date} className={d.fresh ? "rc-pop" : undefined}>
              <span>{d.date} · en la atención firmada</span>
              <b>{d.pa}</b>
            </li>
          ))}
        </ul>
      </div>
      <button type="button" className="rc-reset" onClick={() => setSt(INITIAL)}>
        Reiniciar el ejemplo
      </button>
    </div>
  )
}
