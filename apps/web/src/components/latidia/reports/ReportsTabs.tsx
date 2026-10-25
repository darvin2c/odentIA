// Las cinco pestañas de Reportes (lienzo de latidIA, tablero «Caja», sección Reportes): Resumen,
// Finanzas, Pacientes, Agenda y Agente, como en la app. Cada cifra se compara en palabras («↑ 12 más que
// en septiembre»), no solo con un color, y en un consultorio «pagaron» es la consulta cobrada. Las
// pestañas siguen el patrón de WAI-ARIA (flechas, Inicio y Fin dentro de la lista). Sin animación propia.
// Las cifras son del Consultorio San Martín de ejemplo; lo que se pagó por los agentes llega calculado
// con los precios publicados (props), nunca escrito aquí.
import { type KeyboardEvent, useRef, useState } from "react"
import "./reports-tabs.css"

interface Props {
  /** Lo que se pagó por los agentes en el mes de ejemplo, con los precios publicados; null sin precios. */
  agentCost: { total: string; note: string } | null
  /** Dónde se piden los precios cuando aún no se publican. */
  contactHref: string
}

type TabKey = "resumen" | "finanzas" | "pacientes" | "agenda" | "agente"

const TABS: [TabKey, string][] = [
  ["resumen", "Resumen"],
  ["finanzas", "Finanzas"],
  ["pacientes", "Pacientes"],
  ["agenda", "Agenda"],
  ["agente", "Agente"],
]

type Trend = "up" | "down" | "flat"

// Las cifras del mes y sus últimos 12 meses (0 a 1), el último punteado porque no termina.
const SUMMARY: { label: string; value: string; cmp: string; trend: Trend; spark: number[] }[] = [
  { label: "Cobrado", value: "S/ 18.640", cmp: "↑ 8 % más que en septiembre", trend: "up", spark: [0.42, 0.48, 0.45, 0.52, 0.55, 0.5, 0.58, 0.62, 0.6, 0.66, 0.7, 0.55] },
  { label: "Consultas atendidas", value: "214", cmp: "↑ 12 más que en septiembre", trend: "up", spark: [0.5, 0.52, 0.49, 0.55, 0.6, 0.58, 0.6, 0.64, 0.63, 0.68, 0.72, 0.6] },
  { label: "Pacientes nuevos", value: "37", cmp: "↓ 5 menos que en septiembre", trend: "down", spark: [0.4, 0.45, 0.5, 0.48, 0.55, 0.6, 0.52, 0.58, 0.62, 0.6, 0.7, 0.5] },
  // Que falten menos es bueno: baja, pero va en verde.
  { label: "Faltaron a su cita", value: "16", cmp: "↓ 3 menos que en septiembre", trend: "up", spark: [0.7, 0.66, 0.68, 0.6, 0.62, 0.55, 0.5, 0.52, 0.48, 0.45, 0.42, 0.3] },
]

// De lo cobrado a lo que te deja: [rótulo, cifra, desde %, ancho %, es un descuento].
const CASCADE: [string, string, number, number, boolean][] = [
  ["Cobrado", "18.640", 0, 100, false],
  ["Impuesto (IGV)", "− 2.843", 84.7, 15.3, true],
  ["Comisiones de tarjeta", "− 210", 83.6, 1.1, true],
  ["Lo que te deja", "15.587", 0, 83.6, false],
]

// Quienes nos buscaron por primera vez en octubre, y hasta dónde llegaron.
const FUNNEL: [string, string, number, string][] = [
  ["Nos buscaron", "Primera conversación o registro", 120, ""],
  ["Agendaron", "Una cita sin cancelar", 84, "70 %"],
  ["Vinieron", "Una cita atendida o una atención firmada", 71, "85 %"],
  ["Pagaron", "Vinieron y se les cobró la consulta", 68, "96 %"],
]

const ROOMS: [string, number][] = [
  ["San Martín · Sala 1", 78],
  ["San Martín · Sala 2", 64],
  ["Los Olivos · Sala 1", 59],
]

// Lo que hizo cada agente en el mes, con su color sobre claro.
const AGENTS: { who: string; color: string; label: string; value: string; cmp: string; trend: Trend }[] = [
  { who: "Sofi", color: "#0e7490", label: "Conversaciones atendidas", value: "412", cmp: "↑ 30 más que en septiembre", trend: "up" },
  { who: "Sofi", color: "#0e7490", label: "Citas que agendó", value: "96", cmp: "↑ 8 % más que en septiembre", trend: "up" },
  { who: "Clío", color: "#1f9d7a", label: "Consultas que ordenó", value: "198", cmp: "Igual que en septiembre", trend: "flat" },
  { who: "Argos", color: "#9a6a12", label: "Citas recuperadas", value: "11", cmp: "↑ 4 más que en septiembre", trend: "up" },
]

/** Los puntos de una línea de 12 meses en un dibujo de 120 × 30. */
const points = (values: number[], from = 0) =>
  values.map((v, i) => `${(((i + from) * 120) / 11).toFixed(1)},${(28 - v * 26).toFixed(1)}`).join(" ")

export default function ReportsTabs({ agentCost, contactHref }: Props) {
  // Abre en Pacientes, como el tablero: ahí se ve que «pagaron» es la consulta cobrada.
  const [tab, setTab] = useState<TabKey>("pacientes")
  const [asTable, setAsTable] = useState(false)
  // Una sola tabla de Reportes por página: los id pueden ser fijos.
  const id = "lt-rtabs"
  const refs = useRef<(HTMLButtonElement | null)[]>([])

  // Flechas, Inicio y Fin mueven el foco y eligen la pestaña (solo dentro de la lista de pestañas).
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = TABS.length - 1
    const to =
      event.key === "ArrowRight" ? (i === last ? 0 : i + 1)
      : event.key === "ArrowLeft" ? (i === 0 ? last : i - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null
    if (to === null) return
    event.preventDefault()
    setTab(TABS[to][0])
    refs.current[to]?.focus()
  }

  return (
    <div className="lt-rtabs">
      <div className="lt-rtabs-top">
        <b>Reportes</b>
        <div className="lt-rtabs-pills">
          <span>Octubre de 2026, hasta hoy</span>
          <span>Todas las sedes</span>
        </div>
      </div>
      <span className="lt-rtabs-vs">Comparado con los mismos días de septiembre de 2026</span>
      <div className="lt-rtabs-tabs" role="tablist" aria-label="Pestañas de Reportes">
        {TABS.map(([key, label], i) => (
          <button
            key={key}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="tab"
            id={`${id}-t-${key}`}
            aria-controls={`${id}-p-${key}`}
            aria-selected={key === tab}
            tabIndex={key === tab ? 0 : -1}
            onClick={() => setTab(key)}
            onKeyDown={(event) => onKey(event, i)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="lt-rtabs-panel" role="tabpanel" id={`${id}-p-${tab}`} aria-labelledby={`${id}-t-${tab}`}>
        {tab === "resumen" && (
          <div className="lt-rtabs-grid">
            {SUMMARY.map((c) => (
              <div key={c.label} className="lt-rtabs-card">
                <span className="lt-rtabs-label">{c.label}</span>
                <b className="lt-rtabs-big">{c.value}</b>
                <span className="lt-rtabs-cmp" data-trend={c.trend}>
                  {c.cmp}
                </span>
                <svg viewBox="0 0 120 30" width="100%" height="30" preserveAspectRatio="none" aria-hidden="true">
                  <polyline points={points(c.spark.slice(0, 11))} className="lt-rtabs-spark" />
                  <polyline points={points(c.spark.slice(10), 10)} className="lt-rtabs-spark lt-rtabs-spark-open" />
                </svg>
                <span className="lt-rtabs-foot">Últimos 12 meses; el mes que no termina va punteado.</span>
              </div>
            ))}
          </div>
        )}

        {tab === "finanzas" && (
          <div className="lt-rtabs-row">
            <div className="lt-rtabs-card lt-rtabs-wide">
              <b className="lt-rtabs-h">De lo cobrado a lo que te deja</b>
              {CASCADE.map(([label, value, from, width, minus]) => (
                <div key={label} className="lt-rtabs-line">
                  <span>{label}</span>
                  <span className="lt-rtabs-track lt-rtabs-rel">
                    <span className="lt-rtabs-fill" data-minus={minus || undefined} data-net={label === "Lo que te deja" || undefined} style={{ left: `${from}%`, width: `${width}%` }} />
                  </span>
                  <b className="lt-rtabs-num">{value}</b>
                </div>
              ))}
              <span className="lt-rtabs-label">El impuesto se separa de lo cobrado antes de decir lo que te deja.</span>
            </div>
            <div className="lt-rtabs-col">
              <div className="lt-rtabs-card">
                <span className="lt-rtabs-label">Te deben</span>
                <b className="lt-rtabs-big">S/ 1.230</b>
                <span className="lt-rtabs-cmp" data-trend="warn">
                  14 personas · S/ 240 llevan más de 60 días
                </span>
              </div>
              <div className="lt-rtabs-card">
                <span className="lt-rtabs-label">Comisiones de tarjeta</span>
                <b className="lt-rtabs-big">S/ 210</b>
                <span className="lt-rtabs-cmp" data-trend="flat">
                  Igual que en los mismos días de septiembre
                </span>
              </div>
            </div>
          </div>
        )}

        {tab === "pacientes" && (
          <div className="lt-rtabs-card">
            <div className="lt-rtabs-hgroup">
              <b className="lt-rtabs-h">Dónde se caen los pacientes</b>
              <span className="lt-rtabs-label">Quienes nos buscaron por primera vez en octubre, y hasta dónde llegaron.</span>
            </div>
            {FUNNEL.map(([label, sub, n, pct], i) => {
              const lost = i ? FUNNEL[i - 1][2] - n : 0
              const worst = i === 1
              return (
                <div key={label} className="lt-rtabs-step">
                  {i > 0 && (
                    <span className="lt-rtabs-drop" data-worst={worst || undefined}>
                      ↓ {lost} {i === 1 ? "no agendaron · Aquí se caen más" : i === 2 ? "no vinieron" : "no pagaron todavía"}
                    </span>
                  )}
                  <div className="lt-rtabs-step-l">
                    <span>
                      <b>{label}</b>
                      <span className="lt-rtabs-sub">{sub}</span>
                    </span>
                    <span className="lt-rtabs-num">
                      <b>{n}</b>
                      {pct && <span>{pct}</span>}
                    </span>
                  </div>
                  <span className="lt-rtabs-track lt-rtabs-round">
                    <span className="lt-rtabs-fill" style={{ width: `${Math.round((n / 120) * 100)}%` }} />
                  </span>
                </div>
              )
            })}
            <p className="lt-rtabs-tip">En un consultorio, «pagaron» es la consulta cobrada. No hace falta que alguien acepte un presupuesto para que cuente.</p>
          </div>
        )}

        {tab === "agenda" && (
          <div className="lt-rtabs-row">
            <div className="lt-rtabs-col lt-rtabs-pair">
              <div className="lt-rtabs-card">
                <span className="lt-rtabs-label">Vinieron</span>
                <b className="lt-rtabs-big">214</b>
                <span className="lt-rtabs-cmp" data-trend="up">
                  ↑ 12 más que en septiembre
                </span>
              </div>
              <div className="lt-rtabs-card">
                <span className="lt-rtabs-label">Faltaron</span>
                <b className="lt-rtabs-big">16</b>
                <span className="lt-rtabs-cmp" data-trend="up">
                  ↓ 3 menos que en septiembre
                </span>
              </div>
            </div>
            <div className="lt-rtabs-card lt-rtabs-wide">
              <b className="lt-rtabs-h">Qué tan llena está cada sala</b>
              {asTable ? (
                <table className="lt-rtabs-table">
                  <thead>
                    <tr>
                      <th scope="col">Sala</th>
                      <th scope="col">Horas con cita</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ROOMS.map(([label, pct]) => (
                      <tr key={label}>
                        <td>{label}</td>
                        <td>{pct} %</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                ROOMS.map(([label, pct]) => (
                  <div key={label} className="lt-rtabs-line lt-rtabs-line-room">
                    <span>{label}</span>
                    <span className="lt-rtabs-track lt-rtabs-round">
                      <span className="lt-rtabs-fill" style={{ width: `${pct}%` }} />
                    </span>
                    <b className="lt-rtabs-num">{pct} %</b>
                  </div>
                ))
              )}
              <button type="button" className="lt-rtabs-link" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
                {asTable ? "Ver como gráfico" : "Ver como tabla"}
              </button>
            </div>
          </div>
        )}

        {tab === "agente" && (
          <div className="lt-rtabs-grid lt-rtabs-grid-agents">
            {AGENTS.map((a) => (
              <div key={a.label} className="lt-rtabs-card">
                <span className="lt-rtabs-who" style={{ color: a.color }}>
                  {a.who}
                </span>
                <span className="lt-rtabs-label">{a.label}</span>
                <b className="lt-rtabs-big">{a.value}</b>
                <span className="lt-rtabs-cmp" data-trend={a.trend}>
                  {a.cmp}
                </span>
              </div>
            ))}
            <div className="lt-rtabs-paid">
              <span>Lo que pagaste por tus agentes este mes</span>
              {agentCost ? (
                <>
                  <b className="lt-rtabs-num">{agentCost.total}</b>
                  <span className="lt-rtabs-foot">{agentCost.note}</span>
                </>
              ) : (
                <span className="lt-rtabs-foot">
                  Los precios se publican pronto. <a href={contactHref}>Escríbenos</a> y te los contamos.
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      <span className="lt-rtabs-note">Demostración con datos de ejemplo. Toca una pestaña.</span>
    </div>
  )
}
