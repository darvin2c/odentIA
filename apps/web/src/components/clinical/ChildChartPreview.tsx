// La demo de la guía de niños (acta de la mesa del 24 nov): como en la app, la dentición viene por la
// edad (temporal hasta los 5 años, mixta de 6 a 12) y se cambia con un toque. Valentina, 4 años, y
// Mateo, 7, con hallazgos clínicamente coherentes. Es un ejemplo con datos inventados: tocar una
// pieza solo cambia lo que se ve.
import { useState } from "react"
import OdontogramArch, { type Dentition, type ExampleFinding, teethOf } from "../odontogram/OdontogramArch"
import "./chart-preview.css"
import "./child-chart.css"

type Example = { finding: string; detail: string; kind: ExampleFinding }
type Patient = { key: string; name: string; suggested: Dentition; examples: Record<number, Example> }

const PATIENTS: Patient[] = [
  {
    key: "valentina",
    name: "Valentina, 4 años",
    suggested: "temporal",
    examples: {
      54: { kind: "caries", finding: "Caries de dentina en oclusal", detail: "Un molar de leche: se trata como en adultos, con su sigla CD." },
      64: { kind: "caries", finding: "Caries de dentina en oclusal", detail: "La misma lesión en el otro lado." },
      75: { kind: "corona", finding: "Corona en buen estado", detail: "Corona metálica (CM) sobre una pulpotomía (PP): la de acero de un molar de leche." },
    },
  },
  {
    key: "mateo",
    name: "Mateo, 7 años",
    suggested: "mixta",
    examples: {
      // Los mismos cinco de su tabla en la guía de niños.
      21: { kind: "saliendo", finding: "Está saliendo", detail: "El incisivo central permanente: la flecha en zigzag azul, en su fila de arriba." },
      36: { kind: "sigla", finding: "Fosas y fisuras profundas", detail: "Solo la sigla FFP en el recuadro, en azul: no es una caries." },
      46: { kind: "sellante", finding: "Sellante en buen estado", detail: "El sellante en la cara oclusal y la sigla S, en azul." },
      75: { kind: "caries", finding: "Caries que llega a la pulpa", detail: "En el molar de leche de abajo: la oclusal en rojo y CDP." },
      84: { kind: "ausente", finding: "Ausente", detail: "Extraído por caries a los 5 años, antes de tiempo: aspa azul y DEX en su fila de leche." },
    },
  },
]

const DENTITIONS: Array<[Dentition, string]> = [
  ["temporal", "Temporal (20)"],
  ["mixta", "Mixta (52)"],
  ["permanente", "Permanente (32)"],
]
const DENTITION_WORDS: Record<Dentition, string> = { temporal: "temporal", mixta: "mixta", permanente: "permanente" }

export default function ChildChartPreview({ names }: { names: Record<number, string> }) {
  const [patient, setPatient] = useState<Patient>(PATIENTS[0] as Patient)
  const [dentition, setDentition] = useState<Dentition>(patient.suggested)
  const [tooth, setTooth] = useState<number>(Number(Object.keys(patient.examples)[0]))
  const findings = Object.fromEntries(Object.entries(patient.examples).map(([n, example]) => [n, example.kind])) as Record<
    number,
    ExampleFinding
  >
  const example = patient.examples[tooth]
  const tone = !example ? "none" : example.kind === "caries" ? "red" : "blue"

  const pick = (next: Patient) => {
    setPatient(next)
    setDentition(next.suggested)
    setTooth(Number(Object.keys(next.examples)[0]))
  }

  // La pieza elegida tiene que estar en el dibujo: al pasar a otra dentición, si no se dibuja,
  // queda elegida la primera con hallazgo que sí se ve (o la primera del dibujo).
  const show = (next: Dentition) => {
    setDentition(next)
    const drawn = teethOf(next)
    if (drawn.includes(tooth)) return
    const marked = Object.keys(patient.examples).map(Number).find((n) => drawn.includes(n))
    setTooth(marked ?? drawn[0] ?? tooth)
  }

  return (
    <div className="cp cc">
      <div className="cc-top">
        <div className="cc-group" role="group" aria-label="Paciente del ejemplo">
          <span className="cc-label">Paciente</span>
          {PATIENTS.map((item) => (
            <button key={item.key} type="button" className="cc-pill" aria-pressed={item.key === patient.key} onClick={() => pick(item)}>
              {item.name}
            </button>
          ))}
        </div>
        <div className="cc-group" role="group" aria-label="Dentición">
          <span className="cc-label">Dentición</span>
          {DENTITIONS.map(([value, label]) => (
            <button key={value} type="button" className="cc-pill" aria-pressed={value === dentition} onClick={() => show(value)}>
              {label}
            </button>
          ))}
        </div>
        <p className="cc-hint" aria-live="polite">
          {dentition === patient.suggested
            ? `Sugerida por la edad del paciente: ${DENTITION_WORDS[dentition]}.`
            : `La cambiaste; la sugerida por su edad es la ${DENTITION_WORDS[patient.suggested]}.`}
          {dentition === "mixta" ? " Arco exterior: permanentes; arco interior: temporales." : ""}
        </p>
      </div>
      <div className="cp-arch">
        <OdontogramArch
          findings={findings}
          dentition={dentition}
          selected={tooth}
          onPick={setTooth}
          labelOf={(n) => `Pieza ${n}, ${names[n] ?? ""}: ${patient.examples[n]?.finding ?? "sin hallazgos"}`}
        />
      </div>
      <div className="cp-panel" aria-live="polite">
        <span className="cp-n">PIEZA {tooth}</span>
        <b className="cp-name">{names[tooth]}</b>
        <span className={`cp-chip ${tone}`}>{example?.finding ?? "Sin hallazgos"}</span>
        <span className="cp-detail">{example?.detail ?? "No hay hallazgos registrados en esta pieza."}</span>
        <span className="cp-note">
          {dentition === "mixta"
            ? "En la mixta se ven los 52 dientes; marcas lo que encuentras en los que tiene en la boca. Ejemplo con datos inventados."
            : "Ejemplo con datos inventados."}
        </span>
      </div>
    </div>
  )
}
