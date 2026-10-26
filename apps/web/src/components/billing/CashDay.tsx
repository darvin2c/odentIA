// La caja del día de la Clínica Sonrisa Norte (odentIA, portada de /caja-y-cobros): la pestaña Caja de
// Finanzas se llena cobro a cobro, con las mismas tarjetas y palabras de la aplicación (Efectivo en caja,
// Por cobrar, Movimientos de hoy). Carlos paga una parte con tarjeta y sale su ticket con el IGV aparte y
// «Le falta pagar»; por la tarde paga lo que faltaba. También entran un adelanto de Lucía (que paga su
// mamá) y un gasto que sale del efectivo. Un paso cada 1,7 s; «Repetir el día» está en la esquina de la
// caja. Con movimiento reducido se ve el día terminado, sin animar. Los montos son del ejemplo.
import { useCallback, useEffect, useRef, useState } from "react"
import "./cash-day.css"

const STEP_MS = 1700
const LAST = 6
/** Lo que quedó en la caja del cierre anterior. */
const OPENING = 50

type Entry = {
  at: number
  time: string
  who: string
  sub: string
  note?: string
  /** Lo que entra (+) o sale (−) de la caja; el efectivo se cuenta aparte. */
  amount: number
  method: string
  kind: "cobro" | "gasto"
}

// `at`: en qué paso del día aparece cada movimiento. En el paso 2 sale el ticket de Carlos.
const DAY: Entry[] = [
  { at: 1, time: "08:40", who: "Andrea Quispe Rojas", sub: "Ticket 000211 · Efectivo", note: "Limpieza dental", amount: 120, method: "Efectivo", kind: "cobro" },
  { at: 2, time: "10:25", who: "Carlos Medina", sub: "Ticket 000212 · Tarjeta", note: "Resina · pieza 36 y limpieza dental", amount: 200, method: "Tarjeta", kind: "cobro" },
  { at: 3, time: "12:15", who: "Lucía Ramos Soto", sub: "Ticket 000213 · Transferencia", note: "Adelanto del tratamiento, lo paga Carmen", amount: 150, method: "Transferencia", kind: "cobro" },
  { at: 4, time: "15:00", who: "Gasto: Compra de materiales", sub: "Salió del efectivo", amount: -85, method: "Efectivo", kind: "gasto" },
  { at: 5, time: "17:30", who: "Carlos Medina", sub: "Ticket 000214 · Efectivo", note: "Paga lo que faltaba", amount: 100, method: "Efectivo", kind: "cobro" },
]

/** «S/ 80,00»: los soles del ejemplo (una clínica de Perú). */
const soles = (v: number) => `S/ ${v.toFixed(2).replace(".", ",")}`
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export default function CashDay() {
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

  const carlosPaid = n >= 5
  const shown = DAY.filter((d) => n >= d.at)
  const cobros = shown.filter((d) => d.kind === "cobro")
  const collected = cobros.reduce((sum, d) => sum + d.amount, 0)
  const cash = OPENING + shown.filter((d) => d.method === "Efectivo").reduce((sum, d) => sum + d.amount, 0)
  const others = new Map<string, { amount: number; count: number }>()
  for (const d of cobros) {
    if (d.method === "Efectivo") continue
    const row = others.get(d.method) ?? { amount: 0, count: 0 }
    others.set(d.method, { amount: row.amount + d.amount, count: row.count + 1 })
  }
  const owes = n >= 2 && !carlosPaid
  const state = n === 0 ? "closed" : n >= LAST ? "ready" : "open"
  const stateText = n === 0 ? "Sin abrir" : n >= LAST ? "Lista para cerrar" : "Abierta desde 08:40"

  return (
    <div className="fc">
      <div className="fc-card">
        <div className="fc-top">
          <div className="fc-title">
            <b>Finanzas</b>
            <span>Caja por sede, deudas y gastos · Sede Norte · sábado 24 oct.</span>
          </div>
          <span className="fc-side">
            <span className="fc-state" data-state={state}>
              <i aria-hidden="true" />
              {stateText}
            </span>
            <button type="button" className="fc-replay" onClick={play}>
              <span aria-hidden="true">↻</span> Repetir el día
            </button>
          </span>
        </div>
        <div className="fc-tabs" aria-hidden="true">
          <span className="on">Caja</span>
          <span>Deudas</span>
          <span>Gastos</span>
          <span>Comisiones</span>
        </div>

        <div className="fc-cards">
          <div className="fc-stat fc-stat-main">
            <span className="fc-k">Efectivo en caja</span>
            <b>{soles(cash)}</b>
            <span className="fc-sub">{n === 0 ? "La caja se abre sola con el primer cobro." : `Quedó ${soles(OPENING)} del cierre anterior`}</span>
          </div>
          {[...others].map(([method, v]) => (
            <div key={method} className="fc-stat">
              <span className="fc-k">{method}</span>
              <b>{soles(v.amount)}</b>
              <span className="fc-sub">{plural(v.count, "cobro", "cobros")}</span>
            </div>
          ))}
          <div className="fc-stat">
            <span className="fc-k">Cobrado hoy</span>
            <b>{soles(collected)}</b>
            <span className="fc-sub">{plural(cobros.length, "ticket", "tickets")}</span>
          </div>
        </div>

        <div className="fc-block">
          <div className="fc-block-head">
            <b>Por cobrar</b>
            <span>{owes ? "1 persona · S/ 100,00" : ""}</span>
          </div>
          {owes ? (
            <div className="fc-owe">
              <span>
                <b>Carlos Medina</b>
                <span>Resina · pieza 36 y limpieza dental</span>
                <span>Salió a las 10:25 · Dra. Paredes</span>
              </span>
              <b className="fc-owe-amount">{soles(100)}</b>
            </div>
          ) : (
            <p className="fc-none">Nadie debe por ahora</p>
          )}
        </div>

        <div className="fc-block">
          <div className="fc-block-head">
            <b>Movimientos de hoy</b>
            <span>{shown.length ? `${plural(cobros.length, "ticket", "tickets")} · ${plural(shown.length - cobros.length, "gasto", "gastos")}` : ""}</span>
          </div>
          {/* Lo que entra se anuncia a los lectores de pantalla, sin repetir toda la lista. */}
          <div className="fc-rows" aria-live="polite">
            {[...shown].reverse().map((d) => {
              const now = d.at === n
              const partial = d.at === 2 && !carlosPaid
              return (
                <div key={d.at} className="fc-row" data-now={now || undefined}>
                  <span className="fc-time">{d.time}</span>
                  <span className="fc-who">
                    <b>{d.who}</b>
                    <span>{d.sub}</span>
                    {d.note && <span>{d.note}</span>}
                    {partial && <span className="fc-chip" data-owed>Le falta pagar {soles(100)}</span>}
                    {d.at === 3 && <span className="fc-chip">Saldo a favor</span>}
                  </span>
                  <b className="fc-amount" data-out={d.amount < 0 || undefined}>
                    {d.amount < 0 ? "−" : ""}
                    {soles(Math.abs(d.amount))}
                  </b>
                </div>
              )
            })}
            {n === 0 && <div className="fc-empty">Sin movimientos hoy. La caja se abre sola con el primer cobro.</div>}
          </div>
        </div>

        {n >= LAST && (
          <div className="fc-close">
            <span>Debe haber {soles(cash)} en efectivo. Al cerrar, imprimes la hoja para firmar la entrega.</span>
            <span className="fc-close-btn" aria-hidden="true">
              Cerrar caja
            </span>
          </div>
        )}
        <span className="fc-note">Demostración con datos de ejemplo.</span>
      </div>

      {/* El ticket de Carlos: subtotal e impuesto separados, y siempre dice que no es un documento fiscal. */}
      <div className="fc-ticket" data-on={n >= 2 || undefined} aria-hidden={n >= 2 ? undefined : true}>
        <b className="fc-c">CLÍNICA SONRISA NORTE</b>
        <span className="fc-c fc-dim">Sede Norte</span>
        <span className="fc-c fc-dim">Ticket 000212 · 24/10/2026 10:25</span>
        <span className="fc-cut" />
        <span>Carlos Medina</span>
        <span className="fc-line">
          <span>Resina · pieza 36</span>
          <span>180,00</span>
        </span>
        <span className="fc-line">
          <span>Limpieza dental</span>
          <span>120,00</span>
        </span>
        <span className="fc-cut" />
        <span className="fc-line fc-dim">
          <span>Subtotal</span>
          <span>254,24</span>
        </span>
        <span className="fc-line fc-dim">
          <span>IGV 18 %</span>
          <span>45,76</span>
        </span>
        <span className="fc-line">
          <b>TOTAL S/</b>
          <b>300,00</b>
        </span>
        <span className="fc-line">
          <span>Tarjeta</span>
          <span>200,00</span>
        </span>
        <span className="fc-line fc-left" data-paid={carlosPaid || undefined}>
          <b>Le falta pagar</b>
          <b>{carlosPaid ? "0,00" : "100,00"}</b>
        </span>
        <span className="fc-cut" />
        <span className="fc-c fc-fiscal">Recibo interno. No es un documento fiscal.</span>
      </div>
    </div>
  )
}
