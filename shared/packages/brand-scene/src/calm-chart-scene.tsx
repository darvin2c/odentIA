import { useId } from "react"

export interface CalmChartSceneProps {
  className?: string
}

/** Los renglones de la cartilla, de la letra grande a la chica, con su alto y su línea. */
const ROWS: ReadonlyArray<{ letters: string; size: number; y: number }> = [
  { letters: "E", size: 58, y: 62 },
  { letters: "F P", size: 34, y: 104 },
  { letters: "T O Z", size: 22, y: 136 },
  { letters: "L P E D", size: 15, y: 160 },
]

/** Lo que dura una lectura completa de la cartilla, en segundos. */
const READ = 6

/**
 * La escena de vistIA en el acceso, en lugar de las piezas de odentIA o el pulso
 * de latidIA: una cartilla de lectura que se lee renglón por renglón, de la letra
 * grande a la chica, y vuelve a empezar. Al pie, «20/20», el número de su marca.
 * Con «menos movimiento» queda quieta y entera. Es un dibujo, no un dato: el
 * lector de pantalla no la anuncia.
 */
export function CalmChartScene({ className }: CalmChartSceneProps) {
  const id = useId().replace(/:/g, "")
  return (
    <svg aria-hidden="true" viewBox="-24 0 608 200" preserveAspectRatio="xMidYMid meet" className={className}>
      <style>{`
        .chart-${id}-row { opacity: .35; animation: chart-${id}-read ${READ}s ease-in-out infinite; }
        @keyframes chart-${id}-read { 0%, 30%, 100% { opacity: .35; } 8%, 22% { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) {
          .chart-${id}-row { animation: none; opacity: 1; }
        }
      `}</style>
      {ROWS.map((row, index) => (
        <text
          key={row.letters}
          className={`chart-${id}-row`}
          style={{ animationDelay: `${(index * READ) / (ROWS.length + 1)}s` }}
          x="280"
          y={row.y}
          textAnchor="middle"
          fill="#bbf7d0"
          fontFamily="'IBM Plex Mono', ui-monospace, monospace"
          fontWeight="600"
          fontSize={row.size}
          letterSpacing={row.size * 0.3}
        >
          {row.letters}
        </text>
      ))}
      <path d="M170 176 H390" stroke="#1f4d33" strokeWidth="2" strokeLinecap="round" />
      <text x="0" y="190" fill="#7fb894" fontFamily="'IBM Plex Mono', ui-monospace, monospace" fontSize="13">
        20/20
      </text>
    </svg>
  )
}
