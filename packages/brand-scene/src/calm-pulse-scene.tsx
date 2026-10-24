import { useId } from "react"

export interface CalmPulseSceneProps {
  className?: string
}

/** El trazo de un latido sobre la línea en reposo (tablero «Marca y color» del lienzo de latidIA). */
const BEAT =
  "M0 120 H150 l14 -10 l12 10 H210 l10 18 l16 -96 l18 116 l12 -38 H300 l18 -16 l18 16 H560"

/**
 * La escena de latidIA en el acceso, en lugar de las piezas de odentIA: un
 * pulso tranquilo a 72 latidos por minuto. Una luz recorre el trazo y el
 * punto del final late con el mismo ritmo; con «menos movimiento» queda quieta.
 * Es un dibujo, no un dato: el lector de pantalla no la anuncia.
 */
export function CalmPulseScene({ className }: CalmPulseSceneProps) {
  const id = useId().replace(/:/g, "")
  return (
    <svg
      aria-hidden="true"
      viewBox="-24 0 608 200"
      preserveAspectRatio="xMidYMid meet"
      className={className}
    >
      <style>{`
        .pulse-${id}-run { animation: pulse-${id}-run 2.5s linear infinite; }
        .pulse-${id}-dot { transform-origin: 560px 120px; animation: pulse-${id}-beat 0.833s ease-out infinite; }
        @keyframes pulse-${id}-run { from { stroke-dashoffset: 118; } to { stroke-dashoffset: 0; } }
        @keyframes pulse-${id}-beat { 0%, 100% { transform: scale(1); opacity: 1; } 30% { transform: scale(1.35); opacity: .75; } }
        @media (prefers-reduced-motion: reduce) {
          .pulse-${id}-run { animation: none; stroke-dashoffset: 0; stroke-dasharray: none; }
          .pulse-${id}-dot { animation: none; }
        }
      `}</style>
      <path
        d={BEAT}
        fill="none"
        stroke="#3b2a63"
        strokeWidth="10"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={BEAT}
        fill="none"
        stroke="#b79cf0"
        strokeOpacity=".45"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className={`pulse-${id}-run`}
        d={BEAT}
        pathLength={100}
        fill="none"
        stroke="#b79cf0"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="18 100"
      />
      <circle className={`pulse-${id}-dot`} cx="560" cy="120" r="7" fill="#e9defc" />
      <text
        x="0"
        y="190"
        fill="#8f7fb3"
        fontFamily="'IBM Plex Mono', ui-monospace, monospace"
        fontSize="13"
      >
        72 lpm
      </text>
    </svg>
  )
}
