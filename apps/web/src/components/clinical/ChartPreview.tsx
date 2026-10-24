// La tarjeta de la portada de Historia y odontograma (lienzo del paso 3, tablero «Historia»): el
// odontograma a la izquierda y, a la derecha, la pieza elegida con su hallazgo. Ejemplo con datos
// inventados; tocar una pieza solo cambia lo que se ve.
import { useState } from "react"
import OdontogramArch, { type ExampleFinding } from "../odontogram/OdontogramArch"
import "./chart-preview.css"

type Example = { finding: string; detail: string; kind: ExampleFinding }

/** Los hallazgos de Carlos, el paciente de ejemplo de la web. */
const EXAMPLES: Record<number, Example> = {
  36: {
    kind: "caries",
    finding: "Caries oclusal profunda",
    detail: "Dictado por la Dra. Paredes y confirmado. Diagnóstico CIE-10 K02.1. En el plan: resina, o si no una corona.",
  },
  46: { kind: "ausente", finding: "Ausente", detail: "Registrado en la atención del 12 de marzo." },
  11: { kind: "corona", finding: "Corona en buen estado", detail: "Corona de porcelana registrada en 2024." },
  26: { kind: "restauracion", finding: "Restauración en buen estado", detail: "Resina oclusal del 3 de junio." },
}

const FINDINGS = Object.fromEntries(Object.entries(EXAMPLES).map(([tooth, example]) => [tooth, example.kind])) as Record<
  number,
  ExampleFinding
>

export default function ChartPreview({ names }: { names: Record<number, string> }) {
  const [tooth, setTooth] = useState(36)
  const example = EXAMPLES[tooth]
  const tone = !example ? "none" : example.kind === "caries" ? "red" : "blue"
  return (
    <div className="cp">
      <div className="cp-arch">
        <OdontogramArch
          findings={FINDINGS}
          selected={tooth}
          onPick={setTooth}
          labelOf={(n) => `Pieza ${n}, ${names[n] ?? ""}: ${EXAMPLES[n]?.finding ?? "sin hallazgos"}`}
        />
      </div>
      <div className="cp-panel" aria-live="polite">
        <span className="cp-n">PIEZA {tooth}</span>
        <b className="cp-name">{names[tooth]}</b>
        <span className={`cp-chip ${tone}`}>{example?.finding ?? "Sin hallazgos"}</span>
        <span className="cp-detail">{example?.detail ?? "No hay hallazgos registrados en esta pieza."}</span>
        <span className="cp-note">Toca una pieza. Ejemplo con datos inventados.</span>
      </div>
    </div>
  )
}
