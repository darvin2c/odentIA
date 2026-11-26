// Un trozo del periodontograma (guía del periodontograma, «Pruébalo aquí»): la cara de afuera de la 16,
// la 15 y la 14, con sus tres sitios cada una, como en la app (`@odentia/dental/periodontal`): se
// escriben la profundidad de sondaje y la recesión (positiva si se ve raíz, negativa si la encía cubre
// la corona), la pérdida de inserción sale sola (sondaje + recesión) y el dibujo se mueve mientras
// escribes. El sangrado se marca por sitio y su porcentaje también sale solo. No guarda nada.
import { useState } from "react"
import "./demos.css"

const TEETH = [16, 15, 14] as const
/** Mirando la cara de afuera del lado derecho de arriba: distal a la izquierda, mesial a la derecha. */
const SITES = ["D", "V", "M"] as const
const SITE_WORDS = ["distal", "del centro", "mesial"] as const

interface Site {
  depth: number
  recession: number
  bleeding: boolean
}

const START: Site[] = [
  { depth: 3, recession: 1, bleeding: false },
  { depth: 2, recession: 0, bleeding: false },
  { depth: 5, recession: 2, bleeding: true },
  { depth: 3, recession: 0, bleeding: true },
  { depth: 2, recession: 0, bleeding: false },
  { depth: 3, recession: -1, bleeding: false },
  { depth: 2, recession: -1, bleeding: false },
  { depth: 1, recession: 0, bleeding: false },
  { depth: 2, recession: 0, bleeding: false },
]

const DEPTH_MAX = 15
const RECESSION_MIN = -10
const RECESSION_MAX = 15

/**
 * El dibujo, como en la app (`periodontal-chart.tsx`): las piezas de arriba con la raíz hacia arriba y
 * la corona abajo. 9 sitios a lo ancho; el límite amelocementario a `CROWN` del borde de abajo, y cada
 * milímetro, `MM` píxeles hacia la raíz (hacia arriba).
 */
const W = 360
const COL = W / 9
const CROWN = 46
const MM = 9

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export default function PerioDemo() {
  const [sites, setSites] = useState<Site[]>(START)
  /** Lo escrito en cada campo mientras se escribe («-» antes del número): el número se toma cuando lo es. */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const set = (index: number, patch: Partial<Site>) =>
    setSites((now) => now.map((site, at) => (at === index ? { ...site, ...patch } : site)))
  const typed = (field: "depth" | "recession", index: number, text: string) => {
    const clean = text.replace(/[−–]/g, "-").replace(/[^\d-]/g, "").replace(/(?!^)-/g, "")
    setDrafts((now) => ({ ...now, [`${field}${index}`]: clean }))
    if (!/^-?\d+$/.test(clean)) return
    const value = Number(clean)
    set(index, field === "depth" ? { depth: clamp(value, 0, DEPTH_MAX) } : { recession: clamp(value, RECESSION_MIN, RECESSION_MAX) })
  }
  /** Al salir del campo vuelve a mostrar el número guardado. */
  const settle = (field: "depth" | "recession", index: number) =>
    setDrafts((now) => {
      const { [`${field}${index}`]: _, ...rest } = now
      return rest
    })
  const shownValue = (field: "depth" | "recession", index: number) => drafts[`${field}${index}`] ?? String(sites[index]![field])

  const loss = sites.map((site) => site.depth + site.recession)
  const worst = loss.reduce((best, value, index) => (value > loss[best]! ? index : best), 0)
  const bleeding = sites.filter((site) => site.bleeding).length
  const percent = Math.round((100 * bleeding) / sites.length)

  const height = CROWN + 16 * MM
  const CEJ = height - CROWN
  const x = (index: number) => COL * index + COL / 2
  /** Los milímetros hacia la raíz, sin salirse del dibujo (una bolsa de 15 mm con recesión llega abajo). */
  const y = (mm: number) => Math.min(height - 8, Math.max(6, CEJ - mm * MM))
  const margin = sites.map((site, index) => `${x(index)},${y(site.recession)}`).join(" ")
  const bottom = sites.map((site, index) => `${x(index)},${y(site.recession + site.depth)}`).join(" ")

  return (
    <div className="gx gx-perio">
      <div className="gx-card">
        <div className="gx-head">
          <b>Periodontograma · por fuera, 16 a 14</b>
          <span>Cambia un número y mira cómo se mueve la encía y la pérdida de inserción.</span>
        </div>
        <svg className="gx-perio-svg" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="La encía y el fondo de la bolsa de cada sitio">
          {TEETH.map((tooth, t) => (
            <g key={tooth}>
              <rect x={COL * 3 * t + 8} y={CEJ} width={COL * 3 - 16} height={CROWN - 6} rx={10} className="gx-crown" />
              <path
                d={`M ${COL * 3 * t + 14} ${CEJ} L ${COL * 3 * t + COL * 1.2} ${CEJ - 14 * MM} L ${COL * 3 * t + COL * 1.8} ${CEJ - 14 * MM} L ${COL * 3 * (t + 1) - 14} ${CEJ}`}
                className="gx-root"
              />
              <text x={COL * 3 * t + COL * 1.5} y={CEJ + 28} textAnchor="middle" className="gx-tooth-n">
                {tooth}
              </text>
            </g>
          ))}
          <line x1={0} x2={W} y1={CEJ} y2={CEJ} className="gx-cej" />
          <polyline points={margin} className="gx-margin" />
          <polyline points={bottom} className="gx-bottom" />
          {sites.map((site, index) =>
            site.bleeding ? <circle key={index} cx={x(index)} cy={y(site.recession + site.depth)} r={5} className="gx-bleed" /> : null,
          )}
        </svg>
        <div className="gx-legend" aria-hidden="true">
          <span><i className="gx-l-margin" /> Borde de la encía</span>
          <span><i className="gx-l-bottom" /> Fondo de la bolsa</span>
          <span><i className="gx-l-bleed" /> Sangra</span>
        </div>
        <div className="gx-perio-grid" role="group" aria-label="Los nueve sitios">
          <span className="gx-row-k" aria-hidden="true" />
          {sites.map((_, index) => (
            <span key={index} className="gx-col-k" aria-hidden="true">
              {index % 3 === 1 ? <b>{TEETH[Math.floor(index / 3)]}</b> : null}
              {SITES[index % 3]}
            </span>
          ))}
          <span className="gx-row-k">Sondaje</span>
          {sites.map((site, index) => (
            <input
              key={index}
              type="text"
              inputMode="numeric"
              value={shownValue("depth", index)}
              onBlur={() => settle("depth", index)}
              aria-label={`Sondaje de la ${TEETH[Math.floor(index / 3)]}, ${SITE_WORDS[index % 3]}, en milímetros`}
              onChange={(event) => typed("depth", index, event.target.value)}
            />
          ))}
          <span className="gx-row-k">Recesión</span>
          {sites.map((site, index) => (
            <input
              key={index}
              type="text"
              // Teclado con el signo «-»: el numérico del iPhone no lo trae.
              inputMode="text"
              value={shownValue("recession", index)}
              onBlur={() => settle("recession", index)}
              aria-label={`Recesión de la ${TEETH[Math.floor(index / 3)]}, ${SITE_WORDS[index % 3]}, en milímetros (negativa si la encía cubre la corona)`}
              onChange={(event) => typed("recession", index, event.target.value)}
            />
          ))}
          <span className="gx-row-k">Inserción</span>
          {loss.map((value, index) => (
            // Un span y no un <output>: el resumen de abajo ya lo anuncia, sin nueve avisos por tecla.
            <span key={index} className={value >= 5 ? "gx-out hi" : "gx-out"}>
              <span className="sr-only">Pérdida de inserción de la {TEETH[Math.floor(index / 3)]}, {SITE_WORDS[index % 3]}: </span>
              {value}
            </span>
          ))}
          <span className="gx-row-k">Sangra</span>
          {sites.map((site, index) => (
            <button
              key={index}
              type="button"
              className={site.bleeding ? "gx-bl on" : "gx-bl"}
              aria-pressed={site.bleeding}
              aria-label={`Sangra la ${TEETH[Math.floor(index / 3)]}, ${SITE_WORDS[index % 3]}`}
              onClick={() => set(index, { bleeding: !site.bleeding })}
            >
              {site.bleeding ? "Sí" : "No"}
            </button>
          ))}
        </div>
        <p className="gx-status" aria-live="polite">
          La mayor pérdida de inserción: <b>{loss[worst]} mm</b> en la {TEETH[Math.floor(worst / 3)]}, {SITE_WORDS[worst % 3]} (
          {sites[worst]!.depth} de sondaje {sites[worst]!.recession < 0 ? "−" : "+"} {Math.abs(sites[worst]!.recession)} de recesión). Sangra{" "}
          {bleeding === 1 ? "1 sitio" : `${bleeding} sitios`} de {sites.length}: {percent} %.
        </p>
        <button type="button" className="gx-btn gx-btn-soft" onClick={() => setSites(START)}>
          Volver al ejemplo
        </button>
      </div>
    </div>
  )
}
