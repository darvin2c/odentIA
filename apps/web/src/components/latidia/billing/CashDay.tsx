// La caja del día del Consultorio San Martín (lienzo de latidIA, tablero «Caja», portada): los cobros
// entran uno a uno, Luis paga una parte con tarjeta y sale su ticket con el impuesto aparte y «Le falta
// pagar»; por la tarde paga lo que faltaba y la caja queda lista para cerrar. Un paso cada 1,7 s.
// «Repetir el día» (en la portada) manda el evento `replayEvent`. Con movimiento reducido se ve el día
// terminado, sin animar. Los montos son del tarifario de ejemplo del consultorio, no precios de latidIA.
import { useCallback, useEffect, useRef, useState } from "react"
import "./cash-day.css"

interface Props {
  /** Un evento de window que vuelve a empezar el día (el botón «Repetir el día» de la portada). */
  replayEvent?: string
}

const STEP_MS = 1700
const LAST = 6

type Charge = { at: number; time: string; who: string; what: string; amount: number; method: string }

// `at`: en qué paso del día aparece cada cobro. En el paso 3 sale el ticket de Luis.
const DAY: Charge[] = [
  { at: 1, time: "09:20", who: "Rosa Paredes Luna", what: "Consulta de medicina general", amount: 80, method: "Efectivo" },
  { at: 2, time: "10:25", who: "Luis Gómez Salas", what: "Control + electrocardiograma · S/ 110", amount: 80, method: "Tarjeta" },
  { at: 4, time: "11:40", who: "Mateo Ríos", what: "Nebulización", amount: 30, method: "Efectivo" },
  { at: 5, time: "17:30", who: "Luis Gómez Salas", what: "Paga lo que faltaba", amount: 30, method: "Efectivo" },
]

/** «S/ 80,00»: los soles del tarifario de ejemplo. */
const soles = (v: number) => `S/ ${v.toFixed(2).replace(".", ",")}`

export default function CashDay({ replayEvent }: Props) {
  // Se arma en el servidor con el día terminado: sin JavaScript se lee igual.
  const [n, setN] = useState(LAST)
  const timer = useRef<number | undefined>(undefined)

  const play = useCallback(() => {
    window.clearInterval(timer.current)
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setN(LAST)
      return
    }
    let step = 0
    setN(0)
    timer.current = window.setInterval(() => {
      step += 1
      setN(step)
      if (step >= LAST) window.clearInterval(timer.current)
    }, STEP_MS)
  }, [])

  useEffect(() => {
    play()
    return () => window.clearInterval(timer.current)
  }, [play])

  useEffect(() => {
    if (!replayEvent) return
    window.addEventListener(replayEvent, play)
    return () => window.removeEventListener(replayEvent, play)
  }, [replayEvent, play])

  const luisPaid = n >= 5
  const shown = DAY.filter((d) => n >= d.at)
  const total = shown.reduce((sum, d) => sum + d.amount, 0)
  const byMethod = new Map<string, number>()
  for (const d of shown) byMethod.set(d.method, (byMethod.get(d.method) ?? 0) + d.amount)
  const state = n === 0 ? "closed" : n >= LAST ? "ready" : "open"
  const stateText = n === 0 ? "Sin abrir" : n >= LAST ? "Lista para cerrar" : "Abierta desde 09:20"

  return (
    <div className="lt-cash">
      <div className="lt-cash-card">
        <div className="lt-cash-top">
          <div className="lt-cash-title">
            <b>Caja de hoy</b>
            <span>Sede San Martín · sábado 24 oct.</span>
          </div>
          <span className="lt-cash-state" data-state={state}>
            <i aria-hidden="true" />
            {stateText}
          </span>
        </div>
        {/* Lo que entra se anuncia a los lectores de pantalla, sin repetir toda la lista. */}
        <div className="lt-cash-rows" aria-live="polite">
          {shown.map((d) => {
            const owed = d.at === 2 && !luisPaid
            const now = d.at === n || (n === 3 && d.at === 2)
            return (
              <div key={d.at} className="lt-cash-row" data-now={now || undefined}>
                <span className="lt-cash-time">{d.time}</span>
                <span className="lt-cash-who">
                  <b>{d.who}</b>
                  <span>{d.what}</span>
                  <span className="lt-cash-chip" data-owed={owed || undefined}>
                    {owed ? "Le falta pagar S/ 30,00" : "Pagado"}
                  </span>
                </span>
                <span className="lt-cash-amount">
                  <b>{soles(d.amount)}</b>
                  <span>{d.method}</span>
                </span>
              </div>
            )
          })}
          {n === 0 && <div className="lt-cash-empty">La caja se abre sola con el primer cobro del día.</div>}
        </div>
        <div className="lt-cash-foot">
          <div className="lt-cash-total">
            <span>Cobrado hoy</span>
            <b>{soles(total)}</b>
          </div>
          <div className="lt-cash-methods">
            {byMethod.size ? (
              [...byMethod].map(([method, v]) => (
                <span key={method}>
                  {method} S/ {v}
                </span>
              ))
            ) : (
              <span>Sin cobros todavía</span>
            )}
          </div>
          {n >= 2 && n < 5 && <span className="lt-cash-owed">Por cobrar: S/ 30,00 de Luis Gómez Salas</span>}
          {n >= LAST && (
            <div className="lt-cash-close">
              <span>Todo cobrado. Al cerrar, imprimes la hoja para firmar la entrega.</span>
              <span className="lt-cash-close-btn" aria-hidden="true">
                Cerrar caja
              </span>
            </div>
          )}
        </div>
        <span className="lt-cash-note">Demostración con datos de ejemplo.</span>
      </div>

      {/* El ticket de Luis: subtotal e impuesto separados, y siempre dice que no es un documento fiscal. */}
      <div className="lt-cash-ticket" data-on={n >= 3 || undefined} aria-hidden={n >= 3 ? undefined : true}>
        <b className="lt-cash-c">CONSULTORIO SAN MARTÍN</b>
        <span className="lt-cash-c lt-cash-dim">Av. Perú 1820, San Martín de Porres</span>
        <span className="lt-cash-c lt-cash-dim">Ticket 000124 · 24/10/2026 10:25</span>
        <span className="lt-cash-cut" />
        <span>Luis Gómez Salas</span>
        <span className="lt-cash-line">
          <span>Control</span>
          <span>50,00</span>
        </span>
        <span className="lt-cash-line">
          <span>Electrocardiograma</span>
          <span>60,00</span>
        </span>
        <span className="lt-cash-cut" />
        <span className="lt-cash-line lt-cash-dim">
          <span>Subtotal</span>
          <span>93,22</span>
        </span>
        <span className="lt-cash-line lt-cash-dim">
          <span>IGV 18 %</span>
          <span>16,78</span>
        </span>
        <span className="lt-cash-line">
          <b>Total S/</b>
          <b>110,00</b>
        </span>
        <span className="lt-cash-line">
          <span>Tarjeta</span>
          <span>80,00</span>
        </span>
        <span className="lt-cash-line lt-cash-left" data-paid={luisPaid || undefined}>
          <b>Le falta pagar</b>
          <b>{luisPaid ? "0,00" : "30,00"}</b>
        </span>
        <span className="lt-cash-cut" />
        <span className="lt-cash-c lt-cash-fiscal">Recibo interno. No es un documento fiscal.</span>
      </div>
    </div>
  )
}
