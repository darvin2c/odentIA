// Quién debe y desde cuándo (odentIA, /caja-y-cobros): la pestaña Deudas de Finanzas con «Por cobrar en
// total», el filtro por antigüedad (Todas · Más de 30 días · Más de 90 días) y cada persona con su
// «Debe desde el…, hace N días», «Escribirle» y «Cobrar». Lo aceptado en un presupuesto que aún no se
// atiende no es deuda, y la pantalla lo dice. Datos de ejemplo al 24 de octubre.
import { useState } from "react"
import "./debts-list.css"

type Filter = "todas" | "30" | "90"
const ROWS = [
  { name: "Jorge Paredes", what: "Endodoncia · pieza 46", since: "2 jul.", days: 114, amount: 1250 },
  { name: "Mónica Salazar", what: "Corona · pieza 36", since: "12 sept.", days: 42, amount: 420 },
  { name: "Carlos Medina", what: "Resina · pieza 36 y limpieza dental", since: "24 oct.", days: 0, amount: 100 },
]

const soles = (v: number) => {
  const [int, dec] = v.toFixed(2).split(".")
  return `S/ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`
}

export default function DebtsList() {
  const [filter, setFilter] = useState<Filter>("todas")
  const over30 = ROWS.filter((r) => r.days > 30)
  const over90 = ROWS.filter((r) => r.days > 90)
  const visible = filter === "30" ? over30 : filter === "90" ? over90 : ROWS
  const total = ROWS.reduce((s, r) => s + r.amount, 0)
  const tabs: { v: Filter; label: string; count: number }[] = [
    { v: "todas", label: "Todas", count: ROWS.length },
    { v: "30", label: "Más de 30 días", count: over30.length },
    { v: "90", label: "Más de 90 días", count: over90.length },
  ]

  return (
    <div className="dl">
      <div className="dl-total">
        <span>Por cobrar en total · {ROWS.length} personas</span>
        <b>{soles(total)}</b>
      </div>
      <fieldset className="dl-tabs">
        <legend className="sr-only">Antigüedad de la deuda</legend>
        {tabs.map((t) => (
          <button key={t.v} type="button" aria-pressed={filter === t.v} onClick={() => setFilter(t.v)}>
            {t.label} <span>{t.count}</span>
          </button>
        ))}
      </fieldset>
      <ul className="dl-list" aria-live="polite">
        {visible.map((r) => (
          <li key={r.name} className="dl-row">
            <span className="dl-who">
              <b>
                {r.name}
                {r.days > 90 && <span className="dl-badge">Más de 90 días</span>}
              </b>
              <span>{r.what}</span>
              <span>{r.days === 0 ? `Debe desde el ${r.since}, desde hoy` : `Debe desde el ${r.since}, hace ${r.days} días`}</span>
            </span>
            <b className="dl-amount">{soles(r.amount)}</b>
            <span className="dl-acts" aria-hidden="true">
              <span>Escribirle</span>
              <span className="dl-pay">Cobrar</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="dl-foot">Lo aceptado en un presupuesto que todavía no se atiende no aparece aquí: no es deuda.</p>
    </div>
  )
}
