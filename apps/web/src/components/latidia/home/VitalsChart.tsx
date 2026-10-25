// Signos vitales en el inicio de latidIA (lienzo «Inicio», sección 5): la presión de Luis Gómez en
// sus cuatro controles se dibuja punto a punto, como el gráfico de la ficha. El escritorio y el
// teléfono tienen su propio dibujo (el del teléfono, con letras que se leen a 390 px).
import { useLoop } from "./loop"
import "./vitals-chart.css"

const READINGS = ["152/96", "144/92", "138/88", "132/84"]
const WEIGHT = [86, 84, 83, 82]
const LABEL = "Presión arterial de Luis: de 152/96 en enero a 132/84 en octubre"

type Pt = [number, number]
const WIDE = {
  sys: [[90, 45], [260, 60], [430, 71], [600, 83]] as Pt[],
  dia: [[90, 151], [260, 158], [430, 166], [600, 174]] as Pt[],
}
const NARROW = {
  sys: [[60, 34], [145, 48], [230, 58], [315, 69]] as Pt[],
  dia: [[60, 132], [145, 139], [230, 146], [315, 153]] as Pt[],
}

export default function VitalsChart() {
  const { step: n } = useLoop({ len: 5, hold: 8, ms: 800 })
  const line = (pts: Pt[]) => (n === 0 ? "" : pts.slice(0, n).map((p) => p.join(",")).join(" "))
  const shown = (i: number) => (n > i ? 1 : 0)
  const last = n === 0 ? "—" : `${READINGS[n - 1]} mmHg`
  const weight = n === 0 ? "—" : `86 → ${WEIGHT[n - 1]} kg`

  return (
    <div className="lt-vc">
      <div className="lt-vc-wide">
        <svg viewBox="0 0 640 230" role="img" aria-label={LABEL}>
          <g stroke="#eef0f4" strokeWidth="1">
            {[30, 68, 106, 143, 181].map((y) => (
              <line key={y} x1="44" y1={y} x2="630" y2={y}></line>
            ))}
          </g>
          <g fontSize="14" fill="#94a3b8">
            <text x="8" y="34">160</text>
            <text x="8" y="72">140</text>
            <text x="8" y="110">120</text>
            <text x="8" y="147">100</text>
            <text x="14" y="185">80</text>
          </g>
          <g fontSize="14" fill="#64748b" textAnchor="middle">
            <text x="90" y="222">ene.</text>
            <text x="260" y="222">abr.</text>
            <text x="430" y="222">jul.</text>
            <text x="600" y="222" fontWeight="700" fill="#0f172a">oct.</text>
          </g>
          <polyline points={line(WIDE.sys)} className="lt-vc-sys"></polyline>
          <polyline points={line(WIDE.dia)} className="lt-vc-dia"></polyline>
          {WIDE.sys.map(([x, y], i) => (
            <circle key={`s${x}`} cx={x} cy={y} r={i === 3 ? 6 : 5} fill="#0e8fb0" opacity={shown(i)}></circle>
          ))}
          {WIDE.dia.map(([x, y], i) => (
            <circle key={`d${x}`} cx={x} cy={y} r={i === 3 ? 6 : 5} fill="#f0703a" opacity={shown(i)}></circle>
          ))}
          <g opacity={shown(3)}>
            <rect x="478" y="98" width="104" height="44" rx="10" fill="#0f172a"></rect>
            <text x="530" y="116" textAnchor="middle" fontSize="12" fontWeight="700" fill="#ffffff">
              24 oct.
            </text>
            <text x="530" y="133" textAnchor="middle" fontSize="12" fill="#ffffff">
              132/84 mmHg
            </text>
          </g>
        </svg>
        <div className="lt-vc-side">
          <b>Última medición</b>
          <span>
            <span>Presión</span>
            <b>{last}</b>
          </span>
          <span>
            <span>Peso</span>
            <b>{weight}</b>
          </span>
          <span>
            <span>Tabaco</span>
            <b>10 al día</b>
          </span>
          <span className="lt-vc-table">Ver como tabla</span>
        </div>
      </div>

      <div className="lt-vc-narrow">
        <svg viewBox="0 0 340 200" role="img" aria-label={LABEL}>
          <g stroke="#eef0f4" strokeWidth="1">
            {[20, 55, 90, 125, 160].map((y) => (
              <line key={y} x1="34" y1={y} x2="336" y2={y}></line>
            ))}
          </g>
          <g fontSize="12" fill="#94a3b8">
            <text x="0" y="24">160</text>
            <text x="0" y="59">140</text>
            <text x="0" y="94">120</text>
            <text x="0" y="129">100</text>
            <text x="6" y="164">80</text>
          </g>
          <g fontSize="12" fill="#64748b" textAnchor="middle">
            <text x="60" y="190">ene.</text>
            <text x="145" y="190">abr.</text>
            <text x="230" y="190">jul.</text>
            <text x="315" y="190" fontWeight="700" fill="#0f172a">oct.</text>
          </g>
          <polyline points={line(NARROW.sys)} className="lt-vc-sys"></polyline>
          <polyline points={line(NARROW.dia)} className="lt-vc-dia"></polyline>
          {NARROW.sys.map(([x, y], i) => (
            <circle key={`s${x}`} cx={x} cy={y} r={i === 3 ? 5.5 : 4.5} fill="#0e8fb0" opacity={shown(i)}></circle>
          ))}
          {NARROW.dia.map(([x, y], i) => (
            <circle key={`d${x}`} cx={x} cy={y} r={i === 3 ? 5.5 : 4.5} fill="#f0703a" opacity={shown(i)}></circle>
          ))}
        </svg>
        <span className="lt-vc-row first">
          <span>Última medición</span>
          <b>{last}</b>
        </span>
        <span className="lt-vc-row">
          <span>Peso</span>
          <b>{weight}</b>
        </span>
      </div>
    </div>
  )
}
