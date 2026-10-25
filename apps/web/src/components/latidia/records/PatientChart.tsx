// La ficha de Luis en la portada de Historia clínica (lienzo de latidIA, tablero «Historia»): sus
// cuatro pestañas clínicas y, en Signos vitales, la presión que se dibuja de enero a octubre. Cada
// control del gráfico es un botón que cambia «Última medición»; «Ver como tabla» muestra lo mismo
// en filas. Ejemplo con los datos de la demo; tocar algo solo cambia lo que se ve.
import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import "./patient-chart.css"

type Tab = "ante" | "vitals" | "hist" | "docs"

/** Los cuatro controles de Luis: la presión baja de 152/96 a 132/84 y el peso de 86 a 82 kg. */
const CONTROLS = [
  { short: "24 ene", long: "24 de enero de 2026", sys: 152, dia: 96, fc: 84, peso: 86, note: "inicia enalapril y dieta baja en sal" },
  { short: "25 abr", long: "25 de abril de 2026", sys: 144, dia: 92, fc: 80, peso: 85, note: "continúa con enalapril" },
  { short: "25 jul", long: "25 de julio de 2026", sys: 138, dia: 88, fc: 78, peso: 83, note: "orden de laboratorio" },
  { short: "24 oct", long: "24 de octubre de 2026", sys: 132, dia: 84, fc: 76, peso: 82, note: "control cada 3 meses" },
]
const LAST = CONTROLS.length - 1
const HEIGHT_M = 1.72
/** El IMC como lo muestra la app: un decimal, con coma. */
const bmi = (kg: number) => (kg / (HEIGHT_M * HEIGHT_M)).toFixed(1).replace(".", ",")

const TABS: Array<[Tab, string]> = [
  ["ante", "Antecedentes"],
  ["vitals", "Signos vitales"],
  ["hist", "Historia"],
  ["docs", "Documentos"],
]

// Geometría del gráfico (viewBox 460 × 222): de 60 a 160 mmHg, un control en cada X.
const X = [70, 197, 324, 432]
const Y = (v: number) => 20 + (160 - v) * 1.7
const GRID = [160, 140, 120, 100, 80, 60]

/** La línea hasta donde va el dibujo: los controles ya alcanzados y un tramo del siguiente. */
function lineOf(key: "sys" | "dia", progress: number): string {
  const points: string[] = []
  for (let i = 0; i <= LAST; i++) if (i <= progress) points.push(`${X[i]},${Y(CONTROLS[i][key]).toFixed(1)}`)
  const whole = Math.floor(progress)
  if (whole < LAST && progress > whole) {
    const t = progress - whole
    const x = X[whole] + (X[whole + 1] - X[whole]) * t
    const y = Y(CONTROLS[whole][key]) + (Y(CONTROLS[whole + 1][key]) - Y(CONTROLS[whole][key])) * t
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  }
  return points.join(" ")
}

export default function PatientChart() {
  const [tab, setTab] = useState<Tab>("vitals")
  // En el servidor y sin movimiento se ve el gráfico entero, con el último control elegido.
  const [progress, setProgress] = useState(LAST)
  const [sel, setSel] = useState(LAST)
  const [table, setTable] = useState(false)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const timer = useRef<ReturnType<typeof setInterval>>(undefined)

  // Va antes que el dibujo: al montar, el gráfico entero no debe cortar el intervalo recién creado.
  // Al llegar a octubre se detiene y, si nadie eligió otro, queda elegido el último control.
  useEffect(() => {
    if (progress < LAST) return
    clearInterval(timer.current)
    setSel((s) => (s === -1 ? LAST : s))
  }, [progress])

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    // El gráfico se dibuja de enero a octubre; al terminar queda elegido el último control.
    setProgress(0)
    setSel(-1)
    const id = setInterval(() => setProgress((p) => Math.min(LAST, Math.round((p + 0.1) * 10) / 10)), 90)
    timer.current = id
    return () => clearInterval(id)
  }, [])

  // Las pestañas se recorren con las flechas, como en la app; Tab entra y sale del grupo.
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const move = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
    if (!move) return
    event.preventDefault()
    const next = (index + move + TABS.length) % TABS.length
    setTab(TABS[next][0])
    tabRefs.current[next]?.focus()
  }

  const pick = (i: number) => {
    setSel(i)
    setProgress(LAST)
  }
  const current = CONTROLS[sel >= 0 ? sel : LAST]
  const isLast = sel === LAST || sel === -1
  const rows = CONTROLS.map((c) => ({ ...c, pa: `${c.sys}/${c.dia}` }))

  return (
    <div className="pc">
      <div className="pc-head">
        <span className="pc-av" aria-hidden="true">LG</span>
        <span className="pc-who">
          <span className="pc-name">
            <b>Luis Gómez Salas</b>
            <span className="pc-chip">Paciente</span>
          </span>
          <span className="pc-meta">HC-000002 · 62 años · Hipertensión arterial</span>
        </span>
        <span className="pc-attend">Atender</span>
      </div>

      <div className="pc-tabs" role="tablist" aria-label="Clínica">
        {TABS.map(([id, label], i) => (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[i] = el
            }}
            type="button"
            role="tab"
            id={`pc-tab-${id}`}
            aria-controls="pc-panel"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            className="pc-tab"
            onClick={() => setTab(id)}
            onKeyDown={(event) => onTabKey(event, i)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="pc-body" id="pc-panel" role="tabpanel" aria-labelledby={`pc-tab-${tab}`}>
        {tab === "vitals" && (
          <div className="pc-vitals">
            <div className="pc-box pc-graph">
              {table ? (
                <>
                  <b className="pc-t">Signos vitales en tabla</b>
                  <table className="pc-table">
                    <caption className="sr-only">Signos vitales de Luis en cada control</caption>
                    <thead>
                      <tr>
                        <th scope="col">Fecha</th>
                        <th scope="col">PA (mmHg)</th>
                        <th scope="col">FC</th>
                        <th scope="col">Peso</th>
                        <th scope="col">IMC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.short}>
                          <td>{r.short}</td>
                          <td>
                            <b>{r.pa}</b>
                          </td>
                          <td>{r.fc} lpm</td>
                          <td>{r.peso} kg</td>
                          <td>{bmi(r.peso)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : (
                <>
                  <div className="pc-gh">
                    <b className="pc-t">Presión arterial</b>
                    <span>mmHg · en cada control</span>
                  </div>
                  <div className="pc-svg">
                    <svg viewBox="0 0 460 222" width="100%" role="img" aria-label="Presión arterial de Luis en 4 controles, de 152/96 a 132/84 mmHg">
                      <g className="pc-axis">
                        {GRID.map((v) => (
                          <g key={v}>
                            <line x1="44" y1={Y(v)} x2="452" y2={Y(v)} stroke={v === 60 ? "#cbd5e1" : "#eef0f4"} />
                            <text x="36" y={Y(v) + 4} textAnchor="end">
                              {v}
                            </text>
                          </g>
                        ))}
                      </g>
                      <line
                        x1={X[sel >= 0 ? sel : LAST]}
                        y1="14"
                        x2={X[sel >= 0 ? sel : LAST]}
                        y2="190"
                        stroke="#94a3b8"
                        strokeDasharray="3 3"
                        opacity={sel >= 0 ? 1 : 0}
                      />
                      <polyline className="pc-sys" points={lineOf("sys", progress)} />
                      <polyline className="pc-dia" points={lineOf("dia", progress)} />
                      {CONTROLS.map((c, i) => {
                        const shown = i <= progress
                        const on = i === sel
                        const r = shown ? (on ? 6.5 : 4.5) : 0
                        return (
                          <g key={c.short}>
                            <circle cx={X[i]} cy={Y(c.sys)} r={r} className="pc-dot-s" />
                            <circle cx={X[i]} cy={Y(c.dia)} r={r} className="pc-dot-d" />
                            <text x={X[i]} y={Y(c.sys) - 12} textAnchor="middle" className="pc-val" opacity={on ? 1 : 0}>
                              {c.sys}
                            </text>
                            <text x={X[i]} y={Y(c.dia) + 22} textAnchor="middle" className="pc-val" opacity={on ? 1 : 0}>
                              {c.dia}
                            </text>
                            <text x={X[i]} y="210" textAnchor="middle" className="pc-date" fontWeight={on ? 800 : 500}>
                              {c.short}
                            </text>
                          </g>
                        )
                      })}
                    </svg>
                    {CONTROLS.map((c, i) => (
                      <button
                        key={c.short}
                        type="button"
                        className="pc-hit"
                        style={{ left: `calc(${((X[i] / 460) * 100).toFixed(2)}% - 22px)` }}
                        aria-pressed={i === sel}
                        aria-label={`Control del ${c.long}: presión ${c.sys}/${c.dia} mmHg`}
                        onClick={() => pick(i)}
                      />
                    ))}
                  </div>
                  <div className="pc-legend">
                    <span>
                      <i className="s" />
                      Sistólica
                    </span>
                    <span>
                      <i className="d" />
                      Diastólica
                    </span>
                    <span className="pc-hint">Toca un control</span>
                  </div>
                </>
              )}
            </div>
            <div className="pc-side">
              <div className="pc-box pc-last" aria-live="polite">
                <b className="pc-t">{isLast ? "Última medición" : `Medición del ${current.short}`}</b>
                <span className="pc-sub">{current.short} · Elena Vela · control</span>
                <span className="pc-kv">
                  <span>Presión arterial</span>
                  <b>
                    {current.sys}/{current.dia} mmHg
                  </b>
                </span>
                <span className="pc-kv">
                  <span>Frecuencia cardiaca</span>
                  <b>{current.fc} lpm</b>
                </span>
                <span className="pc-kv">
                  <span>Peso</span>
                  <b>{current.peso} kg</b>
                </span>
                <span className="pc-kv">
                  <span>Talla</span>
                  <b>172 cm</b>
                </span>
                <span className="pc-kv">
                  <span>IMC</span>
                  <b>{bmi(current.peso)}</b>
                </span>
              </div>
              <div className="pc-box pc-count">
                <span>4 controles con signos vitales</span>
                <button
                  type="button"
                  className="pc-toggle"
                  aria-pressed={table}
                  onClick={() => {
                    setTable((t) => !t)
                    setProgress(LAST)
                    setSel((s) => (s === -1 ? LAST : s))
                  }}
                >
                  {table ? "Ver los gráficos" : "Ver como tabla"}
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === "ante" && (
          <div className="pc-ante">
            <div className="pc-card">
              <b>Alergias</b>
              <span>No tiene alergias · preguntado el 24 ene</span>
            </div>
            <div className="pc-card">
              <b>Condiciones</b>
              <span>Hipertensión arterial · desde 2019</span>
            </div>
            <div className="pc-card">
              <b>Medicación vigente</b>
              <span>Enalapril 10 mg, cada 12 horas</span>
            </div>
            <div className="pc-card">
              <b>Hábitos</b>
              <span>Tabaco: fuma, 10 cigarrillos al día · Alcohol: ocasional · Actividad física: camina</span>
            </div>
            <div className="pc-card pc-problems">
              <b>Lista de problemas</b>
              <span>Hipertensión arterial (I10) · Tabaquismo. Siguen activos hasta que se resuelven.</span>
            </div>
          </div>
        )}

        {tab === "hist" && (
          <div className="pc-box pc-list">
            {rows
              .slice()
              .reverse()
              .map((r) => (
                <div key={r.short} className="pc-row">
                  <span className="pc-rc">
                    <b>{r.short} · Control de presión arterial</b>
                    <span>
                      PA {r.pa} mmHg · {r.note}
                    </span>
                  </span>
                  <span className="pc-state ok">Firmada</span>
                </div>
              ))}
            <span className="pc-foot">Cada atención firmada con la colegiatura de la Dra. Elena Vela, CMP 045678.</span>
          </div>
        )}

        {tab === "docs" && (
          <div className="pc-box pc-list">
            <div className="pc-row">
              <span className="pc-rc">
                <b>Receta N.º 4</b>
                <span>24/10/2026 · enalapril 10 mg</span>
              </span>
              <span className="pc-state ok">Vigente</span>
            </div>
            <div className="pc-row">
              <span className="pc-rc">
                <b>Orden de laboratorio</b>
                <span>25/07/2026 · perfil lipídico y glucosa</span>
              </span>
              <span className="pc-state">Emitida</span>
            </div>
            <div className="pc-row">
              <span className="pc-rc">
                <b>Electrocardiograma</b>
                <span>24/01/2026 · archivo subido</span>
              </span>
              <span className="pc-state">PDF</span>
            </div>
          </div>
        )}
      </div>
      <span className="pc-note">Demostración con datos de ejemplo. Cambia de pestaña o toca un control del gráfico.</span>
    </div>
  )
}
