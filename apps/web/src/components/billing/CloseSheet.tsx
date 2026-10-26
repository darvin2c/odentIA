// Cierre de caja (odentIA, /caja-y-cobros): el panel «Cerrar caja» con «1. Efectivo que contaste» y
// «2. Qué haces con el efectivo», y a su lado la hoja «CIERRE DE CAJA» para firmar. Se elige cuánto se
// contó (de más, justo o de menos) y cambian la diferencia, lo que se entrega y el aviso, con las palabras
// de la aplicación. Los otros medios (tarjeta, transferencia) no se cuentan aquí. Montos de ejemplo.
import { useState } from "react"
import "./close-sheet.css"

const EXPECTED = 185
const KEPT = 50
const OPTIONS = [
  { id: "less", label: "S/ 180,00", counted: 180 },
  { id: "exact", label: "S/ 185,00", counted: 185 },
  { id: "more", label: "S/ 190,00", counted: 190 },
] as const

const soles = (v: number) => `S/ ${v.toFixed(2).replace(".", ",")}`

export default function CloseSheet() {
  const [pick, setPick] = useState<(typeof OPTIONS)[number]["id"]>("exact")
  const counted = OPTIONS.find((o) => o.id === pick)?.counted ?? EXPECTED
  const diff = counted - EXPECTED
  const delivered = counted - KEPT
  const diffText = diff === 0 ? "S/ 0,00" : diff < 0 ? `Faltan ${soles(-diff)}` : `Sobran ${soles(diff)}`

  return (
    <div className="cs">
      <div className="cs-panel">
        <b className="cs-title">Cerrar caja</b>
        <dl className="cs-box">
          <div>
            <dt>Quedó del cierre anterior</dt>
            <dd>{soles(50)}</dd>
          </div>
          <div>
            <dt>Cobros en efectivo</dt>
            <dd>{soles(220)}</dd>
          </div>
          <div>
            <dt>Gastos pagados con la caja</dt>
            <dd>− {soles(85)}</dd>
          </div>
          <div className="cs-total">
            <dt>Debe haber</dt>
            <dd>{soles(EXPECTED)}</dd>
          </div>
        </dl>
        <fieldset className="cs-pick">
          <legend>1. Efectivo que contaste</legend>
          <div className="cs-opts">
            {OPTIONS.map((o) => (
              <button key={o.id} type="button" aria-pressed={pick === o.id} onClick={() => setPick(o.id)}>
                {o.label}
              </button>
            ))}
          </div>
          <p className={`cs-status ${diff === 0 ? "ok" : "bad"}`} role="status">
            {diff === 0 ? "Cuadra con lo que debe haber." : `${diffText}. Puedes cerrar igual; administración recibirá un aviso.`}
          </p>
        </fieldset>
        <div className="cs-split">
          <span className="cs-split-k">2. Qué haces con el efectivo</span>
          <div className="cs-two">
            <span>
              <small>Dejas en caja para mañana</small>
              <b>{soles(KEPT)}</b>
            </span>
            <span>
              <small>Entregas</small>
              <b>{soles(delivered)}</b>
            </span>
          </div>
          <span className="cs-hint">Escribe uno y el otro se calcula solo: juntos suman lo que contaste.</span>
        </div>
        <span className="cs-others">Otros medios, no se cuentan aquí: Tarjeta S/ 200,00 · Transferencia S/ 150,00. Compáralos con el reporte de cada medio.</span>
      </div>

      <div className="cs-sheet" aria-label="Hoja de cierre">
        <b className="cs-c">CLÍNICA SONRISA NORTE</b>
        <span className="cs-c">Sede Norte</span>
        <b className="cs-c cs-big">CIERRE DE CAJA</b>
        <span className="cs-c">24/10/2026 19:30</span>
        <span className="cs-line">
          <span>Cerró</span>
          <span>Rocío Vega</span>
        </span>
        <span className="cs-line">
          <span>Desde</span>
          <span>24/10/2026 08:40</span>
        </span>
        <span className="cs-cut" />
        <span className="cs-line">
          <span>Quedó del cierre anterior</span>
          <span>{soles(50)}</span>
        </span>
        <span className="cs-line">
          <span>Cobros en efectivo</span>
          <span>{soles(220)}</span>
        </span>
        <span className="cs-line">
          <span>Gastos pagados con la caja</span>
          <span>− {soles(85)}</span>
        </span>
        <span className="cs-line cs-strong">
          <span>Debe haber</span>
          <span>{soles(EXPECTED)}</span>
        </span>
        <span className="cs-line">
          <span>Contado</span>
          <span>{soles(counted)}</span>
        </span>
        <span className="cs-line cs-strong">
          <span>Diferencia</span>
          <span>{diffText}</span>
        </span>
        <span className="cs-line">
          <span>Queda en caja</span>
          <span>{soles(KEPT)}</span>
        </span>
        <span className="cs-line cs-strong cs-deliver">
          <span>ENTREGA</span>
          <span>{soles(delivered)}</span>
        </span>
        <span className="cs-cut" />
        <span className="cs-dim">Otros medios (no se cuentan)</span>
        <span className="cs-line">
          <span>Tarjeta</span>
          <span>{soles(200)}</span>
        </span>
        <span className="cs-line">
          <span>Transferencia</span>
          <span>{soles(150)}</span>
        </span>
        <span className="cs-sign">
          <span>Entrega</span>
          <span>Recibe</span>
        </span>
      </div>
    </div>
  )
}
