// Las cinco pestañas de Reportes (lienzo de latidIA, tablero «Caja», sección Reportes): Resumen,
// Finanzas, Pacientes, Agenda y Agente, como en la app. Cada cifra se compara en palabras («↑ 12 más que
// en septiembre»), no solo con un color. Las pestañas siguen el patrón de WAI-ARIA (flechas, Inicio y Fin
// dentro de la lista). Sin animación propia.
// Un solo componente para las dos webs (`variant`): latidIA, con las cifras del Consultorio San Martín,
// donde «pagaron» es la consulta cobrada; odentIA, con las de Clínica Sonrisa Norte, con el presupuesto
// en el embudo y el cobrado por tratamiento, como en Reportes de la app. Lo que se pagó por los agentes
// llega calculado con los precios publicados (props), nunca escrito aquí.
import { type KeyboardEvent, useRef, useState } from "react"
import "./reports-tabs.css"

type Variant = "medical" | "dental"

interface Props {
  /** Lo que se pagó por los agentes en el mes de ejemplo, con los precios publicados; null sin precios. */
  agentCost: { total: string; note: string } | null
  /** Dónde se piden los precios cuando aún no se publican. */
  contactHref: string
  /** latidIA (por omisión) u odentIA: cada una con las cifras y las palabras de su producto. */
  variant?: Variant
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

interface SummaryCard {
  label: string
  value: string
  cmp: string
  trend: Trend
  /** Una línea de apoyo bajo la comparación («38 de 60 presupuestos presentados»). */
  detail?: string
  /** Los últimos 12 meses (0 a 1), el último punteado porque no termina. */
  spark: number[]
}

interface Data {
  /** La cabeza de la ventana: el periodo, las sedes y con qué se compara. */
  period: string
  scope: string
  vs: string
  summary: SummaryCard[]
  /** De lo cobrado a lo que queda: [rótulo, cifra, desde %, ancho %, es un descuento]. */
  cascade: [string, string, number, number, boolean][]
  /** El rótulo del último paso, el que se pinta más fuerte. */
  cascadeEnd: string
  cascadeNote: string
  finance: { label: string; value: string; cmp: string; trend: Trend | "warn" }[]
  /** Lo cobrado por tratamiento (solo odentIA, como en Reportes › Finanzas): [nombre, valor, cifra escrita]. */
  byService?: { title: string; rows: [string, number, string][] }
  /** Quienes nos buscaron por primera vez en el mes y hasta dónde llegaron: [rótulo, qué cuenta, personas, % del paso anterior]. */
  funnel: [string, string, number, string][]
  /** Cómo se dice quiénes se cayeron antes de cada paso, desde el segundo; el primero es el que más pierde. */
  funnelDrops: string[]
  funnelTip: string
  agenda: {
    cards: { label: string; value: string; cmp: string; trend: Trend }[]
    title: string
    column: string
    measure: string
    rows: [string, number][]
  }
  agents: { who: string; color: string; label: string; value: string; cmp: string; trend: Trend }[]
}

const MEDICAL: Data = {
  period: "Octubre de 2026, hasta hoy",
  scope: "Todas las sedes",
  vs: "Comparado con los mismos días de septiembre de 2026",
  summary: [
    { label: "Cobrado", value: "S/ 18.640", cmp: "↑ 8 % más que en septiembre", trend: "up", spark: [0.42, 0.48, 0.45, 0.52, 0.55, 0.5, 0.58, 0.62, 0.6, 0.66, 0.7, 0.55] },
    { label: "Consultas atendidas", value: "214", cmp: "↑ 12 más que en septiembre", trend: "up", spark: [0.5, 0.52, 0.49, 0.55, 0.6, 0.58, 0.6, 0.64, 0.63, 0.68, 0.72, 0.6] },
    { label: "Pacientes nuevos", value: "37", cmp: "↓ 5 menos que en septiembre", trend: "down", spark: [0.4, 0.45, 0.5, 0.48, 0.55, 0.6, 0.52, 0.58, 0.62, 0.6, 0.7, 0.5] },
    // Que falten menos es bueno: baja, pero va en verde.
    { label: "Faltaron a su cita", value: "16", cmp: "↓ 3 menos que en septiembre", trend: "up", spark: [0.7, 0.66, 0.68, 0.6, 0.62, 0.55, 0.5, 0.52, 0.48, 0.45, 0.42, 0.3] },
  ],
  cascade: [
    ["Cobrado", "18.640", 0, 100, false],
    ["Impuesto (IGV)", "− 2.843", 84.7, 15.3, true],
    ["Comisiones de tarjeta", "− 210", 83.6, 1.1, true],
    ["Lo que te deja", "15.587", 0, 83.6, false],
  ],
  cascadeEnd: "Lo que te deja",
  cascadeNote: "El impuesto se separa de lo cobrado antes de decir lo que te deja.",
  finance: [
    { label: "Te deben", value: "S/ 1.230", cmp: "14 personas · S/ 240 llevan más de 60 días", trend: "warn" },
    { label: "Comisiones de tarjeta", value: "S/ 210", cmp: "Igual que en los mismos días de septiembre", trend: "flat" },
  ],
  funnel: [
    ["Nos buscaron", "Primera conversación o registro", 120, ""],
    ["Agendaron", "Una cita sin cancelar", 84, "70 %"],
    ["Vinieron", "Una cita atendida o una atención firmada", 71, "85 %"],
    ["Pagaron", "Vinieron y se les cobró la consulta", 68, "96 %"],
  ],
  funnelDrops: ["no agendaron · Aquí se caen más", "no vinieron", "no pagaron todavía"],
  funnelTip: "En un consultorio, «pagaron» es la consulta cobrada. No hace falta que alguien acepte un presupuesto para que cuente.",
  agenda: {
    cards: [
      { label: "Vinieron", value: "214", cmp: "↑ 12 más que en septiembre", trend: "up" },
      { label: "Faltaron", value: "16", cmp: "↓ 3 menos que en septiembre", trend: "up" },
    ],
    title: "Qué tan llena está cada sala",
    column: "Sala",
    measure: "Horas con cita",
    rows: [
      ["San Martín · Sala 1", 78],
      ["San Martín · Sala 2", 64],
      ["Los Olivos · Sala 1", 59],
    ],
  },
  // Lo que hizo cada agente en el mes, con su color sobre claro.
  agents: [
    { who: "Sofi", color: "#0e7490", label: "Conversaciones atendidas", value: "412", cmp: "↑ 30 más que en septiembre", trend: "up" },
    { who: "Sofi", color: "#0e7490", label: "Citas que agendó", value: "96", cmp: "↑ 8 % más que en septiembre", trend: "up" },
    { who: "Clío", color: "#1f9d7a", label: "Consultas que ordenó", value: "198", cmp: "Igual que en septiembre", trend: "flat" },
    { who: "Argos", color: "#9a6a12", label: "Citas recuperadas", value: "11", cmp: "↑ 4 más que en septiembre", trend: "up" },
  ],
}

// Clínica Sonrisa Norte (la de las demás demostraciones de odentIA), en soles. Las cifras que ya publican
// la portada de Argos y las preguntas de esta misma página son las mismas: te deben S/ 4.820 de 23 personas,
// S/ 1.150 llevan más de 60 días, la inasistencia de la clínica es 11 % y la limpieza dental suma S/ 3.200
// en 40 atenciones. Los rótulos y el orden de las cifras, los de Reportes de la app
// (packages/clinic-app/src/components/reports).
const DENTAL: Data = {
  period: "Octubre de 2026, hasta hoy",
  scope: "Todas las sedes",
  vs: "Comparado con los mismos días de septiembre de 2026",
  summary: [
    { label: "Cobrado", value: "S/ 21.600", cmp: "↑ 9 % más que en septiembre", trend: "up", spark: [0.4, 0.44, 0.47, 0.5, 0.48, 0.55, 0.58, 0.56, 0.62, 0.66, 0.7, 0.54] },
    { label: "Pacientes nuevos", value: "52", cmp: "↑ 6 más que en septiembre", trend: "up", spark: [0.45, 0.5, 0.47, 0.55, 0.52, 0.58, 0.6, 0.57, 0.64, 0.62, 0.68, 0.56] },
    { label: "Aceptaron su presupuesto", value: "63 %", cmp: "↑ 4 puntos más que en septiembre", trend: "up", detail: "38 de 60 presupuestos presentados", spark: [0.5, 0.48, 0.52, 0.55, 0.5, 0.56, 0.54, 0.58, 0.57, 0.6, 0.62, 0.6] },
    // Que falten menos es bueno: baja, pero va en verde.
    { label: "No vinieron", value: "11 %", cmp: "↓ 2 puntos menos que en septiembre", trend: "up", detail: "27 de 245 citas que ya pasaron", spark: [0.66, 0.62, 0.64, 0.58, 0.6, 0.55, 0.52, 0.5, 0.48, 0.46, 0.44, 0.38] },
    { label: "Citas que agendó el agente", value: "71", cmp: "↑ 6 más que en septiembre", trend: "up", detail: "y recuperó 9 citas", spark: [0.3, 0.34, 0.4, 0.42, 0.48, 0.5, 0.55, 0.58, 0.6, 0.66, 0.7, 0.55] },
    // Que baje lo que se debe es bueno: va en verde.
    { label: "Te deben hace más de 60 días", value: "S/ 1.150", cmp: "↓ S/ 200 menos que en septiembre", trend: "up", detail: "5 personas, al cierre del periodo", spark: [0.6, 0.62, 0.66, 0.64, 0.6, 0.58, 0.62, 0.56, 0.54, 0.5, 0.48, 0.42] },
  ],
  cascade: [
    ["Cobrado", "21.600", 0, 100, false],
    ["Impuesto (IGV)", "− 3.295", 84.7, 15.3, true],
    ["Comisiones", "− 2.500", 73.2, 11.6, true],
    ["Materiales", "− 2.100", 63.4, 9.7, true],
    ["Lo que deja", "13.705", 0, 63.4, false],
  ],
  cascadeEnd: "Lo que deja",
  cascadeNote: "El impuesto no es de la clínica: se separa de lo cobrado antes de decir lo que deja.",
  finance: [
    { label: "Te deben", value: "S/ 4.820", cmp: "23 personas · S/ 1.150 llevan más de 60 días", trend: "warn" },
    { label: "Comisiones", value: "S/ 2.500", cmp: "14 % de lo cobrado sin IGV · Por pagar: S/ 900", trend: "flat" },
  ],
  byService: {
    title: "Cobrado por tratamiento",
    rows: [
      ["Limpieza dental", 3200, "3.200"],
      ["Resina simple", 2450, "2.450"],
      ["Endodoncia", 1800, "1.800"],
    ],
  },
  funnel: [
    ["Nos buscaron", "Primera conversación o registro", 140, ""],
    ["Agendaron", "Una cita sin cancelar", 98, "70 %"],
    ["Vinieron", "Una cita atendida o una atención firmada", 83, "85 %"],
    ["Recibieron presupuesto", "Presentado", 60, "72 %"],
    ["Aceptaron", "Del todo o en parte", 38, "63 %"],
    ["Pagaron algo", "Aceptaron y pagaron algo", 31, "82 %"],
  ],
  funnelDrops: [
    "no agendaron · Aquí se caen más",
    "no vinieron",
    "vinieron y no recibieron presupuesto",
    "aún no responden o lo rechazaron",
    "aceptaron y aún no pagan",
  ],
  funnelTip: "Aceptar el presupuesto cuenta aunque sea solo una parte. Cada paso abre la lista de quiénes son.",
  agenda: {
    cards: [
      { label: "Citas atendidas", value: "198", cmp: "↑ 14 más que en septiembre", trend: "up" },
      { label: "No vinieron", value: "11 %", cmp: "↓ 2 puntos menos que en septiembre", trend: "up" },
      { label: "Canceladas", value: "8 %", cmp: "Igual que en septiembre", trend: "flat" },
      { label: "Agenda ocupada", value: "74 %", cmp: "↑ 3 puntos más que en septiembre", trend: "up" },
    ],
    title: "Cuándo queda libre la agenda",
    column: "Día",
    measure: "Agenda ocupada",
    rows: [
      ["Lunes", 82],
      ["Martes", 78],
      ["Miércoles", 76],
      ["Jueves", 80],
      ["Viernes", 71],
      ["Sábado", 55],
    ],
  },
  agents: [
    { who: "Sofi", color: "#0e7490", label: "Conversaciones que atendió", value: "377", cmp: "↑ 27 más que en septiembre", trend: "up" },
    { who: "Sofi", color: "#0e7490", label: "Citas que agendó", value: "71", cmp: "↑ 6 más que en septiembre", trend: "up" },
    { who: "Argos", color: "#9a6a12", label: "Citas recuperadas", value: "9", cmp: "↑ 3 más que en septiembre", trend: "up" },
    // El verde de Clío, oscurecido para que se lea en chico sobre claro.
    { who: "Clío", color: "#1f7f63", label: "Consultas dictadas", value: "164", cmp: "↑ 18 más que en septiembre", trend: "up" },
  ],
}

const DATA: Record<Variant, Data> = { medical: MEDICAL, dental: DENTAL }

/** Los puntos de una línea de 12 meses en un dibujo de 120 × 30. */
const points = (values: number[], from = 0) =>
  values.map((v, i) => `${(((i + from) * 120) / 11).toFixed(1)},${(28 - v * 26).toFixed(1)}`).join(" ")

export default function ReportsTabs({ agentCost, contactHref, variant = "medical" }: Props) {
  const d = DATA[variant]
  // Abre en Pacientes, como el tablero: ahí se ve el paso donde se caen más y qué cuenta como «pagaron».
  const [tab, setTab] = useState<TabKey>("pacientes")
  const [asTable, setAsTable] = useState(false)
  // Una sola tabla de Reportes por página: los id pueden ser fijos.
  const id = "lt-rtabs"
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const first = d.funnel[0][2]
  const top = d.byService?.rows[0][1] ?? 1

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
          <span>{d.period}</span>
          <span>{d.scope}</span>
        </div>
      </div>
      <span className="lt-rtabs-vs">{d.vs}</span>
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
            {d.summary.map((c) => (
              <div key={c.label} className="lt-rtabs-card">
                <span className="lt-rtabs-label">{c.label}</span>
                <b className="lt-rtabs-big">{c.value}</b>
                <span className="lt-rtabs-cmp" data-trend={c.trend}>
                  {c.cmp}
                </span>
                {c.detail && <span className="lt-rtabs-foot lt-rtabs-detail">{c.detail}</span>}
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
          <div className="lt-rtabs-stack">
            <div className="lt-rtabs-row">
              <div className="lt-rtabs-card lt-rtabs-wide">
                <b className="lt-rtabs-h">{variant === "dental" ? "De lo cobrado a lo que deja el periodo" : "De lo cobrado a lo que te deja"}</b>
                {d.cascade.map(([label, value, from, width, minus]) => (
                  <div key={label} className="lt-rtabs-line">
                    <span>{label}</span>
                    <span className="lt-rtabs-track lt-rtabs-rel">
                      <span className="lt-rtabs-fill" data-minus={minus || undefined} data-net={label === d.cascadeEnd || undefined} style={{ left: `${from}%`, width: `${width}%` }} />
                    </span>
                    <b className="lt-rtabs-num">{value}</b>
                  </div>
                ))}
                <span className="lt-rtabs-label">{d.cascadeNote}</span>
              </div>
              <div className="lt-rtabs-col">
                {d.finance.map((c) => (
                  <div key={c.label} className="lt-rtabs-card">
                    <span className="lt-rtabs-label">{c.label}</span>
                    <b className="lt-rtabs-big">{c.value}</b>
                    <span className="lt-rtabs-cmp" data-trend={c.trend}>
                      {c.cmp}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            {d.byService && (
              <div className="lt-rtabs-card lt-rtabs-wide">
                <b className="lt-rtabs-h">{d.byService.title}</b>
                {d.byService.rows.map(([label, value, text]) => (
                  <div key={label} className="lt-rtabs-line lt-rtabs-line-room">
                    <span>{label}</span>
                    <span className="lt-rtabs-track lt-rtabs-round">
                      <span className="lt-rtabs-fill" style={{ width: `${Math.round((value / top) * 100)}%` }} />
                    </span>
                    <b className="lt-rtabs-num">{text}</b>
                  </div>
                ))}
                <span className="lt-rtabs-label">En soles, sin el impuesto.</span>
              </div>
            )}
          </div>
        )}

        {tab === "pacientes" && (
          <div className="lt-rtabs-card">
            <div className="lt-rtabs-hgroup">
              <b className="lt-rtabs-h">Dónde se caen los pacientes</b>
              <span className="lt-rtabs-label">Quienes nos buscaron por primera vez en octubre, y hasta dónde llegaron.</span>
            </div>
            {d.funnel.map(([label, sub, n, pct], i) => {
              const lost = i ? d.funnel[i - 1][2] - n : 0
              const worst = i === 1
              return (
                <div key={label} className="lt-rtabs-step">
                  {i > 0 && (
                    <span className="lt-rtabs-drop" data-worst={worst || undefined}>
                      ↓ {lost} {d.funnelDrops[i - 1]}
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
                    <span className="lt-rtabs-fill" style={{ width: `${Math.round((n / first) * 100)}%` }} />
                  </span>
                </div>
              )
            })}
            <p className="lt-rtabs-tip">{d.funnelTip}</p>
          </div>
        )}

        {tab === "agenda" && (
          <div className="lt-rtabs-row">
            <div className="lt-rtabs-col lt-rtabs-pair">
              {d.agenda.cards.map((c) => (
                <div key={c.label} className="lt-rtabs-card">
                  <span className="lt-rtabs-label">{c.label}</span>
                  <b className="lt-rtabs-big">{c.value}</b>
                  <span className="lt-rtabs-cmp" data-trend={c.trend}>
                    {c.cmp}
                  </span>
                </div>
              ))}
            </div>
            <div className="lt-rtabs-card lt-rtabs-wide">
              <b className="lt-rtabs-h">{d.agenda.title}</b>
              {asTable ? (
                <table className="lt-rtabs-table">
                  <thead>
                    <tr>
                      <th scope="col">{d.agenda.column}</th>
                      <th scope="col">{d.agenda.measure}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.agenda.rows.map(([label, pct]) => (
                      <tr key={label}>
                        <td>{label}</td>
                        <td>{pct} %</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                d.agenda.rows.map(([label, pct]) => (
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
            {d.agents.map((a) => (
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
